import type { MergeOperationBinding, ScmMergeOperation } from '@multiremi/contracts/merge-operation.js';
import type { ScmActor } from '@multiremi/contracts/merge-policy.js';
import type { StoreContext } from '../context.js';
import { createId, nowIso } from '@multiremi/ids.js';
import { ScmOperationError } from '../../scm/operations.js';
import { afterCommit } from '../db/postgres.js';
const workers = new Set<() => void>();
export function subscribeMergeWorker(wake: () => void): () => void { workers.add(wake); return () => { workers.delete(wake); }; }
export function wakeMergeWorkers(): void { for (const wake of workers) queueMicrotask(wake); }
export function operationBinding(op: MergeOperationBinding): MergeOperationBinding {
  return { head_sha: op.head_sha, base_sha: op.base_sha, target_branch: op.target_branch, base_repository_full_name: op.base_repository_full_name,
    policy_revision: op.policy_revision, method: op.method };
}
export function sameBinding(a: MergeOperationBinding, b: MergeOperationBinding): boolean { return JSON.stringify(operationBinding(a)) === JSON.stringify(operationBinding(b)); }
export class MergeOperationRepo {
  constructor(private ctx: StoreContext) {}
  get(id: string): ScmMergeOperation | null {
    const row = this.ctx.db.query('SELECT operation FROM multiremi_scm_merge_operations WHERE id=?').get(id);
    return row ? JSON.parse(String(row.operation)) : null;
  }
  replay(project: string, cr: string, key: string, body: string): ScmMergeOperation | null {
    const row = this.ctx.db.query('SELECT o.operation,k.request_body FROM multiremi_scm_merge_request_keys k JOIN multiremi_scm_merge_operations o ON o.id=k.operation_id WHERE k.project_id=? AND k.change_request_id=? AND k.idempotency_key=?').get(project, cr, key);
    if (row && row.request_body !== body) throw new ScmOperationError('merge_idempotency_conflict', 'Idempotency key was used with a different request');
    return row ? JSON.parse(String(row.operation)) : null;
  }
  create(input: { project_id: string; change_request_id: string; workspace_id: string; actor: ScmActor; idempotency_key: string; expected_head_sha: string } & MergeOperationBinding, body: string): ScmMergeOperation {
    return this.ctx.db.transaction(() => {
      // Serialize across projects too: the unique index is the final cross-process guard.
      this.ctx.db.query('UPDATE multiremi_scm_change_requests SET id=id WHERE id=?').run(input.change_request_id);
      const replay = this.replay(input.project_id, input.change_request_id, input.idempotency_key, body);
      if (replay) return replay;
      const row = this.ctx.db.query("SELECT operation FROM multiremi_scm_merge_operations WHERE change_request_id=? AND state IN ('requested','awaiting_human','approved','executing','unknown')").get(input.change_request_id);
      if (row) {
        const existing: ScmMergeOperation = JSON.parse(String(row.operation));
        if (existing.project_id === input.project_id && existing.expected_head_sha === input.expected_head_sha && sameBinding(existing, input)) {
          this.recordKey(input, existing.id, body); return existing;
        }
        throw new ScmOperationError('merge_operation_in_progress', 'Another operation owns this PR');
      }
      const op: ScmMergeOperation = { ...input, id: createId('mop'), state: 'requested', version: 1, lease_until: null,
        approval_message_id: null, approved_binding: null, reasons: [], merge_commit_sha: null,
        credential_boundary: '平台入口受控、直推未封闭', created_at: nowIso(), updated_at: nowIso() };
      this.ctx.db.query('INSERT INTO multiremi_scm_merge_operations(id,project_id,change_request_id,idempotency_key,request_body,state,version,lease_until,operation) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(op.id, op.project_id, op.change_request_id, op.idempotency_key, body, op.state, op.version, null, JSON.stringify(op));
      this.recordKey(input, op.id, body);
      return op;
    })();
  }
  private recordKey(input: { project_id: string; change_request_id: string; idempotency_key: string }, id: string, body: string): void {
    this.ctx.db.query('INSERT INTO multiremi_scm_merge_request_keys(project_id,change_request_id,idempotency_key,operation_id,request_body) VALUES(?,?,?,?,?)')
      .run(input.project_id, input.change_request_id, input.idempotency_key, id, body);
  }
  update(op: ScmMergeOperation, changes: Partial<ScmMergeOperation>): ScmMergeOperation | null {
    const next = { ...op, ...changes, version: op.version + 1, updated_at: nowIso() };
    const result = this.ctx.db.query('UPDATE multiremi_scm_merge_operations SET state=?,version=?,lease_until=?,operation=? WHERE id=? AND version=?')
      .run(next.state, next.version, next.lease_until, JSON.stringify(next), op.id, op.version);
    return result.changes ? next : null;
  }
  recoverable(now = nowIso()): ScmMergeOperation[] {
    return this.ctx.db.query("SELECT operation FROM multiremi_scm_merge_operations WHERE state IN ('requested','approved','unknown') OR (state='executing' AND lease_until<=?)").all(now)
      .map(row => JSON.parse(String(row.operation)));
  }
  claim(op: ScmMergeOperation, now = Date.now()): ScmMergeOperation | null {
    if (!['requested','approved','unknown'].includes(op.state) && !(op.state === 'executing' && op.lease_until && Date.parse(op.lease_until) <= now)) return null;
    if (op.lease_until && Date.parse(op.lease_until) > now) return null;
    return this.update(op, { state: 'executing', lease_until: new Date(now + 120_000).toISOString() });
  }
  /** Runs under the Q row/workspace lock in the same transaction as its answer. */
  decide(id: string, questionId: string, approve: boolean): void {
    const op = this.get(id);
    if (!op || op.approval_message_id !== questionId) throw new ScmOperationError('merge_approval_conflict', 'Approval operation binding changed');
    if (approve && op.state === 'approved' || !approve && op.state === 'rejected') return;
    if (!['awaiting_human','approved'].includes(op.state)) throw new ScmOperationError('merge_approval_conflict', 'Worker claimed operation; approval cannot be revised');
    if (!this.update(op, { state: approve ? 'approved' : 'rejected', approved_binding: approve ? operationBinding(op) : null })) throw new ScmOperationError('merge_approval_conflict', 'Operation version changed');
    afterCommit(this.ctx.db, wakeMergeWorkers);
  }
  approvalMutable(id: string): boolean { const op = this.get(id); return !!op && ['awaiting_human','approved'].includes(op.state); }
}
