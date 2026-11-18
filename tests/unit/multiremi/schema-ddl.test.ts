import { describe, expect, it } from 'bun:test';
import { hasDestructiveSchemaSql } from '@multiremi/store/schema-ddl.js';

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

describe('shared schema DDL action detector', () => {
  for (const sql of positive) it(`rejects ${sql}`, () => expect(hasDestructiveSchemaSql(sql)).toBe(true));
  for (const sql of negative) it(`allows ${sql}`, () => expect(hasDestructiveSchemaSql(sql)).toBe(false));
});
