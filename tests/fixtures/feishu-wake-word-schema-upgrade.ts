import { removeScmSchema } from "./scm-schema-upgrade.js";
import { expect } from "bun:test";
import type { SqlDatabase } from "../../packages/server/src/store/db/postgres.js";
import { runMigrations, runStartupMigrations } from "../../packages/server/src/store/migrations.js";
import { assertSchemaCompatible, readSchemaLevels, SCHEMA_EXPAND_LEVEL } from "../../packages/server/src/store/schema-levels.js";

export function verifyFeishuWakeWordUpgrade(db: SqlDatabase): void {
  runMigrations(db);
  removeScmSchema(db);
  db.exec(`DROP TABLE multiremi_feishu_command_results; ALTER TABLE multiremi_feishu_bot_configs DROP COLUMN wake_words_json;
    DELETE FROM multiremi_schema_steps WHERE level>=5;
    UPDATE multiremi_schema_meta SET expand_level=4;
    INSERT INTO multiremi_workspaces(id,name,slug,created_at,updated_at)
      VALUES ('ws_upgrade','Migration fixture','migration-fixture','2026-11-24','2026-11-24');`);
  const legacyInsert = `INSERT INTO multiremi_feishu_bot_configs
    (workspace_id,bot_id,agent_id,runtime_id,app_id,app_secret_encrypted,created_at,updated_at)
    VALUES ('ws_upgrade',?,'agent',?,?,'test-value','2026-11-24','2026-11-24')`;
  db.run(legacyInsert, ['first','rt_first','app_first']);
  runStartupMigrations(db);
  expect(readSchemaLevels(db)).toEqual({ expandLevel: SCHEMA_EXPAND_LEVEL, contractLevel: 0 });
  assertSchemaCompatible(readSchemaLevels(db), { minLevel: 4, maxLevel: 4 });
  db.run(legacyInsert, ['second','rt_second','app_second']);
  const words = (bot: string) => db.query(`SELECT wake_words_json FROM multiremi_feishu_bot_configs
    WHERE workspace_id='ws_upgrade' AND bot_id=?`).get(bot)?.wake_words_json;
  expect(words("first")).toBe("[]");
  expect(words("second")).toBe("[]");
  db.run(`UPDATE multiremi_feishu_bot_configs SET wake_words_json=? WHERE workspace_id='ws_upgrade' AND bot_id='first'`, ['["Ask"]']);
  db.exec(`UPDATE multiremi_feishu_bot_configs SET name='Updated by old writer' WHERE workspace_id='ws_upgrade'`);
  runStartupMigrations(db);
  removeScmSchema(db);
  db.exec('DROP TABLE multiremi_feishu_command_results; DELETE FROM multiremi_schema_steps WHERE level>=6; UPDATE multiremi_schema_meta SET expand_level=5');
  runStartupMigrations(db);
  assertSchemaCompatible(readSchemaLevels(db), { minLevel: 5, maxLevel: 5 });
  db.exec(`INSERT INTO multiremi_feishu_command_results VALUES ('ws_upgrade','feishu','app','om','first','ou','digest','new','{}','2026-11-25')`);
  db.run(legacyInsert, ['third','rt_third','app_third']);
  runStartupMigrations(db);
  expect(db.query('SELECT external_message_id FROM multiremi_feishu_command_results').all()).toEqual([{ external_message_id: 'om' }]);
  expect(words("first")).toBe('["Ask"]');
  expect(words("second")).toBe("[]");
}
