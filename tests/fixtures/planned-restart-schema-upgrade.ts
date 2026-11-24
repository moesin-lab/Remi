import { expect } from 'bun:test';
import type { SqlDatabase } from '../../packages/server/src/store/db/postgres.js';
import { runMigrations, runStartupMigrations } from '../../packages/server/src/store/migrations.js';
import { assertSchemaCompatible, readSchemaLevels } from '../../packages/server/src/store/schema-levels.js';
import { runSchemaExpands } from '../../packages/server/src/store/schema-migration-runner.js';
import { SCHEMA_MIGRATIONS } from '../../packages/server/src/store/schema-migrations.js';

/** Reproduce an enrolled pre-#128 database, including an in-flight old drain. */
export function verifyPlannedRestartSchemaUpgrade(db: SqlDatabase): void {
  const restoreLevel2 = () => {
    db.exec(`DROP TABLE multiremi_planned_restarts;
      ALTER TABLE multiremi_daemon_drains DROP COLUMN drain_id;
      DROP TABLE multiremi_feishu_command_results; ALTER TABLE multiremi_feishu_bot_configs DROP COLUMN wake_words_json;
      DELETE FROM multiremi_schema_steps WHERE level>=3;
      UPDATE multiremi_schema_meta SET expand_level=2;`);
  };
  runMigrations(db);
  db.run(`INSERT INTO multiremi_daemon_drains(workspace_id,daemon_id,started_at,deadline,reason)
    VALUES('local','pre128','2026-11-19','2026-11-20','deploy')`);
  restoreLevel2();
  const step = SCHEMA_MIGRATIONS.find(step => step.level === 3)!;
  // All DDL, backfill and bookkeeping must roll back together.
  expect(() => runSchemaExpands(db, [{ ...step, run(guarded) {
    step.run(guarded); throw new Error('planned restart injected rollback');
  } }], '0.2.95', { minLevel: 3, maxLevel: 3 })).toThrow('planned restart injected rollback');
  expect(readSchemaLevels(db)).toEqual({ expandLevel: 2, contractLevel: 0 });
  expect(db.query('SELECT id FROM multiremi_schema_steps WHERE level=3').all()).toEqual([]);
  expect(db.query('PRAGMA table_info(multiremi_daemon_drains)').all().some(column => column.name === 'drain_id')).toBe(false);
  expect(() => db.query('SELECT * FROM multiremi_planned_restarts').all()).toThrow();

  for (const historicalMaintenance of [false, true]) {
    if (historicalMaintenance) restoreLevel2();
    if (historicalMaintenance) runMigrations(db, { historicalMaintenance: true });
    else runStartupMigrations(db);
    expect(readSchemaLevels(db)).toEqual({ expandLevel: 5, contractLevel: 0 });
    expect(() => assertSchemaCompatible(readSchemaLevels(db), { minLevel: 2, maxLevel: 2 })).not.toThrow();
    expect(db.query('SELECT * FROM multiremi_planned_restarts').all()).toEqual([]);
    const indexes = db.dialect === 'postgres'
      ? db.query("SELECT indexname AS name FROM pg_indexes WHERE schemaname='public' AND tablename='multiremi_planned_restarts'").all()
      : db.query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='multiremi_planned_restarts'").all();
    expect(indexes.some(index => index.name === 'idx_planned_restarts_runtime_state')).toBe(true);
    expect(db.query('SELECT id FROM multiremi_schema_steps WHERE level=3').get()?.id).toBe(step.id);
    const columns = db.query('PRAGMA table_info(multiremi_daemon_drains)').all();
    expect(columns.find(column => column.name === 'drain_id')?.notnull).toBe(0);
    const row = db.query("SELECT reason,drain_id FROM multiremi_daemon_drains WHERE daemon_id='pre128'").get();
    expect(row?.reason).toBe('deploy');
    expect(row?.drain_id).toMatch(/^[0-9a-f-]{36}$/);
    runStartupMigrations(db);
    expect(db.query("SELECT reason,drain_id FROM multiremi_daemon_drains WHERE daemon_id='pre128'").get()).toEqual(row);
    // Both the old projection and the new lookup are usable after expand.
    expect(db.query("SELECT daemon_id FROM multiremi_daemon_drains WHERE daemon_id='pre128'").get()?.daemon_id).toBe('pre128');
    expect(db.query('SELECT attempt_id FROM multiremi_planned_restarts WHERE runtime_id=? AND state=?').all('pre128','requested')).toEqual([]);
  }
}
