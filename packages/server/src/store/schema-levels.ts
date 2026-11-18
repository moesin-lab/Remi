import schemaContract from './schema-compatibility.json';
import type { SqlDatabase } from './db/postgres.js';

export interface SchemaLevels { expandLevel: number; contractLevel: number }
export interface SchemaCompatibility { minLevel: number; maxLevel: number }

// Level 1 introduces the versioned migration protocol. Historical migrations
// predate this contract and must finish before a database is enrolled.
export const SCHEMA_COMPATIBILITY: Readonly<SchemaCompatibility> = { minLevel: schemaContract.minLevel, maxLevel: schemaContract.maxLevel };
export const SCHEMA_EXPAND_LEVEL = schemaContract.expandLevel;

function level(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
export function validateSchemaLevels(schema: SchemaLevels): void {
  if (!level(schema.expandLevel) || !level(schema.contractLevel) || schema.contractLevel > schema.expandLevel) {
    throw new Error('Invalid schema metadata: expected 0 <= contract_level <= expand_level; restore valid metadata before starting Remi');
  }
}
export function validateSchemaCompatibility(code: SchemaCompatibility): void {
  if (!level(code.minLevel) || !level(code.maxLevel) || code.minLevel > code.maxLevel) throw new Error('Invalid code schema compatibility interval');
}

/** Additions do not invalidate old readers. Only contract raises their floor. */
export function assertSchemaCompatible(schema: SchemaLevels, code: SchemaCompatibility = SCHEMA_COMPATIBILITY): void {
  validateSchemaLevels(schema);
  validateSchemaCompatibility(code);
  if (schema.contractLevel > code.maxLevel) {
    throw new Error(`Schema compatibility refused: database contract_level=${schema.contractLevel} exceeds code maxLevel=${code.maxLevel}. Start a newer compatible release; rolling back requires restoring a pre-contract database backup. Do not lower schema metadata manually.`);
  }
  if (schema.expandLevel < code.minLevel) {
    throw new Error(`Schema compatibility refused: database expand_level=${schema.expandLevel} is below code minLevel=${code.minLevel}. Run this release's expand migrations before serving traffic.`);
  }
}

/** Missing metadata is the pre-protocol level 0, never inferred from source. */
export function readSchemaLevels(db: SqlDatabase): SchemaLevels {
  const exists = db.dialect === 'postgres'
    ? db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='multiremi_schema_meta'").get()
    : db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='multiremi_schema_meta'").get();
  if (!exists) {
    return { expandLevel: 0, contractLevel: 0 };
  }
  const rows = db.query('SELECT singleton, expand_level, contract_level FROM multiremi_schema_meta').all();
  if (rows.length !== 1 || Number(rows[0].singleton) !== 1) throw new Error('Invalid schema metadata: expected exactly one multiremi_schema_meta row with singleton=1');
  if (rows[0].expand_level == null || rows[0].contract_level == null) throw new Error('Invalid schema metadata: null level');
  const schema = { expandLevel: Number(rows[0].expand_level), contractLevel: Number(rows[0].contract_level) };
  validateSchemaLevels(schema);
  return schema;
}

/** Called under the startup advisory/file lock, before ANY historical DDL. */
export function assertSchemaBeforeExpand(db: SqlDatabase, code: SchemaCompatibility = SCHEMA_COMPATIBILITY): void {
  const schema = readSchemaLevels(db);
  validateSchemaCompatibility(code);
  validateSchemaLevels(schema);
  if (schema.contractLevel > code.maxLevel) assertSchemaCompatible(schema, code);
}

export function ensureSchemaMeta(db: SqlDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_schema_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    expand_level INTEGER NOT NULL CHECK (expand_level >= 0),
    contract_level INTEGER NOT NULL CHECK (contract_level >= 0 AND contract_level <= expand_level)
  );
  CREATE TABLE IF NOT EXISTS multiremi_schema_steps (
    id TEXT PRIMARY KEY,
    phase TEXT NOT NULL CHECK (phase IN ('expand', 'contract')),
    level INTEGER NOT NULL CHECK (level > 0),
    release TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );`);
  db.run('INSERT INTO multiremi_schema_meta(singleton, expand_level, contract_level) VALUES(1, 0, 0) ON CONFLICT(singleton) DO NOTHING');
}

/** Read-only integration surface for the updater and slot control plane. */
export function querySchemaCompatibility(db: SqlDatabase) {
  const levels = readSchemaLevels(db);
  return { ...levels, compatibility: { ...SCHEMA_COMPATIBILITY } };
}
