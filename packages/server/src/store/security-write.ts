import type { SqlDatabase } from './db/postgres.js';
import { markRequestReadCacheLockTaken } from './request-read-cache.js';

declare const transactionBrand: unique symbol;
export interface SecurityTx { readonly [transactionBrand]: true }

export interface SecurityLockPlan {
  readonly expectedRevision: number;
  readonly workspaceIds: readonly string[];
  readonly numberKeys: readonly string[];
  readonly domainTargets: readonly string[];
}

type Failure = 'security_lock_order' | 'security_tx_invalid' | 'security_target_unplanned'
  | 'security_state_unavailable' | 'authority_revision_conflict' | 'root_authority_revoked' | 'authority_depth_exceeded'
  | 'root_required' | 'credential_version_conflict';

export class SecurityAbort extends Error {
  constructor(readonly code: Failure) { super(code); }
}

interface Frame {
  readonly fenceTerm?: string;
  readonly tx: SecurityTx;
  readonly targets: ReadonlySet<string>;
  readonly afterCommit: Array<() => void>;
  failure?: SecurityAbort;
}

const active = new WeakMap<SqlDatabase, Frame>();

function reject(frame: Frame | undefined, code: Failure): never {
  const error = new SecurityAbort(code);
  if (frame) frame.failure ??= error;
  throw error;
}

function ordered(keys: readonly string[]): string[] {
  const copy = [...keys];
  for (const [index, key] of copy.entries()) {
    if (!key || (index > 0 && copy[index - 1]! >= key)) throw new SecurityAbort('security_lock_order');
  }
  return copy;
}

function synchronous<T>(frame: Frame, callback: () => T): T {
  try {
    const result = callback();
    if (result != null && typeof (result as { then?: unknown }).then === 'function') {
      reject(frame, 'security_tx_invalid');
    }
    if (frame.failure) throw frame.failure;
    return result;
  } catch (error) {
    frame.failure ??= error instanceof SecurityAbort ? error : new SecurityAbort('security_tx_invalid');
    throw error;
  }
}

function requireActive(db: SqlDatabase, tx: SecurityTx): Frame {
  const frame = active.get(db);
  if (!frame || frame.tx !== tx || !db.inTransaction) return reject(frame, 'security_tx_invalid');
  if (frame.failure) throw frame.failure;
  return frame;
}

export function afterSecurityCommit(db: SqlDatabase, tx: SecurityTx, callback: () => void): void {
  const frame = requireActive(db, tx);
  if (db.afterCommit) db.afterCommit(callback);
  else frame.afterCommit.push(callback);
}

export function withSecurityTarget<T>(db: SqlDatabase, tx: SecurityTx, target: string, callback: () => T): T {
  const frame = requireActive(db, tx);
  if (!frame.targets.has(target)) return reject(frame, 'security_target_unplanned');
  return synchronous(frame, callback);
}

export function abortSecurityWrite(db: SqlDatabase, tx: SecurityTx, code: Failure): never {
  return reject(requireActive(db, tx), code);
}

export function requireSecurityFence(db: SqlDatabase, tx: SecurityTx, term: string): void {
  const frame = requireActive(db, tx);
  if (!term || frame.fenceTerm !== term) reject(frame, 'security_tx_invalid');
}

export function withSecurityWrite<T>(db: SqlDatabase, fenceTerm: string | undefined, plan: SecurityLockPlan,
  callback: (tx: SecurityTx) => T): T {
  if (db.inTransaction !== false || active.has(db)) return reject(active.get(db), 'security_tx_invalid');
  if (db.dialect !== 'sqlite' && db.dialect !== 'postgres') throw new SecurityAbort('security_state_unavailable');
  const workspaces = ordered(plan.workspaceIds);
  const numbers = ordered(plan.numberKeys);
  const frame: Frame = { fenceTerm, tx: Object.freeze({}) as SecurityTx, targets: new Set(ordered(plan.domainTargets)), afterCommit: [] };
  const result = db.transaction(() => {
    if (fenceTerm !== undefined && !db.query(`UPDATE multiremi_live_terms SET term = term
      WHERE scope = 'background_jobs' AND term = ? RETURNING term`).get(fenceTerm)) {
      throw new SecurityAbort('security_tx_invalid');
    }
    const state = db.query(`UPDATE multiremi_security_state SET security_revision = security_revision
      WHERE singleton = 1 RETURNING security_revision`).get();
    if (!state) throw new SecurityAbort('security_state_unavailable');
    if (Number(state.security_revision) !== plan.expectedRevision) throw new SecurityAbort('authority_revision_conflict');
    for (const workspace of workspaces) {
      if (!db.query(`UPDATE multiremi_workspaces SET updated_at = updated_at WHERE id = ? RETURNING id`).get(workspace)) {
        throw new SecurityAbort('security_target_unplanned');
      }
    }
    markRequestReadCacheLockTaken();
    if (db.dialect === 'postgres') {
      for (const key of numbers) {
        if (!db.advisoryXactLock) throw new SecurityAbort('security_state_unavailable');
        db.advisoryXactLock(key);
      }
    }
    active.set(db, frame);
    try { return synchronous(frame, () => callback(frame.tx)); }
    finally { active.delete(db); }
  })();
  for (const notify of frame.afterCommit) {
    try { notify(); } catch { continue; }
  }
  return result;
}
