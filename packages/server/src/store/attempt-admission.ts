import type { SqlDatabase } from './db/postgres.js';
import type { AdmissionTicket, AuthorityKernel, FinalExecution, InputManifest } from './root-authority-contract.js';
import { withSecurityTarget, withSecurityWrite, type SecurityLockPlan, type SecurityTx } from './security-write.js';
import { tableExists } from './unified-model-migration.js';
import { isDeepStrictEqual } from 'node:util';

type AttemptRow = Readonly<Record<string, unknown>>;
type AdmissionKernel = Pick<AuthorityKernel, 'admitAttempt' | 'consumeAdmission'>;
type AdmissionArgs = Parameters<AdmissionKernel['admitAttempt']>;

export interface AttemptWrite {
  readonly attemptId: string;
  readonly kernel: AdmissionKernel;
  resolveInvocation(tx: SecurityTx): { subject: AdmissionArgs[1]; invocation: AdmissionArgs[2] };
  resolveExecution(tx: SecurityTx, row: AttemptRow): { execution: FinalExecution; manifest: InputManifest };
}

const activeInsert = new WeakMap<SqlDatabase, (row: AttemptRow, insert: () => void) => void>();

function saveOrdinaryEligibility(db:SqlDatabase, attemptId:unknown):void {
  const saveWithoutActiveGrant = db.query(`INSERT INTO multiremi_attempt_eligibility(attempt_id,eligibility)
    SELECT a.id,'none' FROM multiremi_turn_attempts a JOIN multiremi_turns t ON t.id=a.turn_id
    JOIN multiremi_security_state s ON s.singleton=1
    WHERE a.id=? AND (s.feature_activation=0 OR NOT EXISTS (SELECT 1 FROM multiremi_root_subject_state subject
      JOIN multiremi_root_grants g ON g.grant_id=subject.active_grant_id AND g.generation=subject.generation_counter
      WHERE subject.subject_type='agent' AND subject.subject_id=t.agent_id AND g.revoked_at_ms IS NULL
        AND (g.expires_at_ms IS NULL OR g.expires_at_ms>?))) RETURNING attempt_id`);
  if (saveWithoutActiveGrant.get(attemptId,0)) return;
  if (!saveWithoutActiveGrant.get(attemptId,Date.now())) throw new Error('root_invoker_untrusted');
}

function readExecutionRow(db:SqlDatabase, attemptId:string) {
  return db.query(`SELECT turn_id,runtime_id,provider,session_id,work_dir,plugin_snapshot,codex_profile,claude_profile,execution_connection,
    execution_fingerprint,execution_model,execution_thinking_level,fallback_switched,switch_reason,next_retry_at,projection_degrade_level,
    input_ack_seq,input_read_seq,input_read_offset,input_trigger_ack FROM multiremi_turn_attempts WHERE id=?`).get(attemptId);
}

export function withAttemptAdmission<T>(db: SqlDatabase, fence: string | undefined, plan: SecurityLockPlan,
  write: AttemptWrite, operation: () => T): T {
  return withSecurityWrite(db, fence, plan, tx => withSecurityTarget(db, tx, `attempt:${write.attemptId}`, () => {
    let inserted = false;
    let ticket: AdmissionTicket | undefined;
    let executionRow: AttemptRow | undefined;
    activeInsert.set(db, (row, insert) => withSecurityTarget(db, tx, `attempt:${write.attemptId}`, () => {
      if (inserted || row.id !== write.attemptId) throw new Error('Unexpected admission target');
      const { subject, invocation } = write.resolveInvocation(tx);
      const { execution, manifest } = write.resolveExecution(tx, row);
      if (execution.attemptId !== write.attemptId) throw new Error('Unexpected admission execution');
      const admission = write.kernel.admitAttempt(tx, subject, invocation, execution, manifest);
      if (admission.eligibility === 'root') ticket = admission.ticket;
      insert();
      if (ticket) executionRow=readExecutionRow(db,write.attemptId);
      else saveOrdinaryEligibility(db,write.attemptId);
      inserted = true;
    }));
    try {
      const result = operation();
      if (!inserted) throw new Error('Missing admitted attempt');
      if (ticket) {
        if (!isDeepStrictEqual(executionRow,readExecutionRow(db,write.attemptId))) throw new Error('Admitted execution changed after insert');
        const stored = db.query('SELECT * FROM multiremi_turn_attempts WHERE id=?').get(write.attemptId);
        if (!stored) throw new Error('Missing admitted attempt');
        const { execution, manifest } = write.resolveExecution(tx, stored);
        write.kernel.consumeAdmission(tx, ticket, execution, manifest);
      }
      return result;
    } finally { activeInsert.delete(db); }
  }));
}

export function insertTurnAttempt(db: SqlDatabase, row: AttemptRow): void {
  const columns = Object.keys(row);
  if (columns.some(column => !/^[a-z][a-z0-9_]*$/.test(column))) throw new Error('Invalid attempt column');
  const insert = () => {
    db.run(`INSERT INTO multiremi_turn_attempts(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
      columns.map(column => row[column] ?? null));
  };
  const admit = activeInsert.get(db);
  if (admit) admit(row, insert);
  else {
    const insertOrdinary = () => {
      insert();
      if (!tableExists(db,'multiremi_schema_meta') && !tableExists(db,'multiremi_security_state')) return;
      saveOrdinaryEligibility(db,row.id);
    };
    if (db.inTransaction) insertOrdinary();
    else db.transaction(insertOrdinary)();
  }
}
