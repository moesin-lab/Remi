import { assertScmOwnershipReady, classifyScmLinks } from "@multiremi/store/scm-ownership.js";
import { verifyPlannedRestartSchemaUpgrade } from "../../fixtures/planned-restart-schema-upgrade.js";
import { afterEach, describe, expect, it } from 'bun:test';
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import type { SqlDatabase } from '@multiremi/store/db/postgres.js';
import { assertSchemaCompatible, assertSchemaBeforeExpand, ensureSchemaMeta, readSchemaLevels } from '@multiremi/store/schema-levels.js';
import { runSchemaContracts, runSchemaExpands, validateSchemaMigrations, type SchemaMigration } from '@multiremi/store/schema-migration-runner.js';
import { contractSchema } from '@multiremi/store/schema-contracts.js';
import { runMigrations, runStartupMigrations } from '@multiremi/store/migrations.js';

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
    expect(() => assertScmOwnershipReady(database)).toThrow('cutover incomplete');
    classifyScmLinks(database);
    classifyScmLinks(database);
    expect(() => assertScmOwnershipReady(database)).not.toThrow();
    expect(database.query('SELECT cursor_id, complete FROM multiremi_scm_ownership_cutover').all()).toEqual([{ cursor_id: '', complete: 1 }]);
    expect(readSchemaLevels(database)).toEqual({ expandLevel: 4, contractLevel: 0 });
    runMigrations(database);
    expect(database.query('SELECT id FROM multiremi_schema_steps').all()).toHaveLength(4);
    database.exec('UPDATE multiremi_schema_meta SET expand_level=5, contract_level=5');
    const before = database.query('SELECT total_changes() AS count').get();
    expect(() => runMigrations(database)).toThrow('contract_level=5 exceeds code maxLevel=4');
    expect(database.query('SELECT total_changes() AS count').get()).toEqual(before);
  });
  it('requires maintenance for populated pre-protocol databases and never replays enrolled history', () => {
    const database = db();
    database.exec('CREATE TABLE multiremi_before_protocol (id INTEGER)');
    expect(() => runStartupMigrations(database)).toThrow('run remi db prepare');
    runMigrations(database, { historicalMaintenance: true });
    const original = database.exec.bind(database);
    const guarded = new Proxy(database, { get(target, key) {
      if (key === 'exec') return (sql: string) => {
        if (/RENAME|DROP|CREATE OR REPLACE/i.test(sql)) throw new Error('Historical DDL replayed');
        return original(sql);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    expect(() => runStartupMigrations(guarded)).not.toThrow();
  });
  it('expands an enrolled level 1 database with the live term table without historical replay', () => {
    const database = db();
    runMigrations(database);
    // Reproduce the previously enrolled B1 schema, before A3's additive table.
    database.exec("DROP TABLE multiremi_live_terms");
    database.exec("DELETE FROM multiremi_schema_steps WHERE level>=2");
    database.exec("UPDATE multiremi_schema_meta SET expand_level=1");
    runStartupMigrations(database);
    expect(readSchemaLevels(database)).toEqual({ expandLevel: 4, contractLevel: 0 });
    expect(database.query("SELECT name FROM sqlite_master WHERE name='multiremi_live_terms'").get()).not.toBeNull();
    expect(database.query("SELECT id FROM multiremi_schema_steps WHERE level=2").get().id).toBe('20261118_live_term_fence');
  });
  it('upgrades level 2 planned restart schema atomically and preserves old drains', () => {
    verifyPlannedRestartSchemaUpgrade(db());
  });
  it('rejects an empty/corrupt metadata table instead of treating it as legacy', () => {
    const database = db(); ensureSchemaMeta(database);
    database.exec('DELETE FROM multiremi_schema_meta');
    expect(() => assertSchemaBeforeExpand(database)).toThrow('exactly one');
  });
  it('preserves native SQLite receivers through the four-method statement facade', () => {
    const database = db();
    runSchemaExpands(database, [expand(1, guarded => {
      guarded.exec('CREATE TABLE retained(id integer)');
      guarded.run('INSERT INTO retained VALUES(?)', 42);
      for (const factory of ['query', 'prepare'] as const) {
        const statement = guarded[factory]('SELECT id FROM retained');
        expect(statement.get()).toEqual({id:42});
        expect(statement.all()).toEqual([{id:42}]);
        expect(statement.values()).toEqual([[42]]);
        statement.run();
        expect((statement as any).iterate).toBeUndefined();
      }
    })], '1.0.0', code);
    expect(readSchemaLevels(database).expandLevel).toBe(1);
  });
  it('sealed facade exposes only frozen null-prototype handles and no raw reachable objects', () => {
    const database = db();
    const forbidden = new Set<object>([database]);
    const wrapStatement = (statement: ReturnType<SqlDatabase['query']>) => {
      forbidden.add(statement);
      return statement;
    };
    // Instrument real SQLite handles without replacing their execution behavior.
    const target: SqlDatabase = {
      dialect: 'sqlite',
      get inTransaction() { return database.inTransaction; },
      exec: sql => database.exec(sql),
      run: (sql, ...params) => database.run(sql, ...params),
      query: sql => wrapStatement(database.query(sql)),
      prepare: sql => wrapStatement(database.prepare(sql)),
      transaction: fn => {
        const original = database.transaction(function (...args: unknown[]) { return fn.apply(database, args); });
        forbidden.add(original);
        return original;
      },
      close: () => database.close(),
    };
    forbidden.add(target);
    const visited = new Set<object>();
    function inspect(value: unknown): void {
      if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return;
      const object = value as object;
      expect(forbidden.has(object)).toBe(false);
      if (visited.has(object)) return;
      visited.add(object);
      inspect(Object.getPrototypeOf(object));
      for (const key of Reflect.ownKeys(object)) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
        inspect(descriptor.value);
        inspect(descriptor.get);
        inspect(descriptor.set);
        // Function.prototype's intrinsic caller/arguments getters always throw.
        if (descriptor.get && !(object === Function.prototype && ['caller', 'arguments'].includes(String(key)))) {
          inspect(descriptor.get.call(object));
        }
      }
    }
    function sealed(value: object, keys: string[]) {
      expect(Reflect.ownKeys(value).sort()).toEqual(keys.sort());
      expect(Object.getPrototypeOf(value)).toBeNull();
      expect(Object.isFrozen(value)).toBe(true);
      inspect(value);
    }
    runSchemaExpands(target, [expand(1, guarded => {
      sealed(guarded, ['dialect', 'inTransaction', 'exec', 'run', 'query', 'prepare', 'transaction']);
      expect(guarded.inTransaction).toBe(true);
      expect(Object.getOwnPropertyDescriptor(guarded, 'inTransaction')?.get).toBeFunction();
      for (const key of ['close', 'advisoryLock', 'afterCommit', 'savepoint', 'valueOf', 'execute', 'constructor', 'toString']) {
        expect((guarded as any)[key]).toBeUndefined();
        expect(() => (guarded as any)[key]()).toThrow(TypeError);
      }
      inspect(guarded.exec('SELECT 1'));
      inspect(guarded.run('SELECT 1'));
      for (const factory of ['query', 'prepare'] as const) {
        const statement = guarded[factory]('SELECT 1 AS n');
        sealed(statement, ['get', 'all', 'run', 'values']);
        for (const key of ['valueOf', 'execute', 'constructor', 'toString', 'iterate']) expect((statement as any)[key]).toBeUndefined();
        expect(statement.get()).toEqual({n:1});
        expect(statement.all()).toEqual([{n:1}]);
        expect(statement.values()).toEqual([[1]]);
        for (const method of ['get', 'all', 'run', 'values'] as const) inspect(statement[method]());
      }
      const invoke = guarded.transaction(function (this: unknown, argument: unknown) {
        expect(this).toBeUndefined();
        expect(argument).toBe('caller-owned');
        expect(guarded.inTransaction).toBe(true);
        return guarded.query('SELECT 1 AS n').get();
      });
      expect(invoke.deferred).toBeUndefined();
      inspect(invoke);
      const result = invoke.call(database, 'caller-owned');
      expect(result).toEqual({n:1});
      inspect(result);
      expect(() => guarded.transaction(() => { throw new Error('nested rollback'); })()).toThrow('nested rollback');
      console.info(`SEALED structure: exact database/statement keys; prototypes=null; frozen=true; ${visited.size} reachable objects inspected; raw handles absent; transaction receiver=undefined`);
    })], '1.0.0', code);
    expect(readSchemaLevels(database).expandLevel).toBe(1);
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
  for (const [open, close] of [['"', '"'], ['`', '`'], ['[', ']']]) {
    it(`rejects copy-and-swap with ${open} quoted identifiers and preserves rows`, () => {
      const database = db();
      database.exec('CREATE TABLE retained (id INTEGER); INSERT INTO retained VALUES (42)');
      let failure: unknown;
      try { runSchemaExpands(database, [expand(1, guarded => {
        guarded.exec('CREATE TABLE replacement (id INTEGER)');
        guarded.exec(`dRoP tAbLe ${open}retained${close}`);
        guarded.exec(`aLtEr TaBlE ${open}replacement${close} ReNaMe To ${open}retained${close}`);
      })], '1.0.0', code); } catch (error) { failure = error; }
      console.info('COPY_SWAP', JSON.stringify({ quote: open, rejected: Boolean(failure),
        rows: database.query('SELECT * FROM retained').all(), levels: readSchemaLevels(database),
        steps: database.query('SELECT id FROM multiremi_schema_steps').all() }));
      expect(() => { if (failure) throw failure; }).toThrow(open === '"' ? 'Destructive DDL' : 'backtick and bracket forms are unsupported');
      expect(database.query('SELECT * FROM retained').all()).toEqual([{ id: 42 }]);
      expect(database.query("SELECT name FROM sqlite_master WHERE name='replacement'").get()).toBeNull();
      expect(readSchemaLevels(database)).toEqual({ expandLevel: 0, contractLevel: 0 });
      expect(database.query('SELECT * FROM multiremi_schema_steps').all()).toEqual([]);
    });
  }
  it('blocks dynamically generated destructive SQL through every expand statement entry', () => {
    const database = db(); database.exec('CREATE TABLE retained (id INTEGER)');
    for (const method of ['exec', 'run', 'query', 'prepare'] as const) {
      expect(() => runSchemaExpands(database, [expand(1, db => { db[method](['DROP', 'TABLE', 'retained'].join(' ')); })], '1.0.0', code)).toThrow('Destructive DDL');
      expect(readSchemaLevels(database)).toEqual({ expandLevel: 0, contractLevel: 0 });
      expect(database.query("SELECT name FROM sqlite_master WHERE name='retained'").get()).toBeTruthy();
    }
  });
});
