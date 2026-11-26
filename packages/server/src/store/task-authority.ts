import type { SqlDatabase } from './db/postgres.js';
import { requireSecurityFence, SecurityAbort, withSecurityTarget, type SecurityTx } from './security-write.js';

export interface TaskLease {
  readonly attemptId: string;
  readonly leaseId: string;
  readonly fenceTerm: string;
  readonly consumerId: string;
  readonly runGeneration: number;
  readonly runtimeId: string;
  readonly daemonId: string;
  readonly incarnation: string;
  readonly expiresAtMs: number;
  readonly state: 'dispatched' | 'running';
}

export function approvedAttemptSources(db:SqlDatabase, manifest: {id:string;version:number;digest:string}) {
  const row = db.query(`SELECT p.*,g.authority_node_id AS issuer_grant_node,invoker.authority_node_id AS invoker_grant_node FROM multiremi_attempt_input_approvals p
    JOIN multiremi_root_grants g ON g.grant_id=p.issuer_grant_id AND g.generation=p.issuer_grant_generation
    JOIN multiremi_root_subject_state s ON s.active_grant_id=g.grant_id AND s.generation_counter=g.generation
    JOIN multiremi_root_grants invoker ON invoker.grant_id=p.invoker_grant_id AND invoker.generation=p.invoker_grant_generation
    JOIN multiremi_root_subject_state i ON i.active_grant_id=invoker.grant_id AND i.generation_counter=invoker.generation
    WHERE p.manifest_id=? AND p.manifest_version=? AND p.manifest_digest=? AND g.revoked_at_ms IS NULL
      AND (g.expires_at_ms IS NULL OR g.expires_at_ms>?) AND invoker.revoked_at_ms IS NULL
      AND (invoker.expires_at_ms IS NULL OR invoker.expires_at_ms>?)`).get(manifest.id,manifest.version,manifest.digest,Date.now(),Date.now());
  if (!row) return null;
  const provider = JSON.parse(row.provider_trust_json);
  const checkpoint = JSON.parse(row.checkpoint_trust_json);
  return {row, sources:[provider,...(checkpoint?[checkpoint]:[]),{id:row.authority_node_id,version:Number(row.authority_generation)},
    {id:row.issuer_grant_node,version:Number(row.issuer_grant_generation)},{id:row.invoker_node_id,version:Number(row.invoker_node_generation)},
    {id:row.invoker_grant_node,version:Number(row.invoker_grant_generation)}] as {id:string;version:number}[]};
}

export type AttemptEligibilityRow = Readonly<{attempt_id:string;eligibility:'none'} | {
  attempt_id:string;eligibility:'root';subject_type:'agent';subject_id:string;grant_id:string;grant_generation:number;
  runtime_trust_id:string;runtime_trust_version:number;invocation_json:string;manifest_json:string;runtime_id:string;
  daemon_id:string;incarnation:string;execution_digest:string;config_epoch:number;provider_trust_json:string;
  checkpoint_trust_json:string|null;admission_revision:number|string;
}>;

export interface CurrentTaskLeaseRow {
  readonly attempt_id:string; readonly lease_version:number|string; readonly lease_id:string; readonly fence_term:string;
  readonly consumer_id:string; readonly run_generation:number; readonly runtime_id:string; readonly daemon_id:string;
  readonly incarnation:string; readonly expires_at_ms:number|string; readonly state:TaskLease['state'];
}

export function matchesDeliveryLease(current: CurrentTaskLeaseRow | null, tuple: {
  attempt_id: string; consumer_id: string; run_generation: number; runtime_id: string; daemon_id: string; incarnation: string;
}, receipt: { lease_id: string; fence_term: string; run_state: string }): boolean {
  return current !== null && current.attempt_id === tuple.attempt_id && current.consumer_id === tuple.consumer_id &&
    Number(current.run_generation) === tuple.run_generation && current.runtime_id === tuple.runtime_id &&
    current.daemon_id === tuple.daemon_id && current.incarnation === tuple.incarnation && current.lease_id === receipt.lease_id &&
    current.fence_term === receipt.fence_term && ((receipt.run_state === 'pending_start' && current.state === 'dispatched') ||
      (receipt.run_state === 'running' && current.state === 'running'));
}

export function readAttemptEligibility(db: SqlDatabase, tx: SecurityTx, attemptId: string):AttemptEligibilityRow|null {
  return withSecurityTarget(db, tx, `attempt:${attemptId}`, () =>
    db.query('SELECT * FROM multiremi_attempt_eligibility WHERE attempt_id=?').get(attemptId) ?? null);
}

export function readCurrentTaskLease(db: SqlDatabase, tx: SecurityTx, attemptId: string):CurrentTaskLeaseRow|null {
  return withSecurityTarget(db, tx, `attempt:${attemptId}`, () => {
    const lease=db.query(`SELECT lease.* FROM multiremi_current_task_leases lease JOIN multiremi_live_terms fence
      ON fence.scope='background_jobs' AND CAST(fence.term AS TEXT)=lease.fence_term AND fence.holder IS NOT NULL
      WHERE lease.attempt_id=? AND lease.expires_at_ms>?`).get(attemptId, Date.now());
    if (lease) requireSecurityFence(db,tx,lease.fence_term);
    return lease ?? null;
  });
}

export function writeCurrentTaskLease(db: SqlDatabase, tx: SecurityTx, expectedVersion: number, lease: TaskLease): number {
  return withSecurityTarget(db, tx, `attempt:${lease.attemptId}`, () => {
    requireSecurityFence(db, tx, lease.fenceTerm);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || !Number.isSafeInteger(lease.expiresAtMs)
      || lease.expiresAtMs <= Date.now() || !Number.isSafeInteger(lease.runGeneration) || lease.runGeneration < 0
      || ![lease.leaseId,lease.fenceTerm,lease.consumerId,lease.runtimeId,lease.daemonId,lease.incarnation].every(Boolean)) {
      throw new SecurityAbort('authority_revision_conflict');
    }
    const row = db.query(`INSERT INTO multiremi_current_task_leases(attempt_id,lease_version,lease_id,fence_term,consumer_id,
      run_generation,runtime_id,daemon_id,incarnation,expires_at_ms,state)
      SELECT e.attempt_id,?,?,?,?,?,?,?,?,?,? FROM multiremi_attempt_eligibility e
      JOIN multiremi_live_terms f ON f.scope='background_jobs' AND CAST(f.term AS TEXT)=? AND f.holder IS NOT NULL
      WHERE e.attempt_id=? AND e.eligibility='root' AND e.runtime_id=? AND e.daemon_id=? AND e.incarnation=?
        AND (?=0 OR EXISTS (SELECT 1 FROM multiremi_current_task_leases prior WHERE prior.attempt_id=e.attempt_id))
        AND (?<>0 OR ?='dispatched')
      ON CONFLICT(attempt_id) DO UPDATE SET lease_version=excluded.lease_version,lease_id=excluded.lease_id,
        fence_term=excluded.fence_term,consumer_id=excluded.consumer_id,run_generation=excluded.run_generation,
        expires_at_ms=excluded.expires_at_ms,state=excluded.state
      WHERE multiremi_current_task_leases.lease_version=? AND (
        (excluded.run_generation>multiremi_current_task_leases.run_generation AND excluded.state='dispatched'
          AND excluded.lease_id<>multiremi_current_task_leases.lease_id) OR
        (excluded.run_generation=multiremi_current_task_leases.run_generation AND excluded.lease_id=multiremi_current_task_leases.lease_id
          AND excluded.fence_term=multiremi_current_task_leases.fence_term AND excluded.consumer_id=multiremi_current_task_leases.consumer_id
          AND multiremi_current_task_leases.expires_at_ms>? AND (multiremi_current_task_leases.state='dispatched' OR excluded.state='running')))
      RETURNING lease_version`).get(expectedVersion+1, lease.leaseId, lease.fenceTerm, lease.consumerId, lease.runGeneration,
      lease.runtimeId, lease.daemonId, lease.incarnation, lease.expiresAtMs, lease.state, lease.fenceTerm, lease.attemptId,
      lease.runtimeId, lease.daemonId, lease.incarnation, expectedVersion, expectedVersion, lease.state, expectedVersion, Date.now());
    if (!row) throw new SecurityAbort('authority_revision_conflict');
    return Number(row.lease_version);
  });
}
