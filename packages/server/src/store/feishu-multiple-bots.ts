import type { SqlDatabase } from "./db/postgres.js";

const MIGRATION = "20261009_feishu_multiple_bots";

/** Give the original bot a stable `default` identity, including a deleted bot's
 * outstanding Runtime state. SQLite suspends foreign keys while rebuilding
 * identity constraints, preserving referenced IDs, indexes and ciphertext. */
export function migrateFeishuMultipleBots(db: SqlDatabase): void {
  if (db.query("SELECT id FROM multiremi_schema_migrations WHERE id = ?").get(MIGRATION)) return;
  const foreignKeys = db.dialect !== "postgres" && Number(db.query("PRAGMA foreign_keys").get()?.foreign_keys) === 1;
  if (foreignKeys) db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.transaction(() => {
      const tables = ["configs", "runtime_states", "agent_routes", "deliveries", "audit", "chat_bindings", "senders", "inbound_attachments"];
      for (const suffix of tables) {
        db.exec(`ALTER TABLE multiremi_feishu_bot_${suffix} ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'default'`);
      }
      db.exec("ALTER TABLE multiremi_feishu_bot_configs ADD COLUMN name TEXT NOT NULL DEFAULT ''");
      db.exec("ALTER TABLE multiremi_feishu_bot_runtime_states ADD COLUMN release_pending INTEGER NOT NULL DEFAULT 0");
      db.exec("ALTER TABLE multiremi_feishu_bot_runtime_states ADD COLUMN stopping_app_id TEXT");
      const identities = [
        ["configs", "workspace_id, bot_id"],
        ["runtime_states", "workspace_id, bot_id, runtime_id"],
        ["deliveries", "workspace_id, bot_id, external_message_id"],
      ];
      if (db.dialect === "postgres") {
        for (const [suffix, columns] of identities) {
          const table = `multiremi_feishu_bot_${suffix}`;
          db.exec(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_pkey`);
          db.exec(`ALTER TABLE ${table} ADD PRIMARY KEY (${columns})`);
        }
        for (const [suffix, columns] of [["agent_routes", "scope, chat_id"], ["chat_bindings", "app_id, agent_id, external_session_key"], ["senders", "app_id, open_id"]]) {
          const table = `multiremi_feishu_bot_${suffix}`;
          const unique = db.query(`SELECT conname FROM pg_constraint WHERE conrelid = ?::regclass AND contype = 'u' AND pg_get_constraintdef(oid) LIKE '%workspace_id%'`).all(table);
          for (const row of unique) {
            const name = String(row.conname).replaceAll('"', '""');
            db.exec(`ALTER TABLE ${table} DROP CONSTRAINT "${name}"`);
          }
          db.exec(`ALTER TABLE ${table} ADD UNIQUE (workspace_id, bot_id, ${columns})`);
        }
      } else {
        for (const [suffix, columns] of [...identities, ["agent_routes", ""], ["chat_bindings", ""], ["senders", ""]]) {
          const table = `multiremi_feishu_bot_${suffix}`;
          const schema = String(db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)!.sql);
          const indexes = db.query("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(table);
          const names = db.query(`PRAGMA table_info(${table})`).all().map(row => `"${row.name}"`).join(", ");
          let next = schema.replace(new RegExp(`(CREATE TABLE\\s+["\x60]?)${table}(["\x60]?)`, "i"), `$1${table}_multi$2`);
          if (suffix === "configs") {
            next = next.replace(/workspace_id TEXT PRIMARY KEY/i, "workspace_id TEXT NOT NULL");
            next = next.replace(/\)\s*$/, `, PRIMARY KEY (${columns}))`);
          } else if (columns) {
            next = next.replace(/PRIMARY KEY\s*\([^)]*\)/i, `PRIMARY KEY (${columns})`);
          } else {
            next = next.replace(/UNIQUE\s*\(workspace_id, /i, "UNIQUE(workspace_id, bot_id, ");
          }
          db.exec(next);
          db.exec(`INSERT INTO ${table}_multi (${names}) SELECT ${names} FROM ${table}`);
          db.exec(`DROP TABLE ${table}`);
          db.exec(`ALTER TABLE ${table}_multi RENAME TO ${table}`);
          for (const index of indexes) db.exec(String(index.sql).replace("(workspace_id, scope)", "(workspace_id, bot_id, scope)"));
        }
      }
      db.exec(`DROP INDEX IF EXISTS idx_multiremi_feishu_bot_agent_routes_default_scope;
        CREATE UNIQUE INDEX idx_multiremi_feishu_bot_agent_routes_default_scope
          ON multiremi_feishu_bot_agent_routes(workspace_id, bot_id, scope) WHERE chat_id IS NULL;
        CREATE UNIQUE INDEX idx_multiremi_feishu_bot_configs_app ON multiremi_feishu_bot_configs(workspace_id, app_id);
        CREATE UNIQUE INDEX idx_multiremi_feishu_bot_configs_runtime ON multiremi_feishu_bot_configs(workspace_id, runtime_id);
        CREATE INDEX idx_multiremi_feishu_bot_audit_bot ON multiremi_feishu_bot_audit(workspace_id, bot_id, seq);`);
      db.run("INSERT INTO multiremi_schema_migrations(id, applied_at) VALUES (?, ?)", [MIGRATION, new Date().toISOString()]);
      if (db.dialect !== "postgres" && db.query("PRAGMA foreign_key_check").all().length) throw new Error("Feishu bot migration introduced invalid foreign keys");
    })();
  } finally { if (foreignKeys) db.exec("PRAGMA foreign_keys = ON"); }
}
