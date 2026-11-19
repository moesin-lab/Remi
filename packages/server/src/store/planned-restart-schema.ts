import type { SqlDatabase } from "./db/postgres.js";

/** Additive, shared SQLite/PG schema. Does not reinterpret any existing attempt status. */
export function ensurePlannedRestarts(db: SqlDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_planned_restarts (
    attempt_id TEXT PRIMARY KEY REFERENCES multiremi_turn_attempts(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL REFERENCES multiremi_turns(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL,
    runtime_id TEXT NOT NULL,
    daemon_id TEXT NOT NULL,
    handoff_id TEXT NOT NULL UNIQUE,
    drain_id TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
    state TEXT NOT NULL CHECK (state IN ('requested','suspended','resuming','running')),
    consumer_id TEXT,
    checkpoint TEXT,
    checkpoint_sha256 TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_planned_restarts_runtime_state ON multiremi_planned_restarts(runtime_id,state);`);
}

