/** Explicit maintenance operation. This module must not enter the startup graph. */
import { advisoryLock, type SqlDatabase } from './db/postgres.js';
import { MIGRATION_ADVISORY_LOCK_KEY } from './advisory-locks.js';
import { runSchemaContracts } from './schema-migration-runner.js';
import { SCHEMA_MIGRATIONS } from './schema-migrations.js';
import { SCHEMA_CONTRACT_MIGRATIONS } from './schema-contract-migrations.js';
import { readSchemaLevels, SCHEMA_COMPATIBILITY } from './schema-levels.js';
import { PACKAGE_VERSION as version } from '@shared/package-version.js';

export function contractSchema(db: SqlDatabase, targetLevel: number): ReturnType<typeof readSchemaLevels> {
  // There is no reliable inventory of already-open, idle SQLite handles.
  if (db.dialect !== 'postgres') throw new Error('Schema contract requires PostgreSQL and all API slots stopped; SQLite contract is not supported');
  return advisoryLock(db, MIGRATION_ADVISORY_LOCK_KEY, () => {
    runSchemaContracts(db, [...SCHEMA_MIGRATIONS, ...SCHEMA_CONTRACT_MIGRATIONS], {
      targetLevel, release: version, code: SCHEMA_COMPATIBILITY,
      assertSlotsCompatible: () => assertSchemaContractClientsOffline(db),
    });
    return readSchemaLevels(db);
  });
}

/** Caller holds MIGRATION_ADVISORY_LOCK_KEY throughout the contract run. */
export function assertSchemaContractClientsOffline(db: SqlDatabase, operation: "contract" | "classify-scm-links" = "contract"): void {
  // Conservatively require every other client disconnected, including standby
  // slots. A connecting startup waits on our lock and rechecks the floor.
  const row = db.query(`SELECT COUNT(*) AS count FROM pg_stat_activity
    WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'`).get();
  if (row && Number(row.count) === 0) return;
  if (operation === "classify-scm-links") {
    throw new Error("Other database clients are online. Disconnect all clients and keep old writers isolated. Retry remi db classify-scm-links with the same arguments; resume compatible writers only after success.");
  }
  throw new Error('Schema contract refused: other database clients are online. Stop ALL API slots and database workers, run remi db contract, then restart compatible releases.');
}
