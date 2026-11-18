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
        const { readSchemaLevels, SCHEMA_COMPATIBILITY } = await import('@multiremi/store/schema-levels.js');
        console.log(JSON.stringify({ ...readSchemaLevels(db), compatibility: SCHEMA_COMPATIBILITY }));
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
