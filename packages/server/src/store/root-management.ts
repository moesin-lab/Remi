import { createHash } from 'node:crypto';
import { ROOT_SECURITY_REVOKE_REASONS, type RevokeCredentialFamilyRequest, type RevokeCredentialFamilyResponse,
  type RevokeRootGrantRequest, type RevokeRootGrantResponse } from '@multiremi/contracts/root-authority.js';
import type { SqlDatabase } from './db/postgres.js';
import { assertUnrevokedAncestry } from './authority-provenance.js';
import type { AuthorityKernel, AuthorityUse, CredentialProof, CurrentAuthority } from './root-authority-contract.js';
import { readRecordedGrant } from './root-grants.js';
import { SecurityAbort, withSecurityTarget, withSecurityWrite, type SecurityTx } from './security-write.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const grantAction = 'root.grant.revoke';
const familyAction = 'root.credential-family.revoke';
type Actor = ReturnType<AuthorityKernel['authorizeWrite']>;
type Response = RevokeRootGrantResponse | RevokeCredentialFamilyResponse;
interface PasswordEvidence { userId: string; verifier: string; version: number; node: string; deadline: number }

export class RootManagementRequestError extends Error {
  constructor(readonly status: 400 | 404, message: string) { super(message); }
}

function onPrimary<T>(readOrWrite: () => T): T {
  try { return readOrWrite(); } catch (error) {
    if (error instanceof SecurityAbort || error instanceof RootManagementRequestError) throw error;
    throw new SecurityAbort('security_state_unavailable');
  }
}

export class RootManagement {
  private readonly proofs = new WeakMap<CredentialProof, PasswordEvidence>();
  private readonly actors = new WeakMap<Actor, { tx: SecurityTx; proof: CredentialProof; action: string; target: string }>();

  constructor(private readonly db: SqlDatabase) {}

  private passwordRow(userId: string, writing = false) {
    const lock = writing && this.db.dialect === 'postgres' ? ' FOR SHARE OF p,u' : '';
    return this.db.query(`SELECT p.password_hash FROM multiremi_password_credentials p
      JOIN multiremi_users u ON u.id=p.user_id WHERE p.user_id=?${lock}`).get(userId);
  }

  private versionRow(userId: string, verifier: string) {
    return this.db.query(`SELECT v.version,v.password_node_id,v.identity_node_id FROM multiremi_password_authority_versions v
      JOIN multiremi_authority_nodes p ON p.node_id=v.password_node_id AND p.kind='password' AND p.subject_type='user'
        AND p.subject_id=v.user_id AND p.generation=v.version AND p.continuous_parent_count=1
      JOIN multiremi_authority_edges e ON e.child_id=p.node_id AND e.parent_id=v.identity_node_id AND e.dependency='continuous'
      JOIN multiremi_authority_nodes i ON i.node_id=e.parent_id AND i.kind='independent_identity' AND i.subject_type='user'
        AND i.subject_id=v.user_id AND i.continuous_parent_count=0
      WHERE v.user_id=? AND v.verifier_digest=? AND v.version=(SELECT MAX(newest.version)
        FROM multiremi_password_authority_versions newest WHERE newest.user_id=v.user_id)`).get(userId, verifier);
  }

  async verifyIndependentPassword(userId: string, password: string): Promise<CredentialProof> {
    if (!userId.startsWith('usr_') || !password || password.length > 1024) return { kind: 'invalid' };
    const row = onPrimary(() => this.passwordRow(userId));
    if (!row) return { kind: 'invalid' };
    let matches: boolean;
    try { matches = await Bun.password.verify(password, row.password_hash); } catch { return { kind: 'invalid' }; }
    if (!matches) return { kind: 'invalid' };
    const verifier = digest(row.password_hash);
    const source = onPrimary(() => this.versionRow(userId, verifier));
    if (!source || onPrimary(() => this.passwordRow(userId))?.password_hash !== row.password_hash) return { kind: 'invalid' };
    const proof = Object.freeze({ kind: 'independent', proofVersion: Object.freeze({ id: source.password_node_id,
      version: Number(source.version) }) }) as CredentialProof;
    const evidence = { userId, verifier, version: Number(source.version), node: source.password_node_id, deadline: Date.now() + 60_000 };
    const state = onPrimary(() => this.db.query('SELECT security_revision FROM multiremi_security_state WHERE singleton=1').get());
    if (!state) throw new SecurityAbort('security_state_unavailable');
    try {
      onPrimary(() => withSecurityWrite(this.db, undefined, { expectedRevision: Number(state.security_revision), workspaceIds: [],
        numberKeys: [], domainTargets: [`authority:${evidence.node}`] }, tx => this.checkPassword(tx, evidence)));
    } catch (error) {
      if (error instanceof SecurityAbort && error.code === 'root_authority_revoked') return { kind: 'invalid' };
      throw error;
    }
    this.proofs.set(proof, evidence);
    return proof;
  }

  private evidence(proof: CredentialProof) {
    const evidence = this.proofs.get(proof);
    if (!evidence || Date.now() >= evidence.deadline) throw new SecurityAbort('root_authority_revoked');
    return evidence;
  }

  plan(proof: CredentialProof, request: AuthorityUse) {
    const evidence = this.evidence(proof);
    const state = onPrimary(() => this.db.query('SELECT security_revision FROM multiremi_security_state WHERE singleton=1').get());
    if (!state) throw new SecurityAbort('security_state_unavailable');
    const grant = onPrimary(() => this.db.query(`SELECT g.authority_node_id FROM multiremi_root_subject_state s JOIN multiremi_root_grants g
      ON g.grant_id=s.active_grant_id WHERE s.subject_type='user' AND s.subject_id=?`).get(evidence.userId));
    const targets = [`authority:${evidence.node}`, `grant:user:${evidence.userId}`, `management:${request.actualTarget.type}:${request.actualTarget.id}`];
    if (grant) targets.push(`authority:${grant.authority_node_id}`);
    return { expectedRevision: Number(state.security_revision), workspaceIds: [], numberKeys: [], domainTargets: [...new Set(targets)].sort() };
  }

  private checkPassword(tx: SecurityTx, evidence: PasswordEvidence): void {
    const row = this.passwordRow(evidence.userId, true);
    if (!row || digest(row.password_hash) !== evidence.verifier) throw new SecurityAbort('credential_version_conflict');
    const source = this.versionRow(evidence.userId, evidence.verifier);
    if (!source || source.password_node_id !== evidence.node || Number(source.version) !== evidence.version) throw new SecurityAbort('credential_version_conflict');
    assertUnrevokedAncestry(this.db, tx, { nodeId: evidence.node, generation: evidence.version });
  }

  private check(tx: SecurityTx, proof: CredentialProof, request: AuthorityUse): CurrentAuthority {
    const evidence = this.evidence(proof);
    const target = request.actualTarget;
    if (!target.id || request.use !== 'management' || !(request.action === grantAction && target.type === 'grant'
      || request.action === familyAction && target.type === 'credential_family')) throw new SecurityAbort('root_required');
    this.checkPassword(tx, evidence);
    const state = this.db.query('SELECT feature_activation,security_revision FROM multiremi_security_state WHERE singleton=1').get();
    if (!state) throw new SecurityAbort('security_state_unavailable');
    const subject = { type: 'user', id: evidence.userId } as const;
    const grant = readRecordedGrant(this.db, tx, subject);
    const active = Number(state.feature_activation) === 1;
    if (active && grant) {
      const node = this.db.query(`SELECT node_id FROM multiremi_authority_nodes WHERE node_id=? AND generation=? AND kind='grant'
        AND scope='system' AND subject_type='user' AND subject_id=?`).get(grant.authorityNodeId, grant.generation, subject.id);
      if (!node) throw new SecurityAbort('root_authority_revoked');
      assertUnrevokedAncestry(this.db, tx, { nodeId: grant.authorityNodeId, generation: grant.generation });
      const exists = request.action === grantAction
        ? this.db.query('SELECT grant_id FROM multiremi_root_grants WHERE grant_id=?').get(target.id)
        : this.db.query('SELECT family_id FROM multiremi_credential_families WHERE family_id=?').get(target.id);
      if (!exists) throw new RootManagementRequestError(404, 'Management target not found');
    }
    return { transport: 'human', subject, credentialOrigin: null, attemptId: null, recordedGrant: grant,
      scope: active && grant ? 'system' : null, effectiveRoot: active && !!grant,
      reason: !active ? 'feature_disabled' : grant ? 'active' : 'no_grant', checkedRevision: Number(state.security_revision) };
  }

  resolveCurrent(proof: CredentialProof, request: AuthorityUse): CurrentAuthority {
    return onPrimary(() => withSecurityWrite(this.db, undefined, this.plan(proof, request), tx => this.check(tx, proof, request)));
  }

  authorizeWrite(tx: SecurityTx, proof: CredentialProof, request: AuthorityUse): Actor {
    return withSecurityTarget(this.db, tx, `management:${request.actualTarget.type}:${request.actualTarget.id}`, () => {
      const authority = onPrimary(() => this.check(tx, proof, request));
      if (!authority.effectiveRoot) throw new SecurityAbort('root_required');
      const actor = Object.freeze(authority) as Actor;
      this.actors.set(actor, { tx, proof, action: request.action, target: request.actualTarget.id });
      return actor;
    });
  }

  revokeGrant(tx: SecurityTx, actor: Parameters<AuthorityKernel['revokeGrant']>[1], targetId: string, input: RevokeRootGrantRequest): RevokeRootGrantResponse {
    return onPrimary(() => this.revoke(tx, actor, targetId, grantAction, input)) as RevokeRootGrantResponse;
  }

  revokeFamily(tx: SecurityTx, actor: Parameters<AuthorityKernel['revokeFamily']>[1], targetId: string, input: RevokeCredentialFamilyRequest): RevokeCredentialFamilyResponse {
    return onPrimary(() => this.revoke(tx, actor, targetId, familyAction, input)) as RevokeCredentialFamilyResponse;
  }

  private revoke(tx: SecurityTx, actor: Parameters<AuthorityKernel['revokeGrant']>[1], targetId: string, action: string,
    input: RevokeRootGrantRequest): Response {
    const type = action === grantAction ? 'grant' : 'credential_family';
    return withSecurityTarget(this.db, tx, `management:${type}:${targetId}`, () => {
      const bound = this.actors.get(actor as Actor);
      if (!bound || bound.tx !== tx || bound.target !== targetId || bound.action !== action) throw new SecurityAbort('root_required');
      const current = this.check(tx, bound.proof, { action, actualTarget: { type, id: targetId }, use: 'management' });
      if (!current.effectiveRoot || !current.recordedGrant || !current.subject) throw new SecurityAbort('root_required');
      const previous = actor as Actor;
      if (previous.recordedGrant?.grantId !== current.recordedGrant.grantId || previous.recordedGrant.generation !== current.recordedGrant.generation
        || previous.checkedRevision !== current.checkedRevision) throw new SecurityAbort('authority_revision_conflict');
      if (typeof input.reason !== 'string' || !input.reason.trim() || typeof input.idempotency_key !== 'string'
        || !input.idempotency_key.trim() || !Number.isSafeInteger(input.expected_revision)
        || input.expected_revision < 0 || (action === familyAction || input.reason_code !== undefined)
          && !ROOT_SECURITY_REVOKE_REASONS.some(code => code === input.reason_code)) throw new RootManagementRequestError(400, 'Invalid revocation request');
      const key = [current.subject.id, action, targetId, input.idempotency_key];
      const payload = digest(JSON.stringify([input.expected_revision, input.reason, input.reason_code ?? null]));
      const prior = this.db.query(`SELECT payload_digest,result_json FROM multiremi_root_management_events
        WHERE actor_user_id=? AND action=? AND target_id=? AND idempotency_key=?`).get(...key);
      if (prior) {
        if (prior.payload_digest !== payload) throw new SecurityAbort('authority_revision_conflict');
        return { ...JSON.parse(prior.result_json), replayed: true };
      }
      const before = current.checkedRevision;
      const revision = before + 1;
      if (input.expected_revision !== before || !Number.isSafeInteger(revision)) throw new SecurityAbort('authority_revision_conflict');
      const now = Date.now();
      const target = action === grantAction
        ? this.db.query(`UPDATE multiremi_root_grants SET revoked_at_ms=?,revoke_reason=?,revision=?
          WHERE grant_id=? AND revoked_at_ms IS NULL RETURNING *`).get(now, input.reason, revision, targetId)
        : this.db.query(`UPDATE multiremi_credential_families SET revoked_at_ms=?,revision=? WHERE family_id=? AND revoked_at_ms IS NULL RETURNING *`).get(now, revision, targetId);
      if (!target) throw new SecurityAbort('authority_revision_conflict');
      const changed = this.db.query(`UPDATE multiremi_authority_nodes SET revoked_at_ms=?,revision=? WHERE node_id=?
        AND kind=? AND revoked_at_ms IS NULL RETURNING subject_id,subject_type,generation`).get(now, revision, target.authority_node_id, type);
      if (!changed) throw new SecurityAbort('authority_revision_conflict');
      if (action === grantAction && (changed.subject_id !== target.subject_id || changed.subject_type !== target.subject_type
        || Number(changed.generation) !== Number(target.generation) || !this.db.query(`UPDATE multiremi_root_subject_state SET active_grant_id=NULL
          WHERE subject_type=? AND subject_id=? AND generation_counter=? AND active_grant_id=? RETURNING generation_counter`)
          .get(target.subject_type, target.subject_id, target.generation, targetId))) throw new SecurityAbort('authority_revision_conflict');
      const count = this.db.query(`WITH RECURSIVE affected(node_id) AS (SELECT node_id FROM multiremi_authority_nodes WHERE node_id=?
        UNION SELECT e.child_id FROM multiremi_authority_edges e JOIN affected a ON a.node_id=e.parent_id WHERE e.dependency='continuous')
        SELECT COUNT(*) AS total FROM affected`).get(target.authority_node_id);
      const common = { security_revision: revision, affected_authority_count: Number(count.total), cleanup_batch_id: null };
      const result: Response = action === familyAction ? { ...common, family_id: targetId, status: 'revoked' } : { ...common, grant: {
        id: targetId, subject: { type: target.subject_type, id: target.subject_id }, generation: Number(target.generation), scope: 'system',
        status: 'revoked', effective: false, effective_reason_code: 'grant_revoked', authority_node_id: target.authority_node_id,
        issuer: { type: target.issuer_type, id: target.issuer_id }, origin_attempt_id: target.issuer_attempt_id, origin_family_id: target.origin_family_id,
        reason: target.reason, revocation_reason: input.reason, created_at: new Date(Number(target.created_at_ms)).toISOString(),
        expires_at: target.expires_at_ms === null ? null : new Date(Number(target.expires_at_ms)).toISOString(), revoked_at: new Date(now).toISOString(), revision } };
      if (!this.db.query(`UPDATE multiremi_security_state SET security_revision=? WHERE singleton=1 AND security_revision=? RETURNING singleton`)
        .get(revision, before)) throw new SecurityAbort('authority_revision_conflict');
      this.db.query(`INSERT INTO multiremi_root_management_events(actor_user_id,action,target_id,idempotency_key,payload_digest,proof_node_id,
        actor_grant_id,actor_generation,reason,reason_code,revision_before,revision_after,created_at_ms,result_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(...key, payload, this.evidence(bound.proof).node, current.recordedGrant.grantId, current.recordedGrant.generation,
          input.reason, input.reason_code ?? null, before, revision, now, JSON.stringify(result));
      return result;
    });
  }
}
