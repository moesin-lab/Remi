import type { SqlDatabase } from './db/postgres.js';
/** Shared additive SQLite/PostgreSQL migration. Unknown owns the CR until reconciled. */
export function ensureMergeOperationSchema(db: SqlDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_scm_merge_operations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES multiremi_projects(id) ON DELETE CASCADE,
    change_request_id TEXT NOT NULL REFERENCES multiremi_scm_change_requests(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL,
    request_body TEXT NOT NULL,
    state TEXT NOT NULL,
    version INTEGER NOT NULL,
    lease_until TEXT,
    operation TEXT NOT NULL,
    UNIQUE(project_id, change_request_id, idempotency_key)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_scm_merge_one_active ON multiremi_scm_merge_operations(change_request_id)
    WHERE state IN ('requested','awaiting_human','approved','executing','unknown');
  CREATE TABLE IF NOT EXISTS multiremi_scm_merge_request_keys (
    project_id TEXT NOT NULL, change_request_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
    operation_id TEXT NOT NULL REFERENCES multiremi_scm_merge_operations(id) ON DELETE CASCADE,
    request_body TEXT NOT NULL, PRIMARY KEY(project_id,change_request_id,idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS idx_scm_merge_recovery ON multiremi_scm_merge_operations(state, lease_until);`);
}
