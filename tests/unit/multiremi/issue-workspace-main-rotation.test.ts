import { expect, it } from 'bun:test';
import { createMultiremiApp } from '@multiremi/api.js';
import { MultiremiStore } from '@multiremi/store.js';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';
import { runMigrations } from '@multiremi/store/migrations.js';

pendingTurnBackendTests('explicit Issue workspace Main rotation', (fixture, backend) => {
  for (const prefix of ['/api/issues', '/api/multiremi/issues']) {
    it(`${prefix} preserves source history, creates a target Main and rolls back a failed dispatch`, async () => {
      const { store, db } = fixture();
      const sourceAgent = store.createAgent({ name: 'Source execution', provider: 'codex' });
      const issue = store.createIssue({ title: 'Movable Issue', responsibleMemberId: 'mem_local_local', assigneeType: 'agent', assigneeId: sourceAgent.id });
      const sourceMain = store.getOrCreateDefaultIssueSession(issue.id);
      const oldComment = store.createIssueComment(issue.id, { body: 'SOURCE_ONLY_PRIVATE_HISTORY' });
      const runtime = store.registerRuntime({ name: 'Source Q Runtime', provider: 'codex', daemonId: 'rotation-source', maxConcurrency: 8 });
      const sourceTask = store.createTask({ agentId: sourceAgent.id, issueId: issue.id, prompt: 'SOURCE_ONLY_PRIVATE_TASK' });
      expect(store.claimTask(runtime.id)?.id).toBe(sourceTask.id);
      store.startTask(sourceTask.id);
      const sourceTurn = store.getTurnForAttempt(sourceTask.id)!;
      const decision = store.getDaemonTurnBridge().rpc('turn.decision', { turn_id: sourceTurn.id, attempt_id: sourceTask.id,
        dedupe_key: 'move-source-question', body_md: 'SOURCE_ONLY_PRIVATE_QUESTION', options: [{ label: 'A', value: 'A' }],
        metadata: { kind: 'question' }, timeout_ms: 1_000,
      }, { runtimeId: runtime.id, daemonId: 'rotation-source', workspaceId: 'local' });
      expect(decision.ok).toBeTrue();
      const questionId = String(decision.message_id);
      const oldDelivery = store.submitIssueDelivery(issue.id, { summary: 'SOURCE_ONLY_PRIVATE_FORMAL_DELIVERY' },
        { type: 'agent', id: sourceAgent.id, taskId: sourceTask.id });
      // Cancellation can append a detached-Q status notification after the
      // first task snapshot. Stop that real notification too before moving.
      for (let pass = 0; pass < 3; pass++) for (const task of store.listTasksForIssue(issue.id)) {
        if (!['completed', 'failed', 'cancelled'].includes(task.status)) store.cancelTask(task.id);
      }
      expect(store.listTasksForIssue(issue.id).every(task => ['completed', 'failed', 'cancelled'].includes(task.status))).toBeTrue();
      const target = store.createWorkspace({ name: 'Target workspace', slug: `main-rotation-${prefix.includes('multiremi') ? 'native' : 'compat'}` });
      const targetUser = store.getOrCreateUser({ externalId: 'main-rotation-target-user', name: 'Target reader' });
      const targetHuman = store.createWorkspaceMember({ workspaceId: target.id, userId: targetUser.id, name: 'Target reader', role: 'owner' });
      const targetAgent = store.createAgent({ name: 'Target execution', provider: 'codex', workspaceId: target.id });
      const app = createMultiremiApp({ store, authToken: 'MASTER', shareSecret: 'main-rotation-share' });
      const move = () => app.request(`${prefix}/${issue.id}`, { method: 'PATCH', headers: { Authorization: 'Bearer MASTER', 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: target.id, responsible_member_id: targetHuman.id, assignee_type: 'agent', assignee_id: targetAgent.id }) });
      const oldQuestion = store.getMessage(questionId)!;
      const beforeMove = store.getIssue(issue.id)!;
      const beforeMain = store.getIssueSession(sourceMain.id)!;
      db.run('UPDATE multiremi_issue_activity SET workspace_id=NULL WHERE issue_id=? AND body=?', [issue.id, oldComment.body]);
      const beforeOrigins = db.query('SELECT id,workspace_id FROM multiremi_issue_activity WHERE issue_id=? ORDER BY id').all(issue.id);
      const oldActivity = store.listIssueActivity(issue.id);
      const events: unknown[] = [];
      store.onWorkspaceEvent(event => events.push(event));
      if (backend === 'PostgreSQL') {
        db.run(`CREATE FUNCTION reject_rotation_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.agent_id='${targetAgent.id}' THEN RAISE EXCEPTION 'rotation dispatch fault'; END IF; RETURN NEW; END $$`);
        db.exec('CREATE TRIGGER reject_rotation_dispatch BEFORE INSERT ON multiremi_turns FOR EACH ROW EXECUTE FUNCTION reject_rotation_dispatch()');
      } else db.exec(`CREATE TRIGGER reject_rotation_dispatch BEFORE INSERT ON multiremi_turns WHEN NEW.agent_id='${targetAgent.id}' BEGIN SELECT RAISE(ABORT,'rotation dispatch fault'); END`);
      const failed = await move();
      expect(failed.status, await failed.clone().text()).toBe(500);
      expect(await failed.text()).toContain('rotation dispatch fault');
      expect(store.getIssue(issue.id)).toEqual(beforeMove);
      expect(store.getIssueSession(sourceMain.id)).toEqual(beforeMain);
      expect(store.listIssueSessions(issue.id, true).map(session => session.id)).toEqual([sourceMain.id]);
      expect(store.listIssueActivity(issue.id)).toEqual(oldActivity);
      expect(db.query('SELECT id,workspace_id FROM multiremi_issue_activity WHERE issue_id=? ORDER BY id').all(issue.id)).toEqual(beforeOrigins);
      expect(store.getMessage(questionId)).toEqual(oldQuestion);
      expect(db.query('SELECT session_id FROM multiremi_conversation_heads WHERE workspace_id=?').all(target.id)).toEqual([]);
      expect(events).toEqual([]);
      if (backend === 'PostgreSQL') db.exec('DROP TRIGGER reject_rotation_dispatch ON multiremi_turns');
      else db.exec('DROP TRIGGER reject_rotation_dispatch');
      const moved = await move();
      expect(moved.status, await moved.clone().text()).toBe(200);
      const main = store.getOrCreateDefaultIssueSession(issue.id);
      expect(main.id).not.toBe(sourceMain.id);
      expect(main).toMatchObject({ workspaceId: target.id, isDefault: true, parentSessionId: null, inheritMode: 'none' });
      expect(store.getIssueSession(sourceMain.id)).toMatchObject({ workspaceId: 'local', isDefault: false });
      expect(store.getMessage(oldComment.id)?.body_md).toBe('SOURCE_ONLY_PRIVATE_HISTORY');
      expect(store.getMessage(questionId)?.session_id).toBe(sourceMain.id);
      expect(store.getMessage(oldDelivery.id)?.body_md).toBe('SOURCE_ONLY_PRIVATE_FORMAL_DELIVERY');
      expect(store.listIssueDeliveries(issue.id)).toEqual([]);
      expect(store.getTask(sourceTask.id)).toMatchObject({ workspaceId: 'local', issueSessionId: sourceMain.id, status: 'cancelled' });
      expect(store.listTasksForIssue(issue.id)).toHaveLength(1);
      expect(store.listTasksForIssue(issue.id)[0]).toMatchObject({ agentId: targetAgent.id, workspaceId: target.id, issueSessionId: main.id });
      expect(store.listIssueActivity(issue.id).filter(entry => entry.type === 'issue_main_session_rotated')).toHaveLength(1);
      const targetToken = await store.createAccessToken({ type: 'pat', name: 'Target reader PAT', workspaceId: target.id, userId: targetUser.id });
      const targetHeaders = { Authorization: `Bearer ${targetToken.token}` };
      for (const path of [`/api/multiremi/issues/${issue.id}`, `/api/issues/${issue.id}/sessions?include_archived=true`,
        `/api/issues/${issue.id}/timeline`, `/api/issues/${issue.id}/timeline?limit=100`, `/api/issues/${issue.id}/deliveries`]) {
        const response = await app.request(path, { headers: targetHeaders });
        expect(response.status, path).toBe(200);
        expect(await response.text(), path).not.toContain('SOURCE_ONLY_PRIVATE');
      }
      for (const suffix of ['', '/participants']) {
        expect((await app.request(`/api/issues/${issue.id}/sessions/${sourceMain.id}${suffix}`, { headers: targetHeaders })).status).toBe(404);
      }
      for (const suffix of ['/events', '/tasks']) {
        const retired = await app.request(`/api/issues/${issue.id}/sessions/${sourceMain.id}${suffix}`, { headers: targetHeaders });
        expect(retired.status).toBe(410);
        expect(await retired.json()).toMatchObject({ code: 'route_retired' });
      }
      expect((await app.request(`/api/issues/${issue.id}/timeline?issue_session_id=${sourceMain.id}`, { headers: targetHeaders })).status).toBe(404);
      expect((await app.request(`/api/sessions/${sourceMain.id}/messages`, { headers: targetHeaders })).status).toBe(404);
      expect((await app.request(`/api/messages/${questionId}/question`, { headers: targetHeaders })).status).toBe(404);
      const sourceToken = await store.createAccessToken({ type: 'pat', name: 'Source reader PAT', workspaceId: 'local', userId: 'local' });
      const sourceMessages = await app.request(`/api/sessions/${sourceMain.id}/messages`, { headers: { Authorization: `Bearer ${sourceToken.token}` } });
      expect(sourceMessages.status).toBe(200);
      expect(await sourceMessages.text()).toContain('SOURCE_ONLY_PRIVATE_HISTORY');
      const shared = await app.request(`/api/issues/${issue.id}/share`, { method: 'POST', headers: targetHeaders });
      expect(shared.status).toBe(201);
      const token = (await shared.json() as { share: { token: string } }).share.token;
      const bundle = await app.request(`/api/shares/${token}`, { headers: { 'X-Remi-Share': token } });
      expect(bundle.status).toBe(200);
      expect(await bundle.text()).not.toContain('SOURCE_ONLY_PRIVATE');
    });
  }
  it('initializes legacy head workspaces only when adding the column and preserves later placeholders', () => {
    const { store, db } = fixture();
    const issue = store.createIssue({ title: 'Legacy head column', responsibleMemberId: 'mem_local_local' });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const target = store.createWorkspace({ name: 'Legacy Chat source', slug: 'legacy-chat-source' });
    const human = store.createWorkspaceMember({ workspaceId: target.id, name: 'Legacy Chat reader' });
    const agent = store.createAgent({ name: 'Legacy Chat worker', provider: 'codex', workspaceId: target.id });
    const chat = store.createChatSession({ agentId: agent.id, workspaceId: target.id });
    const chatMain = store.listChatOwnedSessions(chat.id)[0]!;
    const sourceMessage = store.sendMessage({ session_id: main.id, sender: { type: 'platform', id: null },
      to: { type: 'member', ref: 'mem_local_local' }, message_kind: 'report', wake_requested: 'inbox_only',
      body_md: 'Legacy Issue source message' }).message;
    const chatMessage = store.sendMessage({ session_id: chatMain.id, sender: { type: 'platform', id: null },
      to: { type: 'member', ref: human.id }, message_kind: 'report', wake_requested: 'inbox_only',
      body_md: 'Legacy Chat source message' }).message;
    const log = () => db.query('SELECT * FROM multiremi_conversation_log WHERE session_id IN (?,?) ORDER BY session_id,seq')
      .all(main.id, chatMain.id);
    const before = log();

    // This view is the only schema dependency on the old head workspace column.
    db.exec('DROP VIEW multiremi_member_inbox_records');
    db.exec('ALTER TABLE multiremi_conversation_heads DROP COLUMN workspace_id');
    runMigrations(db);

    expect(db.query('SELECT workspace_id FROM multiremi_conversation_heads WHERE session_id=?').get(main.id))
      .toEqual({ workspace_id: 'local' });
    expect(db.query('SELECT workspace_id FROM multiremi_conversation_heads WHERE session_id=?').get(chatMain.id))
      .toEqual({ workspace_id: target.id });
    expect(db.query('SELECT workspace_id,member_id FROM multiremi_member_inbox_records WHERE id=?').get(sourceMessage.id))
      .toEqual({ workspace_id: 'local', member_id: 'mem_local_local' });
    expect(db.query('SELECT workspace_id,member_id FROM multiremi_member_inbox_records WHERE id=?').get(chatMessage.id))
      .toEqual({ workspace_id: target.id, member_id: human.id });
    expect(store.listMessageInbox('mem_local_local', 'local').items.map(message => message.id)).toContain(sourceMessage.id);
    expect(store.listMessageInbox(human.id, target.id).items.map(message => message.id)).toContain(chatMessage.id);
    expect(log()).toEqual(before);

    const placeholder = store.createIssueSession(issue.id, { title: 'New unbound side after upgrade' });
    const head = db.query('SELECT * FROM multiremi_conversation_heads WHERE session_id=?').get(placeholder.id);
    expect(head).toMatchObject({ workspace_id: null });
    runMigrations(db);
    expect(db.query('SELECT * FROM multiremi_conversation_heads WHERE session_id=?').get(placeholder.id)).toEqual(head);
    expect(log()).toEqual(before);
  });

  it('binds a new Main placeholder on its first message without reviving unbound retired heads', () => {
    const { store, db } = fixture();
    const issue = store.createIssue({ title: 'Unbound Main ownership', responsibleMemberId: 'mem_local_local' });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    expect(db.query('SELECT workspace_id FROM multiremi_conversation_heads WHERE session_id=?').get(main.id))
      .toEqual({ workspace_id: null });
    expect(store.getIssueSessionWithOwnerScope(main.id)).toMatchObject({ ownerWorkspaceId: 'local', historicalWorkspaceId: null });
    store.appendSessionEvent(main.id, { authorType: 'system', body: 'First bound source message' });
    expect(db.query('SELECT workspace_id FROM multiremi_conversation_heads WHERE session_id=?').get(main.id))
      .toEqual({ workspace_id: 'local' });
    const target = store.createWorkspace({ name: 'Placeholder target', slug: 'placeholder-target' });
    db.run('UPDATE multiremi_conversation_heads SET workspace_id=? WHERE session_id=?', [target.id, main.id]);
    expect(store.getIssueSessionWithOwnerScope(main.id)).toMatchObject({ ownerWorkspaceId: null, historicalWorkspaceId: null });
    expect(() => store.appendSessionEvent(main.id, { authorType: 'system', body: 'MUST_NOT_BIND_MISMATCH' })).toThrow('owner is unavailable');
    db.run('UPDATE multiremi_conversation_heads SET workspace_id=NULL WHERE session_id=?', [main.id]);
    const human = store.createWorkspaceMember({ workspaceId: target.id, name: 'Placeholder target human' });
    store.updateIssue(issue.id, { workspaceId: target.id, responsibleMemberId: human.id, actorType: 'member', actorId: 'mem_local_local' });
    const targetMain = store.getOrCreateDefaultIssueSession(issue.id);
    db.run('UPDATE multiremi_conversation_heads SET workspace_id=NULL WHERE session_id=?', [targetMain.id]);
    expect(store.getIssueSessionWithOwnerScope(main.id)).toMatchObject({ ownerWorkspaceId: null, historicalWorkspaceId: null });
    const oldLog = db.query('SELECT * FROM multiremi_conversation_log WHERE session_id=? ORDER BY seq').all(main.id);
    db.run("DELETE FROM multiremi_schema_migrations WHERE id='20261008_dual_owned_sessions'");
    runMigrations(db);
    expect(store.getIssueSession(main.id)?.workspaceId).toBe('local');
    expect(db.query('SELECT * FROM multiremi_conversation_log WHERE session_id=? ORDER BY seq').all(main.id)).toEqual(oldLog);
    expect(db.query('SELECT workspace_id FROM multiremi_conversation_heads WHERE session_id=?').get(main.id))
      .toEqual({ workspace_id: null });
    store.updateIssue(issue.id, { workspaceId: 'local', responsibleMemberId: 'mem_local_local', actorType: 'member', actorId: human.id });
    expect(store.getIssueSessionWithOwnerScope(main.id)).toMatchObject({ ownerWorkspaceId: null, historicalWorkspaceId: null });
    expect(() => store.appendSessionEvent(main.id, { authorType: 'system', body: 'MUST_NOT_REVIVE_UNBOUND' })).toThrow('owner is unavailable');
    expect(store.getIssueSessionWithOwnerScope(store.getOrCreateDefaultIssueSession(issue.id).id)?.ownerWorkspaceId).toBe('local');
    expect(db.query('SELECT * FROM multiremi_conversation_log WHERE session_id=? ORDER BY seq').all(main.id)).toEqual(oldLog);
  });

  it('preserves move history when the target Main is adopted by a Chat, detached and then deleted', async () => {
    const f = fixture();
    let store = f.store;
    const { db } = f;
    const issue = store.createIssue({ title: 'Adopted target Main history', responsibleMemberId: 'mem_local_local' });
    const sourceMain = store.getOrCreateDefaultIssueSession(issue.id);
    store.createIssueComment(issue.id, { body: 'SOURCE_ONLY_ADOPTED_MAIN_HISTORY' });
    const agent = store.createAgent({ name: 'Adoption source worker', provider: 'codex' });
    const runtime = store.registerRuntime({ name: 'Adoption source runtime', provider: 'codex' });
    const task = store.createSessionTask(sourceMain.id, { agentId: agent.id, prompt: 'SOURCE_ONLY_ADOPTED_MAIN_INPUT' });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    const question = store.createTaskHumanRequest({ taskId: task.id, kind: 'question', payload: { title: 'SOURCE_ONLY_ADOPTED_MAIN_QUESTION' } });
    store.completeTask(task.id, { output: 'SOURCE_ONLY_ADOPTED_MAIN_OUTPUT' });
    for (const existing of store.listTasksForIssue(issue.id)) {
      if (!['completed', 'failed', 'cancelled'].includes(existing.status)) store.cancelTask(existing.id);
    }
    const target = store.createWorkspace({ name: 'Adopted Main destination', slug: 'adopted-main-destination' });
    const user = store.getOrCreateUser({ externalId: 'adopted-main-destination-human', name: 'Adopted Main destination human' });
    const human = store.createWorkspaceMember({ workspaceId: target.id, userId: user.id, name: user.name, role: 'owner' });
    store.updateIssue(issue.id, { workspaceId: target.id, responsibleMemberId: human.id, actorType: 'member', actorId: 'mem_local_local' });
    const targetMain = store.getOrCreateDefaultIssueSession(issue.id);
    const sourceToken = await store.createAccessToken({ type: 'pat', name: 'Adopted Main source history reader', workspaceId: 'local', userId: 'local' });
    const sourceSnapshot = () => ({
      session: db.query('SELECT * FROM multiremi_issue_sessions WHERE id=?').get(sourceMain.id),
      head: db.query('SELECT * FROM multiremi_conversation_heads WHERE session_id=?').get(sourceMain.id),
      log: db.query('SELECT * FROM multiremi_conversation_log WHERE session_id=? ORDER BY seq').all(sourceMain.id),
    });
    const beforeAdoption = sourceSnapshot();
    const targetAgent = store.createAgent({ name: 'Target adopting Chat worker', provider: 'codex', workspaceId: target.id });
    const chat = store.createChatSession({ agentId: targetAgent.id, creatorId: user.id, workspaceId: target.id });
    const chatMain = store.getOrCreateDefaultChatSession(chat.id);
    const targetHead = db.query('SELECT workspace_id FROM multiremi_conversation_heads WHERE session_id=?')
      .get(targetMain.id) as { workspace_id: string | null };
    expect(store.adoptLegacySession(chat.id, targetMain.id)).toMatchObject({ ownerType: 'chat', ownerId: chat.id,
      chatId: chat.id, issueId: issue.id, workspaceId: target.id, isDefault: false });
    const handoff = db.query("SELECT id,workspace_id,body,data FROM multiremi_issue_activity WHERE issue_id=? AND type='issue_session_owner_transferred'")
      .get(issue.id) as { id: string; workspace_id: string; body: string | null; data: string };
    expect(handoff).toMatchObject({ workspace_id: target.id, body: null });
    expect(JSON.parse(handoff.data)).toEqual({ sessionId: targetMain.id, issueId: issue.id, workspaceId: target.id,
      chatId: chat.id, isDefault: true, parentSessionId: null, inheritMode: 'none', headWorkspaceId: targetHead.workspace_id });
    store.appendSessionEvent(targetMain.id, { authorType: 'system', body: 'TARGET_ONLY_PRIVATE_ADOPTED_CHAT' });
    const replacementMain = store.getOrCreateDefaultIssueSession(issue.id);
    expect(replacementMain.id).not.toBe(targetMain.id);
    expect(replacementMain).toMatchObject({ ownerType: 'issue', ownerId: issue.id, workspaceId: target.id, isDefault: true });
    expect(store.getOrCreateDefaultChatSession(chat.id).id).toBe(chatMain.id);
    const reopen = () => {
      db.run("DELETE FROM multiremi_schema_migrations WHERE id='20261008_dual_owned_sessions'");
      runMigrations(db);
      store = new MultiremiStore(db);
    };
    const assertSourceHistory = async (workspaceId: string) => {
      expect(sourceSnapshot()).toEqual(beforeAdoption);
      expect(store.getMessage(question.id)?.session_id).toBe(sourceMain.id);
      expect(store.getIssueSessionWithOwnerScope(sourceMain.id)).toMatchObject({ ownerWorkspaceId: null, historicalWorkspaceId: 'local' });
      expect(() => store.updateIssueSession(sourceMain.id, { title: 'MUST_NOT_REVIVE_ADOPTED_SOURCE' })).toThrow('owner is unavailable');
      const currentMain = store.getOrCreateDefaultIssueSession(issue.id);
      expect(store.getIssueSessionWithOwnerScope(currentMain.id)).toMatchObject({ ownerWorkspaceId: workspaceId, historicalWorkspaceId: null });
      store.appendSessionEvent(currentMain.id, { authorType: 'system', body: 'New Issue Main remains writable after adoption' });
      const app = createMultiremiApp({ store, authToken: 'ADOPTION_HISTORY_MASTER' });
      const sourceHeaders = { Authorization: `Bearer ${sourceToken.token}` };
      const read = await app.request(`/api/sessions/${sourceMain.id}/messages`, { headers: sourceHeaders });
      expect(read.status).toBe(200);
      const text = await read.text();
      expect(text).toContain('SOURCE_ONLY_ADOPTED_MAIN_HISTORY');
      expect(text).not.toContain('TARGET_ONLY_PRIVATE_ADOPTED_CHAT');
      const write = await app.request(`/api/sessions/${sourceMain.id}/messages`, { method: 'POST',
        headers: { ...sourceHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body_md: 'MUST_NOT_REVIVE_ADOPTED_SOURCE', to: { type: 'none' }, wake_requested: 'inbox_only' }) });
      expect(write.status).toBe(404);
      expect(sourceSnapshot()).toEqual(beforeAdoption);
    };
    reopen();
    await assertSourceHistory(target.id);
    const app = createMultiremiApp({ store, authToken: 'ADOPTION_HISTORY_MASTER' });
    const sourceHeaders = { Authorization: `Bearer ${sourceToken.token}` };
    expect((await app.request(`/api/sessions/${targetMain.id}/messages`, { headers: sourceHeaders })).status).toBe(404);
    const localChat = store.createChatSession({ agentId: agent.id, creatorId: 'local' });
    store.getOrCreateDefaultChatSession(localChat.id);
    const adoptionTables = [
      ['multiremi_issue_sessions', 'id'], ['multiremi_chat_sessions', 'id'],
      ['multiremi_conversation_heads', 'session_id'], ['multiremi_conversation_log', 'session_id,seq'],
      ['multiremi_issue_activity', 'id'], ['multiremi_session_results', 'id'],
      ['multiremi_session_lanes', 'session_id,reader_type,reader_id,execution_scope'],
      ['multiremi_session_participants', 'id'], ['multiremi_turns', 'id'], ['multiremi_turn_attempts', 'id'],
    ] as const;
    const adoptionSnapshot = () => Object.fromEntries(adoptionTables.map(([table, order]) =>
      [table, db.query(`SELECT * FROM ${table} ORDER BY ${order}`).all()]));
    const beforeRetiredAdoption = adoptionSnapshot();
    const events: unknown[] = [];
    store.onWorkspaceEvent(event => events.push(event));
    expect(() => store.adoptLegacySession(localChat.id, sourceMain.id)).toThrow('owner is unavailable');
    expect(adoptionSnapshot()).toEqual(beforeRetiredAdoption);
    expect(events).toEqual([]);

    const destination = store.createWorkspace({ name: 'Detached adoption destination', slug: 'detached-adoption-destination' });
    const destinationHuman = store.createWorkspaceMember({ workspaceId: destination.id, name: 'Detached adoption destination human' });
    store.updateIssue(issue.id, { workspaceId: destination.id, responsibleMemberId: destinationHuman.id, actorType: 'member', actorId: human.id });
    expect(store.getIssueSession(targetMain.id)).toMatchObject({ ownerType: 'chat', ownerId: chat.id, issueId: null, workspaceId: target.id });
    await assertSourceHistory(destination.id);
    expect(store.deleteChatSession(chat.id)).toBeTrue();
    expect(store.getIssueSession(targetMain.id)).toBeNull();
    expect(store.getChatSession(chat.id)).toBeNull();
    reopen();
    await assertSourceHistory(destination.id);

    // A missing target entity without an exact durable ownership handoff
    // cannot establish historical access. Invalid metadata cannot replace it.
    const corruptions: Array<Record<string, unknown>> = [
      { sessionId: replacementMain.id }, { issueId: 'missing-other-issue' }, { workspaceId: 'local' },
      { chatId: '' }, { isDefault: false }, { parentSessionId: replacementMain.id },
      { inheritMode: 'snapshot' }, { headWorkspaceId: 'local' },
    ];
    for (const corruption of corruptions) {
      db.run('UPDATE multiremi_issue_activity SET data=? WHERE id=?', [JSON.stringify({ ...JSON.parse(handoff.data), ...corruption }), handoff.id]);
      expect(store.getIssueSessionWithOwnerScope(sourceMain.id)).toMatchObject({ ownerWorkspaceId: null, historicalWorkspaceId: null });
      const denied = await createMultiremiApp({ store, authToken: 'ADOPTION_HISTORY_MASTER' })
        .request(`/api/sessions/${sourceMain.id}/messages`, { headers: sourceHeaders });
      expect(denied.status).toBe(404);
      expect(await denied.text()).not.toContain('SOURCE_ONLY_ADOPTED_MAIN');
      expect(sourceSnapshot()).toEqual(beforeAdoption);
    }
    db.run('UPDATE multiremi_issue_activity SET type=? WHERE id=?', ['missing_handoff_fixture', handoff.id]);
    expect(store.getIssueSessionWithOwnerScope(sourceMain.id)).toMatchObject({ ownerWorkspaceId: null, historicalWorkspaceId: null });
    expect((await createMultiremiApp({ store, authToken: 'ADOPTION_HISTORY_MASTER' })
      .request(`/api/sessions/${sourceMain.id}/messages`, { headers: sourceHeaders })).status).toBe(404);
    db.run('UPDATE multiremi_issue_activity SET type=?,data=? WHERE id=?', ['issue_session_owner_transferred', handoff.data, handoff.id]);
    db.run('UPDATE multiremi_conversation_heads SET workspace_id=? WHERE session_id=?', [destination.id, sourceMain.id]);
    expect(store.getIssueSessionWithOwnerScope(sourceMain.id)).toMatchObject({ ownerWorkspaceId: null, historicalWorkspaceId: null });
    const beforeCorruptAdoption = adoptionSnapshot();
    expect(() => store.adoptLegacySession(localChat.id, sourceMain.id)).toThrow('owner is unavailable');
    expect(adoptionSnapshot()).toEqual(beforeCorruptAdoption);
    db.run('UPDATE multiremi_conversation_heads SET workspace_id=? WHERE session_id=?', ['local', sourceMain.id]);
    await assertSourceHistory(destination.id);
  });

  it('preserves audited source history across the dual-owner upgrade without guessing independent legacy sides', () => {
    const { store, db } = fixture();
    const issue = store.createIssue({ title: 'Audited ownership upgrade', responsibleMemberId: 'mem_local_local' });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const side = store.createIssueSession(issue.id, { title: 'Source inherited side', parentSessionId: main.id });
    const independent = store.createIssueSession(issue.id, { title: 'Source independent side' });
    const agent = store.createAgent({ name: 'Source provider owner', provider: 'codex' });
    const runtime = store.registerRuntime({ name: 'Source provider runtime', provider: 'codex' });
    const task = store.createSessionTask(main.id, { agentId: agent.id, prompt: 'SOURCE_ONLY_UPGRADE_INPUT' });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    const question = store.createTaskHumanRequest({ taskId: task.id, kind: 'question', payload: { title: 'SOURCE_ONLY_UPGRADE_QUESTION' } });
    store.completeTask(task.id, { output: 'SOURCE_ONLY_UPGRADE_OUTPUT', sessionId: 'source-provider-before-move', workDir: '/source/history' });
    expect(store.getSessionAgentLane(main.id, agent.id)?.providerSessionId).toBe('source-provider-before-move');
    store.appendSessionEvent(side.id, { authorType: 'system', body: 'SOURCE_ONLY_UPGRADE_SIDE' });
    store.appendSessionEvent(independent.id, { authorType: 'system', body: 'SOURCE_ONLY_UPGRADE_INDEPENDENT' });
    const chat = store.createChatSession({ agentId: agent.id, creatorId: 'local' });
    const chatMain = store.getOrCreateDefaultChatSession(chat.id);
    const projected = store.createIssueSession(issue.id, { chatId: chat.id, title: 'Private source projection' });
    store.publishSessionResult(projected.id, { body: 'SOURCE_ONLY_UPGRADE_PRIVATE_RESULT' });
    for (const existing of store.listTasksForIssue(issue.id)) {
      if (!['completed', 'failed', 'cancelled'].includes(existing.status)) store.cancelTask(existing.id);
    }
    const target = store.createWorkspace({ name: 'Audited upgrade target', slug: 'audited-upgrade-target' });
    const human = store.createWorkspaceMember({ workspaceId: target.id, name: 'Audited upgrade target human' });
    store.updateIssue(issue.id, { workspaceId: target.id, responsibleMemberId: human.id, actorType: 'member', actorId: 'mem_local_local' });
    const targetMain = store.getOrCreateDefaultIssueSession(issue.id);
    const rotation = db.query("SELECT id,data FROM multiremi_issue_activity WHERE issue_id=? AND type='issue_main_session_rotated'")
      .get(issue.id) as { id: string; data: string };
    const receipt = JSON.parse(rotation.data);
    expect(receipt).toMatchObject({ previousSessionId: main.id, sessionId: targetMain.id,
      previousWorkspaceId: 'local', workspaceId: target.id });
    expect(receipt.previousSessionIds).toEqual([main.id, side.id, independent.id].sort());
    expect(receipt.retiredTargetSessionIds).toEqual([]);
    for (const session of [main, side, independent]) {
      expect(store.getIssueSessionWithOwnerScope(session.id)).toMatchObject({ ownerWorkspaceId: null, historicalWorkspaceId: 'local' });
    }
    expect(store.getIssueSession(projected.id)).toMatchObject({ chatId: chat.id, issueId: null, workspaceId: 'local' });
    expect(store.getOrCreateDefaultChatSession(chat.id).id).toBe(chatMain.id);

    // Reproduce the shipped upstream receipt, which named Main but did not
    // enumerate independent sides. Parent identity proves the inherited side;
    // a timestamp or matching old workspace does not prove the other one.
    delete receipt.previousSessionIds;
    db.run('UPDATE multiremi_issue_activity SET data=? WHERE id=?', [JSON.stringify(receipt), rotation.id]);
    expect(store.getIssueSessionWithOwnerScope(side.id)).toMatchObject({ ownerWorkspaceId: null, historicalWorkspaceId: 'local' });
    expect(store.getIssueSessionWithOwnerScope(independent.id)).toMatchObject({ ownerWorkspaceId: null, historicalWorkspaceId: null });
    const snapshot = () => ({
      sessions: db.query('SELECT * FROM multiremi_issue_sessions ORDER BY id').all(),
      heads: db.query('SELECT * FROM multiremi_conversation_heads ORDER BY session_id').all(),
      log: db.query('SELECT * FROM multiremi_conversation_log ORDER BY session_id,seq').all(),
      lanes: db.query('SELECT * FROM multiremi_session_lanes ORDER BY session_id,reader_type,reader_id,execution_scope').all(),
      results: db.query('SELECT * FROM multiremi_session_results ORDER BY id').all(),
      turns: db.query('SELECT * FROM multiremi_turns ORDER BY id').all(),
      attempts: db.query('SELECT * FROM multiremi_turn_attempts ORDER BY id').all(),
      activity: db.query('SELECT * FROM multiremi_issue_activity ORDER BY id').all(),
    });
    const beforeUpgrade = snapshot();
    db.run("DELETE FROM multiremi_schema_migrations WHERE id='20261008_dual_owned_sessions'");
    runMigrations(db);
    const reopened = new MultiremiStore(db);
    expect(snapshot()).toEqual(beforeUpgrade);
    expect(reopened.getMessage(question.id)?.session_id).toBe(main.id);
    expect(reopened.getSessionAgentLane(main.id, agent.id)?.providerSessionId).toBe('source-provider-before-move');
    expect(reopened.getIssueSession(independent.id)?.workspaceId).toBe('local');
    expect(reopened.listIssueSessions(issue.id, true).map(session => session.id)).toEqual([targetMain.id]);
    expect(reopened.listIssueSessionResults(issue.id)).toEqual([]);
  });

  it('never revives retired Session writes when the Issue returns to its original workspace and rejects corrupt owner facts', async () => {
    const { store, db } = fixture();
    const issue = store.createIssue({ title: 'Issue returns to source', responsibleMemberId: 'mem_local_local' });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const side = store.createIssueSession(issue.id, { title: 'Original inherited side', parentSessionId: main.id });
    const unknownSide = store.createIssueSession(issue.id, { title: 'Independent legacy side with no identity receipt' });
    store.appendSessionEvent(main.id, { authorType: 'system', body: 'SOURCE_ONLY_RETURN_HISTORY' });
    store.appendSessionEvent(side.id, { authorType: 'system', body: 'SOURCE_ONLY_RETURN_SIDE_HISTORY' });
    const oldComment = store.createIssueComment(issue.id, { body: 'SOURCE_ONLY_RETURN_COMMENT' });
    const oldAttachment = store.createAttachment({ workspaceId: 'local', issueId: issue.id, commentId: oldComment.id,
      filename: 'SOURCE_ONLY_RETURN_FILE.txt', url: 'https://example.test/source-return-file.txt', contentType: 'text/plain', sizeBytes: 10 });
    const target = store.createWorkspace({ name: 'Return destination', slug: 'return-destination' });
    const human = store.createWorkspaceMember({ workspaceId: target.id, name: 'Return destination human' });
    store.updateIssue(issue.id, { workspaceId: target.id, responsibleMemberId: human.id, actorType: 'member', actorId: 'mem_local_local' });
    const destinationMain = store.getOrCreateDefaultIssueSession(issue.id);
    const oldRotation = db.query("SELECT id,data FROM multiremi_issue_activity WHERE issue_id=? AND type='issue_main_session_rotated'")
      .get(issue.id) as { id: string; data: string };
    const oldReceipt = JSON.parse(oldRotation.data);
    delete oldReceipt.previousSessionIds;
    db.run('UPDATE multiremi_issue_activity SET data=? WHERE id=?', [JSON.stringify(oldReceipt), oldRotation.id]);
    expect(store.getIssueSessionWithOwnerScope(unknownSide.id)).toMatchObject({ ownerWorkspaceId: null, historicalWorkspaceId: null });
    store.updateIssue(issue.id, { workspaceId: 'local', responsibleMemberId: 'mem_local_local', actorType: 'member', actorId: human.id });
    const currentMain = store.getOrCreateDefaultIssueSession(issue.id);
    const returnRotation = db.query("SELECT data FROM multiremi_issue_activity WHERE issue_id=? AND type='issue_main_session_rotated' AND workspace_id='local'")
      .get(issue.id) as { data: string };
    expect(JSON.parse(returnRotation.data).retiredTargetSessionIds).toEqual([main.id, side.id, unknownSide.id].sort());
    expect(new Set([main.id, destinationMain.id, currentMain.id]).size).toBe(3);
    expect(store.getIssueSessionWithOwnerScope(currentMain.id)).toMatchObject({ ownerWorkspaceId: 'local', historicalWorkspaceId: null });
    for (const session of [main, side]) {
      expect(store.getIssueSessionWithOwnerScope(session.id)).toMatchObject({ ownerWorkspaceId: null, historicalWorkspaceId: 'local' });
    }
    expect(store.getIssueSessionWithOwnerScope(unknownSide.id)).toMatchObject({ ownerWorkspaceId: null, historicalWorkspaceId: null });
    const newIndependent = store.createIssueSession(issue.id, { title: 'New side after return' });
    expect(store.getIssueSessionWithOwnerScope(newIndependent.id)).toMatchObject({ ownerWorkspaceId: 'local', historicalWorkspaceId: null });
    store.appendSessionEvent(newIndependent.id, { authorType: 'system', body: 'New returned workspace work' });
    const before = db.query('SELECT * FROM multiremi_conversation_log WHERE session_id=? ORDER BY seq').all(main.id);
    const beforeHead = store.getConversationLogHead(main.id);
    const app = createMultiremiApp({ store, authToken: 'RETURN_SCOPE_MASTER' });
    const headers = { Authorization: 'Bearer RETURN_SCOPE_MASTER', 'Content-Type': 'application/json' };
    const newComment = store.createIssueComment(issue.id, { body: 'New Main attachment after return' });
    expect(newComment.issueSessionId).toBe(currentMain.id);
    const newAttachment = await app.request('/api/multiremi/attachments', { method: 'POST', headers,
      body: JSON.stringify({ workspace_id: 'local', issue_id: issue.id, comment_id: newComment.id,
        filename: 'New return file.txt', url: 'https://example.test/new-return-file.txt' }) });
    expect(newAttachment.status).toBe(201);
    const tables = [
      ['multiremi_issues', 'id'], ['multiremi_issue_sessions', 'id'],
      ['multiremi_conversation_heads', 'session_id'], ['multiremi_conversation_log', 'session_id,seq'],
      ['multiremi_attachments', 'id'], ['multiremi_comment_reactions', 'id'], ['multiremi_issue_activity', 'id'],
      ['multiremi_session_lanes', 'session_id,reader_type,reader_id,execution_scope'],
      ['multiremi_turns', 'id'], ['multiremi_turn_attempts', 'id'], ['multiremi_system_events', 'id'],
    ] as const;
    const attachmentSnapshot = () => Object.fromEntries(tables.map(([table, order]) =>
      [table, db.query(`SELECT * FROM ${table} ORDER BY ${order}`).all()]));
    const beforeAttachmentWrites = attachmentSnapshot();
    expect((await app.request(`/api/attachments/${oldAttachment.id}`, { method: 'DELETE', headers })).status).toBe(404);
    expect(attachmentSnapshot()).toEqual(beforeAttachmentWrites);
    expect((await app.request('/api/multiremi/attachments', { method: 'POST', headers,
      body: JSON.stringify({ workspace_id: 'local', issue_id: issue.id, comment_id: oldComment.id,
        filename: 'MUST_NOT_LINK.txt', url: 'https://example.test/must-not-link.txt' }) })).status).toBe(404);
    expect(attachmentSnapshot()).toEqual(beforeAttachmentWrites);
    expect(store.getAttachment(oldAttachment.id)).toEqual(oldAttachment);
    const read = await app.request(`/api/sessions/${main.id}/messages`, { headers });
    expect(read.status).toBe(200);
    expect(await read.text()).toContain('SOURCE_ONLY_RETURN_HISTORY');
    expect((await app.request(`/api/sessions/${unknownSide.id}/messages`, { headers })).status).toBe(404);
    const unknownLog = db.query('SELECT * FROM multiremi_conversation_log WHERE session_id=? ORDER BY seq').all(unknownSide.id);
    const unknownHead = store.getConversationLogHead(unknownSide.id);
    for (const session of [main, side, unknownSide]) {
      const write = await app.request(`/api/sessions/${session.id}/messages`, { method: 'POST', headers,
        body: JSON.stringify({ body_md: 'MUST_NOT_REVIVE', to: { type: 'none' }, wake_requested: 'inbox_only' }) });
      expect(write.status).toBe(404);
      expect(() => store.updateIssueSession(session.id, { title: 'MUST_NOT_REVIVE' })).toThrow('owner is unavailable');
    }
    expect(() => store.createIssueSession(issue.id, { parentSessionId: main.id })).toThrow('owner is unavailable');
    expect(store.getConversationLogHead(main.id)).toEqual(beforeHead);
    expect(db.query('SELECT * FROM multiremi_conversation_log WHERE session_id=? ORDER BY seq').all(main.id)).toEqual(before);
    expect(store.getConversationLogHead(unknownSide.id)).toEqual(unknownHead);
    expect(db.query('SELECT * FROM multiremi_conversation_log WHERE session_id=? ORDER BY seq').all(unknownSide.id)).toEqual(unknownLog);

    const invalid = store.createIssueSession(issue.id, { title: 'Corrupt workspace fixture' });
    db.run('UPDATE multiremi_issue_sessions SET workspace_id=? WHERE id=?', [target.id, invalid.id]);
    db.run('UPDATE multiremi_conversation_heads SET workspace_id=? WHERE session_id=?', [target.id, invalid.id]);
    expect(store.getIssueSessionWithOwnerScope(invalid.id)).toMatchObject({ ownerWorkspaceId: null, historicalWorkspaceId: null });
    expect((await app.request(`/api/sessions/${invalid.id}/messages`, { headers })).status).toBe(404);
    db.run('UPDATE multiremi_issue_sessions SET workspace_id=? WHERE id=?', ['local', invalid.id]);
    db.run('UPDATE multiremi_conversation_heads SET workspace_id=? WHERE session_id=?', ['local', invalid.id]);
    const other = store.createIssue({ title: 'Other owner fixture', responsibleMemberId: 'mem_local_local' });
    db.run('UPDATE multiremi_issue_sessions SET parent_session_id=? WHERE id=?', [store.getOrCreateDefaultIssueSession(other.id).id, invalid.id]);
    expect(store.getIssueSessionWithOwnerScope(invalid.id)).toMatchObject({ ownerWorkspaceId: null, historicalWorkspaceId: null });
    expect((await app.request(`/api/sessions/${invalid.id}/messages`, { headers })).status).toBe(404);
  });

  it('upgrades a real unified snapshot with no activity origin and freezes legacy facts only during explicit movement', () => {
    const f = fixture();
    const agent = f.store.createAgent({ name: 'Legacy source execution', provider: 'codex' });
    const issue = f.store.createIssue({ title: 'Legacy origin', responsibleMemberId: 'mem_local_local', assigneeType: 'agent', assigneeId: agent.id });
    const comment = f.store.createIssueComment(issue.id, { body: 'SOURCE_ONLY_PRIVATE_LEGACY_BODY' });
    const sourceSession = f.store.getOrCreateDefaultIssueSession(issue.id);
    for (const task of f.store.listTasksForIssue(issue.id)) if (!['completed', 'failed', 'cancelled'].includes(task.status)) f.store.cancelTask(task.id);
    const originalData = f.db.query('SELECT id,body,data FROM multiremi_issue_activity WHERE issue_id=?').all(issue.id);
    // Reproduce the actual previous unified shape: this additive column did
    // not exist. Two complete bootstraps must preserve its original evidence.
    f.db.exec('ALTER TABLE multiremi_issue_activity DROP COLUMN workspace_id');
    const first = new MultiremiStore(f.db);
    const store = new MultiremiStore((first as unknown as { db: typeof f.db }).db);
    expect(f.db.query('SELECT id,body,data FROM multiremi_issue_activity WHERE issue_id=?').all(issue.id)).toEqual(originalData);
    expect(f.db.query('SELECT DISTINCT workspace_id FROM multiremi_issue_activity WHERE issue_id=?').all(issue.id)).toEqual([{ workspace_id: null }]);
    const target = store.createWorkspace({ name: 'Legacy target', slug: 'legacy-origin-target' });
    const human = store.createWorkspaceMember({ workspaceId: target.id, name: 'Explicit legacy target human' });
    store.updateIssue(issue.id, { workspaceId: target.id, responsibleMemberId: human.id, actorType: 'member', actorId: 'mem_local_local' });
    expect(f.db.query('SELECT body,data,workspace_id FROM multiremi_issue_activity WHERE id=?').get(originalData.find(row => row.body === comment.body)!.id))
      .toEqual({ body: comment.body, data: originalData.find(row => row.body === comment.body)!.data, workspace_id: 'local' });
    expect(store.getIssueSession(sourceSession.id)?.workspaceId).toBe('local');
    const targetComments = store.listIssueComments(issue.id);
    expect(targetComments).toHaveLength(1);
    expect(targetComments[0]).toMatchObject({ type: 'system', issueSessionId: store.getOrCreateDefaultIssueSession(issue.id).id });
    expect(JSON.stringify(targetComments)).not.toContain('SOURCE_ONLY_PRIVATE');
    expect(JSON.stringify(store.listIssueActivity(issue.id))).not.toContain('SOURCE_ONLY_PRIVATE');
    f.db.run("INSERT INTO multiremi_issue_activity(id,issue_id,type,body,created_at) VALUES(?,?,'legacy_unknown',?,?)", ['unknown_origin', issue.id, 'SOURCE_ONLY_PRIVATE_UNKNOWN', new Date().toISOString()]);
    expect(JSON.stringify(store.listIssueActivity(issue.id))).not.toContain('SOURCE_ONLY_PRIVATE');
  });
  it('keeps known source attachment IDs out of target reads, uploads and new shared capabilities', async () => {
    const { store } = fixture();
    const issue = store.createIssue({ title: 'Attachment origin move', responsibleMemberId: 'mem_local_local' });
    const oldComment = store.createIssueComment(issue.id, { body: 'SOURCE_ONLY_PRIVATE_ATTACHMENT_COMMENT' });
    const oldAttachments = [null, oldComment.id].map(commentId => store.createAttachment({ workspaceId: 'local', issueId: issue.id, commentId,
      filename: 'SOURCE_ONLY_PRIVATE_FILE.txt', url: 'https://example.test/source-private-file.txt', contentType: 'text/plain', sizeBytes: 10 }));
    const target = store.createWorkspace({ name: 'Attachment destination', slug: 'attachment-destination' });
    const user = store.getOrCreateUser({ externalId: 'attachment-destination-user', name: 'Destination human' });
    const human = store.createWorkspaceMember({ workspaceId: target.id, userId: user.id, name: 'Destination human', role: 'owner' });
    store.updateIssue(issue.id, { workspaceId: target.id, responsibleMemberId: human.id, actorType: 'member', actorId: 'mem_local_local' });
    const sourceToken = await store.createAccessToken({ type: 'pat', name: 'Source history reader', workspaceId: 'local', userId: 'local' });
    const targetToken = await store.createAccessToken({ type: 'pat', name: 'Destination reader', workspaceId: target.id, userId: user.id });
    const sourceHeaders = { Authorization: `Bearer ${sourceToken.token}` }, targetHeaders = { Authorization: `Bearer ${targetToken.token}` };
    const app = createMultiremiApp({ store, authToken: 'attachment-origin-master', shareSecret: 'attachment-origin-share' });
    for (const attachment of oldAttachments) {
      const read = await app.request(`/api/multiremi/attachments/${attachment.id}`, { headers: sourceHeaders });
      expect(read.status).toBe(200);
      expect(await read.text()).toContain('SOURCE_ONLY_PRIVATE_FILE');
      expect((await app.request(`/api/multiremi/attachments/${attachment.id}`, { headers: targetHeaders })).status).toBe(404);
    }
    const commentAttachment = oldAttachments[1]!;
    // The source user retains historical reads, not writes to a moved Issue.
    expect((await app.request(`/api/attachments/${commentAttachment.id}`, { method: 'DELETE', headers: sourceHeaders })).status).toBe(404);
    expect(store.getAttachment(commentAttachment.id)).toEqual(commentAttachment);
    for (const headers of [sourceHeaders, targetHeaders]) {
      const created = await app.request('/api/multiremi/attachments', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: target.id, issue_id: issue.id, comment_id: oldComment.id, filename: 'New forbidden link.txt', url: 'https://example.test/forbidden.txt' }) });
      expect(created.status).toBe(404);
      const form = new FormData();
      form.set('file', new File(['forbidden source mutation'], 'forbidden.txt', { type: 'text/plain' }));
      form.set('issue_id', issue.id); form.set('comment_id', oldComment.id);
      const upload = await app.request('/api/upload-file', { method: 'POST', headers, body: form });
      expect(upload.status).toBe(404);
    }
    const newComment = store.createIssueComment(issue.id, { body: 'Target attachment comment' });
    const created = await app.request('/api/multiremi/attachments', { method: 'POST', headers: { ...targetHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: target.id, issue_id: issue.id, comment_id: newComment.id, filename: 'Target file.txt', url: 'https://example.test/target-file.txt' }) });
    expect(created.status).toBe(201);
    const newAttachment = (await created.json() as { attachment: { id: string } }).attachment;
    expect((await app.request(`/api/multiremi/attachments/${newAttachment.id}`, { headers: targetHeaders })).status).toBe(200);
    expect(store.listAttachmentsForIssue(issue.id)).toEqual([]);
    const detail = await app.request(`/api/multiremi/issues/${issue.id}`, { headers: targetHeaders });
    expect(detail.status).toBe(200);
    expect(await detail.text()).not.toContain('SOURCE_ONLY_PRIVATE');
    const shared = await app.request(`/api/issues/${issue.id}/share`, { method: 'POST', headers: targetHeaders });
    expect(shared.status).toBe(201);
    const token = (await shared.json() as { share: { token: string } }).share.token;
    const shareHeaders = { 'X-Remi-Share': token };
    for (const attachment of oldAttachments) {
      expect((await app.request(`/api/shares/${token}/attachments/${attachment.id}/content`, { headers: shareHeaders })).status).toBe(404);
    }
    const targetFile = await app.request(`/api/shares/${token}/attachments/${newAttachment.id}/content`, { headers: shareHeaders });
    expect(targetFile.status).toBe(302);
    expect(targetFile.headers.get('Location')).toBe('https://example.test/target-file.txt');
    const bundle = await app.request(`/api/shares/${token}`, { headers: shareHeaders });
    expect(bundle.status).toBe(200);
    expect(await bundle.text()).not.toContain('SOURCE_ONLY_PRIVATE');
  });
});
