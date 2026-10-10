import { expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { runMigrations } from "@multiremi/store/migrations.js";
import { mutateExecutionFixture, turnApiPath } from "./unified-test-paths.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";
import { createResponsibleTestIssue } from "./helpers.js";

const migrationId = "20261008_dual_owned_sessions";

pendingTurnBackendTests("Session owner migration contract", (fixture, backend) => {
  it("serializes different Agents sharing a Chat checkout without blocking other owners", () => {
    const { db, store } = fixture();
    const runtime = store.registerRuntime({ name: "Shared checkout", provider: "claude", maxConcurrency: 10 });
    const agents = [1, 2, 3, 4].map(index => store.createAgent({
      name: `Checkout agent ${index}`, provider: "claude", runtimeId: runtime.id,
    }));
    const chat = store.createChatSession({ agentId: agents[0]!.id });
    const sessionA = store.listChatOwnedSessions(chat.id)[0]!;
    const sessionB = store.createSession(chat.id, { title: "Other work" });
    const ordinary = store.sendChatMessage(chat.id, { body: "Ordinary Chat work" }).task;
    mutateExecutionFixture(store, "UPDATE multiremi_turn_execution_records SET priority = 100 WHERE id = ?", [ordinary.id]);
    const workA = store.createSessionTask(sessionA.id, { agentId: agents[1]!.id, prompt: "Session A", priority: 20 });
    const workB = store.createSessionTask(sessionB.id, { agentId: agents[2]!.id, prompt: "Session B", priority: 10 });
    const otherChat = store.createChatSession({ agentId: agents[3]!.id });
    const independent = store.sendChatMessage(otherChat.id, { body: "Another checkout" }).task;

    expect(store.claimTask(runtime.id)?.id).toBe(ordinary.id);
    store.startTask(ordinary.id);
    expect(store.claimTask(runtime.id)?.id).toBe(independent.id);
    store.cancelTask(independent.id);
    const issue = createResponsibleTestIssue(store, { title: "Independent Issue checkout" });
    const issueTask = store.createSessionTask(store.getOrCreateDefaultIssueSession(issue.id).id, {
      agentId: agents[3]!.id, prompt: "Issue work",
    });
    expect(store.claimTask(runtime.id)?.id).toBe(issueTask.id);
    store.cancelTask(issueTask.id);
    expect(store.claimTask(runtime.id)).toBeNull();
    store.completeTask(ordinary.id, { output: "Ordinary work finished" });

    expect(store.claimTask(runtime.id)?.id).toBe(workA.id);
    store.startTask(workA.id);
    expect(store.claimTask(runtime.id)).toBeNull();
    store.completeTask(workA.id, { output: "Session A finished" });
    expect(store.claimTask(runtime.id)?.id).toBe(workB.id);
  });

  it("keeps a Chat-owned terminal reply private when its Task audit loses the Chat pointer", async () => {
    const { db, store } = fixture();
    const runtime = store.registerRuntime({ name: "Private terminal executor", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "Private terminal worker", provider: "claude", runtimeId: runtime.id });
    const issue = createResponsibleTestIssue(store, { title: "Public projection" });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const chat = store.createChatSession({ agentId: agent.id, creatorId: "local" });
    const session = store.createIssueSession(issue.id, { chatId: chat.id, title: "Private projected work" });
    const task = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Private input" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    mutateExecutionFixture(store, "UPDATE multiremi_turn_execution_records SET chat_session_id = NULL WHERE id = ?", [task.id]);
    expect(store.getTask(task.id)?.chatSessionId).toBeNull();
    expect(store.getIssueSession(session.id)).toMatchObject({ ownerType: "chat", ownerId: chat.id });

    const secret = "PRIVATE_TERMINAL_SECRET_WITHOUT_AUDIT_CHAT";
    store.completeTask(task.id, { output: secret });

    const turn = store.getTurnForAttempt(task.id)!;
    expect(store.getTask(task.id)?.status).toBe("completed");
    expect(store.getMessage(turn.reply_message_id!)).toMatchObject({ session_id: session.id, body_md: secret });
    expect(store.listMessages(session.id).filter(message => message.body_md === secret)).toHaveLength(1);
    expect(JSON.stringify(store.listIssueComments(issue.id))).not.toContain(secret);
    expect(JSON.stringify(store.listConversationLogEntries(main.id))).not.toContain(secret);
    const activity = db.query("SELECT type, body, data FROM multiremi_issue_activity WHERE issue_id = ?").all(issue.id);
    expect(JSON.stringify(activity)).not.toContain(secret);

    store.createWorkspaceMember({ workspaceId: "local", userId: "external", name: "External admin", role: "admin" });
    const external = await store.createAccessToken({ name: "External admin", type: "pat", userId: "external", workspaceId: "local" });
    const publicTask = store.createSessionTask(main.id, { agentId: agent.id, prompt: "Public Issue work" });
    const publicToken = await store.createTaskAccessToken(publicTask, "external");
    const app = createMultiremiApp({ store, authToken: "OWNER_LIFECYCLE_MASTER" });

    expect(store.deleteChatSession(chat.id)).toBe(true);
    expect(store.getChatSession(chat.id)).toBeNull();
    expect(store.getIssueSession(session.id)).toBeNull();
    expect(store.getTask(task.id)).toMatchObject({ status: "completed", chatSessionId: chat.id, issueSessionId: null });
    expect(store.getTurn(turn.id)?.chat_session_id).toBe(chat.id);
    expect(store.listTurns({ workspace_id: "local", visibility: { userId: "external", admin: true } }).map(item => item.id)).not.toContain(turn.id);
    expect(() => store.createChatSession({ id: chat.id, agentId: agent.id, creatorId: "local" })).toThrow("already been used");

    for (const token of [external, publicToken]) {
      const headers = { Authorization: `Bearer ${token.token}` };
      expect((await app.request(turnApiPath(store, publicTask.id), { headers })).status).toBe(200);
      for (const suffix of ["", "?input=true&attempts=true", "/trace"]) {
        const denied = await app.request(turnApiPath(store, task.id, suffix), { headers });
        expect(denied.status, suffix).toBe(403);
        expect(await denied.text()).not.toContain(secret);
      }
      const listed = await app.request("/api/turns", { headers });
      expect(listed.status).toBe(200);
      const body = await listed.text();
      expect(body).toContain(store.getTurnForAttempt(publicTask.id)!.id);
      expect(body).not.toContain(turn.id);
      expect(body).not.toContain(task.id);
      expect(body).not.toContain(secret);
    }
  });

  for (const lifecycle of ["archived", "deleted"] as const) {
    it(`cancels a pending private Session Task with a missing Chat audit pointer when its Chat is ${lifecycle}`, () => {
      const { store } = fixture();
      const agent = store.createAgent({ name: "Private lifecycle worker", provider: "claude" });
      const issue = createResponsibleTestIssue(store, { title: "Public lifecycle projection" });
      const main = store.getOrCreateDefaultIssueSession(issue.id);
      const chat = store.createChatSession({ agentId: agent.id, creatorId: "local" });
      const session = store.createIssueSession(issue.id, { chatId: chat.id, title: "Private lifecycle work" });
      const task = store.createSessionTask(session.id, { agentId: agent.id, prompt: "PRIVATE_PENDING_WITHOUT_AUDIT_CHAT" });
      const turn = store.getTurnForAttempt(task.id)!;
      mutateExecutionFixture(store, "UPDATE multiremi_turn_execution_records SET chat_session_id = NULL WHERE id = ?", [task.id]);
      expect(store.getTask(task.id)).toMatchObject({ status: "queued", chatSessionId: null, issueSessionId: session.id });
      expect(store.getPendingChatTask(chat.id)).toBeNull();

      if (lifecycle === "archived") {
        expect(store.updateChatSession(chat.id, { status: "archived" }).status).toBe("archived");
        expect(store.getIssueSession(session.id)).toMatchObject({ ownerType: "chat", ownerId: chat.id });
        expect(store.getPendingChatTask(chat.id)).toBeNull();
      } else {
        expect(store.deleteChatSession(chat.id)).toBe(true);
        expect(store.getChatSession(chat.id)).toBeNull();
        expect(store.getIssueSession(session.id)).toBeNull();
        expect(store.getTask(task.id)?.chatSessionId).toBe(chat.id);
        expect(store.getTurn(turn.id)?.chat_session_id).toBe(chat.id);
        expect(() => store.createChatSession({ id: chat.id, agentId: agent.id, creatorId: "local" })).toThrow("already been used");
      }

      expect(store.getTask(task.id)?.status).toBe("cancelled");
      expect(store.getTurn(turn.id)?.status).toBe("cancelled");
      expect(store.listTurns({ workspace_id: "local", visibility: { userId: "external", admin: true } }).map(item => item.id)).not.toContain(turn.id);
      expect(JSON.stringify(store.listConversationLogEntries(main.id))).not.toContain("PRIVATE_PENDING_WITHOUT_AUDIT_CHAT");
      expect(JSON.stringify(store.listIssueComments(issue.id))).not.toContain("PRIVATE_PENDING_WITHOUT_AUDIT_CHAT");
    });
  }

  it("rotates the Issue Main while freezing source history, Chat projections and historical Task audit", () => {
    const { db, store } = fixture();
    const issue = createResponsibleTestIssue(store, { title: "Move canonical conversation" });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const side = store.createIssueSession(issue.id, { title: "Owned sibling", parentSessionId: main.id });
    store.appendSessionEvent(side.id, { authorType: "system", body: "Owned sibling history" });
    const oldAgent = store.createAgent({ name: "Historic worker", provider: "claude" });
    const historicTask = store.createSessionTask(main.id, { agentId: oldAgent.id, prompt: "Historic work" });
    store.cancelTask(historicTask.id);
    const oldMessage = store.sendMessage({ session_id: main.id, sender: { type: "platform", id: null },
      to: { type: "none" }, message_kind: "report", wake_requested: "inbox_only", body_md: "Historic Issue message" }).message;
    store.reactMessage(oldMessage.id, { emoji: "+1" });
    const chat = store.createChatSession({ agentId: oldAgent.id, creatorId: "local" });
    const projected = store.createIssueSession(issue.id, { chatId: chat.id, title: "Private Chat projection" });
    const privateMessage = store.sendMessage({ session_id: projected.id, sender: { type: "platform", id: null },
      to: { type: "none" }, message_kind: "report", wake_requested: "inbox_only", body_md: "Private projected history" }).message;
    store.reactMessage(privateMessage.id, { emoji: "+1" });
    const target = store.createWorkspace({ name: "Canonical move destination" });
    const human = store.listWorkspaceMembers(target.id).find(member => member.role === "owner" && !member.archivedAt)
      ?? store.createWorkspaceMember({ workspaceId: target.id, userId: "local", name: "Target human", role: "owner" });

    const sourceHistory = [main.id, side.id].map(id =>
      db.query("SELECT * FROM multiremi_conversation_log WHERE session_id = ? ORDER BY seq").all(id));

    store.updateIssue(issue.id, { workspaceId: target.id, responsibleMemberId: human.id, actorType: "member", actorId: "mem_local_local" });

    const targetMain = store.getOrCreateDefaultIssueSession(issue.id);
    expect(targetMain.id).not.toBe(main.id);
    expect(targetMain).toMatchObject({ ownerType: "issue", ownerId: issue.id, workspaceId: target.id,
      isDefault: true, parentSessionId: null, inheritMode: "none" });
    expect(store.listIssueSessions(issue.id, true).map(session => session.id)).toEqual([targetMain.id]);
    for (const id of [main.id, side.id]) {
      expect(store.getIssueSession(id)).toMatchObject({ workspaceId: "local", isDefault: false });
      expect(db.query("SELECT workspace_id FROM multiremi_conversation_heads WHERE session_id = ?").get(id)?.workspace_id).toBe("local");
      expect(store.getIssueSessionWithOwnerScope(id)).toMatchObject({ ownerWorkspaceId: null, historicalWorkspaceId: "local" });
    }
    expect([main.id, side.id].map(id =>
      db.query("SELECT * FROM multiremi_conversation_log WHERE session_id = ? ORDER BY seq").all(id))).toEqual(sourceHistory);
    expect(store.getIssueSession(projected.id)).toMatchObject({ ownerType: "chat", ownerId: chat.id,
      workspaceId: "local", issueId: null });
    expect(db.query("SELECT workspace_id FROM multiremi_conversation_heads WHERE session_id = ?").get(projected.id)?.workspace_id).toBe("local");
    expect(store.getTask(historicTask.id)?.workspaceId).toBe("local");
    expect(db.query("SELECT workspace_id FROM multiremi_turns WHERE current_attempt_id = ?").get(historicTask.id)?.workspace_id).toBe("local");
    expect(db.query("SELECT workspace_id FROM multiremi_comment_reactions WHERE comment_id = ?").get(oldMessage.id)?.workspace_id).toBe("local");
    expect(db.query("SELECT workspace_id FROM multiremi_comment_reactions WHERE comment_id = ?").get(privateMessage.id)?.workspace_id).toBe("local");

    const runtime = store.registerRuntime({ name: "Target executor", provider: "claude", workspaceId: target.id });
    const agent = store.createAgent({ name: "Target worker", provider: "claude", workspaceId: target.id, runtimeId: runtime.id });
    const task = store.createSessionTask(targetMain.id, { agentId: agent.id, createdByType: "system", prompt: "New target work" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    const question = store.createTaskHumanRequest({ taskId: task.id, kind: "question", payload: { title: "TARGET_QUESTION_AFTER_MOVE" } });
    expect(store.getMessage(question.id)?.to_member_id).toBe(human.id);
    expect(store.getMessage(question.id)?.wake_applied).toBe("inbox_only");
    expect(store.resolveIssueResponsibility(issue.id).rootHuman).toMatchObject({ type: "member", id: human.id, issueId: issue.id });
    expect(store.listIssueQuestions(issue.id).find(item => item.id === question.id)).toMatchObject({
      id: question.id, session_id: targetMain.id, workspace_id: target.id, stage: "human",
      current_handler: { type: "member", id: human.id },
    });
    const inbox = store.listMessageInbox(human.id, target.id, { access: { userId: "local", admin: true } });
    expect(inbox.items.map(message => message.id)).toContain(question.id);
    expect(inbox.unread_count).toBeGreaterThan(0);
    expect(inbox.attention_count).toBe(0);
    const report = store.sendMessage({ session_id: targetMain.id, sender: { type: "platform", id: null },
      to: { type: "member", ref: human.id }, message_kind: "report", wake_requested: "inbox_only", body_md: "Target report" }).message;
    store.reactMessage(report.id, { emoji: "+1" });
    expect(db.query("SELECT workspace_id FROM multiremi_comment_reactions WHERE comment_id = ?").get(report.id)?.workspace_id).toBe(target.id);
  });

  it("preserves both owners, results and Task audit through an upgrade and restart", () => {
    const { db, store } = fixture();
    const issue = createResponsibleTestIssue(store, { title: "Issue owner" });
    const agent = store.createAgent({ name: "Owner agent", provider: "claude" });
    const chat = store.createChatSession({ agentId: agent.id });
    const issueMain = store.getOrCreateDefaultIssueSession(issue.id);
    const chatMain = store.listChatOwnedSessions(chat.id)[0]!;
    const result = store.publishSessionResult(issueMain.id, { title: "Output", body: "Keep this output" });
    const task = store.createSessionTask(chatMain.id, { agentId: agent.id, prompt: "Chat work" });
    const owners = db.query("SELECT id, chat_id, issue_id, workspace_id FROM multiremi_issue_sessions ORDER BY id").all();
    const turn = store.getTurnForAttempt(task.id)!;
    const turnAudit = db.query("SELECT * FROM multiremi_turns WHERE id = ?").get(turn.id);
    const attemptAudit = db.query("SELECT * FROM multiremi_turn_attempts WHERE id = ?").get(task.id);
    expect(turnAudit).toMatchObject({ session_id: chatMain.id, chat_session_id: chat.id });
    expect(chatMain.id.startsWith("ises_")).toBe(true);

    db.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", [migrationId]);
    runMigrations(db);
    runMigrations(db);

    expect(db.query("SELECT id, chat_id, issue_id, workspace_id FROM multiremi_issue_sessions ORDER BY id").all()).toEqual(owners);
    expect(store.getIssueSession(issueMain.id)).toMatchObject({ ownerType: "issue", ownerId: issue.id, chatId: null });
    expect(store.getIssueSession(chatMain.id)).toMatchObject({ ownerType: "chat", ownerId: chat.id });
    expect(store.listSessionResults(issueMain.id)).toContainEqual(result);
    expect(store.getTask(task.id)?.chatSessionId).toBe(chat.id);
    expect(db.query("SELECT * FROM multiremi_turns WHERE id = ?").get(turn.id)).toEqual(turnAudit);
    expect(db.query("SELECT * FROM multiremi_turn_attempts WHERE id = ?").get(task.id)).toEqual(attemptAudit);
    expect(db.query("SELECT id FROM multiremi_schema_migrations WHERE id = ?").get(migrationId)).toBeTruthy();

    store.cancelTask(task.id);
    expect(store.deleteChatSession(chat.id)).toBe(true);
    expect(store.getTask(task.id)?.chatSessionId).toBe(chat.id);
    expect(db.query("SELECT chat_session_id FROM multiremi_turns WHERE id = ?").get(turn.id)?.chat_session_id).toBe(chat.id);
    expect(store.getIssueSession(issueMain.id)?.ownerId).toBe(issue.id);
  });

  it("repairs old Issue moves without transferring a Chat owner or rewriting Task audit", () => {
    const { db, store } = fixture();
    const issue = createResponsibleTestIssue(store, { title: "Old moved issue" });
    const target = store.createWorkspace({ name: "Target workspace" });
    const agent = store.createAgent({ name: "Owner agent", provider: "claude" });
    const chat = store.createChatSession({ agentId: agent.id });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const projected = store.createIssueSession(issue.id, { chatId: chat.id, title: "Private projection" });
    const result = store.publishSessionResult(projected.id, { title: "Private", body: "Private output" });
    const task = store.createSessionTask(main.id, { agentId: agent.id, prompt: "Historic work" });
    store.cancelTask(task.id);

    // The old move contract changed the Issue row but left its Session workspace behind.
    db.run("UPDATE multiremi_issues SET workspace_id = ? WHERE id = ?", [target.id, issue.id]);
    db.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", [migrationId]);
    runMigrations(db);

    expect(store.getIssueSession(main.id)).toMatchObject({ ownerType: "issue", ownerId: issue.id, workspaceId: target.id });
    expect(store.getIssueSession(projected.id)).toMatchObject({ ownerType: "chat", ownerId: chat.id, workspaceId: "local", issueId: null });
    expect(store.listSessionResults(projected.id)).toContainEqual({ ...result, issueId: null, issue_id: null });
    expect(store.getTask(task.id)).toMatchObject({ workspaceId: "local", issueId: issue.id });
  });

  it("rolls back deterministic move repairs when a legacy parent has another owner", () => {
    const { db, store } = fixture();
    const issue = createResponsibleTestIssue(store, { title: "Moved owner" });
    const other = createResponsibleTestIssue(store, { title: "Other owner" });
    const target = store.createWorkspace({ name: "Move target" });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const child = store.createIssueSession(issue.id, { title: "Child", parentSessionId: main.id });
    const agent = store.createAgent({ name: "Owner agent", provider: "claude" });
    const chat = store.createChatSession({ agentId: agent.id });
    const projected = store.createIssueSession(issue.id, { chatId: chat.id, title: "Private projection" });
    const result = store.publishSessionResult(projected.id, { title: "Private", body: "Retain on rollback" });
    db.run("UPDATE multiremi_issues SET workspace_id = ? WHERE id = ?", [target.id, issue.id]);
    db.run("UPDATE multiremi_issue_sessions SET issue_id = ? WHERE id = ?", [other.id, child.id]);
    db.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", [migrationId]);
    const before = db.query("SELECT id, chat_id, issue_id, workspace_id FROM multiremi_issue_sessions ORDER BY id").all();

    expect(() => runMigrations(db)).toThrow("parent has a different owner");
    expect(db.query("SELECT id, chat_id, issue_id, workspace_id FROM multiremi_issue_sessions ORDER BY id").all()).toEqual(before);
    expect(store.listSessionResults(projected.id)).toContainEqual(result);
    expect(db.query("SELECT id FROM multiremi_schema_migrations WHERE id = ?").get(migrationId)).toBeNull();
  });

  it("rejects an ownerless legacy row without deleting it or writing a migration marker", () => {
    const { db, store } = fixture();
    const issue = createResponsibleTestIssue(store, { title: "Valid owner" });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    if (backend === "PostgreSQL") {
      db.exec("ALTER TABLE multiremi_issue_sessions DROP CONSTRAINT multiremi_issue_sessions_owner_check");
    } else {
      db.exec("PRAGMA ignore_check_constraints = ON");
    }
    const now = new Date().toISOString();
    db.run(`INSERT INTO multiremi_issue_sessions
      (id, chat_id, issue_id, workspace_id, title, created_at, updated_at)
      VALUES (?, NULL, NULL, 'local', 'Unknown owner', ?, ?)`, ["ises_unknown_owner", now, now]);
    if (backend === "SQLite") db.exec("PRAGMA ignore_check_constraints = OFF");
    db.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", [migrationId]);
    const before = db.query("SELECT id, chat_id, issue_id, workspace_id FROM multiremi_issue_sessions ORDER BY id").all();

    expect(() => runMigrations(db)).toThrow("missing owner");
    expect(db.query("SELECT id, chat_id, issue_id, workspace_id FROM multiremi_issue_sessions ORDER BY id").all()).toEqual(before);
    expect(store.getIssueSession(main.id)?.ownerId).toBe(issue.id);
    expect(db.query("SELECT id FROM multiremi_schema_migrations WHERE id = ?").get(migrationId)).toBeNull();
  });
});
