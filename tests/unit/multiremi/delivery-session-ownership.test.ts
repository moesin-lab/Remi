import { beforeEach, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import type { IssueDelivery } from "@multiremi/contracts";
import type { StoreContext } from "@multiremi/store/context.js";
import { assertIssueDeliveryAccepted, IssueDeliveryError } from "@multiremi/store/issue-deliveries.js";
import { pendingTurnBackendTests, type PendingTurnTestFixture } from "./pending-turn-test-backends.js";
import { mutateExecutionFixture } from "./unified-test-paths.js";

async function createFixture(base: PendingTurnTestFixture) {
  const { store, db } = base;
  const humanUser = store.getOrCreateUser({ email: "delivery-human@example.invalid", name: "Delivery reviewer" });
  const privateUser = store.getOrCreateUser({ email: "delivery-private@example.invalid", name: "Private Chat creator" });
  const human = store.createWorkspaceMember({ userId: humanUser.id, name: humanUser.name, role: "admin" });
  store.createWorkspaceMember({ userId: privateUser.id, name: privateUser.name });
  const nextHuman = store.createWorkspaceMember({ name: "Next explicit reviewer" });
  const owner = store.createAgent({ name: "Parent executor", provider: "claude", visibility: "workspace" });
  const worker = store.createAgent({ name: "Child executor", provider: "claude", visibility: "workspace" });
  const root = store.createIssue({ title: "Owned root", responsibleMemberId: human.id, assigneeType: "agent", assigneeId: owner.id });
  const child = store.createIssue({ title: "Owned child", parentIssueId: root.id, assigneeType: "agent", assigneeId: worker.id });
  const ownerTask = store.createTask({ issueId: root.id, agentId: owner.id, prompt: "Review the child delivery" });
  const workerTask = store.createTask({ issueId: child.id, agentId: worker.id, prompt: "Prepare the child delivery" });

  const privateSource = (agentId: string, issueId: string) => {
    const chat = store.createChatSession({ agentId, creatorId: privateUser.id });
    const session = store.getOrCreateDefaultChatSession(chat.id);
    // A retained Issue projection does not transfer a private Chat Main's ownership.
    db.run("UPDATE multiremi_issue_sessions SET issue_id=? WHERE id=?", [issueId, session.id]);
    const task = store.createSessionTask(session.id, { agentId, prompt: "Private execution discussion" });
    return { chat, session: store.getIssueSession(session.id)!, task };
  };
  const privateChild = privateSource(worker.id, child.id);
  const privateParent = privateSource(owner.id, root.id);
  const ownerActor = { type: "agent" as const, id: owner.id, taskId: ownerTask.id };
  const workerActor = { type: "agent" as const, id: worker.id, taskId: workerTask.id };
  const childDelivery = store.submitIssueDelivery(child.id, { summary: "Public child delivery" }, workerActor);
  const humanAccess = await store.createAccessToken({ userId: humanUser.id, name: "Public delivery reader", type: "pat", workspaceId: "local" });
  const app = createMultiremiApp({ store, authToken: "delivery-owner-test" });

  return { ...base, human, nextHuman, owner, worker, root, child, ownerTask, workerTask,
    privateChild, privateParent, ownerActor, workerActor, childDelivery, app, humanToken: humanAccess.token };
}

function expectDeliveryError(action: () => unknown, code: string): void {
  let error: unknown;
  try { action(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(IssueDeliveryError);
  expect((error as IssueDeliveryError).code).toBe(code);
}

pendingTurnBackendTests("Formal deliveries follow the actual Session owner", fixture => {
  let f: Awaited<ReturnType<typeof createFixture>>;

  beforeEach(async () => {
    f = await createFixture(fixture());
  });

  const request = (path: string, token: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    f.app.request(path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  for (const audit of ["chat", "issue_and_chat"] as const) {
    it(`rejects private Chat submission and parent review with ${audit} audit columns cleared`, async () => {
      const { store, privateChild, privateParent, child } = f;
      for (const source of [privateChild, privateParent]) {
        expect(source.session).toMatchObject({ chatId: source.chat.id, isDefault: true, inheritMode: "none" });
        mutateExecutionFixture(store, `UPDATE multiremi_turn_execution_records SET chat_session_id=NULL${audit === "issue_and_chat" ? ", issue_id=NULL" : ""} WHERE id=?`, [source.task.id]);
      }
      const childAccess = await store.createTaskAccessToken(store.getTask(privateChild.task.id)!, "local");
      const parentAccess = await store.createTaskAccessToken(store.getTask(privateParent.task.id)!, "local");
      const before = { issue: store.getIssue(child.id), messages: store.listMessages(privateChild.session.id),
        activity: store.listIssueActivity(child.id), delivery: store.listIssueDeliveries(child.id) };

      const submission = await request(`/api/issues/${child.id}/deliveries`, childAccess.token, { summary: "PRIVATE_CHAT_FORMAL_SUMMARY" });
      expect(submission.status).toBe(403);
      expect(await submission.json()).toMatchObject({ code: "issue_delivery_side_session_forbidden" });
      const review = await request(`/api/issues/${child.id}/deliveries/${f.childDelivery.id}/respond`, parentAccess.token,
        { action: "accept", revision: f.childDelivery.responsibilityRevision });
      expect(review.status).toBe(403);
      expect(await review.json()).toMatchObject({ code: "issue_delivery_side_session_forbidden" });

      expect({ issue: store.getIssue(child.id), messages: store.listMessages(privateChild.session.id),
        activity: store.listIssueActivity(child.id), delivery: store.listIssueDeliveries(child.id) }).toEqual(before);
      expect(JSON.stringify(store.listIssueComments(child.id))).not.toContain("PRIVATE_CHAT_FORMAL_SUMMARY");
    });
  }

  it("does not let a delivery-specific human grant turn a private Chat into an Issue review Main", async () => {
    const { store, privateParent, root } = f;
    store.updateIssue(f.child.id, { status: "cancelled" });
    const delivery = store.submitIssueDelivery(root.id, { summary: "Root ready for explicit review" }, f.ownerActor);
    store.authorizeIssueDelivery(root.id, delivery.id, f.owner.id, delivery.responsibilityRevision, { type: "member", id: f.human.id });
    mutateExecutionFixture(store, "UPDATE multiremi_turn_execution_records SET issue_id=NULL, chat_session_id=NULL WHERE id=?", [privateParent.task.id]);
    const access = await store.createTaskAccessToken(store.getTask(privateParent.task.id)!, "local");
    const before = { issue: store.getIssue(root.id), delivery: store.listIssueDeliveries(root.id), activity: store.listIssueActivity(root.id) };

    const response = await request(`/api/issues/${root.id}/deliveries/${delivery.id}/respond`, access.token,
      { action: "accept", revision: delivery.responsibilityRevision });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "issue_delivery_side_session_forbidden" });
    expect({ issue: store.getIssue(root.id), delivery: store.listIssueDeliveries(root.id), activity: store.listIssueActivity(root.id) }).toEqual(before);
    expect(store.listIssueDeliveries(root.id)[0]?.authorization?.agentId).toBe(f.owner.id);
  });

  it("keeps private projected delivery rows out of public reads, review, closure and responsibility invalidation", async () => {
    const { store, db, root, privateParent } = f;
    const revision = store.resolveIssueResponsibility(root.id).revision;
    const inject = (status: IssueDelivery["status"]) => {
      const id = `cmt_private_delivery_${status}`;
      const delivery: IssueDelivery = { ...f.childDelivery, id, issueId: root.id, sourceSessionId: privateParent.session.id,
        summary: `PRIVATE_DELIVERY_${status}`, status, responsibilityRevision: revision,
        submittedBy: store.resolveIssueResponsibility(root.id).executionOwner!, reviewOwner: store.resolveIssueResponsibility(root.id).reviewOwner! };
      return store.sendMessage({ id, session_id: privateParent.session.id, sender: { type: "platform", id: null }, to: { type: "none" },
        message_kind: "report", wake_requested: "inbox_only", body_md: delivery.summary, metadata: { issue_delivery: delivery } }).message;
    };
    const pending = inject("pending"), accepted = inject("accepted");
    const privateRows = () => db.query("SELECT id,metadata FROM multiremi_conversation_log WHERE id IN (?,?) ORDER BY id").all(pending.id, accepted.id);
    const before = privateRows();
    expect(store.listIssueDeliveries(root.id)).toEqual([]);
    expect(store.listIssueDeliveries(f.child.id)[0]).toMatchObject({ id: f.childDelivery.id, isLatest: true });
    const listing = await request(`/api/issues/${root.id}/deliveries`, f.humanToken);
    expect(listing.status).toBe(200);
    expect(await listing.json()).toEqual({ deliveries: [], nextCursor: null });

    const cursor = await request(`/api/issues/${root.id}/deliveries?before=${pending.id}`, f.humanToken);
    expect(cursor.status).toBe(409);
    expect(await cursor.json()).toMatchObject({ code: "issue_delivery_cursor_invalid" });
    const response = await request(`/api/issues/${root.id}/deliveries/${pending.id}/respond`, f.humanToken, { action: "accept", revision });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "issue_delivery_not_found" });
    const grant = await request(`/api/issues/${root.id}/deliveries/${pending.id}/authorize`, f.humanToken, { agentId: f.owner.id, revision });
    expect(grant.status).toBe(409);
    expect(await grant.json()).toMatchObject({ code: "issue_delivery_not_pending" });

    const ctx = (store as unknown as { ctx: StoreContext }).ctx;
    expectDeliveryError(() => assertIssueDeliveryAccepted(ctx, root.id, accepted.id), "issue_delivery_acceptance_required");
    expectDeliveryError(() => store.updateIssue(root.id, { status: "done" }, { acceptedDeliveryId: accepted.id }), "issue_delivery_acceptance_required");
    const closure = await request(`/api/issues/${root.id}`, f.humanToken, { status: "done", acceptedDeliveryId: accepted.id }, "PATCH");
    expect(closure.status).toBe(409);
    expect(await closure.json()).toMatchObject({ code: "issue_delivery_acceptance_required" });
    expect(store.getIssue(root.id)?.status).toBe(f.root.status);
    expect(privateRows()).toEqual(before);

    store.updateIssue(root.id, { responsibleMemberId: f.nextHuman.id, actorType: "member", actorId: f.human.id });
    expect(privateRows()).toEqual(before);
    expect(store.listIssueDeliveries(f.child.id)[0]).toMatchObject({ id: f.childDelivery.id, invalidatedAt: expect.any(String) });
    expect(JSON.stringify(store.listIssueActivity(root.id))).not.toContain("PRIVATE_DELIVERY_");
    expect(JSON.stringify(store.listIssueComments(root.id))).not.toContain("PRIVATE_DELIVERY_");
  });

  it("allows submission and parent acceptance from actual Issue Mains with both Task audit columns cleared", async () => {
    const { store, child } = f;
    for (const task of [f.workerTask, f.ownerTask]) {
      mutateExecutionFixture(store, "UPDATE multiremi_turn_execution_records SET issue_id=NULL, chat_session_id=NULL WHERE id=?", [task.id]);
      expect(store.getTask(task.id)).toMatchObject({ issueId: null, chatSessionId: null, issueSessionId: task.issueSessionId });
      expect(store.getIssueSession(task.issueSessionId!)?.chatId).toBeNull();
    }
    const childAccess = await store.createTaskAccessToken(store.getTask(f.workerTask.id)!, "local");
    const parentAccess = await store.createTaskAccessToken(store.getTask(f.ownerTask.id)!, "local");
    const submission = await request(`/api/issues/${child.id}/deliveries`, childAccess.token, { summary: "Actual Issue owner result" });
    expect(submission.status).toBe(201);
    const { delivery } = await submission.json();
    expect(delivery).toMatchObject({ issueId: child.id, sourceSessionId: f.workerTask.issueSessionId, status: "pending", isLatest: true });

    const acceptance = await request(`/api/issues/${child.id}/deliveries/${delivery.id}/respond`, parentAccess.token,
      { action: "accept", revision: delivery.responsibilityRevision });
    expect(acceptance.status).toBe(200);
    const result = await acceptance.json();
    expect(result.delivery).toMatchObject({ id: delivery.id, status: "accepted" });
    expect(result.issue).toMatchObject({ id: child.id, status: "done" });
    expect(store.getMessage(result.delivery.responseMessageId)?.reply_to_id).toBe(delivery.id);
  });

  it("preserves same-workspace old Main delivery history while only the current Main supplies latest authority", () => {
    const { store, db, child } = f;
    const oldMain = store.getIssueSession(f.workerTask.issueSessionId!)!;
    store.sendMessage({ session_id: oldMain.id, sender: { type: "platform", id: null }, to: { type: "none" },
      message_kind: "status", wake_requested: "inbox_only", body_md: "Earlier Main sequence" });
    const oldDelivery = store.submitIssueDelivery(child.id, { summary: "Old Main final report" }, f.workerActor);
    db.run("UPDATE multiremi_issue_sessions SET is_default=0 WHERE id=?", [oldMain.id]);
    const currentMain = store.getOrCreateDefaultIssueSession(child.id);
    const currentTask = store.createSessionTask(currentMain.id, { agentId: f.worker.id, prompt: "Current Main work" });
    const currentDelivery = store.submitIssueDelivery(child.id, { summary: "Current Main final report" },
      { type: "agent", id: f.worker.id, taskId: currentTask.id });
    expect(currentMain.id).not.toBe(oldMain.id);
    expect(store.getIssueSession(oldMain.id)).toMatchObject({ chatId: null, workspaceId: "local", isDefault: false });
    expect(store.getMessage(oldDelivery.id)!.seq).toBeGreaterThan(store.getMessage(currentDelivery.id)!.seq);
    db.run("UPDATE multiremi_conversation_log SET created_at=? WHERE id=?", ["2038-01-01T00:00:00.000Z", oldDelivery.id]);
    db.run("UPDATE multiremi_conversation_log SET created_at=? WHERE id=?", ["2037-01-01T00:00:00.000Z", f.childDelivery.id]);
    db.run("UPDATE multiremi_conversation_log SET created_at=? WHERE id=?", ["2036-01-01T00:00:00.000Z", currentDelivery.id]);

    expect(store.listIssueDeliveries(child.id, { limit: 1 })[0]).toMatchObject({ id: oldDelivery.id, isLatest: false });
    expect(store.listIssueDeliveries(child.id, { limit: 1, before: oldDelivery.id })[0]).toMatchObject({ id: f.childDelivery.id, isLatest: false });
    expect(store.listIssueDeliveries(child.id, { limit: 1, before: f.childDelivery.id })[0]).toMatchObject({ id: currentDelivery.id, isLatest: true });
    expectDeliveryError(() => store.respondIssueDelivery(child.id, oldDelivery.id,
      { action: "accept", revision: oldDelivery.responsibilityRevision }, f.ownerActor), "issue_delivery_superseded");
    expectDeliveryError(() => store.submitIssueDelivery(child.id, { summary: "Old Main cannot submit again" }, f.workerActor), "issue_delivery_side_session_forbidden");
    expect(store.respondIssueDelivery(child.id, currentDelivery.id,
      { action: "accept", revision: currentDelivery.responsibilityRevision }, f.ownerActor).status).toBe("accepted");
    expect(store.listIssueDeliveries(child.id).map(delivery => delivery.id)).toEqual([oldDelivery.id, f.childDelivery.id, currentDelivery.id]);
    expect(store.listIssueDeliveries(child.id)[0]).toMatchObject({ status: "pending", isLatest: false });
  });
});
