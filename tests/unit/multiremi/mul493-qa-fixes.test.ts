import { afterEach, beforeEach, expect, it } from 'bun:test';
import { createMultiremiApp } from '@multiremi/api.js';
import { daemonTaskClaimResponse } from '@multiremi/api/wire/tasks.js';
import { prepareTaskOffer } from '@multiremi/api/daemon-protocol/task-offers.js';
import { fitTaskOfferToBudget } from '@multiremi/api/daemon-protocol/offer-budget.js';
import { ProjectKnowledgeService } from '@multiremi/project-knowledge/service.js';
import { RepositoryWikiService } from '@multiremi/repository-wiki/service.js';
import { normalizeDaemonClaimTask } from '@multiremi/worker/client.js';
import { buildTaskPrompt } from '@daemon/agent-runtime/prompts/ephemeral.js';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';
import { bindFeishuTopicFixture } from './feishu-topic-fixture.js';

pendingTurnBackendTests('MUL-493 QA blockers B1-B4', fixture => {
  let previousKey: string | undefined;
  beforeEach(() => {
    previousKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
    process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 37).toString('base64');
  });
  afterEach(() => {
    if (previousKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
    else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousKey;
  });

  const scope = { workspaceId: 'local', runtimeId: 'rt_qa_fix', daemonId: 'daemon_qa_fix' };
  function setup() {
    const f = fixture(), { store, db } = f;
    const concierge = store.createAgent({ name: 'Concierge', provider: 'codex' });
    const worker = store.createAgent({ name: 'Worker', provider: 'codex', maxConcurrentTasks: 20 });
    store.registerRuntime({ id: scope.runtimeId, daemonId: scope.daemonId, name: 'Isolated runtime', provider: 'codex', maxConcurrency: 20 });
    store.heartbeatRuntime(scope.runtimeId, { supportsFeishuBotConfig: true });
    const config = store.upsertFeishuBotConfig('local', {
      agentId: concierge.id, runtimeId: scope.runtimeId, appId: 'cli_qa_fix', domain: 'feishu',
      enabled: true, appSecretOp: 'set', appSecret: 'synthetic-test-only',
    });
    store.reportFeishuBotRuntimeStatus('local', scope.runtimeId, { appliedRevision: config.revision, state: 'online' });
    store.updateWorkspace('local', { settings: { issueTopics: { enabled: true, chatId: 'oc_same_group' } } });
    function topic(title: string) {
      const issue = store.createIssue({ title, assigneeType: 'agent', assigneeId: worker.id });
      store.prepareFeishuIssueTopicWithinTransaction(issue);
      const root = store.claimFeishuBotOutbound('local', scope.runtimeId)!;
      expect(root).toBeTruthy();
      store.reportFeishuBotOutbound('local', scope.runtimeId, root.id,
        { claimToken: root.claimToken, status: 'sent', externalMessageId: `om_${issue.id}` });
      return { issue, chat: store.getChatSession(`chat_issue_topic_${issue.id}`)!, session: store.getOrCreateDefaultIssueSession(issue.id) };
    }
    function running(issueId?: string) {
      if (issueId) store.reportIssueWorkspace({ issueId, runtimeId: scope.runtimeId, rootPath: '/tmp/qa-fix-source',
        branchName: `agent/${store.getIssue(issueId)!.key}`, status: 'ready', repos: [] });
      const task = store.createTask({ agentId: worker.id, prompt: 'Review', ...(issueId ? { issueId } : {}) });
      expect(store.claimTask(scope.runtimeId)?.id).toBe(task.id);
      store.startTask(task.id);
      return task;
    }
    function message(target: ReturnType<typeof topic>, attemptId: string, body = 'Review result') {
      return store.sendMessage({ session_id: target.session.id, source_turn_id: store.getTurnForAttempt(attemptId)!.id,
        sender: { type: 'agent', id: worker.id }, to: { type: 'none' },
        message_kind: 'final', body_md: body, wake_requested: 'inbox_only' }).message;
    }
    return { ...f, concierge, worker, topic, running, message };
  }

  for (const status of ['completed', 'failed', 'cancelled'] as const) {
    it(`B1: ${status} delivers once to each binding in the same group`, () => {
      const f = setup(), target = f.topic('Two topics'), second = f.store.createChatSession({ agentId: f.concierge.id });
      bindFeishuTopicFixture(f.store, f.db, second.id, target.issue.id);
      f.db.run("UPDATE multiremi_feishu_bot_chat_bindings SET app_id='cli_qa_fix',chat_id='oc_same_group',reply_to_message_id='om_second_topic' WHERE chat_session_id=?", [second.id]);
      const source = f.running(), turn = f.store.getTurnForAttempt(source.id)!;
      f.message(target, source.id);
      f.message(target, source.id, 'Another comment on the same Issue');
      if (status === 'completed') {
        f.store.completeTaskFromDaemon(source.id, { output: 'Finished' }, scope);
        f.store.completeTaskFromDaemon(source.id, { output: 'Finished' }, scope);
      } else if (status === 'failed') f.store.failTask(source.id, { error: 'Final failure', failureReason: 'agent_error' });
      else f.store.cancelTurn(turn.id);
      const pushes = f.db.query('SELECT binding_id,leader_task_id,wake_task_id FROM multiremi_feishu_bot_round_pushes WHERE issue_id=?').all(target.issue.id);
      expect(pushes).toHaveLength(2);
      expect(new Set(pushes.map(row => row.binding_id)).size).toBe(2);
      expect(pushes.map(row => row.leader_task_id)).toEqual([turn.id, turn.id]);
      for (const chat of [target.chat, second]) {
        const reports = f.store.listMessages(chat.id).filter(m => m.dedupe_key === `relay:${target.issue.id}:${turn.id}`);
        expect(reports).toHaveLength(1);
        expect(reports[0].task_id).toBe(turn.id);
        expect(reports[0].metadata.message_outcome).toBe(status === 'completed' ? 'done' : status);
        const push = pushes.find(row => f.store.getTask(String(row.wake_task_id))?.chatSessionId === chat.id)!;
        expect(push).toBeTruthy();
        expect(Number(f.db.query('SELECT COUNT(*) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE task_id=?').get(push.wake_task_id).n)).toBe(1);
      }
    }, 30_000);
  }

  it('B4: a replacement attempt stores and deduplicates round pushes by the stable turn', () => {
    const f = setup(), target = f.topic('Recovered source');
    const origin = f.store.createIssue({ title: 'Source Issue', assigneeType: 'agent', assigneeId: f.worker.id });
    const source = f.running(origin.id), turn = f.store.getTurnForAttempt(source.id)!;
    f.message(target, source.id);
    f.store.failTask(source.id, { error: 'Runtime unavailable', failureReason: 'runtime_offline' });
    const replacement = f.store.getTurn(turn.id)!.current_attempt_id!;
    expect(replacement).not.toBe(source.id);
    expect(Number(f.db.query('SELECT COUNT(*) AS n FROM multiremi_feishu_bot_round_pushes').get().n)).toBe(0);
    expect(f.store.claimTask(scope.runtimeId)?.id).toBe(replacement);
    f.store.startTask(replacement);
    f.store.completeTask(replacement, { output: 'Recovered' });
    expect(f.db.query('SELECT leader_task_id FROM multiremi_feishu_bot_round_pushes WHERE issue_id=?').all(target.issue.id)).toEqual([{ leader_task_id: turn.id }]);
    // Exercise the preparation entry point directly too, bypassing relay-message deduplication.
    expect(f.store.prepareFeishuIssueRoundPushes({ issue: target.issue, leaderTask: f.store.getTask(source.id)! })).toEqual([]);
    expect(f.store.prepareFeishuIssueRoundPushes({ issue: target.issue, leaderTask: f.store.getTask(replacement)! })).toEqual([]);
    expect(Number(f.db.query('SELECT COUNT(*) AS n FROM multiremi_feishu_bot_round_pushes WHERE issue_id=?').get(target.issue.id).n)).toBe(1);
  }, 30_000);

  for (const kind of ['direct', 'run_only'] as const) {
    function startedStandalone() {
      const f = setup();
      const id = kind === 'direct' ? f.store.createTask({ agentId: f.worker.id, prompt: 'Original input' }).id
        : f.store.runAutopilot(f.store.createAutopilot({ title: 'Independent run', assigneeId: f.worker.id, executionMode: 'run_only' }).id, { prompt: 'Original input' }).taskId!;
      expect(f.store.claimTask(scope.runtimeId)?.id).toBe(id);
      f.store.startTask(id);
      const turn = f.store.getTurnForAttempt(id)!, bridge = f.store.getDaemonTurnBridge();
      const offer = bridge.offerInput(f.store.getTaskWithAgent(id)!);
      f.store.recordSessionAgentRangeRead(turn.session_id, f.worker.id, { seq: 1, offset: 0 }, { seq: offer.input_to_seq + 1, offset: 0 }, id);
      expect(bridge.rpc('turn.input', { turn_id: turn.id, attempt_id: id, input_to_seq: offer.input_to_seq,
        message_ids: offer.input_messages.map(m => m.id) }, scope).ok).toBe(true);
      const late = f.store.sendMessage({ session_id: turn.session_id, sender: { type: 'member', id: 'mem_local_local' },
        to: { type: 'agent', ref: f.worker.id }, execution_scope: turn.execution_scope,
        message_kind: 'request', wake_requested: 'now', body_md: 'Late unoffered now' });
      expect(late.turn_id).toBe(turn.id);
      expect(late.message.wake_applied).toBe('now');
      expect(late.message.seq).toBeGreaterThan(offer.input_to_seq);
      return { ...f, id, turn, bridge, offer, late };
    }
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      it(`B2: ${kind} ${status} re-rings an unoffered now in its own scope`, () => {
        const f = startedStandalone();
        const other = f.store.sendMessage({ session_id: f.turn.session_id, sender: { type: 'member', id: 'mem_local_local' },
          to: { type: 'agent', ref: f.worker.id }, execution_scope: 'other_scope',
          message_kind: 'request', wake_requested: 'next_turn', body_md: 'Other scope' });
        if (status === 'completed') {
          const input = { payload: { turn_id: f.turn.id, attempt_id: f.id, input_to_seq: f.offer.input_to_seq,
            reply: { body_md: 'Completed original input', message_kind: 'final' as const } }, completionFields: null };
          expect(f.bridge.complete(input, scope).ok).toBe(true);
          expect(f.bridge.complete(input, scope).ok).toBe(true);
        } else if (status === 'failed') f.store.failTask(f.id, { error: 'Final failure', failureReason: 'agent_error' });
        else f.store.cancelTurn(f.turn.id);
        expect(f.store.getTurn(f.turn.id)?.status).toBe(status);
        const turns = f.store.listTurns({ session_id: f.turn.session_id, workspace_id: 'local' });
        expect(turns).toHaveLength(2);
        const successor = turns.find(t => t.id !== f.turn.id)!;
        expect(successor).toMatchObject({ status: 'pending', execution_scope: f.turn.execution_scope, trigger_message_id: f.late.message.id });
        expect(successor.trigger_message_id).not.toBe(other.message.id);
        expect(f.store.getSessionAgentReadProgress(f.turn.session_id, f.worker.id, f.id).seq).toBe(f.offer.input_to_seq);
        const claimed = f.store.claimTask(scope.runtimeId)!;
        expect(claimed.id).toBe(successor.current_attempt_id!);
        f.store.startTask(claimed.id);
        expect(f.bridge.offerInput(f.store.getTaskWithAgent(claimed.id)!).input_messages.some(m => m.id === f.late.message.id)).toBe(true);
      }, 30_000);
    }
    it(`B2: ${kind} keeps the offered-now completion barrier and creates no extra turn after consumption`, () => {
      const f = startedStandalone();
      const snapshot = f.bridge.snapshot(scope, new Set([f.id]));
      expect(snapshot.messages.map(m => m.message.id)).toEqual([f.late.message.id]);
      const input = { payload: { turn_id: f.turn.id, attempt_id: f.id, input_to_seq: f.offer.input_to_seq,
        reply: { body_md: 'Done', message_kind: 'final' as const } }, completionFields: null };
      expect(f.bridge.complete(input, scope)).toMatchObject({ ok: false, code: 'turn_input_pending' });
      expect(f.store.listTurns({ session_id: f.turn.session_id, workspace_id: 'local' })).toHaveLength(1);
      expect(f.bridge.rpc('turn.input', { turn_id: f.turn.id, attempt_id: f.id, input_to_seq: f.late.message.seq,
        message_ids: [f.late.message.id] }, scope).ok).toBe(true);
      input.payload.input_to_seq = f.late.message.seq;
      expect(f.bridge.complete(input, scope).ok).toBe(true);
      expect(f.store.listTurns({ session_id: f.turn.session_id, workspace_id: 'local' })).toHaveLength(1);
    }, 30_000);
  }

  it('B3: Topic CLI reads stay on its Chat through replacement and the next frozen round', async () => {
    const f = setup(), target = f.topic('Destination B'), source = f.running();
    f.message(target, source.id, 'FOREIGN_BOUND_ISSUE_BODY');
    f.store.completeTask(source.id, { output: 'Source done' });
    const body = '😀中文'.repeat(30_000);
    const first = f.store.sendMessage({ session_id: target.chat.id, sender: { type: 'member', id: 'mem_local_local' },
      to: { type: 'agent', ref: f.concierge.id }, message_kind: 'request', wake_requested: 'inbox_only', body_md: body }).message;
    const claimed = f.store.claimTask(scope.runtimeId)!;
    expect(claimed.chatSessionId).toBe(target.chat.id);
    const issueHead = f.store.getConversationLogHead(target.session.id)!.headSeq;
    const head = f.store.getConversationLogHead(target.chat.id)!.headSeq;
    expect(daemonTaskClaimResponse(f.store, claimed).bound_issue_log).toMatchObject({ from_seq: 0, to_seq: issueHead });
    f.store.startTask(claimed.id);
    const app = createMultiremiApp({ store: f.store, authToken: 'test-master' });
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch });
    async function read(attemptId: string, from: number, to: number, sessionId = target.chat.id, denied = false) {
      const token = await f.store.createTaskAccessToken(f.store.getTask(attemptId)!, 'local');
      const child = Bun.spawn([process.execPath, 'apps/remi/main.ts', 'message', 'list', sessionId,
        '--from', String(from), '--to', String(to), '--output', 'json'], {
        cwd: process.cwd(), env: { ...process.env, MULTIREMI_SERVER_URL: server.url.origin, MULTIREMI_TOKEN: token.token, MULTIREMI_WORKSPACE_ID: 'local' },
        stdout: 'pipe', stderr: 'pipe',
      });
      const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, error).toBe(denied ? 1 : 0);
      if (denied) {
        expect(error).toContain('forbidden outside current Session');
        expect(output).not.toContain('FOREIGN_BOUND_ISSUE_BODY');
        return [];
      }
      return JSON.parse(output) as Array<{ id: string; body_md: string }>;
    }
    const progress = (attemptId: string) => f.store.getSessionAgentReadProgress(target.chat.id, f.concierge.id, attemptId);
    const foreignProgress = (attemptId: string) => f.store.getSessionAgentReadProgress(target.session.id, f.concierge.id, attemptId);
    const receipt = (attemptId = claimed.id) => f.db.query('SELECT input_ack_seq,input_read_seq,input_read_offset FROM multiremi_turn_attempts WHERE id=?').get(attemptId);
    async function expectOfferedRange(attemptId: string, ownFrom: number, ownTo: number, boundTo: number) {
      const offered = await prepareTaskOffer(f.store, f.store.getTaskWithAgent(attemptId)!,
        new ProjectKnowledgeService(f.store, null, 'sql'), new RepositoryWikiService(f.store, null, 'sql'), true);
      expect(offered).toBeTruthy();
      expect(offered!.attempt_id).toBe(attemptId);
      fitTaskOfferToBudget(offered!, scope.runtimeId, undefined, true);
      const bound = offered!.bound_issue_log as { session_id: string; from_seq: number; to_seq: number; content_jsonl: string };
      expect(bound).toMatchObject({ session_id: target.session.id, from_seq: 0, to_seq: boundTo });
      expect(bound.content_jsonl).not.toContain('FOREIGN_BOUND_ISSUE_BODY');
      expect(bound.content_jsonl).not.toContain(`remi message list ${target.session.id}`);
      const own = offered!.session_projection as { from_seq: number; to_seq: number; jsonl: string };
      expect(own).toMatchObject({ from_seq: ownFrom, to_seq: ownTo });
      expect(JSON.parse(own.jsonl.split('\n')[0])).toMatchObject({ type: 'unread_range', session_id: target.chat.id,
        from_seq: ownFrom, to_seq: ownTo });
      expect(own.jsonl).toContain(`remi message list ${target.chat.id} --from ${ownFrom} --to ${ownTo}`);
      const prompt = buildTaskPrompt(normalizeDaemonClaimTask(offered)!);
      expect(prompt).toContain(own.jsonl.split('\n')[0]);
      expect(prompt).not.toContain(`remi message list ${target.session.id}`);
      return offered!;
    }
    try {
      const before = receipt();
      f.store.recordSessionAgentRangeRead(target.chat.id, f.concierge.id, { seq: 1, offset: 0 }, { seq: first.seq, offset: 32_000 }, claimed.id);
      expect(progress(claimed.id)).toEqual({ seq: first.seq - 1, offset: 32_000 });
      expect(receipt()).toMatchObject({ input_ack_seq: before.input_ack_seq ?? 0, input_read_seq: first.seq - 1, input_read_offset: 32_000 });
      const partial = receipt();
      const foreignBefore = foreignProgress(claimed.id);
      await read(claimed.id, 0, issueHead, target.session.id, true);
      expect(foreignProgress(claimed.id)).toEqual(foreignBefore);
      expect(f.store.getSessionAgentReadProgress(target.session.id, f.concierge.id)).toEqual({ seq: 0, offset: 0 });
      expect(receipt()).toEqual(partial);
      expect((await read(claimed.id, 0, head)).find(m => m.id === first.id)?.body_md).toBe(body);
      expect(progress(claimed.id)).toEqual({ seq: head, offset: 0 });
      expect(receipt()).toMatchObject({ input_ack_seq: before.input_ack_seq ?? 0, input_read_seq: head, input_read_offset: 0 });
      const turn = f.store.getTurnForAttempt(claimed.id)!;
      const bridge = f.store.getDaemonTurnBridge(), input = bridge.offerInput(f.store.getTaskWithAgent(claimed.id)!);
      expect(bridge.rpc('turn.input', { turn_id: turn.id, attempt_id: claimed.id, input_to_seq: input.input_to_seq,
        message_ids: input.input_messages.map(message => message.id) }, scope).ok).toBe(true);
      expect(receipt().input_ack_seq).toBe(input.input_to_seq);
      const replacement = f.store.retryTurn(turn.id).current_attempt_id!;
      expect(f.store.claimTask(scope.runtimeId)?.id).toBe(replacement);
      await expectOfferedRange(replacement, 0, head, issueHead);
      f.store.startTask(replacement);
      expect(() => progress(claimed.id)).toThrow('stale_attempt');
      const foreignReplacement = foreignProgress(replacement), replacementReceipt = receipt(replacement);
      await read(replacement, 0, issueHead, target.session.id, true);
      expect(foreignProgress(replacement)).toEqual(foreignReplacement);
      expect(receipt(replacement)).toEqual(replacementReceipt);
      expect((await read(replacement, 0, head)).find(m => m.id === first.id)?.body_md).toBe(body);
      expect(progress(replacement)).toEqual({ seq: head, offset: 0 });
      f.store.completeTask(replacement, { output: 'First relay done', sessionId: 'b3_relay_provider' });
      const nextSource = f.running(), issueIncrement = f.message(target, nextSource.id, 'FOREIGN_BOUND_ISSUE_BODY next');
      f.store.completeTask(nextSource.id, { output: 'Second source done' });
      const increment = f.store.sendMessage({ session_id: target.chat.id, sender: { type: 'member', id: 'mem_local_local' },
        to: { type: 'agent', ref: f.concierge.id }, message_kind: 'request', wake_requested: 'inbox_only', body_md: 'Own Chat increment' }).message;
      const next = f.store.claimTask(scope.runtimeId)!;
      expect(next.chatSessionId).toBe(target.chat.id);
      const nextOffer = daemonTaskClaimResponse(f.store, next);
      const nextFrom = f.store.getTask(next.id)!.projectionFromSeq!;
      expect(nextFrom).toBeGreaterThanOrEqual(head);
      expect(nextOffer.bound_issue_log).toMatchObject({ from_seq: 0, to_seq: issueIncrement.seq });
      const frozen = await expectOfferedRange(next.id, nextFrom, increment.seq, issueIncrement.seq);
      const later = f.store.sendMessage({ session_id: target.chat.id, sender: { type: 'member', id: 'mem_local_local' },
        to: { type: 'none' }, message_kind: 'request', wake_requested: 'inbox_only', body_md: 'After the frozen claim' }).message;
      expect(frozen.input_to_seq).toBeLessThan(later.seq);
      expect((frozen.input_messages as Array<{ id: string }>).some(message => message.id === later.id)).toBe(false);
      f.store.startTask(next.id);
      const nextForeignProgress = foreignProgress(next.id), nextReceipt = receipt(next.id);
      await read(next.id, 0, issueIncrement.seq, target.session.id, true);
      expect(foreignProgress(next.id)).toEqual(nextForeignProgress);
      expect(receipt(next.id)).toEqual(nextReceipt);
      const range = await read(next.id, nextFrom, increment.seq);
      expect(range.find(m => m.id === increment.id)?.body_md).toBe('Own Chat increment');
      expect(range.some(m => m.id === first.id)).toBe(false);
      expect(range.some(m => m.id === later.id)).toBe(false);
      expect(progress(next.id)).toEqual({ seq: increment.seq, offset: 0 });
      expect(f.store.getSessionAgentReadProgress(target.session.id, f.concierge.id)).toEqual({ seq: 0, offset: 0 });
    } finally { server.stop(true); }
  }, 60_000);
});
