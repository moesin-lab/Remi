/** Required scalar cutover, separate from schema DDL and archive/evidence recovery. */
import { advisoryLock, type SqlDatabase } from "./db/postgres.js";
import {
  ensureLegacyUsageMigrationSchema, hasPendingLegacyUsage, migrateLegacyUsage, USAGE_CUTOVER_MARKER, USAGE_MIGRATION_LOCK, USAGE_STARTUP_CUTOVER_MARKER,
} from "./usage-accounting.js";

// A manual preparation may have written the old marker while old servers were
// still writing JSON. Only a startup pass can establish this cutover marker.
export { USAGE_STARTUP_CUTOVER_MARKER } from "./usage-accounting.js";
export const DEFAULT_USAGE_MIGRATION_TIMEOUT_MS = 300_000;
export interface UsageStartupMigrationOptions {
  signal?: AbortSignal;
  batchSize?: number;
  timeoutMs?: number;
  onBatch?: (batch: { migrated: number; hasMore: boolean }) => void;
}

function ready(db: SqlDatabase): boolean {
  return Boolean(db.query("SELECT id FROM multiremi_schema_migrations WHERE id=?").get(USAGE_STARTUP_CUTOVER_MARKER));
}

function startupMigration(db: SqlDatabase, options: UsageStartupMigrationOptions) {
  const batchSize = options.batchSize ?? Number(process.env.MULTIREMI_USAGE_MIGRATION_BATCH_SIZE ?? 500);
  const timeoutMs = options.timeoutMs ?? Number(process.env.MULTIREMI_USAGE_MIGRATION_TIMEOUT_MS ?? DEFAULT_USAGE_MIGRATION_TIMEOUT_MS);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 5000) throw new Error("Usage migration batch size must be 1..5000");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Usage migration timeout must be a positive integer");
  if (db.inTransaction) throw new Error("Usage startup migration must run outside a transaction/schema migration lock");
  const deadline = performance.now() + timeoutMs;
  let initialized = false;
  let cursor: string | undefined = "";
  const currentReady = () => {
    if (!ready(db)) return false;
    // A previously deployed JSON-only writer may have run after this marker,
    // including during an image rollback. Query only pending IDs in the DB;
    // do not trust a marker while its processed sources have changed.
    if (!hasPendingLegacyUsage(db)) return true;
    db.run("DELETE FROM multiremi_schema_migrations WHERE id IN (?,?)", [USAGE_CUTOVER_MARKER, USAGE_STARTUP_CUTOVER_MARKER]);
    return false;
  };
  return () => {
    if (currentReady()) return true;
    if (performance.now() >= deadline) throw new Error("Usage startup migration timed out; committed checkpoints will resume on restart");
    if (!initialized) {
      ensureLegacyUsageMigrationSchema(db);
      advisoryLock(db, USAGE_MIGRATION_LOCK, () => db.exec(`CREATE TABLE IF NOT EXISTS multiremi_usage_startup_progress (
        id TEXT PRIMARY KEY, last_task_id TEXT NOT NULL, keyset_complete INTEGER NOT NULL
      )`));
      const progress = db.query("SELECT last_task_id,keyset_complete FROM multiremi_usage_startup_progress WHERE id=?").get(USAGE_STARTUP_CUTOVER_MARKER) as { last_task_id: string; keyset_complete: number } | null;
      if (progress) cursor = Number(progress.keyset_complete) === 1 ? undefined : progress.last_task_id;
      initialized = true;
    }
    const batch = migrateLegacyUsage(db, { batchSize, afterTaskId: cursor, schemaReady: true });
    if (cursor !== undefined) {
      cursor = batch.lastTaskId ?? cursor;
      db.run(`INSERT INTO multiremi_usage_startup_progress(id,last_task_id,keyset_complete) VALUES(?,?,?)
        ON CONFLICT(id) DO UPDATE SET
        last_task_id=CASE WHEN multiremi_usage_startup_progress.last_task_id<excluded.last_task_id THEN excluded.last_task_id ELSE multiremi_usage_startup_progress.last_task_id END,
        keyset_complete=CASE WHEN multiremi_usage_startup_progress.keyset_complete=1 THEN 1 ELSE excluded.keyset_complete END`,
      [USAGE_STARTUP_CUTOVER_MARKER, cursor, batch.complete ? 1 : 0]);
    }
    options.onBatch?.({ migrated: batch.migrated, hasMore: !batch.complete });
    if (performance.now() >= deadline) throw new Error("Usage startup migration timed out; committed checkpoints will resume on restart");
    if (!batch.complete) return false;
    // Recheck rows changed behind the keyset cursor. Both process roles use
    // this same mutex; each batch has already committed its task checkpoints.
    return advisoryLock(db, USAGE_MIGRATION_LOCK, () => {
      if (currentReady()) return true;
      const final = migrateLegacyUsage(db, { batchSize, schemaReady: true });
      if (performance.now() >= deadline) throw new Error("Usage startup migration timed out; committed checkpoints will resume on restart");
      if (!final.complete) { cursor = undefined; return false; }
      const finish = db.transaction(() => {
        // Close the last source/check/marker race. No history writes happen in
        // this short fence; all per-task migration transactions are committed.
        if (db.dialect === "postgres") db.exec("LOCK TABLE multiremi_turns, multiremi_turn_attempts, multiremi_usage_runs IN SHARE MODE");
        if (hasPendingLegacyUsage(db)) { cursor = undefined; return false; }
        if (performance.now() >= deadline) throw new Error("Usage startup migration timed out; committed checkpoints will resume on restart");
        for (const marker of [USAGE_CUTOVER_MARKER, USAGE_STARTUP_CUTOVER_MARKER]) {
          db.run("INSERT INTO multiremi_schema_migrations(id,applied_at) VALUES(?,?) ON CONFLICT(id) DO NOTHING", [marker, new Date().toISOString()]);
        }
        return true;
      });
      return (finish as typeof finish & { immediate?: () => boolean }).immediate?.() ?? finish();
    });
  };
}

/** Maintenance/background loop: every bounded batch commits before yielding. */
export async function prepareUsageAccountingStartup(db: SqlDatabase, options: UsageStartupMigrationOptions = {}): Promise<void> {
  const step = startupMigration(db, options);
  for (;;) {
    options.signal?.throwIfAborted();
    if (step()) return;
    await Bun.sleep(0);
  }
}

/** Explicit synchronous maintenance/test entry; never called by production startup. */
export function ensureUsageAccountingStartup(db: SqlDatabase, options: UsageStartupMigrationOptions = {}): void {
  const step = startupMigration(db, options);
  while (!step()) { /* Each bounded batch commits independently. */ }
}

/** A cancellable, resumable worker. Schedule the first batch after the listener
 * exists; release/exit waits for the last committed batch before closing DB. */
export function startUsageAccountingBackfill(db: SqlDatabase, options: UsageStartupMigrationOptions = {}) {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  let failure: unknown;
  const done = (async () => {
    await Bun.sleep(0);
    await prepareUsageAccountingStartup(db, { ...options, signal });
  })().catch(error => {
    if (!signal.aborted) { failure = error; console.error('Usage backfill failed; checkpoints retained. Restart after resolving source evidence:', error); }
  });
  return { done, get failure() { return failure; }, async stop() { controller.abort(); await done; } };
}
