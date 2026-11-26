import { claimWithCurrentRuntime } from "../../helpers/claim-with-current-runtime.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiScheduler } from "@multiremi/scheduler.js";
import { migratedStoreBackend, type MigratedStore } from "../../helpers/migrated-store-backends.js";
import { configureKindBot } from "./feishu-outbound-kind-fixture.js";

for (const backend of ["sqlite", "postgres"] as const) {
  const suite = backend === "postgres" && !process.env.MULTIREMI_TEST_POSTGRES_URL ? describe.skip : describe;
  suite(`Autopilot authorized Chat delivery (${backend})`, () => {
    const factory = migratedStoreBackend(backend, { prefix: "mul11_delivery", fixture: "autopilot-chat-delivery" });
    let f: MigratedStore;
    let previousJobs: string | undefined;
    let previousKey: string | undefined;
    beforeAll(() => {
      previousJobs = process.env.MULTIREMI_BACKGROUND_JOBS;
      previousKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
      process.env.MULTIREMI_BACKGROUND_JOBS = "1";
      process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString("base64");
    });
    factory.install();
    beforeEach(async () => {
      process.env.MULTIREMI_BACKGROUND_JOBS = "1";
      f = await factory.open();
    });
    afterEach(async () => { await f?.close(); });
    afterAll(() => {
      if (previousJobs === undefined) delete process.env.MULTIREMI_BACKGROUND_JOBS; else process.env.MULTIREMI_BACKGROUND_JOBS = previousJobs;
      if (previousKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY; else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousKey;
    });

    async function setup(native = false) {
      const { store } = f;
      const agent = store.createAgent({ name: "Inspector", provider: "codex" });
      const target = store.createChatSession({ agentId: agent.id, title: "Main Chat", creatorId: "local" });
      const runtime = store.registerRuntime({ name: "Inspector host", provider: "codex" });
      const app = createMultiremiApp({ store, authToken: "test-root" });
      const headers = { "Content-Type": "application/json", Authorization: "Bearer test-root" };
      const response = await app.request(native ? "/api/multiremi/autopilots" : "/api/autopilots", {
        method: "POST", headers, body: JSON.stringify(native ? {
          title: "Inspection", assigneeId: agent.id, executionMode: "run_only", sessionPolicy: "reuse_latest",
          deliveryChatSessionId: target.id,
        } : {
          title: "Inspection", assignee_id: agent.id, execution_mode: "run_only", session_policy: "reuse_latest",
          delivery_chat_session_id: target.id,
        }),
      });
      const body = await response.json();
      expect(body).not.toHaveProperty("error");
      expect(response.status).toBe(201);
      const id = native ? body.autopilot.id : body.id;
      return { store, agent, target, runtime, app, headers, autopilot: store.getAutopilot(id)! };
    }

    for (const native of [false, true]) it(`round-trips and clears the human-authorized target (${native ? 'native' : 'compatibility'} API)`, async () => {
      const s = await setup(native);
      expect(s.autopilot.deliveryChatSessionId).toBe(s.target.id);
      expect(s.autopilot.deliveryAuthorizedBy).toBe(s.store.getWorkspaceOperator("local")!.id);
      const path = `${native ? "/api/multiremi" : "/api"}/autopilots/${s.autopilot.id}`;
      const response = await s.app.request(path, { method: "PATCH", headers: s.headers,
        body: JSON.stringify(native ? { deliveryChatSessionId: null } : { delivery_chat_session_id: null }) });
      expect(response.status).toBe(200);
      expect(s.store.getAutopilot(s.autopilot.id)!.deliveryChatSessionId).toBeNull();
      expect(s.store.getAutopilot(s.autopilot.id)!.deliveryAuthorizedBy).toBeNull();
    });

    it("delivers scheduled results once while reuse_latest keeps the execution Chat isolated", async () => {
      const s = await setup();
      s.store.createAutopilotTrigger(s.autopilot.id, { kind: "schedule", cronExpression: "*/30 * * * *" });
      const scheduler = new MultiremiScheduler({ store: s.store });
      const scheduled = scheduler.trigger(s.autopilot.id)!;
      const run = s.store.getAutopilotRun(scheduled.id)!;
      expect(run.source).toBe("schedule");
      expect(run.chatSessionId).not.toBe(s.target.id);
      expect(claimWithCurrentRuntime(s.store, s.runtime.id)!.id).toBe(run.taskId!);
      s.store.startTask(run.taskId!);
      s.store.completeTask(run.taskId!, { output: "项目 A：已完成接口回归。" });
      expect(() => s.store.completeTask(run.taskId!, { output: "项目 A：已完成接口回归。" })).toThrow("terminal");
      const messages = s.store.listChatMessages(s.target.id);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.body).toContain("项目 A：已完成接口回归。");
      const report = s.store.getMessage(`msg_autopilot_delivery_${run.id}`)!;
      expect(report.sender_type).toBe("timer");
      expect(report.metadata).toMatchObject({ run_id: run.id, delivery_authorized_by: s.autopilot.deliveryAuthorizedBy });
      expect(report.wake_applied).toBe("inbox_only");
      const next = s.store.getAutopilotRun(scheduler.trigger(s.autopilot.id)!.id)!;
      expect(next.chatSessionId).toBe(run.chatSessionId);
      scheduler.stop();
    });

    it("keeps task tokens unable to read/write an unrelated Chat or alter delivery authorization", async () => {
      const s = await setup();
      const run = s.store.runAutopilot(s.autopilot.id);
      const task = s.store.getTask(run.taskId!)!;
      const token = await s.store.createTaskAccessToken(task, "local");
      const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token.token}` };
      for (const method of ["GET", "POST"]) {
        const response = await s.app.request(`/api/sessions/${s.target.id}/messages`, { method, headers,
          ...(method === "POST" ? { body: JSON.stringify({ body_md: "unauthorized", to: { type: "member", ref: s.autopilot.deliveryAuthorizedBy }, message_kind: "reply", wake_requested: "inbox_only" }) } : {}) });
        expect(response.status).toBe(403);
      }
      for (const prefix of ["/api", "/api/multiremi"]) for (const target of [s.target.id, null]) {
        const response = await s.app.request(`${prefix}/autopilots/${s.autopilot.id}`, { method: "PATCH", headers,
          body: JSON.stringify({ delivery_chat_session_id: target, deliveryAuthorizedBy: s.autopilot.deliveryAuthorizedBy }) });
        expect(response.status).toBe(403);
      }
      expect(s.store.listChatMessages(s.target.id)).toHaveLength(0);
    });

    it("preserves unconfigured automations and reports failures even after quiet was requested", async () => {
      const s = await setup();
      const quiet = s.store.runAutopilot(s.autopilot.id);
      claimWithCurrentRuntime(s.store, s.runtime.id); s.store.startTask(quiet.taskId!);
      s.store.markAutopilotRunQuiet(s.store.getTurnForAttempt(quiet.taskId!)!.id);
      s.store.completeTask(quiet.taskId!, { output: "No changes." });
      expect(s.store.listChatMessages(s.target.id)).toHaveLength(0);
      const failed = s.store.runAutopilot(s.autopilot.id);
      claimWithCurrentRuntime(s.store, s.runtime.id); s.store.startTask(failed.taskId!);
      s.store.markAutopilotRunQuiet(s.store.getTurnForAttempt(failed.taskId!)!.id);
      s.store.failTask(failed.taskId!, { error: "Inspection failed" });
      expect(s.store.listChatMessages(s.target.id)).toHaveLength(1);
      expect(s.store.listChatMessages(s.target.id)[0]!.body).toContain("Inspection failed");
      const unconfigured = s.store.createAutopilot({ title: "Legacy", executionMode: "run_only", assigneeId: s.agent.id });
      expect(unconfigured.deliveryChatSessionId).toBeNull();
      const old = s.store.runAutopilot(unconfigured.id);
      claimWithCurrentRuntime(s.store, s.runtime.id); s.store.startTask(old.taskId!);
      s.store.completeTask(old.taskId!, { output: "Legacy result" });
      expect(s.store.getMessage(`msg_autopilot_delivery_${old.id}`)).toBeNull();
      expect(s.store.listChatMessages(s.target.id)).toHaveLength(1);
    });

    it("rejects cross-workspace targets and malformed IDs", async () => {
      const s = await setup();
      const workspace = s.store.createWorkspace({ name: "Other" });
      const agent = s.store.createAgent({ name: "Other agent", provider: "codex", workspaceId: workspace.id });
      const target = s.store.createChatSession({ agentId: agent.id, workspaceId: workspace.id });
      for (const id of [target.id, "", 4, "missing"]) {
        const response = await s.app.request(`/api/autopilots/${s.autopilot.id}`, { method: "PATCH", headers: s.headers,
          body: JSON.stringify({ delivery_chat_session_id: id }) });
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
      }
      expect(s.store.getAutopilot(s.autopilot.id)!.deliveryChatSessionId).toBe(s.target.id);
    });

    it("skips archived targets with an audit message, and honors target revocation before completion", async () => {
      const s = await setup();
      const run = s.store.runAutopilot(s.autopilot.id);
      claimWithCurrentRuntime(s.store, s.runtime.id); s.store.startTask(run.taskId!);
      s.store.updateChatSession(s.target.id, { status: "archived" });
      s.store.completeTask(run.taskId!, { output: "private result" });
      expect(s.store.listChatMessages(s.target.id)).toHaveLength(0);
      expect(s.store.getMessage(`msg_autopilot_delivery_${run.id}`)!.metadata.delivery_status).toBe("skipped");
      s.store.updateChatSession(s.target.id, { status: "active" });
      const next = s.store.runAutopilot(s.autopilot.id);
      claimWithCurrentRuntime(s.store, s.runtime.id); s.store.startTask(next.taskId!);
      const clear = await s.app.request(`/api/autopilots/${s.autopilot.id}`, { method: "PATCH", headers: s.headers,
        body: JSON.stringify({ delivery_chat_session_id: null }) });
      expect(clear.status).toBe(200);
      s.store.completeTask(next.taskId!, { output: "revoked result" });
      expect(s.store.listChatMessages(s.target.id)).toHaveLength(0);
    });

    for (const jobs of ["1", "0"]) for (const outcome of ["short", "long", "failed"] as const) it(`queues a ${outcome} report for the Feishu-bound target, including jobs=${jobs} deferral`, async () => {
      const s = await setup();
      const bot = configureKindBot(s.store);
      const inbound = bot.inbound(`mul11_${jobs}`);
      s.store.completeTask(inbound.taskId, { output: "Original reply" });
      const targetId = s.store.getTask(inbound.taskId)!.chatSessionId!;
      const bound = await s.app.request(`/api/autopilots/${s.autopilot.id}`, { method: "PATCH", headers: s.headers,
        body: JSON.stringify({ delivery_chat_session_id: targetId }) });
      expect(bound.status).toBe(200);
      process.env.MULTIREMI_BACKGROUND_JOBS = jobs;
      const run = s.store.runAutopilot(s.autopilot.id, { source: "schedule" });
      // The automation and the target bot deliberately have different agents.
      claimWithCurrentRuntime(s.store, s.runtime.id); s.store.startTask(run.taskId!);
      const output = outcome === "short" ? "定期巡检：所有项目进展已更新。" : "巡😀".repeat(20_000);
      if (outcome === "failed") s.store.failTask(run.taskId!, { error: output });
      else s.store.completeTask(run.taskId!, { output });
      const reportBody = s.store.listChatMessages(targetId).at(-1)!.body;
      expect(Buffer.byteLength(reportBody)).toBeLessThanOrEqual(4_096);
      expect(reportBody).not.toContain("\ufffd");
      expect(reportBody).toContain(run.id);
      if (outcome === "short") {
        expect(reportBody).toContain(output);
        expect(reportBody).not.toContain("已截断");
      } else {
        expect(reportBody).toContain("巡😀");
        expect(reportBody).toContain("已截断");
        // Only the delivery copy is bounded; the execution keeps its full evidence.
        const task = s.store.getTask(run.taskId!)!;
        if (outcome === "failed") expect(task.error).toBe(output);
        else expect(task.result).toContain(output);
      }
      // Claiming drains durable intents even in runtime API processes with jobs disabled.
      let delivery = null;
      for (let index = 0; index < 12; index++) {
        const item = s.store.claimFeishuBotOutbound("local", bot.runtimeId, undefined, true, true, true, true);
        if (!item) break;
        if (item.id === `fbo_autopilot_${run.id}`) { delivery = item; break; }
        s.store.reportFeishuBotOutbound("local", bot.runtimeId, item.id, { claimToken: item.claimToken!, status: "sent", externalMessageId: `om_reply_${index}` });
      }
      expect(delivery).not.toBeNull();
      expect(delivery!.chatId).toBe(`oc_kind_mul11_${jobs}`);
      expect(delivery!.body).toBe(reportBody);
      expect(delivery!.taskId).toBeUndefined();
    });
  });
}
