import { QuestionError } from "@multiremi/store/inbox/questions.js";
import type { MultiremiStore } from '@multiremi/store/store.js';
import type { ScmActor } from '@multiremi/contracts/merge-policy.js';
import type { MergeMethod, ScmMergeOperation } from '@multiremi/contracts/merge-operation.js';
import { sameBinding, subscribeMergeWorker } from '@multiremi/store/repos/merge-operation-repo.js';
import { GitHubScmOperations, ScmOperationError } from './operations.js';
import { ScmHttpError } from './http.js';
import { pullIdentity } from './merge-gate.js';
import { readLiveMergeGate } from './live-merge-gate.js';
import { reconcileObservation } from './reconcile.js';
import { scmIngestionStore } from './store.js';

export function validateMergeRequest(body: unknown): { expected_head_sha: string; method: MergeMethod; idempotency_key: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ScmOperationError('scm_invalid_input', 'Merge body must be an object');
  const row = body as Record<string, unknown>;
  if (Object.keys(row).some(k => !['expected_head_sha','method','idempotency_key'].includes(k)) || typeof row.expected_head_sha !== 'string'
    || !/^[a-f0-9]{40}$/.test(row.expected_head_sha) || !['merge','squash','rebase'].includes(String(row.method))
    || typeof row.idempotency_key !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(row.idempotency_key)) throw new ScmOperationError('scm_invalid_input', 'Expected head SHA, merge method and idempotency key are required; unknown fields are forbidden');
  return row as ReturnType<typeof validateMergeRequest>;
}
export class MergeExecutionService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private running: Promise<void> | null = null;
  constructor(private store: MultiremiStore) {}
  start(): void {
    if (this.timer) return;
    this.unsubscribe = subscribeMergeWorker(() => { void this.runOnce().catch(() => {}); });
    this.timer = setInterval(() => { void this.runOnce().catch(() => {}); }, 15_000); this.timer.unref?.();
    void this.runOnce().catch(() => {});
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.unsubscribe?.(); this.unsubscribe = null; }
  runOnce(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => { for (const op of this.store.mergeOperations.recoverable()) { try { await this.process(op.id); } catch { /* durable operation is retried by recovery */ } } })().finally(() => { this.running = null; });
    return this.running;
  }
  private live(crId: string) {
    const cr = this.store.getScmChangeRequest(crId);
    if (!cr) throw new ScmOperationError('scm_binding_unavailable', 'Change request unavailable');
    const binding = this.store.listScmRepositoryBindings({ workspaceId: cr.workspaceId, enabled: true }).find(b => b.connectionId === cr.connectionId && b.repositoryId === cr.repositoryId);
    const connection = this.store.getScmConnection(cr.connectionId), credential = this.store.getScmConnectionCredential(cr.connectionId);
    if (!binding || !connection?.enabled || !credential) throw new ScmOperationError('scm_binding_unavailable', 'SCM connection unavailable');
    // B2 uses the existing connection credential. C switches this to server-merger.
    return { cr, binding, op: new GitHubScmOperations({ binding, connection, credential }) };
  }
  async request(projectId: string, crId: string, actor: ScmActor, body: unknown): Promise<ScmMergeOperation> {
    const input = validateMergeRequest(body), serialized = JSON.stringify({ expected_head_sha: input.expected_head_sha, method: input.method, idempotency_key: input.idempotency_key });
    const replay = this.store.mergeOperations.replay(projectId, crId, input.idempotency_key, serialized);
    if (replay) return replay;
    const policy = this.store.mergePolicies.get(projectId);
    if (!policy.enabled) throw new ScmOperationError('merge_policy_disabled', 'Project merge policy is disabled');
    if (!policy.allowed_merge_methods.includes(input.method)) throw new ScmOperationError('merge_method_not_allowed', 'Method is outside allowed_merge_methods');
    const { cr, op } = this.live(crId);
    const observation = await op.get(cr.number!);
    const identity = pullIdentity(observation.payload);
    if (!identity || observation.externalId !== cr.externalId) throw new ScmOperationError('scm_evidence_mismatch', 'PR identity unavailable');
    const operation = this.store.mergeOperations.create({ ...input, ...identity, policy_revision: policy.revision, project_id: projectId, change_request_id: crId, workspace_id: cr.workspaceId, actor }, serialized);
    if (operation.state !== 'requested') return operation;
    return this.process(operation.id);
  }
  private approvalRoute(op: ScmMergeOperation): { sessionId: string; issueId: string | null } | null {
    if (op.actor.kind === 'agent') {
      const task = op.actor.turn_id ? this.store.getTask(op.actor.turn_id) : null;
      if (!task || task.agentId !== op.actor.id || task.workspaceId !== op.workspace_id) return null;
      const turn = this.store.getTurnForAttempt(task.id);
      if (!turn || turn.agent_id !== op.actor.id || turn.workspace_id !== op.workspace_id) return null;
      const scoped = this.store.getIssueSessionWithOwnerScope(turn.session_id);
      if (scoped) {
        if (scoped.ownerWorkspaceId !== op.workspace_id || scoped.session.workspaceId !== op.workspace_id) return null;
        return { sessionId: scoped.session.id, issueId: scoped.session.chatId ? null : scoped.session.issueId };
      }
      const chat = this.store.getChatSession(turn.session_id);
      return chat?.workspaceId === op.workspace_id ? { sessionId: chat.id, issueId: null } : null;
    }
    const issueId = this.store.mergePolicies.approvalIssue(op.project_id, op.change_request_id);
    const issue = issueId ? this.store.getIssue(issueId) : null;
    if (issue?.workspaceId === op.workspace_id) return { sessionId: this.store.getOrCreateDefaultIssueSession(issue.id).id, issueId: issue.id };
    return null;
  }
  async process(id: string): Promise<ScmMergeOperation> {
    const previous = this.store.mergeOperations.get(id);
    if (!previous) throw new ScmOperationError('merge_operation_not_found', 'Operation not found');
    const claimed = this.store.mergeOperations.claim(previous);
    if (!claimed) return this.store.mergeOperations.get(id)!;
    let current = claimed;
    const save = (changes: Partial<ScmMergeOperation>) => {
      const next = this.store.mergeOperations.update(current, changes);
      if (!next) throw new ScmOperationError('merge_operation_conflict', 'Execution lease/version changed');
      current = next; return next;
    };
    const blocked = (code: string, message: string) => save({ state: 'blocked', lease_until: null, reasons: [{ code, message }] });
    // Once a PUT may have started, a crash/timeout is reconciled by GET only.
    if (previous.state === 'unknown' || previous.state === 'executing') {
      try {
        const { cr, binding, op } = this.live(current.change_request_id);
        const observed = await op.get(cr.number!);
        if (observed.externalId === cr.externalId && observed.payload.state === 'merged' && observed.payload.head_sha === current.expected_head_sha
          && typeof observed.payload.merge_sha === 'string' && observed.payload.merge_sha) {
          reconcileObservation({ store: scmIngestionStore(this.store), binding, observation: observed, baseline: false });
          return save({ state: 'merged', lease_until: null, merge_commit_sha: observed.payload.merge_sha, reasons: [] });
        }
        if (observed.externalId === cr.externalId && observed.payload.state === 'open') return save({ state: 'failed', lease_until: null, reasons: [{ code: 'merge_not_applied', message: 'Recovery confirmed PR is still open; no PUT retry' }] });
        return save({ state: 'unknown', lease_until: new Date(Date.now() + 120_000).toISOString(), reasons: [{ code: 'merge_outcome_unknown', message: 'Provider state cannot establish outcome; requires investigation' }] });
      } catch { return save({ state: 'unknown', lease_until: new Date(Date.now() + 120_000).toISOString(), reasons: [{ code: 'merge_outcome_unknown', message: 'Cannot read provider state; no PUT retry' }] }); }
    }
    let sent = false;
    try {
      const { cr, binding, op } = this.live(current.change_request_id);
      const policy = this.store.mergePolicies.get(current.project_id);
      const live = await readLiveMergeGate(this.store, current.project_id, cr, op, policy, identity => !!current.approved_binding && sameBinding(current.approved_binding, { ...identity, method: current.method, policy_revision: policy.revision }));
      const bindingNow = { ...live.identity, method: current.method, policy_revision: policy.revision };
      const stale = !sameBinding(current, bindingNow) || current.expected_head_sha !== live.identity.head_sha;
      if (current.approval_message_id && (stale || !current.approved_binding || !sameBinding(current.approved_binding, bindingNow))) {
        this.store.invalidateMergeApproval(current.approval_message_id, 'approval_stale', current);
        return this.store.mergeOperations.get(id)!;
      }
      if (stale) return blocked('pull_request_changed', 'PR or policy changed since request');
      if (!policy.allowed_merge_methods.includes(current.method)) return blocked('merge_method_not_allowed', 'Merge method is no longer allowed');
      if (!this.store.mergePolicies.belongsToProject(current.project_id, cr.id)) return blocked('cr_project_changed', 'CR is no longer linked to project');
      // Reuse exactly the B1 evaluator. An approval removes only its own reason.
      const reasons = [...live.gate.reasons];
      if (live.observation.payload.mergeable !== true) reasons.push({ code: live.observation.payload.mergeable == null ? 'mergeability_unknown' : 'pull_request_not_mergeable', message: 'Provider has not confirmed mergeability' });
      const nonHuman = reasons.filter(r => r.code !== 'human_approval_required');
      if (nonHuman.length) return save({ state: 'blocked', lease_until: null, reasons });
      if (reasons.length) {
        const route = this.approvalRoute(current);
        if (!route) return blocked('merge_approval_unroutable', 'Cannot locate originating session or linked Issue Main');
        this.store.createMergeApproval({ operation: current, ...route, body: `Platform merge approval\nRepository: ${current.base_repository_full_name}\nPR: #${cr.number}\nOperation: ${current.id}\nHead: ${current.head_sha}\nBase: ${current.base_sha}\nTarget: ${current.target_branch}\nMethod: ${current.method}\nPolicy revision: ${current.policy_revision}\nGate: all non-human conditions passed. Approval unlocks only this operation; worker revalidates before merging.\n${current.credential_boundary}` });
        return this.store.mergeOperations.get(id)!;
      }
      // Persist a final CAS immediately before I/O, outside all DB transactions.
      // If another worker recovered this lease while evidence was loading, it wins.
      if (this.store.mergePolicies.get(current.project_id).revision !== current.policy_revision) return blocked('policy_changed', 'Policy changed before execution');
      save({ lease_until: new Date(Date.now() + 120_000).toISOString() });
      sent = true;
      const result = await op.merge(cr.number!, { headSha: current.expected_head_sha, method: current.method });
      if (!result.merged || !result.sha) return save({ state: 'unknown', lease_until: null, reasons: [{ code: 'merge_outcome_unknown', message: 'Provider returned no definitive merge result; recover by reading PR' }] });
      // Use the same canonical change.merged ID/path as webhook/poll, never a second activity writer.
      const observed = await op.get(cr.number!);
      if (observed.externalId !== cr.externalId || observed.payload.state !== 'merged' || observed.payload.head_sha !== current.expected_head_sha || observed.payload.merge_sha !== result.sha)
        return save({ state: 'unknown', lease_until: null, reasons: [{ code: 'merge_outcome_unknown', message: 'Merge response could not be corroborated by live PR' }] });
      reconcileObservation({ store: scmIngestionStore(this.store), binding, observation: observed, baseline: false });
      return save({ state: 'merged', lease_until: null, merge_commit_sha: result.sha, reasons: [] });
    } catch (error) {
      if (!sent && error instanceof QuestionError && error.code === 'merge_approval_unroutable') return blocked(error.code, error.message);
      const definitive = sent && error instanceof ScmHttpError && [405,409].includes(error.status);
      return save({ state: sent ? definitive ? 'failed' : 'unknown' : 'blocked', lease_until: null,
        reasons: [{ code: definitive ? 'provider_merge_rejected' : sent ? 'merge_outcome_unknown' : 'scm_evidence_unavailable', message: definitive ? `GitHub rejected merge (${error.status}): ${error.responseBody}` : error instanceof ScmOperationError ? error.message : 'SCM call failed; uncertain writes are recovered by GET only' }] });
    }
  }
}
