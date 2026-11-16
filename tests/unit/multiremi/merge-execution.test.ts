import { afterEach, describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import { createMultiremiApp } from '@multiremi/api.js';
import { MergeExecutionService } from '@multiremi/scm/merge-execution.js';
import { defaultMergePolicy } from '@multiremi/scm/merge-policy.js';
import { ScmWebhookIngestor } from '@multiremi/scm/webhook.js';
import { scmIngestionStore } from '@multiremi/scm/store.js';
import { createStore, createResponsibleTestIssue, resetMultiremiTestEnv } from './helpers.js';
import type { SqlDatabase } from '@multiremi/store/db/postgres.js';
const originalFetch = globalThis.fetch, originalKey = process.env.MULTIREMI_SCM_ENCRYPTION_KEY;
const head = 'a'.repeat(40), base = 'b'.repeat(40), mergeSha = 'c'.repeat(40);
const headers = { Authorization: 'Bearer merge-test', 'Content-Type': 'application/json' };
afterEach(() => { globalThis.fetch = originalFetch; if (originalKey === undefined) delete process.env.MULTIREMI_SCM_ENCRYPTION_KEY; else process.env.MULTIREMI_SCM_ENCRYPTION_KEY = originalKey; resetMultiremiTestEnv(); });
async function fixture(options: { human?: boolean; chat?: boolean; delegated?: boolean; omitReview?: boolean; strict?: boolean; disabled?: boolean } = {}) {
  process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
  const store = createStore(); store.ensureLocalWorkspace();
  store.updateWorkspace('local', { settings: { scm_complete_issue_on_merge_enabled: true }, repos: [{ id: 'repo_merge', name: 'widgets', url: 'https://github.com/acme/widgets.git', defaultBranch: 'main' }] });
  store.createScmConnection({ id: 'scm_merge', workspaceId: 'local', name: 'GitHub', provider: 'github', mode: 'hybrid', accessToken: 'provider-secret', webhookSecret: 'hook-secret', repositoryIds: ['repo_merge'] });
  const project = store.createProject({ title: 'Merge execution' });
  store.createProjectResource(project.id, { resourceType: 'github_repo', resourceRef: { url: 'https://github.com/acme/widgets.git' } });
  const issue = createResponsibleTestIssue(store, { title: 'Merge', projectId: project.id, workspaceId: 'local', createdBy: 'local' });
  const agent = store.createAgent({ name: 'Author', provider: 'codex', workspaceId: 'local', ...(options.delegated ? { maxConcurrentTasks: 4 } : {}) });
  const runtime = store.registerRuntime({ name: 'Merge runtime', provider: 'codex', daemonId: 'merge-runtime', ...(options.delegated ? { maxConcurrency: 4 } : {}) });
  const chat = options.chat ? store.createChatSession({ agentId: agent.id, creatorId: 'local', title: 'Chat merge' }) : null;
  const delegator = options.delegated ? store.createAgent({ name: 'Delegator', provider: 'codex', workspaceId: 'local' }) : null;
  const task = store.createTask({ ...(delegator ? { delegatedByAgentId: delegator.id, delegationId: 'dlg_merge_approval' } : {}), agentId: agent.id, ...(chat ? { chatSessionId: chat.id } : { issueId: issue.id }), workspaceId: 'local', prompt: 'Merge request' });
  expect(store.claimTask(runtime.id)?.id).toBe(task.id); store.startTask(task.id);
  const token = await store.createTaskAccessToken(task, 'local');
  const taskHeaders = { ...headers, Authorization: `Bearer ${token.token}` };
  const app = createMultiremiApp({ store, authToken: 'merge-test', backgroundJobs: false, inspectGitRemoteRepository: async () => ({ default_branch: 'main', branches: ['main'] }) });
  const state = { head, base, target: 'main', baseRepo: 'acme/widgets', conclusion: 'success', merged: false, mergeable: true as boolean | null, puts: [] as unknown[], mode: 'ok', readsFail: false, rulesFail: false };
  let mergeBarrier: Promise<void> | null = null, entered: (() => void) | null = null;
  const pauseMerge = () => {
    let release!: () => void;
    mergeBarrier = new Promise<void>(r => { release = r; });
    const waitEntered = new Promise<void>(r => { entered = r; });
    return { release, waitEntered };
  };
  const pull = () => ({ id: 9001, number: 42, title: 'PR', draft: false, state: state.merged ? 'closed' : 'open', merged: state.merged, mergeable: state.mergeable,
    head: { ref: 'feature', sha: state.head, repo: { full_name: 'acme/widgets' } }, base: { ref: state.target, sha: state.base, repo: { full_name: state.baseRepo } },
    merge_commit_sha: state.merged ? mergeSha : null, merged_at: state.merged ? '2026-11-16T02:00:00Z' : null, updated_at: state.merged ? '2026-11-16T02:00:00Z' : '2026-11-16T01:00:00Z' });
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === 'PUT' && url.pathname.endsWith('/merge')) {
      state.puts.push(JSON.parse(String(init.body)));
      entered?.(); if (mergeBarrier) await mergeBarrier;
      if (state.mode === 'timeout') throw new DOMException('timed out', 'TimeoutError');
      if (state.mode === 'timeout-merged') { state.merged = true; throw new DOMException('timed out', 'TimeoutError'); }
      if (state.mode === '409' || state.mode === '405') return Response.json({ message: 'Not mergeable' }, { status: Number(state.mode) });
      if (state.mode === 'ambiguous') return Response.json({ merged: false });
      state.merged = true; return Response.json({ merged: true, sha: mergeSha });
    }
    if (state.readsFail) throw new Error('Provider read unavailable');
    if (url.pathname.includes('/pulls') && init?.method === 'POST') return Response.json(pull());
    if (url.pathname.includes('/pulls/42')) return Response.json(pull());
    if (url.pathname.includes('/rules/branches/')) return state.rulesFail ? Response.json({}, { status: 403 }) : Response.json([]);
    if (url.pathname.includes('/branches/')) return Response.json({ name: state.target, protected: false });
    if (url.pathname.includes('/check-runs')) return Response.json({ check_runs: [] });
    if (url.pathname.includes('/statuses')) return Response.json([{ id: 1, context: 'ci', state: state.conclusion, created_at: '2026-11-16T01:00:00Z' }]);
    if (url.pathname.includes('/actions/runs')) return Response.json({ workflow_runs: [] });
    return Response.json([]);
  }, { preconnect: originalFetch.preconnect });
  const active = '/api/workspaces/local/scm/repositories/repo_merge/change-requests';
  const created = await app.request(active, { method: 'POST', headers: taskHeaders, body: JSON.stringify({ head: 'feature', base: 'main', title: 'PR' }) });
  expect(created.status, await created.text()).toBe(201);
  const cr = store.mergePolicies.findChangeRequest('scm_merge', 'repo_merge', '9001')!;
  store.linkScmChangeRequestToIssue(issue.id, cr.id);
  const { revision: _, ...fields } = defaultMergePolicy();
  const policy = { ...fields, enabled: !options.disabled, target_branches: ['main','release'], allowed_merge_methods: ['squash','merge'], required_checks: [{ kind: 'commit_status', context: 'ci' }], require_independent_review: true,
    independent_reviewers: [agent.id], require_human_approval: !!options.human, credential_enforcement_mode: options.strict ? 'strict' : 'platform_only', expected_revision: 0 };
  const policyRoot = `/api/projects/${project.id}/merge-policy`;
  expect((await app.request(policyRoot, { method: 'PUT', headers, body: JSON.stringify(policy) })).status).toBe(200);
  const root = `/api/projects/${project.id}/change-requests/${cr.id}`;
  const submit = async () => app.request(`${root}/reviews`, { method: 'POST', headers, body: JSON.stringify({ schema_version: 1, head_sha: state.head, base_sha: state.base, verdict: 'pass', summary: 'Member inspected revision', findings: [], evidence: ['test evidence'] }) });
  if (!options.omitReview) expect((await submit()).status).toBe(201);
  const service = new MergeExecutionService(store);
  const request = async (key = 'key1', overrides = {}, h = taskHeaders) => app.request(`${root}/merge`, { method: 'POST', headers: h, body: JSON.stringify({ expected_head_sha: head, method: 'squash', idempotency_key: key, ...overrides }) });
  const answer = async (id: string, choice = 'approve', h = headers, extra = {}) => app.request(`/api/messages/${id}/question/answer`, { method: 'POST', headers: h, body: JSON.stringify({ expected_route_revision: 1, response: { selected_options: [choice] }, ...extra }) });
  return { store, app, state, pull, pauseMerge, request, answer, service, root, cr, project, issue, agent, runtime, task, chat, taskHeaders, submit, policyRoot, policy };
}
async function operation(response: Response) { return (await response.json()).operation; }
function expire(f: Awaited<ReturnType<typeof fixture>>, id: string) { const op = f.store.mergeOperations.get(id)!; return f.store.mergeOperations.update(op, { lease_until: '2000-01-01T00:00:00Z' })!; }

describe('B2 policy-gated merge execution (real SQLite/HTTP, mock GitHub)', () => {
  it('rejects disabled policy, forbidden fields/methods and daemon without merging', async () => {
    const f = await fixture({ disabled: true });
    const result = await f.request(); expect(result.status).toBe(409); expect(await result.json()).toMatchObject({ code: 'merge_policy_disabled' });
    for (const field of ['actor','reviewer','force','skip']) expect((await f.request('key2', { [field]: true })).status).toBe(400);
    const daemon = await f.store.createAccessToken({ type: 'daemon', name: 'daemon', workspaceId: 'local', daemonId: 'merge-test' });
    expect((await f.request('daemon', {}, { ...headers, Authorization: `Bearer ${daemon.token}` })).status).toBe(403);
    expect(f.state.puts).toEqual([]);
  });
  for (const condition of ['checks','review','strict','rules','mergeability','method'] as const) it(`blocks ${condition}, no PUT or question`, async () => {
    const f = await fixture({ human: true, strict: condition === 'strict', omitReview: condition === 'review' });
    if (condition === 'checks') f.state.conclusion = 'failure';
    if (condition === 'rules') f.state.rulesFail = true;
    if (condition === 'mergeability') f.state.mergeable = null;
    const result = await f.request('blocked', condition === 'method' ? { method: 'rebase' } : {});
    // Default policy permits squash/merge, never rebase.
    if (condition === 'method') { expect(result.status).toBe(400); }
    else { expect(result.status).toBe(409); const op = await operation(result); expect(op.state).toBe('blocked'); expect(op.approval_message_id).toBeNull(); }
    expect(f.state.puts).toEqual([]);
  });
  it('merges exactly once with sha; same key and concurrent different keys replay the operation', async () => {
    const f = await fixture();
    const barrier = f.pauseMerge();
    const first = f.request('one'); await barrier.waitEntered;
    const second = await f.request('two'); barrier.release();
    const ops = await Promise.all([operation(await first), operation(second)]); expect(ops[0].id).toBe(ops[1].id);
    expect(f.state.puts).toEqual([{ sha: head, merge_method: 'squash' }]);
    expect((await operation(await f.request('one'))).id).toBe(ops[0].id);
    expect((await operation(await f.request('two'))).id).toBe(ops[0].id);
    expect((await f.request('one', { method: 'merge' })).status).toBe(409);
    expect((await f.app.request(`/api/scm/merge-operations/${ops[0].id}`, { headers })).status).toBe(200);
    // Canonical merge ingestion + a real HMAC webhook replay produces one activity and no done.
    const body = JSON.stringify({ action: 'closed', repository: { id: 1, name: 'widgets', full_name: 'acme/widgets', owner: { login: 'acme' } }, pull_request: f.pull() });
    const signature = `sha256=${createHmac('sha256','hook-secret').update(body).digest('hex')}`;
    for (let i = 0; i < 2; i++) new ScmWebhookIngestor(scmIngestionStore(f.store)).ingest({ body: JSON.parse(body), connectionId: 'scm_merge', headers: { 'x-github-event': 'pull_request', 'x-github-delivery': `merge-${i}`, 'x-hub-signature-256': signature }, rawBody: body });
    f.store.dispatchPendingScmEvents();
    expect(f.store.listIssueActivity(f.issue.id).filter(a => a.type === 'scm_merge_completed')).toHaveLength(1);
    expect(f.store.listScmCanonicalEvents({ workspaceId: 'local', type: 'change.merged' })).toHaveLength(1);
    expect(f.store.getIssue(f.issue.id)?.status).not.toBe('done');
  });
  for (const mode of ['405','409'] as const) it(`records definitive GitHub ${mode} failure`, async () => { const f = await fixture(); f.state.mode = mode; const op = await operation(await f.request()); expect(op.state).toBe('failed'); expect(op.reasons[0].code).toBe('provider_merge_rejected'); expect(f.state.puts).toHaveLength(1); });
  for (const outcome of ['open','merged','unreadable','closed'] as const) it(`timeout recovery: ${outcome}, never resends PUT`, async () => {
    const f = await fixture(); f.state.mode = outcome === 'merged' ? 'timeout-merged' : 'timeout';
    const op = await operation(await f.request()); expect(op.state).toBe('unknown');
    if (outcome === 'unreadable') f.state.readsFail = true;
    if (outcome === 'closed') { f.state.merged = true; f.state.head = 'd'.repeat(40); }
    await f.service.runOnce();
    expect(f.store.mergeOperations.get(op.id)?.state).toBe(outcome === 'merged' ? 'merged' : outcome === 'open' ? 'failed' : 'unknown');
    await f.service.runOnce(); expect(f.state.puts).toHaveLength(1);
  });
  it('human Q is visible in Inbox; Agent cannot answer/close/revise, member approves, worker revalidates', async () => {
    const f = await fixture({ human: true });
    const response = await f.request(); expect(response.status).toBe(202); const op = await operation(response), q = op.approval_message_id;
    expect(f.store.getQuestion(q)).toMatchObject({ origin: 'platform_merge_approval', stage: 'human', wait_status: 'none', source_issue_id: f.issue.id });
    const inbox = await f.app.request('/api/inbox?workspace_id=local', { headers }); expect(inbox.status).toBe(200); expect(JSON.stringify(await inbox.json())).toContain(q);
    expect((await f.answer(q, 'approve', f.taskHeaders)).status).toBe(403);
    expect((await f.app.request(`/api/messages/${q}/question/close`, { method: 'POST', headers: f.taskHeaders, body: JSON.stringify({ expected_route_revision: 1, reason: 'close' }) })).status).toBe(403);
    expect((await f.answer(q, 'reject', f.taskHeaders, { revise: true, reason: 'revise', expected_answer_revision: 1 })).status).toBe(403);
    expect((await f.app.request(`/api/messages/${q}/question/escalate`, { method: 'POST', headers: f.taskHeaders, body: JSON.stringify({ expected_route_revision: 1, reason: 'up' }) })).status).toBe(409);
    expect((await f.app.request(`/api/messages/${q}/question/present`, { method: 'POST', headers: f.taskHeaders, body: JSON.stringify({ expected_route_revision: 1, summary: 'Gate evidence inspected' }) })).status).toBe(200);
    expect(f.state.puts).toHaveLength(0);
    expect((await f.answer(q)).status).toBe(200); expect((await f.answer(q)).status).toBe(200);
    await f.service.runOnce(); expect(f.state.puts).toHaveLength(1); expect(f.store.mergeOperations.get(op.id)?.state).toBe('merged');
    expect((await f.answer(q)).status).toBe(200); await f.service.runOnce(); expect(f.state.puts).toHaveLength(1);
    expect((await f.answer(q, 'reject', headers, { revise: true, reason: 'changed', expected_answer_revision: 1 })).status).toBe(409);
  });
  it('keeps delegated approval on the originating scope and excludes other lanes of the same Agent', async () => {
    const f = await fixture({ human: true, delegated: true });
    const turn = f.store.getTurnForAttempt(f.task.id)!;
    expect(turn.execution_scope).toBe('dlg_merge_approval');
    const response = await f.request(); expect(response.status).toBe(202);
    const op = await operation(response), q = op.approval_message_id;
    expect(op.state).toBe('awaiting_human');
    expect(f.store.getMessage(q)?.metadata.execution_scope).toBe(turn.execution_scope);
    expect(f.store.getQuestion(q)).toMatchObject({ stage: 'human', wait_status: 'none', source_attempt_id: null });
    expect((await f.app.request(`/api/messages/${q}/question`, { headers: f.taskHeaders })).status).toBe(200);
    expect((await f.app.request(`/api/messages/${q}/question/present`, { method: 'POST', headers: f.taskHeaders,
      body: JSON.stringify({ expected_route_revision: 1, summary: 'Delegated gate evidence inspected' }) })).status).toBe(200);
    for (const scope of ['dlg_other_merge', '']) {
      const other = f.store.createTask({ agentId: f.agent.id, issueId: f.issue.id, workspaceId: 'local', prompt: 'Other lane',
        ...(scope ? { delegatedByAgentId: f.task.delegatedByAgentId!, delegationId: scope } : {}) });
      expect(f.store.claimTask(f.runtime.id)?.id).toBe(other.id);
      f.store.startTask(other.id);
      const otherTurn = f.store.getTurnForAttempt(other.id)!;
      expect(otherTurn.session_id).toBe(turn.session_id);
      expect(otherTurn.execution_scope ?? '').toBe(scope);
      const token = await f.store.createTaskAccessToken(other, 'local');
      expect((await f.app.request(`/api/messages/${q}/question`, { headers: { ...headers, Authorization: `Bearer ${token.token}` } })).status).toBe(403);
    }
    expect(f.state.puts).toHaveLength(0);
    expect((await f.answer(q)).status).toBe(200);
    await f.service.runOnce();
    expect(f.store.mergeOperations.get(op.id)?.state).toBe('merged');
    expect(f.state.puts).toEqual([{ sha: head, merge_method: 'squash' }]);
  });
  for (const reject of ['reject','close'] as const) it(`${reject} settles operation without merge`, async () => {
    const f = await fixture({ human: true }), op = await operation(await f.request()), q = op.approval_message_id;
    const response = reject === 'reject' ? await f.answer(q,'reject') : await f.app.request(`/api/messages/${q}/question/close`, { method: 'POST', headers, body: JSON.stringify({ expected_route_revision: 1, reason: 'Do not merge' }) });
    expect(response.status).toBe(200); await f.service.runOnce(); expect(f.store.mergeOperations.get(op.id)?.state).toBe('rejected'); expect(f.state.puts).toHaveLength(0);
  });
  for (const change of ['head','base','target','baseRepo','policy','checks'] as const) it(`approved then ${change} changes: revalidation blocks`, async () => {
    const f = await fixture({ human: true }), op = await operation(await f.request()), q = op.approval_message_id;
    expect((await f.answer(q)).status).toBe(200);
    if (change === 'policy') expect((await f.app.request(f.policyRoot, { method: 'PUT', headers, body: JSON.stringify({ ...f.policy, expected_revision: 1 }) })).status).toBe(200);
    else if (change === 'checks') f.state.conclusion = 'failure';
    else f.state[change] = change === 'target' ? 'release' : change === 'baseRepo' ? 'acme/other' : 'd'.repeat(40);
    await f.service.runOnce(); const result = f.store.mergeOperations.get(op.id)!;
    expect(result.state).toBe('blocked'); expect(f.state.puts).toHaveLength(0);
    if (change !== 'checks') { expect(result.reasons[0]?.code).toBe('approval_stale'); expect(f.store.getQuestion(q)?.status).toBe('closed'); }
  });
  it('same active binding reuses Q and persists alternate idempotency keys; conflicting binding fails', async () => {
    const f = await fixture({ human: true });
    const first = await operation(await f.request('first')), second = await operation(await f.request('second'));
    expect(second.id).toBe(first.id); expect(second.approval_message_id).toBe(first.approval_message_id);
    expect((await f.request('third', { method: 'merge' })).status).toBe(409);
    expect((await f.request('wrong-head', { expected_head_sha: 'd'.repeat(40) })).status).toBe(409);
    await f.answer(first.approval_message_id, 'reject');
    expect((await operation(await f.request('second'))).id).toBe(first.id);
  });
  it('expired executing lease is recovered by GET after simulated crash; never repeats merge', async () => {
    const f = await fixture({ human: true }), op = await operation(await f.request());
    await f.answer(op.approval_message_id);
    const claim = f.store.mergeOperations.claim(f.store.mergeOperations.get(op.id)!)!; expect(claim.state).toBe('executing');
    f.state.merged = true; expire(f, op.id);
    await Promise.all([f.service.runOnce(), new MergeExecutionService(f.store).runOnce()]);
    expect(f.store.mergeOperations.get(op.id)?.state).toBe('merged'); expect(f.state.puts).toHaveLength(0);
    expect(f.store.listIssueActivity(f.issue.id).filter(a => a.type === 'scm_merge_completed')).toHaveLength(1);
  });
  it('approval does not authorize public preflight; worker claim prevents revision before PUT completes', async () => {
    const f = await fixture({ human: true }), op = await operation(await f.request());
    await f.answer(op.approval_message_id);
    const preflight = await f.app.request(`${f.root}/merge-gate`, { headers });
    expect(await preflight.json()).toMatchObject({ allowed: false, preflight_only: true, execution_authorized: false, reasons: [{ code: 'human_approval_required' }] });
    const barrier = f.pauseMerge(), running = f.service.runOnce(); await barrier.waitEntered;
    expect((await f.answer(op.approval_message_id, 'reject', headers, { revise: true, reason: 'retract', expected_answer_revision: 1 })).status).toBe(409);
    barrier.release(); await running; expect(f.state.puts).toHaveLength(1);
  });
  it('startup wake consumes approved work, and a new blocking review prevents PUT', async () => {
    const f = await fixture({ human: true }), op = await operation(await f.request());
    await f.answer(op.approval_message_id);
    expect((await f.app.request(`${f.root}/reviews`, { method: 'POST', headers, body: JSON.stringify({ schema_version: 1, head_sha: head, base_sha: base, verdict: 'block', summary: 'New blocker', findings: [], evidence: ['regression'] }) })).status).toBe(201);
    f.service.start(); await f.service.runOnce(); f.service.stop();
    expect(f.store.mergeOperations.get(op.id)?.state).toBe('blocked'); expect(f.state.puts).toHaveLength(0);
  });
  it('a running worker wakes only after the approval transaction commits', async () => {
    const f = await fixture({ human: true }), op = await operation(await f.request());
    f.service.start(); await f.service.runOnce();
    expect(f.state.puts).toHaveLength(0); await f.answer(op.approval_message_id); await f.service.runOnce(); f.service.stop();
    expect(f.store.mergeOperations.get(op.id)?.state).toBe('merged'); expect(f.state.puts).toHaveLength(1);
  });
  it('member requests route approval to linked Issue Main', async () => {
    const f = await fixture({ human: true }), op = await operation(await f.request('member', {}, headers));
    expect(f.store.getQuestion(op.approval_message_id)?.session_id).toBe(f.store.getOrCreateDefaultIssueSession(f.issue.id).id);
    expect(f.store.getMessage(op.approval_message_id)?.metadata.execution_scope).toBe('');
    expect(f.store.mergeOperations.get(op.id)?.state).toBe('awaiting_human'); expect(f.state.puts).toHaveLength(0);
  });
  it('ambiguous provider response goes unknown, then recovers by GET without another PUT', async () => {
    const f = await fixture(); f.state.mode = 'ambiguous'; const op = await operation(await f.request());
    expect(op.state).toBe('unknown'); await f.service.runOnce(); expect(f.store.mergeOperations.get(op.id)?.state).toBe('failed'); expect(f.state.puts).toHaveLength(1);
  });
  it('expired pre-PUT crash confirmed open becomes failed, allowing an explicit new operation', async () => {
    const f = await fixture({ human: true }), op = await operation(await f.request());
    await f.answer(op.approval_message_id); f.store.mergeOperations.claim(f.store.mergeOperations.get(op.id)!); expire(f,op.id);
    await f.service.runOnce(); expect(f.store.mergeOperations.get(op.id)?.state).toBe('failed'); expect(f.state.puts).toHaveLength(0);
    const retry = await operation(await f.request('after-crash')); expect(retry.id).not.toBe(op.id); expect(retry.state).toBe('awaiting_human');
  });
  it('routes a normal Chat turn approval to that Chat without inheriting an Issue', async () => {
    const f = await fixture({ human: true, chat: true });
    const response = await f.request(); expect(response.status).toBe(202); const op = await operation(response);
    expect(f.store.getQuestion(op.approval_message_id)).toMatchObject({ session_id: f.chat!.id, source_issue_id: null, stage: 'human', wait_status: 'none' });
    const inbox = await f.app.request('/api/inbox?workspace_id=local', { headers }); expect(JSON.stringify(await inbox.json())).toContain(op.approval_message_id);
    expect((await f.answer(op.approval_message_id, 'approve', f.taskHeaders)).status).toBe(403);
    await f.answer(op.approval_message_id); await f.service.runOnce(); expect(f.state.puts).toHaveLength(1);
  });
  it('cannot create a human approval without a routable source turn', async () => {
    const f = await fixture({ human: true });
    const op = await f.service.request(f.project.id, f.cr.id, { kind: 'agent', id: f.agent.id, turn_id: null }, { expected_head_sha: head, method: 'squash', idempotency_key: 'unroutable' });
    expect(op).toMatchObject({ state: 'blocked', approval_message_id: null, reasons: [{ code: 'merge_approval_unroutable' }] }); expect(f.state.puts).toHaveLength(0);
  });
  it('DB unique constraint excludes a second active operation across projects', async () => {
    const f = await fixture({ human: true }), op = await operation(await f.request());
    const db = (f.store as unknown as { db: SqlDatabase }).db;
    expect(() => db.query('INSERT INTO multiremi_scm_merge_operations SELECT ?,project_id,change_request_id,?,request_body,state,version,lease_until,operation FROM multiremi_scm_merge_operations WHERE id=?').run('mop_collision','other',op.id)).toThrow();
  });
});


/** C1 mock provider; SQLite, HTTP authentication, policy, Question and worker are real. */
async function protectionFixture(options: Parameters<typeof fixture>[0] = { strict: true }) {
  const f = await fixture(options);
  const legacyFetch = globalThis.fetch;
  const proof = { sameIdentity: false, admin: false, enforceAdmins: true, force: false, deletion: false, updateRestriction: true,
    bypassReadFail: false, mergerBypass: false, taskBypass: false, pagination: false, unsupported: false, classic404: false, reads: 0 };
  const calls: Array<{ path: string; auth: string }> = [];
  const classic = () => ({ required_status_checks: { strict: false, contexts: ['ci'], checks: [{ context: 'ci', app_id: null }] },
    enforce_admins: { enabled: proof.enforceAdmins }, restrictions: proof.updateRestriction ? { users: [{ id: 2, login: 'merger' }], teams: [], apps: [] } : null,
    allow_force_pushes: { enabled: proof.force }, allow_deletions: { enabled: proof.deletion } });
  const rules = () => proof.unsupported ? [{ type: 'future_security_rule', ruleset_id: 10 }] :
    proof.bypassReadFail || proof.mergerBypass || proof.taskBypass ? [
      { type: 'required_status_checks', ruleset_id: 10, parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: 'ci', integration_id: null }] } },
      { type: 'update', ruleset_id: 20, parameters: { update_allows_fetch_and_merge: false } },
    ] : [];
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input)), path = url.pathname, auth = new Headers(init?.headers).get('Authorization') ?? '';
    calls.push({ path, auth });
    const isMerger = auth === 'Bearer merger-secret';
    if (path === '/user') { proof.reads++; return Response.json({ id: isMerger || proof.sameIdentity ? 2 : 1, login: isMerger ? 'merger' : 'task-writer' }); }
    if (path.endsWith('/permission')) return Response.json({ permission: proof.admin ? 'admin' : 'write', role_name: proof.admin ? 'admin' : 'write', user: { id: proof.sameIdentity ? 2 : 1 } });
    if (path.includes('/rules/branches/')) return Response.json(rules(), proof.pagination ? { headers: { link: '<https://api.github.com/next>; rel="next"' } } : undefined);
    if (path.includes('/rulesets/')) {
      if (proof.bypassReadFail) return Response.json({}, { status: 403 });
      const update = path.endsWith('/20');
      return Response.json({ id: update ? 20 : 10, target: 'branch', enforcement: 'active', bypass_actors: isMerger ? [] : undefined,
        current_user_can_bypass: update ? isMerger || proof.taskBypass ? 'always' : 'never' : isMerger && proof.mergerBypass ? 'always' : 'never' });
    }
    if (path.includes('/protection/restrictions/')) return Response.json(path.endsWith('/users') ? [{ id: 2, login: 'merger' }] : []);
    if (path.endsWith('/protection')) return proof.classic404 ? Response.json({}, { status: 404 }) : Response.json(classic());
    if (path.includes('/branches/')) return Response.json({ name: decodeURIComponent(path.split('/').pop()!), protected: true });
    return legacyFetch(input, init);
  }, { preconnect: originalFetch.preconnect });
  const connectionRoot = '/api/workspaces/local/scm/connections/scm_merge';
  const configure = (body = { mergeCredential: 'merger-secret', mergeCredentialKind: 'token' }, h = headers) => f.app.request(connectionRoot, { method: 'PATCH', headers: h, body: JSON.stringify(body) });
  const credentials = (h = f.taskHeaders) => f.app.request('/api/daemon/scm/git-credentials', { method: 'POST', headers: h, body: JSON.stringify({ workspaceId: 'local', repositoryUrl: 'https://github.com/acme/widgets.git' }) });
  const gate = () => f.app.request(`${f.root}/merge-gate`, { headers: f.taskHeaders });
  return { ...f, proof, calls, configure, credentials, gate, connectionRoot };
}
describe('C1 credential boundary (mock GitHub, real SQLite/HTTP/worker)', () => {
  const policyPut = (f: Awaited<ReturnType<typeof protectionFixture>>, extra = {}) => f.app.request(f.policyRoot, { method: 'PUT', headers,
    body: JSON.stringify({ ...f.policy, expected_revision: f.store.mergePolicies.get(f.project.id).revision, ...extra }) });
  const removeAssociations = async (f: Awaited<ReturnType<typeof protectionFixture>>) => {
    for (const resource of f.store.listProjectResources(f.project.id)) expect((await f.app.request(`/api/projects/${f.project.id}/resources/${resource.id}`, { method: 'DELETE', headers: f.taskHeaders })).status).toBe(204);
    expect((await f.app.request(`/api/issues/${f.issue.id}/change-requests/${f.cr.id}`, { method: 'DELETE', headers: f.taskHeaders })).status).toBe(204);
  };
  const addOtherRepository = (f: Awaited<ReturnType<typeof protectionFixture>>) => {
    f.store.updateWorkspace('local', { repos: [...f.store.getWorkspace('local')!.repos, { id: 'repo_other', name: 'other', url: 'https://github.com/acme/other.git', defaultBranch: 'main' }] });
    f.store.updateScmConnection('scm_merge', { repositoryScope: 'selected', repositoryIds: ['repo_merge','repo_other'] });
  };
  const otherCredentials = (f: Awaited<ReturnType<typeof protectionFixture>>) => f.app.request('/api/daemon/scm/git-credentials', { method: 'POST', headers: f.taskHeaders,
    body: JSON.stringify({ workspaceId: 'local', repositoryUrl: 'https://github.com/acme/other.git' }) });
  const bind = (f: Awaited<ReturnType<typeof protectionFixture>>, repositoryId: string, connection = 'scm_merge', h = f.taskHeaders) =>
    f.app.request(`/api/workspaces/local/scm/connections/${connection}/repositories/${repositoryId}`, { method: 'PUT', headers: h, body: JSON.stringify({ transfer: true }) });
  const imported = async (f: Awaited<ReturnType<typeof protectionFixture>>, url: string) => {
    const response = await f.app.request('/api/workspaces/local/repos', { method: 'POST', headers: f.taskHeaders, body: JSON.stringify({ url }) });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()).repository;
  };
  const credentialFor = (f: Awaited<ReturnType<typeof protectionFixture>>, url: string) =>
    f.app.request('/api/daemon/scm/git-credentials', { method: 'POST', headers: f.taskHeaders, body: JSON.stringify({ repositoryUrl: url }) });
  it('retains remote coverage through Task deletion and HTTPS/SSH/case reimports', async () => {
    const f = await protectionFixture({ strict: true });
    expect((await f.credentials()).status).toBe(409);
    await removeAssociations(f);
    expect((await f.app.request('/api/workspaces/local/repos/repo_merge', { method: 'DELETE', headers: f.taskHeaders })).status).toBe(200);
    for (const url of ['https://github.com/acme/widgets.git', 'git@github.com:acme/widgets.git', 'https://github.com/Acme/Widgets.git']) {
      const repo = await imported(f, url);
      expect((await bind(f, repo.id)).status).toBe(200);
      const response = await credentialFor(f, url); expect(response.status).toBe(409);
      expect((await response.json()).reasons[0].evidence.remote_key).toBe('github.com/acme/widgets');
      expect((await f.app.request(`/api/workspaces/local/repos/${repo.id}`, { method: 'DELETE', headers: f.taskHeaders })).status).toBe(200);
    }
    expect(f.state.puts).toHaveLength(0);
  });
  it('withholds the connection token for uncovered Y, but leaves a never-recorded C2 unchanged', async () => {
    const f = await protectionFixture({ strict: true }); await removeAssociations(f);
    const y = await imported(f, 'https://github.com/acme/other.git');
    expect((await bind(f, y.id)).status).toBe(200);
    const denied = await otherCredentials(f); expect(denied.status).toBe(409);
    expect((await denied.json()).reasons[0].evidence.remote_key).toBe('github.com/acme/widgets');
    f.store.createScmConnection({ id: 'scm_other', workspaceId: 'local', name: 'Separate', provider: 'github', mode: 'poll', accessToken: 'separate-task-secret', repositoryIds: [] });
    expect((await f.app.request(`/api/workspaces/local/scm/connections/scm_other/repositories/${y.id}`, { method: 'PUT', headers: f.taskHeaders, body: JSON.stringify({ transfer: true }) })).status).toBe(200);
    const allowed = await otherCredentials(f); expect(allowed.status).toBe(200); expect((await allowed.json()).password).toBe('separate-task-secret');
  });
  it('records default connection transfers before immediate Task deletion without intervening reads', async () => {
    const f = await protectionFixture({ strict: true });
    expect((await f.credentials()).status).toBe(409);
    await removeAssociations(f);
    expect((await f.app.request('/api/workspaces/local/repos/repo_merge', { method: 'DELETE', headers: f.taskHeaders })).status).toBe(200);
    const r = await imported(f, 'https://github.com/acme/widgets.git');
    expect(f.store.listScmRepositoryBindings({ connectionId: 'scm_merge' }).find(b => b.repositoryId === r.id)?.assignmentOrigin).toBe('default');
    f.store.createScmConnection({ id: 'scm_other', workspaceId: 'local', name: 'C2', provider: 'github', mode: 'poll', accessToken: 'other-secret', repositoryScope: 'selected' });
    const revision = f.store.mergePolicies.get(f.project.id).revision;
    const switched = await f.app.request('/api/workspaces/local/scm/connections/scm_other', { method: 'PATCH', headers, body: JSON.stringify({ repositoryScope: 'all' }) });
    expect(switched.status, await switched.clone().text()).toBe(200);
    expect(f.store.listScmRepositoryBindings({ connectionId: 'scm_other' }).find(b => b.repositoryId === r.id)?.assignmentOrigin).toBe('default');
    // No gate or credentials read between the transfer and deleting its only repository.
    expect((await f.app.request(`/api/workspaces/local/repos/${r.id}`, { method: 'DELETE', headers: f.taskHeaders })).status).toBe(200);
    const y = await imported(f, 'https://github.com/acme/other.git');
    expect(f.store.listScmRepositoryBindings({ connectionId: 'scm_other' }).find(b => b.repositoryId === y.id)?.assignmentOrigin).toBe('default');
    const denied = await otherCredentials(f);
    expect(denied.status).toBe(409);
    expect((await denied.json()).reasons[0].evidence.remote_key).toBe('github.com/acme/widgets');
    expect(f.store.mergePolicies.get(f.project.id).revision).toBe(revision);
    expect(f.state.puts).toHaveLength(0);
  });
  it('does not allow Task PATCH to change a repository URL or its binding', async () => {
    const f = await protectionFixture({ strict: true }); await removeAssociations(f);
    const y = await imported(f, 'https://github.com/acme/other.git');
    f.store.createScmConnection({ id: 'scm_other', workspaceId: 'local', name: 'C2', provider: 'github', mode: 'poll', accessToken: 'other-secret', repositoryScope: 'selected' });
    expect((await bind(f, y.id, 'scm_other')).status).toBe(200);
    for (const url of ['https://github.com/acme/widgets.git', 'https://github.com/acme/other.git']) {
      const response = await f.app.request(`/api/workspaces/local/repos/${y.id}`, { method: 'PATCH', headers: f.taskHeaders, body: JSON.stringify({ url }) });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'repository update is empty' });
    }
    // Unknown url is also ignored alongside a valid editable field; it cannot mutate the remote.
    expect((await f.app.request(`/api/workspaces/local/repos/${y.id}`, { method: 'PATCH', headers: f.taskHeaders, body: JSON.stringify({ url: 'https://github.com/acme/widgets.git', description: 'Y' }) })).status).toBe(200);
    expect(f.store.listScmRepositoryBindings({ connectionId: 'scm_other' }).find(b => b.repositoryId === y.id)?.repositoryUrl).toBe('https://github.com/acme/other.git');
    expect((await otherCredentials(f)).status).toBe(200);
    expect(f.state.puts).toHaveLength(0);
  });
  it('binding upsert records coverage in the transaction before immediate Task unbind', async () => {
    const f = await protectionFixture({ strict: true }); await removeAssociations(f);
    f.store.createScmConnection({ id: 'scm_new', workspaceId: 'local', name: 'New', provider: 'github', mode: 'poll', accessToken: 'new-task-secret', repositoryIds: [] });
    expect((await f.app.request('/api/workspaces/local/scm/connections/scm_new/repositories/repo_merge', { method: 'PUT', headers, body: JSON.stringify({ transfer: true }) })).status).toBe(200);
    expect((await f.app.request('/api/workspaces/local/scm/connections/scm_new/repositories/repo_merge', { method: 'DELETE', headers: f.taskHeaders })).status).toBe(204);
    const y = await imported(f, 'https://github.com/acme/other.git');
    expect((await bind(f, y.id, 'scm_new')).status).toBe(200);
    const denied = await otherCredentials(f); expect(denied.status).toBe(409);
    expect((await denied.json()).reasons[0].evidence.remote_key).toBe('github.com/acme/widgets');
  });
  it('proves the union once per remote and reads each credential identity once per handout', async () => {
    const f = await protectionFixture({ strict: true }); await f.configure(); await removeAssociations(f);
    const y = await imported(f, 'https://github.com/acme/other.git'); expect((await bind(f, y.id)).status).toBe(200);
    // A second policy for the same remote must reuse reads within the request, without caching across requests.
    const second = f.store.createProject({ title: 'Also strict' });
    f.store.createProjectResource(second.id, { resourceType: 'github_repo', resourceRef: { url: 'https://github.com/acme/widgets.git' } });
    f.store.createProjectResource(second.id, { resourceType: 'github_repo', resourceRef: { url: 'https://github.com/acme/other.git' } });
    f.store.mergePolicies.put(second.id, { ...f.policy, expected_revision: 0 }, 'operator');
    for (const request of [() => otherCredentials(f), () => f.credentials()]) {
      f.calls.length = 0;
      const response = await request(); expect(response.status).toBe(200); expect((await response.json()).password).toBe('provider-secret');
      expect(f.calls.filter(c => c.path === '/user').map(c => c.auth).sort()).toEqual(['Bearer merger-secret','Bearer provider-secret']);
      expect(f.calls.filter(c => c.path === '/repos/acme/widgets/branches/main/protection')).toHaveLength(1);
      expect(f.calls.filter(c => c.path === '/repos/acme/widgets/rules/branches/main')).toHaveLength(1);
    }
    expect((await policyPut(f, { enabled: false })).status).toBe(200);
    expect((await otherCredentials(f)).status).toBe(200);
  });
  for (const change of ['credential','policy','coverage'] as const) it(`withholds credentials when ${change} changes during a proof`, async () => {
    const f = await protectionFixture({ strict: true }); await f.configure();
    const provider = globalThis.fetch;
    let changed = false;
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (new URL(String(input)).pathname === '/user' && !changed) {
        changed = true;
        if (change === 'credential') f.store.updateScmConnection('scm_merge', { accessToken: 'rotated-task' });
        if (change === 'policy') expect((await policyPut(f)).status).toBe(200);
        if (change === 'coverage') {
          addOtherRepository(f);
          f.store.createProjectResource(f.project.id, { resourceType: 'github_repo', resourceRef: { url: 'https://github.com/acme/other.git' } });
        }
      }
      return provider(input, init);
    }, { preconnect: originalFetch.preconnect });
    const response = await f.credentials(); expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toContain('"password"');
    expect(changed).toBe(true); expect(f.state.puts).toHaveLength(0);
  });
  it('retains coverage after Task removals until member disables strict', async () => {
    const f = await protectionFixture({ strict: true }); await removeAssociations(f);
    expect((await f.credentials()).status).toBe(409);
    expect((await policyPut(f, { credential_enforcement_mode: 'platform_only' })).status).toBe(200);
    expect((await f.credentials()).status).toBe(200);
  });
  it('member strict PUT recomputes coverage, rejects an empty set without erasing old coverage', async () => {
    const f = await protectionFixture({ strict: true }); await removeAssociations(f);
    const empty = await policyPut(f); expect(empty.status).toBe(400); expect((await empty.json()).code).toBe('merge_policy_strict_coverage_empty');
    expect((await f.credentials()).status).toBe(409);
    addOtherRepository(f);
    f.store.createProjectResource(f.project.id, { resourceType: 'github_repo', resourceRef: { url: 'https://github.com/acme/other.git' } });
    expect((await policyPut(f)).status).toBe(200);
    expect(f.store.mergePolicies.strictForRemote('local', 'github.com/acme/widgets')).toEqual([]);
    expect((await f.credentials(headers)).status).toBe(409);
    expect((await otherCredentials(f)).status).toBe(409);
  });
  it('persists project_ref repositories and Task additions in the same write transaction', async () => {
    const f = await protectionFixture({ strict: true }); addOtherRepository(f);
    const referenced = f.store.createProject({ title: 'Referenced repositories' });
    f.store.createProjectResource(referenced.id, { resourceType: 'github_repo', resourceRef: { url: 'https://github.com/acme/other.git' } });
    expect((await f.app.request(`/api/projects/${f.project.id}/resources`, { method: 'POST', headers: f.taskHeaders,
      body: JSON.stringify({ resourceType: 'project_ref', resourceRef: { projectId: referenced.id } }) })).status).toBe(201);
    const persisted = (f.store as unknown as { db: SqlDatabase }).db.query('SELECT repository_id FROM multiremi_scm_strict_coverage WHERE project_id=?').all(f.project.id);
    expect(persisted.map(r => r.repository_id)).toContain('repo_other');
    const coverage = f.store.mergePolicies.strictForRepository('local','repo_other'); expect(coverage.map(c => c.project_id)).toEqual([f.project.id]);
    await removeAssociations(f); f.store.deleteProjectResource(referenced.id, f.store.listProjectResources(referenced.id)[0]!.id);
    expect((await otherCredentials(f)).status).toBe(409);
  });
  it('appends coverage on Task resource update and CR link creation', async () => {
    const f = await protectionFixture({ strict: true }); addOtherRepository(f);
    const resource = f.store.listProjectResources(f.project.id)[0]!;
    expect((await f.app.request(`/api/projects/${f.project.id}/resources/${resource.id}`, { method: 'PUT', headers: f.taskHeaders,
      body: JSON.stringify({ resourceRef: { url: 'https://github.com/acme/other.git' } }) })).status).toBe(200);
    f.store.deleteProjectResource(f.project.id, resource.id);
    expect((await otherCredentials(f)).status).toBe(409);
    // Member recomputation drops the removed repository, while retaining the linked original CR.
    expect((await policyPut(f)).status).toBe(200); expect((await otherCredentials(f)).status).toBe(409);
    const second = f.store.createProject({ title: 'Second strict project' });
    f.store.createProjectResource(second.id, { resourceType: 'github_repo', resourceRef: { url: 'https://github.com/acme/other.git' } });
    f.store.mergePolicies.put(second.id, { ...f.policy, expected_revision: 0 }, 'operator');
    const issue = createResponsibleTestIssue(f.store, { title: 'Link coverage', projectId: second.id, workspaceId: 'local', createdBy: 'local' });
    f.store.linkScmChangeRequestToIssue(issue.id, f.cr.id); f.store.unlinkScmChangeRequestFromIssue(issue.id, f.cr.id);
    expect(f.store.mergePolicies.strictForRepository('local','repo_merge').map(c => c.project_id)).toContain(second.id);
  });
  it('persists dynamically discovered coverage when an Issue moves into a strict project', async () => {
    const f = await protectionFixture({ strict: true }); addOtherRepository(f);
    const second = f.store.createProject({ title: 'Dynamically linked strict project' });
    f.store.createProjectResource(second.id, { resourceType: 'github_repo', resourceRef: { url: 'https://github.com/acme/other.git' } });
    f.store.mergePolicies.put(second.id, { ...f.policy, expected_revision: 0 }, 'operator');
    f.store.updateIssue(f.issue.id, { projectId: second.id });
    expect(f.store.mergePolicies.strictForRepository('local','repo_merge').map(c => c.project_id)).toContain(second.id);
    f.store.updateIssue(f.issue.id, { projectId: f.project.id });
    expect(f.store.mergePolicies.strictForRepository('local','repo_merge').map(c => c.project_id)).toContain(second.id);
  });
  it('does not let Task resource removal and CR unlink downgrade strict credential coverage', async () => {
    const f = await protectionFixture({ strict: true });
    expect((await f.credentials()).status).toBe(409);
    const resource = f.store.listProjectResources(f.project.id)[0]!;
    await f.app.request(`/api/projects/${f.project.id}/resources/${resource.id}`, { method: 'DELETE', headers: f.taskHeaders });
    await f.app.request(`/api/issues/${f.issue.id}/change-requests/${f.cr.id}`, { method: 'DELETE', headers: f.taskHeaders });
    expect((await f.credentials()).status).toBe(409);
  });
  it('disabled strict policy leaves credential handout unchanged', async () => {
    const f = await protectionFixture({ strict: true, disabled: true });
    const response = await f.credentials(); expect(response.status).toBe(200); expect((await response.json()).password).toBe('provider-secret');
    expect(f.proof.reads).toBe(0);
  });
  it('Codebase strict credentials fail closed with capability unavailable', async () => {
    const f = await protectionFixture({ strict: false });
    f.store.updateWorkspace('local', { repos: [...f.store.getWorkspace('local')!.repos,
      { id: 'repo_codebase', name: 'internal', url: 'git@code.byted.org:example/internal.git', source: 'codebase', defaultBranch: 'main' }] });
    f.store.createScmConnection({ id: 'scm_codebase', workspaceId: 'local', name: 'Codebase', provider: 'codebase', mode: 'poll', accessToken: 'jwt:task-only', repositoryIds: ['repo_codebase'] });
    f.store.createProjectResource(f.project.id, { resourceType: 'github_repo', resourceRef: { url: 'git@code.byted.org:example/internal.git' } });
    expect((await policyPut(f, { credential_enforcement_mode: 'strict' })).status).toBe(200);
    const response = await f.app.request('/api/daemon/scm/git-credentials', { method: 'POST', headers,
      body: JSON.stringify({ workspaceId: 'local', repositoryUrl: 'git@code.byted.org:example/internal.git' }) });
    expect(response.status).toBe(409);
    const result = await response.json(); expect(result.reasons[0].code).toBe('scm_capability_unavailable');
    expect(JSON.stringify(result)).not.toContain('jwt:task-only'); expect(f.state.puts).toHaveLength(0);
  });
  it('keeps merger secret encrypted and private; task/daemon cannot configure it', async () => {
    const f = await protectionFixture({ strict: false });
    expect((await f.configure(undefined, f.taskHeaders)).status).toBe(403);
    const token = await f.store.createAccessToken({ type: 'daemon', name: 'daemon', workspaceId: 'local', daemonId: 'merge-test' });
    expect((await f.configure(undefined, { ...headers, Authorization: `Bearer ${token.token}` })).status).toBe(403);
    const result = await f.configure(); expect(result.status).toBe(200);
    const json = await result.json(); expect(json.connection).toMatchObject({ mergeCredentialSet: true, mergeCredentialKind: 'token' });
    expect(JSON.stringify(json)).not.toContain('merger-secret');
    expect(f.store.getScmConnectionCredential('scm_merge')).toEqual({ accessToken: 'provider-secret', webhookSecret: 'hook-secret' });
    const { db } = await import('./helpers.js');
    const encrypted = db!.query('SELECT merge_credential_encrypted FROM multiremi_scm_connections').get() as { merge_credential_encrypted: string };
    expect(encrypted.merge_credential_encrypted).not.toContain('merger-secret');
    expect((await f.credentials()).status).toBe(200); expect((await (await f.credentials()).json()).password).toBe('provider-secret');
    expect((await (await f.credentials({ ...headers, Authorization: `Bearer ${token.token}` })).json()).password).toBe('provider-secret');
    expect(f.proof.reads).toBe(0);
    const op = await operation(await f.request()); expect(op.state).toBe('merged');
    expect(f.calls.filter(c => c.path.endsWith('/merge')).map(c => c.auth)).toEqual(['Bearer merger-secret']);
    expect(f.calls.filter(c => c.path.includes('/statuses')).every(c => c.auth === 'Bearer provider-secret')).toBe(true);
    expect(f.calls.filter(c => c.path.includes('/rules/branches/')).every(c => c.auth === 'Bearer merger-secret')).toBe(true);
    for (const body of [{ mergeCredential: 'other', clearMergeCredential: true }, { mergeCredentialKind: 'app' }, { mergeCredential: null }]) {
      expect((await f.app.request(f.connectionRoot, { method: 'PATCH', headers, body: JSON.stringify(body) })).status).toBe(400);
    }
    const cleared = await f.app.request(f.connectionRoot, { method: 'PATCH', headers, body: JSON.stringify({ clearMergeCredential: true }) });
    expect(cleared.status).toBe(200); expect((await cleared.json()).connection).toMatchObject({ mergeCredentialSet: false, mergeCredentialKind: null, mergeCredentialHint: null });
  });
  for (const [condition, code] of [
    ['classic404','protection_classic_unreadable'], ['missing','merge_credential_missing'], ['sameIdentity','credential_identity_not_separated'], ['enforceAdmins','protection_required_checks_bypassable'],
    ['mergerBypass','protection_required_checks_bypassable'], ['bypassReadFail','protection_bypass_unreadable'], ['updateRestriction','protection_task_can_update_target'],
    ['taskBypass','protection_task_can_update_target'], ['force','protection_force_push_allowed'], ['deletion','protection_deletion_allowed'],
    ['admin','task_identity_admin'], ['pagination','protection_pagination_incomplete'], ['unsupported','repository_rules_unsupported'],
  ] as const) it(`strict ${condition}: gate denied, credentials withheld, merge PUT=0`, async () => {
    const f = await protectionFixture({ strict: true, human: true });
    if (condition !== 'missing') expect((await f.configure()).status).toBe(200);
    if (condition === 'enforceAdmins' || condition === 'updateRestriction') f.proof[condition] = false;
    else if (condition !== 'missing') f.proof[condition] = true;
    const gate = await (await f.gate()).json(); expect(gate.allowed).toBe(false); expect(gate.reasons.map((r: {code: string}) => r.code)).toContain(code);
    const credential = await f.credentials(); expect(credential.status).toBe(409); expect((await credential.json()).reasons.map((r: {code: string}) => r.code)).toContain(code);
    if (condition === 'missing') {
      const broker = await f.store.createAccessToken({ type: 'daemon', name: 'strict-broker', workspaceId: 'local', daemonId: 'merge-test' });
      expect((await f.credentials({ ...headers, Authorization: `Bearer ${broker.token}` })).status).toBe(409);
    }
    const denied = await f.request(); expect(denied.status).toBe(409); expect((await operation(denied)).approval_message_id).toBeNull(); expect(f.state.puts).toEqual([]);
    expect(f.calls.filter(c => c.path.endsWith('/merge'))).toEqual([]);
  });
  it('proves every target, releases only task-writer and re-proves before one sha-bound merger PUT', async () => {
    const f = await protectionFixture({ strict: true }); expect((await f.configure()).status).toBe(200);
    const gate = await (await f.gate()).json(); expect(gate.allowed).toBe(true); expect(gate.protection_proof.proven).toBe(true);
    const broker = await f.store.createAccessToken({ type: 'daemon', name: 'strict-broker', workspaceId: 'local', daemonId: 'merge-test' });
    const brokerResponse = await f.credentials({ ...headers, Authorization: `Bearer ${broker.token}` });
    expect(brokerResponse.status).toBe(200); expect((await brokerResponse.json()).password).toBe('provider-secret');
    expect(gate.credential_boundary).toBe('平台入口受控、直推已由仓库保护封闭（实时证明）');
    expect(gate.protection_proof.evidence.branches.map((b: {target: string}) => b.target)).toEqual(['main','release']);
    const cred = await f.credentials(); expect(cred.status).toBe(200); expect((await cred.json()).password).toBe('provider-secret');
    const reads = f.proof.reads;
    const op = await operation(await f.request()); expect(op.state).toBe('merged'); expect(op.credential_boundary).toBe(gate.credential_boundary);
    expect(f.proof.reads).toBeGreaterThan(reads); expect(f.state.puts).toEqual([{ sha: head, merge_method: 'squash' }]);
    expect(f.calls.filter(c => c.path.endsWith('/merge')).map(c => c.auth)).toEqual(['Bearer merger-secret']);
  });
  it('approval does not cache proof; changed protection blocks worker with zero PUT', async () => {
    const f = await protectionFixture({ strict: true, human: true }); await f.configure();
    const response = await f.request(); expect(response.status).toBe(202); const op = await operation(response);
    expect((await f.answer(op.approval_message_id)).status).toBe(200);
    f.proof.force = true; await f.service.runOnce();
    expect(f.store.mergeOperations.get(op.id)?.state).toBe('blocked'); expect(f.state.puts).toEqual([]);
  });
  it('uses no cached proof after either credential or policy changes', async () => {
    const f = await protectionFixture({ strict: true }); await f.configure(); await f.gate(); let reads = f.proof.reads;
    f.store.updateScmConnection('scm_merge', { accessToken: 'new-task-secret' });
    await f.gate(); expect(f.proof.reads).toBeGreaterThan(reads); reads = f.proof.reads;
    await f.configure({ mergeCredential: 'new-merger-secret', mergeCredentialKind: 'token' });
    await f.gate(); expect(f.proof.reads).toBeGreaterThan(reads); reads = f.proof.reads;
    expect((await f.app.request(f.policyRoot, { method: 'PUT', headers, body: JSON.stringify({ ...f.policy, expected_revision: 1 }) })).status).toBe(200);
    await f.gate(); expect(f.proof.reads).toBeGreaterThan(reads);
  });
});
