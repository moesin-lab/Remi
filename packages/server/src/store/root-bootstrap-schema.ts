import type { SqlDatabase } from './db/postgres.js';

export function expandBootstrapAuthorizations(db: SqlDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_root_bootstrap_authorizations (
    authorization_digest TEXT PRIMARY KEY NOT NULL, deployment_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES multiremi_users(id), reason TEXT NOT NULL,
    expires_at_ms BIGINT NOT NULL, consumed_at_ms BIGINT, grant_id TEXT REFERENCES multiremi_root_grants(grant_id),
    proof_node_id TEXT REFERENCES multiremi_authority_nodes(node_id), revision_before INTEGER, revision_after INTEGER
  )`);
}
