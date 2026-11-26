import { claimWithCurrentRuntime } from "../../helpers/claim-with-current-runtime.js";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { migratedStoreBackend, type MigratedStore } from "../../helpers/migrated-store-backends.js";
import { configureKindBot } from "./feishu-outbound-kind-fixture.js";

for (const backend of ["sqlite", "postgres"] as const) {
  const suite = backend === "postgres" && !process.env.MULTIREMI_TEST_POSTGRES_URL ? describe.skip : describe;
  suite(`Autopilot completion revalidates delivery (${backend})`, () => {
    const factory = migratedStoreBackend(backend, { prefix: "mul32_recheck", fixture: "autopilot-delivery-revalidation" });
    factory.install();
    let fixture: MigratedStore;
    let previousKey: string | undefined;
    beforeEach(async () => {
      previousKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
      process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 32).toString("base64");
      fixture = await factory.open();
    });
    afterEach(async () => {
      if (previousKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
      else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousKey;
      await fixture?.close();
    });

    for (const change of ["target Agent moves", "historical member is archived"]) {
      it(`keeps the run report internal when the ${change}`, async () => {
        const { store, db } = fixture;
        const bot = configureKindBot(store);
        const inbound = bot.inbound("recheck");
        store.completeTask(inbound.taskId, { output: "Initial reply" });
        const targetId = store.getTask(inbound.taskId)!.chatSessionId!;
        const previousMessages = store.listChatMessages(targetId);
        const reporter = store.createAgent({ name: "Reporter", provider: "codex" });
        const app = createMultiremiApp({ store, authToken: "test-root" });
        const headers = { "Content-Type": "application/json", Authorization: "Bearer test-root" };
        const created = await app.request("/api/autopilots", { method: "POST", headers,
          body: JSON.stringify({ title: "Report", assignee_id: reporter.id, execution_mode: "run_only", delivery_chat_session_id: targetId }) });
        expect(created.status).toBe(201);
        const { id } = await created.json();
        const member = change === "historical member is archived" ? store.createWorkspaceMember({ name: "Earlier operator" }) : null;
        if (member) store.updateAutopilot(id, { deliveryChatSessionId: targetId, deliveryAuthorizedBy: member.id });
        const run = store.runAutopilot(id);
        expect(claimWithCurrentRuntime(store, bot.runtimeId)?.id).toBe(run.taskId!);
        store.startTask(run.taskId!);
        if (member) {
          store.archiveWorkspaceMember(member.id);
        } else {
          const workspace = store.createWorkspace({ name: "Destination" });
          const moved = await app.request(`/api/agents/${bot.agent.id}`, { method: "PUT", headers,
            body: JSON.stringify({ workspace_id: workspace.id }) });
          expect(moved.status).toBe(200);
          expect(store.getAgent(bot.agent.id)?.workspaceId).toBe(workspace.id);
          expect(store.getChatSession(targetId)).toMatchObject({ workspaceId: "local", status: "active" });
        }
        store.completeTask(run.taskId!, { output: "Internal report" });
        expect(store.listChatMessages(targetId)).toEqual(previousMessages);
        expect(store.getMessage(`msg_autopilot_delivery_${run.id}`)).toMatchObject({ session_id: `auto_${id}`,
          metadata: { delivery_chat_session_id: targetId, delivery_status: "skipped" } });
        expect(db.query("SELECT id FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?").all(`fbo_autopilot_${run.id}`)).toEqual([]);
        expect(db.query("SELECT id FROM multiremi_feishu_bot_outbound_operations WHERE kind = 'autopilot_report'").all()).toEqual([]);
      }, 15_000);
    }

    if (backend === "postgres") it("holds the target Agent against migration until report commit", () => {
      const { store, db } = fixture;
      const reporter = store.createAgent({ name: "Reporter", provider: "codex" });
      const recipient = store.createAgent({ name: "Recipient", provider: "codex" });
      const target = store.createChatSession({ agentId: recipient.id });
      const runtime = store.registerRuntime({ name: "Host", provider: "codex" });
      const autopilot = store.createAutopilot({ title: "Report", assigneeId: reporter.id, executionMode: "run_only",
        deliveryChatSessionId: target.id, deliveryAuthorizedBy: store.getWorkspaceOperator("local")!.id });
      const run = store.runAutopilot(autopilot.id);
      expect(claimWithCurrentRuntime(store, runtime.id)?.id).toBe(run.taskId!);
      store.startTask(run.taskId!);
      const url = new URL(process.env.MULTIREMI_TEST_POSTGRES_URL!);
      url.pathname = String(db.query("SELECT current_database() AS name").get()!.name);
      const other = new PostgresSyncDatabase(url.toString());
      const migrationLock = other.query("SELECT id FROM multiremi_agents WHERE id = ? FOR NO KEY UPDATE NOWAIT");
      try {
        db.transaction(() => {
          store.completeTask(run.taskId!, { output: "Web report" });
          expect(() => migrationLock.get(recipient.id)).toThrow(/could not obtain lock/);
        })();
        expect(migrationLock.get(recipient.id)).toMatchObject({ id: recipient.id });
        expect(store.listChatMessages(target.id)).toHaveLength(1);
      } finally { other.close(); }
    }, 15_000);
  });
}
