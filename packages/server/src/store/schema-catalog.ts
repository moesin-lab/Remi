import type { SqlDatabase } from './db/postgres.js';

export interface SchemaCatalogEntry { key: string; type?: string; notNull?: boolean }
export type SchemaCatalog = Map<string, SchemaCatalogEntry>;

/** Read on the same connection and inside the step transaction. Names, rather
 * than OIDs, are the compatibility contract consumed by old application code. */
export function snapshotSchemaCatalog(db: SqlDatabase): SchemaCatalog {
  const entries: SchemaCatalogEntry[] = [];
  if (db.dialect === 'postgres') {
    const schemas = db.query(`SELECT oid, nspname FROM pg_namespace
      WHERE nspname <> 'pg_catalog' AND nspname <> 'information_schema'
      AND nspname NOT LIKE 'pg_toast%'`).all();
    for (const schema of schemas) {
      const prefix = JSON.stringify([schema.nspname]);
      entries.push({ key: `schema:${prefix}` });
      for (const row of db.query(`SELECT c.relname, c.relkind FROM pg_class c WHERE c.relnamespace=?
        AND c.relkind IN ('r','p','v','m','S','f','i','I')`).all(schema.oid)) {
        entries.push({ key: `relation:${JSON.stringify([schema.nspname, row.relkind, row.relname])}` });
      }
      for (const row of db.query('SELECT typname FROM pg_type WHERE typnamespace=?').all(schema.oid)) {
        entries.push({ key: `type:${JSON.stringify([schema.nspname, row.typname])}` });
      }
      for (const row of db.query(`SELECT c.relname, a.attname, format_type(a.atttypid,a.atttypmod) AS data_type, a.attnotnull
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
        WHERE c.relnamespace=? AND c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped`).all(schema.oid)) {
        entries.push({ key: `column:${JSON.stringify([schema.nspname, row.relname, row.attname])}`,
          type: row.data_type, notNull: Boolean(row.attnotnull) });
      }
      for (const row of db.query(`SELECT con.conname, c.relname, t.typname FROM pg_constraint con
        LEFT JOIN pg_class c ON c.oid=con.conrelid LEFT JOIN pg_type t ON t.oid=con.contypid
        WHERE con.connamespace=?`).all(schema.oid)) {
        entries.push({ key: `constraint:${JSON.stringify([schema.nspname, row.relname, row.typname, row.conname])}` });
      }
      for (const row of db.query(`SELECT t.typname, e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typnamespace=?`).all(schema.oid)) {
        entries.push({ key: `enum:${JSON.stringify([schema.nspname, row.typname, row.enumlabel])}` });
      }
    }
  } else {
    // Raw bun:sqlite Database handles are structurally SqlDatabase and have no
    // dialect marker. Production marked SQLite and raw SQLite tests both land here.
    // SQLite lazily creates the temp catalog during ALTER; materialize it
    // before the baseline so rollback comparisons do not see a phantom schema.
    db.query('SELECT name FROM temp.sqlite_schema').all();
    for (const schema of db.query('PRAGMA database_list').all()) {
      const quoted = '"' + String(schema.name).replaceAll('"', '""') + '"';
      entries.push({ key: `schema:${JSON.stringify([schema.name])}` });
      for (const row of db.query(`SELECT type, name, sql FROM ${quoted}.sqlite_schema WHERE name NOT LIKE 'sqlite_%'`).all()) {
        entries.push({ key: `object:${JSON.stringify([schema.name, row.type, row.name])}` });
        if (row.type !== 'table' && row.type !== 'view') continue;
        for (const column of db.query('SELECT * FROM pragma_table_info(?, ?)').all(row.name, schema.name)) {
          entries.push({ key: `column:${JSON.stringify([schema.name, row.name, column.name])}`,
            type: column.type, notNull: Boolean(column.notnull || column.pk) });
        }
        // Named CHECK/FOREIGN KEY constraints have no SQLite catalog table.
        // Extract names from CREATE SQL after removing values and comments.
        const definition = String(row.sql ?? '').replace(/'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
        for (const match of definition.matchAll(/\bCONSTRAINT\s+("(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[\p{L}_][\p{L}\p{N}_$]*)/giu)) {
          entries.push({ key: `constraint:${JSON.stringify([schema.name, row.name, match[1]])}` });
        }
        // SQLite represents named table constraints in CREATE SQL rather than
        // catalog rows. Index metadata also covers implicit UNIQUE/PRIMARY KEY.
        for (const index of db.query('SELECT * FROM pragma_index_list(?, ?)').all(row.name, schema.name)) {
          entries.push({ key: `index:${JSON.stringify([schema.name, row.name, index.name])}` });
        }
      }
    }
  }
  return new Map(entries.map(entry => [entry.key, entry]));
}

export function assertAdditiveSchemaCatalog(before: SchemaCatalog, after: SchemaCatalog): void {
  const violations: string[] = [];
  for (const [key, entry] of before) {
    const next = after.get(key);
    if (!next) violations.push(`removed or renamed ${key}`);
    else if (entry.type !== next.type) violations.push(`changed type ${key}: ${entry.type} -> ${next.type}`);
    else if (!entry.notNull && next.notNull) violations.push(`SET NOT NULL ${key}`);
  }
  if (violations.length) throw new Error(`Destructive schema catalog change is forbidden in an expand migration; declare a later-release contract step:\n${violations.join('\n')}`);
}
