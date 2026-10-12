import { expect, it } from "bun:test";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";

pendingTurnBackendTests("shared parent outcome notifications", fixture => {
  it("delivers one notification per child event even with multiple historical human subscribers", () => {
    const { store, db, createIssue } = fixture();
    const operator = store.getWorkspaceOperator("local")!;
    const parent = createIssue({ title: "Unassigned parent", status: "in_progress" });
    const child = createIssue({ title: "Child", parentIssueId: parent.id, status: "in_progress" });
    const members = ["first", "second"].map(name => store.createWorkspaceMember({ name }));
    // Retain historical rows that predate canonical subscription writes.
    for (const member of members) db.run(`INSERT INTO multiremi_issue_subscribers
      (id, issue_id, member_id, user_type, user_id, reason, created_at)
      VALUES (?, ?, ?, 'member', ?, 'manual', ?)`,
    [`subscription_${member.id}`, parent.id, member.id, member.id, new Date().toISOString()]);
    const messages = () => store.listMessages(store.getOrCreateDefaultIssueSession(parent.id).id)
      .filter(message => message.metadata.child_issue_id === child.id && message.metadata.outcome === "blocked");
    const notifications = () => store.listInboxItems(operator.id)
      .filter(item => item.type === "child_issue_terminal" && (item.details as Record<string, unknown> | null)?.outcome === "blocked");

    store.updateIssue(child.id, { status: "blocked" });
    expect(messages()).toHaveLength(1);
    expect(notifications()).toHaveLength(1);
    expect(notifications()[0]).toMatchObject({ id: messages()[0]!.id, memberId: operator.id,
      severity: "warning", details: { outcome: "blocked", noAssignee: true } });
    expect(store.listIssueActivity(parent.id).filter(event => event.type === "child_done_parent_skipped"))
      .toHaveLength(1);
    expect(store.listTasksForIssue(parent.id)).toHaveLength(0);

    store.updateIssue(child.id, { status: "blocked" });
    expect(notifications()).toHaveLength(1);
    store.updateIssue(child.id, { status: "in_progress" });
    store.updateIssue(child.id, { status: "blocked" });
    expect(messages()).toHaveLength(2);
    expect(notifications().map(item => item.id).sort()).toEqual(messages().map(message => message.id).sort());
    expect(store.listIssueActivity(parent.id).filter(event => event.type === "child_done_parent_skipped"))
      .toHaveLength(2);
    for (const member of members) expect(store.listInboxItems(member.id).map(item => item.id))
      .toEqual(store.listInboxItems(operator.id).map(item => item.id));
  });

  it("rolls back the status, parent comment, audit and shared notification together", () => {
    const { store, transaction, createIssue } = fixture();
    const operator = store.getWorkspaceOperator("local")!;
    const parent = createIssue({ title: "Unassigned parent", status: "in_progress" });
    const child = createIssue({ title: "Child", parentIssueId: parent.id, status: "in_progress" });
    store.addIssueSubscriber(parent.id, operator.id, "manual");
    const session = store.getOrCreateDefaultIssueSession(parent.id);
    const beforeMessages = store.listMessages(session.id);
    const beforeActivity = store.listIssueActivity(parent.id);
    const beforeInbox = store.listInboxItems(operator.id);
    expect(() => transaction(() => {
      store.updateIssue(child.id, { status: "blocked" });
      throw new Error("rollback notification");
    })).toThrow("rollback notification");
    expect(store.getIssue(child.id)?.status).toBe("in_progress");
    expect(store.listMessages(session.id)).toEqual(beforeMessages);
    expect(store.listIssueActivity(parent.id)).toEqual(beforeActivity);
    expect(store.listInboxItems(operator.id)).toEqual(beforeInbox);
    store.updateIssue(child.id, { status: "blocked" });
    expect(store.listInboxItems(operator.id).filter(item => item.type === "child_issue_terminal"))
      .toHaveLength(1);
  });

  it("notifies the shared operator without a legacy human contact and never invents an executor", () => {
    const { store } = fixture();
    const operator = store.getWorkspaceOperator("local")!;
    const parent = store.createIssue({ title: "No legacy contact", status: "in_progress" });
    const children = ["First", "Second"].map(title => store.createIssue({ title,
      parentIssueId: parent.id, status: "in_progress" }));
    expect(store.resolveIssueResponsibility(parent.id)).toMatchObject({ rootHuman: null,
      executionOwner: null, reviewOwner: null, rootIssueId: parent.id });
    for (const child of children) store.updateIssue(child.id, { status: "blocked" });
    const items = store.listInboxItems(operator.id).filter(item => item.type === "child_issue_terminal");
    expect(items).toHaveLength(2);
    expect(items.map(item => (item.details as Record<string, unknown> | null)?.childIssueId).sort()).toEqual(children.map(child => child.id).sort());
    const messages = store.listMessages(store.getOrCreateDefaultIssueSession(parent.id).id);
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message).toMatchObject({ to_member_id: operator.id, to_agent_id: null });
      expect(message.metadata.responsibility_unresolved).toContainEqual({ issueId: parent.id,
        reason: "execution_owner_missing" });
    }
    expect(store.listTasksForIssue(parent.id)).toHaveLength(0);
    for (const child of children) expect(store.listTasksForIssue(child.id)).toHaveLength(0);
    expect(store.getIssue(parent.id)?.assigneeId).toBeNull();
    expect(store.listIssueActivity(parent.id).filter(event => event.type === "child_done_parent_skipped"))
      .toHaveLength(2);
  });
});
