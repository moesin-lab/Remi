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
    run: async () => {
      const db = await openDatabase();
      try {
        const { advisoryLock } = await import('@multiremi/store/db/postgres.js');
        const { MIGRATION_ADVISORY_LOCK_KEY } = await import('@multiremi/store/advisory-locks.js');
        const { assertSchemaContractClientsOffline } = await import('@multiremi/store/schema-contracts.js');
        const { classifyScmLinks } = await import('@multiremi/store/scm-ownership.js');
        advisoryLock(db, MIGRATION_ADVISORY_LOCK_KEY, () => {
          assertSchemaContractClientsOffline(db);
          classifyScmLinks(db);
        });
        console.log(JSON.stringify({ complete: true }));
      } finally { db.close(); }
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
