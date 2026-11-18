import { afterEach, describe, expect, it } from 'bun:test';
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import type { SqlDatabase } from '@multiremi/store/db/postgres.js';
import { assertSchemaCompatible, assertSchemaBeforeExpand, ensureSchemaMeta, readSchemaLevels } from '@multiremi/store/schema-levels.js';
import { runSchemaContracts, runSchemaExpands, validateSchemaMigrations, type SchemaMigration } from '@multiremi/store/schema-migration-runner.js';
import { contractSchema } from '@multiremi/store/schema-contracts.js';
import { runMigrations } from '@multiremi/store/migrations.js';

let database: ReturnType<typeof openSqliteDatabase>;
afterEach(() => database?.close());
function db(): SqlDatabase { database = openSqliteDatabase(':memory:'); return database as unknown as SqlDatabase; }
const code = { minLevel: 1, maxLevel: 2 };
const expand = (level: number, run: SchemaMigration['run'] = () => {}): SchemaMigration => ({
  id: `expand-${level}`, phase: 'expand', level, expandRelease: '1.0.0', release: '1.0.0', run,
});
const contract = (level: number, run: SchemaMigration['run'] = () => {}): SchemaMigration => ({
  id: `contract-${level}`, phase: 'contract', level, expandRelease: '1.0.0', release: '1.1.0', run,
});

describe('schema compatibility protocol', () => {
  it('allows newer additions but refuses an incompatible contract floor', () => {
    expect(() => assertSchemaCompatible({ expandLevel: 5, contractLevel: 1 }, { minLevel: 1, maxLevel: 1 })).not.toThrow();
    expect(() => assertSchemaCompatible({ expandLevel: 5, contractLevel: 2 }, { minLevel: 1, maxLevel: 1 })).toThrow('Start a newer compatible release');
    expect(() => assertSchemaCompatible({ expandLevel: 0, contractLevel: 0 }, code)).toThrow('expand migrations');
    expect(() => assertSchemaCompatible({ expandLevel: 1, contractLevel: 2 }, code)).toThrow('Invalid schema metadata');
    expect(() => assertSchemaCompatible({ expandLevel: NaN, contractLevel: 0 }, code)).toThrow('Invalid schema metadata');
    expect(() => assertSchemaCompatible({ expandLevel: 1, contractLevel: 0 }, { minLevel: 2, maxLevel: 1 })).toThrow('Invalid code');
  });
  it('enrolls a legacy/fresh database and refuses out of range startup without writes', () => {
    const database = db();
    expect(readSchemaLevels(database)).toEqual({ expandLevel: 0, contractLevel: 0 });
    runMigrations(database);
    expect(readSchemaLevels(database)).toEqual({ expandLevel: 1, contractLevel: 0 });
    runMigrations(database);
    expect(database.query('SELECT id FROM multiremi_schema_steps').all()).toHaveLength(1);
    database.exec('UPDATE multiremi_schema_meta SET expand_level=2, contract_level=2');
    const before = database.query('SELECT total_changes() AS count').get();
    expect(() => runMigrations(database)).toThrow('contract_level=2 exceeds code maxLevel=1');
    expect(database.query('SELECT total_changes() AS count').get()).toEqual(before);
  });
  it('rejects an empty/corrupt metadata table instead of treating it as legacy', () => {
    const database = db(); ensureSchemaMeta(database);
    database.exec('DELETE FROM multiremi_schema_meta');
    expect(() => assertSchemaBeforeExpand(database)).toThrow('exactly one');
  });
  it('commits each expand with its marker and resumes after failure', () => {
    const database = db(); let fails = true;
    const steps = [expand(1, db => db.exec('CREATE TABLE added_one (id INTEGER)')), expand(2, db => {
      db.exec('CREATE TABLE added_two (id INTEGER)');
      if (fails) throw new Error('injected');
    })];
    expect(() => runSchemaExpands(database, steps, '1.0.0', code)).toThrow('injected');
    expect(readSchemaLevels(database)).toEqual({ expandLevel: 1, contractLevel: 0 });
    expect(database.query("SELECT name FROM sqlite_master WHERE name='added_two'").get()).toBeNull();
    fails = false; runSchemaExpands(database, steps, '1.0.0', code); runSchemaExpands(database, steps, '1.0.0', code);
    expect(readSchemaLevels(database)).toEqual({ expandLevel: 2, contractLevel: 0 });
    expect(database.query('SELECT id FROM multiremi_schema_steps').all()).toHaveLength(2);
  });
  it('never executes contract callbacks at startup and enforces later release + inventory gates', () => {
    const database = db(); let contracted = false; let inventoryCalls = 0;
    const steps = [expand(1, db => db.exec('CREATE TABLE retained (id INTEGER)')), contract(1, db => {
      db.exec('DROP TABLE retained'); contracted = true;
    })];
    runSchemaExpands(database, steps, '1.1.0', code);
    expect(contracted).toBe(false);
    const input = { release: '1.0.0', targetLevel: 1, code, assertSlotsCompatible: () => { inventoryCalls++; } };
    expect(() => runSchemaContracts(database, steps, input)).toThrow('release gate');
    expect(inventoryCalls).toBe(0);
    expect(() => runSchemaContracts(database, steps, { ...input, release: '1.1.0', assertSlotsCompatible: () => { throw new Error('old slot online'); } })).toThrow('old slot online');
    expect(contracted).toBe(false);
    runSchemaContracts(database, steps, { ...input, release: '1.1.0' });
    expect(contracted).toBe(true);
    expect(readSchemaLevels(database)).toEqual({ expandLevel: 1, contractLevel: 1 });
    runSchemaContracts(database, steps, { ...input, release: '1.1.0' });
  });
  it('refuses same-release contraction, undefined targets, rewrites and SQLite maintenance', () => {
    const database = db();
    expect(() => validateSchemaMigrations([{ ...contract(1), release: '1.0.0' }])).toThrow('after its expand');
    runSchemaExpands(database, [expand(1)], '1.0.0', code);
    expect(() => runSchemaExpands(database, [{ ...expand(1), release: '1.0.1' }], '1.0.1', code)).toThrow('redefined');
    expect(() => runSchemaContracts(database, [], { release: '1.1.0', targetLevel: 1, code, assertSlotsCompatible() {} })).toThrow('No declared contract');
    expect(() => contractSchema(database, 1)).toThrow('requires PostgreSQL');
  });
  it('blocks dynamically generated destructive SQL through every expand statement entry', () => {
    const database = db(); database.exec('CREATE TABLE retained (id INTEGER)');
    for (const method of ['exec', 'run', 'query', 'prepare'] as const) {
      expect(() => runSchemaExpands(database, [expand(1, db => { db[method](['DROP', 'TABLE', 'retained'].join(' ')); })], '1.0.0', code)).toThrow('Destructive DDL');
      expect(readSchemaLevels(database)).toEqual({ expandLevel: 0, contractLevel: 0 });
      expect(database.query("SELECT name FROM sqlite_master WHERE name='retained'").get()).toBeTruthy();
    }
  });
});
