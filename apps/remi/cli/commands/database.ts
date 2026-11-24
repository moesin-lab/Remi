import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import type { CommandSpec } from '../core/command-registry.js';

/** Local maintenance commands: DB credentials, never platform/task API auth. */
export function databaseCommandSpecs(): CommandSpec[] {
  return [{
    id: 'db.schema', path: ['db', 'schema'],
    description: 'Read PostgreSQL expand/contract levels and this code compatibility interval',
    mutation: 'read', outputs: ['json'],
    run: async () => {
      const db = await openDatabase();
      try {
        const { querySchemaCompatibility } = await import('@multiremi/store/schema-levels.js');
        console.log(JSON.stringify(querySchemaCompatibility(db)));
      } finally { db.close(); }
    },
  }, {
    id: 'db.prepare', path: ['db', 'prepare'],
    description: 'Prepare a historical PostgreSQL schema offline; completed steps resume on retry',
    mutation: 'destructive', outputs: ['json'],
    run: async () => {
      const db = await openDatabase();
      try {
        const { advisoryLock } = await import('@multiremi/store/db/postgres.js');
        const { MIGRATION_ADVISORY_LOCK_KEY } = await import('@multiremi/store/advisory-locks.js');
        const { assertSchemaContractClientsOffline } = await import('@multiremi/store/schema-contracts.js');
        const { runMigrations } = await import('@multiremi/store/migrations.js');
        const { querySchemaCompatibility } = await import('@multiremi/store/schema-levels.js');
        advisoryLock(db, MIGRATION_ADVISORY_LOCK_KEY, () => {
          assertSchemaContractClientsOffline(db);
          runMigrations(db, { historicalMaintenance: true });
        });
        console.log(JSON.stringify(querySchemaCompatibility(db)));
      } finally { db.close(); }
    },
  }, {
    id: 'db.classify-scm-links', path: ['db', 'classify-scm-links'],
    description: 'Freeze existing SCM link ownership after isolating all old writers',
    mutation: 'destructive', outputs: ['json'],
    options: [
      { name: 'sqlite-file', type: 'string', valueName: 'absolute-path', description: 'Existing SQLite Server database file for exclusive offline classification' },
      { name: 'export-inventory', type: 'boolean', conflictsWith: ['adopt-inventory','hold-for-rollback','after','review-page','finalize'], description: 'Export from an isolated historical level 4/5 snapshot for independent provenance verification' },
      { name: 'adopt-inventory', type: 'string', valueName: 'archive-file', conflictsWith: ['hold-for-rollback','after','review-page','finalize'], description: 'Compare a historical archive against the independently provisioned target-specific pin' },
      { name: 'hold-for-rollback', type: 'boolean', conflictsWith: ['after','review-page','finalize'], description: 'Gate writers and capture the immutable pre-rollback inventory' },
      { name: 'after', type: 'string', conflictsWith: ['review-page','finalize'], description: 'Show the next 25 differences after this stable entry key' },
      { name: 'review-page', type: 'string', conflictsWith: ['finalize'], valueName: 'json-file', description: 'Stage a complete generation-bound page of text-only reviews' },
      { name: 'finalize', type: 'string', valueName: 'receipt-file', description: 'Recheck the full inventory and explicitly release this reviewed generation' },
    ],
    run: async ({ options }) => {
      const { classifyScmLinks } = await import('@multiremi/store/scm-ownership.js');
      const { holdScmWritersForReview, auditScmRollback, legacyInventory, adoptLegacyInventory } = await import('@multiremi/store/scm-rollback-audit.js');
      let result: unknown;
      const classify = (db: SqlDatabase, sqliteTarget?: string) => {
        if (options['export-inventory']) result = legacyInventory(db);
        else if (options['adopt-inventory']) {
          const target = sqliteTarget ?? postgresAuditTarget();
          const pin = historicalInventoryPin(target);
          result = adoptLegacyInventory(db, readFileSync(String(options['adopt-inventory'])), pin.sha256, pin.continuousIsolation === true);
        } else if (options['hold-for-rollback']) result = holdScmWritersForReview(db);
        else if (options['review-page']) result = auditScmRollback(db, { review: JSON.parse(readFileSync(String(options['review-page']), 'utf8')) });
        else if (options.finalize) result = auditScmRollback(db, { finalize: JSON.parse(readFileSync(String(options.finalize), 'utf8')) });
        else if (options.after) result = auditScmRollback(db, { after: String(options.after) });
        else result = classifyScmLinks(db);
      };
      if (options['sqlite-file']) {
        await withOfflineSqlite(String(options['sqlite-file']), classify);
      } else {
        const db = await openDatabase();
        try {
          const { advisoryLock } = await import('@multiremi/store/db/postgres.js');
          const { MIGRATION_ADVISORY_LOCK_KEY } = await import('@multiremi/store/advisory-locks.js');
          const { assertSchemaContractClientsOffline } = await import('@multiremi/store/schema-contracts.js');
          advisoryLock(db, MIGRATION_ADVISORY_LOCK_KEY, () => {
            assertSchemaContractClientsOffline(db, 'classify-scm-links');
            classify(db);
          });
        } finally { db.close(); }
      }
      console.log(JSON.stringify(result));
    },
  }, {
    id: 'db.contract', path: ['db', 'contract'],
    description: 'Execute declared contract migrations after all PostgreSQL clients have stopped',
    mutation: 'destructive', outputs: ['json'],
    options: [{ name: 'level', type: 'integer', required: true, description: 'Declared target contract level' }],
    run: async ({ options }) => {
      const db = await openDatabase();
      try {
        const { contractSchema } = await import('@multiremi/store/schema-contracts.js');
        console.log(JSON.stringify(contractSchema(db, options.level as number)));
      } finally { db.close(); }
    },
  }];
}
function postgresAuditTarget(): string {
  const target = new URL(process.env.MULTIREMI_DATABASE_URL!);
  if (target.search || target.hash) throw new Error('Use a direct target database URL without overrides for historical provenance');
  return `postgres://${target.hostname}:${target.port || '5432'}${target.pathname}`;
}

function historicalInventoryPin(target: string): { sha256: string; continuousIsolation?: boolean } {
  const path = '/etc/remi/scm-cutover-anchors.json';
  for (const component of ['/etc', '/etc/remi', path]) {
    const info = statSync(component);
    if (realpathSync(component) !== component || info.uid !== 0 || (info.mode & 0o022) !== 0) throw new Error('Untrusted historical inventory pin location');
  }
  const pin = JSON.parse(readFileSync(path, 'utf8')).targets?.[target];
  if (!pin || !/^[a-f0-9]{64}$/.test(pin.sha256)) throw new Error('Missing independent historical provenance for this database target');
  return pin;
}

async function openDatabase() {
  const url = process.env.MULTIREMI_DATABASE_URL?.trim();
  if (!url || !/^postgres(?:ql)?:\/\//.test(url)) throw new Error('Set MULTIREMI_DATABASE_URL to the PostgreSQL database for this maintenance operation');
  const { PostgresSyncDatabase } = await import('@multiremi/store/db/postgres.js');
  return new PostgresSyncDatabase(url);
}

async function withOfflineSqlite(path: string, classify: (db: SqlDatabase, target: string) => void): Promise<void> {
  if (!isAbsolute(path) || !statSync(path).isFile()) throw new Error('--sqlite-file requires an existing absolute database file');
  if (process.env.MULTIREMI_DATABASE_URL?.trim()) throw new Error('Select one maintenance target: unset MULTIREMI_DATABASE_URL when using --sqlite-file');
  const filename = realpathSync(path);
  const { openSqliteDatabase } = await import('@multiremi/store/db/sqlite.js');
  const lock = openSqliteDatabase(`${filename}.migration-lock`, { create: true });
  try {
    lock.exec('BEGIN IMMEDIATE');
    const db = openSqliteDatabase(filename, { readwrite: true, create: false });
    try {
      db.exec('PRAGMA locking_mode=EXCLUSIVE');
      db.exec('BEGIN EXCLUSIVE');
      db.exec('COMMIT');
      classify(db, `sqlite:${filename}`);
    } finally { db.close(); }
  } catch (error) {
    if (error instanceof Error && /SQLITE_(BUSY|LOCKED)|database is locked/i.test(`${error.name}: ${error.message}`)) {
      throw new Error('SQLite database is busy. Disconnect all clients and keep old writers isolated. Retry remi db classify-scm-links with the same arguments; resume compatible writers only after success.');
    }
    throw error;
  } finally {
    if (lock.inTransaction) lock.exec('ROLLBACK');
    lock.close();
  }
}
