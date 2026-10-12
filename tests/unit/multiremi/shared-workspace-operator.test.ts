import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { authorizeBrowserWebSocketToken } from "@multiremi/api/realtime.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

async function fixture() {
  const store = createLocalStore();
  const first = store.getOrCreateUser({ email: "first@example.test", name: "First" });
  const second = store.getOrCreateUser({ email: "second@example.test", name: "Second" });
  const ws = store.createWorkspace({ name: "Shared", slug: "shared" }, first.id);
  const login = async (userId: string) => (await store.createAccessToken({ name: "Login", userId, workspaceId: "local", type: "pat", purpose: "session" })).token;
  const tokens = await Promise.all([login(first.id), login(second.id)]);
  const app = createMultiremiApp({ store, authToken: "test-master" });
  const request = (path: string, index = 0, init: RequestInit = {}) => app.request(path, {
    ...init, headers: { Authorization: `Bearer ${tokens[index]}`, "Content-Type": "application/json", ...init.headers },
  });
  return { store, first, second, ws, tokens, request };
}

describe("shared workspace operator", () => {
  it("preserves login account identity while all operators see and configure workspaces", async () => {
    const { store, first, second, ws, request } = await fixture();
    expect((await (await request("/api/me")).json()).id).toBe(first.id);
    expect((await (await request("/api/me", 1)).json()).id).toBe(second.id);
    expect(store.findWorkspaceMemberForUser(second.id, ws.id)).toBeNull();
    const listed = await (await request("/api/workspaces", 1)).json();
    expect(listed.find((item: any) => item.id === ws.id).operator).toEqual({ userId: "local", memberId: store.getWorkspaceOperator(ws.id)!.id });
    expect((await request(`/api/workspaces/${ws.id}/env`, 1, { method: "PUT", body: JSON.stringify({ env: { SHARED: "yes" } }) })).status).toBe(200);
    expect((await request("/api/workspaces/missing", 1)).status).toBe(404);
  });

  it("shares old Chat content and creates new content under the operator without rewriting history", async () => {
    const { store, first, ws, request } = await fixture();
    const agent = store.createAgent({ name: "Helper", provider: "codex", workspaceId: ws.id, ownerId: first.id, visibility: "private" });
    const old = store.createChatSession({ workspaceId: ws.id, agentId: agent.id, creatorId: first.id, title: "Historical" });
    expect((await request(`/api/chat/sessions/${old.id}`, 1)).status).toBe(200);
    const listed = await (await request(`/api/chat/sessions?workspace_id=${ws.id}`, 1)).json();
    expect(listed.some((chat: any) => chat.id === old.id)).toBe(true);
    const created = await request("/api/chat/sessions", 1, { method: "POST", body: JSON.stringify({ workspace_id: ws.id, agent_id: agent.id }) });
    expect(created.status).toBe(201);
    expect((await created.json()).creator_id).toBe("local");
    expect(store.getChatSession(old.id)!.creatorId).toBe(first.id);
  });

  it("keeps historical membership readable but retires member and invitation mutations", async () => {
    const { store, second, ws, request } = await fixture();
    const old = store.createWorkspaceMember({ workspaceId: ws.id, userId: second.id, name: "Historical", role: "member" });
    const members = await (await request(`/api/workspaces/${ws.id}/members`)).json();
    expect(members).toHaveLength(1);
    expect(members[0].user_id).toBe("local");
    expect((await request(`/api/multiremi/members/${old.id}`)).status).toBe(200);
    expect((await request(`/api/workspaces/${ws.id}/members/${old.id}`, 0, { method: "DELETE" })).status).toBe(410);
    expect((await request(`/api/workspaces/${ws.id}/leave`, 0, { method: "POST" })).status).toBe(410);
    expect((await request("/api/invitations/missing/accept", 0, { method: "POST" })).status).toBe(410);
    expect(store.getWorkspaceMember(old.id)?.archivedAt).toBeNull();
  });

  it("lets the shared operator review a delivery with a historical human contact", async () => {
    const { store, first, ws, request } = await fixture();
    const contact = store.createWorkspaceMember({ workspaceId: ws.id, userId: first.id, name: "Historical contact", role: "member" });
    const agent = store.createAgent({ workspaceId: ws.id, name: "Delivery Agent", provider: "codex" });
    const issue = store.createIssue({ workspaceId: ws.id, title: "Review", responsibleMemberId: contact.id, assigneeType: "agent", assigneeId: agent.id });
    const task = store.createTask({ workspaceId: ws.id, issueId: issue.id, agentId: agent.id, prompt: "Deliver" });
    const delivery = store.submitIssueDelivery(issue.id, { summary: "Done" }, { type: "agent", id: agent.id, taskId: task.id });
    const authorized = await request(`/api/issues/${issue.id}/deliveries/${delivery.id}/authorize`, 1, {
      method: "POST", body: JSON.stringify({ agentId: agent.id, revision: delivery.responsibilityRevision }),
    });
    expect(authorized.status).toBe(200);
    expect((await authorized.json()).delivery.authorization.grantedBy).toBe(store.getWorkspaceOperator(ws.id)!.id);
    const response = await request(`/api/issues/${issue.id}/deliveries/${delivery.id}/respond`, 1, {
      method: "POST", body: JSON.stringify({ action: "accept", revision: delivery.responsibilityRevision }),
    });
    expect(response.status).toBe(200);
    expect(store.getIssue(issue.id)?.status).toBe("done");
    expect(store.getIssue(issue.id)?.responsibleMemberId).toBe(contact.id);
  });

  it("shares human subscriptions across accounts and preserves Agent subscriptions", async () => {
    const { store, first, second, ws, request } = await fixture();
    const firstMember = store.createWorkspaceMember({ workspaceId: ws.id, userId: first.id, name: "First", role: "member" });
    const secondMember = store.createWorkspaceMember({ workspaceId: ws.id, userId: second.id, name: "Second", role: "member" });
    const issue = store.createIssue({ workspaceId: ws.id, title: "Shared subscription" });
    const agent = store.createAgent({ workspaceId: ws.id, name: "Subscriber", provider: "codex" });
    store.addTypedIssueSubscriber(issue.id, "agent", agent.id);
    store.addIssueSubscriber(issue.id, firstMember.id);
    expect((await request(`/api/issues/${issue.id}/subscribe`, 1, { method: "POST", body: JSON.stringify({ member_id: secondMember.id }) })).status).toBe(200);
    expect(store.listIssueSubscribers(issue.id).filter(row => row.userType === "member").map(row => row.userId))
      .toEqual([store.getWorkspaceOperator(ws.id)!.id]);
    expect((await request(`/api/issues/${issue.id}/unsubscribe`, 0, { method: "POST", body: "{}" })).status).toBe(200);
    expect(store.listIssueSubscribers(issue.id).map(row => row.userId)).toEqual([agent.id]);
    expect((await request(`/api/issues/${issue.id}/subscribe`, 0, { method: "POST", body: "{}" })).status).toBe(200);
  });

  it("binds browser streams to the shared operator while machine credentials cannot enter them", async () => {
    const { store, ws, tokens } = await fixture();
    expect(await authorizeBrowserWebSocketToken(tokens[1]!, store, "test-master", ws.id)).toMatchObject({ userId: "local" });
    const daemon = await store.createAccessToken({ name: "Machine", type: "daemon", workspaceId: ws.id, daemonId: "machine", userId: "local" });
    expect(await authorizeBrowserWebSocketToken(daemon.token, store, "test-master", ws.id)).toMatchObject({ status: 403 });
    expect(await authorizeBrowserWebSocketToken("invalid", store, "test-master", ws.id)).toMatchObject({ status: 401 });
  });
  it("keeps task workspace and credential boundaries after sharing operator authority", async () => {
    const { store, first, ws } = await fixture();
    const other = store.createWorkspace({ name: "Other", slug: "other" });
    const agent = store.createAgent({ name: "Worker", provider: "codex", workspaceId: ws.id });
    const issue = store.createIssue({ title: "Work", workspaceId: ws.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: ws.id, prompt: "work" });
    const token = await store.createTaskAccessToken(task, first.id);
    const app = createMultiremiApp({ store, authToken: "test-master" });
    const headers = { Authorization: `Bearer ${token.token}` };
    expect((await app.request(`/api/workspaces/${ws.id}/env`, { headers })).status).toBe(200);
    expect((await app.request(`/api/workspaces/${other.id}/env`, { headers })).status).toBe(404);
    expect((await app.request("/api/me", { headers })).status).toBe(403);
    expect((await app.request("/api/tokens", { headers })).status).toBe(403);
    expect(await authorizeBrowserWebSocketToken(token.token, store, "test-master", ws.id)).toMatchObject({ status: 403 });
  });

  it("lets an account without legacy membership provision only its bound daemon workspace", async () => {
    const { store, first, ws } = await fixture();
    const other = store.createWorkspace({ name: "Another", slug: "another" });
    const token = await store.createAccessToken({ name: "Machine", type: "daemon", workspaceId: ws.id, userId: first.id, daemonId: "bound-machine" });
    const app = createMultiremiApp({ store, authToken: "test-master" });
    const register = (workspaceId: string) => app.request("/api/daemon/register", { method: "POST", headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ workspace_id: workspaceId, daemon_id: "bound-machine", runtimes: [{ type: "codex" }] }) });
    expect(store.findWorkspaceMemberForUser(first.id, ws.id)).toBeNull();
    expect((await register(ws.id)).status).toBe(200);
    expect((await register(other.id)).status).toBe(403);
    for (const path of ["/api/me", "/api/tokens", `/api/workspaces/${ws.id}/feishu-bot`]) {
      expect((await app.request(path, { headers: { Authorization: `Bearer ${token.token}` } })).status).toBe(403);
    }
  });

});
