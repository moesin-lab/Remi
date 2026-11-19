import { MultiremiStore } from '@multiremi/store.js';
import { PostgresSyncDatabase } from '@multiremi/store/db/postgres.js';
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';

const target = process.argv[2]!;
const db = target.startsWith('postgres:') || target.startsWith('postgresql:')
  ? new PostgresSyncDatabase(target) : openSqliteDatabase(target);
try {
  const store = new MultiremiStore(db);
  store.updateWorkspace('local', { name: 'Winning workspace', description: 'Preserve winner', settings: { bootstrapWinner: true } });
  console.log(JSON.stringify(store.ensureWorkspaceOperator('local')));
} finally { db.close(); }
