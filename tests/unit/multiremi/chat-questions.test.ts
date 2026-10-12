import { expect, it } from 'bun:test';
import { pendingTurnBackendTests, type PendingTurnTestFixture } from './pending-turn-test-backends.js';
import { StoreContext, createCommitEventQueue } from '@multiremi/store/context.js';
import { refreshChatQuestionsAfterResponsibilityChangeWithinTransaction } from '@multiremi/store/inbox/questions.js';

function setup(f: PendingTurnTestFixture, transport = false, native = true, creatorId = 'local') {
  const { store, db } = f;
  const runtime = store.registerRuntime({ name: 'Chat Q host', provider: 'codex', daemonId: 'chat-q-daemon', maxConcurrency: 8 });
  const agent = store.createAgent({ name: 'Chat source', provider: 'codex' });
  const chat = store.createChatSession({ agentId: agent.id, creatorId, title: 'Original Chat' });
  if (transport) {
    const at = new Date().toISOString();
    db.run('INSERT INTO multiremi_feishu_bot_chat_bindings(id,workspace_id,app_id,agent_id,external_session_key,chat_session_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      ['fbb_chat_q', 'local', 'cli_chat_q', agent.id, 'transport_chat_q', chat.id, at, at]);
  }
  const task = store.createTask({ agentId: agent.id, chatSessionId: chat.id, prompt: 'Original Chat work' });
  expect(store.claimTask(runtime.id)?.id).toBe(task.id); store.startTask(task.id);
  const turn = store.getTurnForAttempt(task.id)!;
  let questionId: string;
  if (native) {
    const response = store.getDaemonTurnBridge().rpc('turn.decision', { turn_id: turn.id, attempt_id: task.id, wait_id: `chat_wait_${task.id}`, dedupe_key: `chat_question_${task.id}`, options: [{ label: 'A', value: 'A' }],
      body_md: 'Choose Chat direction', metadata: { kind: 'question', questions: [{ fieldKey: 'direction', question: { question: 'Choose Chat direction', options: [{ label: 'A' }] } }] } },
      { runtimeId: runtime.id, daemonId: 'chat-q-daemon', workspaceId: 'local' });
    expect(response).toMatchObject({ ok: true }); questionId = String(response.message_id);
  } else questionId = store.createTaskHumanRequest({ taskId: task.id, kind: 'question', payload: { questions: [{ fieldKey: 'direction', question: { question: 'Choose Chat direction', options: [{ label: 'A' }] } }] } }).id;
  const ctx = new StoreContext(db, () => store);
  const refresh = (filter: { transportOnly?: boolean; memberId?: string; agentId?: string } = {}) => refreshChatQuestionsAfterResponsibilityChangeWithinTransaction(ctx, 'local', createCommitEventQueue(), undefined, 'chat_responsibility_transferred', filter);
  return { ...f, ctx, runtime, agent, chat, task, turn, questionId, refresh };
}

pendingTurnBackendTests('Chat question shared workspace responsibility', fixture => {
  it('an unresolved historical creator routes to the shared operator without a fuzzy member lookup', () => {
    const f = fixture();
    const user = f.store.getOrCreateUser({ externalId: 'chat_q_name_impostor', name: 'Ambiguous Chat creator' });
    const other = f.store.createWorkspaceMember({ workspaceId: 'local', userId: user.id, name: 'Ambiguous Chat creator', role: 'member' });
    const h = setup(f, false, true, 'Ambiguous Chat creator');
    expect(h.store.getQuestion(h.questionId)).toMatchObject({ current_handler: { type: 'member', id: 'mem_local_local' }, route_reason: null });
    expect(h.store.getQuestion(h.questionId)?.current_handler?.id).not.toBe(other.id);
    const before = h.store.getMessage(h.questionId)!.revision;
    h.store.getQuestion(h.questionId);
    expect(h.store.getMessage(h.questionId)!.revision).toBe(before);
  });
  it('source Agent changes refresh the same Q while historical member changes do not change the shared handler', () => {
    const h = setup(fixture());
    expect(h.store.getQuestion(h.questionId)).toMatchObject({ current_handler: { type: 'member', id: 'mem_local_local' }, wait_status: 'waiting', route_revision: 1 });
    h.db.transaction(() => { h.store.archiveAgent(h.agent.id); h.refresh({ agentId: h.agent.id }); })();
    expect(h.store.getQuestion(h.questionId)).toMatchObject({ current_handler: { id: 'mem_local_local' }, route_revision: 2 });
    const user = h.store.getOrCreateUser({ externalId: 'chat_q_old_contact', name: 'Old contact' });
    const member = h.store.createWorkspaceMember({ workspaceId: 'local', userId: user.id, name: user.name, role: 'member' });
    h.db.transaction(() => { h.store.archiveWorkspaceMember(member.id); h.refresh({ memberId: member.id }); })();
    expect(h.store.getQuestion(h.questionId)).toMatchObject({ current_handler: { id: 'mem_local_local' }, route_revision: 2 });
  });
  it('Feishu Chat needs no configured human and external card credentials still bind the recipient and route', () => {
    const h = setup(fixture(), true);
    expect(h.store.getQuestion(h.questionId)).toMatchObject({ current_handler: { id: 'mem_local_local' }, route_reason: null });
    const token = h.store.issueMessageCardToken(h.questionId, 'ou_designated');
    const credential = { token, operatorOpenId: 'ou_other', routeRevision: 1 };
    expect(() => h.store.answerQuestion(h.questionId, { expected_route_revision: 1, response: { answer: 'A' } },
      { type: 'member', id: 'mem_local_local' }, undefined, credential)).toThrow();
    expect(h.store.getQuestion(h.questionId)?.status).toBe('pending');
    expect(h.store.getMessage(h.questionId)?.card_token_consumed_at).toBeNull();
    const answer = h.store.answerQuestion(h.questionId, { expected_route_revision: 1, response: { answer: 'A' } },
      { type: 'member', id: 'mem_local_local' });
    expect(answer.question.status).toBe('answered');
  });
  it('compatibility creation without a native wait nonce cannot treat running DB status as a live callback', () => {
    const h = setup(fixture(), false, false);
    expect(h.store.getTask(h.task.id)?.status).toBe('awaiting_human');
    expect(h.store.getQuestion(h.questionId)).toMatchObject({ wait_status: 'detached', wait_reason: 'native_wait_unverified' });
    const answer = h.store.answerQuestion(h.questionId, { expected_route_revision: 1, response: { answer: 'A' } }, { type: 'member', id: 'mem_local_local' });
    expect(answer.question).toMatchObject({ status: 'answered', wait_status: 'continuation_pending' });
    expect(answer.message.to_agent_id).toBeNull();
    expect(h.store.getTask(h.task.id)?.status).toBe('cancelled');
    const consumer = h.store.getTurn(answer.question.recovery.consumer_turn_id!)!;
    expect(consumer).toMatchObject({ session_id: h.chat.id, agent_id: h.agent.id });
    expect(h.store.getTask(consumer.current_attempt_id!)?.continuedFromTaskId).toBe(h.task.id);
  });
});
