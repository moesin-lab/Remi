import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";
import { mutateExecutionFixture, requestMessageBody, sentTask, turnApiPath } from "./unified-test-paths.js";
import { bindFeishuTopicFixture } from "./feishu-topic-fixture.js";

afterEach(resetMultiremiTestEnv);

async function fixture() {
  const store = createStore();
  store.ensureLocalWorkspace();
  for (const [userId, role] of [["alice", "member"], ["bob", "admin"]] as const) {
    store.createWorkspaceMember({ workspaceId: "local", userId, name: userId, role });
  }
  const aliceToken = await store.createAccessToken({ name: "Alice", type: "pat", userId: "alice", workspaceId: "local" });
  const bobToken = await store.createAccessToken({ name: "Bob", type: "pat", userId: "bob", workspaceId: "local" });
  const agent = store.createAgent({ name: "Shared", provider: "claude", visibility: "workspace", ownerId: "alice" });
  const issue = store.createIssue({ title: "Team work", workspaceId: "local", createdBy: "alice" });
  const chat = store.createChatSession({ agentId: agent.id, creatorId: "alice", workspaceId: "local" });
  const linked = store.listChatOwnedSessions(chat.id)[0]!;
  db!.run("UPDATE multiremi_issue_sessions SET issue_id = ? WHERE id = ?", [issue.id, linked.id]);
  store.appendSessionEvent(linked.id, { authorType: "member", authorId: "alice", body: "PRIVATE_SESSION_EVENT" });
  store.publishSessionResult(linked.id, { title: "Private result", body: "PRIVATE_SESSION_RESULT" });
  const app = createMultiremiApp({ store, authToken: "MASTER", shareSecret: "owner-share-secret" });
  const alice = { Authorization: `Bearer ${aliceToken.token}`, "Content-Type": "application/json" };
  const bob = { Authorization: `Bearer ${bobToken.token}`, "Content-Type": "application/json" };
  return { store, app, agent, issue, chat, linked, alice, bob };
}

describe("Session owner API boundaries", () => {
  it("creates an Issue-owned Session without reusing its linked private Chat", async () => {
    const f = await fixture();
    const chatIds = f.store.listChatSessions("local", { includeArchived: true }).map(chat => chat.id);
    const response = await f.app.request(`/api/issues/${f.issue.id}/sessions`, {
      method: "POST", headers: f.bob, body: JSON.stringify({ title: "Issue work" }),
    });
    expect(response.status).toBe(201);
    const session = await response.json();
    expect(session).toMatchObject({ owner_type: "issue", owner_id: f.issue.id, chat_id: null, issue_id: f.issue.id });
    expect(f.store.listChatSessions("local", { includeArchived: true }).map(chat => chat.id)).toEqual(chatIds);
    const taskResponse = await f.app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST", headers: f.bob, body: JSON.stringify(requestMessageBody(f.store, { agent_id: f.agent.id, prompt: "Independent work" })),
    });
    expect(taskResponse.status).toBe(200);
    expect(sentTask(f.store, await taskResponse.json()).chatSessionId).toBeNull();
    expect(f.store.getIssueSession(session.id)?.chatId).toBeNull();
    expect(f.store.listChatSessions("local", { includeArchived: true }).map(chat => chat.id)).toEqual(chatIds);
  });

  it("rejects Chat ownership supplied to the Issue creation endpoint", async () => {
    const f = await fixture();
    const before = f.store.listIssueSessions(f.issue.id, true).length;
    for (const field of ["chatId", "chat_id"]) {
      const response = await f.app.request(`/api/issues/${f.issue.id}/sessions`, {
        method: "POST", headers: f.bob, body: JSON.stringify({ title: "Injection", [field]: f.chat.id }),
      });
      expect(response.status, field).toBe(400);
    }
    expect(f.store.listIssueSessions(f.issue.id, true)).toHaveLength(before);
  });

  it("does not expand private Chat permissions through a linked Issue", async () => {
    const f = await fixture();
    for (const path of [
      `/api/sessions/${f.linked.id}`,
      `/api/sessions/${f.linked.id}/inherited-context`,
      `/api/sessions/${f.linked.id}/log`,
      `/api/sessions/${f.linked.id}/messages`,
    ]) {
      expect((await f.app.request(path, { headers: f.bob })).status, path).toBe(403);
      expect((await f.app.request(path, { headers: f.alice })).status, path).toBe(200);
    }
    const taskResponse = await f.app.request(`/api/sessions/${f.linked.id}/messages`, {
      method: "POST", headers: f.bob, body: JSON.stringify(requestMessageBody(f.store, { agent_id: f.agent.id, prompt: "Intrusion" })),
    });
    expect(taskResponse.status).toBe(403);
    const sessions = await (await f.app.request(`/api/issues/${f.issue.id}/sessions`, { headers: f.bob })).json();
    expect(sessions.some((session: { id: string }) => session.id === f.linked.id)).toBe(false);
    const results = await (await f.app.request(`/api/issues/${f.issue.id}/session-results`, { headers: f.bob })).text();
    expect(results).not.toContain("PRIVATE_SESSION_RESULT");
    const mintResponse = await f.app.request(`/api/issues/${f.issue.id}/share`, { method: "POST", headers: f.alice });
    expect(mintResponse.status).toBe(201);
    const minted = await mintResponse.json();
    const shared = await (await f.app.request(`/api/shares/${minted.share.token}`, { headers: f.bob })).text();
    expect(shared).not.toContain("PRIVATE_SESSION_EVENT");
    expect(shared).not.toContain("PRIVATE_SESSION_RESULT");
    const privateTask = f.store.createSessionTask(f.linked.id, { agentId: f.agent.id, prompt: "PRIVATE_SESSION_TASK" });
    mutateExecutionFixture(f.store, "UPDATE multiremi_turn_execution_records SET status = 'running' WHERE id = ?", [privateTask.id]);
    f.store.completeTask(privateTask.id, { output: "PRIVATE_TERMINAL_OUTPUT" });
    const afterCompletion = await (await f.app.request(`/api/shares/${minted.share.token}`, { headers: f.bob })).text();
    expect(afterCompletion).not.toContain("PRIVATE_SESSION_TASK");
    expect(afterCompletion).not.toContain("PRIVATE_TERMINAL_OUTPUT");
  });

  it("keeps public Issue Task authority while isolating Session content and private Chat Tasks", async () => {
    const f = await fixture();
    const main = f.store.createIssueSession(f.issue.id, { title: "Own" });
    const sibling = f.store.createIssueSession(f.issue.id, { title: "Sibling" });
    const task = f.store.createSessionTask(main.id, { agentId: f.agent.id, prompt: "Own task" });
    const siblingTask = f.store.createSessionTask(sibling.id, { agentId: f.agent.id, prompt: "Sibling task" });
    const privateTask = f.store.createSessionTask(f.linked.id, { agentId: f.agent.id, prompt: "Private task" });
    const privateWorker = f.store.createAgent({ name: "Private sibling worker", provider: "claude", visibility: "workspace", ownerId: "alice" });
    const privateSibling = f.store.createSessionTask(f.linked.id, { agentId: privateWorker.id, prompt: "Private sibling" });
    const token = await f.store.createTaskAccessToken(f.store.getTask(task.id)!, "alice");
    const headers = { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" };
    for (const tail of ["", "/log", "/inherited-context"]) {
      expect((await f.app.request(`/api/sessions/${main.id}${tail}`, { headers })).status).toBe(200);
      expect((await f.app.request(`/api/sessions/${sibling.id}${tail}`, { headers })).status).toBe(403);
    }
    for (const [method, tail] of [["GET", "/messages"], ["POST", "/messages"]] as const) {
      expect((await f.app.request(`/api/sessions/${sibling.id}${tail}`, {
        method, headers, body: method === "POST" ? JSON.stringify({ body_md: "Cross-Session write", to: { type: "none" } }) : undefined,
      })).status).toBe(403);
    }
    const siblingDetail = await f.app.request(turnApiPath(f.store, siblingTask.id), { headers });
    expect(siblingDetail.status).toBe(200);
    expect((await siblingDetail.json()).turn.legacy_prompt).toBe("Sibling task");
    const listed = await (await f.app.request("/api/turns", { headers })).json();
    expect(listed.turns.map((entry: { current_attempt_id: string }) => entry.current_attempt_id).sort()).toEqual([task.id, siblingTask.id].sort());
    const active = await (await f.app.request(`/api/turns?issue=${f.issue.id}`, { headers })).json();
    expect(active.turns.map((entry: { current_attempt_id: string }) => entry.current_attempt_id).sort()).toEqual([task.id, siblingTask.id].sort());
    expect(JSON.stringify(active)).not.toContain("Private task");
    expect(JSON.stringify(active)).not.toContain("Private sibling");
    const privateToken = await f.store.createTaskAccessToken(privateTask, "alice");
    const privateHeaders = { Authorization: `Bearer ${privateToken.token}`, "Content-Type": "application/json" };
    expect((await f.app.request(turnApiPath(f.store, privateTask.id), { headers: privateHeaders })).status).toBe(200);
    for (const privateTarget of [privateTask, privateSibling]) {
      for (const [method, tail] of [["GET", ""], ["GET", "/trace"], ["POST", "/cancel"]] as const) {
        expect((await f.app.request(turnApiPath(f.store, privateTarget.id, tail), { method, headers })).status).toBe(403);
        if (privateTarget.id !== privateTask.id) {
          expect((await f.app.request(turnApiPath(f.store, privateTarget.id, tail), {
            method, headers: privateHeaders,
          })).status).toBe(403);
        }
      }
      expect(f.store.getTask(privateTarget.id)?.status).toBe("queued");
    }
    expect((await f.app.request(turnApiPath(f.store, siblingTask.id, "/cancel"), { method: "POST", headers })).status).toBe(200);
    expect(f.store.getTask(siblingTask.id)?.status).toBe("cancelled");
  });

  it("does not extend public Issue Task authority beyond its credential workspace", async () => {
    const f = await fixture();
    const sourceSession = f.store.getOrCreateDefaultIssueSession(f.issue.id);
    const source = f.store.createSessionTask(sourceSession.id, { agentId: f.agent.id, prompt: "Own workspace" });
    const foreign = f.store.createWorkspace({ name: "Foreign tasks", slug: "foreign-tasks", issuePrefix: "FTK" });
    f.store.createWorkspaceMember({ workspaceId: foreign.id, userId: "alice", name: "alice", role: "member" });
    const agent = f.store.createAgent({ name: "Foreign worker", provider: "claude", workspaceId: foreign.id, ownerId: "alice" });
    const issue = f.store.createIssue({ title: "Foreign public work", workspaceId: foreign.id });
    const task = f.store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Foreign task" });
    expect(task.chatSessionId).toBeNull();
    const token = await f.store.createTaskAccessToken(source, "alice");
    const headers = { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" };
    for (const [method, tail] of [["GET", ""], ["GET", "?attempts=true"], ["POST", "/cancel"]] as const) {
      expect((await f.app.request(turnApiPath(f.store, task.id, tail), {
        method, headers, body: method === "POST" ? "{}" : undefined,
      })).status).toBe(404);
    }
    expect((await f.app.request(`/api/sessions/${task.issueSessionId}/messages`, {
      method: "POST", headers, body: JSON.stringify(requestMessageBody(f.store, {
        agentId: agent.id, prompt: "Cross-workspace action",
      })),
    })).status).toBe(404);
    const listed = await (await f.app.request("/api/turns", { headers })).json();
    expect(listed.turns.map((entry: { current_attempt_id: string }) => entry.current_attempt_id)).toEqual([source.id]);
    expect(f.store.getTask(task.id)?.status).toBe("queued");
    expect(f.store.listTaskSteerMessages(task.id)).toHaveLength(0);
  });

  it("allows public Issue delegation without granting cross-Session content or private Chat access", async () => {
    const f = await fixture();
    const sourceSession = f.store.getOrCreateDefaultIssueSession(f.issue.id);
    const source = f.store.createSessionTask(sourceSession.id, { agentId: f.agent.id, prompt: "Delegate work" });
    const worker = f.store.createAgent({ name: "Worker", provider: "claude", visibility: "workspace", ownerId: "alice" });
    const otherIssue = f.store.createIssue({ title: "Independent work", workspaceId: "local", createdBy: "alice" });
    const targetSession = f.store.getOrCreateDefaultIssueSession(otherIssue.id);
    const token = await f.store.createTaskAccessToken(source, "alice");
    const headers = { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" };
    const response = await f.app.request(`/api/sessions/${targetSession.id}/messages`, {
      method: "POST", headers, body: JSON.stringify(requestMessageBody(f.store, {
        agentId: worker.id, prompt: "Independent delegated task",
      })),
    });
    expect(response.status).toBe(200);
    const delegated = sentTask(f.store, await response.json());
    expect(delegated).toMatchObject({ issueId: otherIssue.id, issueSessionId: targetSession.id, chatSessionId: null,
      delegatedByAgentId: f.agent.id, delegatedFromIssueSessionId: sourceSession.id });
    const dispatch = f.store.getMessage(f.store.getTurnForAttempt(delegated.id)!.trigger_message_id!)!;
    expect(dispatch.task_id).toBe(f.store.getTurnForAttempt(source.id)!.id);
    expect(delegated.execution_scope).not.toBe(source.execution_scope);
    expect((await f.app.request(turnApiPath(f.store, delegated.id), { headers })).status).toBe(200);
    expect((await f.app.request(`/api/sessions/${targetSession.id}/log`, { headers })).status).toBe(403);
    const delegatedToken = await f.store.createTaskAccessToken(delegated, "alice");
    expect((await f.app.request(turnApiPath(f.store, source.id), {
      headers: { Authorization: `Bearer ${delegatedToken.token}` },
    })).status).toBe(200);
    expect((await f.app.request(`/api/sessions/${sourceSession.id}/log`, {
      headers: { Authorization: `Bearer ${delegatedToken.token}` },
    })).status).toBe(403);
    const before = f.store.listTasksForIssue(f.issue.id).length;
    const denied = await f.app.request(`/api/sessions/${f.linked.id}/messages`, {
      method: "POST", headers, body: JSON.stringify(requestMessageBody(f.store, {
        agentId: worker.id, prompt: "Private projection injection",
      })),
    });
    expect(denied.status).toBe(403);
    expect(f.store.listTasksForIssue(f.issue.id)).toHaveLength(before);
  });

  it("keeps a Chat work Task on its Session axis across ordinary Chat content and controls", async () => {
    const f = await fixture();
    const ordinary = f.store.sendChatMessage(f.chat.id, { body: "ORDINARY_PRIVATE_MARKER" });
    const task = f.store.createSessionTask(f.linked.id, { agentId: f.agent.id, prompt: "Work inside this Session" });
    expect(f.store.getTaskChatExecutionKind(task)).toBe("session");
    const token = await f.store.createTaskAccessToken(task, "alice");
    const headers = { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" };
    const location = f.store.locateConversationLogEntry(f.chat.id, ordinary.message.id)!;
    const cursor = f.store.getSessionAgentReadProgress(f.chat.id, f.agent.id);
    const before = f.store.getChatSession(f.chat.id);
    for (const path of [
      `/api/sessions/${f.chat.id}/log?before=10`,
      `/api/sessions/${f.chat.id}/log/entry?from=0&to=${location.head_seq}`,
      `/api/sessions/${f.chat.id}/log/entry?seq=${location.seq}`,
      `/api/sessions/${f.chat.id}/log/entry?id=${ordinary.message.id}`,
      `/api/sessions/${f.chat.id}/log/locate?id=${ordinary.message.id}`,
      `/api/multiremi/chats/${f.chat.id}`,
      `/api/sessions/${f.chat.id}/messages`,
      `/api/chat/sessions/${f.chat.id}`,
      `/api/turns?session_id=${f.chat.id}`,
      "/api/multiremi/chats", "/api/chat/sessions",
    ]) {
      const response = await f.app.request(path, { headers });
      expect(response.status, path).toBe(path.startsWith("/api/turns?") ? 400 : 403);
      expect(await response.text()).not.toContain("ORDINARY_PRIVATE_MARKER");
    }
    for (const [method, path, body] of [
      ["POST", `/api/sessions/${f.chat.id}/messages`, { body_md: "Wrong axis send", to: { type: "agent", ref: f.agent.id } }],
      ["PATCH", `/api/messages/${ordinary.message.id}`, { body_md: "Wrong axis edit" }],
      ["DELETE", `/api/messages/${ordinary.message.id}`, {}],
      ["POST", turnApiPath(f.store, ordinary.task.id, "/cancel"), {}],
      ["POST", "/api/inbox/read", { session_id: f.chat.id }],
      ["PATCH", `/api/multiremi/chats/${f.chat.id}`, { title: "Wrong axis metadata" }],
      ["PATCH", `/api/chat/sessions/${f.chat.id}`, { title: "Wrong axis metadata" }],
      ["DELETE", `/api/chat/sessions/${f.chat.id}`, {}],
    ] as const) {
      expect((await f.app.request(path, { method, headers, body: JSON.stringify(body) })).status, `${method} ${path}`).toBe(403);
    }
    const attachment = f.store.createAttachment({ workspaceId: "local", chatSessionId: f.chat.id,
      chatMessageId: ordinary.message.id, filename: "ordinary-private.txt", url: "https://example.test/private.txt" });
    expect((await f.app.request(`/api/multiremi/attachments/${attachment.id}`, { headers })).status).toBe(404);
    const upload = new FormData();
    upload.set("message", JSON.stringify({ body_md: "Wrong axis attachment", to: { type: "agent", ref: f.agent.id } }));
    upload.append("file", new File(["PRIVATE_UPLOAD"], "private.txt", { type: "text/plain" }));
    expect((await f.app.request(`/api/sessions/${f.chat.id}/messages`, {
      method: "POST", headers: { Authorization: headers.Authorization }, body: upload,
    })).status).toBe(403);
    expect(f.store.getChatSession(f.chat.id)).toEqual(before);
    expect(f.store.getTask(ordinary.task.id)?.prompt).toBe("ORDINARY_PRIVATE_MARKER");
    expect(f.store.getTask(ordinary.task.id)?.status).toBe("queued");
    expect(f.store.getSessionAgentReadProgress(f.chat.id, f.agent.id)).toEqual(cursor);
    for (const path of [
      `/api/sessions/${f.linked.id}`, `/api/sessions/${f.linked.id}/log`,
      `/api/multiremi/chats/${f.chat.id}/sessions`,
      `/api/multiremi/chats/${f.chat.id}/sessions/${f.linked.id}`,
      `/api/multiremi/chats/${f.chat.id}/sessions/${f.linked.id}/results`,
      `/api/sessions/${f.linked.id}/messages`,
    ]) expect((await f.app.request(path, { headers })).status, path).toBe(200);
    const created = await f.app.request(`/api/multiremi/chats/${f.chat.id}/sessions`, {
      method: "POST", headers, body: JSON.stringify({ title: "Same owner metadata creation" }),
    });
    expect(created.status).toBe(201);
    expect((await created.json()).session).toMatchObject({ owner_type: "chat", owner_id: f.chat.id });
    expect((await f.app.request(`/api/sessions/${f.linked.id}/messages`, {
      method: "POST", headers, body: JSON.stringify(requestMessageBody(f.store, { agent_id: f.agent.id, prompt: "Own Session dispatch" })),
    })).status).toBe(200);
    const issueTask = f.store.createSessionTask(f.store.getOrCreateDefaultIssueSession(f.issue.id).id, {
      agentId: f.agent.id, prompt: "Issue-owned work cannot use a creator fallback",
    });
    const issueToken = await f.store.createTaskAccessToken(issueTask, "alice");
    for (const path of [`/api/sessions/${f.chat.id}/log`, `/api/sessions/${f.chat.id}/messages`]) {
      expect((await f.app.request(path, { headers: { Authorization: `Bearer ${issueToken.token}` } })).status).toBe(403);
    }
  });

  it("does not turn a kind or Chat pointer injection into ordinary Chat authority", async () => {
    const f = await fixture();
    f.store.sendChatMessage(f.chat.id, { body: "ORDINARY_AXIS_SECRET" });
    const response = await f.app.request(`/api/sessions/${f.linked.id}/messages`, {
      method: "POST", headers: f.alice, body: JSON.stringify(requestMessageBody(f.store, {
        agentId: f.agent.id, chatSessionId: f.chat.id, prompt: "Generic request inside a Session", kind: "chat",
      })),
    });
    expect(response.status).toBe(200);
    const task = sentTask(f.store, await response.json());
    expect(f.store.getTaskChatExecutionKind(task)).toBe("session");
    expect(task.issueSessionId).toBe(f.linked.id);
    expect(f.store.listChatMessages(f.chat.id).some(message => message.role === "user" && message.taskId === task.id)).toBe(false);
    const token = await f.store.createTaskAccessToken(task, "alice");
    const headers = { Authorization: `Bearer ${token.token}` };
    for (const path of [`/api/sessions/${f.chat.id}/log`, `/api/sessions/${f.chat.id}/messages`]) {
      const denied = await f.app.request(path, { headers });
      expect(denied.status, path).toBe(403);
      expect(await denied.text()).not.toContain("ORDINARY_AXIS_SECRET");
    }
  });

  it("requires a durable human root request before a Chat-kind Task can use the ordinary axis", async () => {
    const f = await fixture();
    const ordinary = f.store.sendChatMessage(f.chat.id, { body: "ORDINARY_EVIDENCE_SECRET" });
    f.store.cancelTask(ordinary.task.id);
    const input = { agentId: f.agent.id, chatSessionId: f.chat.id,
      assignmentAuthorType: "system" as const, prompt: "Platform request with forged Chat kind", kind: "chat" };
    const task = f.store.createTask(input);
    expect(f.store.getTaskChatExecutionKind(task)).toBe("ordinary");
    expect(f.store.listChatMessages(f.chat.id).some(message => message.role === "user" && message.taskId === task.id)).toBe(false);
    const token = await f.store.createTaskAccessToken(task, "alice");
    for (const path of [`/api/sessions/${f.chat.id}/log`, `/api/sessions/${f.chat.id}/messages`]) {
      const denied = await f.app.request(path, { headers: { Authorization: `Bearer ${token.token}` } });
      expect(denied.status, path).toBe(403);
      expect(await denied.text()).not.toContain("ORDINARY_EVIDENCE_SECRET");
    }
  });

  it("fails closed when an Issue owner has moved to another workspace", async () => {
    const f = await fixture();
    const session = f.store.createIssueSession(f.issue.id, { title: "Retained" });
    db!.run("UPDATE multiremi_issue_sessions SET chat_id = NULL WHERE id = ?", [session.id]);
    const workspace = f.store.createWorkspace({ name: "Other", slug: "other-owner", issuePrefix: "OTH" });
    db!.run("UPDATE multiremi_issues SET workspace_id = ? WHERE id = ?", [workspace.id, f.issue.id]);
    for (const tail of ["", "/log", "/inherited-context"]) {
      expect((await f.app.request(`/api/sessions/${session.id}${tail}`, { headers: f.alice })).status).toBe(404);
    }
  });

  it("uses the Issue-owned Main for default timeline and Issue activity", async () => {
    const f = await fixture();
    const main = f.store.getOrCreateDefaultIssueSession(f.issue.id);
    f.store.createIssueComment(f.issue.id, { issueSessionId: main.id, body: "ISSUE_MAIN_COMMENT" });
    f.store.sendMessage({ session_id: f.linked.id, sender: { type: "member", id: f.store.findWorkspaceMemberForUser("alice", "local")!.id },
      to: { type: "none" }, message_kind: "report", wake_requested: "inbox_only", body_md: "CHAT_MAIN_COMMENT" });
    f.store.appendIssueActivity(f.issue.id, { actorType: "member", actorId: "alice", type: "issue_updated", body: "ISSUE_ACTIVITY" });
    db!.run("UPDATE multiremi_issue_sessions SET updated_at = '2099-01-01T00:00:00.000Z' WHERE id = ?", [f.linked.id]);
    const timeline = await (await f.app.request(`/api/issues/${f.issue.id}/timeline?issue_session_id=@default&limit=10`, {
      headers: f.alice,
    })).json();
    expect(timeline.issue_session_id).toBe(main.id);
    expect(JSON.stringify(timeline)).toContain("ISSUE_MAIN_COMMENT");
    expect(JSON.stringify(timeline)).not.toContain("CHAT_MAIN_COMMENT");
    const chatLog = await (await f.app.request(`/api/sessions/${f.linked.id}/log?with_activity=1`, { headers: f.alice })).json();
    expect(chatLog.activities).toBeUndefined();
    const issueLog = await (await f.app.request(`/api/sessions/${main.id}/log?with_activity=1`, { headers: f.alice })).json();
    expect(JSON.stringify(issueLog.activities)).toContain("ISSUE_ACTIVITY");
  });

  it("rejects a Chat projection attached to an Issue in another workspace", async () => {
    const f = await fixture();
    const foreign = f.store.createWorkspace({ name: "Foreign projection", slug: "foreign-projection", issuePrefix: "FPR" });
    f.store.createWorkspaceMember({ workspaceId: foreign.id, userId: "alice", name: "alice", role: "member" });
    const issue = f.store.createIssue({ title: "Foreign Issue", workspaceId: foreign.id, createdBy: "alice" });
    db!.run("UPDATE multiremi_issue_sessions SET issue_id = ? WHERE id = ?", [issue.id, f.linked.id]);
    expect((await f.app.request(`/api/sessions/${f.linked.id}`, { headers: f.alice })).status).toBe(200);
    for (const tail of ["", "/participants"]) {
      expect((await f.app.request(`/api/issues/${issue.id}/sessions/${f.linked.id}${tail}`, {
        headers: f.alice,
      })).status, tail).toBe(404);
    }
  });

  it("preserves private Task audit boundaries after deleting a Chat with foreign keys enabled", async () => {
    const f = await fixture();
    db!.run("PRAGMA foreign_keys = ON");
    const task = f.store.createSessionTask(f.linked.id, { agentId: f.agent.id, prompt: "DELETED_PRIVATE_TASK" });
    const previousToken = await f.store.createTaskAccessToken(task, "alice");
    f.store.deleteChatSession(f.chat.id);
    const retained = f.store.getTask(task.id)!;
    expect(retained).toMatchObject({ chatSessionId: f.chat.id, issueSessionId: null });
    expect((await f.app.request(turnApiPath(f.store, task.id), {
      headers: { Authorization: `Bearer ${previousToken.token}` },
    })).status).toBe(401);
    const retainedToken = await f.store.createTaskAccessToken(retained, "alice");
    for (const headers of [f.bob, { Authorization: `Bearer ${retainedToken.token}` }]) {
      expect((await f.app.request(turnApiPath(f.store, task.id), { headers })).status).toBe(403);
      expect((await f.app.request(turnApiPath(f.store, task.id, "/trace"), { headers })).status).toBe(403);
      const deletedLog = await f.app.request(`/api/sessions/${f.linked.id}/log`, { headers });
      expect([403, 404]).toContain(deletedLog.status);
      expect(await deletedLog.text()).not.toContain("DELETED_PRIVATE_TASK");
    }
    const mint = await (await f.app.request(`/api/issues/${f.issue.id}/share`, { method: "POST", headers: f.bob })).json();
    expect(await (await f.app.request(`/api/shares/${mint.share.token}`, { headers: f.bob })).text())
      .not.toContain("DELETED_PRIVATE_TASK");
  });

  it("rejects an existing Session id without changing its owner or participants", async () => {
    const f = await fixture();
    const issueSession = f.store.getOrCreateDefaultIssueSession(f.issue.id);
    const before = f.store.getIssueSession(issueSession.id);
    const participants = f.store.listSessionParticipants(issueSession.id);
    const response = await f.app.request(`/api/multiremi/chats/${f.chat.id}/sessions`, {
      method: "POST", headers: f.alice, body: JSON.stringify({ id: issueSession.id, title: "Owner injection" }),
    });
    expect(response.status).toBe(409);
    expect(f.store.getIssueSession(issueSession.id)).toEqual(before);
    expect(f.store.listSessionParticipants(issueSession.id)).toEqual(participants);
  });

  it("keeps public dispatch authority while requiring a verified topic binding for Session coordination", async () => {
    const f = await fixture();
    const publicSession = f.store.getOrCreateDefaultIssueSession(f.issue.id);
    const source = f.store.sendChatMessage(f.chat.id, { body: "Coordinate work" }).task;
    mutateExecutionFixture(f.store, "UPDATE multiremi_turn_execution_records SET issue_id = ? WHERE id = ?", [f.issue.id, source.id]);
    const token = await f.store.createTaskAccessToken(f.store.getTask(source.id)!, "alice");
    const headers = { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" };
    const path = `/api/sessions/${publicSession.id}`;
    const metadataPath = `/api/issues/${f.issue.id}/sessions/${publicSession.id}`;
    const post = (dispatch = true) => f.app.request(`${path}/messages`, {
      method: "POST", headers, body: JSON.stringify({ body_md: "Public coordination comment", message_kind: "request",
        to: dispatch ? { type: "agent", ref: f.agent.id } : { type: "none" } }),
    });
    // Ordinary Chat requests retain public dispatch authority, while content
    // and coordination metadata require their own verified Session authority.
    expect((await post(false)).status).toBe(403);
    expect((await post()).status).toBe(200);
    expect((await f.app.request(metadataPath, { headers })).status).toBe(403);
    bindFeishuTopicFixture(f.store, db!, f.chat.id, f.issue.id);
    expect((await post()).status).toBe(200);
    expect((await post(false)).status).toBe(403);
    expect((await f.app.request(metadataPath, { headers })).status).toBe(200);
    const otherIssue = f.store.createIssue({ title: "Unbound", workspaceId: "local" });
    const otherSession = f.store.getOrCreateDefaultIssueSession(otherIssue.id);
    expect((await f.app.request(`/api/sessions/${otherSession.id}/messages`, {
      method: "POST", headers, body: JSON.stringify({ body_md: "Cross-Issue intrusion", message_kind: "request", to: { type: "agent", ref: f.agent.id } }),
    })).status).toBe(403);
    const otherChat = f.store.createChatSession({ agentId: f.agent.id, creatorId: "bob" });
    const privateProjection = f.store.createIssueSession(f.issue.id, { chatId: otherChat.id });
    expect((await f.app.request(`/api/sessions/${privateProjection.id}/messages`, { headers })).status).toBe(403);
    const foreign = f.store.createWorkspace({ name: "Foreign", slug: "foreign-topic", issuePrefix: "FRN" });
    db!.run("UPDATE multiremi_feishu_bot_chat_bindings SET workspace_id = ? WHERE chat_session_id = ?", [foreign.id, f.chat.id]);
    expect((await post()).status).toBe(403);
    expect((await f.app.request(metadataPath, { headers })).status).toBe(403);
    expect(f.store.listIssueComments(otherIssue.id)).toHaveLength(0);
  });

  for (const owner of ["chat", "issue"] as const) {
    it(`limits inherited ${owner} parent reads to the persisted range without consuming parent cursors`, async () => {
      const f = await fixture();
      const parent = owner === "chat" ? f.linked : f.store.getOrCreateDefaultIssueSession(f.issue.id);
      const frozen = f.store.appendSessionEvent(parent.id, { authorType: "member", authorId: "alice", body: "Frozen reference" });
      const child = owner === "chat"
        ? f.store.createSession(f.chat.id, { parentSessionId: parent.id })
        : f.store.createIssueSession(f.issue.id, { parentSessionId: parent.id });
      const task = f.store.createSessionTask(child.id, { agentId: f.agent.id, prompt: "Read inherited context" });
      const token = await f.store.createTaskAccessToken(task, "alice");
      const headers = { Authorization: `Bearer ${token.token}` };
      const fromParent = `/api/sessions/${parent.id}/messages?from=0&to=${child.inheritCutoffSeq}`;
      expect((await f.app.request(fromParent, { headers })).status).toBe(403);
      mutateExecutionFixture(f.store, `UPDATE multiremi_turn_execution_records SET inherited_projection_to_seq = ?, inherited_projection_recorded_at = ? WHERE id = ?`,
        [child.inheritCutoffSeq, new Date().toISOString(), task.id]);
      f.store.appendSessionEvent(parent.id, { authorType: "member", authorId: "alice", body: "FUTURE_PARENT_BODY" });
      const before = f.store.getSessionAgentReadProgress(parent.id, f.agent.id);
      const allowed = await f.app.request(fromParent, { headers });
      expect(allowed.status).toBe(200);
      expect(await allowed.text()).not.toContain("FUTURE_PARENT_BODY");
      expect(f.store.getSessionAgentReadProgress(parent.id, f.agent.id)).toEqual(before);
      for (const tail of ["", "/log", "/messages", `/messages?from=0&to=${child.inheritCutoffSeq! + 1}`]) {
        expect((await f.app.request(`/api/sessions/${parent.id}${tail}`, { headers })).status).toBe(403);
      }
      expect((await f.app.request(`/api/messages/${frozen.id}`, { headers })).status).toBe(403);
      const own = f.store.appendSessionEvent(child.id, { authorType: "member", authorId: "alice", body: "Own context" });
      expect((await f.app.request(`/api/sessions/${child.id}/messages?from=0&to=${own.seq}`, { headers })).status).toBe(200);
      expect(f.store.getSessionAgentReadProgress(child.id, f.agent.id)).toEqual({ seq: own.seq, offset: 0 });
    });
  }
});
