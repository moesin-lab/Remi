import { expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";

pendingTurnBackendTests("Shared Agent secret boundaries", fixture => {
  it("shares human MCP settings while retaining a task's original secret-owner authority", async () => {
    const { store } = fixture();
    for (const [userId, role] of [["secret-owner", "member"], ["secret-peer", "member"], ["secret-admin", "admin"]] as const) {
      store.createWorkspaceMember({ userId, name: userId, role });
    }
    const secret = { mcpServers: { fixture: { command: "fixture-server", env: { API_KEY: "synthetic-mcp-secret" } } } };
    const agent = store.createAgent({ name: "Public Agent with private settings", provider: "codex",
      visibility: "workspace", ownerId: "secret-owner", mcpConfig: secret });
    const worker = store.createAgent({ name: "Reader", provider: "codex" });
    const task = store.createTask({ agentId: worker.id, prompt: "Read Agent metadata" });
    const human = await store.createAccessToken({ type: "pat", name: "Human peer", userId: "secret-peer", workspaceId: "local" });
    const peer = await store.createTaskAccessToken(task, "secret-peer");
    const owner = await store.createTaskAccessToken(task, "secret-owner");
    const admin = await store.createTaskAccessToken(task, "secret-admin");
    const unknown = await store.createTaskAccessToken(task, "no-historical-member");
    const app = createMultiremiApp({ store, authToken: "secret-test-master" });
    for (const [credential, allowed] of [[human, true], [peer, false], [owner, true], [admin, true], [unknown, false]] as const) {
      // Bearer-only requests matter: the caller does not supply X-Agent-ID.
      const headers = { Authorization: `Bearer ${credential.token}` };
      const detail = await app.request(`/api/agents/${agent.id}`, { headers });
      expect(detail.status).toBe(200);
      const expected = { id: agent.id, mcp_config: allowed ? secret : null, mcp_config_redacted: !allowed };
      expect(await detail.json()).toMatchObject(expected);
      const list = await app.request("/api/agents", { headers });
      expect(list.status).toBe(200);
      expect((await list.json()).find((row: { id: string }) => row.id === agent.id)).toMatchObject(expected);
    }
    const explicitAgent = await app.request(`/api/agents/${agent.id}`, {
      headers: { Authorization: `Bearer ${owner.token}`, "X-Agent-ID": worker.id },
    });
    expect(await explicitAgent.json()).toMatchObject({ mcp_config: null, mcp_config_redacted: true });
    store.updateWorkspace("local", { settings: { always_redact_env: true } });
    for (const credential of [human, owner, admin]) {
      const headers = { Authorization: `Bearer ${credential.token}` };
      expect(await (await app.request(`/api/agents/${agent.id}`, { headers })).json())
        .toMatchObject({ mcp_config: null, mcp_config_redacted: true });
      expect((await (await app.request("/api/agents", { headers })).json()).find((row: { id: string }) => row.id === agent.id))
        .toMatchObject({ mcp_config: null, mcp_config_redacted: true });
    }
    expect(store.getAgent(agent.id)?.mcpConfig).toEqual(secret);
    expect(store.getAgent(agent.id)?.ownerId).toBe("secret-owner");
  });
});
