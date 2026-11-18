import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { runMigrations } from '@multiremi/store/migrations.js';
import type { SqlDatabase } from '@multiremi/store/db/postgres.js';
import { PostgresSyncDatabase } from '@multiremi/store/db/postgres.js';
import { snapshotSchemaCatalog } from '@multiremi/store/schema-catalog.js';
import { ensureSchemaMeta, readSchemaLevels } from '@multiremi/store/schema-levels.js';
import { hasDestructiveSchemaSql } from '@multiremi/store/schema-ddl.js';
import { runSchemaExpands, type SchemaMigration } from '@multiremi/store/schema-migration-runner.js';

const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
describe.skipIf(!adminUrl)('transactional catalog authority on PostgreSQL', () => {
  let admin: Bun.SQL, db: PostgresSyncDatabase;
  const database = `mul173_catalog_${process.pid}_${crypto.randomUUID().replaceAll('-', '')}`;
  let created = false, serial = 0;
  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(adminUrl!).hostname)) throw new Error('Requires local PostgreSQL');
    admin = new Bun.SQL(adminUrl!, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${database}`); created = true;
    const url = new URL(adminUrl!); url.pathname = `/${database}`;
    db = new PostgresSyncDatabase(url.toString()); ensureSchemaMeta(db);
  });
  afterAll(async () => {
    db?.close();
    try { if (created) await admin.unsafe(`DROP DATABASE ${database}`); }
    finally { await admin?.close(); }
  });
  afterEach(() => {
    if (serial) db.exec(`DROP SCHEMA IF EXISTS catalog_${serial} CASCADE`);
  });
  function fixture() {
    const schema = `catalog_${++serial}`;
    db.exec(`CREATE SCHEMA ${schema}`);
    db.exec(`CREATE TYPE ${schema}.pair AS (a integer,b text)`);
    db.exec(`CREATE DOMAIN ${schema}.positive AS integer CONSTRAINT domain_check CHECK(VALUE>0)`);
    db.exec(`CREATE TABLE ${schema}.partitioned (id integer) PARTITION BY RANGE(id)`);
    db.exec(`CREATE TABLE ${schema}.child PARTITION OF ${schema}.partitioned FOR VALUES FROM (0) TO (10)`);
    db.exec(`CREATE TABLE ${schema}.parent (id integer); CREATE TABLE ${schema}.inherited (extra text) INHERITS (${schema}.parent)`);
    db.exec(`CREATE TABLE ${schema}.secure (id integer); ALTER TABLE ${schema}.secure ENABLE ROW LEVEL SECURITY; CREATE POLICY visible ON ${schema}.secure USING (id>0)`);
    db.exec(`CREATE TABLE ${schema}.restrictions (id integer PRIMARY KEY, checked integer CHECK(checked>0), ref integer)`);
    db.exec(`CREATE TABLE ${schema}.foreign_key (id integer REFERENCES ${schema}.restrictions(id), span int4range, EXCLUDE USING gist (span WITH &&))`);
    db.exec(`CREATE TABLE ${schema}.generated (id integer GENERATED ALWAYS AS IDENTITY, computed integer GENERATED ALWAYS AS (id+1) STORED)`);
    db.exec(`CREATE FUNCTION ${schema}.audit() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'`);
    db.exec(`CREATE FUNCTION ${schema}.retained() RETURNS integer LANGUAGE sql AS 'SELECT 1'`);
    db.exec(`CREATE TYPE ${schema}.mood AS ENUM ('happy','sad')`);
    db.exec(`CREATE SEQUENCE ${schema}.seq`);
    db.exec(`CREATE TABLE ${schema}.té (id integer PRIMARY KEY, c text, café integer, relaxed integer NOT NULL, mood ${schema}.mood, n integer DEFAULT nextval('${schema}.seq'), CONSTRAINT named_unique UNIQUE(c))`);
    db.exec(`CREATE INDEX named_index ON ${schema}.té(café)`);
    db.exec(`CREATE VIEW ${schema}.v AS SELECT id FROM ${schema}.té`);
    db.exec(`CREATE MATERIALIZED VIEW ${schema}.mv AS SELECT id FROM ${schema}.té`);
    db.exec(`CREATE TRIGGER audit_trigger BEFORE INSERT ON ${schema}.té FOR EACH ROW EXECUTE FUNCTION ${schema}.audit()`);
    db.exec(`CREATE POLICY visible ON ${schema}.té USING (true)`);
    db.exec(`CREATE RULE no_delete AS ON DELETE TO ${schema}.té DO INSTEAD NOTHING`);
    db.exec(`CREATE STATISTICS ${schema}.stats ON id,café FROM ${schema}.té`);
    db.exec(`GRANT SELECT ON ${schema}.té TO pg_monitor`);
    return schema;
  }
  function step(id: string, sql: string): SchemaMigration {
    return { id, phase: 'expand', level: 1, expandRelease: '9.0.0', release: '9.0.0', run: guarded => {
      // The same-name constraint replacement contains two independent actions.
      if (sql.startsWith('ALTER TABLE') && sql.includes(';')) {
        for (const part of sql.split(';')) guarded.query(part).run();
      } else guarded.query(sql).run();
    } };
  }
  function rejected(id: string, sql: string, message: string) {
    const before = snapshotSchemaCatalog(db), levels = readSchemaLevels(db);
    expect(() => runSchemaExpands(db, [step(id, sql)], '9.0.0', { minLevel: 0, maxLevel: 100 })).toThrow(message);
    expect(readSchemaLevels(db)).toEqual(levels);
    expect(db.query('SELECT id FROM multiremi_schema_steps WHERE id=?').get(id)).toBeNull();
    expect(snapshotSchemaCatalog(db)).toEqual(before);
    console.info(`REJECT ${id}: ${sql}; levels unchanged ${JSON.stringify(levels)}; step absent; catalog unchanged`);
  }
  const direct = [
    '/* outer /* inner */ outer */ ALTER TABLE S.té DROP c',
    'ALTER TABLE S.té DROP c', 'ALTER TABLE S.té ALTER café TYPE bigint',
    'DO $$ BEGIN ALTER TABLE S.té DROP COLUMN c; END $$',
    'DROP SCHEMA S CASCADE', 'DROP TYPE S.mood CASCADE', 'DROP SEQUENCE S.seq CASCADE',
  ];
  for (const [index, template] of direct.entries()) it(`rejects reviewer SQL ${template}`, () => {
    const schema = fixture();
    rejected(`direct-${index}`, template.replaceAll('S.', `${schema}.`).replace('SCHEMA S ', `SCHEMA ${schema} `), 'Destructive DDL is forbidden');
  });
  for (const name of ['U&"retained"', String.raw`u&"ret\0061ined"`,
    `U&"ret!0061ined" UESCAPE '!'`,
    ...["E'!'", '$$!$$', "'!'\n''", "'!'\n-- continuation\n''", "E'!'\n-- continuation\n''"].map(escape => `U&"ret!0061ined" UESCAPE ${escape}`)]) it(`rejects Unicode TRUNCATE without losing rows: ${name}`, () => {
    const schema = fixture();
    db.exec(`CREATE TABLE ${schema}.retained (id integer); INSERT INTO ${schema}.retained VALUES (42)`);
    const sql = `TRUNCATE ${schema}.${name}`;
    rejected(`unicode-truncate-${serial}`, sql, 'Unicode escape identifiers/strings are unsupported');
    expect(db.query(`SELECT id FROM ${schema}.retained`).all()).toEqual([{ id: 42 }]);
    expect(db.query('SELECT id FROM multiremi_schema_steps').all()).toEqual([]);
    expect(readSchemaLevels(db).expandLevel).toBe(0);
    console.info(`Original row retained after ${sql}; steps=[]; expandLevel=0`);
  });
  for (const escape of ["'!'", "E'!'", '$$!$$', "'!'\n''", "'!'\n-- continuation\n''", "E'!'\n-- continuation\n''"]) it(`rejects unsupported Unicode additive ALTER with ${escape}`, () => {
    const schema = fixture();
    db.exec(`CREATE TABLE ${schema}.retained (id integer)`);
    const sql = `ALTER TABLE ${schema}.U&"ret!0061ined" UESCAPE ${escape} ADD COLUMN U&"c!006fl" UESCAPE ${escape} text`;
    db.exec(`INSERT INTO ${schema}.retained VALUES (42)`);
    expect(hasDestructiveSchemaSql(sql)).toBe(true);
    rejected(`unicode-additive-${serial}`, sql, 'Unicode escape identifiers/strings are unsupported');
    expect(db.query(`SELECT id FROM ${schema}.retained`).all()).toEqual([{ id: 42 }]);
    expect(db.query('SELECT id FROM multiremi_schema_steps').all()).toEqual([]);
  });
  it('rejects TRUNCATE with an unrecognized tail before the SQL backend', () => {
    const schema = fixture();
    db.exec(`CREATE TABLE ${schema}.retained (id integer); INSERT INTO ${schema}.retained VALUES (42)`);
    rejected(`unknown-tail-${serial}`, `TRUNCATE ${schema}.retained @ unknown_tail`, 'Destructive DDL is forbidden');
    expect(db.query(`SELECT id FROM ${schema}.retained`).all()).toEqual([{ id: 42 }]);
  });
  for (const escape of ['not_a_string', '$1']) it(`fails closed on unrecognized UESCAPE ${escape}`, () => {
    const schema = fixture();
    db.exec(`CREATE TABLE ${schema}.retained (id integer); INSERT INTO ${schema}.retained VALUES (42)`);
    rejected(`unknown-uescape-${serial}`,
      `ALTER TABLE ${schema}.U&"retained" UESCAPE ${escape} ADD COLUMN c text`, 'Unicode escape identifiers/strings are unsupported');
    expect(db.query(`SELECT id FROM ${schema}.retained`).all()).toEqual([{ id: 42 }]);
  });
  it('rejects Unicode escaped strings before execution', () => {
    const schema = fixture();
    db.exec(`CREATE TABLE ${schema}.retained (id integer); INSERT INTO ${schema}.retained VALUES (42)`);
    rejected(`unicode-string-${serial}`, `SELECT u&'hello'`, 'Unicode escape identifiers/strings are unsupported');
    expect(db.query(`SELECT id FROM ${schema}.retained`).all()).toEqual([{ id: 42 }]);
    expect(db.query('SELECT id FROM multiremi_schema_steps').all()).toEqual([]);
  });
  // These SELECT statements deliberately pass text lint. Only before/after
  // catalog comparison can detect the function's transactional side effects.
  const hidden = [
    'DROP TRIGGER IF EXISTS audit_trigger ON S.té', 'DROP POLICY visible ON S.té',
    'ALTER TYPE S.pair DROP ATTRIBUTE b', 'ALTER TYPE S.pair ALTER ATTRIBUTE b TYPE varchar',
    'ALTER TABLE S.partitioned DETACH PARTITION S.child',
    'ALTER TABLE S.inherited NO INHERIT S.parent', 'ALTER TABLE S.té DISABLE TRIGGER audit_trigger',
    'ALTER TABLE S.té DISABLE RULE no_delete',
    'ALTER TABLE S.té DROP CONSTRAINT named_unique; ALTER TABLE S.té ADD CONSTRAINT named_unique UNIQUE(café)',
    'DROP FUNCTION S.retained()',
    "CREATE OR REPLACE FUNCTION S.retained() RETURNS integer LANGUAGE sql AS 'SELECT 2'",
    'REVOKE SELECT ON S.té FROM pg_monitor', 'ALTER TABLE S.té ENABLE ROW LEVEL SECURITY',
    'ALTER TABLE S.té ADD CONSTRAINT new_check CHECK(café>0)',
    'ALTER TABLE S.té ADD CONSTRAINT new_unique UNIQUE(café)',
    'ALTER TABLE S.té ADD CONSTRAINT new_fk FOREIGN KEY(café) REFERENCES S.restrictions(id)',
    'CREATE UNIQUE INDEX new_unique_index ON S.té(café)',
    'CREATE POLICY new_policy ON S.té USING (true)',
    'CREATE OR REPLACE VIEW S.v AS SELECT café AS id FROM S.té',
    'DROP STATISTICS S.stats',
    'ALTER TABLE S.generated ALTER id SET GENERATED BY DEFAULT',
    'ALTER SEQUENCE S.seq INCREMENT BY 2',
    'ALTER DOMAIN S.positive DROP CONSTRAINT domain_check',

    'ALTER TABLE S.té DROP COLUMN c', 'ALTER TABLE S.té ALTER café SET NOT NULL',
    'ALTER TABLE S.té ALTER café TYPE bigint', 'ALTER TABLE S.té RENAME TO renamed',
    'ALTER TABLE S.té RENAME COLUMN café TO renamed', 'DROP SCHEMA S CASCADE',
    'DROP TYPE S.mood CASCADE', 'DROP SEQUENCE S.seq CASCADE',
    'DROP VIEW S.v', 'DROP MATERIALIZED VIEW S.mv',
    'ALTER INDEX S.named_index RENAME TO renamed_index', 'DROP INDEX S.named_index',
    'ALTER TABLE S.té DROP CONSTRAINT named_unique', 'ALTER TABLE S.té DROP CONSTRAINT té_pkey',
    'ALTER TYPE S.mood RENAME TO renamed_type', 'ALTER SEQUENCE S.seq RENAME TO renamed_sequence',
    'ALTER SCHEMA S RENAME TO renamed_schema',
  ];
  for (const [index, template] of hidden.entries()) for (const indirect of [false,true]) it(`catalog rejects ${indirect ? 'indirect' : 'direct'} ${template}`, () => {
    const schema = fixture();
    const ddl = template.replaceAll('S.', `${schema}.`).replace('SCHEMA S ', `SCHEMA ${schema} `);
    const fn = `catalog_hidden_${index}_${serial}`;
    db.query(`CREATE FUNCTION public.${fn}() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ${ddl}; END $$`).run();
    const sql = indirect ? `SELECT public.${fn}()` : ddl;
    if (indirect) expect(hasDestructiveSchemaSql(sql)).toBe(false);
    rejected(`hidden-${index}-${indirect}`, sql, indirect || !hasDestructiveSchemaSql(sql) ? 'Destructive schema catalog change' : 'Destructive DDL is forbidden');
  });
  function oldReader(sql: string) {
    db.exec('SET ROLE pg_monitor');
    try { return db.query(sql).all(); }
    finally { db.exec('RESET ROLE'); }
  }
  for (const indirect of [false, true]) {
    for (const options of ['security_invoker=true', 'security_barrier=true', 'check_option=local']) {
      it(`preserves view options and old reader (${options}, indirect=${indirect})`, () => {
        const schema = fixture();
        db.exec(`GRANT USAGE ON SCHEMA ${schema} TO pg_monitor`);
        db.exec(`CREATE TABLE ${schema}.view_base(id integer); INSERT INTO ${schema}.view_base VALUES(42); CREATE VIEW ${schema}.old_view AS SELECT id FROM ${schema}.view_base; GRANT SELECT ON ${schema}.old_view TO pg_monitor`);
        const query = `SELECT * FROM ${schema}.old_view`;
        expect(oldReader(query)).toEqual([{ id: 42 }]);
        const ddl = `CREATE OR REPLACE VIEW ${schema}.old_view WITH (${options}) AS SELECT id FROM ${schema}.view_base`;
        db.query(`CREATE FUNCTION ${schema}.change_view() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ${ddl}; END $$`).run();
        rejected(`view-options-${serial}`, indirect ? `SELECT ${schema}.change_view()` : ddl, 'Destructive schema catalog change');
        expect(oldReader(query)).toEqual([{ id: 42 }]);
        console.info(`OLD READER view ${options} indirect=${indirect}: id=42 after rollback`);
      });
    }
    for (const grantOptionOnly of [false, true]) {
      it(`preserves column ACL and old reader (grant option=${grantOptionOnly}, indirect=${indirect})`, () => {
        const schema = fixture();
        db.exec(`CREATE TABLE ${schema}.column_acl_target(c integer); INSERT INTO ${schema}.column_acl_target VALUES(42)`);
        db.exec(`GRANT USAGE ON SCHEMA ${schema} TO pg_monitor`);
        db.exec(`GRANT SELECT(c) ON ${schema}.column_acl_target TO pg_monitor WITH GRANT OPTION`);
        const query = `SELECT c FROM ${schema}.column_acl_target`;
        expect(oldReader(query)).toEqual([{ c: 42 }]);
        const ddl = `REVOKE ${grantOptionOnly ? 'GRANT OPTION FOR ' : ''}SELECT(c) ON ${schema}.column_acl_target FROM pg_monitor`;
        db.query(`CREATE FUNCTION ${schema}.change_column_acl() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ${ddl}; END $$`).run();
        rejected(`column-acl-${serial}`, indirect ? `SELECT ${schema}.change_column_acl()` : ddl,
          indirect ? 'Destructive schema catalog change' : 'Destructive DDL is forbidden');
        expect(oldReader(query)).toEqual([{ c: 42 }]);
        console.info(`OLD READER column ACL grantOptionOnly=${grantOptionOnly} indirect=${indirect}: c=42 after rollback`);
      });
    }
  }
  it('preserves materialized view reloptions through indirect DDL', () => {
    const schema = fixture();
    db.query(`CREATE FUNCTION ${schema}.change_mv() RETURNS void LANGUAGE plpgsql AS $$ BEGIN
      ALTER MATERIALIZED VIEW ${schema}.mv SET (fillfactor=80); END $$`).run();
    rejected(`mv-options-${serial}`, `SELECT ${schema}.change_mv()`, 'Destructive schema catalog change');
  });
  it('allows column grants and new security-invoker views', () => {
    const schema = fixture();
    db.exec(`CREATE TABLE ${schema}.column_acl_target(c integer); INSERT INTO ${schema}.column_acl_target VALUES(42)`);
    db.exec(`GRANT USAGE ON SCHEMA ${schema} TO pg_monitor`);
    for (const [index,sql] of [
      `GRANT SELECT(c) ON ${schema}.column_acl_target TO pg_monitor`,
      `GRANT SELECT(c) ON ${schema}.column_acl_target TO pg_monitor WITH GRANT OPTION`,
      `CREATE VIEW ${schema}.new_invoker WITH (security_invoker=true) AS SELECT c FROM ${schema}.column_acl_target`,
      `GRANT SELECT ON ${schema}.new_invoker TO pg_monitor`,
    ].entries()) {
      const id = `permissions-allowed-${serial}-${index}`;
      runSchemaExpands(db,[step(id,sql)],'9.0.0',{ minLevel:0,maxLevel:100 });
      expect(db.query('SELECT id FROM multiremi_schema_steps WHERE id=?').get(id)?.id).toBe(id);
      console.info(`ALLOW ${sql}`);
    }
    expect(oldReader(`SELECT c FROM ${schema}.new_invoker`)).toEqual([{ c: 42 }]);
  });
  it('covers every dependency object type present in the rich fixture', () => {
    const schema = fixture();
    const snapshot = snapshotSchemaCatalog(db);
    const rows = db.query(`SELECT DISTINCT o.type,o.identity FROM pg_depend d
      CROSS JOIN LATERAL pg_identify_object(d.classid,d.objid,d.objsubid) o
      WHERE d.classid<>'pg_attrdef'::regclass AND (
        (d.refclassid='pg_namespace'::regclass AND d.refobjid=(SELECT oid FROM pg_namespace WHERE nspname=?))
        OR (d.refclassid='pg_class'::regclass AND d.refobjid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=?)))`).all(schema,schema);
    const types = [...new Set(rows.map(row => row.type))].sort();
    expect(types.length).toBeGreaterThan(8);
    for (const row of rows) expect(snapshot.has(`dependent:${JSON.stringify([row.type,row.identity])}`)).toBe(true);
    console.info(`DEPENDENCY COVERAGE: ${JSON.stringify(types)}; ${rows.length} identities all present`);
  });
  it('uses 11 set queries with empty public, 100 empty schemas and bootstrapped schema; steady expand uses zero', async () => {
    const name = `${database}_performance`;
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const url = new URL(adminUrl!); url.pathname = `/${name}`;
    const bench = new PostgresSyncDatabase(url.toString());
    const statements = new Set<string>();
    let count = 0;
    const measured = new Proxy(bench, { get(target,key) {
      if (key === 'query') return (sql: string) => { count++; statements.add(sql); return target.query(sql); };
      const value = Reflect.get(target,key,target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as SqlDatabase;
    try {
      console.info(`PG VERSION: ${bench.query('SHOW server_version').get()?.server_version}`);
      for (const stage of ['empty public','100 empty schemas','bootstrap production shape']) {
        if (stage === '100 empty schemas') for (let i=0;i<100;i++) bench.exec(`CREATE SCHEMA empty_${i}`);
        if (stage === 'bootstrap production shape') {
          for (let i=0;i<100;i++) bench.exec(`DROP SCHEMA empty_${i}`);
          runMigrations(bench);
        }
        count = 0;
        const start = performance.now();
        const snapshot = snapshotSchemaCatalog(measured);
        const ms = performance.now()-start;
        expect(count).toBe(11);
        console.info(`CATALOG PERFORMANCE ${stage}: ${ms.toFixed(3)} ms; ${count} queries; ${snapshot.size} entries`);
      }
      let catalogQueries = 0;
      const steady = new Proxy(bench, { get(target,key) {
        if (key === 'query') return (sql: string) => { if (statements.has(sql)) catalogQueries++; return target.query(sql); };
        const value = Reflect.get(target,key,target);
        return typeof value === 'function' ? value.bind(target) : value;
      } }) as SqlDatabase;
      const appliedStep = step('steady', 'CREATE TABLE IF NOT EXISTS steady (id integer)');
      runSchemaExpands(steady,[appliedStep],'9.0.0',{minLevel:0,maxLevel:100});
      catalogQueries=0;
      runSchemaExpands(steady,[appliedStep],'9.0.0',{minLevel:0,maxLevel:100});
      expect(catalogQueries).toBe(0);
      console.info('STEADY STARTUP: 0 catalog queries for already-applied expand');
    } finally { bench.close(); await admin.unsafe(`DROP DATABASE ${name}`); }
  },30_000);
  it('allows restrictions on relations created within the same expand', () => {
    const schema = fixture();
    db.query(`CREATE FUNCTION public.new_relation() RETURNS void LANGUAGE plpgsql AS $$ BEGIN
      CREATE TABLE ${schema}.new_table(id integer UNIQUE CHECK(id>0));
      ALTER TABLE ${schema}.new_table ENABLE ROW LEVEL SECURITY;
      CREATE POLICY visible ON ${schema}.new_table USING (id>0);
    END $$`).run();
    runSchemaExpands(db,[step('new-relation','SELECT public.new_relation()')],'9.0.0',{minLevel:0,maxLevel:100});
    expect(db.query('SELECT id FROM multiremi_schema_steps WHERE id=?').get('new-relation')?.id).toBe('new-relation');
  });
  it('permits additive structures and default/nullable relaxation', () => {
    const schema = fixture();
    const allowed = [
      `ALTER TABLE ${schema}.té ADD COLUMN added text`,
      `CREATE TABLE IF NOT EXISTS ${schema}.added_table (id integer)`,
      `CREATE INDEX IF NOT EXISTS added_index ON ${schema}.té(café)`,
      `CREATE INDEX IF NOT EXISTS added_index ON ${schema}.té(café)`,
      `ALTER TABLE ${schema}.té ALTER c SET DEFAULT 'default'`,
      `ALTER TABLE ${schema}.té ALTER c SET DEFAULT 'changed'`,
      `ALTER TABLE ${schema}.té ALTER c DROP DEFAULT`,
      `ALTER TABLE ${schema}.té ALTER relaxed DROP NOT NULL`,
      `ALTER TYPE ${schema}.mood ADD VALUE 'neutral' BEFORE 'sad'`,
      `GRANT UPDATE ON ${schema}.té TO pg_monitor`,
      `GRANT SELECT ON ${schema}.té TO pg_monitor WITH GRANT OPTION`,
      `COMMENT ON TABLE ${schema}.té IS 'allowed'`,
      `CREATE TRIGGER second_trigger BEFORE INSERT ON ${schema}.té FOR EACH ROW EXECUTE FUNCTION ${schema}.audit()`,
      `CREATE TABLE ${schema}.new_restricted (id integer UNIQUE CHECK(id>0))`,
    ];
    for (const [index, sql] of allowed.entries()) {
      const id = `allowed-${index}`;
      runSchemaExpands(db, [step(id, sql)], '9.0.0', { minLevel: 0, maxLevel: 100 });
      expect(db.query('SELECT id FROM multiremi_schema_steps WHERE id=?').get(id)?.id).toBe(id);
      console.info(`ALLOW ${sql}`);
    }
    expect(readSchemaLevels(db)).toEqual({ expandLevel: 1, contractLevel: 0 });
  });
});
