import { isDeepStrictEqual } from 'node:util';
import { runtimeConnectionSnapshot } from '@multiremi/contracts/runtime-connection.js';
import type { CreateTaskInput } from '@multiremi/contracts/types.js';
import { createId } from '@multiremi/ids.js';
import { agentDependencyDigest, planFrozenAgentDependencies, type AgentDependencyRef } from './agent-dependencies.js';
import { planVerifiedAttemptWrite } from './attempt-admission.js';
import { executionTrustNodeId } from './agent-source-approvals.js';
import type { SqlDatabase } from './db/postgres.js';
import type { CredentialProof, FinalExecution, VersionedRef } from './root-authority-contract.js';
import type { ApprovedExecutionInputs } from './root-management.js';
import { SecurityAbort } from './security-write.js';
import type { MultiremiStore } from './store.js';

export interface RootAttemptApproval {
  readonly messages: readonly VersionedRef[];
  readonly includeSubmittedPrompt?: boolean;
}

function reject(): never { throw new SecurityAbort('root_required'); }

function sources(db: SqlDatabase, store: MultiremiStore, agentId: string, runtimeId: string | null, attemptId: string) {
  const agent = store.getAgent(agentId) ?? reject();
  const rows = db.query(`SELECT x.*, d.grant_id,d.grant_generation,d.dependency_digest,d.trust_versions_json,c.approval_node_id,e.daemon_id
    FROM multiremi_current_agent_execution_sources x JOIN multiremi_current_agent_config_epochs c
      ON c.agent_id=x.agent_id AND c.workspace_id=x.workspace_id AND c.config_epoch=x.config_epoch
    JOIN multiremi_root_subject_state s ON s.subject_type='agent' AND s.subject_id=x.agent_id
    JOIN multiremi_root_grants g ON g.grant_id=s.active_grant_id AND g.generation=s.generation_counter
      AND g.subject_type=s.subject_type AND g.subject_id=s.subject_id AND g.revoked_at_ms IS NULL
    JOIN multiremi_agent_grant_dependencies d ON d.grant_id=g.grant_id AND d.grant_generation=g.generation
      AND d.agent_id=x.agent_id AND d.config_epoch=x.config_epoch AND d.invalidated_revision IS NULL
    JOIN multiremi_runtime_trusts t ON t.trust_id=x.trust_id AND t.generation=x.trust_generation
      AND t.runtime_id=x.runtime_id AND t.incarnation=x.incarnation AND t.revoked_at_ms IS NULL
    JOIN multiremi_machine_enrollments e ON e.runtime_id=t.runtime_id AND e.incarnation=t.incarnation AND e.retired_at_ms IS NULL
    WHERE x.agent_id=? AND x.workspace_id=? AND x.provider=? AND x.runtime_id=COALESCE(?,x.runtime_id)
      AND EXISTS(SELECT 1 FROM multiremi_security_state WHERE singleton=1 AND feature_activation=1)`)
    .all(agentId, agent.workspaceId, agent.provider, runtimeId);
  if (rows.length !== 1) reject();
  const row = rows[0];
  const trusts: VersionedRef[] = JSON.parse(row.trust_versions_json);
  if (!trusts.some(trust => trust.id === row.trust_id && trust.version === Number(row.trust_generation))) reject();
  const profile = runtimeConnectionSnapshot(store.getAgentExecutionProfile(row.runtime_id, agent), agent.model);
  if (agentDependencyDigest(profile) !== row.profile_digest) reject();
  const readRef = (json: string, kind: string, use: string): AgentDependencyRef => {
    const ref = JSON.parse(json);
    if (!ref || ref.kind !== kind || ref.use !== use || !ref.id || !Number.isSafeInteger(ref.version) || ref.version < 0 ||
        !db.query(`SELECT 1 FROM multiremi_current_agent_source_snapshots p JOIN multiremi_agent_grant_protected_refs f
          ON f.kind=p.kind AND f.resource_id=p.resource_id AND f.use_kind=p.use_kind AND f.resource_version=p.resource_version AND f.digest=p.digest
          WHERE p.agent_id=? AND p.workspace_id=? AND p.config_epoch=? AND p.kind=? AND p.resource_id=? AND p.use_kind=?
          AND p.resource_version=? AND p.digest=? AND f.grant_id=?`).get(agentId, agent.workspaceId, row.config_epoch, kind, ref.id, use, ref.version, ref.digest, row.grant_id)) reject();
    return ref;
  };
  const provider = readRef(row.provider_ref, 'provider-trust', 'execute');
  const checkpoint = readRef(row.checkpoint_policy_ref, 'checkpoint-policy', 'restore');
  const policy = readRef(row.input_policy_ref, 'input-policy', 'accept');
  const providerTrust = { id: executionTrustNodeId(row.grant_id,row.trust_id,provider), version: Number(row.grant_generation) };
  if (policy.version < 1 || !db.query(`SELECT 1 FROM multiremi_authority_nodes WHERE node_id=? AND generation=? AND kind='provider_trust'
    AND subject_type='agent' AND subject_id=? AND scope='system' AND revoked_at_ms IS NULL AND expires_at_ms>?`)
    .get(providerTrust.id, providerTrust.version, agentId, Date.now())) reject();
  const execution: FinalExecution = { attemptId, runtimeId: row.runtime_id, daemonId: row.daemon_id, incarnation: row.incarnation,
    configEpoch: Number(row.config_epoch), providerTrust, checkpointTrust: null,
    executionDigest: agentDependencyDigest({ agentId, grant: row.grant_id, frozen: row.dependency_digest, epochNode: row.approval_node_id,
      runtime: row.runtime_id, trust: row.trust_id, profile: row.profile_digest, provider, checkpoint, policy }) };
  const scope = planFrozenAgentDependencies(db, row.grant_id, Number(row.grant_generation), agentId);
  return { execution, sourcePolicy: { id: policy.id, version: policy.version }, scope, provider: agent.provider };
}

type Target = Parameters<typeof planVerifiedAttemptWrite>[2];

function writeAttempt<T>(db: SqlDatabase, store: MultiremiStore, proof: CredentialProof, target: Target, runtime: string | null,
  approval: RootAttemptApproval, submitted: string | null, existingTrigger: string | null, operation: (runtime: string) => T): T {
  const planned = sources(db, store, target.agentId, runtime, target.attemptId);
  const allowed = new Map(approval.messages.map(source => [source.id, source.version]));
  if (allowed.size !== approval.messages.length || (approval.includeSubmittedPrompt && submitted === null)) reject();
  const { plan, write } = planVerifiedAttemptWrite(store.rootManagement, proof, target, planned.execution, (_tx, attempt) => {
    const live = sources(db, store, target.agentId, runtime, target.attemptId);
    if (!isDeepStrictEqual(live, planned) || attempt.runtime_id !== live.execution.runtimeId ||
        (attempt.provider != null && attempt.provider !== live.provider) ||
        ['session_id','execution_fingerprint','work_dir','codex_profile','claude_profile','execution_connection','execution_model',
          'execution_thinking_level','switch_reason','next_retry_at'].some(key => attempt[key] != null) ||
        Number(attempt.fallback_switched ?? 0) || Number(attempt.projection_degrade_level ?? 0) ||
        !isDeepStrictEqual(JSON.parse(String(attempt.plugin_snapshot ?? '[]')), []) ||
        ['input_ack_seq','input_read_seq','input_read_offset','input_trigger_ack'].some(key => Number(attempt[key] ?? 0) !== 0)) reject();
    const turn = db.query('SELECT * FROM multiremi_turns WHERE id=? AND agent_id=?').get(target.turnId, target.agentId) ?? reject();
    if (turn.continued_from_turn_id || db.query('SELECT 1 FROM multiremi_planned_restarts WHERE turn_id=? AND checkpoint IS NOT NULL').get(turn.id) ||
        db.query(`SELECT 1 FROM multiremi_session_lanes WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=?
          AND provider_session_id IS NOT NULL`).get(turn.session_id, turn.agent_id, turn.execution_scope)) reject();
    const stored = Boolean(db.query('SELECT id FROM multiremi_turn_attempts WHERE id=?').get(target.attemptId));
    if (stored && !turn.trigger_message_id) reject();
    const rows = db.query(`SELECT m.*, w.user_id, a.id AS current_agent FROM multiremi_conversation_log m
      LEFT JOIN multiremi_workspace_members w ON m.sender_type='member' AND w.id=m.sender_id AND w.workspace_id=? AND w.archived_at IS NULL
      LEFT JOIN multiremi_agents a ON m.sender_type='agent' AND a.id=m.sender_id AND a.workspace_id=? AND a.archived_at IS NULL
      WHERE m.session_id=? AND m.kind='message' AND m.visibility='shown' AND m.deleted_at IS NULL ORDER BY m.seq
      ${db.dialect === 'postgres' ? 'FOR UPDATE OF m' : ''}`)
      .all(turn.workspace_id, turn.workspace_id, turn.session_id);
    const trigger = turn.trigger_message_id ?? turn.trigger_comment_id ?? (target.previousAttemptId === null ? rows.at(-1)?.id : null);
    if (!trigger || !rows.some(message => message.id === trigger && message.body_md === turn.legacy_prompt)) reject();
    const entries: ApprovedExecutionInputs['entries'] = rows.map(message => {
      const author = message.current_agent ? { type: 'agent' as const, id: message.current_agent } :
        message.user_id ? { type: 'user' as const, id: message.user_id } : reject();
      const initialTrigger = target.previousAttemptId === null && message.id === trigger;
      const newPrompt = initialTrigger && approval.includeSubmittedPrompt && message.sender_type === 'member' && message.body_md === submitted && !allowed.has(trigger);
      const meta = JSON.parse(message.metadata);
      if (!['request','reply','report','status','final'].includes(message.message_kind) || message.options ||
          !meta || Object.keys(meta).some(key => !['execution_scope','delivery_turn_id','pending_completion'].includes(key)) ||
          db.query('SELECT 1 FROM multiremi_attachments WHERE comment_id=? OR chat_message_id=?').get(message.id, message.id)) reject();
      const linked = stored && turn.trigger_message_id != null;
      if (initialTrigger && linked && (meta.delivery_turn_id !== turn.id || turn.trigger_message_id !== trigger)) reject();
      const revision = Number(message.revision);
      const reviewedVersion = revision - Number(initialTrigger && linked) - Number(initialTrigger && message.id === existingTrigger);
      if (!Number.isSafeInteger(revision) || revision < 1 || (!newPrompt && allowed.get(message.id) !== reviewedVersion)) reject();
      return { source: { id: message.id, version: revision + (initialTrigger && !linked ? 1 : 0) }, snapshot: message.body_md,
        purpose: message.message_kind === 'request' ? 'instruction' : 'business_data', author };
    });
    if (entries.length !== allowed.size + (approval.includeSubmittedPrompt ? 1 : 0)) reject();
    const inputs: ApprovedExecutionInputs = { manifest: { id: target.attemptId, version: 1 }, sourcePolicy: live.sourcePolicy, entries,
      providerState: { sessionId: null, securityDomainId: agentDependencyDigest([turn.workspace_id, turn.agent_id, live.execution.executionDigest]), checkpointDigest: null } };
    return { execution: live.execution, inputs };
  });
  const domainTargets = [...new Set([...plan.domainTargets, ...planned.scope.domainTargets])].sort();
  const workspaceIds = [...new Set([...plan.workspaceIds, ...planned.scope.workspaceIds])].sort();
  return store.withAttemptAdmission(plan.fenceTerm, { ...plan, workspaceIds, domainTargets }, write, () => operation(planned.execution.runtimeId));
}

export function createRootAttempt(db: SqlDatabase, store: MultiremiStore, input: CreateTaskInput, proof: CredentialProof, approval: RootAttemptApproval) {
  const agent = store.getAgent(input.agentId) ?? reject();
  const sessionId = input.conversationSessionId ?? input.issueSessionId ?? input.issue_session_id ?? input.chatSessionId ??
    (input.issueId && db.query(`SELECT id FROM multiremi_issue_sessions WHERE issue_id=? AND workspace_id=?
      AND chat_id IS NULL AND is_default=1 AND status='active'`).get(input.issueId, agent.workspaceId)?.id);
  if (!sessionId || input.parentTaskId || input.parent_task_id || (approval.includeSubmittedPrompt && (input.triggerCommentId || input.trigger_comment_id))) reject();
  const attemptId = input.id ?? createId('tsk');
  return writeAttempt(db, store, proof, { turnId: attemptId, attemptId, previousAttemptId: null, agentId: agent.id, workspaceId: agent.workspaceId, sessionId },
    input.runtimeId ?? input.runtime_id ?? agent.runtimeId, approval, input.prompt, input.triggerCommentId ?? input.trigger_comment_id ?? null,
    runtimeId => store.createTask({ ...input, id: attemptId, runtimeId }));
}

export function retryRootAttempt(db: SqlDatabase, store: MultiremiStore, turnId: string, previousAttemptId: string, proof: CredentialProof,
  approval: RootAttemptApproval, cold: boolean, authorizeConversation?: (sessionId: string) => void) {
  const turn = store.getTurn(turnId) ?? reject();
  const previous = db.query('SELECT runtime_id FROM multiremi_turn_attempts WHERE id=? AND turn_id=?').get(previousAttemptId, turnId);
  if (turn.current_attempt_id !== previousAttemptId || !previous?.runtime_id) reject();
  return writeAttempt(db, store, proof, { turnId, previousAttemptId, attemptId: createId('tsk'), agentId: turn.agent_id }, previous.runtime_id,
    approval, null, null, () => store.retryTurnAsMember(turnId, cold, authorizeConversation));
}
