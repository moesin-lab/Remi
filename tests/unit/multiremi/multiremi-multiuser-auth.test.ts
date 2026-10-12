import { createResponsibleTestIssue } from './helpers.js';
import { InMemoryTraceStore } from "@multiremi/worker/trace-store.js";
import { InMemoryDaemonTraceReader } from "@multiremi/api/trace/daemon-trace-reader.js";
import { turnApiPath } from "./unified-test-paths.js";
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createLocalStore as freshStore, resetMultiremiTestEnv } from "./helpers.js";

// The deployment owner's stable Feishu open_id (see DEFAULT_OWNER_OPEN_ID in the store).
const OWNER_OPEN_ID = "ou_e6b7ffc662b392317275b817295c0b44";

afterEach(() => {
  resetMultiremiTestEnv();
  delete process.env.MULTIREMI_ALLOW_EMAIL_CODE_LOGIN;
  delete process.env.MULTIREMI_OWNER_OPEN_ID;
});

// Reproduce the existing single-user deployment: the seed `local` user owns the
// local workspace, then the multi-user migration tags it with the owner open_id
// (backfillOwnerExternalId runs in migrate()).
function seedDeployment(): MultiremiStore {
  const store = freshStore();
  store.ensureLocalWorkspace(); // local workspace + owner member (user id "local")
  store.migrate(); // re-run migration on the now-populated db to tag the owner
  return store;
}

// Mirror the server's localAuthResponse: resolve/create the distinct user for a
// login identity and mint a token that carries that user's real id.
async function login(
  store: MultiremiStore,
  identity: { externalId?: string; email: string; name?: string },
): Promise<{ userId: string; token: string }> {
  const user = store.getOrCreateUser(identity);
  const created = await store.createAccessToken({
    workspaceId: "local",
    userId: user.id,
    name: `Login ${user.id}`,
    type: "pat",
    purpose: "session",
    expiresInDays: 30,
  });
  return { userId: user.id, token: created.token };
}

const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });
const jsonAuth = (token: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });

describe("Multiremi multi-user auth", () => {
  it("links the same Feishu user across apps by union_id without duplicating data", () => {
    const store = seedDeployment();
    const first = store.getOrCreateUser({
      externalId: OWNER_OPEN_ID,
      email: "hehuajie@corp.com",
      name: "贺华杰",
    });

    const linked = store.getOrCreateUser({
      externalId: OWNER_OPEN_ID,
      feishuUnionId: "on_owner_union",
      email: "hehuajie@corp.com",
      name: "贺华杰",
    });

    expect(linked.id).toBe(first.id);
    expect(store.getUserByFeishuUnionId("on_owner_union")?.id).toBe(first.id);
  });

  it("AC1/AC7: preserves the existing owner and creates a distinct user for a second login", async () => {
    const store = freshStore();
    store.getCurrentUser(); // seed the legacy single-user "local" record
    store.ensureLocalWorkspace(); // local workspace + owner member (user "local")
    // Reproduce the production bug where the owner's record got overwritten.
    store.updateCurrentUser({ name: "朱欣文", email: "zhuxinwen@corp.com" });

    // "Deploy" the multi-user migration onto the existing database.
    store.migrate();
    expect(store.getUser("local")?.externalId).toBe(OWNER_OPEN_ID);

    // A (hehuajie) logs in via Feishu -> matched to the existing owner by open_id.
    const a = store.getOrCreateUser({ externalId: OWNER_OPEN_ID, email: "hehuajie@corp.com", name: "贺华杰" });
    expect(a.id).toBe("local");
    expect(a.name).toBe("贺华杰");

    // B (zhuxinwen) logs in with a different open_id -> a distinct new user.
    const b = store.getOrCreateUser({ externalId: "ou_zhuxinwen", email: "z@feishu.local", name: "朱欣文" });
    expect(b.id).not.toBe("local");
    expect(b.id).not.toBe(a.id);

    // B does not overwrite A: two distinct records, A still named 贺华杰.
    expect(store.getUser("local")?.name).toBe("贺华杰");
    expect(store.getUserByExternalId("ou_zhuxinwen")?.id).toBe(b.id);
    expect(store.getUserRoleInWorkspace("local", "local")).toBe("owner");
    expect(store.getUserRoleInWorkspace(b.id, "local")).toBeNull();
  });

  it("authenticated operators can access existing workspaces and runtimes without membership", async () => {
    const store = seedDeployment();
    store.registerRuntime({ id: "rt_pub", name: "Public", provider: "codex", workspaceId: "local", ownerId: "local", visibility: "public" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const b = await login(store, { externalId: "ou_b", email: "b@example.test", name: "B" });
    expect((await (await app.request("/api/workspaces", bearer(b.token))).json()).map((ws: any) => ws.id)).toContain("local");
    for (const path of ["/api/workspaces/local", "/api/multiremi/runtimes", "/api/multiremi/runtimes/rt_pub"]) {
      expect((await app.request(path, bearer(b.token))).status).toBe(200);
      expect((await app.request(path)).status).toBe(401);
    }
    expect(store.findWorkspaceMemberForUser(b.userId, "local")).toBeNull();
  });

  it("AC3: the owner sees the workspace and all runtimes", async () => {
    const store = seedDeployment();
    store.registerRuntime({ id: "rt_pub", name: "Public", provider: "codex", workspaceId: "local", ownerId: "local", visibility: "public" });
    store.registerRuntime({ id: "rt_priv", name: "Private", provider: "codex", workspaceId: "local", ownerId: "local", visibility: "private" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const a = await login(store, { externalId: OWNER_OPEN_ID, email: "hehuajie@feishu.local", name: "贺华杰" });
    expect(a.userId).toBe("local");

    const ws = await app.request("/api/workspaces", bearer(a.token));
    expect((await ws.json()).map((w: { id: string }) => w.id)).toContain("local");

    const runtimes = await app.request("/api/multiremi/runtimes", bearer(a.token));
    expect(runtimes.status).toBe(200);
    const ids = (await runtimes.json()).runtimes.map((r: { id: string }) => r.id).sort();
    expect(ids).toEqual(["rt_priv", "rt_pub"]);
  });

  it("retired invitations are unnecessary for using historical private runtimes", async () => {
    const store = seedDeployment();
    store.registerRuntime({ id: "rt_priv", name: "Private", provider: "codex", workspaceId: "local", ownerId: "local", visibility: "private" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const b = await login(store, { externalId: "ou_b", email: "b@example.test", name: "B" });
    const invite = await app.request("/api/workspaces/local/members", { method: "POST", headers: jsonAuth(b.token), body: JSON.stringify({ email: "b@example.test" }) });
    expect(invite.status).toBe(410);
    const usePrivate = await app.request("/api/multiremi/agents/default", { method: "POST", headers: jsonAuth(b.token), body: JSON.stringify({ runtimeId: "rt_priv", workspaceId: "local", provider: "codex" }) });
    expect([200, 201]).toContain(usePrivate.status);
  });

  it("transcript messages of historical private agents are shared by workspace operators", async () => {
    const store = seedDeployment();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const owner = await login(store, { externalId: OWNER_OPEN_ID, email: "hehuajie@feishu.local", name: "贺华杰" });
    const b = await login(store, { externalId: "ou_b2", email: "b2@corp.com", name: "B" });

    // Owner's PRIVATE agent runs a task that records transcript messages.
    const agent = store.createAgent({ name: "Secret", provider: "claude", workspaceId: "local", ownerId: "local", visibility: "private" });
    const issue = createResponsibleTestIssue(store, { title: "secret work", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "x" });
    const runtime = store.registerRuntime({name:"Private trace daemon",provider:"claude"});
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    const traces = new InMemoryTraceStore();
    traces.append(task.id,[{type:"tool_use",tool:"Bash",input:{command:"cat ~/.aws/credentials"}}]);
    const traceApp=createMultiremiApp({store,authToken:"root-secret",daemonTraceReader:new InMemoryDaemonTraceReader(()=>traces)});

    // B (member, not owner/admin) is denied; owner sees the messages.
    const bResp = await traceApp.request(turnApiPath(store, task.id, "/trace"), bearer(b.token));
    expect(bResp.status).toBe(200);
    const ownerResp = await traceApp.request(turnApiPath(store, task.id, "/trace"), bearer(owner.token));
    expect(ownerResp.status).toBe(200);
    expect((await ownerResp.json()).events).toHaveLength(1);
  });

  it("new workspaces and headerless actions use the shared operator", async () => {
    const store = seedDeployment();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const b = await login(store, { externalId: "ou_b", email: "b@example.test", name: "B" });
    const created = await app.request("/api/workspaces", { method: "POST", headers: jsonAuth(b.token), body: JSON.stringify({ name: "Shared team" }) });
    expect(created.status).toBe(201);
    const workspace = await created.json();
    expect(store.getWorkspaceOperator(workspace.id)?.userId).toBe("local");
    expect(store.getUserRoleInWorkspace(b.userId, workspace.id)).toBeNull();
    expect(workspace.operator.memberId).toBe(store.getWorkspaceOperator(workspace.id)?.id);
    expect(store.listAgents().find(agent => agent.workspaceId === workspace.id)?.ownerId).toBe("local");
    const createdAgent = await app.request("/api/agents", { method: "POST", headers: jsonAuth(b.token), body: JSON.stringify({ name: "Headerless", provider: "claude" }) });
    expect(createdAgent.status).toBe(201);
    expect(store.getAgent((await createdAgent.json()).id)).toMatchObject({ workspaceId: "local", ownerId: "local" });
    const createdIssue = await app.request("/api/multiremi/issues", { method: "POST", headers: { ...jsonAuth(b.token), "X-Workspace-ID": workspace.id }, body: JSON.stringify({ title: "Shared issue" }) });
    expect(createdIssue.status).toBe(201);
    expect((await createdIssue.json()).issue).toMatchObject({ workspaceId: workspace.id, createdBy: "local" });
  });

  it("add computer: a new user mints a real setup token for their own workspace", async () => {
    const store = seedDeployment();
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const b = await login(store, { externalId: "ou_b", email: "b@feishu.local", name: "B" });
    const created = await app.request("/api/workspaces", {
      method: "POST",
      headers: jsonAuth(b.token),
      body: JSON.stringify({ name: "B Team" }),
    });
    const workspace = await created.json();

    // Mimic the dashboard dialog exactly: no workspace in the body, the current
    // workspace only present as the X-Workspace-Slug header.
    const minted = await app.request("/api/tokens", {
      method: "POST",
      headers: { ...jsonAuth(b.token), "X-Workspace-Slug": workspace.slug },
      body: JSON.stringify({ name: "Remi daemon 2026-07-06", expires_in_days: 365, purpose: "cli" }),
    });
    expect(minted.status).toBe(201);
    const token = await minted.json();
    expect(token.token).toStartWith("mul_");
    // Bound to the requester and their workspace — never a user-less admin token,
    // even if the body tries to spoof another identity.
    const storedToken = await store.verifyAccessToken(token.token);
    expect(storedToken?.userId).toBe(b.userId);
    expect(storedToken?.workspaceId).toBe(workspace.id);
    expect(storedToken?.purpose).toBe("cli");
    const spoofed = await app.request("/api/tokens", {
      method: "POST",
      headers: { ...jsonAuth(b.token), "X-Workspace-Slug": workspace.slug },
      body: JSON.stringify({ name: "spoof", userId: "local" }),
    });
    const spoofedBody = await spoofed.json();
    expect((await store.verifyAccessToken(spoofedBody.token))?.userId).toBe(b.userId);

    // Without any workspace context the stale local token resolves through B's
    // sole active membership instead of falling into the local workspace.
    const noContext = await app.request("/api/tokens", {
      method: "POST",
      headers: jsonAuth(b.token),
      body: JSON.stringify({ name: "no context" }),
    });
    expect(noContext.status).toBe(201);
    expect((await store.verifyAccessToken((await noContext.json()).token))?.workspaceId).toBe("local");
  });

  it("keeps the headerless single-user local path unchanged", async () => {
    const store = seedDeployment();
    const localAgent = store.createAgent({ name: "Local agent", provider: "claude", workspaceId: "local" });
    const local = await login(store, {
      externalId: OWNER_OPEN_ID,
      email: "local-owner@example.test",
      name: "Local owner",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const response = await app.request("/api/agents", bearer(local.token));
    expect(response.status).toBe(200);
    expect((await response.json()).map((agent: { id: string }) => agent.id)).toContain(localAgent.id);
  });

  it("does not let forged member identities redirect another user's headerless requests", async () => {
    const store = seedDeployment();
    const attacker = await login(store, {
      externalId: "ou_attacker",
      email: "attacker@corp.com",
      name: "Attacker",
    });
    const victim = await login(store, {
      externalId: "ou_victim",
      email: "victim@corp.com",
      name: "Victim",
    });
    const attackerWorkspace = store.createWorkspace(
      { name: "Attacker workspace", slug: "attacker-workspace" },
      attacker.userId,
    );
    const attackerAgent = store.createAgent({
      name: "Attacker agent",
      provider: "claude",
      workspaceId: attackerWorkspace.id,
      ownerId: attacker.userId,
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    for (const forgedIdentity of [
      { id: victim.userId },
      { userId: victim.userId },
      { user_id: victim.userId },
    ]) {
      const forged = await app.request("/api/multiremi/members", {
        method: "POST",
        headers: jsonAuth(attacker.token),
        body: JSON.stringify({
          workspaceId: attackerWorkspace.id,
          name: "Forged victim",
          ...forgedIdentity,
        }),
      });
      expect(forged.status).toBe(410);
      expect(await forged.json()).toMatchObject({ code: "workspace_members_retired" });
    }

    // Existing databases may already contain an unlinked legacy row with a
    // user-shaped id. It must not influence headerless workspace routing.
    store.createWorkspaceMember({
      id: victim.userId,
      workspaceId: attackerWorkspace.id,
      name: "Legacy forged victim",
      role: "member",
    });
    const before = store.listAgents().filter((agent) => agent.workspaceId === attackerWorkspace.id);
    expect(before.map((agent) => agent.id)).toEqual([attackerAgent.id]);

    const create = await app.request("/api/agents", {
      method: "POST",
      headers: jsonAuth(victim.token),
      body: JSON.stringify({ name: "Misrouted victim agent", provider: "claude" }),
    });
    expect(create.status).toBe(201);
    expect(store.getAgent((await create.json()).id)?.workspaceId).toBe("local");
    expect(store.listAgents().filter((agent) => agent.workspaceId === attackerWorkspace.id)).toEqual(before);
  });

  it("personal token settings only expose and revoke the current user's active personal tokens", async () => {
    const store = seedDeployment();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const owner = await login(store, { externalId: OWNER_OPEN_ID, email: "owner@corp.com", name: "Owner" });
    const member = await login(store, { externalId: "ou_member", email: "member@corp.com", name: "Member" });
    store.createWorkspaceMember({
      workspaceId: "local",
      userId: member.userId,
      name: "Member",
      email: "member@corp.com",
      role: "member",
    });

    const create = async (authToken: string, name: string, purpose?: "personal" | "cli") => {
      const response = await app.request("/api/tokens", {
        method: "POST",
        headers: jsonAuth(authToken),
        body: JSON.stringify({ name, expires_in_days: 90, ...(purpose ? { purpose } : {}) }),
      });
      expect(response.status).toBe(201);
      return response.json();
    };
    const ownerPersonal = await create(owner.token, "Owner CLI");
    const memberPersonal = await create(member.token, "Member CLI");
    await create(owner.token, "Computer setup", "cli");

    const ownerList = await (await app.request("/api/tokens", bearer(owner.token))).json();
    expect(ownerList.map((token: { id: string }) => token.id)).toEqual([ownerPersonal.id]);
    expect(ownerList[0]).toMatchObject({
      token_prefix: expect.any(String),
      created_at: expect.any(String),
    });
    expect(ownerList[0]).not.toHaveProperty("token");

    const memberList = await (await app.request("/api/tokens", bearer(member.token))).json();
    expect(memberList.map((token: { id: string }) => token.id)).toEqual([memberPersonal.id]);

    const crossRevoke = await app.request(`/api/tokens/${memberPersonal.id}`, {
      method: "DELETE",
      ...bearer(owner.token),
    });
    expect(crossRevoke.status).toBe(404);
    expect(store.getAccessToken(memberPersonal.id)?.revokedAt).toBeNull();

    const legacyList = await app.request("/api/multiremi/tokens", bearer(member.token));
    expect(legacyList.status).toBe(200);
    expect((await legacyList.json()).tokens.every((token: any) => token.userId === member.userId)).toBe(true);
    const legacyRevoke = await app.request(`/api/multiremi/tokens/${ownerPersonal.id}`, {
      method: "DELETE",
      ...bearer(member.token),
    });
    expect(legacyRevoke.status).toBe(404);
    expect(store.getAccessToken(ownerPersonal.id)?.revokedAt).toBeNull();
  });

  it("AC6: email-code login is disabled by default and enabled by flag; Feishu SSO stays reachable", async () => {
    const store = seedDeployment();
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const disabled = await app.request("/auth/send-code", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "anyone@example.com" }),
    });
    expect(disabled.status).toBe(403);

    // The Feishu SSO url endpoint stays public (reachable without auth); it is
    // just unconfigured in tests, so it answers 503 rather than 401/403.
    const larkUrl = await app.request("/auth/lark/url?redirect_uri=https%3A%2F%2Fx");
    expect(larkUrl.status).toBe(503);

    process.env.MULTIREMI_ALLOW_EMAIL_CODE_LOGIN = "1";
    const enabled = await app.request("/auth/send-code", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "anyone@example.com" }),
    });
    expect(enabled.status).toBe(200);
  });

  it("FR8: a daemon token owns the runtimes it registers, and re-registration never hijacks the owner", async () => {
    const store = seedDeployment();
    store.createWorkspaceMember({ id: "usr_setup_user", userId: "usr_setup_user", name: "Setup user", role: "member" });
    store.createWorkspaceMember({ id: "usr_other", userId: "usr_other", name: "Other user", role: "member" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    // A daemon token minted for a specific user (as `remi setup` would).
    const daemonToken = await store.createAccessToken({
      workspaceId: "local",
      userId: "usr_setup_user",
      daemonId: "daemon-1",
      name: "Daemon 1",
      type: "daemon",
    });

    const first = await app.request("/api/daemon/register", {
      method: "POST",
      headers: jsonAuth(daemonToken.token),
      body: JSON.stringify({ workspace_id: "local", daemon_id: "daemon-1", runtimes: [{ type: "codex", version: "1.0.0" }] }),
    });
    expect(first.status).toBe(200);
    const runtimeId = (await first.json()).runtimes[0].id;
    expect(store.getRuntime(runtimeId)?.ownerId).toBe("usr_setup_user");

    // The identity claim rejects a token for another owner before it exists.
    await expect(store.createAccessToken({
      workspaceId: "local", userId: "usr_other", daemonId: "daemon-1", name: "Daemon other", type: "daemon",
    })).rejects.toThrow("already owned by another user");
    const sameOwnerDaemon = await store.createAccessToken({
      workspaceId: "local", userId: "usr_setup_user", daemonId: "daemon-1", name: "Daemon replacement", type: "daemon",
    });
    const second = await app.request("/api/daemon/register", {
      method: "POST",
      headers: jsonAuth(sameOwnerDaemon.token),
      body: JSON.stringify({ workspace_id: "local", daemon_id: "daemon-1", runtimes: [{ type: "codex", version: "1.0.1" }] }),
    });
    expect(second.status).toBe(200);
    expect(store.getRuntime(runtimeId)?.ownerId).toBe("usr_setup_user");
  });
});
