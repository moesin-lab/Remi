import type { SqlDatabase } from './db/postgres.js';
import type { CreateTaskInput } from '@multiremi/contracts/types.js';
import type { MultiremiStore } from './store.js';
import type { ApprovedExecutionInputs, RootManagement } from './root-management.js';
import type { AdmissionTicket, AuthorityKernel, CredentialProof, FinalExecution, InputManifest } from './root-authority-contract.js';
import { withSecurityTarget, withSecurityWrite, type SecurityLockPlan, type SecurityTx } from './security-write.js';
import { tableExists } from './unified-model-migration.js';
import { isDeepStrictEqual } from 'node:util';

type AttemptRow = Readonly<Record<string, unknown>>;
type AdmissionKernel = Pick<AuthorityKernel, 'admitAttempt' | 'consumeAdmission'>;
type AdmissionArgs = Parameters<AdmissionKernel['admitAttempt']>;

export interface AttemptWrite {
  readonly attemptId: string;
  readonly kernel: AdmissionKernel;
  beforeOperation?(tx: SecurityTx): void;
  resolveInvocation(tx: SecurityTx): { subject: AdmissionArgs[1]; invocation: AdmissionArgs[2] };
  resolveExecution(tx: SecurityTx, row: AttemptRow): { execution: FinalExecution; manifest: InputManifest };
}

const activeInsert = new WeakMap<SqlDatabase, { attemptId: string; apply(row: AttemptRow, insert: () => void): void }>();

export function reservedAttemptId(db: SqlDatabase) { return activeInsert.get(db)?.attemptId; }

type VerifiedTarget = Parameters<RootManagement['verifyAttemptInvocation']>[2] & { agentId: string };
type ResolvedAttempt = { execution: FinalExecution; inputs: ApprovedExecutionInputs };
type ResolveAttempt = (tx: SecurityTx, row: AttemptRow) => ResolvedAttempt;

export function planVerifiedAttemptWrite(service: RootManagement, proof: CredentialProof, target: VerifiedTarget,
  preview: FinalExecution, resolve: ResolveAttempt) {
  const plan = service.planAttemptAdmission(proof, target, preview);
  let invocation: AdmissionArgs[2] | undefined;
  let approval: { resolved: ResolvedAttempt; manifest: InputManifest } | undefined;
  const write: AttemptWrite = {
    attemptId: target.attemptId, kernel: service,
    beforeOperation(tx) {
      invocation = undefined;
      approval = undefined;
      if (target.previousAttemptId !== null) invocation = service.verifyDirectRetryInvocation(tx, proof, target);
    },
    resolveInvocation(tx) {
      invocation ??= service.verifyAttemptInvocation(tx, proof, target);
      return { subject: { type: 'agent', id: target.agentId }, invocation };
    },
    resolveExecution(tx, row) {
      const resolved = resolve(tx, row);
      if (!invocation || row.id !== target.attemptId || row.turn_id !== target.turnId || row.runtime_id !== resolved.execution.runtimeId ||
          !isDeepStrictEqual(preview, resolved.execution)) throw new Error('authority_revision_conflict');
      if (approval) {
        if (!isDeepStrictEqual(approval.resolved, resolved)) throw new Error('authority_revision_conflict');
      } else {
        const actor = service.authorizeWrite(tx, proof, { action: 'attempt.inputs.approve', use: 'write', actualTarget: { type: 'attempt', id: target.attemptId } });
        const manifest = service.approveAttemptInputs(tx, actor, invocation, resolved.execution, resolved.inputs);
        approval = { resolved: structuredClone(resolved), manifest };
      }
      return { execution: resolved.execution, manifest: approval.manifest };
    },
  };
  return { plan, write };
}

export function createAdmittedTask(store: MultiremiStore, input: CreateTaskInput, proof: CredentialProof, preview: FinalExecution, resolve: ResolveAttempt) {
  const agent = store.getAgent(input.agentId);
  const sessionId = input.conversationSessionId ?? input.issueSessionId ?? input.issue_session_id ?? input.chatSessionId;
  if (!agent || !sessionId || input.parentTaskId || (input.id && input.id !== preview.attemptId)) throw new Error('authority_revision_conflict');
  const target = { turnId: preview.attemptId, attemptId: preview.attemptId, previousAttemptId: null, agentId: agent.id, workspaceId: agent.workspaceId, sessionId };
  const { plan, write } = planVerifiedAttemptWrite(store.rootManagement, proof, target, preview, resolve);
  return store.withAttemptAdmission(plan.fenceTerm, plan, write, () => store.createTask({ ...input, id: preview.attemptId }));
}

export function retryAdmittedTurn(store: MultiremiStore, turnId: string, previousAttemptId: string, proof: CredentialProof,
  preview: FinalExecution, resolve: ResolveAttempt, cold = false, authorizeConversation?: (sessionId: string) => void) {
  const turn = store.getTurn(turnId);
  if (!turn || turn.current_attempt_id !== previousAttemptId) throw new Error('authority_revision_conflict');
  const target = { turnId, previousAttemptId, attemptId: preview.attemptId, agentId: turn.agent_id };
  const { plan, write } = planVerifiedAttemptWrite(store.rootManagement, proof, target, preview, resolve);
  return store.withAttemptAdmission(plan.fenceTerm, plan, write, () => store.retryTurnAsMember(turnId, cold, authorizeConversation));
}

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
    activeInsert.set(db, { attemptId: write.attemptId, apply: (row, insert) => withSecurityTarget(db, tx, `attempt:${write.attemptId}`, () => {
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
    }) });
    try {
      write.beforeOperation?.(tx);
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
  if (admit) admit.apply(row, insert);
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
