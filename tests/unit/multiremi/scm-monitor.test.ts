import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore, createResponsibleTestIssue, db, resetMultiremiTestEnv } from "./helpers.js";

const originalFetch = globalThis.fetch;
const originalKey = process.env.MULTIREMI_SCM_ENCRYPTION_KEY;
const head = "a".repeat(40);
const nextHead = "c".repeat(40);
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.MULTIREMI_SCM_ENCRYPTION_KEY;
  else process.env.MULTIREMI_SCM_ENCRYPTION_KEY = originalKey;
  resetMultiremiTestEnv();
});
function setup() {
  process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64");
  const store = createLocalStore();
  store.updateWorkspace("local", { repos: [{ id: "repo_test", name: "widgets", url: "https://github.com/acme/widgets.git", source: "github" }] });
  const connection = store.createScmConnection({ name: "GitHub", provider: "github", mode: "poll", accessToken: "mock-provider-token" });
  const agent = store.createAgent({ name: "Owner", provider: "codex" });
  const issue = createResponsibleTestIssue(store, { title: "Monitor target", assigneeType: "agent", assigneeId: agent.id });
  const session = store.getOrCreateDefaultIssueSession(issue.id);
  let revision = 0;
  function project(sha = head, state = "open") {
    revision++;
    store.advanceScmEntitySnapshot({ connectionId: connection.id, repositoryId: "repo_test", entityType: "change_request", externalId: "9001",
      revisionAt: new Date(Date.now() + revision * 1000).toISOString(), revision: String(revision), contentHash: String(revision),
      payload: { id: "9001", number: 42, title: "PR", state, head_sha: sha, base_sha: "b".repeat(40), url: "https://github.com/acme/widgets/pull/42" } });
  }
  project();
  const cr = db!.query("SELECT id FROM multiremi_scm_change_requests WHERE number = 42").get() as { id: string };
  store.linkScmChangeRequestToIssue(issue.id, cr.id);
  let sequence = 0;
  function event(sha = head, type: "pipeline.completed" | "change.updated" | "review.submitted" | "review.dismissed" | "change.closed" = "pipeline.completed", extra: Record<string, unknown> = {}) {
    sequence++;
    return store.recordScmCanonicalEvent({ workspaceId: "local", connectionId: connection.id, repositoryId: "repo_test", type,
      subjectType: type.startsWith("review") ? "review" : type.startsWith("change") ? "change_request" : "pipeline",
      subjectId: type.startsWith("change") ? "9001" : String(sequence), logicalKey: `monitor-test:${sequence}`,
      fidelity: "exact", payload: { head_sha: sha, change_id: "9001", change_number: 42, ...extra }, evidence: { source: "webhook", dedupeKey: `monitor-test:${sequence}` } }).event;
  }
  const observed = { sha: head, checks: [{ id: 1, name: "unit", head_sha: head, status: "completed", conclusion: "success" }] as Record<string, unknown>[], workflows: [] as Record<string, unknown>[], jobs: [] as Record<string, unknown>[], limited: false, moveDuringRead: false, pullReads: 0 };
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (observed.limited) return Response.json({ message: "private provider details" }, { status: 429, headers: { "retry-after": "120" } });
    if (url.includes("/jobs?")) return Response.json({ jobs: observed.jobs });
    if (url.includes("/check-runs")) return Response.json({ check_runs: observed.checks.map(c => ({ ...c, head_sha: observed.sha })) });
    if (url.includes("/statuses")) return Response.json([]);
    if (url.includes("/actions/runs")) return Response.json({ workflow_runs: observed.workflows.map(c => ({ ...c, head_sha: observed.sha })) });
    observed.pullReads++;
    return Response.json({ id: 9001, number: 42, title: "PR", state: "open", head: { sha: observed.moveDuringRead && observed.pullReads % 2 === 0 ? nextHead : observed.sha, ref: "feature" }, base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "acme/widgets" } } });
  }, { preconnect: originalFetch.preconnect }) as typeof fetch;
  function messages(sessionId = session.id) {
    return (db!.query("SELECT * FROM multiremi_conversation_log WHERE session_id = ? AND sender_type = 'platform' AND dedupe_key LIKE 'checks:%'").all(sessionId) as Record<string, any>[]);
  }
  async function dispatch(now = new Date(Date.now() + 10_000)) { store.dispatchPendingScmEvents(now); await store.processScmMonitorEffects(now); }
  return { store, connection, issue, session, cr, observed, project, event, messages, dispatch, agent };
}

describe("SCM monitor outbox (real SQLite/Inbox, mock GitHub)", () => {
  it("waits for every workflow, emits one status on the head, and wakes an in_review owner", async () => {
    const f = setup();
    // Remove only the assignment's execution so this assertion proves the monitor opened a new turn.
    for (const task of f.store.listTasks().filter(t => t.issueId === f.issue.id)) {
      if (["queued", "running"].includes(task.status)) f.store.cancelTask(task.id);
    }
    db!.run("UPDATE multiremi_issues SET status = 'in_review' WHERE id = ?", [f.issue.id]);
    f.observed.workflows = [{ id: 9, name: "integration", status: "in_progress", conclusion: null }];
    f.event(); await f.dispatch(); expect(f.messages()).toHaveLength(0);
    f.observed.workflows[0]!.status = "completed"; f.observed.workflows[0]!.conclusion = "success";
    f.event(); f.event(); await f.dispatch();
    expect(f.messages()).toHaveLength(1);
    expect(f.messages()[0]).toMatchObject({ message_kind: "status", wake_requested: "now", wake_applied: "now", to_agent_id: f.agent.id });
    expect(db!.query("SELECT id FROM multiremi_turns WHERE issue_id = ? AND status = 'pending'").get(f.issue.id)).not.toBeNull();
  });

  it("does not emit a failure while another job is pending and separates cancelled/skipped from failed checks", async () => {
    const f = setup();
    f.observed.checks = [{ id: 1, name: "bad", status: "completed", conclusion: "failure" }, { id: 2, name: "waiting", status: "queued", conclusion: null }];
    f.event(); await f.dispatch(); expect(f.messages()).toHaveLength(0);
    f.observed.checks[1] = { id: 2, name: "cancelled", status: "completed", conclusion: "cancelled" };
    f.event(); await f.dispatch();
    const body = JSON.parse(f.messages()[0]!.body_md.split("```json\n")[1].split("\n```")[0]);
    expect(body.failed_checks.map((c: any) => c.name)).toEqual(["bad"]);
    expect(body.unexecuted_checks.map((c: any) => c.name)).toEqual(["cancelled"]);
  });

  it("invalidates a concluded head even when the new head is pending", async () => {
    const f = setup(); f.event(); await f.dispatch();
    f.project(nextHead); f.observed.sha = nextHead; f.observed.checks[0]!.status = "queued"; f.observed.checks[0]!.conclusion = null;
    f.event(nextHead, "change.updated"); await f.dispatch();
    const changed = db!.query("SELECT body_md FROM multiremi_conversation_log WHERE dedupe_key LIKE 'head_changed:%'").all();
    expect(changed).toHaveLength(1); expect(JSON.stringify(changed)).toContain(head);
    expect(f.messages()).toHaveLength(1);
    f.event(nextHead, "change.updated"); await f.dispatch();
    expect(db!.query("SELECT id FROM multiremi_conversation_log WHERE dedupe_key LIKE 'head_changed:%'").all()).toHaveLength(1);
  });

  it.each([false, true])("runs a single delayed capacity check, runner assigned = %s", async assigned => {
    const f = setup(); f.observed.checks = [];
    f.observed.workflows = [{ id: 9, name: "workflow", status: "queued", conclusion: null }];
    f.observed.jobs = [{ id: 21, name: "linux", status: "queued", runner_id: assigned ? 88 : 0, runner_name: assigned ? "runner" : "", html_url: "https://github.com/acme/widgets/actions/runs/9/job/21" }];
    f.event(); f.event(); await f.dispatch();
    expect(db!.query("SELECT id FROM multiremi_scm_effects WHERE effect_type = 'monitor_capacity'").all()).toHaveLength(1);
    expect(db!.query("SELECT id FROM multiremi_conversation_log WHERE dedupe_key LIKE 'capacity:%'").all()).toHaveLength(0);
    await f.store.processScmMonitorEffects(new Date(Date.now() + 46 * 60_000));
    expect(db!.query("SELECT body_md FROM multiremi_conversation_log WHERE dedupe_key LIKE 'capacity:%'").all()).toHaveLength(assigned ? 0 : 1);
    expect(db!.query("SELECT status FROM multiremi_scm_effects WHERE effect_type = 'monitor_capacity'").get()).toEqual({ status: "applied" });
  });

  it("ignores the old head's delayed capacity check", async () => {
    const f = setup(); f.observed.checks[0]!.status = "queued"; f.observed.checks[0]!.conclusion = null;
    f.event(); await f.dispatch(); f.project(nextHead); f.observed.sha = nextHead;
    await f.store.processScmMonitorEffects(new Date(Date.now() + 46 * 60_000));
    expect(db!.query("SELECT id FROM multiremi_conversation_log WHERE dedupe_key LIKE 'capacity:%'").all()).toHaveLength(0);
  });

  it("invalidates the old conclusion even while provider reads are rate limited", async () => {
    const f = setup(); f.event(); await f.dispatch();
    f.project(nextHead); f.observed.sha = nextHead; f.observed.limited = true;
    f.event(nextHead, "change.updated"); await f.dispatch();
    expect(db!.query("SELECT id FROM multiremi_conversation_log WHERE dedupe_key LIKE 'head_changed:%'").all()).toHaveLength(1);
    expect(db!.query("SELECT concluded_head FROM multiremi_scm_monitor_heads").get()).toEqual({ concluded_head: null });
  });

  it("retains rate-limited effects until provider retry-after and delivers after recovery", async () => {
    const f = setup(); f.observed.limited = true; f.event(); const now = new Date(Date.now() + 10_000); await f.dispatch(now);
    const effect = db!.query("SELECT * FROM multiremi_scm_effects WHERE effect_type = 'monitor_checks'").get() as any;
    expect(effect.status).toBe("pending"); expect(Date.parse(effect.available_at)).toBe(now.getTime() + 120_000);
    expect(effect.last_error).not.toContain("private"); expect(f.messages()).toHaveLength(0);
    f.observed.limited = false; await f.store.processScmMonitorEffects(new Date(now.getTime() + 120_000)); expect(f.messages()).toHaveLength(1);
  });

  it("retries a changing live head and reclaims an expired effect lease", async () => {
    const f = setup(); f.observed.moveDuringRead = true; f.event(); await f.dispatch();
    expect(f.messages()).toHaveLength(0);
    expect(db!.query("SELECT status FROM multiremi_scm_effects WHERE effect_type = 'monitor_checks'").get()).toEqual({ status: "pending" });
    f.observed.moveDuringRead = false;
    db!.run("UPDATE multiremi_scm_effects SET status = 'processing', lease_token = 'old-worker', lease_until = ?", [new Date(Date.now() - 1000).toISOString()]);
    await f.store.processScmMonitorEffects(new Date(Date.now() + 60_000)); expect(f.messages()).toHaveLength(1);
  });

  it("adds watch delivery, expires settled/closed watches, and forwards review commit", async () => {
    const f = setup(); const extra = f.store.createIssueSession(f.issue.id, { title: "Watch" });
    f.store.setScmWatch("local", "repo_test", 42, extra.id, "settled", true);
    f.event(head, "review.submitted", { commit_sha: "reviewed-commit", state: "approved" }); await f.dispatch();
    expect(db!.query("SELECT body_md FROM multiremi_conversation_log WHERE session_id = ? AND dedupe_key LIKE 'review:%'").all(extra.id)).toHaveLength(1);
    f.event(); await f.dispatch(); expect(f.messages(extra.id)).toHaveLength(1);
    expect(f.store.listScmWatches("local", "repo_test", 42)).toHaveLength(0);
    f.store.setScmWatch("local", "repo_test", 42, extra.id, "merged", true);
    f.project(head, "closed"); f.event(head, "change.closed"); await f.dispatch();
    expect(f.store.listScmWatches("local", "repo_test", 42)).toHaveLength(0);
    expect(() => f.store.setScmWatch("local", "repo_test", 42, extra.id, "closed", true)).toThrow("closed");
  });

  it("delivers a watch without an Issue link, unwatch removes it, and rejects cross-workspace sessions", async () => {
    const f = setup(); f.store.unlinkScmChangeRequestFromIssue(f.issue.id, f.cr.id);
    f.store.setScmWatch("local", "repo_test", 42, f.session.id, "closed", true);
    f.event(); await f.dispatch(); expect(f.messages()).toHaveLength(1);
    f.store.setScmWatch("local", "repo_test", 42, f.session.id, "closed", false);
    expect(f.store.listScmWatches("local", "repo_test", 42)).toHaveLength(0);
    expect(() => f.store.setScmWatch("other", "repo_test", 42, f.session.id, "closed", true)).toThrow();
  });

  it("exposes stream health, alerts once per outage, then alerts for a later stale success watermark", async () => {
    const f = setup(); const now = new Date(Date.now() + 6 * 60_000);
    const before = db!.query("SELECT COUNT(*) AS n FROM multiremi_conversation_log WHERE body_md LIKE '%scm_monitor.health.v1%'").get() as any;
    await f.store.processScmMonitorEffects(now);
    const count = () => (db!.query("SELECT COUNT(*) AS n FROM multiremi_conversation_log WHERE body_md LIKE '%scm_monitor.health.v1%'").get() as any).n;
    expect(count()).toBeGreaterThan(before.n); const alerted = count();
    await f.store.processScmMonitorEffects(now); expect(count()).toBe(alerted);
    f.store.upsertScmSyncCursor({ connectionId: f.connection.id, repositoryId: "repo_test", stream: "pipelines", lastCompletedAt: now.toISOString() });
    expect(f.store.scmMonitorStatus("local").find(s => s.stream === "pipelines")).toMatchObject({ lastSuccessfulPollAt: now.toISOString(), stale: false });
    await f.store.processScmMonitorEffects(new Date(now.getTime() + 6 * 60_000)); expect(count()).toBeGreaterThan(alerted);
  });

  it("fences a late worker after another worker reclaims and commits the effect", async () => {
    const f = setup(); f.event(); const now = new Date(Date.now() + 10_000); f.store.dispatchPendingScmEvents(now);
    const provider = globalThis.fetch;
    let unblock!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    let first = true;
    globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
      if (first) { first = false; started(); await gate; }
      return provider(...args);
    }, { preconnect: originalFetch.preconnect }) as typeof fetch;
    const oldWorker = f.store.processScmMonitorEffects(now, 1);
    await entered;
    await f.store.processScmMonitorEffects(new Date(now.getTime() + 121_000), 1);
    expect(f.messages()).toHaveLength(1);
    unblock(); await oldWorker;
    expect(f.messages()).toHaveLength(1);
    expect(db!.query("SELECT status, lease_token FROM multiremi_scm_effects WHERE effect_type = 'monitor_checks'").get()).toEqual({ status: "applied", lease_token: null });
  });

  it("lets later rules register effects with a fenced transactional commit", async () => {
    const f = setup();
    f.store.registerScmMonitorRule({ effectType: "monitor_extension", matches: event => event.type === "review.dismissed",
      prepare: async () => () => { db!.run("UPDATE multiremi_issues SET title = ? WHERE id = ?", ["Extension committed", f.issue.id]); } });
    f.event(head, "review.dismissed", { commit_sha: head }); await f.dispatch();
    expect(f.store.getIssue(f.issue.id)?.title).toBe("Extension committed");
    expect(db!.query("SELECT status FROM multiremi_scm_effects WHERE effect_type = 'monitor_extension'").get()).toEqual({ status: "applied" });
  });

  it("uses the project timeout for the first pending effect", async () => {
    const f = setup(); const project = f.store.createProject({ title: "Monitor config" });
    f.store.updateIssue(f.issue.id, { projectId: project.id });
    expect(f.store.scmMonitorProjectConfig(project.id)).toEqual({ pendingTimeoutSeconds: 2700 });
    f.store.scmMonitorProjectConfig(project.id, 60);
    expect(() => f.store.scmMonitorProjectConfig(project.id, 1)).toThrow();
    f.observed.checks[0]!.status = "queued"; f.observed.checks[0]!.conclusion = null;
    const now = new Date(Date.now() + 10_000); f.event(); await f.dispatch(now);
    expect((db!.query("SELECT available_at FROM multiremi_scm_effects WHERE effect_type = 'monitor_capacity'").get() as any).available_at).toBe(new Date(now.getTime() + 60_000).toISOString());
  });

  it("offers authenticated watch and health HTTP APIs", async () => {
    const f = setup(); const app = createMultiremiApp({ store: f.store, authToken: "test-secret" });
    const path = "/api/workspaces/local/scm/repositories/acme%2Fwidgets/change-requests/42/watch";
    const headers = { Authorization: "Bearer test-secret", "Content-Type": "application/json" };
    expect((await app.request(path)).status).toBe(401);
    expect((await app.request(path, { method: "PUT", headers, body: JSON.stringify({ sessionId: f.session.id }) })).status).toBe(200);
    expect((await (await app.request(path, { headers })).json()).watches).toHaveLength(1);
    expect((await app.request(path + `?session=${f.session.id}`, { method: "DELETE", headers })).status).toBe(200);
    const status = await app.request("/api/workspaces/local/scm/monitor/status", { headers });
    expect(status.status).toBe(200); expect((await status.json()).streams).toHaveLength(5);
  });
});
