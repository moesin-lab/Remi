import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { authorizeBrowserScope } from "@multiremi/api/realtime.js";
import type { MultiremiWebSocketClient } from "@multiremi/api/helpers/realtime-types.js";
import type { Bot, SaveBotInput, SubmitBotMessageResult } from "@multiremi/contracts/bots.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

const MASTER = "bot-integration-master";
const APP_ID = "cli_bot_integration";
const APP_SECRET = "bot-integration-app-secret";
let previousEncryptionKey: string | undefined;

beforeEach(() => {
  previousEncryptionKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 21).toString("base64");
});

afterEach(() => {
  if (previousEncryptionKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousEncryptionKey;
  resetMultiremiTestEnv();
});

describe("Bot integration with Chat tasks and platform boundaries", () => {
  it("exposes Bot conversations to their space without making ordinary Chats shared", async () => {
    const test = await fixture();
    const inbound = await submit(test);
    const privateChat = test.store.createChatSession({
      agentId: test.agent.id, workspaceId: "local", creatorId: "another-person", title: "Private conversation",
    });
    const owner = await test.store.createAccessToken({ name: "Owner", type: "pat", workspaceId: "local", userId: "local" });
    const listed = await test.app.request("/api/chat/sessions", { headers: headers(owner.token) });
    const ids = (await listed.json() as { id: string }[]).map((chat) => chat.id);
    expect(ids).toContain(inbound.chatSessionId);
    expect(ids).not.toContain(privateChat.id);
    for (const token of [owner.token, await taskToken(test, inbound.taskId)]) {
      expect((await test.app.request(`/api/chat/sessions/${inbound.chatSessionId}`, { headers: headers(token) })).status).toBe(200);
      expect((await test.app.request(`/api/chat/sessions/${privateChat.id}`, { headers: headers(token) })).status).toBe(403);
    }
    const browser = { data: { kind: "browser", authenticated: true, userId: "local", workspaceId: "local" } } as MultiremiWebSocketClient;
    expect(authorizeBrowserScope(test.store, browser, "chat", inbound.chatSessionId)).toEqual({ ok: true });
    expect(authorizeBrowserScope(test.store, browser, "task", inbound.taskId)).toEqual({ ok: true });
    expect(authorizeBrowserScope(test.store, browser, "chat", privateChat.id)).toMatchObject({ ok: false });
    expect(test.store.listPendingChatTasks("local", { creatorId: "local" }).map((task) => task.id)).toContain(inbound.taskId);
    test.store.deleteBot(test.bot.id);
    expect((await test.app.request(`/api/chat/sessions/${inbound.chatSessionId}`, { headers: headers(owner.token) })).status).toBe(200);
  });

  it("keeps the default Bot open for an external sender without member association", async () => {
    const test = await fixture();
    const messageEvents: string[] = [];
    const unsubscribe = test.store.onWorkspaceEvent((event) => {
      if (event.type === "chat:message") messageEvents.push(String(event.payload.message_id));
    });
    const inbound = await submit(test);
    expect((await submit(test)).duplicate).toBe(true);
    expect(messageEvents).toHaveLength(1);
    expect(test.store.getChatMessage(messageEvents[0]!)).toMatchObject({ chatSessionId: inbound.chatSessionId, taskId: inbound.taskId });
    unsubscribe();
    const task = test.store.getTask(inbound.taskId)!;
    expect(test.bot.allowlist_enabled).toBe(false);
    expect(test.store.getChatSession(inbound.chatSessionId)?.agentId).toBe(test.agent.id);
    expect(task).toMatchObject({ chatSessionId: inbound.chatSessionId, runtimeId: test.executorId, issueCreationRestricted: false });
    expect(test.store.listBotSenders(test.bot.id)).toEqual([
      expect.objectContaining({ external_id: "ou_bot_external", allowed: false }),
    ]);
    const token = await taskToken(test, task.id);
    await expectIssueAccess(test, token, true);
  });

  it("changes Issue access for the same Bot Chat and descendant without making task policy permanent", async () => {
    const test = await fixture({ allowlistEnabled: true });
    const inbound = await submit(test);
    const token = await taskToken(test, inbound.taskId);
    const childCreated = await test.app.request("/api/multiremi/tasks", {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ agentId: test.agent.id, prompt: "Delegated follow-up", parentTaskId: null, issueCreationRestricted: false }),
    });
    expect(childCreated.status).toBe(201);
    const childId = (await childCreated.json()).task.id as string;
    const childToken = await taskToken(test, childId);
    expect(test.store.getTask(childId)).toMatchObject({ parentTaskId: inbound.taskId, issueCreationRestricted: false });
    expect(test.store.getTask(inbound.taskId)?.issueCreationRestricted).toBe(false);
    await expectIssueAccess(test, token, false, "bot_sender_approval_required");
    await expectIssueAccess(test, childToken, false, "bot_sender_approval_required");

    const sender = test.store.listBotSenders(test.bot.id)[0]!;
    const selfAllowed = await test.app.request(`/api/bots/${test.bot.id}/senders/${sender.id}`, {
      method: "PUT", headers: headers(token), body: JSON.stringify({ allowed: true }),
    });
    expect(selfAllowed.status).toBe(403);
    expect(test.store.listBotSenders(test.bot.id)[0]?.allowed).toBe(false);
    const botRead = await test.app.request(`/api/bots/${test.bot.id}`, { headers: headers(token) });
    expect(botRead.status).toBe(200);
    expect(await botRead.text()).not.toContain(APP_SECRET);
    test.store.setBotSenderAllowed(test.bot.id, sender.id, true);
    await expectIssueAccess(test, token, true);
    await expectIssueAccess(test, childToken, true);
    expect(test.store.getTask(inbound.taskId)?.chatSessionId).toBe(inbound.chatSessionId);
    expect(test.store.getTask(childId)?.issueCreationRestricted).toBe(false);

    test.store.setBotSenderAllowed(test.bot.id, sender.id, false);
    await expectIssueAccess(test, childToken, false, "bot_sender_approval_required");
    test.bot = test.store.updateBot(test.bot.id, botInput(test.bot, { allowlist_enabled: false }));
    await expectIssueAccess(test, token, true);
    await expectIssueAccess(test, childToken, true);
  });

  it("keeps an Agent's explicit proposal policy after the Bot sender is allowed", async () => {
    const test = await fixture({ allowlistEnabled: true, requireProposal: true });
    const inbound = await submit(test);
    const sender = test.store.listBotSenders(test.bot.id)[0]!;
    test.store.setBotSenderAllowed(test.bot.id, sender.id, true);
    expect(test.store.getTask(inbound.taskId)?.issueCreationRestricted).toBe(true);
    await expectIssueAccess(test, await taskToken(test, inbound.taskId), false, "issue_creation_requires_proposal");
  });

  it("removes a deleted Bot's optional policy while retaining its Chat", async () => {
    const test = await fixture({ allowlistEnabled: true });
    const inbound = await submit(test);
    const token = await taskToken(test, inbound.taskId);
    await expectIssueAccess(test, token, false, "bot_sender_approval_required");
    test.store.deleteBot(test.bot.id);
    expect(test.store.getChatSession(inbound.chatSessionId)).not.toBeNull();
    await expectIssueAccess(test, token, true);
  });

  it("leaves an ordinary Chat independent of pending senders on the same Agent's Bot", async () => {
    const test = await fixture({ allowlistEnabled: true });
    const inbound = await submit(test);
    await expectIssueAccess(test, await taskToken(test, inbound.taskId), false, "bot_sender_approval_required");
    const chat = test.store.createChatSession({ agentId: test.agent.id, workspaceId: "local" });
    const task = test.store.sendChatMessage(chat.id, { body: "Direct personal Chat" }).task;
    expect(test.store.isBotTaskIssueCreationRestricted(task.id)).toBe(false);
    await expectIssueAccess(test, await taskToken(test, task.id), true);
  });

  it("lets the Bot host read and answer its remote task without becoming the executor", async () => {
    const test = await fixture();
    const inbound = await submit(test);
    expect(test.store.claimTask(test.executorId)?.id).toBe(inbound.taskId);
    test.store.startTask(inbound.taskId);
    const base = `/api/daemon/tasks/${inbound.taskId}`;
    const written = await test.app.request(`${base}/messages`, {
      method: "POST", headers: headers(test.tokens.executor),
      body: JSON.stringify({ messages: [{ type: "text", content: "Executor progress" }] }),
    });
    expect(written.status).toBe(200);
    const requested = await test.app.request(`${base}/human-requests`, {
      method: "POST", headers: headers(test.tokens.executor),
      body: JSON.stringify({ kind: "question", payload: { question: "Which branch?" } }),
    });
    expect(requested.status).toBe(201);
    const requestId = (await requested.json()).request.id as string;

    for (const suffix of ["messages", "status", `human-requests/${requestId}`]) {
      const visible = await test.app.request(`${base}/${suffix}`, { headers: headers(test.tokens.host) });
      expect(visible.status, suffix).toBe(200);
      const denied = await test.app.request(`${base}/${suffix}`, { headers: headers(test.tokens.other) });
      expect(denied.status, suffix).toBe(403);
    }
    const messages = await test.app.request(`${base}/messages`, { headers: headers(test.tokens.host) });
    expect(await messages.json()).toEqual([expect.objectContaining({ content: "Executor progress" })]);

    const responseBody = JSON.stringify({ response: { answers: { branch: "main" } }, responded_by: "ou_bot_external" });
    const otherResponse = await test.app.request(`${base}/human-requests/${requestId}/respond`, {
      method: "POST", headers: headers(test.tokens.other), body: responseBody,
    });
    expect(otherResponse.status).toBe(403);
    const hostResponse = await test.app.request(`${base}/human-requests/${requestId}/respond`, {
      method: "POST", headers: headers(test.tokens.host), body: responseBody,
    });
    expect(hostResponse.status).toBe(200);
    expect((await hostResponse.json()).request).toMatchObject({ status: "responded", respondedBy: "ou_bot_external" });

    for (const [suffix, body] of [
      ["messages", { messages: [{ type: "text", content: "Forged executor result" }] }],
      ["complete", { output: "Forged completion" }],
      ["human-requests", { kind: "permission", payload: {} }],
      [`human-requests/${requestId}/expire`, { status: "timeout" }],
    ] as const) {
      const denied = await test.app.request(`${base}/${suffix}`, {
        method: "POST", headers: headers(test.tokens.host), body: JSON.stringify(body),
      });
      expect(denied.status, suffix).toBe(403);
    }
    expect(test.store.getTask(inbound.taskId)?.status).toBe("running");
    expect(test.store.listTaskMessages(inbound.taskId)).toHaveLength(1);
    const completed = await test.app.request(`${base}/complete`, {
      method: "POST", headers: headers(test.tokens.executor), body: JSON.stringify({ output: "Executor completed" }),
    });
    expect(completed.status).toBe(200);
    expect(test.store.getTask(inbound.taskId)?.status).toBe("completed");
  });

  it.each(["failed", "cancelled"] as const)("durably updates the original card when an inbound Bot task becomes %s", async (status) => {
    const test = await fixture();
    const inbound = await submit(test);
    const bindingId = test.bot.platform_bindings[0]!.id;
    expect(test.store.claimTask(test.executorId)?.id).toBe(inbound.taskId);
    test.store.startTask(inbound.taskId);
    test.store.recordBotReply(test.bot.id, bindingId, test.hostId, inbound.taskId, "om_original_bot_card");
    const body = status === "failed" ? "Provider rejected the request" : "Task cancelled.";
    const terminal = status === "failed"
      ? test.store.failTask(inbound.taskId, { error: body, failureReason: "api_invalid_request" })
      : test.store.cancelTask(inbound.taskId);
    expect(terminal.status).toBe(status);
    expect(test.store.listTasks().filter(task => task.parentTaskId === inbound.taskId)).toHaveLength(0);

    const delivery = test.store.claimBotOutbound(test.bot.id, bindingId, test.hostId)!;
    expect(delivery).toMatchObject({ body, updateMessageId: "om_original_bot_card", replyToMessageId: "om_bot_integration" });
    const count = db!.query("SELECT COUNT(*) AS count FROM multiremi_bot_outbound_deliveries WHERE task_id = ?")
      .get(inbound.taskId) as { count: number };
    expect(count.count).toBe(1);
    expect(test.store.claimBotOutbound(test.bot.id, bindingId, test.hostId)).toBeNull();
    expect(test.store.reportBotOutbound(test.bot.id, bindingId, test.hostId, delivery.id, {
      claimToken: delivery.claimToken, status: "sent", externalMessageId: "om_original_bot_card",
    })).toBe(true);
    expect(test.store.claimBotOutbound(test.bot.id, bindingId, test.hostId)).toBeNull();
  });

  it.each(["before", "after"] as const)("updates the original card with a receipt received %s the automatic retry", async (receiptTiming) => {
    const test = await fixture();
    const inbound = await submit(test);
    const bindingId = test.bot.platform_bindings[0]!.id;
    expect(test.store.claimTask(test.executorId)?.id).toBe(inbound.taskId);
    test.store.startTask(inbound.taskId);
    if (receiptTiming === "before") test.store.recordBotReply(test.bot.id, bindingId, test.hostId, inbound.taskId, "om_retry_original_card");
    test.store.failTask(inbound.taskId, { error: "Temporary timeout", failureReason: "timeout" });
    const retry = test.store.listTasks().find(task => task.parentTaskId === inbound.taskId)!;
    expect(retry).toMatchObject({ status: "queued", chatSessionId: inbound.chatSessionId });
    expect(test.store.claimBotOutbound(test.bot.id, bindingId, test.hostId)).toBeNull();
    expect((db!.query("SELECT COUNT(*) AS count FROM multiremi_bot_outbound_deliveries WHERE bot_id = ?")
      .get(test.bot.id) as { count: number }).count).toBe(0);

    expect(test.store.claimTask(test.executorId)?.id).toBe(retry.id);
    test.store.startTask(retry.id);
    test.store.completeTask(retry.id, { output: "Retry completed successfully" });
    if (receiptTiming === "after") test.store.recordBotReply(test.bot.id, bindingId, test.hostId, inbound.taskId, "om_retry_original_card");
    const delivery = test.store.claimBotOutbound(test.bot.id, bindingId, test.hostId)!;
    expect(delivery).toMatchObject({ body: "Retry completed successfully", updateMessageId: "om_retry_original_card", replyToMessageId: "om_bot_integration" });
    expect((db!.query("SELECT COUNT(*) AS count FROM multiremi_bot_outbound_deliveries WHERE bot_id = ?")
      .get(test.bot.id) as { count: number }).count).toBe(1);
    expect(test.store.reportBotOutbound(test.bot.id, bindingId, test.hostId, delivery.id, {
      claimToken: delivery.claimToken, status: "sent", externalMessageId: "om_retry_original_card",
    })).toBe(true);
    expect(test.store.claimBotOutbound(test.bot.id, bindingId, test.hostId)).toBeNull();
  });

  it("rejects enabling the legacy account while the same app is active in Bots", async () => {
    const test = await fixture();
    const legacyInput = {
      agentId: test.agent.id, runtimeId: test.hostId, appId: APP_ID, appSecretOp: "set" as const,
      appSecret: APP_SECRET, domain: "feishu" as const, enabled: false,
    };
    test.store.upsertFeishuBotConfig("local", legacyInput);
    expect(() => test.store.setFeishuBotEnabled("local", true)).toThrow("already enabled in Bots");
    expect(() => test.store.upsertFeishuBotConfig("local", { ...legacyInput, enabled: true })).toThrow("already enabled in Bots");
    expect(test.store.getFeishuBotConfig("local")?.enabled).toBe(false);
    expect(test.store.getBot(test.bot.id)?.enabled).toBe(true);
  });

  it("rejects enabling a new Bot while the same app is active in the legacy integration", async () => {
    const test = await fixture({ enabled: false });
    test.store.upsertFeishuBotConfig("local", {
      agentId: test.agent.id, runtimeId: test.hostId, appId: APP_ID, appSecretOp: "set",
      appSecret: APP_SECRET, domain: "feishu", enabled: true,
    });
    const enabled = await test.app.request(`/api/bots/${test.bot.id}`, {
      method: "PUT", headers: headers(MASTER), body: JSON.stringify(botInput(test.bot, { enabled: true })),
    });
    expect(enabled.status).toBe(409);
    expect(test.store.getBot(test.bot.id)?.enabled).toBe(false);
    expect(test.store.getFeishuBotConfig("local")?.enabled).toBe(true);
    test.store.setFeishuBotEnabled("local", false);
    const switched = await test.app.request(`/api/bots/${test.bot.id}`, {
      method: "PUT", headers: headers(MASTER), body: JSON.stringify(botInput(test.bot, { enabled: true })),
    });
    expect(switched.status).toBe(200);
  });

  it.each(["disable", "delete"] as const)("waits for the new connector to stop before legacy takeover after Bot %s", async (action) => {
    const test = await fixture();
    const binding = test.bot.platform_bindings[0]!;
    const statusPath = `/api/daemon/runtimes/${test.hostId}/bots/${test.bot.id}/platforms/${binding.id}/status`;
    const online = await test.app.request(statusPath, {
      method: "POST", headers: headers(test.tokens.host),
      body: JSON.stringify({ applied_revision: test.bot.revision, state: "online" }),
    });
    expect(online.status).toBe(200);
    const changed = await test.app.request(`/api/bots/${test.bot.id}`, {
      method: action === "delete" ? "DELETE" : "PUT", headers: headers(MASTER),
      ...(action === "delete" ? {} : { body: JSON.stringify(botInput(test.bot, { enabled: false })) }),
    });
    expect(changed.status).toBe(200);
    test.store.upsertFeishuBotConfig("local", {
      agentId: test.agent.id, runtimeId: test.executorId, appId: APP_ID, appSecretOp: "set",
      appSecret: APP_SECRET, domain: "feishu", enabled: true,
    });
    expect(test.store.feishuBotDirectiveForRuntime("local", test.executorId)).toMatchObject({ desired_state: "stopped", config_available: false });
    expect(test.store.feishuBotStatusSnapshot("local")).toMatchObject({ desiredState: "stopped", staleRuntimeIds: [test.hostId] });
    const assignmentPath = `/api/daemon/runtimes/${test.executorId}/feishu-bot`;
    const held = await test.app.request(assignmentPath, { headers: headers(test.tokens.executor) });
    expect(held.status).toBe(404);

    const stopped = await test.app.request(statusPath, {
      method: "POST", headers: headers(test.tokens.host),
      body: JSON.stringify({ applied_revision: test.store.getBot(test.bot.id)?.revision ?? 0, state: "stopped" }),
    });
    expect(stopped.status).toBe(200);
    expect(test.store.feishuBotDirectiveForRuntime("local", test.executorId)).toMatchObject({ desired_state: "running", config_available: true });
    const assignment = await test.app.request(assignmentPath, { headers: headers(test.tokens.executor) });
    expect(assignment.status).toBe(200);
    expect((await assignment.json()).app_id).toBe(APP_ID);
  });
});

async function fixture(options: { allowlistEnabled?: boolean; requireProposal?: boolean; enabled?: boolean } = {}) {
  const store = createLocalStore();
  const runtimeIds = { host: "rt_bot_host", executor: "rt_bot_executor", other: "rt_bot_unrelated" };
  const tokens = { host: "", executor: "", other: "" };
  for (const kind of ["host", "executor", "other"] as const) {
    const daemonId = `bot-integration-${kind}`;
    store.registerRuntime({ id: runtimeIds[kind], name: kind, provider: "codex", workspaceId: "local", daemonId });
    store.heartbeatRuntime(runtimeIds[kind], { supportsFeishuBotConfig: true });
    tokens[kind] = (await store.createAccessToken({ name: daemonId, type: "daemon", workspaceId: "local", daemonId })).token;
  }
  const agent = store.createAgent({
    name: "Bot worker", provider: "codex", workspaceId: "local", runtimeId: runtimeIds.executor,
    issueCreationRequiresProposal: options.requireProposal ?? false,
  });
  const app = createMultiremiApp({ store, authToken: MASTER });
  const saved = await app.request("/api/bots", {
    method: "POST", headers: headers(MASTER),
    body: JSON.stringify({
      workspace_id: "local", name: "Integration Bot", enabled: options.enabled ?? true,
      ...(options.allowlistEnabled === undefined ? {} : { allowlist_enabled: options.allowlistEnabled }),
      default_target: { kind: "agent", agent_id: agent.id, runtime_id: runtimeIds.executor },
      platform_bindings: [{ platform: "feishu", app_id: APP_ID, domain: "feishu", host_runtime_id: runtimeIds.host,
        enabled: true, app_secret_op: "set", app_secret: APP_SECRET }],
    }),
  });
  const body = await saved.json();
  expect(saved.status, JSON.stringify(body)).toBe(201);
  const bot = body as Bot;
  return { app, store, bot, agent, tokens, hostId: runtimeIds.host, executorId: runtimeIds.executor };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function headers(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function submit(test: Fixture): Promise<SubmitBotMessageResult> {
  const binding = test.bot.platform_bindings[0]!;
  const result = await test.app.request(`/api/daemon/runtimes/${test.hostId}/bots/${test.bot.id}/platforms/${binding.id}/messages`, {
    method: "POST", headers: headers(test.tokens.host),
    body: JSON.stringify({ revision: test.bot.revision, external_session_key: "oc_bot_integration", external_message_id: "om_bot_integration",
      chat_id: "oc_bot_integration", reply_to_message_id: "om_bot_integration", sender_open_id: "ou_bot_external",
      chat_type: "p2p", text: "Create an Issue and work on it" }),
  });
  const body = await result.json();
  expect(result.status, JSON.stringify(body)).toBe(202);
  return body as SubmitBotMessageResult;
}

async function taskToken(test: Fixture, taskId: string): Promise<string> {
  return (await test.store.createTaskAccessToken(test.store.getTask(taskId)!, "local")).token;
}

async function expectIssueAccess(test: Fixture, token: string, allowed: boolean, code?: string) {
  const response = await test.app.request("/api/issues", {
    method: "POST", headers: headers(token), body: JSON.stringify({ title: "Bot-created work", workspace_id: "local" }),
  });
  expect(response.status).toBe(allowed ? 201 : 403);
  if (code) expect(await response.json()).toMatchObject({ code });
  const capabilityResponse = await test.app.request("/api/cli/capabilities", { headers: headers(token) });
  expect(capabilityResponse.status).toBe(200);
  const capabilities = await capabilityResponse.json();
  for (const id of ["issue.create", "issue.quick-create"]) {
    expect(capabilities.commands.find((command: { id: string }) => command.id === id)).toMatchObject({ id, allowed });
  }
}

function botInput(bot: Bot, overrides: Partial<SaveBotInput> = {}): SaveBotInput {
  return {
    workspace_id: bot.workspace_id, name: bot.name, enabled: bot.enabled, allowlist_enabled: bot.allowlist_enabled,
    default_target: bot.default_target, routes: bot.routes, issue_notifications: bot.issue_notifications,
    platform_bindings: bot.platform_bindings.map((binding) => ({
      id: binding.id, platform: binding.platform, app_id: binding.app_id, domain: binding.domain,
      host_runtime_id: binding.host_runtime_id, enabled: binding.enabled, app_secret_op: "keep",
    })),
    ...overrides,
  };
}
