import { expect, it } from 'bun:test';
import { pendingTurnBackendTests, type PendingTurnTestFixture } from './pending-turn-test-backends.js';

function setup(fixture: PendingTurnTestFixture, kind: 'orphan' | 'autopilot', nativeWait = true) {
  const { store, db } = fixture;
  const runtime = store.registerRuntime({ name: 'Issue-free Q runtime', provider: 'codex', daemonId: 'issue-free-q' });
  const agent = store.createAgent({ name: 'Issue-free Q worker', provider: 'codex', runtimeId: runtime.id });
  const autopilot = kind === 'autopilot' ? store.createAutopilot({ title: 'Native run-only Q',
    assigneeId: agent.id, executionMode: 'run_only' }) : null;
  const run = autopilot ? store.runAutopilot(autopilot.id, { prompt: 'Ask in the automation conversation' }) : null;
  const task = run ? store.getTask(run.taskId!)!
    : store.createTask({ agentId: agent.id, runtimeId: runtime.id, prompt: 'Ask without an Issue or Chat' });
  expect(store.claimTask(runtime.id)?.id).toBe(task.id);
  store.startTask(task.id);
  const turn = store.getTurnForAttempt(task.id)!;
  const bridge = store.getDaemonTurnBridge();
  const scope = { runtimeId: runtime.id, daemonId: runtime.daemonId!, workspaceId: 'local' };
  const create = (attemptId = task.id, wait = nativeWait) => bridge.rpc('turn.decision', {
    turn_id: turn.id, attempt_id: attemptId, dedupe_key: `native-free:${attemptId}`,
    ...(wait ? { wait_id: `native-free:${attemptId}` } : {}), body_md: 'SOURCE_ONLY_ISSUE_FREE_QUESTION',
    options: [{ label: 'A', value: 'A' }], metadata: { kind: 'question', questions: [{ question: 'Proceed?' }] },
  }, scope);
  const result = create();
  expect(result.ok).toBe(true);
  const id = String(result.message_id);
  return { store, db, runtime, agent, autopilot, run, task, turn, bridge, scope, create, id };
}

pendingTurnBackendTests('Issue-free native Question ownership', fixture => {
  for (const kind of ['orphan', 'autopilot'] as const) {
    it(`${kind} keeps registered native waiting, timeout and completed-source history distinct`, () => {
      const h = setup(fixture(), kind);
      const message = h.store.getMessage(h.id)!;
      expect(message).toMatchObject({ task_id: h.turn.id, session_id: h.turn.session_id,
        sender_type: 'agent', sender_id: h.agent.id });
      expect(h.store.getIssueSession(message.session_id)).toBeNull();
      expect(h.store.getChatSession(message.session_id)).toBeNull();
      expect(h.db.query('SELECT workspace_id FROM multiremi_conversation_heads WHERE session_id=?').get(message.session_id))
        .toEqual({ workspace_id: 'local' });
      expect(h.store.getQuestion(h.id)).toMatchObject({ source_issue_id: null, source_attempt_id: h.task.id,
        source_turn_id: h.turn.id, status: 'pending', wait_status: 'waiting' });
      const before = h.store.getMessage(h.id);
      expect(h.store.getQuestion(h.id)?.current_handler).toBeNull();
      expect(h.store.getMessage(h.id)).toEqual(before);

      expect(h.bridge.rpc('turn.decision.expire', { turn_id: h.turn.id, attempt_id: h.task.id,
        message_id: h.id, status: 'timeout' }, h.scope).ok).toBe(true);
      expect(h.store.getQuestion(h.id)).toMatchObject({ status: 'pending', wait_status: 'detached', wait_reason: 'timeout' });
      h.store.completeTask(h.task.id, { output: 'The original provider continued conservatively' });
      expect(h.store.getTask(h.task.id)?.status).toBe('completed');
      expect(h.store.getQuestion(h.id)).toMatchObject({ status: 'pending', wait_status: 'detached', wait_reason: 'timeout' });
    });

    it(`${kind} preserves original Q identity across a real attempt replacement without reviving its callback`, () => {
      const h = setup(fixture(), kind);
      expect(h.bridge.rpc('turn.decision.expire', { turn_id: h.turn.id, attempt_id: h.task.id,
        message_id: h.id, status: 'timeout' }, h.scope).ok).toBe(true);
      const original = h.store.getMessage(h.id)!;
      const replacement = h.store.retryTurn(h.turn.id, true);
      expect(replacement.current_attempt_id).not.toBe(h.task.id);
      expect(replacement.session_id).toBe(h.turn.session_id);
      expect(h.store.getQuestion(h.id)).toMatchObject({ source_attempt_id: h.task.id,
        status: 'pending', wait_status: 'detached', wait_reason: 'timeout' });
      expect(h.store.getMessage(h.id)).toEqual(original);
      const nextId = replacement.current_attempt_id!;
      expect(h.store.getTask(nextId)?.runtimeId).toBeNull();
      expect(h.store.claimTask(h.runtime.id)?.id).toBe(nextId);
      expect(h.store.getTask(nextId)?.runtimeId).toBe(h.runtime.id);
      h.store.startTask(nextId);
      const next = h.create(nextId);
      expect(next.ok).toBe(true);
      expect(String(next.message_id)).not.toBe(h.id);
      expect(h.store.getQuestion(String(next.message_id))).toMatchObject({ source_attempt_id: nextId,
        source_turn_id: h.turn.id, wait_status: 'waiting' });
      expect(h.store.getQuestion(h.id)).toMatchObject({ source_attempt_id: h.task.id,
        wait_status: 'detached', wait_reason: 'timeout' });
      expect(h.bridge.rpc('turn.decision.get', { turn_id: h.turn.id, attempt_id: h.task.id, message_id: h.id }, h.scope).ok)
        .toBe(false);
      expect(h.store.getMessage(h.id)).toEqual(original);
    });

    it(`${kind} rejects corrupt source facts and cannot treat a historical decision as a native registration`, () => {
      const h = setup(fixture(), kind);
      const original = h.store.getMessage(h.id)!;
      const metadata = original.metadata as Record<string, any>;
      const foreign = h.store.createWorkspace({ name: 'Foreign native Q source', slug: `foreign-native-q-${kind}` });
      const assertRejected = () => {
        const before = h.store.getMessage(h.id);
        expect(h.store.getQuestion(h.id)).toMatchObject({ wait_status: 'detached', wait_reason: 'source_workspace_changed' });
        expect(h.store.getMessage(h.id)).toEqual(before);
      };
      for (const workspaceId of [null, foreign.id]) {
        h.db.run('UPDATE multiremi_conversation_heads SET workspace_id=? WHERE session_id=?', [workspaceId, original.session_id]);
        assertRejected();
      }
      h.db.run('UPDATE multiremi_conversation_heads SET workspace_id=? WHERE session_id=?', ['local', original.session_id]);
      const unrelated = h.store.createTask({ agentId: h.agent.id, runtimeId: h.runtime.id, prompt: 'Another real original request' });
      for (const mutation of [
        { source_attempt_id: unrelated.id }, { source_issue_id: 'missing_issue' }, { workspace_id: foreign.id },
      ]) {
        h.db.run('UPDATE multiremi_conversation_log SET metadata=? WHERE id=?',
          [JSON.stringify({ ...metadata, question: { ...metadata.question, ...mutation } }), h.id]);
        assertRejected();
      }
      h.db.run('UPDATE multiremi_conversation_log SET metadata=? WHERE id=?', [JSON.stringify(metadata), h.id]);
      h.db.run('UPDATE multiremi_conversation_log SET sender_id=? WHERE id=?', [null, h.id]);
      assertRejected();
      h.db.run('UPDATE multiremi_conversation_log SET sender_id=? WHERE id=?', [h.agent.id, h.id]);

      if (h.run) {
        h.db.run('UPDATE multiremi_autopilot_runs SET turn_id=? WHERE id=?', [unrelated.id, h.run.id]);
        assertRejected();
        h.db.run('UPDATE multiremi_autopilot_runs SET turn_id=? WHERE id=?', [h.turn.id, h.run.id]);
      } else {
        const counterfeit = `auto_orphan_${unrelated.id}`;
        const head = h.db.query('SELECT head_seq,workspace_id FROM multiremi_conversation_heads WHERE session_id=?').get(counterfeit)!;
        expect(head.workspace_id).toBe('local');
        const turnSeq = Number(head.head_seq) + 1, messageSeq = turnSeq + 1;
        h.db.run('UPDATE multiremi_turns SET session_id=?,seq=? WHERE id=?', [counterfeit, turnSeq, h.turn.id]);
        h.db.run('UPDATE multiremi_conversation_log SET session_id=?,seq=? WHERE id=?', [counterfeit, messageSeq, h.id]);
        h.db.run('UPDATE multiremi_conversation_heads SET head_seq=? WHERE session_id=?', [messageSeq, counterfeit]);
        assertRejected();
        h.db.run('UPDATE multiremi_turns SET session_id=?,seq=? WHERE id=?', [original.session_id, h.turn.seq, h.turn.id]);
        h.db.run('UPDATE multiremi_conversation_log SET session_id=?,seq=? WHERE id=?', [original.session_id, original.seq, h.id]);
        h.db.run('UPDATE multiremi_conversation_heads SET head_seq=? WHERE session_id=?', [head.head_seq, counterfeit]);
      }
      expect(h.store.getQuestion(h.id)?.wait_status).toBe('waiting');
      expect(h.store.getMessage(h.id)).toEqual(original);

      const human = h.store.createWorkspaceMember({ workspaceId: foreign.id, name: 'Foreign Issue human' });
      const issue = h.store.createIssue({ workspaceId: foreign.id, title: 'Conflicting declared owner', responsibleMemberId: human.id });
      h.db.run(`INSERT INTO multiremi_issue_sessions
        (id,issue_id,workspace_id,title,created_by_type,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?)`, [original.session_id, issue.id, 'local', 'Corrupt native identity', 'system', original.created_at, original.created_at]);
      expect(h.store.getIssueSessionWithOwnerScope(original.session_id)?.ownerWorkspaceId).toBeNull();
      assertRejected();
      h.db.run('DELETE FROM multiremi_issue_sessions WHERE id=?', [original.session_id]);
      expect(h.store.getQuestion(h.id)?.wait_status).toBe('waiting');

      const historical = h.store.sendMessage({ session_id: original.session_id, sender: { type: 'agent', id: h.agent.id },
        source_turn_id: h.turn.id, to: { type: 'none' }, message_kind: 'decision', wake_requested: 'inbox_only',
        body_md: 'Historical decision with a source attempt reference', metadata: { source_attempt_id: h.task.id,
          human_request: { kind: 'question', payload: { questions: [] }, status: 'pending' } } }).message;
      expect(h.store.getQuestion(historical.id)).toBeNull();
      expect(h.store.getMessage(historical.id)).toEqual(historical);
    });
  }

  it('does not recover a waiting callback from an Issue-free native registration without a nonce', () => {
    const h = setup(fixture(), 'orphan', false);
    const before = h.store.getMessage(h.id);
    expect(h.store.getQuestion(h.id)).toMatchObject({ status: 'pending', wait_status: 'detached', wait_reason: 'native_wait_unverified' });
    expect(h.store.getMessage(h.id)).toEqual(before);
  });
});
