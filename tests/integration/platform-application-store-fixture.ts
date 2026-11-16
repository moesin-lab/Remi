// Bundled for rehearsal: use the real PostgreSQL store and migration guard,
// without API listeners or background fixture heartbeats.
import { MultiremiStore } from '@multiremi/store.js';
import { openMultiremiDatabase } from '@multiremi/store/db/postgres.js';
const database = openMultiremiDatabase();
try { new MultiremiStore(database); }
finally { await database.close(); }
