import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import type { Bot, BotSender, BotSession, SaveBotInput, SubmitBotMessageResult } from "@multiremi/contracts/bots.js";
import { createLocalStore, resetMultiremiTestEnv, useUploadDir } from "./helpers.js";

const APP_SECRET = "bot-api-test-secret-1234567890";
const MASTER = { Authorization: "Bearer MASTER", "content-type": "application/json" };
let previousEncryptionKey: string | undefined;

beforeEach(() => {
  previousEncryptionKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64");
});

afterEach(() => {
  if (previousEncryptionKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousEncryptionKey;
  resetMultiremiTestEnv();
});

async function scaffold() {
  const store = createLocalStore();
  const agent = store.createAgent({ name: "Bot Agent", provider: "codex", workspaceId: "local" });
  const otherAgent = store.createAgent({ name: "Other Agent", provider: "codex", workspaceId: "local" });
  const tokens: Record<string, string> = {};
  for (const suffix of ["a", "b"]) {
    const runtimeId = `rt_${suffix}`;
    store.registerRuntime({ id: runtimeId, name: runtimeId, provider: "codex", workspaceId: "local", daemonId: `daemon-${suffix}` });
    store.heartbeatRuntime(runtimeId, { supportsFeishuBotConfig: true });
    tokens[runtimeId] = (await store.createAccessToken({
      name: `daemon-${suffix}`, type: "daemon", workspaceId: "local", daemonId: `daemon-${suffix}`,
    })).token;
  }
  const app = createMultiremiApp({ store, authToken: "MASTER" });
  const input: SaveBotInput = {
    workspace_id: "local", name: "Support Bot",
    platform_bindings: [{ platform: "feishu", app_id: "cli_bot_api", host_runtime_id: "rt_a", app_secret_op: "set", app_secret: APP_SECRET }],
    default_target: { kind: "agent", agent_id: agent.id, runtime_id: "rt_a" },
  };
  return { store, app, agent, otherAgent, tokens, input };
}

type Fixture = Awaited<ReturnType<typeof scaffold>>;

function headers(token: string) {
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function createBot(test: Fixture, overrides: Partial<SaveBotInput> = {}): Promise<Bot> {
  const response = await test.app.request("/api/bots", {
    method: "POST", headers: MASTER, body: JSON.stringify({ ...test.input, enabled: true, ...overrides }),
  });
  expect(response.status).toBe(201);
  return response.json();
}

function daemonPath(bot: Bot, runtimeId = "rt_a", bindingId = bot.platform_bindings[0]!.id) {
  return `/api/daemon/runtimes/${runtimeId}/bots/${bot.id}/platforms/${bindingId}`;
}

function post(test: Fixture, path: string, body: unknown, token = test.tokens.rt_a!) {
  return test.app.request(path, { method: "POST", headers: headers(token), body: JSON.stringify(body) });
}

function inbound(bot: Bot, overrides: Record<string, unknown> = {}) {
  return {
    revision: bot.revision, external_session_key: "oc_chat", external_message_id: "om_first",
    sender_open_id: "ou_sender", sender_name: "Sender", chat_id: "oc_chat", chat_type: "group", text: "hello",
    ...overrides,
  };
}

describe("Bot management and daemon API", () => {
  it("round-trips a Bot with masked credentials and keeps the legacy integration independent", async () => {
    const test = await scaffold();
    const legacy = await test.app.request("/api/workspaces/local/feishu-bot", {
      method: "PUT", headers: MASTER, body: JSON.stringify({
        agent_id: test.agent.id, runtime_id: "rt_a", app_id: "cli_legacy_bot", domain: "feishu", enabled: false, app_secret: APP_SECRET,
      }),
    });
    expect(legacy.status).toBe(200);
    const legacyBefore = test.store.getFeishuBotConfig("local");
    const bot = await createBot(test, { enabled: undefined });
    expect(bot).toMatchObject({ enabled: false, allowlist_enabled: false, routes: [] });
    expect(bot.platform_bindings[0]).toMatchObject({ app_secret_configured: true, app_secret_hint: `${APP_SECRET.slice(0, 4)}••••••` });
    expect(JSON.stringify(bot)).not.toContain(APP_SECRET);

    const detail = await test.app.request(`/api/bots/${bot.id}`, { headers: MASTER });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual(bot);
    const mismatched = await test.app.request(`/api/bots/${bot.id}?workspace_id=other`, { headers: MASTER });
    expect(mismatched.status).toBe(404);
    const listed = await test.app.request("/api/bots?workspace_id=local", { headers: MASTER });
    expect(await listed.json()).toEqual({ bots: [bot] });

    const updated = await test.app.request(`/api/bots/${bot.id}`, {
      method: "PUT", headers: MASTER, body: JSON.stringify({
        ...test.input, name: "Renamed Bot", enabled: true,
        platform_bindings: [{ id: bot.platform_bindings[0]!.id, platform: "feishu", app_id: "cli_bot_api", host_runtime_id: "rt_a" }],
      }),
    });
    expect(updated.status).toBe(200);
    const saved = await updated.json() as Bot;
    expect(saved).toMatchObject({ name: "Renamed Bot", enabled: true, revision: bot.revision + 1 });
    expect(saved.platform_bindings[0]).toMatchObject({ id: bot.platform_bindings[0]!.id, app_secret_configured: true });
    expect(JSON.stringify(saved)).not.toContain(APP_SECRET);
    const assignment = await test.app.request(daemonPath(saved), { headers: headers(test.tokens.rt_a!) });
    expect(assignment.status).toBe(200);
    expect(await assignment.json()).toMatchObject({ app_secret: APP_SECRET });

    const deleted = await test.app.request(`/api/bots/${bot.id}`, { method: "DELETE", headers: MASTER });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true });
    expect((await test.app.request(`/api/bots/${bot.id}`, { headers: MASTER })).status).toBe(404);
    expect(test.store.getFeishuBotConfig("local")).toEqual(legacyBefore);
  });

  it("rejects malformed configuration without creating or corrupting a Bot", async () => {
    const test = await scaffold();
    const invalidBodies: unknown[] = [
      null, [], { ...test.input, enabled: "true" }, { ...test.input, platform_bindings: [null] },
      { ...test.input, default_target: { kind: "agent", agent_id: 42 } },
      { ...test.input, routes: [{ id: "route", name: "broken", match: { commands: "deploy" }, target: test.input.default_target }] },
    ];
    for (const body of invalidBodies) {
      const response = await test.app.request("/api/bots", { method: "POST", headers: MASTER, body: JSON.stringify(body) });
      expect([body, response.status]).toEqual([body, 400]);
    }
    const malformedJson = await test.app.request("/api/bots", { method: "POST", headers: MASTER, body: "{" });
    expect(malformedJson.status).toBe(400);
    expect(test.store.listBots("local")).toEqual([]);

    const bot = await createBot(test);
    const changedIdentity = await test.app.request(`/api/bots/${bot.id}`, {
      method: "PUT", headers: MASTER, body: JSON.stringify({ ...test.input,
        platform_bindings: [{ ...test.input.platform_bindings[0], id: bot.platform_bindings[0]!.id, app_id: "cli_replacement" }],
      }),
    });
    expect(changedIdentity.status).toBe(409);
    expect(await changedIdentity.json()).toMatchObject({ code: "platform_identity_immutable" });
    expect(test.store.getBot(bot.id)).toEqual(bot);
  });

  it("allows task credentials to read masked configuration while keeping writes and daemon assignments separate", async () => {
    const test = await scaffold();
    const bot = await createBot(test);
    const issue = test.store.createIssue({ title: "Bot credential test", workspaceId: "local" });
    const task = test.store.createTask({ agentId: test.agent.id, issueId: issue.id, workspaceId: "local", prompt: "Read Bot configuration" });
    const token = await test.store.createTaskAccessToken(task, "local");
    const taskHeaders = headers(token.token);
    const read = await test.app.request(`/api/bots/${bot.id}`, { headers: taskHeaders });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(bot);

    for (const [path, method, body] of [
      ["/api/bots", "POST", test.input], [`/api/bots/${bot.id}`, "PUT", test.input], [`/api/bots/${bot.id}`, "DELETE", undefined],
    ] as const) {
      expect((await test.app.request(path, { method, headers: taskHeaders, body: body && JSON.stringify(body) })).status).toBe(403);
    }
    for (const path of ["/api/bots?workspace_id=local", `/api/bots/${bot.id}`]) {
      expect((await test.app.request(path, { headers: headers(test.tokens.rt_a!) })).status).toBe(403);
    }
    for (const credential of [MASTER, taskHeaders]) {
      const response = await test.app.request(daemonPath(bot), { headers: credential });
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(APP_SECRET);
    }
    expect(test.store.getBot(bot.id)).toEqual(bot);
  });

  it("delivers credentials only to the assigned Runtime and accepts its snake_case status report", async () => {
    const test = await scaffold();
    const bot = await createBot(test);
    const directives = await test.app.request("/api/daemon/runtimes/rt_a/bots", { headers: headers(test.tokens.rt_a!) });
    expect(directives.status).toBe(200);
    const body = await directives.json();
    expect(body).toMatchObject({ directives: [{ bot_id: bot.id, platform_binding_id: bot.platform_bindings[0]!.id, revision: bot.revision, desired_state: "running" }] });
    expect(JSON.stringify(body)).not.toContain(APP_SECRET);
    const assignment = await test.app.request(daemonPath(bot), { headers: headers(test.tokens.rt_a!) });
    expect(assignment.status).toBe(200);
    expect(assignment.headers.get("cache-control")).toBe("no-store");
    expect(await assignment.json()).toMatchObject({ bot_id: bot.id, platform_binding_id: bot.platform_bindings[0]!.id, app_secret: APP_SECRET, bot_agent: { id: test.agent.id } });
    expect((await test.app.request(daemonPath(bot), { headers: headers(test.tokens.rt_b!) })).status).toBe(403);
    expect((await test.app.request(daemonPath(bot, "rt_b"), { headers: headers(test.tokens.rt_b!) })).status).toBe(404);

    const reported = await post(test, `${daemonPath(bot)}/status`, { applied_revision: bot.revision, state: "online", bot_name: "Connected Bot", bot_open_id: "ou_bot" });
    expect(reported.status).toBe(200);
    expect(test.store.getBot(bot.id)?.platform_bindings[0]?.status).toBe("online");
    const claimed = await post(test, `${daemonPath(bot)}/outbound/claim`, {});
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toEqual({ delivery: null });
    const stale = await post(test, `${daemonPath(bot)}/outbound/missing/result`, { claim_token: "lease", status: "sent" });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "stale_lease" });
  });

  it("turns incoming messages into real Chat tasks and discovers each sender once with access open by default", async () => {
    const test = await scaffold();
    const bot = await createBot(test);
    const submit = await post(test, `${daemonPath(bot)}/messages`, inbound(bot));
    expect(submit.status).toBe(202);
    const first = await submit.json() as SubmitBotMessageResult;
    expect(first).toMatchObject({ status: "queued", duplicate: false, steered: false });
    expect(test.store.getTask(first.taskId)).toMatchObject({ agentId: test.agent.id, workspaceId: "local", issueCreationRestricted: false });
    expect(test.store.getChatSession(first.chatSessionId)?.agentId).toBe(test.agent.id);
    const retry = await post(test, `${daemonPath(bot)}/messages`, inbound(bot));
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ taskId: first.taskId, chatSessionId: first.chatSessionId, duplicate: true });
    const second = await post(test, `${daemonPath(bot)}/messages`, inbound(bot, { external_message_id: "om_second", sender_name: "Updated Sender", text: "follow up" }));
    expect(second.status).toBe(202);

    const sendersResponse = await test.app.request(`/api/bots/${bot.id}/senders`, { headers: MASTER });
    expect(sendersResponse.status).toBe(200);
    const { senders } = await sendersResponse.json() as { senders: BotSender[] };
    expect(senders).toHaveLength(1);
    expect(senders[0]).toMatchObject({ external_id: "ou_sender", display_name: "Updated Sender", allowed: false });
    for (const allowed of [true, false]) {
      const changed = await test.app.request(`/api/bots/${bot.id}/senders/${senders[0]!.id}`, { method: "PUT", headers: MASTER, body: JSON.stringify({ allowed }) });
      expect(changed.status).toBe(200);
      expect(await changed.json()).toMatchObject({ id: senders[0]!.id, allowed });
    }
    const snapshot = await post(test, `${daemonPath(bot)}/session/inspect`, { revision: bot.revision, external_session_key: "oc_chat" });
    expect(snapshot.status).toBe(200);
    const inspected = await snapshot.json();
    expect(inspected).toMatchObject({ chat_session_id: first.chatSessionId, task: { task_id: first.taskId, status: "queued" } });
    expect(inspected).not.toHaveProperty("chatSessionId");
    const sessions = await test.app.request(`/api/bots/${bot.id}/sessions`, { headers: MASTER });
    expect((await sessions.json() as { sessions: BotSession[] }).sessions).toHaveLength(1);
  });

  it("routes one external conversation to separate Agents and uses a reply to control only its matching Chat", async () => {
    const test = await scaffold();
    const bot = await createBot(test, { routes: [{ id: "deploy", name: "Deploy", match: { commands: ["deploy"] }, target: { kind: "agent", agent_id: test.otherAgent.id } }] });
    const firstResponse = await post(test, `${daemonPath(bot)}/messages`, inbound(bot));
    expect(firstResponse.status).toBe(202);
    const first = await firstResponse.json() as SubmitBotMessageResult;
    const secondResponse = await post(test, `${daemonPath(bot)}/messages`, inbound(bot, { external_message_id: "om_deploy", command: "deploy" }));
    expect(secondResponse.status).toBe(202);
    const second = await secondResponse.json() as SubmitBotMessageResult;
    expect(first.chatSessionId).not.toBe(second.chatSessionId);
    expect(test.store.getTask(second.taskId)?.agentId).toBe(test.otherAgent.id);
    const control = { revision: bot.revision, external_session_key: "oc_chat" };
    expect((await post(test, `${daemonPath(bot)}/session/cancel`, control)).status).toBe(409);
    const recorded = await post(test, `${daemonPath(bot)}/tasks/${second.taskId}/replies`, { external_message_id: "om_bot_reply" });
    expect(recorded.status).toBe(200);
    const continued = await post(test, `${daemonPath(bot)}/messages`, inbound(bot, {
      external_message_id: "om_follow_reply", parent_message_id: "om_bot_reply", text: "continue this deployment",
    }));
    expect(continued.status).toBe(202);
    expect(await continued.json()).toMatchObject({ chatSessionId: second.chatSessionId, taskId: second.taskId });
    const inspected = await post(test, `${daemonPath(bot)}/session/inspect`, { ...control, reply_to_message_id: "om_bot_reply" });
    expect(inspected.status).toBe(200);
    expect(await inspected.json()).toMatchObject({ chat_session_id: second.chatSessionId, task: { task_id: second.taskId } });
    const cancelled = await post(test, `${daemonPath(bot)}/session/cancel`, { ...control, reply_to_message_id: "om_bot_reply" });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({ cancelled: true, task_id: second.taskId });
    expect(test.store.getTask(first.taskId)?.status).toBe("queued");
    expect(test.store.getTask(second.taskId)?.status).toBe("cancelled");
    const reset = await post(test, `${daemonPath(bot)}/session/reset`, { ...control, chat_session_id: second.chatSessionId });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ reset: true });
    const remaining = await post(test, `${daemonPath(bot)}/session/inspect`, control);
    expect(remaining.status).toBe(200);
    expect(await remaining.json()).toMatchObject({ chat_session_id: first.chatSessionId });
    const afterReset = await post(test, `${daemonPath(bot)}/messages`, inbound(bot, {
      external_message_id: "om_after_reset", parent_message_id: "om_bot_reply", text: "start a new deployment",
    }));
    expect(afterReset.status).toBe(202);
    const restarted = await afterReset.json() as SubmitBotMessageResult;
    expect(restarted.chatSessionId).not.toBe(second.chatSessionId);
    expect(restarted.chatSessionId).not.toBe(first.chatSessionId);
    expect(test.store.getTask(restarted.taskId)?.agentId).toBe(test.otherAgent.id);
    expect((await test.app.request(`/api/bots/${bot.id}`, { method: "DELETE", headers: MASTER })).status).toBe(200);
    expect(test.store.getChatSession(first.chatSessionId)).not.toBeNull();
    expect(test.store.getTask(first.taskId)).not.toBeNull();
  });

  it("delivers Bot attachments to a separate executor, running-task steers and automatic retries", async () => {
    const uploadDir = useUploadDir();
    const test = await scaffold();
    const bot = await createBot(test, { default_target: { kind: "agent", agent_id: test.agent.id, runtime_id: "rt_b" } });
    const form = new FormData();
    form.set("file", new File(["hello from a bot"], "note.txt", { type: "text/plain" }));
    const uploaded = await test.app.request(`${daemonPath(bot)}/attachments`, { method: "POST", headers: { Authorization: `Bearer ${test.tokens.rt_a!}` }, body: form });
    expect(uploaded.status).toBe(201);
    const { attachment_id: attachmentId } = await uploaded.json() as { attachment_id: string };
    expect(test.store.getAttachment(attachmentId)).toMatchObject({ workspaceId: "local", uploaderType: "bot", uploaderId: bot.id, filename: "note.txt", chatSessionId: null });

    const otherBot = await createBot(test, { name: "Another Bot", platform_bindings: [{ ...test.input.platform_bindings[0]!, app_id: "cli_other_bot" }] });
    const foreign = await post(test, `${daemonPath(otherBot)}/messages`, inbound(otherBot, { attachment_ids: [attachmentId] }));
    expect(foreign.status).toBe(400);
    expect(test.store.listBotSessions(otherBot.id)).toEqual([]);
    const submitted = await post(test, `${daemonPath(bot)}/messages`, inbound(bot, { attachment_ids: [attachmentId] }));
    expect(submitted.status).toBe(202);
    const lineage = await submitted.json() as SubmitBotMessageResult;
    const message = test.store.listChatMessages(lineage.chatSessionId).find((entry) => entry.role === "user");
    expect(message).toBeDefined();
    expect(test.store.getAttachment(attachmentId)).toMatchObject({ chatSessionId: lineage.chatSessionId, chatMessageId: message!.id });

    const executorToken = test.tokens.rt_b!;
    const claimed = await post(test, "/api/daemon/runtimes/rt_b/tasks/claim", {}, executorToken);
    expect(claimed.status).toBe(200);
    type ClaimedTask = { id: string; auth_token: string; chat_message_attachments: Array<{ id: string; download_url: string }> };
    const { task } = await claimed.json() as { task: ClaimedTask };
    expect(task.id).toBe(lineage.taskId);
    expect(test.store.getTask(task.id)?.runtimeId).toBe("rt_b");
    expect(task.chat_message_attachments).toEqual([
      expect.objectContaining({ id: attachmentId, download_url: `/api/attachments/${attachmentId}/download` }),
    ]);
    expect(JSON.stringify(task.chat_message_attachments)).not.toContain(uploadDir);
    const downloaded = await test.app.request(`/api/attachments/${attachmentId}/download`, { headers: headers(task.auth_token) });
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe("hello from a bot");
    expect((await post(test, `/api/daemon/tasks/${task.id}/start`, {}, executorToken)).status).toBe(200);

    const followupForm = new FormData();
    followupForm.set("file", new File(["followup from a bot"], "followup.txt", { type: "text/plain" }));
    const followupUpload = await test.app.request(`${daemonPath(bot)}/attachments`, {
      method: "POST", headers: { Authorization: `Bearer ${test.tokens.rt_a!}` }, body: followupForm,
    });
    expect(followupUpload.status).toBe(201);
    const { attachment_id: followupAttachmentId } = await followupUpload.json() as { attachment_id: string };
    const steered = await post(test, `${daemonPath(bot)}/messages`, inbound(bot, {
      external_message_id: "om_followup_attachment", text: "also read this file", attachment_ids: [followupAttachmentId],
    }));
    expect(steered.status).toBe(202);
    expect(await steered.json()).toMatchObject({ taskId: task.id, chatSessionId: lineage.chatSessionId, steered: true });
    const pendingSteer = await test.app.request(`/api/daemon/tasks/${task.id}/steer`, { headers: headers(executorToken) });
    expect(pendingSteer.status).toBe(200);
    const { messages: steerMessages } = await pendingSteer.json() as { messages: Array<{ content: string }> };
    expect(steerMessages).toHaveLength(1);
    const steer = steerMessages[0]!.content;
    expect(steer).toContain(`/api/attachments/${followupAttachmentId}/download`);
    expect(steer).toContain(`remi attachment download "${followupAttachmentId}" --output-dir ./attachments`);
    expect(steer).not.toContain(uploadDir);
    expect(steer).not.toContain("/tmp/");
    const followupDownload = await test.app.request(`/api/attachments/${followupAttachmentId}/download`, { headers: headers(task.auth_token) });
    expect(followupDownload.status).toBe(200);
    expect(await followupDownload.text()).toBe("followup from a bot");

    const failed = await post(test, `/api/daemon/tasks/${task.id}/fail`, { error: "temporary timeout", failure_reason: "timeout" }, executorToken);
    expect(failed.status).toBe(200);
    const retry = test.store.listTasks().find((candidate) => candidate.parentTaskId === task.id);
    expect(retry).toBeDefined();
    const retryClaim = await post(test, "/api/daemon/runtimes/rt_b/tasks/claim", {}, executorToken);
    expect(retryClaim.status).toBe(200);
    const { task: retried } = await retryClaim.json() as { task: ClaimedTask };
    expect(retried.id).toBe(retry!.id);
    expect(retried.chat_message_attachments.map((attachment) => attachment.id).sort()).toEqual([attachmentId, followupAttachmentId].sort());
    for (const [id, contents] of [[attachmentId, "hello from a bot"], [followupAttachmentId, "followup from a bot"]]) {
      const response = await test.app.request(`/api/attachments/${id}/download`, { headers: headers(retried.auth_token) });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(contents);
    }
  });

  it("returns 400 for malformed daemon payloads instead of throwing server errors", async () => {
    const test = await scaffold();
    const bot = await createBot(test);
    for (const patch of [
      { revision: "1" }, { external_session_key: null }, { external_message_id: "" },
      { chat_type: "channel" }, { attachment_ids: [42] }, { target: { kind: "agent", agent_id: 42 } },
    ]) {
      const response = await post(test, `${daemonPath(bot)}/messages`, inbound(bot, patch));
      expect([patch, response.status]).toEqual([patch, 400]);
    }
    for (const [suffix, body] of [
      ["status", { applied_revision: 1, state: "invalid" }],
      ["session/inspect", { revision: 1, external_session_key: 42 }],
      ["outbound/missing/result", { claim_token: "lease", status: "invalid" }],
    ] as const) {
      expect((await post(test, `${daemonPath(bot)}/${suffix}`, body)).status).toBe(400);
    }
    const badUpload = await test.app.request(`${daemonPath(bot)}/attachments`, { method: "POST", headers: { Authorization: `Bearer ${test.tokens.rt_a!}` }, body: new FormData() });
    expect(badUpload.status).toBe(400);
    expect(test.store.listBotSessions(bot.id)).toEqual([]);
  });
});
