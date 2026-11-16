import type { SqlDatabase } from "./db/postgres.js";
/** Additive SQL shared by SQLite and PostgreSQL; no backend-specific defaults. */
export function ensureMergePolicySchema(db: SqlDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS multiremi_project_merge_policies (
      project_id TEXT PRIMARY KEY REFERENCES multiremi_projects(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      policy TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS multiremi_scm_cr_actors (
      id TEXT PRIMARY KEY,
      change_request_id TEXT NOT NULL REFERENCES multiremi_scm_change_requests(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scm_cr_actors_cr ON multiremi_scm_cr_actors(change_request_id);
    CREATE TABLE IF NOT EXISTS multiremi_scm_reviews (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES multiremi_projects(id) ON DELETE CASCADE,
      change_request_id TEXT NOT NULL REFERENCES multiremi_scm_change_requests(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      review TEXT NOT NULL,
      UNIQUE(project_id, change_request_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_scm_reviews_cr ON multiremi_scm_reviews(project_id, change_request_id);
  `);
}
