import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { CliApiClient } from "../../../apps/remi/cli/core/api-client.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

let previousEncryptionKey: string | undefined;

beforeEach(() => {
  previousEncryptionKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
});

afterEach(() => {
  if (previousEncryptionKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousEncryptionKey;
  resetMultiremiTestEnv();
});

describe("Multiremi API - runtime commands", () => {
  it("restricts execution to workspace managers and keeps its audit response redacted", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    store.createWorkspaceMember({ id: "command-admin", name: "Command Admin", role: "admin" });
    store.createWorkspaceMember({ id: "command-member", name: "Command Member", role: "member" });
    const ownerToken = await store.createAccessToken({ name: "Owner", type: "pat", workspaceId: "local", userId: "local" });
    const adminToken = await store.createAccessToken({ name: "Admin", type: "pat", workspaceId: "local", userId: "command-admin" });
    const memberToken = await store.createAccessToken({ name: "Member", type: "pat", workspaceId: "local", userId: "command-member" });
    const taskAgent = store.createAgent({ name: "Command task actor", provider: "codex", workspaceId: "local" });
    const taskIssue = store.createIssue({ title: "Command task auth", workspaceId: "local" });
    const task = store.createTask({
      agentId: taskAgent.id,
      issueId: taskIssue.id,
      workspaceId: "local",
      prompt: "Attempt a runtime command",
    });
    const taskToken = await store.createTaskAccessToken(task, "command-member");
    const daemonToken = await store.createAccessToken({
      name: "Command Daemon",
      type: "daemon",
      workspaceId: "local",
      daemonId: "command-daemon",
    });
    const runtime = store.registerRuntime({
      id: "rt_command_api",
      name: "Command runtime",
      provider: "codex",
      workspaceId: "local",
      daemonId: "command-daemon",
    });
    const app = createMultiremiApp({ store, authToken: "root-command-secret" });
    const jsonHeaders = (token: string) => ({
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    });
    const tokenLikeValue = ["ghp", "placeholdervalue1234"].join("_");
    const command = `printf ${tokenLikeValue}`;

    const denied = await app.request(`/api/runtimes/${runtime.id}/commands`, {
      method: "POST",
      headers: jsonHeaders(memberToken.token),
      body: JSON.stringify({ command }),
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "insufficient permissions" });

    const taskDenied = await app.request(`/api/runtimes/${runtime.id}/commands`, {
      method: "POST",
      headers: jsonHeaders(taskToken.token),
      body: JSON.stringify({ command }),
    });
    expect(taskDenied.status).toBe(403);
    expect(await taskDenied.json()).toEqual({ error: "insufficient permissions" });

    const spoofedProvision = await app.request(`/api/runtimes/${runtime.id}/commands`, {
      method: "POST",
      headers: jsonHeaders(adminToken.token),
      body: JSON.stringify({ command: "printf bounded", timeout_ms: 15 * 60 * 1000, provisionKind: "npm-global" }),
    });
    expect(spoofedProvision.status).toBe(400);

    const created = await app.request(`/api/runtimes/${runtime.id}/commands`, {
      method: "POST",
      headers: jsonHeaders(adminToken.token),
      body: JSON.stringify({ command, args: ["token=placeholder-value"], timeout_ms: 2_000 }),
    });
    expect(created.status).toBe(202);
    const createdBody = await created.json();
    expect(createdBody).toMatchObject({
      runtime_id: runtime.id,
      command: "printf [REDACTED]",
      args: ["token=[REDACTED]"],
      created_by: "command-admin",
      status: "pending",
    });
    expect(JSON.stringify(createdBody)).not.toContain(tokenLikeValue);

    const heartbeat = await app.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: jsonHeaders(daemonToken.token),
      body: JSON.stringify({ runtime_id: runtime.id }),
    });
    expect(heartbeat.status).toBe(200);
    const heartbeatBody = await heartbeat.json();
    expect(heartbeatBody.pending_command).toMatchObject({
      id: createdBody.id,
      command,
      args: ["token=placeholder-value"],
      timeout_ms: 2_000,
    });

    const reported = await app.request(`/api/daemon/runtimes/${runtime.id}/commands/${createdBody.id}/result`, {
      method: "POST",
      headers: jsonHeaders(daemonToken.token),
      body: JSON.stringify({
        status: "completed",
        exit_code: 9,
        stdout: `result ${tokenLikeValue}`,
        stderr: "",
        duration_ms: 14,
      }),
    });
    expect(reported.status).toBe(200);

    const result = await app.request(`/api/runtimes/${runtime.id}/commands/${createdBody.id}`, {
      headers: { Authorization: `Bearer ${ownerToken.token}` },
    });
    expect(result.status).toBe(200);
    const resultBody = await result.json();
    expect(resultBody).toMatchObject({ status: "completed", exit_code: 9, stdout: "result [REDACTED]", duration_ms: 14 });
    expect(JSON.stringify(resultBody)).not.toContain(tokenLikeValue);
  });

  it.each(["web", "feishu"] as const)("lets %s Chat task credentials execute and read commands on another runtime in their workspace", async (origin) => {
    const { app, task, token, sourceRuntime, targetRuntime, targetDaemonToken } = await chatCommandFixture(origin);
    expect(task.runtimeId).toBe(sourceRuntime.id);
    expect(task.issueCreationRestricted).toBe(origin === "feishu");
    const taskHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const created = await app.request(`/api/runtimes/${targetRuntime.id}/commands`, {
      method: "POST",
      headers: taskHeaders,
      body: JSON.stringify({ command: "echo runtime-result", timeout_ms: 2_000 }),
    });
    expect(created.status).toBe(202);
    const command = await created.json();
    expect(command).toMatchObject({ runtime_id: targetRuntime.id, created_by: "local", status: "pending" });

    const claimed = await app.request(`/api/daemon/runtimes/${targetRuntime.id}/commands/claim`, {
      method: "POST",
      headers: { Authorization: `Bearer ${targetDaemonToken}` },
    });
    expect(claimed.status).toBe(200);
    expect((await claimed.json()).request).toMatchObject({ id: command.id, command: "echo runtime-result" });
    const reported = await app.request(`/api/daemon/runtimes/${targetRuntime.id}/commands/${command.id}/result`, {
      method: "POST",
      headers: { Authorization: `Bearer ${targetDaemonToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed", exit_code: 0, stdout: "runtime-result", stderr: "", duration_ms: 12 }),
    });
    expect(reported.status).toBe(200);
    const result = await app.request(`/api/runtimes/${targetRuntime.id}/commands/${command.id}`, { headers: taskHeaders });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ id: command.id, status: "completed", exit_code: 0, stdout: "runtime-result" });
  });

  it.each(["web", "feishu"] as const)("advertises runtime command capability to a %s Chat task credential", async (origin) => {
    const { app, token } = await chatCommandFixture(origin);
    const client = new CliApiClient({
      serverUrl: "http://remi.test",
      workspaceId: "local",
      token,
      fetch: (input, init) => Promise.resolve(app.request(new Request(input, init))),
    });
    expect(await client.requireCapability("runtime.command.run")).toMatchObject({ identity: "task" });
  });

  it("keeps command workspace boundaries and request/runtime pairing for task credentials", async () => {
    const { app, store, token, sourceRuntime, targetRuntime } = await chatCommandFixture("web");
    const remoteWorkspace = store.createWorkspace({ id: "ws_command_remote", name: "Other space", slug: "command-remote" }, "local");
    const remoteRuntime = store.registerRuntime({ id: "rt_command_remote", name: "Other runtime", provider: "codex", workspaceId: remoteWorkspace.id });
    const ownCommand = store.createRuntimeCommandRequest(targetRuntime.id, { command: "echo own" });
    const remoteCommand = store.createRuntimeCommandRequest(remoteRuntime.id, { command: "echo remote" });
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Workspace-ID": remoteWorkspace.id };
    const remoteCreate = await app.request(`/api/runtimes/${remoteRuntime.id}/commands`, {
      method: "POST", headers, body: JSON.stringify({ command: "echo inaccessible" }),
    });
    expect(remoteCreate.status).toBe(404);
    const remoteRead = await app.request(`/api/runtimes/${remoteRuntime.id}/commands/${remoteCommand.id}`, { headers });
    expect(remoteRead.status).toBe(404);
    const wrongRuntime = await app.request(`/api/runtimes/${sourceRuntime.id}/commands/${ownCommand.id}`, { headers });
    expect(wrongRuntime.status).toBe(404);
    expect(await wrongRuntime.json()).toEqual({ error: "request not found" });
  });

  it("restricts workspace Runtime provision CRUD to managers and denies task tokens", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    store.createWorkspaceMember({ id: "provision-admin", name: "Provision Admin", role: "admin" });
    store.createWorkspaceMember({ id: "provision-member", name: "Provision Member", role: "member" });
    const adminToken = await store.createAccessToken({ name: "Admin", type: "pat", workspaceId: "local", userId: "provision-admin" });
    const memberToken = await store.createAccessToken({ name: "Member", type: "pat", workspaceId: "local", userId: "provision-member" });
    const agent = store.createAgent({ name: "Provision task actor", provider: "codex", workspaceId: "local" });
    const issue = store.createIssue({ title: "Provision task auth", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "Attempt a provision" });
    const taskToken = await store.createTaskAccessToken(task, "local");
    const app = createMultiremiApp({ store, authToken: "root-provision-secret" });
    const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
    const body = JSON.stringify({
      kind: "command",
      command: "printf token=placeholder-value",
      trigger_kinds: ["on_register"],
    });

    expect((await app.request("/api/workspaces/local/runtime-provisions", {
      method: "POST", headers: headers(memberToken.token), body,
    })).status).toBe(403);
    expect((await app.request("/api/workspaces/local/runtime-provisions", {
      method: "GET", headers: headers(memberToken.token),
    })).status).toBe(200);
    expect((await app.request("/api/workspaces/local/runtime-provisions", {
      method: "POST", headers: headers(taskToken.token), body,
    })).status).toBe(403);
    expect((await app.request("/api/workspaces/local/runtime-provisions", {
      method: "GET", headers: headers(taskToken.token),
    })).status).toBe(403);

    const created = await app.request("/api/workspaces/local/runtime-provisions", {
      method: "POST", headers: headers(adminToken.token), body,
    });
    expect(created.status).toBe(201);
    const response = await created.json();
    expect(response.provision).toMatchObject({
      workspace_id: "local",
      kind: "command",
      version_check: false,
      command: "printf token=[REDACTED]",
      created_by: "provision-admin",
    });
    expect(JSON.stringify(response)).not.toContain("placeholder-value");
    const runtime = store.registerRuntime({
      id: "rt_provision_member_view",
      name: "Provision member view",
      provider: "codex",
      workspaceId: "local",
    });
    const statesResponse = await app.request(
      `/api/workspaces/local/runtime-provisions/${response.provision.id}/states`,
      { headers: headers(memberToken.token) },
    );
    expect(statesResponse.status).toBe(200);
    const statesBody = await statesResponse.json();
    expect(statesBody.states).toEqual([
      expect.objectContaining({
        provision_id: response.provision.id,
        runtime_id: runtime.id,
        status: "pending",
      }),
    ]);
    expect(statesBody.states[0]).not.toHaveProperty("runtimeId");
    const audit = db!.query("SELECT action, snapshot, actor_id FROM multiremi_runtime_provision_audit WHERE provision_id = ?")
      .get(response.provision.id) as { action: string; snapshot: string; actor_id: string };
    expect(audit).toMatchObject({ action: "create", actor_id: "provision-admin" });
    expect(audit.snapshot).toContain("[REDACTED]");
    expect(audit.snapshot).not.toContain("placeholder-value");
  });
});

async function chatCommandFixture(origin: "web" | "feishu") {
  const store = createStore();
  store.ensureLocalWorkspace();
  const sourceRuntime = store.registerRuntime({
    id: "rt_command_chat", name: "Chat runtime", provider: "codex", workspaceId: "local", daemonId: "command-chat-daemon",
  });
  const targetRuntime = store.registerRuntime({
    id: "rt_command_target", name: "Windows runtime", provider: "codex", workspaceId: "local", daemonId: "command-target-daemon",
  });
  const agent = store.createAgent({ name: "Command Chat", provider: "codex", workspaceId: "local", runtimeId: sourceRuntime.id });
  const task = origin === "web"
    ? store.sendChatMessage(store.createChatSession({ agentId: agent.id, workspaceId: "local" }).id, { body: "Inspect another runtime" }).task
    : (() => {
      const config = store.upsertFeishuBotConfig("local", {
        agentId: agent.id, runtimeId: sourceRuntime.id, appId: "cli_command_fixture", appSecretOp: "set",
        appSecret: "runtime-command-test-secret", domain: "feishu", enabled: true,
      });
      const inbound = store.submitFeishuBotMessage("local", sourceRuntime.id, {
        revision: config.revision, externalSessionKey: "oc_command", externalMessageId: "om_command",
        chatId: "oc_command", senderOpenId: "ou_external_command", text: "Inspect another runtime",
      });
      return store.getTask(inbound.taskId)!;
    })();
  const token = await store.createTaskAccessToken(task, "local");
  const targetDaemonToken = await store.createAccessToken({
    name: "Command target daemon", type: "daemon", workspaceId: "local", daemonId: "command-target-daemon",
  });
  const app = createMultiremiApp({ store, authToken: "root-command-secret" });
  return { app, store, task, token: token.token, sourceRuntime, targetRuntime, targetDaemonToken: targetDaemonToken.token };
}
