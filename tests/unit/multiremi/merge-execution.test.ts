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
  const issue = createResponsibleTestIssue(store, { title: 'Merge', projectId: project.id, workspaceId: 'local', createdBy: 'local' });
  const agent = store.createAgent({ name: 'Author', provider: 'codex', workspaceId: 'local', ...(options.delegated ? { maxConcurrentTasks: 4 } : {}) });
  const runtime = store.registerRuntime({ name: 'Merge runtime', provider: 'codex', daemonId: 'merge-runtime', ...(options.delegated ? { maxConcurrency: 4 } : {}) });
  const chat = options.chat ? store.createChatSession({ agentId: agent.id, creatorId: 'local', title: 'Chat merge' }) : null;
  const delegator = options.delegated ? store.createAgent({ name: 'Delegator', provider: 'codex', workspaceId: 'local' }) : null;
  const task = store.createTask({ ...(delegator ? { delegatedByAgentId: delegator.id, delegationId: 'dlg_merge_approval' } : {}), agentId: agent.id, ...(chat ? { chatSessionId: chat.id } : { issueId: issue.id }), workspaceId: 'local', prompt: 'Merge request' });
  expect(store.claimTask(runtime.id)?.id).toBe(task.id); store.startTask(task.id);
  const token = await store.createTaskAccessToken(task, 'local');
  const taskHeaders = { ...headers, Authorization: `Bearer ${token.token}` };
  const app = createMultiremiApp({ store, authToken: 'merge-test', backgroundJobs: false });
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
  expect((await app.request(active, { method: 'POST', headers: taskHeaders, body: JSON.stringify({ head: 'feature', base: 'main', title: 'PR' }) })).status).toBe(201);
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
