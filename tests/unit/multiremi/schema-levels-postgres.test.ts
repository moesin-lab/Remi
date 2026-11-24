import { verifyFeishuWakeWordUpgrade } from "../../fixtures/feishu-wake-word-schema-upgrade.js";
import { verifyPlannedRestartSchemaUpgrade } from "../../fixtures/planned-restart-schema-upgrade.js";
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { PostgresSyncDatabase, advisoryLock } from '@multiremi/store/db/postgres.js';
import { MIGRATION_ADVISORY_LOCK_KEY } from '@multiremi/store/advisory-locks.js';
import { assertSchemaCompatible, readSchemaLevels } from '@multiremi/store/schema-levels.js';
import { runMigrations, runStartupMigrations } from '@multiremi/store/migrations.js';
import { assertSchemaContractClientsOffline } from '@multiremi/store/schema-contracts.js';
import { runSchemaExpands, runSchemaContracts, type SchemaMigration } from '@multiremi/store/schema-migration-runner.js';

const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
describe.skipIf(!adminUrl)('schema protocol on real PostgreSQL', () => {
  let admin: Bun.SQL, db: PostgresSyncDatabase, url: string;
  const name = `mul173_${process.pid}_${crypto.randomUUID().replaceAll('-', '')}`;
  let created = false;
  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(adminUrl!).hostname)) throw new Error('Requires local PostgreSQL');
    admin = new Bun.SQL(adminUrl!, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${name}`); created = true;
    const target = new URL(adminUrl!); target.pathname = `/${name}`; url = target.toString();
    db = new PostgresSyncDatabase(url);
  });
  afterAll(async () => {
    db?.close();
    try { if (created) await admin.unsafe(`DROP DATABASE ${name}`); }
    finally { await admin?.close(); }
  });
  it('enrolls and reopens the production migration chain on PostgreSQL', () => {
    expect(readSchemaLevels(db)).toEqual({ expandLevel: 0, contractLevel: 0 });
    runMigrations(db); runMigrations(db);
    expect(readSchemaLevels(db)).toEqual({ expandLevel: 4, contractLevel: 0 });
  }, 30_000);
  it('adds A3 live terms to an enrolled level 1 database and preserves old reader compatibility', () => {
    db.exec('ALTER TABLE multiremi_feishu_bot_configs DROP COLUMN wake_words_json; DROP TABLE multiremi_live_terms');
    db.exec('DELETE FROM multiremi_schema_steps WHERE level>=2');
    db.exec('UPDATE multiremi_schema_meta SET expand_level=1');
    runStartupMigrations(db);
    expect(readSchemaLevels(db)).toEqual({ expandLevel: 4, contractLevel: 0 });
    expect(db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='multiremi_live_terms'").get()).not.toBeNull();
    expect(() => assertSchemaCompatible(readSchemaLevels(db), { minLevel: 1, maxLevel: 1 })).not.toThrow();
    console.info('A3 startup expand: level 1 -> 2, live terms table exists; previous B1 reader interval [1,1] remains compatible');
  });
  it('refuses contracted schemas before historical migrations execute', () => {
    db.exec('UPDATE multiremi_schema_meta SET expand_level=5, contract_level=5');
    try {
      let refusal: Error | undefined;
      try { runStartupMigrations(db); } catch (error) { refusal = error as Error; }
      expect(refusal?.message).toContain('contract_level=5 exceeds code maxLevel=4');
      console.info(`startup guard: ${refusal?.message}`);
    }
    finally { db.exec('UPDATE multiremi_schema_meta SET contract_level=0, expand_level=4'); }
  });
  it('upgrades existing bot rows and accepts old writers after level 4', () => {
    verifyFeishuWakeWordUpgrade(db);
  }, 30_000);
  it('upgrades level 2 planned restart schema atomically and preserves old drains on PostgreSQL', () => {
    verifyPlannedRestartSchemaUpgrade(db);
  }, 30_000);
  it('production maintenance CLI refuses undeclared contract and retains the floor', () => {
    db.close();
    const childHome = mkdtempSync(join(tmpdir(), 'mul173-contract-cli-'));
    let child;
    try { child = Bun.spawnSync([process.execPath, 'apps/remi/main.ts', 'db', 'contract', '--level', '1'], {
      cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: childHome, BUN_INSTALL_CACHE_DIR: join(childHome, 'cache'), MULTIREMI_DATABASE_URL: url }, stdout: 'pipe', stderr: 'pipe',
    });
    } finally { rmSync(childHome, { recursive: true, force: true }); }
    db = new PostgresSyncDatabase(url);
    expect(child.exitCode).not.toBe(0);
    expect(child.stderr.toString()).toContain('No declared contract migration');
    expect(readSchemaLevels(db).contractLevel).toBe(0);
    console.info('explicit CLI contract --level 1: refused (No declared contract migration for the target level); contractLevel=0');
  });
  it('rejects all four COLUMN-omitted destructive actions without advancing metadata', () => {
    db.exec('CREATE TABLE mul173_omitted_column (c TEXT)');
    const before = readSchemaLevels(db);
    const columns = () => db.query("SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_name='mul173_omitted_column' ORDER BY ordinal_position").all();
    const original = columns();
    for (const [index, action] of ['DROP c', 'RENAME c TO d', 'ALTER c TYPE integer', 'ALTER c SET NOT NULL'].entries()) {
      const sql = `ALTER TABLE mul173_omitted_column ${action}`;
      const id = `pg-omitted-column-${index}`;
      const steps: SchemaMigration[] = [{ id, phase: 'expand', level: before.expandLevel + 1,
        expandRelease: '9.0.0', release: '9.0.0', run: guarded => guarded.exec(sql) }];
      expect(() => runSchemaExpands(db, steps, '9.0.0', { minLevel: 2, maxLevel: 2 })).toThrow('Destructive DDL is forbidden');
      expect(readSchemaLevels(db)).toEqual(before);
      expect(db.query('SELECT id FROM multiremi_schema_steps WHERE id=?').get(id)).toBeNull();
      expect(columns()).toEqual(original);
      console.info(`Rejected through runSchemaExpands: ${sql}; expandLevel=${before.expandLevel}, contractLevel=${before.contractLevel}; step absent, columns unchanged`);
    }
  });
  it('checks actual online clients before contract, and executes after they disconnect', async () => {
    const steps: SchemaMigration[] = [{ id: 'pg-expand', phase: 'expand', level: 1, expandRelease: '1.0.0', release: '1.0.0',
      run: db => db.exec('CREATE TABLE mul173_retained (id INTEGER)') },
    { id: 'pg-contract', phase: 'contract', level: 1, expandRelease: '1.0.0', release: '1.1.0',
      run: db => db.exec('DROP TABLE mul173_retained') }];
    const code = { minLevel: 1, maxLevel: 1 };
    runSchemaExpands(db, steps, '1.1.0', code);
    expect(readSchemaLevels(db).contractLevel).toBe(0);
    expect(db.query("SELECT table_name FROM information_schema.tables WHERE table_name='mul173_retained'").get()).not.toBeNull();
    console.info('startup expand at later release: retained table exists; contractLevel=0');
    const other = new Bun.SQL(url, { max: 1 });
    try {
      await other`SELECT 1`;
      expect(() => advisoryLock(db, MIGRATION_ADVISORY_LOCK_KEY, () => runSchemaContracts(db, steps, {
        release: '1.1.0', targetLevel: 1, code, assertSlotsCompatible: () => assertSchemaContractClientsOffline(db),
      }))).toThrow('other database clients are online');
      expect(readSchemaLevels(db).contractLevel).toBe(0);
    } finally { await other.close(); }
    // Wait only for PostgreSQL to observe the closed socket, never ignore an
    // active client or substitute a fixture inventory.
    for (let attempt = 0; ; attempt++) {
      try { assertSchemaContractClientsOffline(db); break; }
      catch (error) { if (attempt === 100) throw error; await Bun.sleep(10); }
    }
    advisoryLock(db, MIGRATION_ADVISORY_LOCK_KEY, () => runSchemaContracts(db, steps, {
      release: '1.1.0', targetLevel: 1, code, assertSlotsCompatible: () => assertSchemaContractClientsOffline(db),
    }));
    expect(readSchemaLevels(db).contractLevel).toBe(1);
    console.info('explicit maintenance executor: online client refused; after disconnect contractLevel=1 and retained table removed');
    expect(db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='mul173_retained'").get()).toBeNull();
  }, 15_000);
});
