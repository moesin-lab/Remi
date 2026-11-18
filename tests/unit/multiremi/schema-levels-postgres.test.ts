import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { PostgresSyncDatabase, advisoryLock } from '@multiremi/store/db/postgres.js';
import { MIGRATION_ADVISORY_LOCK_KEY } from '@multiremi/store/advisory-locks.js';
import { readSchemaLevels } from '@multiremi/store/schema-levels.js';
import { runMigrations } from '@multiremi/store/migrations.js';
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
    expect(readSchemaLevels(db)).toEqual({ expandLevel: 1, contractLevel: 0 });
  }, 30_000);
  it('refuses contracted schemas before historical migrations execute', () => {
    db.exec('UPDATE multiremi_schema_meta SET expand_level=2, contract_level=2');
    try { expect(() => runMigrations(db)).toThrow('contract_level=2 exceeds code maxLevel=1'); }
    finally { db.exec('UPDATE multiremi_schema_meta SET contract_level=0, expand_level=1'); }
  });
  it('checks actual online clients before contract, and executes after they disconnect', async () => {
    const steps: SchemaMigration[] = [{ id: 'pg-expand', phase: 'expand', level: 1, expandRelease: '1.0.0', release: '1.0.0',
      run: db => db.exec('CREATE TABLE mul173_retained (id INTEGER)') },
    { id: 'pg-contract', phase: 'contract', level: 1, expandRelease: '1.0.0', release: '1.1.0',
      run: db => db.exec('DROP TABLE mul173_retained') }];
    const code = { minLevel: 1, maxLevel: 1 };
    runSchemaExpands(db, steps, '1.0.0', code);
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
    expect(db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='mul173_retained'").get()).toBeNull();
  }, 15_000);
});
