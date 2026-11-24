import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import type { SqlDatabase } from '@multiremi/store/db/postgres.js';
import { RootManagement } from '@multiremi/store/root-management.js';
import { withSecurityWrite } from '@multiremi/store/security-write.js';

self.onmessage = async (event: MessageEvent<{ database: string; password: string; key: string; barrier: SharedArrayBuffer }>) => {
  const { database, password, key, barrier } = event.data;
  const sqlite = openSqliteDatabase(database);
  try {
    const db = sqlite as unknown as SqlDatabase;
    db.exec('PRAGMA busy_timeout=5000');
    const service = new RootManagement(db);
    const proof = await service.verifyIndependentPassword('usr_test', password);
    const use = { action: 'root.credential-family.revoke', actualTarget: { type: 'credential_family', id: 'family' }, use: 'management' };
    const plan = service.plan(proof, use);
    const ready = new Int32Array(barrier);
    if (Atomics.add(ready, 0, 1) === 0) {
      if (Atomics.wait(ready, 0, 1, 5000) === 'timed-out') throw new Error('barrier timeout');
    } else Atomics.notify(ready, 0);
    const result = withSecurityWrite(db, undefined, plan, tx => service.revokeFamily(tx, service.authorizeWrite(tx, proof, use), 'family',
      { expected_revision: 0, reason: 'race', reason_code: 'operator_security_revoke', idempotency_key: key }));
    self.postMessage(result.status);
  } catch (error) {
    self.postMessage(error instanceof Error ? error.message : String(error));
  } finally {
    sqlite.close();
  }
};
