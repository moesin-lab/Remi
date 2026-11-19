import { randomUUID } from "node:crypto";
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

/** Shared by historical drains setup and the level-3 enrolled upgrade. */
export function ensureDaemonDrainIdentity(db: SqlDatabase): void {
  const columns = db.query("PRAGMA table_info(multiremi_daemon_drains)").all();
  if (!columns.some(column => column.name === "drain_id")) {
    db.exec("ALTER TABLE multiremi_daemon_drains ADD COLUMN drain_id TEXT");
  }
  for (const row of db.query("SELECT workspace_id,daemon_id FROM multiremi_daemon_drains WHERE drain_id IS NULL").all()) {
    db.run("UPDATE multiremi_daemon_drains SET drain_id=? WHERE workspace_id=? AND daemon_id=? AND drain_id IS NULL",
      [randomUUID(), row.workspace_id, row.daemon_id]);
  }
}
