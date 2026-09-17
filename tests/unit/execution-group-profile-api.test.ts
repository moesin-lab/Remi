import { afterEach, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./multiremi/helpers.js";

const originalKey = process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
afterEach(() => {
  if (originalKey === undefined) delete process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
  else process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = originalKey;
  resetMultiremiTestEnv();
});

it.each(["codex", "claude"])("uses a shared %s connection for automatic model selection and dispatch", async provider => {
  const store = createLocalStore();
  const runtimes = ["first", "second"].map(id => store.registerRuntime({
    id, name: id, provider, executionGroupId: "shared", ownerId: "local", metadata: { [`${provider}_profiles`]: 1 },
  }));
  const app = createMultiremiApp({ store });
  const request = (path: string, body: unknown, method = "PUT") => app.request(path, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const profile = { name: "custom", base_url: "https://example.com/v1", model: "model-a", models: ["model-a", "model-b"], env_key: provider === "codex" ? "REMI_CODEX_KEY" : "REMI_CLAUDE_KEY" };
  expect((await request("/api/execution-groups/shared/provider-profile", { profile })).status).toBe(200);
  const saved = await (await app.request("/api/execution-groups/shared/provider-profile")).json();
  expect(saved.profile.models).toEqual(profile.models);
  for (const query of ["", "?execution_group_id=shared"]) {
    const catalog = await (await app.request(`/api/models${query}`)).json();
    expect(catalog.providers[0].models.map((model: { id: string }) => model.id)).toEqual(profile.models);
  }
  for (const execution_group_id of [null, "shared"]) {
    const created = await request("/api/agents", { name: `Worker-${execution_group_id ?? "auto"}`, provider, execution_group_id, model: "model-a" }, "POST");
    expect(created.status).toBe(201);
    const agent = await created.json();
    expect((await request(`/api/agents/${agent.id}`, { model: "model-b" })).status).toBe(200);
    expect(store.getAgent(agent.id)?.model).toBe("model-b");
    const task = store.createTask({ agentId: agent.id, prompt: "run" });
    const claimed = store.claimTask(runtimes[1]!.id)!;
    expect(claimed.id).toBe(task.id);
    const snapshot = provider === "codex" ? claimed.codexProfile : claimed.claudeProfile;
    expect(snapshot?.model).toBe("model-b");
    expect(snapshot).not.toHaveProperty("models");
    store.startTask(task.id);
    store.completeTask(task.id, { output: "done" });
  }
  expect((await request("/api/agents", { name: "Invalid", execution_group_id: "shared", model: "unsupported" }, "POST")).status).toBe(400);
});

it("restricts group writes and membership, encrypts shared keys, and retains frozen task credentials", async () => {
  process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  const store = createLocalStore();
  const first = store.registerRuntime({ id: "first", name: "First", daemonId: "first-daemon", provider: "codex", executionGroupId: "shared", ownerId: "local", metadata: { codex_profiles: 1 } });
  const peer = store.registerRuntime({ id: "peer", name: "Peer", daemonId: "peer-daemon", provider: "codex", executionGroupId: "shared", ownerId: "local", metadata: { codex_profiles: 1 } });
  store.createWorkspaceMember({ userId: "member", workspaceId: "local", name: "Member", role: "member" });
  const outsider = store.registerRuntime({ id: "outsider", name: "Outsider", daemonId: "outsider-daemon", provider: "codex", ownerId: "member", metadata: { codex_profiles: 1 } });
  const owner = await store.createAccessToken({ name: "Owner", type: "pat", workspaceId: "local", userId: "local" });
  const member = await store.createAccessToken({ name: "Member", type: "pat", workspaceId: "local", userId: "member" });
  const peerToken = await store.createAccessToken({ name: "Peer daemon", type: "daemon", workspaceId: "local", daemonId: peer.daemonId!, userId: "local" });
  const outsiderToken = await store.createAccessToken({ name: "Outsider daemon", type: "daemon", workspaceId: "local", daemonId: outsider.daemonId!, userId: "member" });
  const app = createMultiremiApp({ store, authToken: "test-master" });
  const request = (path: string, token: string, body?: unknown, method = body ? "PUT" : "GET") => app.request(path, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const path = "/api/execution-groups/shared/provider-profile";
  const profile = { name: "shared", base_url: "https://example.com/v1", model: "model-a", models: ["model-a", "model-b"], env_key: "", auth_mode: "api_key" };
  const body = { profile, api_key: "group-test-key" };
  expect((await request(path, member.token, body)).status).toBe(403);
  expect((await request(path, peerToken.token, body)).status).toBe(403);
  const saved = await request(path, owner.token, body);
  expect(saved.status).toBe(200);
  const wire = await saved.json();
  expect(JSON.stringify(wire)).not.toContain(body.api_key);
  expect(JSON.stringify(db!.query("SELECT * FROM multiremi_execution_group_credentials").all())).not.toContain(body.api_key);
  const keyPath = (runtimeId: string) => `/api/daemon/runtimes/${runtimeId}/codex-profile-key?credential_id=${wire.profile.credential_id}`;
  expect(await (await request(keyPath(peer.id), peerToken.token)).json()).toEqual({ api_key: body.api_key });
  expect((await request(keyPath(outsider.id), outsiderToken.token)).status).toBe(404);
  expect((await request(keyPath(peer.id), owner.token)).status).toBe(403);
  expect((await request(`/api/runtimes/${outsider.id}`, member.token, { execution_group_id: "shared" }, "PATCH")).status).toBe(403);
  expect((await request(`/api/runtimes/${outsider.id}/codex-profile`, member.token, body)).status).toBe(403);
  expect(await (await request(path, owner.token, { profile: { ...profile, credential_id: "rck_forged" } })).json()).toEqual(wire);

  const agent = store.createAgent({ name: "Worker", provider: "codex", model: "model-b" });
  const task = store.createTask({ agentId: agent.id, prompt: "run" });
  expect(store.claimTask(outsider.id)).toBeNull();
  const claimed = store.claimTask(peer.id)!;
  expect(claimed.id).toBe(task.id);
  expect(claimed.codexProfile?.model).toBe("model-b");
  const taskToken = await store.createTaskAccessToken(claimed, "local");
  expect((await request(path, taskToken.token)).status).toBe(403);
  expect((await request(path, taskToken.token, body)).status).toBe(403);
  store.updateRuntime(peer.id, { executionGroupId: null });
  expect(await (await request(keyPath(peer.id), peerToken.token)).json()).toEqual({ api_key: body.api_key });
  expect((await request(path, owner.token, { profile, api_key: "replacement-test-key" })).status).toBe(200);
  expect(store.getTask(task.id)?.codexProfile?.credential_id).toBe(wire.profile.credential_id);
  expect(store.getRuntimeCodexProfile(first.id)?.credential_id).not.toBe(wire.profile.credential_id);
});

it("advertises the configured group models of an any-provider Runtime", async () => {
  const store = createLocalStore();
  const runtime = store.registerRuntime({ name: "Any", provider: "any", metadata: { codex_profiles: 1 } });
  const group = store.listExecutionGroups("local").find(group => group.provider === "codex")!;
  store.setExecutionGroupProfile("local", group.id, { name: "custom", base_url: "https://example.com/v1", model: "custom", models: ["custom", "alternative"], env_key: "REMI_CODEX_KEY" });
  const app = createMultiremiApp({ store });
  const catalog = await (await app.request("/api/models")).json();
  expect(catalog.providers.find((entry: { provider: string }) => entry.provider === "codex").models.map((model: { id: string }) => model.id)).toEqual(["custom", "alternative"]);
  const agent = store.createAgent({ name: "Automatic", provider: "codex", model: "alternative" });
  store.createTask({ agentId: agent.id, prompt: "run" });
  expect(store.claimTask(runtime.id)?.codexProfile?.model).toBe("alternative");
});
