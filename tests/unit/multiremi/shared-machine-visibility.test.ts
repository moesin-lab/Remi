import { expect, it } from "bun:test";
import { Hono } from "hono";
import { createMultiremiApp } from "@multiremi/api.js";
import { buildRequestAuth } from "@multiremi/api/helpers/auth-guards.js";
import { canCurrentUserEditRuntime, canCurrentUserUseRuntime } from "@multiremi/api/helpers/runtimes.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";

pendingTurnBackendTests("Shared human and machine resource visibility", fixture => {
  it("shares human resources while preserving task actor roles for private Agent lists and Runtime use", async () => {
    const { store } = fixture();
    for (const [userId, role] of [["peer", "member"], ["original-owner", "member"], ["old-admin", "admin"]] as const) {
      store.createWorkspaceMember({ userId, name: userId, role });
    }
    const agent = store.createAgent({ name: "Historical private", provider: "codex", ownerId: "original-owner", visibility: "private" });
    const publicAgent = store.createAgent({ name: "Shared agent", provider: "codex", visibility: "workspace" });
    const task = store.createTask({ agentId: publicAgent.id, prompt: "Bound worker" });
    const privateRuntime = store.registerRuntime({ name: "Historical private", provider: "codex", ownerId: "original-owner", visibility: "private" });
    const publicRuntime = store.registerRuntime({ name: "Public host", provider: "codex", ownerId: "original-owner", visibility: "public" });
    const groups = [[privateRuntime.id], [privateRuntime.id, publicRuntime.id], [publicRuntime.id]].map((runtimeIds, index) =>
      store.saveExecutionGroup("local", { name: `Restricted group ${index}`, provider: "codex", profile_id: null, runtime_ids: runtimeIds }));
    const human = await store.createAccessToken({ type: "pat", name: "Human peer", userId: "peer", workspaceId: "local" });
    const taskPeer = await store.createTaskAccessToken(task, "peer");
    const taskOwner = await store.createTaskAccessToken(task, "original-owner");
    const taskAdmin = await store.createTaskAccessToken(task, "old-admin");
    const taskLocal = await store.createTaskAccessToken(task, "local");
    const app = createMultiremiApp({ store, authToken: "visibility-master" });
    for (const [credential, privateAccess] of [[human, true], [taskPeer, false], [taskOwner, true], [taskAdmin, true], [taskLocal, true]] as const) {
      const headers = { Authorization: `Bearer ${credential.token}` };
      const listed = await app.request("/api/agents", { headers });
      expect(listed.status).toBe(200);
      const ids = (await listed.json() as Array<{ id: string }>).map(row => row.id);
      expect(ids.includes(agent.id)).toBe(privateAccess);
      expect(ids).toContain(publicAgent.id);
      expect((await app.request(`/api/models?runtime_id=${privateRuntime.id}`, { headers })).status).toBe(privateAccess ? 200 : 403);
      expect((await app.request(`/api/models?runtime_id=${publicRuntime.id}`, { headers })).status).toBe(200);
      for (const group of groups) {
        const groupAccess = privateAccess || group.runtimeIds.every(id => id === publicRuntime.id);
        expect((await app.request(`/api/models?execution_group_id=${group.id}`, { headers })).status).toBe(groupAccess ? 200 : 403);
        const created = await app.request("/api/agents", { method: "POST", headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ name: `Group ${group.id} by ${credential.id}`, provider: "codex", execution_group_id: group.id }) });
        expect(created.status, await created.text()).toBe(groupAccess ? 201 : 403);
      }
      const guard = new Hono();
      guard.get("/", c => {
        c.set("multiremiAuth", buildRequestAuth(credential, null));
        return c.json({ edit: canCurrentUserEditRuntime(c, store, privateRuntime),
          use: canCurrentUserUseRuntime(c, store, privateRuntime), editPublic: canCurrentUserEditRuntime(c, store, publicRuntime) });
      });
      expect(await (await guard.request("/")).json()).toEqual({ edit: privateAccess, use: privateAccess, editPublic: privateAccess });
    }
  });
  it("keeps attachment deletion bound to the task uploader or its original admin role", async () => {
    const { store } = fixture();
    store.createWorkspaceMember({ userId: "peer", name: "Peer", role: "member" });
    store.createWorkspaceMember({ userId: "old-admin", name: "Admin", role: "admin" });
    const agent = store.createAgent({ name: "Worker", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "Attachment management" });
    const taskPeer = await store.createTaskAccessToken(task, "peer");
    const taskAdmin = await store.createTaskAccessToken(task, "old-admin");
    const human = await store.createAccessToken({ type: "pat", name: "Human peer", userId: "peer", workspaceId: "local" });
    const app = createMultiremiApp({ store, authToken: "attachment-master" });
    const seed = (uploaderId: string) => store.createAttachment({ workspaceId: "local", uploaderType: "agent", uploaderId,
      filename: "report.txt", url: "https://example.com/report.txt", contentType: "text/plain", sizeBytes: 1 });
    const remove = (id: string, token: string) => app.request(`/api/attachments/${id}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${token}` },
    });
    const foreign = seed("other-agent");
    expect((await remove(foreign.id, taskPeer.token)).status).toBe(403);
    expect(store.getAttachment(foreign.id)).not.toBeNull();
    expect((await remove(seed(agent.id).id, taskPeer.token)).status).toBe(200);
    expect((await remove(seed("other-agent").id, taskAdmin.token)).status).toBe(200);
    expect((await remove(foreign.id, human.token)).status).toBe(200);
  });
});
