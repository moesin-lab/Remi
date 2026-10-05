import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";
afterEach(resetMultiremiTestEnv);

async function fixture() {
  const store = createLocalStore();
  const user = store.getOrCreateUser({ name: "Run creator", email: "recovery-creator@example.test" });
  store.createWorkspaceMember({ workspaceId: "local", userId: user.id, name: user.name, role: "member" });
  const original = store.createAgent({ name: "Original agent", provider: "codex", ownerId: user.id });
  const replacement = store.createAgent({ name: "New assignee", provider: "codex", ownerId: user.id });
  const issue = store.createIssue({ title: "Recover context", assigneeType: "agent", assigneeId: replacement.id, workspaceId: "local" });
  const previous = store.createTask({ agentId: original.id, issueId: issue.id, prompt: "Original detailed instructions", maxAttempts: 1, assignmentAuthorType: "member", assignmentAuthorId: user.id, issueCreationRestricted: true });
  store.cancelTask(previous.id);
  const app = createMultiremiApp({ store, authToken: "recovery-fixture-token" });
  const pat = await store.createAccessToken({ name: "Creator token", type: "pat", workspaceId: "local", userId: user.id });
  const retry = (taskId: unknown, issueId = issue.id) => app.request(`/api/issues/${issueId}/rerun`, { method: "POST", headers: { Authorization: `Bearer ${pat.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ task_id: taskId }) });
  return { store, original, replacement, issue, previous, retry, app, user };
}

describe("specific run recovery", () => {
  it("retains the selected run's agent, Session and prompt and rejects another retry while active", async () => {
    const f = await fixture();
    const response = await f.retry(f.previous.id);
    expect(response.status).toBe(202);
    const result = await response.json();
    const next = f.store.getTask(result.id)!;
    expect(next.agentId).toBe(f.original.id);
    expect(next.prompt).toBe(f.previous.prompt);
    expect(next.issueSessionId).toBe(f.previous.issueSessionId);
    expect(next.issueCreationRestricted).toBe(true);
    expect(next.id).not.toBe(f.previous.id);
    const again = await f.retry(f.previous.id);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "active_run_exists" });
    expect(f.store.listTasksForIssue(f.issue.id)).toHaveLength(2);
  });

  it("rejects a task belonging to another issue", async () => {
    const f = await fixture();
    const other = f.store.createIssue({ title: "Other issue", workspaceId: "local" });
    expect((await f.retry(f.previous.id, other.id)).status).toBe(404);
    expect(f.store.listTasksForIssue(other.id)).toHaveLength(0);
  });

  it("accepts only one of two simultaneous recovery requests", async () => {
    const f = await fixture();
    const results = await Promise.all([f.retry(f.previous.id), f.retry(f.previous.id)]);
    expect(results.map((response) => response.status).sort()).toEqual([202, 409]);
    expect(f.store.listTasksForIssue(f.issue.id).filter((task) => task.status === "queued")).toHaveLength(1);
  });

  it("keeps linked Chat recovery within its creator boundary", async () => {
    const f = await fixture();
    const member = f.store.getOrCreateUser({ name: "Other member", email: "recovery-other-member@example.test" });
    f.store.createWorkspaceMember({ workspaceId: "local", userId: member.id, name: member.name, role: "member" });
    const pat = await f.store.createAccessToken({ name: "Other member", type: "pat", workspaceId: "local", userId: member.id });
    const response = await f.app.request(`/api/issues/${f.issue.id}/rerun`, { method: "POST", headers: { Authorization: `Bearer ${pat.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ task_id: f.previous.id }) });
    expect(response.status).toBe(403);
    expect(f.store.listTasksForIssue(f.issue.id)).toHaveLength(1);
  });

  it("does not retry an active task or an invalid reference", async () => {
    const f = await fixture();
    const active = f.store.createTask({ agentId: f.original.id, issueId: f.issue.id, prompt: "Active" });
    expect((await f.retry(active.id)).status).toBe(409);
    expect((await f.retry(42)).status).toBe(400);
    expect((await f.retry("")).status).toBe(400);
  });

  it("rejects workspace outsiders and conflicting overrides", async () => {
    const f = await fixture();
    const user = f.store.getOrCreateUser({ name: "Other workspace", email: "recovery-outsider@example.test" });
    const other = f.store.createWorkspace({ name: "Other", slug: "recovery-other" }, user.id);
    const pat = await f.store.createAccessToken({ name: "Other workspace token", type: "pat", workspaceId: other.id, userId: user.id });
    const response = await f.app.request(`/api/issues/${f.issue.id}/rerun`, { method: "POST", headers: { Authorization: `Bearer ${pat.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ task_id: f.previous.id }) });
    expect(response.status).toBe(404);
    const conflict = await f.app.request(`/api/issues/${f.issue.id}/rerun`, { method: "POST", headers: { Authorization: "Bearer recovery-fixture-token", "Content-Type": "application/json" }, body: JSON.stringify({ task_id: f.previous.id, prompt: "replace instructions" }) });
    expect(conflict.status).toBe(400);
    expect(f.store.listTasksForIssue(f.issue.id)).toHaveLength(1);
  });

  it("does not interpret a member's specific retry as a force-start past dependencies", async () => {
    const f = await fixture();
    const prerequisite = f.store.createIssue({ title: "Pending prerequisite", workspaceId: "local" });
    f.store.updateIssue(f.issue.id, { status: "backlog" });
    f.store.createIssueDependency(f.issue.id, { dependsOnIssueId: prerequisite.id, type: "blocked_by" });
    expect(f.store.listUnmetPrerequisites(f.issue.id)).toHaveLength(1);
    const pat = await f.store.createAccessToken({ name: "Member token", type: "pat", workspaceId: "local", userId: f.user.id });
    const response = await f.app.request(`/api/issues/${f.issue.id}/rerun`, { method: "POST", headers: { Authorization: `Bearer ${pat.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ task_id: f.previous.id }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "dependencies_unmet" });
    expect(f.store.listTasksForIssue(f.issue.id)).toHaveLength(1);
    expect(f.store.getIssue(f.issue.id)?.status).toBe("backlog");
  });
});
