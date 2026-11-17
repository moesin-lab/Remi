import { expect, test, spyOn } from 'bun:test';
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import type { SqlDatabase } from '@multiremi/store/db/postgres.js';
import { readAttemptRow, readAttemptTurn, readCurrentTurnRow, readTurnRow } from '@multiremi/store/execution-reads.js';
import { invalidatingDatabase, markRequestReadCacheLockTaken, withSynchronousRequestReadCache } from '@multiremi/store/request-read-cache.js';

test('execution projections share reads, retain independent objects and observe mutations and rollback', () => {
  const raw = openSqliteDatabase(':memory:');
  const db = invalidatingDatabase(raw) as unknown as SqlDatabase;
  db.exec(`CREATE TABLE multiremi_turns(id TEXT PRIMARY KEY, current_attempt_id TEXT, status TEXT);
    CREATE TABLE multiremi_turn_attempts(id TEXT PRIMARY KEY, turn_id TEXT, input_ack_seq INTEGER);
    INSERT INTO multiremi_turns VALUES('turn','attempt','running');
    INSERT INTO multiremi_turn_attempts VALUES('attempt','turn',2);`);
  const reads = spyOn(raw, 'query');
  try {
    withSynchronousRequestReadCache(() => {
      const first = readCurrentTurnRow(db, 'attempt')!;
      first.status = 'decorated';
      expect(readTurnRow(db, 'turn')?.status).toBe('running');
      expect(readAttemptTurn(db, 'attempt')).toEqual({ turn_id: 'turn' });
      expect(readAttemptRow(db, 'attempt')?.input_ack_seq).toBe(2);
      expect(reads).toHaveBeenCalledTimes(2);
      db.transaction(() => {
        expect(readTurnRow(db, 'turn')?.status).toBe('running');
        const beforeLock = reads.mock.calls.length;
        markRequestReadCacheLockTaken();
        expect(readTurnRow(db, 'turn')?.status).toBe('running');
        expect(reads.mock.calls.length).toBe(beforeLock + 1);
        db.run("UPDATE multiremi_turns SET status='completed' WHERE id='turn'");
        expect(readCurrentTurnRow(db, 'attempt')?.status).toBe('completed');
        db.run("UPDATE multiremi_turn_attempts SET input_ack_seq=8 WHERE id='attempt'");
        expect(readAttemptRow(db, 'attempt')?.input_ack_seq).toBe(8);
      })();
      expect(() => db.transaction(() => {
        db.run("UPDATE multiremi_turns SET status='failed' WHERE id='turn'");
        expect(readTurnRow(db, 'turn')?.status).toBe('failed');
        throw new Error('rollback');
      })()).toThrow('rollback');
      expect(readTurnRow(db, 'turn')?.status).toBe('completed');
      expect(readAttemptTurn(db, 'missing')).toBeNull();
    });
    db.run("UPDATE multiremi_turns SET status='changed' WHERE id='turn'");
    expect(readTurnRow(db, 'turn')?.status).toBe('changed');
  } finally { reads.mockRestore(); raw.close(); }
});
