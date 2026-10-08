import { expect, it } from "bun:test";
import { runMigrations } from "@multiremi/store/migrations.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";

const migrationId = "20261008_dual_owned_sessions";

pendingTurnBackendTests("Session owner migration contract", (fixture, backend) => {
  it("serializes different Agents sharing a Chat checkout without blocking other owners", () => {
    const { db, store } = fixture();
    const runtime = store.registerRuntime({ name: "Shared checkout", provider: "claude", maxConcurrency: 10 });
    const agents = [1, 2, 3, 4].map(index => store.createAgent({
      name: `Checkout agent ${index}`, provider: "claude", runtimeId: runtime.id,
    }));
    const chat = store.createChatSession({ agentId: agents[0]!.id });
    const sessionA = store.listChatOwnedSessions(chat.id)[0]!;
    const sessionB = store.createSession(chat.id, { title: "Other work" });
    const ordinary = store.sendChatMessage(chat.id, { body: "Ordinary Chat work" }).task;
    db.run("UPDATE multiremi_tasks SET priority = 100 WHERE id = ?", [ordinary.id]);
    const workA = store.createSessionTask(sessionA.id, { agentId: agents[1]!.id, prompt: "Session A", priority: 20 });
    const workB = store.createSessionTask(sessionB.id, { agentId: agents[2]!.id, prompt: "Session B", priority: 10 });
    const otherChat = store.createChatSession({ agentId: agents[3]!.id });
    const independent = store.sendChatMessage(otherChat.id, { body: "Another checkout" }).task;

    expect(store.claimTask(runtime.id)?.id).toBe(ordinary.id);
    store.startTask(ordinary.id);
    expect(store.claimTask(runtime.id)?.id).toBe(independent.id);
    store.cancelTask(independent.id);
    const issue = store.createIssue({ title: "Independent Issue checkout" });
    const issueTask = store.createSessionTask(store.getOrCreateDefaultIssueSession(issue.id).id, {
      agentId: agents[3]!.id, prompt: "Issue work",
    });
    expect(store.claimTask(runtime.id)?.id).toBe(issueTask.id);
    store.cancelTask(issueTask.id);
    expect(store.claimTask(runtime.id)).toBeNull();
    store.completeTask(ordinary.id, { output: "Ordinary work finished" });

    expect(store.claimTask(runtime.id)?.id).toBe(workA.id);
    store.startTask(workA.id);
    expect(store.claimTask(runtime.id)).toBeNull();
    store.completeTask(workA.id, { output: "Session A finished" });
    expect(store.claimTask(runtime.id)?.id).toBe(workB.id);
  });

  it("preserves both owners, results and Task audit through an upgrade and restart", () => {
    const { db, store } = fixture();
    const issue = store.createIssue({ title: "Issue owner" });
    const agent = store.createAgent({ name: "Owner agent", provider: "claude" });
    const chat = store.createChatSession({ agentId: agent.id });
    const issueMain = store.getOrCreateDefaultIssueSession(issue.id);
    const chatMain = store.listChatOwnedSessions(chat.id)[0]!;
    const result = store.publishSessionResult(issueMain.id, { title: "Output", body: "Keep this output" });
    const task = store.createSessionTask(chatMain.id, { agentId: agent.id, prompt: "Chat work" });
    const owners = db.query("SELECT id, chat_id, issue_id, workspace_id FROM multiremi_issue_sessions ORDER BY id").all();

    db.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", [migrationId]);
    runMigrations(db);
    runMigrations(db);

    expect(db.query("SELECT id, chat_id, issue_id, workspace_id FROM multiremi_issue_sessions ORDER BY id").all()).toEqual(owners);
    expect(store.getIssueSession(issueMain.id)).toMatchObject({ ownerType: "issue", ownerId: issue.id, chatId: null });
    expect(store.getIssueSession(chatMain.id)).toMatchObject({ ownerType: "chat", ownerId: chat.id });
    expect(store.listSessionResults(issueMain.id)).toContainEqual(result);
    expect(store.getTask(task.id)?.chatSessionId).toBe(chat.id);
    expect(db.query("SELECT id FROM multiremi_schema_migrations WHERE id = ?").get(migrationId)).toBeTruthy();

    store.cancelTask(task.id);
    expect(store.deleteChatSession(chat.id)).toBe(true);
    expect(store.getTask(task.id)?.chatSessionId).toBe(chat.id);
    expect(store.getIssueSession(issueMain.id)?.ownerId).toBe(issue.id);
  });

  it("repairs old Issue moves without transferring a Chat owner or rewriting Task audit", () => {
    const { db, store } = fixture();
    const issue = store.createIssue({ title: "Old moved issue" });
    const target = store.createWorkspace({ name: "Target workspace" });
    const agent = store.createAgent({ name: "Owner agent", provider: "claude" });
    const chat = store.createChatSession({ agentId: agent.id });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const projected = store.createIssueSession(issue.id, { chatId: chat.id, title: "Private projection" });
    const result = store.publishSessionResult(projected.id, { title: "Private", body: "Private output" });
    const task = store.createSessionTask(main.id, { agentId: agent.id, prompt: "Historic work" });
    store.cancelTask(task.id);

    // The old move contract changed the Issue row but left its Session workspace behind.
    db.run("UPDATE multiremi_issues SET workspace_id = ? WHERE id = ?", [target.id, issue.id]);
    db.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", [migrationId]);
    runMigrations(db);

    expect(store.getIssueSession(main.id)).toMatchObject({ ownerType: "issue", ownerId: issue.id, workspaceId: target.id });
    expect(store.getIssueSession(projected.id)).toMatchObject({ ownerType: "chat", ownerId: chat.id, workspaceId: "local", issueId: null });
    expect(store.listSessionResults(projected.id)).toContainEqual({ ...result, issueId: null, issue_id: null });
    expect(store.getTask(task.id)).toMatchObject({ workspaceId: "local", issueId: issue.id });
  });

  it("rolls back deterministic move repairs when a legacy parent has another owner", () => {
    const { db, store } = fixture();
    const issue = store.createIssue({ title: "Moved owner" });
    const other = store.createIssue({ title: "Other owner" });
    const target = store.createWorkspace({ name: "Move target" });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const child = store.createIssueSession(issue.id, { title: "Child", parentSessionId: main.id });
    const agent = store.createAgent({ name: "Owner agent", provider: "claude" });
    const chat = store.createChatSession({ agentId: agent.id });
    const projected = store.createIssueSession(issue.id, { chatId: chat.id, title: "Private projection" });
    const result = store.publishSessionResult(projected.id, { title: "Private", body: "Retain on rollback" });
    db.run("UPDATE multiremi_issues SET workspace_id = ? WHERE id = ?", [target.id, issue.id]);
    db.run("UPDATE multiremi_issue_sessions SET issue_id = ? WHERE id = ?", [other.id, child.id]);
    db.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", [migrationId]);
    const before = db.query("SELECT id, chat_id, issue_id, workspace_id FROM multiremi_issue_sessions ORDER BY id").all();

    expect(() => runMigrations(db)).toThrow("parent has a different owner");
    expect(db.query("SELECT id, chat_id, issue_id, workspace_id FROM multiremi_issue_sessions ORDER BY id").all()).toEqual(before);
    expect(store.listSessionResults(projected.id)).toContainEqual(result);
    expect(db.query("SELECT id FROM multiremi_schema_migrations WHERE id = ?").get(migrationId)).toBeNull();
  });

  it("rejects an ownerless legacy row without deleting it or writing a migration marker", () => {
    const { db, store } = fixture();
    const issue = store.createIssue({ title: "Valid owner" });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    if (backend === "PostgreSQL") {
      db.exec("ALTER TABLE multiremi_issue_sessions DROP CONSTRAINT multiremi_issue_sessions_owner_check");
    } else {
      db.exec("PRAGMA ignore_check_constraints = ON");
    }
    const now = new Date().toISOString();
    db.run(`INSERT INTO multiremi_issue_sessions
      (id, chat_id, issue_id, workspace_id, title, created_at, updated_at)
      VALUES (?, NULL, NULL, 'local', 'Unknown owner', ?, ?)`, ["ises_unknown_owner", now, now]);
    if (backend === "SQLite") db.exec("PRAGMA ignore_check_constraints = OFF");
    db.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", [migrationId]);
    const before = db.query("SELECT id, chat_id, issue_id, workspace_id FROM multiremi_issue_sessions ORDER BY id").all();

    expect(() => runMigrations(db)).toThrow("missing owner");
    expect(db.query("SELECT id, chat_id, issue_id, workspace_id FROM multiremi_issue_sessions ORDER BY id").all()).toEqual(before);
    expect(store.getIssueSession(main.id)?.ownerId).toBe(issue.id);
    expect(db.query("SELECT id FROM multiremi_schema_migrations WHERE id = ?").get(migrationId)).toBeNull();
  });
});
