import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { migratedStoreBackend, type MigratedStore } from "../../helpers/migrated-store-backends.js";
import { configureKindBot } from "./feishu-outbound-kind-fixture.js";

const warning = [{
  code: "autopilot_delivery_unbound",
  message: "Reports are saved only in the internal Chat. Open the Autopilot details to configure delivery.",
}];

for (const backend of ["sqlite", "postgres"] as const) {
  const suite = backend === "postgres" && !process.env.MULTIREMI_TEST_POSTGRES_URL ? describe.skip : describe;
  suite(`Autopilot delivery configuration (${backend})`, () => {
    const factory = migratedStoreBackend(backend, { prefix: "mul32_config", fixture: "autopilot-delivery-configuration" });
    let f: MigratedStore;
    let previousKey: string | undefined;
    beforeAll(() => {
      previousKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
      process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 32).toString("base64");
    });
    factory.install();
    beforeEach(async () => {
      f = await factory.open();
    });
    afterEach(async () => {
      await f?.close();
    });
    afterAll(() => {
      if (previousKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
      else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousKey;
    });

    function setup(native = false) {
      const { store } = f;
      const agent = store.createAgent({ name: "Reporter", provider: "codex" });
      const target = store.createChatSession({ agentId: agent.id, title: "Report destination" });
      const app = createMultiremiApp({ store, authToken: "test-root" });
      const headers = { "Content-Type": "application/json", Authorization: "Bearer test-root" };
      const base = `${native ? "/api/multiremi" : "/api"}/autopilots`;
      const input = native ? { title: "Report", assigneeId: agent.id, executionMode: "run_only" }
        : { title: "Report", assignee_id: agent.id, execution_mode: "run_only" };
      const deliveryKey = native ? "deliveryChatSessionId" : "delivery_chat_session_id";
      return { store, agent, target, app, headers, base, input, deliveryKey };
    }

    for (const native of [false, true]) {
      it(`derives warnings from persisted configuration on create/update/get/list (${native ? "native" : "compatibility"})`, async () => {
        const s = setup(native);
        const created = await s.app.request(s.base, { method: "POST", headers: s.headers, body: JSON.stringify({
          ...s.input, warnings: [], deliveryAuthorizedBy: "forged",
        }) });
        expect(created.status).toBe(201);
        const payload = await created.json();
        const autopilot = native ? payload.autopilot : payload;
        expect(autopilot.warnings).toEqual(warning);
        const id = autopilot.id;
        expect(s.store.getAutopilot(id)!.deliveryAuthorizedBy).toBeNull();
        const detail = await (await s.app.request(`${s.base}/${id}`, { headers: s.headers })).json();
        expect(detail.autopilot.warnings).toEqual(warning);
        const list = await (await s.app.request(s.base, { headers: s.headers })).json();
        expect(list.autopilots.find((row: { id: string }) => row.id === id).warnings).toEqual(warning);
        for (const [target, expected] of [[s.target.id, []], [null, warning]] as const) {
          const response = await s.app.request(`${s.base}/${id}`, { method: "PATCH", headers: s.headers,
            body: JSON.stringify({ [s.deliveryKey]: target, deliveryAuthorizedBy: "forged", warnings: [] }) });
          expect(response.status).toBe(200);
          const body = await response.json();
          expect((native ? body.autopilot : body).warnings).toEqual(expected);
        }
        const mode = native ? "executionMode" : "execution_mode";
        const response = await s.app.request(`${s.base}/${id}`, { method: "PATCH", headers: s.headers,
          body: JSON.stringify({ [mode]: "create_issue" }) });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect((native ? body.autopilot : body).warnings).toEqual([]);
        // Existing internal-only tasks receive the same warning without any migration/write.
        const legacy = s.store.createAutopilot({ title: "Legacy", assigneeId: s.agent.id, executionMode: "run_only" });
        const old = await (await s.app.request(`${s.base}/${legacy.id}`, { headers: s.headers })).json();
        expect(old.autopilot.warnings).toEqual(warning);
      });

      it(`preserves omitted targets, records only server authorizers and validates saves (${native ? "native" : "compatibility"})`, async () => {
        const s = setup(native);
        const created = await s.app.request(s.base, { method: "POST", headers: s.headers, body: JSON.stringify({
          ...s.input, [s.deliveryKey]: s.target.id, deliveryAuthorizedBy: "forged", delivery_authorized_by: "forged",
        }) });
        expect(created.status).toBe(201);
        const payload = await created.json();
        const id = (native ? payload.autopilot : payload).id;
        const operator = s.store.getWorkspaceOperator("local")!.id;
        const original = s.store.getAutopilot(id)!;
        expect(original.deliveryAuthorizedBy).toBe(operator);
        const path = `${s.base}/${id}`;
        expect((await s.app.request(path, { method: "PATCH", headers: s.headers,
          body: JSON.stringify({ title: "Renamed", deliveryAuthorizedBy: "forged" }) })).status).toBe(200);
        expect(s.store.getAutopilot(id)!.deliveryAuthorizedBy).toBe(operator);
        expect(s.store.getAutopilot(id)!.deliveryChatSessionId).toBe(s.target.id);
        const mode = native ? "executionMode" : "execution_mode";
        expect((await s.app.request(path, { method: "PATCH", headers: s.headers,
          body: JSON.stringify({ [mode]: "create_issue" }) })).status).toBe(400);
        const otherWorkspace = s.store.createWorkspace({ name: "Other" });
        const otherAgent = s.store.createAgent({ name: "Other reporter", provider: "codex", workspaceId: otherWorkspace.id });
        const otherTarget = s.store.createChatSession({ agentId: otherAgent.id, workspaceId: otherWorkspace.id });
        const archived = s.store.createChatSession({ agentId: s.agent.id, title: "Archived" });
        s.store.updateChatSession(archived.id, { status: "archived" });
        for (const [target, status] of [[otherTarget.id, 400], [archived.id, 400], ["", 400], [12, 400], ["missing", 404]] as const) {
          expect((await s.app.request(path, { method: "PATCH", headers: s.headers,
            body: JSON.stringify({ [s.deliveryKey]: target }) })).status).toBe(status);
          expect(s.store.getAutopilot(id)!.deliveryChatSessionId).toBe(s.target.id);
          expect(s.store.getAutopilot(id)!.deliveryAuthorizedBy).toBe(operator);
        }
        expect((await s.app.request(path, { method: "PATCH", headers: s.headers,
          body: JSON.stringify({ deliveryChatSessionId: s.target.id, delivery_chat_session_id: null }) })).status).toBe(400);
        const replacement = s.store.createChatSession({ agentId: s.agent.id, title: "Replacement" });
        expect((await s.app.request(path, { method: "PATCH", headers: s.headers,
          body: JSON.stringify({ [s.deliveryKey]: replacement.id, deliveryAuthorizedBy: "forged" }) })).status).toBe(200);
        expect(s.store.getAutopilot(id)!.deliveryChatSessionId).toBe(replacement.id);
        expect(s.store.getAutopilot(id)!.createdById).toBe(original.createdById);
        expect(s.store.getAutopilot(id)!.deliveryAuthorizedBy).toBe(operator);
        expect((await s.app.request(path, { method: "PATCH", headers: s.headers,
          body: JSON.stringify({ [mode]: "create_issue", [s.deliveryKey]: null }) })).status).toBe(200);
        expect(s.store.getAutopilot(id)!.deliveryAuthorizedBy).toBeNull();
        expect(s.store.getAutopilot(id)!.deliveryChatSessionId).toBeNull();
      });

      it(`rejects task and daemon same-Chat/cross-Chat/null delivery writes (${native ? "native" : "compatibility"})`, async () => {
        const s = setup(native);
        const source = s.store.sendChatMessage(s.target.id, { body: "Create a scheduled report for this conversation" });
        const task = s.store.getTask(source.task!.id)!;
        const taskToken = await s.store.createTaskAccessToken(task, "local");
        const daemon = await s.store.createAccessToken({ name: "Machine", type: "daemon", purpose: "daemon",
          workspaceId: "local", userId: "local", daemonId: "daemon_configuration" });
        const other = s.store.createChatSession({ agentId: s.agent.id });
        const saved = s.store.createAutopilot({ title: "Existing", assigneeId: s.agent.id, executionMode: "run_only" });
        for (const token of [taskToken, daemon]) {
          const headers = { ...s.headers, Authorization: `Bearer ${token.token}` };
          for (const key of ["delivery_chat_session_id", "deliveryChatSessionId"]) {
            for (const target of [s.target.id, other.id, null]) {
              for (const [method, path, body] of [
                ["POST", s.base, { ...s.input, [key]: target }],
                ["PATCH", `${s.base}/${saved.id}`, { [key]: target }],
              ] as const) {
                const response = await s.app.request(path, { method, headers,
                  body: JSON.stringify({ ...body, deliveryAuthorizedBy: s.store.getWorkspaceOperator("local")!.id }) });
                expect(response.status).toBe(403);
                if (token === taskToken) expect(await response.json()).toMatchObject({
                  error: "Autopilot delivery requires a human operator", code: "autopilot_delivery_human_required",
                });
              }
            }
          }
          expect((await s.app.request("/api/autopilot-delivery-targets?workspace_id=local", { headers })).status).toBe(403);
        }
        expect(s.store.listAutopilots("local")).toHaveLength(1);
        expect(s.store.getAutopilot(saved.id)!.deliveryChatSessionId).toBeNull();
        expect(s.store.getAutopilot(saved.id)!.deliveryAuthorizedBy).toBeNull();
        // Task creation without a target remains supported, and tells the caller it is internal-only.
        const response = await s.app.request(s.base, { method: "POST",
          headers: { ...s.headers, Authorization: `Bearer ${taskToken.token}` }, body: JSON.stringify(s.input) });
        expect(response.status).toBe(201);
        const body = await response.json();
        expect((native ? body.autopilot : body).warnings).toEqual(warning);
      });
    }

    it("lists only accessible active user/Feishu Chats with safe metadata, preserving the ordinary Chat list", async () => {
      const s = setup();
      const archived = s.store.createChatSession({ agentId: s.agent.id, title: "Archived" });
      s.store.updateChatSession(archived.id, { status: "archived" });
      const automation = s.store.createAutopilot({ title: "Internal", assigneeId: s.agent.id, executionMode: "run_only" });
      const workspace = s.store.createWorkspace({ name: "Foreign" });
      const agent = s.store.createAgent({ name: "Foreign", provider: "codex", workspaceId: workspace.id });
      const foreign = s.store.createChatSession({ agentId: agent.id, workspaceId: workspace.id });
      const bot = configureKindBot(s.store);
      const inbound = bot.inbound("mul32_candidates");
      s.store.completeTask(inbound.taskId, { output: "Fixture response" });
      const feishuId = s.store.getTask(inbound.taskId)!.chatSessionId!;
      const run = s.store.runAutopilot(automation.id);
      const response = await s.app.request("/api/autopilot-delivery-targets?workspace_id=local", { headers: s.headers });
      expect(response.status).toBe(200);
      const { targets } = await response.json();
      expect(targets).toHaveLength(2);
      expect(targets).toContainEqual({ id: s.target.id, title: s.target.title, channel: "web_chat" });
      expect(targets).toContainEqual({ id: feishuId, title: s.store.getChatSession(feishuId)!.title, channel: "feishu" });
      for (const target of targets) expect(Object.keys(target).sort()).toEqual(["channel", "id", "title"]);
      for (const excluded of [archived.id, run.chatSessionId, foreign.id]) {
        expect(targets.some((row: { id: string }) => row.id === excluded)).toBe(false);
      }
      const ordinaryResponse = await s.app.request("/api/chat/sessions?workspace_id=local", { headers: s.headers });
      expect(ordinaryResponse.status).toBe(200);
      const ordinary = JSON.stringify(await ordinaryResponse.json());
      expect(ordinary).toContain(s.target.id);
      expect(ordinary).not.toContain(feishuId);
      expect((await s.app.request("/api/autopilot-delivery-targets?workspace_id=missing", { headers: s.headers })).status).toBe(404);
      expect((await s.app.request("/api/autopilot-delivery-targets?workspace_id=local")).status).toBe(401);
      // Losing access after discovery must hide metadata and reject a subsequent save.
      const getAgent = s.store.getAgent.bind(s.store);
      s.store.getAgent = (id) => id === bot.agent.id ? null : getAgent(id);
      try {
        const revoked = await (await s.app.request("/api/autopilot-delivery-targets?workspace_id=local", { headers: s.headers })).json();
        expect(revoked.targets).toEqual([{ id: s.target.id, title: s.target.title, channel: "web_chat" }]);
        const save = await s.app.request(`${s.base}/${automation.id}`, { method: "PATCH", headers: s.headers,
          body: JSON.stringify({ delivery_chat_session_id: feishuId }) });
        expect(save.status).toBe(403);
        expect(s.store.getAutopilot(automation.id)!.deliveryChatSessionId).toBeNull();
      } finally { s.store.getAgent = getAgent; }
      const scoped = await s.store.createAccessToken({ workspaceId: workspace.id, type: "pat", name: "Foreign workspace" });
      const denied = await s.app.request("/api/autopilot-delivery-targets?workspace_id=local", {
        headers: { Authorization: `Bearer ${scoped.token}` },
      });
      expect(denied.status).toBeGreaterThanOrEqual(400);
      expect(await denied.text()).not.toContain(s.target.title);
      // Saving re-checks a candidate that was archived after the read.
      s.store.updateChatSession(s.target.id, { status: "archived" });
      expect((await s.app.request(`${s.base}/${automation.id}`, { method: "PATCH", headers: s.headers,
        body: JSON.stringify({ delivery_chat_session_id: s.target.id }) })).status).toBe(400);
      expect(s.store.getAutopilot(automation.id)!.deliveryChatSessionId).toBeNull();
    });
  });
}
