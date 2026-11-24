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
      { name: 'hold-for-rollback', type: 'boolean', conflictsWith: ['restore-reviewed'], description: 'Keep SCM writers gated until offline rollback review completes' },
      { name: 'restore-reviewed', type: 'string', valueName: 'json-file', description: 'Restore independently reviewed rollback evidence for named links' },
    ],
    run: async ({ options }) => {
      const { classifyScmLinks, holdScmWritersForReview } = await import('@multiremi/store/scm-ownership.js');
      const classify = (db: SqlDatabase) => {
        if (options['hold-for-rollback']) return holdScmWritersForReview(db);
        if (options['restore-reviewed']) holdScmWritersForReview(db);
        const reviewed = options['restore-reviewed']
          ? JSON.parse(readFileSync(String(options['restore-reviewed']), 'utf8')) : undefined;
        classifyScmLinks(db, reviewed);
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
      console.log(JSON.stringify(options['hold-for-rollback'] ? { writersHeld: true } : { complete: true }));
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
async function openDatabase() {
  const url = process.env.MULTIREMI_DATABASE_URL?.trim();
  if (!url || !/^postgres(?:ql)?:\/\//.test(url)) throw new Error('Set MULTIREMI_DATABASE_URL to the PostgreSQL database for this maintenance operation');
  const { PostgresSyncDatabase } = await import('@multiremi/store/db/postgres.js');
  return new PostgresSyncDatabase(url);
}

async function withOfflineSqlite(path: string, classify: (db: SqlDatabase) => void): Promise<void> {
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
      classify(db);
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
