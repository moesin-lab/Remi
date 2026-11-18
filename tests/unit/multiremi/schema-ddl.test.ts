import { describe, expect, it } from 'bun:test';
import { hasDestructiveSchemaStatement, hasDestructiveSchemaSql, SCHEMA_DDL_OBJECT_CLASSES } from '@multiremi/store/schema-ddl.js';

// Cross product: table modifiers, qualification, quoted names (spaces/commas),
// optional COLUMN and IF EXISTS; every action is also checked after ADD.
const tables = ['t', 'ONLY t', 'IF EXISTS t', 'IF EXISTS ONLY t', '"s"."t , quoted"'];
const names = ['c', '"c , quoted"'];
const positive: string[] = ['DROP TABLE t', 'DROP VIEW IF EXISTS v', 'DROP INDEX i', 'TRUNCATE t', 'TRUNCATE TABLE t'];
const negative: string[] = [
  'CREATE TABLE IF NOT EXISTS t (c TEXT NOT NULL)', 'CREATE INDEX IF NOT EXISTS i ON t(c)',
  "-- DROP TABLE t\nCREATE TABLE t (id INTEGER)", "SELECT 'DROP TABLE t'", 'SELECT $$ALTER TABLE t DROP c$$',
  'SELECT $body$DROP TABLE t$body$', '/* ALTER TABLE t RENAME c TO d */ SELECT 1',
];
for (const table of tables) {
  const actions = ['DROP CONSTRAINT ck', 'DROP CONSTRAINT IF EXISTS "ck , quoted"', 'RENAME TO d', 'RENAME CONSTRAINT ck TO dk'];
  const additive = ["ADD c TEXT NOT NULL DEFAULT ''", "ADD COLUMN c NUMERIC(10,2) DEFAULT 0", "ADD COLUMN c TEXT DEFAULT 'DROP TABLE t, RENAME TO d'"];
  for (const name of names) for (const column of ['', 'COLUMN ']) {
    for (const exists of ['', 'IF EXISTS ']) actions.push(`DROP ${column}${exists}${name}`);
    actions.push(`RENAME ${column}${name} TO d`);
    for (const type of ['TYPE bigint', 'SET DATA TYPE bigint', 'SET NOT NULL']) actions.push(`ALTER ${column}${name} ${type}`);
    for (const action of ['DROP NOT NULL', 'DROP DEFAULT', "SET DEFAULT 'x,y'", 'SET DEFAULT round(1.2, 0)']) additive.push(`ALTER ${column}${name} ${action}`);
  }
  for (const action of actions) {
    positive.push(`ALTER TABLE ${table} ${action}`);
    positive.push(`ALTER TABLE ${table} ADD fresh NUMERIC(10,2) DEFAULT 0, ${action}`);
  }
  for (const action of additive) negative.push(`ALTER TABLE ${table} ${action}`);
}
positive.push('SELECT 1; ALTER TABLE t ALTER c SET\nNOT NULL', 'ALTER /* comment */ TABLE t ADD c int, DROP d');
negative.push('ALTER TABLE t ALTER "DROP" SET DEFAULT $$a,b; DROP TABLE t$$, ALTER c DROP NOT NULL');

positive.push(
  '/* outer /* inner */ outer */ ALTER TABLE t DROP c',
  'ALTER TABLE té DROP c', 'ALTER TABLE t ALTER café TYPE bigint USING café::bigint',
  'DO $$ BEGIN ALTER TABLE t DROP COLUMN c; END $$',
  "DO LANGUAGE plpgsql 'BEGIN NULL; END'", 'DO $body$ BEGIN NULL; END $body$',
  'DROP SCHEMA aux CASCADE', 'DROP TYPE mood CASCADE', 'DROP SEQUENCE seq CASCADE',
  "DO E'BEGIN NULL; END'", "DO U&'BEGIN NULL; END'",
  'DROP DATABASE db WITH (FORCE)', 'DROP OPERATOR CLASS cls USING btree',
  'DROP FUNCTION f(int)', 'DROP MATERIALIZED VIEW IF EXISTS v',
  'ALTER INDEX idx RENAME TO idx2', 'ALTER SEQUENCE seq RENAME TO seq2',
  'ALTER TYPE mood RENAME TO mood2', 'ALTER SCHEMA aux RENAME TO aux2',
  'ALTER VIEW v RENAME COLUMN c TO d',
);
negative.push(
  `SELECT 'U&"literal"'`, `SELECT $$U&'literal'$$`, `/* U&"comment" */ SELECT 1`,
  `-- U&'comment'\nSELECT 1`,
  '/* outer /* DROP TABLE t */ outer */ SELECT 1',
  'ALTER TABLE té ALTER café DROP NOT NULL', 'ALTER TABLE té ALTER café DROP DEFAULT',
  "ALTER TABLE té ALTER café SET DEFAULT 'RENAME'", 'SELECT $$DO $$',
);

for (const kind of SCHEMA_DDL_OBJECT_CLASSES) {
  for (const prefix of [`DROP ${kind} café CASCADE`, `ALTER ${kind} café RENAME TO té`,
    `dRoP /* outer /* nested */ comment */ ${kind.toLowerCase()} "té"`]) positive.push(prefix);
}
positive.push(
  'DROP TRIGGER IF EXISTS x ON t', 'DROP POLICY p ON t',
  'ALTER TYPE p DROP ATTRIBUTE b', 'ALTER TYPE p ALTER ATTRIBUTE b TYPE bigint',
  'ALTER TABLE p DETACH PARTITION c', 'ALTER TABLE t NO INHERIT p',
  'ALTER TABLE t DISABLE TRIGGER x', 'ALTER TABLE t DISABLE RULE x',
  'ALTER TABLE t ENABLE ROW LEVEL SECURITY', 'ALTER TABLE t FORCE ROW LEVEL SECURITY',
  'ALTER TABLE t SET SCHEMA other', 'REVOKE SELECT ON t FROM PUBLIC',
  'SECURITY LABEL ON TABLE t IS NULL', 'REASSIGN OWNED BY x TO y',
  'TRUNCATE ONLY s.t*, other RESTART IDENTITY CASCADE',
);
negative.push(
  'comment', 'comment.created', 'Comment not found: x', 'Do not do this',
  'for x in y; do echo x; done', 'Drop this dependency first',
  'import bundle exceeds limit', 'refresh token', 'analyze', 'VACUUM INTO ?',
  'ALTER', 'DROP', 'COMMENT', 'TRUNCATE this log message',
  'ALTER TABLE $1 ADD COLUMN IF NOT EXISTS ',
  "ALTER TABLE t_${x} ADD COLUMN c TEXT NOT NULL DEFAULT 'd'",
  'CREATE OR REPLACE VIEW v AS SELECT 1',
  "CREATE OR REPLACE FUNCTION f() RETURNS void AS $$ BEGIN NULL; END $$ LANGUAGE plpgsql",
  "ALTER TYPE mood ADD VALUE 'ok' BEFORE 'sad'", "COMMENT ON TABLE t IS 'ok'",
  'GRANT SELECT ON t TO PUBLIC', 'IMPORT FOREIGN SCHEMA s FROM SERVER s INTO t',
  'REINDEX INDEX i', 'CLUSTER t', 'REFRESH MATERIALIZED VIEW v', 'DISCARD ALL',
);

// Quoting must never shift the table/column action boundary.
for (const [open, close] of [['"', '"'], ['`', '`'], ['[', ']']]) {
  const t = `${open}TaBle , name${close}`, c = `${open}CoL , name${close}`;
  positive.push(`dRoP tAbLe ${t}`, `aLtEr TaBlE ${t} ReNaMe To replacement`,
    `ALTER TABLE ${t} DROP COLUMN ${c}`, `ALTER TABLE ${t} ALTER ${c} SET NOT NULL`,
    `TRUNCATE TABLE ${t}`);
  negative.push(`aLtEr TaBlE ${t} ADD COLUMN fresh TEXT`,
    `ALTER TABLE ${t} ALTER ${c} DROP NOT NULL`, `ALTER TABLE ${t} ALTER ${c} SET DEFAULT 1`);
}

// Registered migrations reject PostgreSQL Unicode escape syntax.
for (const table of ['U&"retained"', String.raw`u&"ret\0061ined"`,
  `U&"ret!0061ined" UESCAPE '!'`, `u&"ret!0061ined" /* escape */ uescape '!'`,
  `U&"a""b,;DROP TABLE x"`, String.raw`U&"face\+01F600"`]) {
  positive.push(`TRUNCATE TABLE ${table}`, `DROP TABLE ${table}`,
    `ALTER TABLE ${table} ALTER U&"c!006fl" UESCAPE '!' TYPE bigint`,
    `ALTER TABLE ${table} RENAME TO replacement`);
  positive.push(`ALTER TABLE ${table} ADD COLUMN fresh TEXT`,
    `ALTER TABLE ${table} ALTER U&"c!006fl" UESCAPE '!' DROP NOT NULL`,
    `ALTER TABLE ${table} ALTER U&"col" SET DEFAULT 1`);
}

describe('shared schema DDL action detector', () => {
  for (const sql of positive) it(`rejects ${sql}`, () => expect(hasDestructiveSchemaSql(sql)).toBe(true));
  for (const sql of negative) it(`allows ${sql}`, () => expect(hasDestructiveSchemaSql(sql)).toBe(false));
});

// Reviewer counterexamples: all Unicode escape forms are unsupported.
const escapes = ["E'!'", '$$!$$', "'!'\n''", "'!'\n-- continuation\n''", "E'!'\n-- continuation\n''", "$escape$!$escape$", String.raw`E'\''`];
describe('known SQL fail-closed boundary', () => {
  for (const escape of escapes) {
    const name = `U&"ret!0061ined" UESCAPE ${escape}`;
    it(`rejects TRUNCATE with ${escape} at both boundaries`, () => {
      expect(hasDestructiveSchemaSql(`TRUNCATE TABLE ${name}`)).toBe(true);
      expect(hasDestructiveSchemaStatement(`TRUNCATE TABLE ${name}`)).toBe(true);
    });
    it(`rejects unsupported additive ALTER with ${escape}`, () => {
      const sql = `ALTER TABLE ${name} ADD COLUMN U&"c!006fl" UESCAPE ${escape} text`;
      expect(hasDestructiveSchemaSql(sql)).toBe(true);
      expect(hasDestructiveSchemaStatement(sql)).toBe(true);
    });
  }
  for (const sql of ['TRUNCATE t unexpected @ tail', 'SELECT 1; TRUNCATE ?',
    'TRUNCATE', `ALTER TABLE U&"t" UESCAPE not_a_string ADD COLUMN c text`,
    `SELECT U&"t" UESCAPE 42`, `SELECT U&"t" UESCAPE $1`, `SELECT U&"t" UESCAPE '`, `ALTER TABLE U&"t" UESCAPE E ADD COLUMN c text`]) {
    it(`fails closed in known SQL: ${sql}`, () => expect(hasDestructiveSchemaStatement(sql)).toBe(true));
  }
  for (const prefix of ['TABLE t', 'ONLY t', '"t"', 'U&"t"']) {
    it(`arch rejects explicit TRUNCATE candidate with unknown tail: ${prefix}`, () => {
      expect(hasDestructiveSchemaSql(`TRUNCATE ${prefix} unrecognized @ tail`)).toBe(true);
    });
  }
  it('arch still distinguishes bare-word prose', () => {
    expect(hasDestructiveSchemaSql('TRUNCATE this log message')).toBe(false);
    expect(hasDestructiveSchemaStatement('TRUNCATE this log message')).toBe(true);
  });
});

for (const sql of [
  `TRUNCATE public.U&"ret!0061ined" UESCAPE '!'\n-- continuation\n''`,
  `TRUNCATE public.U&"ret!0061ined" UESCAPE E'!'\n-- continuation\n''`,
  `SELECT u&'hello'`, `SELECT U&"name"`,
]) it(`rejects Unicode escapes regardless of candidate head: ${sql}`, () => {
  expect(hasDestructiveSchemaSql(sql)).toBe(true);
  expect(hasDestructiveSchemaStatement(sql)).toBe(true);
});

import { unsupportedStringContinuations, supportedSingleLiterals } from '../../fixtures/schema-string-continuations.js';
for (const sql of unsupportedStringContinuations) it(`rejects unsupported string continuation: ${sql}`, () => {
  expect(hasDestructiveSchemaSql(sql)).toBe(true);
  expect(hasDestructiveSchemaStatement(sql)).toBe(true);
});
for (const sql of supportedSingleLiterals) it(`allows single literals: ${sql}`, () => {
  expect(hasDestructiveSchemaSql(sql)).toBe(false);
  expect(hasDestructiveSchemaStatement(sql)).toBe(false);
});
