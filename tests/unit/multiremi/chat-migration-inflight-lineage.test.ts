import { afterEach, describe, expect, it } from "bun:test";
import { runMigrations, bootstrapPreUnifiedSchema } from "@multiremi/store/migrations.js";
import { MultiremiStore } from "@multiremi/store.js";
import { seedLegacyChatIssueFixture } from "./chat-issue-migration-fixture.js";
import { createHistoricalDatabase, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("drained Chat migration cannot restore private Issue lineage", () => {
  for (const tableForeignKey of [false, true]) {
    for (const status of ["running", "awaiting_human", "waiting_local_directory"] as const) {
      it(`${tableForeignKey ? "table" : "inline"} FK ${status}: cuts over after drain and starts private work cold`, () => {
        createHistoricalDatabase();
        seedLegacyChatIssueFixture(db!, tableForeignKey);
        db!.run("UPDATE multiremi_tasks SET status='cancelled'");
        db!.run("UPDATE multiremi_tasks SET status=? WHERE id='tsk_chat_migration_running'", [status]);
        if (status !== "waiting_local_directory") {
          const before = db!.query("SELECT * FROM multiremi_tasks").all();
          expect(() => runMigrations(db!)).toThrow("Unified model migration refused");
          expect(db!.query("SELECT * FROM multiremi_tasks").all()).toEqual(before);
          expect(db!.query("SELECT name FROM sqlite_master WHERE name='multiremi_turns'").get()).toBeNull();
        }
        // MUL-493 requires draining before cutover; no legacy worker survives it.
        db!.run("UPDATE multiremi_tasks SET status='cancelled'");
        bootstrapPreUnifiedSchema(db!);
        const store = new MultiremiStore(db!);
        expect(store.getTask("tsk_chat_migration_running")?.status).toBe("cancelled");
        expect(store.getChatSession("chat_web_migration")?.sessionId).toBeNull();
        expect(() => store.completeTask("tsk_chat_migration_running", { output: "stale", sessionId: "old_issue_provider" })).toThrow();
        expect(store.getChatSession("chat_web_migration")?.sessionId).toBeNull();
        const runtime = store.registerRuntime({ id: "rt_legacy", name: "Machine", provider: "codex", workspaceId: "local" });
        const next = store.sendChatMessage("chat_web_migration", { content: "Next private question" }).task;
        const claim = store.claimTask(runtime.id)!;
        expect(claim.id).toBe(next.id);
        expect(claim.issueId).toBeNull();
        expect(claim.sessionId).toBeNull();
        store.buildTaskSessionProjection(claim.id);
        store.startTask(claim.id);
        store.completeTask(claim.id, { output: "Fresh reply", sessionId: "fresh_private_provider" });
        expect(store.getChatSession("chat_web_migration")?.sessionId).toBe("fresh_private_provider");
      });
    }
  }
  it("draining stale A work cannot restore A provider lineage in a retained B topic", () => {
    createHistoricalDatabase();
    seedLegacyChatIssueFixture(db!);
    db!.run("UPDATE multiremi_tasks SET status = 'cancelled'");
    db!.run(`UPDATE multiremi_tasks SET status = 'running', runtime_id = 'rt_legacy',
      provider = 'codex', session_id = 'old_A_provider'
      WHERE id = 'tsk_topic_migration_queued'`);
    db!.run(`INSERT INTO multiremi_issues (id, title, status, created_at, updated_at)
      VALUES ('issue_old_A', 'Prior Issue A', 'todo', '2026-09-01', '2026-09-01')`);
    db!.run(`INSERT INTO multiremi_tasks
      (id, workspace_id, agent_id, issue_id, chat_session_id, prompt, status, created_at, updated_at)
      VALUES ('old_A_wake', 'local', 'agt_chat_migration', 'issue_old_A', 'chat_group_migration',
        'Old A wake', 'queued', '2026-09-01', '2026-09-01')`);
    db!.run(`INSERT INTO multiremi_tasks
      (id, workspace_id, agent_id, issue_id, chat_session_id, prompt, status, created_at, updated_at)
      VALUES ('old_A_source', 'local', 'agt_chat_migration', 'issue_old_A', 'chat_group_migration',
        'Old A result', 'completed', '2026-09-01', '2026-09-01')`);
    db!.run(`INSERT INTO multiremi_feishu_bot_round_pushes
      (id, workspace_id, binding_id, issue_id, leader_task_id, wake_task_id, delivery_mode, created_at, updated_at)
      VALUES ('old_A_push', 'local', 'fcb_chat_group_migration', 'issue_old_A', 'old_A_source',
        'old_A_wake', 'proactive', '2026-09-01', '2026-09-01')`);
    expect(() => runMigrations(db!)).toThrow("Unified model migration refused");
    db!.run("UPDATE multiremi_tasks SET status = 'cancelled'");
    bootstrapPreUnifiedSchema(db!);
    const store = new MultiremiStore(db!);
    expect(store.getFeishuIssueIdForChatSession("chat_group_migration")).toBe("iss_chat_migration");
    expect(store.getTask("old_A_wake")?.status).toBe("cancelled");
    expect(() => store.completeTask("tsk_topic_migration_queued", { output: "stale B work", sessionId: "old_A_provider" })).toThrow();
    expect(store.getChatSession("chat_group_migration")?.sessionId).toBeNull();

    const runtime = store.registerRuntime({ id: "rt_legacy", name: "Machine", provider: "codex", workspaceId: "local" });
    const next = store.sendChatMessage("chat_group_migration", { content: "Continue B" }).task;
    expect(next.issueId).toBe("iss_chat_migration");
    const claim = store.claimTask(runtime.id)!;
    expect(claim.id).toBe(next.id);
    expect(claim.sessionId).toBeNull();
    store.buildTaskSessionProjection(claim.id);
    store.startTask(claim.id);
    store.completeTask(claim.id, { output: "Fresh B reply", sessionId: "fresh_B_provider" });
    expect(store.getChatSession("chat_group_migration")?.sessionId).toBe("fresh_B_provider");
  });

});
