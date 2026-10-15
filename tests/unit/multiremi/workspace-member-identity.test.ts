import { createResponsibleTestIssue } from './helpers.js';
import { afterEach, describe, expect, it } from "bun:test";
import { memberRemovedPayload } from "@multiremi/api/wire/workspaces.js";
import type { Context } from "hono";
import { createMultiremiApp } from "@multiremi/api.js";
import { currentWorkspaceMember, currentWorkspaceRoleStrict } from "@multiremi/api/wire/context.js";
import type { MultiremiStore } from "@multiremi/store.js";
import { createLocalStore, createStore, db, resetMultiremiTestEnv } from "./helpers.js";
import { seedHistoricalCommentNotification } from "./shared-operator-test-helpers.js";

afterEach(resetMultiremiTestEnv);

function requestContext(requestUserId: string | null | undefined, userId = requestUserId ?? null): Context {
  const values=new Map<string,unknown>();
  return {
    set:(key:string,value:unknown)=>values.set(key,value),
    get: (key: string) => key === "multiremiAuth"
      ? { accessToken: null, jwtUserId: null, userId, requestUserId }
      : values.get(key),
  } as unknown as Context;
}

async function login(store: MultiremiStore, name: string) {
  const user = store.getOrCreateUser({ externalId: `ou_${name}`, email: `${name}@example.test`, name });
  const { token } = await store.createAccessToken({
    workspaceId: "local", userId: user.id, name, type: "pat", purpose: "session",
  });
  return { user, headers: { Authorization: `Bearer ${token}` } };
}

function seedInbox(store: MultiremiStore, workspaceId: string, memberId: string, body: string) {
  const issue = createResponsibleTestIssue(store, { workspaceId, title: "Inbox identity", createdBy: memberId });
  seedHistoricalCommentNotification(store, issue.id, memberId, body);
  const item = store.listInboxItems(memberId, workspaceId).find((candidate) => candidate.issueId === issue.id);
  expect(item).toBeDefined();
  return item!;
}

const inboxRoutes = [
  { path: "/api/inbox", memberParameter: "member_id" },
  { path: "/api/inbox", memberParameter: "member_id" },
];

async function expectInboxMutationsAllowed(
  app: ReturnType<typeof createMultiremiApp>,
  store: MultiremiStore,
  workspaceId: string,
  memberId: string,
  headers: Record<string, string>,
) {
  for (const route of inboxRoutes) {
    const item=seedInbox(store,workspaceId,memberId,"Own mutable message");
    expect(store.getInboxItem(item.id)?.read).toBe(false);
    const response=await app.request(`/api/inbox/read?member_id=${memberId}`,{method:"POST",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify({session_id:store.getMessage(item.id)!.session_id})});
    expect(response.status).toBe(200);
    expect((await response.json()).cursor_seq).toBeGreaterThanOrEqual(store.getMessage(item.id)!.seq);
    expect(store.getInboxItem(item.id)?.read).toBe(true);

  }
}

describe("shared workspace operator with exact historical identity lookup", () => {
  it.each([
    { idShape: "user-id", linkedToOtherUser: false },
    { idShape: "user-id", linkedToOtherUser: true },
    { idShape: "legacy-member-id", linkedToOtherUser: false },
    { idShape: "legacy-member-id", linkedToOtherUser: true },
  ])("historical membership shape cannot impersonate the shared operator %j", async ({ idShape, linkedToOtherUser }) => {
    const store = createLocalStore();
    const workspace = store.createWorkspace({ name: "Workspace A" });
    const outsider = await login(store, "outsider");
    const otherUser = store.getOrCreateUser({ email: "other@example.test", name: "Other user" });
    const forged = store.createWorkspaceMember({
      id: idShape === "user-id" ? outsider.user.id : `mem_${workspace.id}_${outsider.user.id}`,
      workspaceId: workspace.id,
      userId: linkedToOtherUser ? otherUser.id : null,
      name: "Forged owner",
      role: "owner",
    });
    const context = requestContext(outsider.user.id);
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    expect(store.getWorkspaceMember(forged.id)?.userId).toBe(linkedToOtherUser ? otherUser.id : null);
    expect(store.findWorkspaceMemberForUser(outsider.user.id, workspace.id)).toBeNull();
    expect(store.getUserRoleInWorkspace(outsider.user.id, workspace.id)).toBeNull();
    expect(currentWorkspaceMember(context, store, workspace.id)?.id).toBe(store.getWorkspaceOperator(workspace.id)!.id);
    expect(currentWorkspaceRoleStrict(context, store, workspace.id)).toBe("owner");
    expect((await app.request(`/api/workspaces/${workspace.id}`, { headers: outsider.headers })).status).toBe(200);
    expect((await app.request(`/api/workspaces/${workspace.id}/members`, { headers: outsider.headers })).status).toBe(200);
    expect(store.listWorkspacesForUser(outsider.user.id)).toEqual([]);
    const workspaces = await app.request("/api/workspaces", { headers: outsider.headers });
    expect((await workspaces.json()).map((row: { id: string }) => row.id)).toContain(workspace.id);
    if (linkedToOtherUser) {
      expect(store.findWorkspaceMemberForUser(otherUser.id, workspace.id)?.id).toBe(forged.id);
    }
  });

  it.each([null, undefined, "", "   "])("does not resolve an unbound row for empty identity %j", (userId) => {
    const store = createLocalStore();
    const workspace = store.createWorkspace({ name: "Unbound members" });
    store.createWorkspaceMember({ workspaceId: workspace.id, name: "Unbound", role: "owner" });
    const context = requestContext(userId, null);

    expect(store.findWorkspaceMemberForUser(userId, workspace.id)).toBeNull();
    expect(store.getUserRoleInWorkspace(userId, workspace.id)).toBeNull();
    expect(currentWorkspaceMember(context, store, workspace.id)?.id).toBe(store.getWorkspaceOperator(workspace.id)!.id);
    expect(currentWorkspaceRoleStrict(context, store, workspace.id)).toBe("owner");
    expect(currentWorkspaceRoleStrict(context, store, "local")).toBe("owner");
  });

  it("uses the shared operator in auth-disabled compatibility contexts", () => {
    const store = createLocalStore();
    const context = requestContext("unbound-local-owner", null);

    expect(currentWorkspaceMember(context, store, "local")?.id).toBe(store.getWorkspaceOperator("local")!.id);
    expect(currentWorkspaceRoleStrict(context, store, "local")).toBe("owner");
    expect(currentWorkspaceRoleStrict(requestContext("outsider"), store, "local")).toBe("owner");
  });

  it("resolves active user links without treating member row ids as user identities", async () => {
    const store = createLocalStore();
    const workspace = store.createWorkspace({ name: "Linked members" });
    const account = await login(store, "linked");
    const member = store.createWorkspaceMember({ workspaceId: workspace.id, userId: account.user.id, name: "Linked" });
    const context = requestContext(account.user.id);
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    expect(store.findWorkspaceMemberForUser(account.user.id, workspace.id)?.id).toBe(member.id);
    expect(store.findWorkspaceMemberForUser(` ${account.user.id} `, workspace.id)?.id).toBe(member.id);
    expect(store.getUserRoleInWorkspace(account.user.id, workspace.id)).toBe("member");
    expect(currentWorkspaceMember(context, store, workspace.id)?.id).toBe(store.getWorkspaceOperator(workspace.id)!.id);
    expect(currentWorkspaceRoleStrict(context, store, workspace.id)).toBe("owner");
    expect(store.findWorkspaceMemberForUser(member.id, workspace.id)).toBeNull();
    expect(store.findWorkspaceMemberForUser(account.user.id, "local")).toBeNull();
    expect((await app.request(`/api/workspaces/${workspace.id}`, { headers: account.headers })).status).toBe(200);

    store.archiveWorkspaceMember(member.id);
    expect(store.getUserRoleInWorkspace(account.user.id, workspace.id)).toBeNull();
    expect(currentWorkspaceMember(requestContext(account.user.id), store, workspace.id)?.id).toBe(store.getWorkspaceOperator(workspace.id)!.id);
    expect((await app.request(`/api/workspaces/${workspace.id}`, { headers: account.headers })).status).toBe(200);
  });

  it("resolves a local cleanup member by its explicit user link", () => {
    const store = createLocalStore();
    const owner = store.getOrCreateUser({ email: "owner@example.test", name: "Owner" });
    const workspace = store.createWorkspace({ id: "ws_cleanup", name: "Cleanup" }, owner.id);
    const member = store.getWorkspaceOperator(workspace.id)!;

    expect(store.findWorkspaceMemberForUser("local", workspace.id)?.id).toBe(member.id);
    expect(store.getUserRoleInWorkspace("local", workspace.id)).toBe("owner");
    expect(currentWorkspaceMember(requestContext("local"), store, workspace.id)?.id).toBe(member.id);
    expect(store.findWorkspaceMemberForUser(member.id, workspace.id)).toBeNull();
  });

  it.each([false, true])("shares historical inbox recipients without interpreting their row IDs as account identity (linked=%j)", async (linked) => {
    const store = createLocalStore();
    const workspace = store.createWorkspace({ name: "Inbox ownership" });
    const account = await login(store, "inbox-caller");
    const ownMember = store.createWorkspaceMember({ workspaceId: workspace.id, userId: account.user.id, name: "Caller" });
    const otherUser = store.getOrCreateUser({ email: "inbox-other@example.test", name: "Other user" });
    const forged = store.createWorkspaceMember({
      id: account.user.id, workspaceId: workspace.id, userId: linked ? otherUser.id : null, name: "Other recipient",
    });
    const privateItem = seedInbox(store, workspace.id, forged.id, "Other recipient's historical notification");
    const ownItem = seedInbox(store, workspace.id, ownMember.id, "Caller's own notification");
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const headers = { ...account.headers, "X-Workspace-ID": workspace.id };

    expect(store.getUserRoleInWorkspace(account.user.id, workspace.id)).toBe("member");
    for (const route of inboxRoutes) {
      const shared = await app.request(`${route.path}?${route.memberParameter}=${forged.id}`, { headers });
      expect(shared.status).toBe(200);
      const sharedBody = await shared.json();
      expect(sharedBody.items.map((item: { id: string }) => item.id).sort()).toEqual([ownItem.id, privateItem.id].sort());

      const own = await app.request(`${route.path}?${route.memberParameter}=${ownMember.id}`, { headers });
      expect(own.status).toBe(200);
      const body = await own.json();
      expect((body.items ?? body).map((item: { id: string }) => item.id).sort()).toEqual([ownItem.id, privateItem.id].sort());
    }
    expect(store.getInboxItem(privateItem.id)).toMatchObject({ read: false, archived: false });
  });

  // Legacy member selectors cannot create independent reader cursors.
  it("shares a session read cursor while keeping other sessions unread",async()=>{
    const store=createLocalStore(),workspace=store.createWorkspace({name:"Cursor ownership"});
    const account=await login(store,"cursor-caller");
    const own=store.createWorkspaceMember({workspaceId:workspace.id,userId:account.user.id,name:"Caller"});
    const other=store.createWorkspaceMember({workspaceId:workspace.id,name:"Other"});
    const ownItem=seedInbox(store,workspace.id,own.id,"Own message");
    const otherItem=seedInbox(store,workspace.id,other.id,"Other message");
    const app=createMultiremiApp({store,authToken:"root-secret"});
    const response=await app.request("/api/inbox/read",{method:"POST",headers:{...account.headers,"X-Workspace-ID":workspace.id,"Content-Type":"application/json"},body:JSON.stringify({session_id:store.getMessage(otherItem.id)!.session_id,member_id:other.id})});
    expect(response.status).toBe(200);
    expect(store.getInboxItem(otherItem.id)?.read).toBe(true);
    expect(store.getInboxItem(ownItem.id)?.read).toBe(false);
    await expectInboxMutationsAllowed(app,store,workspace.id,own.id,{...account.headers,"X-Workspace-ID":workspace.id});
  });

  it("resolves the caller's inbox through an explicit user link without a member selector", async () => {
    const store = createLocalStore();
    const workspace = store.createWorkspace({ name: "Self inbox" });
    const account = await login(store, "inbox-self");
    const member = store.createWorkspaceMember({ workspaceId: workspace.id, userId: account.user.id, name: "Self" });
    const item = seedInbox(store, workspace.id, member.id, "Own inbox notification");
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const headers = { ...account.headers, "X-Workspace-ID": workspace.id };

    for (const route of inboxRoutes) {
      for (const selector of ["", `?${route.memberParameter}=${account.user.id}`, `?${route.memberParameter}=${member.id}`]) {
        const response = await app.request(`${route.path}${selector}`, { headers });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect((body.items ?? body).map((entry: { id: string }) => entry.id)).toEqual([item.id]);
      }
    }
    await expectInboxMutationsAllowed(app, store, workspace.id, member.id, headers);
  });

  it.each(["master", "open"])("preserves unbound member inbox access in %s mode", async (mode) => {
    const store = createLocalStore();
    const member = store.createWorkspaceMember({ name: "Unbound inbox recipient" });
    const item = seedInbox(store, "local", member.id, "Unbound member notification");
    const app = createMultiremiApp({ store, authToken: mode === "master" ? "root-secret" : "" });
    const headers: Record<string, string> = mode === "master" ? { Authorization: "Bearer root-secret" } : {};

    for (const route of inboxRoutes) {
      const response = await app.request(`${route.path}?${route.memberParameter}=${member.id}`, { headers });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect((body.items ?? body).map((entry: { id: string }) => entry.id)).toEqual([item.id]);
    }
    await expectInboxMutationsAllowed(app, store, "local", member.id, headers);
  });

  it("resolves the authenticated local user's cleanup member inbox", async () => {
    const store = createLocalStore();
    const workspace = store.createWorkspace({ name: "Local cleanup inbox" });
    const member = store.getWorkspaceOperator(workspace.id)!;
    const item = seedInbox(store, workspace.id, member.id, "Local cleanup notification");
    const { token } = await store.createAccessToken({
      workspaceId: "local", userId: "local", name: "Local inbox session", type: "pat", purpose: "session",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const headers = { Authorization: `Bearer ${token}`, "X-Workspace-ID": workspace.id };

    for (const route of inboxRoutes) {
      for (const selector of ["", `?${route.memberParameter}=${member.id}`]) {
        const response = await app.request(`${route.path}${selector}`, { headers });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect((body.items ?? body).map((entry: { id: string }) => entry.id)).toEqual([item.id]);
      }
    }
    await expectInboxMutationsAllowed(app, store, workspace.id, member.id, headers);
  });

  it("rejects reading a conversation outside the selected workspace",async()=>{
    const store=createLocalStore(),oldWorkspace=store.createWorkspace({name:"Old"}),selected=store.createWorkspace({name:"Selected"});
    const account=await login(store,"moved-reader");
    const member=store.createWorkspaceMember({workspaceId:oldWorkspace.id,userId:account.user.id,name:"Moved"});
    const item=seedInbox(store,oldWorkspace.id,member.id,"Old workspace message");
    store.updateWorkspaceMember(member.id,{workspaceId:selected.id});
    const app=createMultiremiApp({store,authToken:"root-secret"});
    const response=await app.request("/api/inbox/read",{method:"POST",headers:{...account.headers,"X-Workspace-ID":selected.id,"Content-Type":"application/json"},body:JSON.stringify({session_id:store.getMessage(item.id)!.session_id})});
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({error:"conversation not found"});
    expect(store.getInboxItem(item.id)?.read).toBe(false);
  });

  it.each([false, true])("normalizes new subscriptions, participants and inbox delivery while keeping historical actors (linked=%j)", (linked) => {
    const store = createLocalStore();
    const creatorUser = store.getOrCreateUser({ email: "creator@example.test", name: "Creator" });
    const commenterUser = store.getOrCreateUser({ email: "commenter@example.test", name: "Commenter" });
    const creator = store.createWorkspaceMember({ name: "Creator", userId: linked ? creatorUser.id : null });
    const commenter = store.createWorkspaceMember({ name: "Commenter", userId: linked ? commenterUser.id : null });
    const issue = createResponsibleTestIssue(store, { title: "Member row collaborators", createdBy: creator.id });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const comment = store.createIssueComment(issue.id, {
      authorType: "member", authorId: commenter.id, issueSessionId: session.id, body: "Subscribe me",
    });

    const operator = store.getWorkspaceOperator("local")!;
    expect(store.listIssueSubscribers(issue.id)).toEqual([
      expect.objectContaining({ memberId: operator.id, reason: "commented" }),
    ]);
    expect(store.listSessionParticipants(session.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ participantType: "member", participantId: "local" }),
    ]));
    expect(store.addSessionParticipant(session.id, { participantType: "member", participantId: creator.id }).participantId)
      .toBe("local");
    expect(store.listInboxItems(creator.id)).toEqual([]);
    const reply = store.createIssueComment(issue.id, { authorType: "member", authorId: creator.id, body: "Notification reply" });
    expect(store.listInboxItems(commenter.id)).toEqual([]);
  });
});

describe("workspace member response identity", () => {
  it("keeps workspace member identity for historical member execution assignments", async () => {
    const store = createLocalStore();
    const account = await login(store, "assignee-display");
    const member = store.createWorkspaceMember({ userId: account.user.id, name: "测试用户" });
    const issue = createResponsibleTestIssue(store, { title: "Historical member assignee display" });
    const app = createMultiremiApp({ store, authToken: "test-assignee-identity-master" });
    const membersResponse = await app.request("/api/workspaces/local/members?include_history=true", { headers: account.headers });
    expect(membersResponse.status).toBe(200);
    const members = await membersResponse.json() as Array<{ id: string; user_id: string; name: string }>;
    expect(members.find((entry) => entry.user_id === account.user.id)).toMatchObject({ id: member.id, name: "测试用户" });

    const assigned = await app.request(`/api/issues/${issue.id}`, {
      method: "PATCH",
      headers: { ...account.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ assignee_type: "member", assignee_id: account.user.id }),
    });
    expect(assigned.status).toBe(409);
    expect(await assigned.json()).toMatchObject({ code: "issue_execution_owner_required" });
    expect(store.getIssue(issue.id)?.assigneeId).toBeNull();

    // A deprecated responsible member is accepted for old clients and ignored:
    // it is neither stored nor projected, and it designates nobody.
    const responsible = await app.request(`/api/issues/${issue.id}`, {
      method: "PATCH",
      headers: { ...account.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ responsible_member_id: member.id }),
    });
    expect(responsible.status).toBe(200);
    expect(await responsible.json()).not.toHaveProperty("responsible_member_id");
    expect(db!.query("SELECT responsible_member_id FROM multiremi_issues WHERE id=?").get(issue.id)).toEqual({ responsible_member_id: null });

    // Retain a genuine historical member execution row for the display contract;
    // current write APIs deliberately cannot create this legacy assignment.
    db!.run("UPDATE multiremi_issues SET assignee_type='member', assignee_id=? WHERE id=?", [member.id, issue.id]);
    const historical = await app.request(`/api/issues/${issue.id}`, { headers: account.headers });
    expect(historical.status).toBe(200);
    const historicalBody = await historical.json();
    expect(historicalBody).toMatchObject({ assignee_type: "member", assignee_id: member.id });
    expect(historicalBody).not.toHaveProperty("responsible_member_id");
    expect(store.getIssue(issue.id)?.assigneeId).toBe(member.id);
    expect(store.resolveIssueResponsibility(issue.id).unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "execution_owner_missing" }),
    ]));
  });

  it("keeps the login account separate from the shared workspace operator", async () => {
    const store = createStore();
    const email = "member-identity@example.test";
    const password = `test-only-${crypto.randomUUID()}`;
    const { user } = await store.configurePasswordAccount({ email, password });
    const session = await store.loginWithPassword(email, password);
    const app = createMultiremiApp({ store, authToken: "test-member-identity-master" });
    const headers = { Authorization: `Bearer ${session!.token}` };
    expect(store.findWorkspaceMemberForUser(user.id, "local")).toBeNull();
    const storedMember = store.getWorkspaceOperator("local")!;

    const meResponse = await app.request("/api/me", { headers });
    expect(meResponse.status).toBe(200);
    const me = await meResponse.json();
    expect(me.id).toBe(user.id);
    const membersResponse = await app.request("/api/workspaces/local/members", { headers });
    expect(membersResponse.status).toBe(200);
    const members = await membersResponse.json() as Array<{ id: string; user_id: string; role: string }>;
    expect(members).toEqual([expect.objectContaining({
      id: storedMember.id,
      user_id: "local",
      role: "owner",
    })]);
    expect(memberRemovedPayload(storedMember)).toMatchObject({
      member_id: storedMember.id,
      user_id: "local",
    });
  });

  it("prefers an explicit user link while preserving legacy member identities", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const explicit = store.createWorkspaceMember({
      id: "mem_local_usr_old",
      userId: "usr_current",
      name: "Explicit identity",
    });
    const legacy = store.createWorkspaceMember({ id: "mem_local_usr_legacy", name: "Legacy identity" });
    const unlinked = store.createWorkspaceMember({ id: "mem_unlinked", name: "Unlinked member" });
    const app = createMultiremiApp({ store });
    const response = await app.request("/api/workspaces/local/members?include_history=true");
    expect(response.status).toBe(200);
    const members = await response.json() as Array<{ id: string; user_id: string }>;
    const identities = new Map(members.map((member) => [member.id, member.user_id]));
    expect(identities.get(explicit.id)).toBe("usr_current");
    expect(identities.get(legacy.id)).toBe("usr_legacy");
    expect(identities.get(unlinked.id)).toBe(unlinked.id);
    expect(identities.get("mem_local_local")).toBe("local");
    expect(memberRemovedPayload(legacy)).toMatchObject({ user_id: "usr_legacy" });
  });
});
