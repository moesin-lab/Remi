import { expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";

pendingTurnBackendTests("Shared workspace operator data", fixture => {
  it("projects each inbox row once when historical local memberships are duplicated", () => {
    const { store, db } = fixture();
    const operator = store.getWorkspaceOperator("local")!;
    const duplicate = store.createWorkspaceMember({ id: "old_local_duplicate", workspaceId: "local", name: "Older local member", userId: "local" });
    db.run("UPDATE multiremi_workspace_members SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?", [duplicate.id]);
    const agent = store.createAgent({ name: "Duplicate membership inbox", provider: "codex" });
    const chat = store.createChatSession({ agentId: agent.id });
    const message = store.sendMessage({ session_id: chat.id, sender: { type: "platform", id: null },
      to: { type: "member", ref: duplicate.id }, message_kind: "status", wake_requested: "inbox_only", body_md: "One shared notification" }).message;
    expect(store.getWorkspaceOperator("local")?.id).toBe(operator.id);
    expect(store.listInboxItems(operator.id, "local").map(item => ({ id: item.id, member: item.memberId })))
      .toEqual([{ id: message.id, member: operator.id }]);
    expect(store.countUnreadInboxItems(operator.id, "local")).toBe(1);
    expect(store.listMessageInbox(operator.id, "local").items.map(item => item.id)).toEqual([message.id]);
    expect(store.getWorkspaceMember(duplicate.id)?.name).toBe("Older local member");
  });

  it("preserves each historical receipt and shares subsequent reads without losing unread messages", () => {
    const { store, db } = fixture();
    const first = store.createWorkspaceMember({ workspaceId: "local", name: "Historical A", userId: "old-a" });
    const second = store.createWorkspaceMember({ workspaceId: "local", name: "Historical B", userId: "old-b" });
    const agent = store.createAgent({ name: "Shared assistant", provider: "codex" });
    const chat = store.createChatSession({ agentId: agent.id, creatorId: "old-a" });
    const send = (memberId: string, body: string) => store.sendMessage({ session_id: chat.id,
      sender: { type: "platform", id: null }, to: { type: "member", ref: memberId },
      message_kind: "status", wake_requested: "inbox_only", body_md: body }).message;
    const one = send(first.id, "Already read A");
    const two = send(second.id, "Still unread B");
    const three = send(first.id, "Already read later A");
    const at = new Date().toISOString();
    db.run(`INSERT INTO multiremi_session_lanes(session_id,reader_type,reader_id,execution_scope,cursor_seq,created_at,updated_at)
      VALUES(?,'member',?,'',?,?,?) ON CONFLICT(session_id,reader_type,reader_id,execution_scope) DO UPDATE SET cursor_seq=excluded.cursor_seq`, [chat.id, first.id, three.seq, at, at]);
    const original = store.getMessage(two.id)!;
    const list = () => store.listMessageInbox(store.getWorkspaceOperator("local")!.id, "local");
    expect(list().items.map(item => item.id)).toEqual([two.id]);
    expect(store.getChatSession(chat.id)?.unreadCount).toBe(1);
    // Reading an earlier page must neither consume B's message nor resurrect A's receipts.
    store.readMessageInbox(first.id, chat.id, one.seq);
    expect(list().items.map(item => item.id)).toEqual([two.id]);
    store.readMessageInbox(second.id, chat.id, two.seq);
    expect(list().unread_count).toBe(0);
    expect(store.getChatSession(chat.id)?.unreadCount).toBe(0);
    expect(store.getInboxItem(two.id)?.read).toBe(true);
    expect(store.getMessage(two.id)).toEqual(original);
    expect(db.query("SELECT cursor_seq FROM multiremi_session_lanes WHERE session_id=? AND reader_type='member' AND reader_id=?").get(chat.id, first.id)?.cursor_seq).toBe(three.seq);
    const later = send(second.id, "Future shared notification");
    expect(store.listMessageInbox(first.id, "local").items.map(item => item.id)).toEqual([later.id]);
    expect(store.readAllMessageInbox(second.id, "local")).toBe(1);
    expect(list().unread_count).toBe(0);
    const restored = new MultiremiStore(db);
    expect(restored.getChatSession(chat.id)?.creatorId).toBe("old-a");
    expect(restored.listMessageInbox(first.id, "local").unread_count).toBe(0);
    const elsewhere = store.createWorkspace({ name: "Other workspace" });
    expect(() => store.readMessageInbox(store.getWorkspaceOperator(elsewhere.id)!.id, chat.id)).toThrow("another workspace");
  });

  it("new Chat messages and replies use the shared operator without rewriting the creator", () => {
    const { store } = fixture();
    const agent = store.createAgent({ name: "Chat assistant", provider: "codex" });
    const chat = store.createChatSession({ agentId: agent.id, creatorId: "historical-user" });
    const sent = store.sendChatMessage(chat.id, { body: "Shared input" });
    expect(store.getMessage(sent.message.id)?.sender_id).toBe(store.getWorkspaceOperator("local")!.id);
    fixture().transaction(() => store.appendChatMessageWithinTransaction({ chatSessionId: chat.id, taskId: sent.task.id, role: "assistant", body: "Shared reply" }));
    expect(store.listMessageInbox(store.getWorkspaceOperator("local")!.id, "local").items.some(item => item.body_md === "Shared reply")).toBe(true);
    expect(store.getChatSession(chat.id)?.creatorId).toBe("historical-user");
  });

  it("the shared operator can answer a historical member-addressed choice, but another workspace cannot", () => {
    const { store } = fixture();
    const member = store.createWorkspaceMember({ workspaceId: "local", name: "Old recipient" });
    const agent = store.createAgent({ name: "Asker", provider: "codex" });
    const chat = store.createChatSession({ agentId: agent.id });
    const decision = store.sendMessage({ session_id: chat.id, sender: { type: "agent", id: agent.id },
      to: { type: "member", ref: member.id }, message_kind: "decision", wake_requested: "inbox_only",
      body_md: "Choose", metadata: { message_choice: { status: "pending" } } }).message;
    const other = store.createWorkspace({ name: "Other" });
    expect(() => store.answerMessageDecision(decision.id, { sender: { type: "member", id: store.getWorkspaceOperator(other.id)!.id }, body_md: "No" })).toThrow("recipient");
    expect(store.answerMessageDecision(decision.id, { sender: { type: "member", id: store.getWorkspaceOperator("local")!.id }, body_md: "Yes" }).message.body_md).toBe("Yes");
    expect(store.getMessage(decision.id)?.to_member_id).toBe(member.id);
  });

  it("startup transfers a persisted Chat question once and invalidates its old external card", () => {
    const { store, db } = fixture();
    const member = store.createWorkspaceMember({ workspaceId: "local", name: "Historical contact" });
    const runtime = store.registerRuntime({ name: "Question host", provider: "codex", daemonId: "shared-q" });
    const agent = store.createAgent({ name: "Asker", provider: "codex" });
    const chat = store.createChatSession({ agentId: agent.id, creatorId: "historical-creator" });
    const task = store.createTask({ agentId: agent.id, chatSessionId: chat.id, prompt: "Ask" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id); store.startTask(task.id);
    const request = store.createTaskHumanRequest({ taskId: task.id, kind: "question", payload: { questions: [{ question: "Choose", options: [{ label: "A" }] }] } });
    const message = store.getMessage(request.id)!;
    const metadata = structuredClone(message.metadata) as Record<string, any>;
    metadata.question.route = [{ handler: { type: "member", id: member.id }, issue_id: null, stage: "human" }];
    metadata.question.responsibility_revision = "historical-private-owner";
    db.run("UPDATE multiremi_conversation_log SET metadata=?,card_token_hash='old-card',card_token_recipient='ou_old' WHERE id=?", [JSON.stringify(metadata), message.id]);
    db.run("DELETE FROM multiremi_schema_migrations WHERE id=?", ["workspace-operator-questions-v1:local"]);
    const restored = new MultiremiStore(db);
    const question = restored.getQuestion(message.id, { type: "member", id: restored.getWorkspaceOperator("local")!.id })!;
    expect(question.current_handler).toEqual({ type: "member", id: restored.getWorkspaceOperator("local")!.id });
    expect(question.actions.allowed).toContain("answer");
    expect(question.route_revision).toBe(2);
    expect(question.history.filter(event => event.reason === "workspace_operator_unified")).toHaveLength(1);
    expect(restored.getMessage(message.id)?.card_token_hash).toBeNull();
    expect(restored.getChatSession(chat.id)?.creatorId).toBe("historical-creator");
    const reopened = new MultiremiStore(db);
    expect(reopened.getQuestion(message.id)?.route_revision).toBe(2);
  });

  it("startup preserves an Agent's active question handoff while unifying the later human step", () => {
    const { store, db } = fixture();
    const runtime = store.registerRuntime({ name: "Migration host", provider: "codex", daemonId: "shared-agent-q", maxConcurrency: 4 });
    const leader = store.createAgent({ name: "Question leader", provider: "codex" });
    const worker = store.createAgent({ name: "Question worker", provider: "codex" });
    const issue = store.createIssue({ title: "Agent question chain", assigneeType: "agent", assigneeId: leader.id });
    const task = store.createTask({ agentId: worker.id, issueId: issue.id, prompt: "Ask leader" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id); store.startTask(task.id);
    const request = store.createTaskHumanRequest({ taskId: task.id, kind: "question", payload: { questions: [{ question: "Choose", options: [{ label: "A" }] }] } });
    const before = store.getQuestion(request.id)!;
    expect(before.current_handler).toEqual({type: "agent", id: leader.id});
    const message = store.getMessage(request.id)!;
    const metadata = structuredClone(message.metadata) as Record<string, any>;
    metadata.question.responsibility_revision = "historical-shared-handler";
    db.run("UPDATE multiremi_conversation_log SET metadata=?,card_token_hash='agent-route-card',card_token_recipient='ou_agent_route' WHERE id=?", [JSON.stringify(metadata), message.id]);
    db.run("DELETE FROM multiremi_schema_migrations WHERE id=?", ["workspace-operator-questions-v1:local"]);
    const beforeTurns = db.query("SELECT id FROM multiremi_turns WHERE agent_id=? ORDER BY id").all(leader.id);
    const beforeNotifications = db.query("SELECT id,revision FROM multiremi_conversation_log WHERE id!=? ORDER BY id").all(message.id);
    const restored = new MultiremiStore(db);
    expect(restored.getQuestion(request.id)).toMatchObject({ current_handler: before.current_handler, route_revision: before.route_revision });
    expect(db.query("SELECT id FROM multiremi_turns WHERE agent_id=? ORDER BY id").all(leader.id)).toEqual(beforeTurns);
    expect(db.query("SELECT id,revision FROM multiremi_conversation_log WHERE id!=? ORDER BY id").all(message.id)).toEqual(beforeNotifications);
    expect(restored.getMessage(message.id)?.card_token_hash).toBe("agent-route-card");
    expect(restored.getTask(task.id)?.status).toBe("awaiting_human");
  });

  it("startup leaves settled answers and closed question audit records unchanged", () => {
    const { store, db } = fixture();
    const runtime = store.registerRuntime({ name: "Historical question host", provider: "codex", daemonId: "shared-settled-q", maxConcurrency: 8 });
    const member = store.createWorkspaceMember({ workspaceId: "local", name: "Historical question recipient" });
    const questionIds: string[] = [];
    for (const status of ["closed", "answered"] as const) {
      const agent = store.createAgent({ name: `Historical ${status}`, provider: "codex" });
      const chat = store.createChatSession({ agentId: agent.id, creatorId: "historical-creator" });
      const task = store.createTask({ agentId: agent.id, chatSessionId: chat.id, prompt: "Historical question" });
      expect(store.claimTask(runtime.id)?.id).toBe(task.id); store.startTask(task.id);
      const request = store.createTaskHumanRequest({ taskId: task.id, kind: "question", payload: { questions: [{ question: "Choose", options: [{ label: "A" }] }] } });
      const operator = { type: "member" as const, id: store.getWorkspaceOperator("local")!.id };
      if (status === "answered") store.answerQuestion(request.id, { expected_route_revision: 1, response: { answer: "A" } }, operator);
      else store.closeQuestion(request.id, { expected_route_revision: 1, reason: "Historical question withdrawn" }, operator);
      const metadata = structuredClone(store.getMessage(request.id)!.metadata) as Record<string, any>;
      metadata.question.route = [{ handler: { type: "member", id: member.id }, issue_id: null, stage: "human" }];
      metadata.question.responsibility_revision = "historical-completed-owner";
      metadata.question.wait.status = status === "answered" ? "consumed" : "detached";
      db.run("UPDATE multiremi_conversation_log SET metadata=?,card_token_hash=?,card_token_recipient='ou_historical' WHERE id=?", [JSON.stringify(metadata), `historical-card-${status}`, request.id]);
      questionIds.push(request.id);
    }
    const original = questionIds.map(id => store.getMessage(id));
    db.run("DELETE FROM multiremi_schema_migrations WHERE id=?", ["workspace-operator-questions-v1:local"]);
    const restored = new MultiremiStore(db);
    expect(questionIds.map(id => restored.getMessage(id))).toEqual(original);
  });

  it("historical human ownership does not block Runtime placement inside the same workspace", () => {
    const { store } = fixture();
    const runtime = store.registerRuntime({ name: "Historical private host", provider: "codex", visibility: "private", ownerId: "old-owner", daemonId: "shared-runtime" });
    const agent = store.createAgent({ name: "Shared agent", provider: "codex", ownerId: "local" });
    const task = store.createTask({ agentId: agent.id, prompt: "Shared work" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
  });
});
