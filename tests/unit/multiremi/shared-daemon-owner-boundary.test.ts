import { expect, it, spyOn } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";

pendingTurnBackendTests("Shared human daemon management", fixture => {
  it("does not elevate a task's daemon inventory, metadata or retirement archive authority", async () => {
    const { store } = fixture();
    for (const [userId, role] of [["machine-peer", "member"], ["machine-owner", "member"], ["machine-admin", "admin"]] as const) {
      store.createWorkspaceMember({ userId, name: userId, role });
    }
    for (const [daemonId, ownerId] of [["dmn_peer", "machine-peer"], ["dmn_owner", "machine-owner"]]) {
      await store.createAccessToken({ type: "daemon", name: daemonId!, daemonId, userId: ownerId, workspaceId: "local" });
      store.registerRuntime({ id: `rt_${daemonId}`, name: daemonId!, daemonId, ownerId, workspaceId: "local", provider: "codex" });
    }
    const agent = store.createAgent({ name: "Task worker", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "Inspect daemons" });
    const peer = await store.createTaskAccessToken(task, "machine-peer");
    const owner = await store.createTaskAccessToken(task, "machine-owner");
    const admin = await store.createTaskAccessToken(task, "machine-admin");
    const human = await store.createAccessToken({ type: "pat", name: "Shared human", userId: "machine-peer", workspaceId: "local" });
    const app = createMultiremiApp({ store, authToken: "daemon-owner-test-master" });
    const archives = spyOn(store, "requestDaemonRetirementArchives");
    try {
      for (const [credential, allowed] of [[peer, false], [owner, true], [admin, true], [human, true]] as const) {
        const headers = { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" };
        const inventory = await app.request("/api/multiremi/daemons?workspace_id=local", { headers });
        expect(inventory.status).toBe(200);
        const ids = (await inventory.json()).daemons.map((row: { daemon_id: string }) => row.daemon_id);
        expect(ids.includes("dmn_owner")).toBe(allowed);
        if (credential === peer) expect(ids).toContain("dmn_peer");
        const before = archives.mock.calls.length;
        const plan = await app.request("/api/multiremi/daemons/dmn_owner/retirement-plan?workspace_id=local", { headers });
        expect(plan.status).toBe(allowed ? 200 : 403);
        expect(archives.mock.calls.length - before).toBe(allowed ? 1 : 0);
        const metadata = await app.request("/api/daemons/dmn_owner?workspace_id=local", {
          method: "PATCH", headers, body: JSON.stringify({ display_name: "Shared workstation", dedicated: true }),
        });
        expect(metadata.status).toBe(allowed ? 200 : 403);
        if (!allowed) expect(store.getDaemonProfile("local", "dmn_owner")?.dedicated ?? false).toBe(false);
        if (credential.type === "task") {
          expect((await app.request("/api/multiremi/daemons/dmn_owner/retire", {
            method: "POST", headers, body: JSON.stringify({ workspace_id: "local", expected_snapshot: "irrelevant" }),
          })).status).toBe(403);
        }
      }
    } finally {
      archives.mockRestore();
    }
    expect(store.getRuntime("rt_dmn_owner")?.ownerId).toBe("machine-owner");
  });
});
