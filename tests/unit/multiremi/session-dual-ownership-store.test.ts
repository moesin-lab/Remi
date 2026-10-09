import { afterEach, describe, expect, it } from "bun:test";
import { bootstrapPreUnifiedSchema, runMigrations } from "@multiremi/store/migrations.js";
import { MultiremiStore } from "@multiremi/store.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { historicalWriters } from "./unified-model-test-backends.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { createStore, db, readyArchiveBinding, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const migrationId = "20261008_dual_owned_sessions";
const migrateAgain = () => runMigrations(db! as unknown as SqlDatabase);
const count = (table: string, field: string, id: string) =>
  Number((db!.query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${field} = ?`).get(id) as { count: number }).count);

describe("Session dual ownership store", () => {
  it("creates an Issue Main without an Agent or Chat and preserves external creator audit", () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Independent work", createdBy: "feishu:open:test:creator" });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const side = store.createIssueSession(issue.id, { parentSessionId: main.id, title: "Review" });

    expect(main).toMatchObject({ ownerType: "issue", ownerId: issue.id, chatId: null, issueId: issue.id, isDefault: true });
    expect(side).toMatchObject({ ownerType: "issue", ownerId: issue.id, chatId: null, parentSessionId: main.id, holdsWorkspace: false });
    expect(store.getOrCreateDefaultIssueSession(issue.id).id).toBe(main.id);
    expect(store.listChatSessions("local")).toEqual([]);
    expect(store.listSessionParticipants(main.id)).toEqual([]);
  });

  it("keeps projected Chat Sessions distinct from the Issue Main and refuses cross-owner forks and ids", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Worker", provider: "claude" });
    const issue = store.createIssue({ title: "Shared anchor" });
    const chat = store.createChatSession({ agentId: agent.id });
    const projected = store.createIssueSession(issue.id, { chatId: chat.id, title: "Private work" });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const before = store.listConversationLogEntries(main.id);

    expect(projected).toMatchObject({ ownerType: "chat", ownerId: chat.id, issueId: issue.id });
    expect(main.chatId).toBeNull();
    expect(() => store.createIssueSession(issue.id, { parentSessionId: projected.id })).toThrow("same Issue owner");
    expect(() => store.createSession(chat.id, { parentSessionId: main.id })).toThrow("same Chat");
    expect(() => store.createSession(chat.id, { id: main.id, title: "Overwrite" })).toThrow("another owner");
    expect(store.listConversationLogEntries(main.id)).toEqual(before);
    expect(() => db!.run("UPDATE multiremi_issue_sessions SET issue_id = NULL WHERE id = ?", [main.id])).toThrow("owner_check");
    expect(() => db!.run("UPDATE multiremi_issue_sessions SET is_default = 1 WHERE id = ?", [
      store.createIssueSession(issue.id, { title: "Another Main" }).id,
    ])).toThrow("UNIQUE");
  });

  it("executes Issue-owned Sessions without adoption and protects explicit transfers", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Worker", provider: "claude" });
    const issue = store.createIssue({ title: "Run directly" });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const task = store.createSessionTask(main.id, { agentId: agent.id, prompt: "Work" });

    expect(task).toMatchObject({ chatSessionId: null, issueSessionId: main.id, issueId: issue.id });
    expect(store.listChatSessions("local")).toEqual([]);
    const chat = store.createChatSession({ agentId: agent.id });
    expect(() => store.adoptLegacySession(chat.id, main.id)).toThrow("active Tasks");
    store.cancelTask(task.id);
    const adopted = store.adoptLegacySession(chat.id, main.id);
    expect(adopted).toMatchObject({ id: main.id, ownerType: "chat", ownerId: chat.id, isDefault: false });
    expect(store.getOrCreateDefaultIssueSession(issue.id).id).not.toBe(main.id);

    const parent = store.getOrCreateDefaultIssueSession(issue.id);
    const side = store.createIssueSession(issue.id, { parentSessionId: parent.id });
    expect(() => store.adoptLegacySession(chat.id, parent.id)).toThrow("parent or child");
    expect(() => store.adoptLegacySession(chat.id, side.id)).toThrow("parent or child");
  });

  it("rolls a Result publication back when its Session event fails", () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Atomic publication" });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const before = store.listConversationLogEntries(main.id);
    db!.exec(`CREATE TRIGGER reject_result_event BEFORE INSERT ON multiremi_conversation_log
      WHEN NEW.kind = 'result_published' BEGIN SELECT RAISE(ABORT, 'injected publication failure'); END`);

    expect(() => store.publishSessionResult(main.id, { body: "Must not survive" })).toThrow("injected publication failure");
    expect(store.listSessionResults(main.id)).toEqual([]);
    expect(store.listConversationLogEntries(main.id)).toEqual(before);
    expect(store.listSessionEvents(main.id)).toEqual([]);
  });

  for (const foreignKeys of [false, true]) {
    it(`deletes an Issue's owned history and only detaches Chat projections (FK=${foreignKeys})`, () => {
      const store = createStore();
      db!.exec(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
      const agent = store.createAgent({ name: "Worker", provider: "claude" });
      const issue = store.createIssue({ title: "Mixed work" });
      const main = store.getOrCreateDefaultIssueSession(issue.id);
      const ownedTask = store.createSessionTask(main.id, { agentId: agent.id, prompt: "Owned round" });
      const ownedResult = store.publishSessionResult(main.id, { body: "Owned result" });
      const chat = store.createChatSession({ agentId: agent.id });
      const projected = store.createIssueSession(issue.id, { chatId: chat.id, title: "Private projected work" });
      const projectedResult = store.publishSessionResult(projected.id, { body: "Private result" });

      store.cancelTask(ownedTask.id);
      const runtime = store.registerRuntime({ id: "rt_delete", name: "Cleanup", provider: "claude" });
      store.reportIssueWorkspace({ issueId: issue.id, runtimeId: runtime.id, rootPath: "/tmp/owned",
        branchName: `agent/${issue.key}`, status: "ready" });
      store.markIssueWorkspaceCleaned({ issueId: issue.id, runtimeId: runtime.id,
        ...readyArchiveBinding(store, issue.id, runtime.id) });

      expect(store.beginIssueDeletion(issue.id)).toEqual({ ok: true });
      const deleted = store.deleteIssue(issue.id);
      expect(store.getIssue(issue.id)).toBeNull();
      expect(deleted).toBe(true);
      expect(store.getIssueSession(main.id)).toBeNull();
      expect(store.getSessionResult(ownedResult.id)).toBeNull();
      expect(store.getTask(ownedTask.id)).toMatchObject({ status: "cancelled", issueId: null, issueSessionId: null });
      expect(store.getIssueSession(projected.id)).toMatchObject({ ownerType: "chat", ownerId: chat.id, issueId: null });
      expect(store.getSessionResult(projectedResult.id)).toMatchObject({ chatId: chat.id, issueId: null });
      for (const table of ["multiremi_session_participants", "multiremi_session_lanes",
        "multiremi_conversation_log", "multiremi_conversation_heads"]) {
        expect(count(table, "session_id", main.id)).toBe(0);
      }
      expect(db!.query("PRAGMA foreign_key_check").all().filter((row: any) =>
        row.table === "multiremi_issue_sessions" || row.parent === "multiremi_issue_sessions",
      )).toEqual([]);
    });

    it(`deletes Chat history while retaining private Task tombstones (FK=${foreignKeys})`, () => {
      const store = createStore();
      db!.exec(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
      const agent = store.createAgent({ name: "Worker", provider: "claude" });
      const issue = store.createIssue({ title: "Retained Issue" });
      const issueMain = store.getOrCreateDefaultIssueSession(issue.id);
      const chat = store.createChatSession({ agentId: agent.id });
      const projected = store.createIssueSession(issue.id, { chatId: chat.id });
      const task = store.createSessionTask(projected.id, { agentId: agent.id, prompt: "Private round" });
      const result = store.publishSessionResult(projected.id, { body: "Private result" });

      expect(store.deleteChatSession(chat.id)).toBe(true);
      expect(store.getIssueSession(projected.id)).toBeNull();
      expect(store.getSessionResult(result.id)).toBeNull();
      expect(store.getIssueSession(issueMain.id)?.ownerId).toBe(issue.id);
      expect(store.getTask(task.id)).toMatchObject({ status: "cancelled", chatSessionId: chat.id, issueSessionId: null });
      for (const logId of [chat.id, projected.id]) {
        expect(count("multiremi_conversation_log", "session_id", logId)).toBe(0);
        expect(count("multiremi_conversation_heads", "session_id", logId)).toBe(0);
      }
      expect(db!.query("PRAGMA foreign_key_check").all()).toEqual([]);
    });
  }

  it("moves Issue-owned history and detaches Chat projections atomically", () => {
    const store = createStore();
    const target = store.createWorkspace({ name: "Target" });
    const agent = store.createAgent({ name: "Worker", provider: "claude" });
    const issue = store.createIssue({ title: "Move with history" });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const side = store.createIssueSession(issue.id, { parentSessionId: main.id });
    store.appendSessionEvent(main.id, { authorType: "system", body: "Keep history" });
    const ownedResult = store.publishSessionResult(main.id, { body: "Owned result" });
    const chat = store.createChatSession({ agentId: agent.id });
    const projected = store.createIssueSession(issue.id, { chatId: chat.id });
    const projectedResult = store.publishSessionResult(projected.id, { body: "Projected result" });
    const task = store.createSessionTask(main.id, { agentId: agent.id, prompt: "Active work" });
    expect(() => store.updateIssue(issue.id, { workspaceId: target.id })).toThrow("workspace");
    expect(store.getIssueSession(main.id)?.workspaceId).toBe("local");
    expect(store.getIssueSession(projected.id)?.issueId).toBe(issue.id);
    store.cancelTask(task.id);
    const before = store.listConversationLogEntries(main.id);
    store.updateIssue(issue.id, { workspaceId: target.id });
    for (const sessionId of [main.id, side.id]) {
      expect(store.getIssueSession(sessionId)).toMatchObject({ ownerId: issue.id, workspaceId: target.id });
    }
    expect(store.listConversationLogEntries(main.id).slice(0, before.length)).toEqual(before);
    expect(store.getSessionResult(ownedResult.id)?.issueId).toBe(issue.id);
    expect(store.getIssueSession(projected.id)).toMatchObject({ ownerId: chat.id, workspaceId: "local", issueId: null });
    expect(store.getSessionResult(projectedResult.id)?.issueId).toBeNull();
    expect(store.getTask(task.id)?.workspaceId).toBe("local");
    const empty = store.createIssue({ title: "Empty Main can move" });
    store.updateIssue(empty.id, { workspaceId: target.id });
    expect(store.getOrCreateDefaultIssueSession(empty.id).workspaceId).toBe(target.id);
  });

  it("rejects ownerless upgrades without changing history, schema or the migration marker", () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Orphaned before upgrade" });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    store.appendSessionEvent(main.id, { authorType: "system", body: "Preserve" });
    const result = store.publishSessionResult(main.id, { body: "Preserve result" });
    db!.exec("PRAGMA ignore_check_constraints = ON");
    db!.run("UPDATE multiremi_issue_sessions SET issue_id = NULL WHERE id = ?", [main.id]);
    db!.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", [migrationId]);
    const before = db!.query("SELECT * FROM multiremi_issue_sessions ORDER BY id").all();
    const schema = db!.query("SELECT sql FROM sqlite_master WHERE name = 'multiremi_issue_sessions'").get();
    const logs = store.listConversationLogEntries(main.id);

    expect(migrateAgain).toThrow(`invalid or missing owner for Session ${main.id}`);
    expect(db!.query("SELECT * FROM multiremi_issue_sessions ORDER BY id").all()).toEqual(before);
    expect(db!.query("SELECT sql FROM sqlite_master WHERE name = 'multiremi_issue_sessions'").get()).toEqual(schema);
    expect(db!.query("SELECT 1 FROM multiremi_schema_migrations WHERE id = ?").get(migrationId)).toBeNull();
    expect(store.getSessionResult(result.id)?.body).toBe("Preserve result");
    expect(store.listConversationLogEntries(main.id)).toEqual(logs);
  });

  it("repairs legacy moved Issues without changing Session, event, Task or Result identities", () => {
    const store = createStore();
    const target = store.createWorkspace({ name: "Target" });
    const agent = store.createAgent({ name: "Worker", provider: "claude" });
    const issue = store.createIssue({ title: "Legacy moved work" });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const chat = store.createChatSession({ agentId: agent.id });
    const projected = store.createIssueSession(issue.id, { chatId: chat.id });
    const task = store.createSessionTask(main.id, { agentId: agent.id, prompt: "Old audit" });
    store.cancelTask(task.id);
    const result = store.publishSessionResult(main.id, { body: "Owned result" });
    const projectedResult = store.publishSessionResult(projected.id, { body: "Private result" });
    const events = db!.query("SELECT * FROM multiremi_conversation_log ORDER BY id").all();
    const audit = db!.query("SELECT * FROM multiremi_turn_execution_records WHERE id = ?").get(task.id);
    db!.run("UPDATE multiremi_issues SET workspace_id = ? WHERE id = ?", [target.id, issue.id]);
    db!.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", [migrationId]);

    migrateAgain();
    migrateAgain();
    expect(store.getIssueSession(main.id)).toMatchObject({ id: main.id, ownerId: issue.id, workspaceId: target.id, chatId: null });
    expect(store.getIssueSession(projected.id)).toMatchObject({ id: projected.id, ownerId: chat.id, workspaceId: "local", issueId: null });
    expect(store.getSessionResult(result.id)).toMatchObject({ id: result.id, issueId: issue.id });
    expect(store.getSessionResult(projectedResult.id)).toMatchObject({ id: projectedResult.id, chatId: chat.id, issueId: null });
    expect(db!.query("SELECT * FROM multiremi_conversation_log ORDER BY id").all()).toEqual(events);
    expect(db!.query("SELECT * FROM multiremi_turn_execution_records WHERE id = ?").get(task.id)).toEqual(audit);
    expect(db!.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rolls legacy workspace repairs back when a parent belongs to another owner", () => {
    const store = createStore();
    const target = store.createWorkspace({ name: "Target" });
    const issue = store.createIssue({ title: "Old moved work" });
    const other = store.createIssue({ title: "Other owner" });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const otherMain = store.getOrCreateDefaultIssueSession(other.id);
    db!.run("UPDATE multiremi_issues SET workspace_id = ? WHERE id = ?", [target.id, issue.id]);
    db!.run("UPDATE multiremi_issue_sessions SET parent_session_id = ? WHERE id = ?", [otherMain.id, main.id]);
    db!.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", [migrationId]);
    const before = db!.query("SELECT * FROM multiremi_issue_sessions ORDER BY id").all();

    expect(migrateAgain).toThrow(`parent has a different owner for Session ${main.id}`);
    expect(db!.query("SELECT * FROM multiremi_issue_sessions ORDER BY id").all()).toEqual(before);
    expect(db!.query("SELECT 1 FROM multiremi_schema_migrations WHERE id = ?").get(migrationId)).toBeNull();
  });

  it("removes the historical Task Chat FK while preserving every Task column and index before cutover", () => {
    const historicalDb = openSqliteDatabase(":memory:", { create: true }) as unknown as SqlDatabase;
    try {
      bootstrapPreUnifiedSchema(historicalDb);
      const historical = historicalWriters(historicalDb);
      const agent = historical.createAgent({ name: "Worker", provider: "claude" });
      const chat = historical.createChatSession({ agentId: agent.id });
      const task = historical.createTask({ agentId: agent.id, chatSessionId: chat.id, prompt: "Private audit", status: "cancelled" });
      historicalDb.exec("ALTER TABLE multiremi_tasks ADD COLUMN fixture_extra TEXT");
      historicalDb.run("UPDATE multiremi_tasks SET fixture_extra = 'preserve' WHERE id = ?", [task.id]);
      historicalDb.exec("CREATE INDEX fixture_task_priority ON multiremi_tasks(priority, fixture_extra)");
      const schema = historicalDb.query("SELECT sql FROM sqlite_master WHERE name = 'multiremi_tasks'").get() as { sql: string };
      const indexes = historicalDb.query("SELECT sql FROM sqlite_master WHERE tbl_name = 'multiremi_tasks' AND type = 'index' AND sql IS NOT NULL")
        .all() as Array<{ sql: string }>;
      const before = historicalDb.query("SELECT * FROM multiremi_tasks WHERE id = ?").get(task.id);
      historicalDb.exec("PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON");
      historicalDb.exec(schema.sql.replace(/CREATE TABLE\s+["`]?multiremi_tasks["`]?/i, "CREATE TABLE legacy_tasks")
        .replace(/\)\s*$/u, ", FOREIGN KEY(chat_session_id) REFERENCES multiremi_chat_sessions(id) ON DELETE SET NULL)"));
      historicalDb.exec("INSERT INTO legacy_tasks SELECT * FROM multiremi_tasks; DROP TABLE multiremi_tasks; ALTER TABLE legacy_tasks RENAME TO multiremi_tasks");
      for (const index of indexes) historicalDb.exec(index.sql);
      historicalDb.exec("PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON");
      historicalDb.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", [migrationId]);

      bootstrapPreUnifiedSchema(historicalDb);
      expect(historicalDb.query("SELECT * FROM multiremi_tasks WHERE id = ?").get(task.id)).toEqual(before);
      expect(historicalDb.query("SELECT sql FROM sqlite_master WHERE name = 'fixture_task_priority'").get()).toEqual({ sql: indexes.find(
        (index) => index.sql.includes("fixture_task_priority"),
      )!.sql });
      expect(historicalDb.query("PRAGMA foreign_key_list(multiremi_tasks)").all().some((fk: any) => fk.from === "chat_session_id")).toBe(false);

      const current = new MultiremiStore(historicalDb);
      expect(current.deleteChatSession(chat.id)).toBe(true);
      expect(current.getTask(task.id)?.chatSessionId).toBe(chat.id);
      expect(historicalDb.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      historicalDb.close();
    }
  });
});
