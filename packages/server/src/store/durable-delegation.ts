import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { SqlDatabase } from './db/postgres.js';
import type { AuthorityUse } from './root-authority-contract.js';
import type { AuthorityKernel } from './root-authority-contract.js';
import type { GrantSubject } from './root-grants.js';
import { afterSecurityCommit, type SecurityTx } from './security-write.js';

export interface DelegatedPatInput {
  readonly kind: 'delegated-pat';
  readonly actor: ReturnType<AuthorityKernel['authorizeWrite']>;
  readonly beneficiary: GrantSubject;
  readonly use: DelegationUse;
  readonly candidate: PreparedAgentPat;
}

const secrets = new WeakMap<PreparedAgentPat,{raw:string;committed:boolean}>();

export class PreparedAgentPat {
  readonly credentialId = randomUUID();
  readonly familyId = randomUUID();
  readonly materialNodeId = randomUUID();
  private constructor(readonly tokenHash: string, readonly tokenPrefix: string) { Object.freeze(this); }

  static prepare(): PreparedAgentPat {
    const raw = `mul_${randomBytes(32).toString('hex')}`;
    const candidate = new PreparedAgentPat(createHash('sha256').update(raw).digest('hex'),raw.slice(0,12));
    secrets.set(candidate,{raw,committed:false});
    return candidate;
  }

  takeCommittedToken(): string | null {
    const secret = secrets.get(this);
    if (!secret?.committed) return null;
    secrets.delete(this);
    return secret.raw;
  }
}

export function releasePatAfterCommit(db: SqlDatabase, tx: SecurityTx, candidate: PreparedAgentPat): void {
  const secret = secrets.get(candidate);
  if (!secret || secret.committed || !db.query(`SELECT p.credential_id FROM multiremi_delegated_pats p JOIN multiremi_credential_version_bindings v
    ON v.credential_id=p.credential_id AND v.family_id=p.family_id WHERE p.credential_id=? AND p.family_id=? AND v.material_digest=?
    AND v.authority_node_id=?`).get(candidate.credentialId,candidate.familyId,candidate.tokenHash,candidate.materialNodeId)) throw new Error('credential_version_conflict');
  afterSecurityCommit(db,tx,()=>{ secret.committed=true; });
}

export interface DelegationUse extends AuthorityUse {
  readonly action: 'root.grant.create' | 'credential.pat.create';
  readonly idempotencyKey: string;
  readonly expiresAtMs: number;
  readonly requestDigest: string;
}

export function expandDurableDelegations(db: SqlDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_durable_delegations (
    node_id TEXT PRIMARY KEY NOT NULL REFERENCES multiremi_authority_nodes(node_id), issuer_agent_id TEXT NOT NULL,
    issuer_grant_id TEXT NOT NULL REFERENCES multiremi_root_grants(grant_id), issuer_generation INTEGER NOT NULL,
    attempt_id TEXT NOT NULL, run_id TEXT NOT NULL, run_generation INTEGER NOT NULL, lease_id TEXT NOT NULL, fence_term TEXT NOT NULL,
    credential_id TEXT NOT NULL, material_version INTEGER NOT NULL, family_id TEXT NOT NULL REFERENCES multiremi_credential_families(family_id),
    action TEXT NOT NULL, beneficiary_type TEXT NOT NULL, beneficiary_id TEXT NOT NULL, request_digest TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    UNIQUE(issuer_grant_id,issuer_generation,action,beneficiary_type,beneficiary_id,idempotency_key)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_durable_delegations_attempt ON multiremi_durable_delegations(attempt_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_durable_delegations_family ON multiremi_durable_delegations(family_id)`);
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_delegated_pats (
    credential_id TEXT PRIMARY KEY NOT NULL REFERENCES multiremi_access_tokens(id), origin_node_id TEXT NOT NULL UNIQUE REFERENCES multiremi_durable_delegations(node_id),
    family_id TEXT NOT NULL UNIQUE REFERENCES multiremi_credential_families(family_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_attempt_security_revocations (
    attempt_id TEXT PRIMARY KEY NOT NULL, reason TEXT NOT NULL, revision INTEGER NOT NULL, revoked_at_ms BIGINT NOT NULL
  )`);
}
