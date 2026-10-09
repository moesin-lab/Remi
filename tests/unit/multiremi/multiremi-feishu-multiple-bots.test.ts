import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

const headers = { Authorization: "Bearer MASTER", "content-type": "application/json" };
let previousKey: string | undefined;
beforeEach(() => {
  previousKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});
afterEach(() => {
  if (previousKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousKey;
  resetMultiremiTestEnv();
});

function setup() {
  const store = createLocalStore();
  const agents = ["one", "two"].map(id => {
    const agent = store.createAgent({ name: id, provider: "codex", workspaceId: "local" });
    store.registerRuntime({ id: `rt_${id}`, name: id, provider: "codex", workspaceId: "local", daemonId: `daemon_${id}` });
    store.heartbeatRuntime(`rt_${id}`, { supportsFeishuBotConfig: true });
    return agent;
  });
  const app = createMultiremiApp({ store, authToken: "MASTER" });
  const body = (index: number) => ({ name: `Bot ${index}`, agent_id: agents[index]!.id,
    runtime_id: `rt_${index ? "two" : "one"}`, app_id: `cli_${index}`, app_secret: `test-secret-${index}`, enabled: true });
  const request = (path: string, method = "GET", payload?: unknown) => app.request(`/api/workspaces/local/${path}`, {
    method, headers, ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  return { store, agents, body, request };
}

describe("multiple Feishu bots", () => {
  it("keeps the original config and exposes independent credentials, routes and stop intent", async () => {
    const { store, agents, body, request } = setup();
    expect((await request("feishu-bot", "PUT", body(0))).status).toBe(200);
    const created = await request("feishu-bots", "POST", body(1));
    expect(created.status).toBe(201);
    const second = await created.json();
    expect(second.bot_id).toStartWith("bot_");
    expect(second.name).toBe("Bot 1");
    const bot = store.feishuBotFor(second.bot_id);
    expect(store.getFeishuBotDaemonConfig("local", "rt_one")?.app_secret).toBe("test-secret-0");
    expect(store.getFeishuBotDaemonConfig("local", "rt_two")?.app_secret).toBe("test-secret-1");
    store.reportFeishuBotRuntimeStatus("local", "rt_one", { state: "online", appliedRevision: 1 });
    store.reportFeishuBotRuntimeStatus("local", "rt_two", { state: "online", appliedRevision: 1 });
    expect(store.feishuBotStatusSnapshot("local").status).toBe("online");
    expect(bot.statusSnapshot("local").status).toBe("online");
    store.replaceFeishuBotAgentRoutes("local", [{ scope: "p2p_default", agentId: agents[0]!.id }]);
    bot.replaceRoutes("local", [{ scope: "p2p_default", agentId: agents[1]!.id }]);
    expect(bot.resolveRouteAgent("local", "p2p")?.agentId).toBe(agents[1]!.id);
    const listed = await (await request("feishu-bots")).json();
    expect(listed.bots).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain("test-secret");
    expect((await request(`feishu-bot/stop?bot_id=${second.bot_id}`, "POST", {})).status).toBe(200);
    expect(store.feishuBotDirectiveForRuntime("local", "rt_two")?.desired_state).toBe("stopped");
    expect(store.feishuBotDirectiveForRuntime("local", "rt_one")?.desired_state).toBe("running");
    expect(store.getFeishuBotConfig("local")?.revision).toBe(1);
  });

  it("isolates duplicate message IDs, sessions and sender permissions", async () => {
    const { store, agents, body, request } = setup();
    await request("feishu-bot", "PUT", { ...body(0), sender_access_policy: "allowlist" });
    const second = await (await request("feishu-bots", "POST", body(1))).json();
    const input = { revision: 1, externalMessageId: "om_same", externalSessionKey: "p2p:oc_same", chatId: "oc_same",
      chatType: "p2p" as const, text: "hello", senderOpenId: "ou_same", senderName: "Same display name" };
    const firstTask = store.submitFeishuBotMessage("local", "rt_one", input);
    const secondTask = store.submitFeishuBotMessage("local", "rt_two", input);
    expect(firstTask.agentId).toBe(agents[0]!.id);
    expect(secondTask.agentId).toBe(agents[1]!.id);
    expect(firstTask.taskId).not.toBe(secondTask.taskId);
    expect(firstTask.chatSessionId).not.toBe(secondTask.chatSessionId);
    expect(store.submitFeishuBotMessage("local", "rt_two", input).taskId).toBe(secondTask.taskId);
    expect(store.isFeishuBotTaskIssueCreationRestricted(firstTask.taskId)).toBe(true);
    expect(store.isFeishuBotTaskIssueCreationRestricted(secondTask.taskId)).toBe(false);
    const sender = store.listFeishuBotSenders("local")[0]!;
    expect(store.feishuBotFor(second.bot_id).setSenderAllowed("local", sender.id, true)).toBeNull();
    expect(store.canFeishuBotDaemonAccessTask("local", "daemon_one", secondTask.taskId)).toBe(false);
  });

  it("rejects duplicate apps and Runtime assignments and never falls back for an unknown ID", async () => {
    const { body, request } = setup();
    await request("feishu-bot", "PUT", body(0));
    const duplicateApp = await request("feishu-bots", "POST", { ...body(1), app_id: "cli_0" });
    expect(duplicateApp.status).toBe(409);
    expect(await duplicateApp.json()).toMatchObject({ code: "app_already_assigned" });
    const duplicateRuntime = await request("feishu-bots", "POST", { ...body(1), runtime_id: "rt_one" });
    expect(duplicateRuntime.status).toBe(409);
    expect(await duplicateRuntime.json()).toMatchObject({ code: "runtime_already_assigned" });
    expect((await request("feishu-bot/stop?bot_id=missing", "POST", {})).status).toBe(404);
    expect((await (await request("feishu-bot")).json()).enabled).toBe(true);
  });

  it("stops a deleted bot without stopping its peer and waits before reusing its Runtime", async () => {
    const { store, body, request } = setup();
    await request("feishu-bot", "PUT", body(0));
    const second = await (await request("feishu-bots", "POST", body(1))).json();
    store.reportFeishuBotRuntimeStatus("local", "rt_two", { state: "online", appliedRevision: 1 });
    const message = { revision: 1, externalMessageId: "om_reused", externalSessionKey: "oc_reused", text: "hello", senderOpenId: "ou_reused" };
    const old = store.submitFeishuBotMessage("local", "rt_two", message);
    const oldBot = store.feishuBotFor(second.bot_id);
    oldBot.setSenderAllowed("local", oldBot.listSenders("local")[0]!.id, true);
    expect((await request(`feishu-bot?bot_id=${second.bot_id}`, "DELETE")).status).toBe(200);
    expect(store.feishuBotDirectiveForRuntime("local", "rt_two")?.desired_state).toBe("stopped");
    expect(store.feishuBotDirectiveForRuntime("local", "rt_one")?.desired_state).toBe("running");
    expect((await request("feishu-bots", "POST", body(1))).status).toBe(409);
    store.reportFeishuBotRuntimeStatus("local", "rt_two", { state: "stopped", appliedRevision: 0 });
    const replacement = await request("feishu-bots", "POST", body(1));
    expect(replacement.status).toBe(201);
    const replacementId = (await replacement.json()).bot_id;
    const next = store.submitFeishuBotMessage("local", "rt_two", message);
    expect(next.chatSessionId).not.toBe(old.chatSessionId);
    expect(store.feishuBotFor(replacementId).listSenders("local")[0]?.allowed).toBe(false);
  });

  it("waits for stop acknowledgement even when a newly saved bot has never reported", async () => {
    const { store, body, request } = setup();
    const second = await (await request("feishu-bots", "POST", body(1))).json();
    await request(`feishu-bot/stop?bot_id=${second.bot_id}`, "POST", {});
    await request(`feishu-bot?bot_id=${second.bot_id}`, "DELETE");
    expect(store.feishuBotDirectiveForRuntime("local", "rt_two")?.desired_state).toBe("stopped");
    expect((await request("feishu-bots", "POST", body(1))).status).toBe(409);
    expect((await request("feishu-bots", "POST", { ...body(1), runtime_id: "rt_one" })).status).toBe(409);
    store.reportFeishuBotRuntimeStatus("local", "rt_two", { state: "stopped", appliedRevision: 0 });
    expect((await request("feishu-bots", "POST", body(1))).status).toBe(201);
  });

  it("only lets each connector claim and acknowledge its own reply", async () => {
    const { store, body, request } = setup();
    await request("feishu-bot", "PUT", body(0));
    await request("feishu-bots", "POST", body(1));
    for (const runtime of ["rt_one", "rt_two"]) store.reportFeishuBotRuntimeStatus("local", runtime, { state: "online", appliedRevision: 1 });
    const tasks = ["rt_one", "rt_two"].map(runtime => store.submitFeishuBotMessage("local", runtime, {
      revision: 1, externalMessageId: "om_shared", externalSessionKey: "oc_shared", chatId: "oc_shared", chatType: "p2p", text: "hello", deliveryMode: "native_cot_v1",
    }));
    for (const task of tasks) {
      expect(store.claimTask("rt_one")?.id).toBe(task.taskId);
      store.startTask(task.taskId);
      store.completeTask(task.taskId, { output: `Reply for ${task.agentId}` });
    }
    const first = store.claimFeishuBotOutbound("local", "rt_one", undefined, true, true)!;
    const second = store.claimFeishuBotOutbound("local", "rt_two", undefined, true, true)!;
    expect(first.taskId).toBe(tasks[0]!.taskId);
    expect(second.taskId).toBe(tasks[1]!.taskId);
    expect(store.reportFeishuBotOutbound("local", "rt_two", first.id, { claimToken: first.claimToken, status: "sent" })).toBe(false);
    expect(store.reportFeishuBotOutbound("local", "rt_one", first.id, { claimToken: first.claimToken, status: "sent" })).toBe(true);
    expect(store.reportFeishuBotOutbound("local", "rt_two", second.id, { claimToken: second.claimToken, status: "sent" })).toBe(true);
  });
});
