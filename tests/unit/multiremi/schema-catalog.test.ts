import { describe, expect, it } from 'bun:test';
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import { snapshotSchemaCatalog } from '@multiremi/store/schema-catalog.js';
import { ensureSchemaMeta, readSchemaLevels } from '@multiremi/store/schema-levels.js';
import { runSchemaExpands } from '@multiremi/store/schema-migration-runner.js';

describe('SQLite expand catalog authority', () => {
  for (const sql of [
    'ALTER TABLE retained DROP COLUMN d', 'ALTER TABLE retained DROP COLUMN generated', 'ALTER TABLE retained RENAME COLUMN c TO gone',
    'ALTER TABLE retained RENAME TO gone', 'DROP INDEX retained_unique', 'DROP VIEW retained_view',
  ]) it(`rolls back indirect ${sql}`, () => {
    const db = openSqliteDatabase(':memory:');
    try {
      ensureSchemaMeta(db);
      db.exec('CREATE TABLE retained (id integer PRIMARY KEY, c text, d text, generated text GENERATED ALWAYS AS (c) VIRTUAL); CREATE UNIQUE INDEX retained_unique ON retained(c); CREATE VIEW retained_view AS SELECT id FROM retained');
      const before = snapshotSchemaCatalog(db);
      expect(() => runSchemaExpands(db, [{ id: 'hidden', phase: 'expand', level: 1,
        release: '1.0.0', expandRelease: '1.0.0', run: () => { db.exec(sql); },
      }], '1.0.0', { minLevel: 0, maxLevel: 1 })).toThrow('Destructive schema catalog change');
      expect(snapshotSchemaCatalog(db)).toEqual(before);
      expect(readSchemaLevels(db)).toEqual({ expandLevel: 0, contractLevel: 0 });
      expect(db.query('SELECT * FROM multiremi_schema_steps').all()).toEqual([]);
    } finally { db.close(); }
  });
  for (const [label, definition] of [
    ['type change', 'c bigint, d text, CONSTRAINT named_check CHECK (c > 0)'],
    ['not null', 'c integer NOT NULL, d text, CONSTRAINT named_check CHECK (c > 0)'],
    ['named constraint replacement', 'c integer, d text, CONSTRAINT named_check CHECK (c > 1)'],
    ['named constraint removal', 'c integer, d text'],
  ]) it(`rejects opaque table reconstruction with ${label}`, () => {
    const db = openSqliteDatabase(':memory:');
    try {
      ensureSchemaMeta(db);
      db.exec('CREATE TABLE retained (c integer, d text, CONSTRAINT named_check CHECK(c > 0))');
      const before = snapshotSchemaCatalog(db);
      expect(() => runSchemaExpands(db, [{ id: 'rebuild', phase: 'expand', level: 1,
        release: '1.0.0', expandRelease: '1.0.0', run: () => {
          db.exec(`CREATE TABLE replacement (${definition}); DROP TABLE retained; ALTER TABLE replacement RENAME TO retained`);
        },
      }], '1.0.0', { minLevel: 0, maxLevel: 1 })).toThrow('Destructive schema catalog change');
      expect(snapshotSchemaCatalog(db)).toEqual(before);
      expect(readSchemaLevels(db)).toEqual({ expandLevel: 0, contractLevel: 0 });
      expect(db.query('SELECT * FROM multiremi_schema_steps').all()).toEqual([]);
    } finally { db.close(); }
  });
  it('allows additive SQLite schema on a raw unmarked SQLite handle', () => {
    const db = openSqliteDatabase(':memory:');
    // Exercise legacy handles without dialect metadata through the approved entry.
    Reflect.deleteProperty(db, 'dialect');
    try {
      db.exec('CREATE TABLE retained (c integer)');
      runSchemaExpands(db, [{ id: 'additive', phase: 'expand', level: 1,
        release: '1.0.0', expandRelease: '1.0.0', run: guarded => {
          guarded.exec('ALTER TABLE retained ADD COLUMN d text');
          guarded.exec('CREATE TABLE IF NOT EXISTS added (id integer)');
          guarded.exec('CREATE INDEX IF NOT EXISTS added_index ON retained(d)');
        },
      }], '1.0.0', { minLevel: 1, maxLevel: 1 });
      expect(readSchemaLevels(db)).toEqual({ expandLevel: 1, contractLevel: 0 });
    } finally { db.close(); }
  });

  for (const sql of [
    'CREATE UNIQUE INDEX extra_unique ON retained(c)',
    'DROP VIEW retained_view; CREATE VIEW retained_view AS SELECT d FROM retained',
    'DROP TRIGGER retained_trigger; CREATE TRIGGER retained_trigger AFTER INSERT ON retained BEGIN SELECT 2; END',
  ]) it(`rejects opaque definition/restriction change ${sql}`, () => {
    const db = openSqliteDatabase(':memory:');
    try {
      ensureSchemaMeta(db);
      db.exec('CREATE TABLE retained(c integer,d text); CREATE VIEW retained_view AS SELECT c FROM retained; CREATE TRIGGER retained_trigger AFTER INSERT ON retained BEGIN SELECT 1; END');
      const before = snapshotSchemaCatalog(db);
      expect(() => runSchemaExpands(db,[{id:'opaque',phase:'expand',level:1,release:'1.0.0',expandRelease:'1.0.0',run:()=>db.exec(sql)}],
        '1.0.0',{minLevel:0,maxLevel:1})).toThrow('Destructive schema catalog change');
      expect(snapshotSchemaCatalog(db)).toEqual(before);
      expect(readSchemaLevels(db)).toEqual({expandLevel:0,contractLevel:0});
      expect(db.query('SELECT * FROM multiremi_schema_steps').all()).toEqual([]);
    } finally { db.close(); }
  });

});

it('exec uses guarded statement boundaries and never delegates its batch to bridge exec', () => {
  const db = openSqliteDatabase(':memory:');
  const batch = "CREATE TABLE pieces(v text); INSERT INTO pieces VALUES('a;b'); -- ; comment\nINSERT INTO pieces VALUES('c'';d')";
  const statements: string[] = [];
  const handle = new Proxy(db, { get(target, key) {
    if (key === 'exec') return (sql: string) => { expect(sql).not.toBe(batch); target.exec(sql); };
    if (key === 'query') return (sql: string) => { statements.push(sql); return target.query(sql); };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  try {
    runSchemaExpands(handle, [{id:'split',phase:'expand',level:1,release:'1.0.0',expandRelease:'1.0.0',run: guarded => guarded.exec(batch)}], '1.0.0', {minLevel:1,maxLevel:1});
    expect(statements).toContain('CREATE TABLE pieces(v text)');
    expect(statements).toContain(" INSERT INTO pieces VALUES('a;b')");
    expect(statements).toContain(" -- ; comment\nINSERT INTO pieces VALUES('c'';d')");
    expect(db.query('SELECT v FROM pieces ORDER BY rowid').all()).toEqual([{v:'a;b'},{v:"c';d"}]);
  } finally { db.close(); }
});
