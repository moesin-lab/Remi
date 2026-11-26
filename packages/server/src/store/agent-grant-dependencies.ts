import type { SqlDatabase } from './db/postgres.js';
import type { SecurityTx } from './security-write.js';
import { SecurityAbort } from './security-write.js';

export interface AgentDependencySnapshot {
  readonly agentId: string;
  readonly configEpoch: number;
  readonly trustVersions: readonly { id: string; version: number }[];
  readonly refs: readonly { kind: string; id: string; version: number; digest: string; use: string }[];
  readonly digest: string;
}

export type ResolveAgentDependencies = (tx: SecurityTx, agentId: string, trustIds: readonly string[]) => AgentDependencySnapshot;

export function expandAgentGrantDependencies(db: SqlDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_agent_grant_dependencies (
    grant_id TEXT PRIMARY KEY NOT NULL REFERENCES multiremi_root_grants(grant_id), grant_generation INTEGER NOT NULL,
    agent_id TEXT NOT NULL, config_epoch INTEGER NOT NULL CHECK(config_epoch>=0), dependency_digest TEXT NOT NULL,
    trust_versions_json TEXT NOT NULL, invalidated_revision INTEGER
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_agent_grant_protected_refs (
    grant_id TEXT NOT NULL REFERENCES multiremi_agent_grant_dependencies(grant_id), kind TEXT NOT NULL, resource_id TEXT NOT NULL,
    resource_version INTEGER NOT NULL, digest TEXT NOT NULL, use_kind TEXT NOT NULL, PRIMARY KEY(grant_id,kind,resource_id,use_kind)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_grant_protected_resource ON multiremi_agent_grant_protected_refs(kind,resource_id,grant_id)`);
}

export function requireAgentDependencySnapshot(resolve: ResolveAgentDependencies | undefined, tx: SecurityTx, agentId: string,
  trustIds: readonly string[], acceptedDigest: string): AgentDependencySnapshot {
  if (!resolve || !trustIds.length || trustIds.some(id=>!id) || new Set(trustIds).size!==trustIds.length) throw new SecurityAbort('root_runtime_untrusted');
  const snapshot = resolve(tx,agentId,[...trustIds].sort());
  const validDigest = (value: string) => /^(?:sha256:)?[0-9a-f]{64}$/.test(value);
  if (snapshot.agentId!==agentId || !Number.isSafeInteger(snapshot.configEpoch) || snapshot.configEpoch<0 || !validDigest(acceptedDigest)
    || snapshot.digest!==acceptedDigest || snapshot.trustVersions.length!==trustIds.length || new Set(snapshot.trustVersions.map(trust=>trust.id)).size!==trustIds.length
    || snapshot.trustVersions.some(trust=>!trustIds.includes(trust.id) || !Number.isSafeInteger(trust.version) || trust.version<1)
    || !snapshot.refs.length || snapshot.refs.some(ref=>!ref.kind || !ref.id || !ref.use || !Number.isSafeInteger(ref.version) || ref.version<0 || !validDigest(ref.digest))) {
    throw new SecurityAbort('authority_revision_conflict');
  }
  return snapshot;
}
