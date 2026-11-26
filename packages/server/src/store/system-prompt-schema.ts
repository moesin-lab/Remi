import type { SqlDatabase } from "./db/postgres.js";

/** Additive schema only; historical bootstrap and its fingerprint remain frozen. */
export function ensureSystemPrompts(db: SqlDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS multiremi_system_prompt_documents (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      key TEXT NOT NULL CHECK (key = 'system-policy'),
      current_version_id TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (workspace_id, key),
      UNIQUE (id, workspace_id)
    );
    CREATE TABLE IF NOT EXISTS multiremi_system_prompt_versions (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('default', 'custom')),
      operation TEXT NOT NULL CHECK (operation IN ('initialize', 'edit', 'reset', 'rollback')),
      content_snapshot_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      base_default_revision TEXT NOT NULL,
      base_default_snapshot_json TEXT NOT NULL,
      restored_from_version_id TEXT,
      parent_version_id TEXT,
      actor_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      change_note TEXT,
      request_id TEXT,
      request_hash TEXT,
      UNIQUE (document_id, version_number),
      UNIQUE (document_id, request_id),
      UNIQUE (id, document_id, workspace_id),
      FOREIGN KEY (document_id, workspace_id) REFERENCES multiremi_system_prompt_documents (id, workspace_id),
      FOREIGN KEY (parent_version_id, document_id, workspace_id) REFERENCES multiremi_system_prompt_versions (id, document_id, workspace_id),
      FOREIGN KEY (restored_from_version_id, document_id, workspace_id) REFERENCES multiremi_system_prompt_versions (id, document_id, workspace_id)
    );
    CREATE TABLE IF NOT EXISTS multiremi_attempt_system_prompts (
      task_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      document_id TEXT,
      version_id TEXT,
      binding_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (version_id, document_id, workspace_id) REFERENCES multiremi_system_prompt_versions (id, document_id, workspace_id)
    );
    CREATE INDEX IF NOT EXISTS idx_system_prompt_versions_workspace ON multiremi_system_prompt_versions (workspace_id, document_id, version_number);
    CREATE INDEX IF NOT EXISTS idx_attempt_system_prompts_workspace ON multiremi_attempt_system_prompts (workspace_id);
  `);
}
