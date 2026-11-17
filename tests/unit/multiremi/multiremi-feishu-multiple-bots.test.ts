import { reportFrame } from "../../fixtures/report-session.js";
import { runtimeInputSnapshot } from "../../../packages/server/src/api/daemon-protocol/runtime-input-snapshot.js";
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
    runtime_id: `rt_${index ? "two" : "one"}`, app_id: `cli_${index}`, app_secret: `test-secret-${index}`, enabled: true,
    sender_access_policy: "agent" });
  const request = (path: string, method = "GET", payload?: unknown) => app.request(`/api/workspaces/local/${path}`, {
    method, headers, ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  return { store, app, agents, body, request };
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
    expect(store.getFeishuBotDaemonConfig("local", "rt_two")?.bot_id).toBe(second.bot_id);
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
    // Only the allowlist bot rejects the sender; its peer keeps Agent access.
    expect(() => store.submitFeishuBotMessage("local", "rt_one", input)).toThrow("allowlist");
    const secondTask = store.submitFeishuBotMessage("local", "rt_two", input);
    const sender = store.listFeishuBotSenders("local")[0]!;
    expect(store.feishuBotFor(second.bot_id).setSenderAllowed("local", sender.id, true)).toBeNull();
    store.setFeishuBotSenderAllowed("local", sender.id, true, "local");
    const firstTask = store.submitFeishuBotMessage("local", "rt_one", input);
    expect(firstTask.agentId).toBe(agents[0]!.id);
    expect(secondTask.agentId).toBe(agents[1]!.id);
    expect(firstTask.taskId).not.toBe(secondTask.taskId);
    expect(firstTask.chatSessionId).not.toBe(secondTask.chatSessionId);
    expect(store.submitFeishuBotMessage("local", "rt_two", input).taskId).toBe(secondTask.taskId);
    store.setFeishuBotSenderAllowed("local", sender.id, false, "local");
    expect(store.isFeishuBotTaskIssueCreationRestricted(firstTask.taskId)).toBe(true);
    expect(store.isFeishuBotTaskIssueCreationRestricted(secondTask.taskId)).toBe(false);
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

  it("waits for the old application to stop across repeated configuration changes", async () => {
    const { store, body, request } = setup();
    await request("feishu-bot", "PUT", body(0));
    store.reportFeishuBotRuntimeStatus("local", "rt_one", { state: "online", appliedRevision: 1 });
    for (const appId of ["cli_replacement", "cli_latest"]) {
      expect((await request("feishu-bot", "PUT", { ...body(0), app_id: appId })).status).toBe(200);
      expect(store.feishuBotDirectiveForRuntime("local", "rt_one")?.desired_state).toBe("stopped");
      expect(store.getFeishuBotDaemonConfig("local", "rt_one")).toBeNull();
      const refused = await request("feishu-bots", "POST", { ...body(1), app_id: "cli_0" });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ code: "app_bot_stopping" });
    }
    store.reportFeishuBotRuntimeStatus("local", "rt_one", { state: "online", appliedRevision: 1 });
    expect(store.feishuBotDirectiveForRuntime("local", "rt_one")?.desired_state).toBe("stopped");
    store.reportFeishuBotRuntimeStatus("local", "rt_one", { state: "stopped", appliedRevision: 3 });
    expect(store.getFeishuBotDaemonConfig("local", "rt_one")?.app_id).toBe("cli_latest");
    expect((await request("feishu-bots", "POST", { ...body(1), app_id: "cli_0" })).status).toBe(201);
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

describe("multiple Feishu bots on one runtime", () => {
  async function multi() {
    const fixture = setup();
    fixture.store.heartbeatRuntime("rt_one", { supportsFeishuBotConfig: true, supportsFeishuBotMulti: true });
    expect((await fixture.request("feishu-bot", "PUT", fixture.body(0))).status).toBe(200);
    const response = await fixture.request("feishu-bots", "POST", { ...fixture.body(1), runtime_id: "rt_one" });
    expect(response.status).toBe(201);
    return { ...fixture, botId: (await response.json()).bot_id as string };
  }

  it("scopes credentials, routing, downlinks, outbound claims and stop acknowledgements", async () => {
    const { store, app, agents, request, botId } = await multi();
    const candidates = await (await request("feishu-bot/candidates")).json();
    expect(candidates.runtimes.find((r: { id: string }) => r.id === "rt_one")).toMatchObject({
      supports_multi: true, assigned_bot_ids: ["default", botId], assigned_bot_names: ["Bot 0", "Bot 1"],
    });
    const token = await store.createAccessToken({ name: "multi host", type: "daemon", workspaceId: "local", daemonId: "daemon_one" });
    const listed = await app.request("/api/daemon/runtimes/rt_one/feishu-bots", { headers: { Authorization: `Bearer ${token.token}` } });
    expect(listed.status).toBe(200);
    expect(JSON.stringify(await listed.json())).not.toContain("secret");
    const directives = () => runtimeInputSnapshot(store, "rt_one").filter(entity => entity.type.startsWith("feishu."));
    expect(directives().filter(entity => entity.type === "feishu.bot_directive").map(entity => entity.payload.bot_id).sort()).toEqual([botId, "default"].sort());
    expect(directives().some(entity => entity.type === "feishu.directive")).toBe(false);
    expect(store.getFeishuBotDaemonConfig("local", "rt_one", botId)?.app_secret).toBe("test-secret-1");
    expect(store.listFeishuBotDaemonAssignments("local", "rt_one")).toHaveLength(2);
    expect(JSON.stringify(store.listFeishuBotDaemonAssignments("local", "rt_one"))).not.toContain("test-secret");
    const input = { revision: 1, externalMessageId: "om_shared_multi", externalSessionKey: "oc_same_multi", chatId: "oc_multi", chatType: "p2p" as const, text: "hi", deliveryMode: "native_cot_v1" as const };
    const tasks = ["default", botId].map((id, i) => {
      store.reportFeishuBotRuntimeStatus("local", "rt_one", { state: "online", appliedRevision: 1 }, id);
      const task = store.submitFeishuBotMessage("local", "rt_one", input, id);
      expect(task.agentId).toBe(agents[i]!.id);
      return task;
    });
    expect(tasks[0]!.chatSessionId).not.toBe(tasks[1]!.chatSessionId);
    for (const task of tasks) {
      expect(store.claimTask("rt_one")?.id).toBe(task.taskId);
      store.startTask(task.taskId); store.completeTask(task.taskId, { output: "reply" });
    }
    const outbounds = store.pendingFeishuBotOutbounds("local", "rt_one");
    expect(outbounds.map(outbound => outbound.botId).sort()).toEqual([botId, "default"].sort());
    const claimed = store.claimFeishuBotOutbounds("local", "rt_one");
    expect(claimed).toHaveLength(2);
    for (const delivery of claimed) expect(store.reportFeishuBotOutbound("local", "rt_one", delivery.id,
      { claimToken: delivery.claimToken, status: "sent" }, undefined, delivery.botId)).toBe(true);
    expect((await request(`feishu-bot?bot_id=${botId}`, "DELETE")).status).toBe(200);
    expect(store.feishuBotDirectivesForRuntime("local", "rt_one").find(d => d.bot_id === botId)?.desired_state).toBe("stopped");
    store.reportFeishuBotRuntimeStatus("local", "rt_one", { state: "stopped", appliedRevision: 1 }, botId);
    expect(store.feishuBotDirectivesForRuntime("local", "rt_one").map(d => d.bot_id)).toEqual(["default"]);
    expect(store.feishuBotStatusSnapshot("local").status).toBe("online");
  });

  it("falls back deterministically when multi capability disappears and gates new assignments", async () => {
    const { store, request, body, botId } = await multi();
    store.heartbeatRuntime("rt_one", { supportsFeishuBotConfig: true });
    expect(store.getFeishuBotDaemonConfig("local", "rt_one")?.bot_id).toBe("default");
    expect(runtimeInputSnapshot(store, "rt_one").filter(e => e.type === "feishu.directive")).toHaveLength(1);
    expect(runtimeInputSnapshot(store, "rt_one").some(e => e.type === "feishu.bot_directive")).toBe(false);
    expect(store.feishuBotFor(botId).statusSnapshot("local")).toMatchObject({ status: "failed", errorCode: "runtime_unsupported", desiredState: "stopped" });
    const rejected = await request("feishu-bots", "POST", { ...body(1), app_id: "cli_third", runtime_id: "rt_one" });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ code: "runtime_already_assigned" });
  });

  it("rejects foreign bot credentials, messages and online reports before writing any state", async () => {
    const { store, app, botId } = await multi();
    expect(() => store.reportFeishuBotRuntimeStatus("local", "rt_two", { state: "online", appliedRevision: 1 }, botId)).toThrow("runtime does not host");
    expect(store.feishuBotFor(botId).getRuntimeStatus("local", "rt_two")).toBeNull();
    const report = await reportFrame(store, "concierge.status_report", {
      runtime_id: "rt_two", bot_id: botId, applied_revision: 1, state: "online",
    });
    expect(report).toMatchObject({ ok: false, code: "runtime_not_selected" });
    expect(store.feishuBotFor(botId).getRuntimeStatus("local", "rt_two")).toBeNull();
    const token = await store.createAccessToken({ name: "other", type: "daemon", workspaceId: "local", daemonId: "daemon_two" });
    for (const [method, path] of [["GET", `feishu-bot?bot_id=${botId}`], ["POST", "feishu-bot/messages"]]) {
      const response = await app.request(`/api/daemon/runtimes/rt_two/${path}`, {
        method, headers: { Authorization: `Bearer ${token.token}`, "content-type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ bot_id: botId, revision: 1 }) } : {}),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "runtime_not_selected" });
    }
    const response = await app.request("/api/daemon/runtimes/rt_two/feishu-bots", { headers: { Authorization: `Bearer ${token.token}` } });
    expect(response.status).toBe(409);
  });

  it("keeps handover fences per bot when it moves to another runtime", async () => {
    const { store, request, body, botId } = await multi();
    store.reportFeishuBotRuntimeStatus("local", "rt_one", { state: "online", appliedRevision: 1 }, botId);
    expect((await request(`feishu-bot?bot_id=${botId}`, "PUT", body(1))).status).toBe(200);
    expect(store.feishuBotDirectiveForRuntime("local", "rt_two", botId)?.desired_state).toBe("stopped");
    expect(store.feishuBotDirectiveForRuntime("local", "rt_one", "default")?.desired_state).toBe("running");
    store.reportFeishuBotRuntimeStatus("local", "rt_one", { state: "stopped", appliedRevision: 2 }, botId);
    expect(store.feishuBotDirectiveForRuntime("local", "rt_two", botId)?.desired_state).toBe("running");
  });
});
