import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
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
  function fixture() {
    const schema = `catalog_${++serial}`;
    db.exec(`CREATE SCHEMA ${schema}`);
    db.exec(`CREATE TYPE ${schema}.mood AS ENUM ('happy','sad')`);
    db.exec(`CREATE SEQUENCE ${schema}.seq`);
    db.exec(`CREATE TABLE ${schema}.té (id integer PRIMARY KEY, c text, café integer, relaxed integer NOT NULL, mood ${schema}.mood, n integer DEFAULT nextval('${schema}.seq'), CONSTRAINT named_unique UNIQUE(c))`);
    db.exec(`CREATE INDEX named_index ON ${schema}.té(café)`);
    db.exec(`CREATE VIEW ${schema}.v AS SELECT id FROM ${schema}.té`);
    db.exec(`CREATE MATERIALIZED VIEW ${schema}.mv AS SELECT id FROM ${schema}.té`);
    return schema;
  }
  function step(id: string, sql: string): SchemaMigration {
    return { id, phase: 'expand', level: 1, expandRelease: '9.0.0', release: '9.0.0', run: guarded => { guarded.query(sql).run(); } };
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
  // These SELECT statements deliberately pass text lint. Only before/after
  // catalog comparison can detect the function's transactional side effects.
  const hidden = [
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
  for (const [index, template] of hidden.entries()) it(`catalog rejects indirect ${template}`, () => {
    const schema = fixture();
    const ddl = template.replaceAll('S.', `${schema}.`).replace('SCHEMA S ', `SCHEMA ${schema} `);
    const fn = `catalog_hidden_${index}`;
    db.query(`CREATE FUNCTION public.${fn}() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ${ddl}; END $$`).run();
    const sql = `SELECT public.${fn}()`;
    expect(hasDestructiveSchemaSql(sql)).toBe(false);
    rejected(`hidden-${index}`, sql, 'Destructive schema catalog change');
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
