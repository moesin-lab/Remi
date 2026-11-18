import { hasDestructiveSchemaSql } from "./schema-ddl.js";
import type { SqlDatabase } from './db/postgres.js';
import { assertSchemaCompatible, ensureSchemaMeta, readSchemaLevels, type SchemaCompatibility } from './schema-levels.js';

export interface SchemaMigration {
  id: string;
  phase: 'expand' | 'contract';
  level: number;
  /** First release shipping the additive structures for this level. */
  expandRelease: string;
  /** First release allowed to execute this step. Contract MUST be later. */
  release: string;
  run(db: SqlDatabase): void;
}

function releaseParts(value: string): number[] {
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`Schema migrations require a stable release version: ${value}`);
  const parts = value.split('.').map(Number);
  if (parts.some(part => !Number.isSafeInteger(part))) throw new Error(`Invalid release version: ${value}`);
  return parts;
}
export function compareSchemaReleases(a: string, b: string): number {
  const left = releaseParts(a), right = releaseParts(b);
  return left.map((part, index) => part - right[index]!).find(part => part !== 0) ?? 0;
}

export function validateSchemaMigrations(steps: readonly SchemaMigration[]): void {
  const ids = new Set<string>();
  const levels = { expand: 0, contract: 0 };
  for (const step of steps) {
    if (!step.id || ids.has(step.id)) throw new Error(`Duplicate or missing schema migration id: ${step.id}`);
    ids.add(step.id);
    if (!['expand', 'contract'].includes(step.phase) || !Number.isSafeInteger(step.level) || step.level < 1 || step.level < levels[step.phase]) {
      throw new Error(`Invalid schema migration phase/level/order: ${step.id}`);
    }
    levels[step.phase] = step.level;
    const order = compareSchemaReleases(step.release, step.expandRelease);
    if (order < 0 || (step.phase === 'contract' && order <= 0)) throw new Error(`Contract must ship after its expand release: ${step.id}`);
  }
}

/** Caller owns the migration lock; each step and its marker commit together. */
export function runSchemaExpands(db: SqlDatabase, steps: readonly SchemaMigration[], release: string, code: SchemaCompatibility): void {
  validateSchemaMigrations(steps);
  // Refuse contracted databases before creating or changing any metadata.
  const schema = readSchemaLevels(db);
  if (schema.contractLevel > code.maxLevel) assertSchemaCompatible(schema, code);
  ensureSchemaMeta(db);
  for (const step of steps.filter(step => step.phase === 'expand' && compareSchemaReleases(release, step.release) >= 0)) {
    apply(db, step);
  }
  assertSchemaCompatible(readSchemaLevels(db), code);
}

function applied(db: SqlDatabase, step: SchemaMigration): boolean {
  const row = db.query('SELECT phase, level, release FROM multiremi_schema_steps WHERE id=?').get(step.id);
  if (!row) return false;
  if (row.phase !== step.phase || Number(row.level) !== step.level || row.release !== step.release) throw new Error(`Applied schema migration was redefined: ${step.id}`);
  return true;
}
function apply(db: SqlDatabase, step: SchemaMigration): void {
  if (applied(db, step)) return;
  db.transaction(() => {
    step.run(step.phase === "expand" ? expandOnlyDatabase(db) : db);
    db.run('INSERT INTO multiremi_schema_steps(id, phase, level, release, applied_at) VALUES(?,?,?,?,?)',
      [step.id, step.phase, step.level, step.release, new Date().toISOString()]);
    const column = step.phase === 'expand' ? 'expand_level' : 'contract_level';
    db.run(`UPDATE multiremi_schema_meta SET ${column} = CASE WHEN ${column} < ? THEN ? ELSE ${column} END WHERE singleton=1`, [step.level, step.level]);
  })();
}

/** Explicit only; NEVER called by startup. Inventory must be checked under the
 * same lock as migrations, by the caller that owns slot admission/quiescence. */
export function runSchemaContracts(db: SqlDatabase, steps: readonly SchemaMigration[], input: {
  release: string;
  targetLevel: number;
  code: SchemaCompatibility;
  assertSlotsCompatible(after: { expandLevel: number; contractLevel: number }): void;
}): void {
  validateSchemaMigrations(steps);
  if (!Number.isSafeInteger(input.targetLevel) || input.targetLevel < 0) throw new Error('Invalid target contract level');
  const before = readSchemaLevels(db);
  assertSchemaCompatible(before, input.code);
  if (input.targetLevel < before.contractLevel || input.targetLevel > before.expandLevel) throw new Error('Contract target must be between current contract and expand levels');
  const after = { ...before, contractLevel: input.targetLevel };
  assertSchemaCompatible(after, input.code);
  const pending = steps.filter(step => step.phase === 'contract' && step.level <= input.targetLevel && !applied(db, step));
  if (input.targetLevel > before.contractLevel && !pending.some(step => step.level === input.targetLevel)) throw new Error('No declared contract migration for the target level');
  // Validate every precondition before executing any destructive callback.
  for (const step of pending) {
    if (compareSchemaReleases(input.release, step.release) < 0 || compareSchemaReleases(input.release, step.expandRelease) <= 0) throw new Error(`Contract release gate refused: ${step.id}`);
    const expansion = db.query("SELECT release FROM multiremi_schema_steps WHERE phase='expand' AND level=?").all(step.level);
    if (!expansion.length || expansion.some(row => compareSchemaReleases(input.release, row.release) <= 0)) throw new Error(`Contract requires an expand from an earlier release: ${step.id}`);
  }
  input.assertSlotsCompatible(after);
  for (const step of pending) apply(db, step);
}

/** Guard prepared statements as well as exec, including helper-generated SQL. */
function expandOnlyDatabase(db: SqlDatabase): SqlDatabase {
  return new Proxy(db, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (['exec', 'run', 'query', 'prepare'].includes(String(key))) {
        return (sql: string, ...args: unknown[]) => {
          if (hasDestructiveSchemaSql(sql)) throw new Error('Destructive DDL is forbidden in an expand migration; declare a later-release contract step');
          return value.call(target, sql, ...args);
        };
      }
      // Preserve receiver-sensitive SQLite methods. Transaction callbacks must
      // still use the supplied guarded handle, never a captured raw database.
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
