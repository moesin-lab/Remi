import type { SqlDatabase } from './db/postgres.js';

export function expandRootManagement(db: SqlDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_password_authority_versions (
    user_id TEXT NOT NULL REFERENCES multiremi_users(id),
    version INTEGER NOT NULL CHECK (version > 0), verifier_digest TEXT NOT NULL,
    password_node_id TEXT NOT NULL UNIQUE REFERENCES multiremi_authority_nodes(node_id),
    identity_node_id TEXT NOT NULL REFERENCES multiremi_authority_nodes(node_id),
    PRIMARY KEY(user_id,version), UNIQUE(user_id,verifier_digest)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_credential_families (
    family_id TEXT PRIMARY KEY NOT NULL, authority_node_id TEXT NOT NULL UNIQUE REFERENCES multiremi_authority_nodes(node_id),
    max_expires_at_ms BIGINT NOT NULL CHECK (max_expires_at_ms > 0), revoked_at_ms BIGINT, revision INTEGER NOT NULL CHECK (revision >= 0)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_root_management_events (
    actor_user_id TEXT NOT NULL, proof_node_id TEXT NOT NULL, actor_grant_id TEXT NOT NULL,
    actor_generation INTEGER NOT NULL, action TEXT NOT NULL, target_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL, payload_digest TEXT NOT NULL, reason TEXT NOT NULL, reason_code TEXT,
    revision_before INTEGER NOT NULL, revision_after INTEGER NOT NULL, created_at_ms BIGINT NOT NULL,
    result_json TEXT NOT NULL, PRIMARY KEY(actor_user_id,action,target_id,idempotency_key)
  )`);
}
