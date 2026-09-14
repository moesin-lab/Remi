import type { SqlDatabase } from "@multiremi/store/db/postgres.js";

/** Additive schema: legacy connectors and their conversation records are untouched. */
export function ensureBotSchema(db: SqlDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS multiremi_bots (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
      default_target TEXT NOT NULL, routes TEXT NOT NULL DEFAULT '[]',
      allowlist_enabled INTEGER NOT NULL DEFAULT 0, issue_notifications TEXT, deleted_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_multiremi_bots_workspace ON multiremi_bots(workspace_id);
    CREATE TABLE IF NOT EXISTS multiremi_bot_platform_bindings (
      id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, platform TEXT NOT NULL,
      app_id TEXT NOT NULL, domain TEXT NOT NULL, host_runtime_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 0,
      removed INTEGER NOT NULL DEFAULT 0, app_secret_encrypted TEXT NOT NULL,
      app_secret_hint TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_multiremi_bot_platforms_bot ON multiremi_bot_platform_bindings(bot_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_multiremi_bot_active_account
      ON multiremi_bot_platform_bindings(platform, domain, app_id) WHERE active = 1;
    CREATE TABLE IF NOT EXISTS multiremi_bot_runtime_states (
      bot_id TEXT NOT NULL, platform_binding_id TEXT NOT NULL, runtime_id TEXT NOT NULL,
      applied_revision INTEGER NOT NULL, state TEXT NOT NULL,
      bot_name TEXT, bot_open_id TEXT, error_code TEXT, error_message TEXT,
      reported_at TEXT NOT NULL, PRIMARY KEY(platform_binding_id, runtime_id)
    );
    CREATE TABLE IF NOT EXISTS multiremi_bot_senders (
      id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, platform_binding_id TEXT NOT NULL,
      external_id TEXT NOT NULL, display_name TEXT, allowed INTEGER NOT NULL DEFAULT 0,
      first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      UNIQUE(platform_binding_id, external_id)
    );
    CREATE TABLE IF NOT EXISTS multiremi_bot_sessions (
      id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, platform_binding_id TEXT NOT NULL,
      external_session_key TEXT NOT NULL, target_key TEXT NOT NULL, target TEXT NOT NULL,
      chat_session_id TEXT NOT NULL, chat_id TEXT, thread_id TEXT, reply_to_message_id TEXT,
      closed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_multiremi_bot_session_identity
      ON multiremi_bot_sessions(platform_binding_id, external_session_key, target_key) WHERE closed = 0;
    CREATE INDEX IF NOT EXISTS idx_multiremi_bot_sessions_chat ON multiremi_bot_sessions(chat_session_id);
    CREATE TABLE IF NOT EXISTS multiremi_bot_deliveries (
      platform_binding_id TEXT NOT NULL, external_message_id TEXT NOT NULL,
      bot_session_id TEXT NOT NULL, task_id TEXT NOT NULL, sender_id TEXT,
      reply_to_message_id TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY(platform_binding_id, external_message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_multiremi_bot_deliveries_task ON multiremi_bot_deliveries(task_id);
    CREATE TABLE IF NOT EXISTS multiremi_bot_round_pushes (
      id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, platform_binding_id TEXT NOT NULL,
      bot_session_id TEXT NOT NULL, issue_id TEXT NOT NULL, leader_task_id TEXT NOT NULL,
      wake_task_id TEXT NOT NULL, delivery_mode TEXT NOT NULL, chat_id TEXT NOT NULL,
      thread_id TEXT, reply_to_message_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(bot_session_id,leader_task_id)
    );
    CREATE INDEX IF NOT EXISTS idx_multiremi_bot_round_push_task ON multiremi_bot_round_pushes(wake_task_id);
    CREATE TABLE IF NOT EXISTS multiremi_bot_reply_messages (
      platform_binding_id TEXT NOT NULL, external_message_id TEXT NOT NULL,
      bot_session_id TEXT NOT NULL, task_id TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(platform_binding_id, external_message_id)
    );
    CREATE TABLE IF NOT EXISTS multiremi_bot_outbound_deliveries (
      id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, platform_binding_id TEXT NOT NULL,
      bot_session_id TEXT NOT NULL, task_id TEXT UNIQUE, chat_id TEXT NOT NULL,
      thread_id TEXT, reply_to_message_id TEXT, update_message_id TEXT, body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', available_at TEXT NOT NULL,
      claim_token TEXT, leased_until TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,
      external_message_id TEXT, last_error TEXT, sent_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_multiremi_bot_outbound_pending
      ON multiremi_bot_outbound_deliveries(platform_binding_id, status, available_at);
  `);
}
