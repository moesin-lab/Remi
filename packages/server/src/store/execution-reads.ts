import type { SqlDatabase } from './db/postgres.js';
import { memoizeRequestRead, seedRequestRead } from './request-read-cache.js';

type TurnRow = Record<string, any> & { id: string; workspace_id: string; session_id: string; agent_id: string;
  execution_scope: string; status: string; current_attempt_id: string };

/** Canonical execution rows shared by inbox adapters within one synchronous frame.
 * Writes, transaction entry and newly acquired locks invalidate these reads.
 * Return a copy: adapters may decorate rows without changing another caller's snapshot.
 */
export function readTurnRow(db: SqlDatabase, id: string): TurnRow | null {
  const row = memoizeRequestRead(db, ['multiremi_turns'], `turn-row:${id}`,
    () => db.query('SELECT * FROM multiremi_turns WHERE id=?').get(id) as TurnRow | null);
  return row ? { ...row } : null;
}

export function readAttemptRow(db: SqlDatabase, id: string): Record<string, any> | null {
  const row = memoizeRequestRead(db, ['multiremi_turn_attempts'], `attempt-row:${id}`,
    () => db.query('SELECT * FROM multiremi_turn_attempts WHERE id=?').get(id));
  return row ? { ...row } : null;
}

export function readAttemptTurn(db: SqlDatabase, id: string): { turn_id: string } | null {
  const row = readAttemptRow(db, id);
  return row ? { turn_id: String(row.turn_id) } : null;
}

export function readCurrentTurnRow(db: SqlDatabase, attemptId: string): TurnRow | null {
  const row = memoizeRequestRead(db, ['multiremi_turns'], `current-turn:${attemptId}`,
    () => db.query('SELECT * FROM multiremi_turns WHERE current_attempt_id=?').get(attemptId) as TurnRow | null);
  if (!row) return null;
  seedRequestRead(db, ['multiremi_turns'], `turn-row:${row.id}`, row);
  return { ...row };
}
