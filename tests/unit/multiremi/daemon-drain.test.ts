import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { parseDaemonDrainDuration } from "@multiremi/contracts/daemon-drain.js";
import { taskInputSnapshot } from "@multiremi/api/daemon-protocol/task-input-snapshot.js";
import { runtimeInputSnapshot } from "@multiremi/api/daemon-protocol/runtime-input-snapshot.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

const start = new Date("2026-11-17T02:00:00Z");
afterEach(() => { setSystemTime(); resetMultiremiTestEnv(); });
function fixture() {
  const store = createLocalStore();
  setSystemTime(start);
  for (const [id, daemonId, provider] of [["rt_a", "machine-a", "codex"], ["rt_a_other", "machine-a", "claude"], ["rt_b", "machine-b", "codex"]] as const) {
    store.registerRuntime({ id, daemonId, provider, name: id, workspaceId: "local", maxConcurrency: 4 });
  }
  const agent = store.createAgent({ name: "drain test", provider: "codex" });
  return { store, agent };
}
function advance(ms: number) { setSystemTime(new Date(start.getTime() + ms)); }
function ack(store: MultiremiStore, count: number) {
  for (const id of ["rt_a", "rt_a_other"]) {
    store.heartbeatRuntime(id, { claimPending: false });
    store.recordRuntimeDrainAck(id, 0, count);
  }
}

describe("daemon drain", () => {
  it("fences all providers on one machine, routes to another, and resumes after undrain", () => {
    const { store, agent } = fixture();
    const task = store.createTask({ agentId: agent.id, prompt: "queued" });
    expect(store.beginDaemonDrain("local", "machine-a")).toMatchObject({ status: "drained", reason: "manual", deadline: "2026-11-17T02:05:00.000Z" });
    expect(store.claimTask("rt_a")).toBeNull();
    expect(store.hasCliUpdateDrainForRuntime("rt_a_other")).toBe(true);
    expect(store.claimTask("rt_b")?.id).toBe(task.id);
    store.completeTask(task.id, { output: "done" });
    store.undrainDaemon("local", "machine-a");
    const next = store.createTask({ agentId: agent.id, prompt: "resumed" });
    expect(store.claimTask("rt_a")?.id).toBe(next.id);
  });

  it("keeps the original deadline and reports natural completion", () => {
    const { store, agent } = fixture();
    const task = store.createTask({ agentId: agent.id, prompt: "running" });
    store.claimTask("rt_a"); store.startTask(task.id);
    const first = store.beginDaemonDrain("local", "machine-a", "deploy", 10_000);
    advance(5_000);
    expect(store.beginDaemonDrain("local", "machine-a", "manual", 60_000).deadline).toBe(first.deadline);
    expect(store.getDaemonDrainStatus("local", "machine-a").remaining_tasks).toBe(1);
    store.completeTask(task.id, { output: "done" });
    expect(store.getDaemonDrainStatus("local", "machine-a")).toMatchObject({ status: "drained", forced_at: null, reason: "deploy" });
    expect(store.hasCliUpdateDrainForRuntime("rt_a")).toBe(true);
  });

  it("expires through runtime_recovery exactly once and waits for local cancellation acknowledgement", () => {
    const { store, agent } = fixture();
    const issue = store.createIssue({ title: "long running", assigneeType: "agent", assigneeId: agent.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "long running" });
    store.claimTask("rt_a"); store.startTask(task.id);
    ack(store, 1);
    store.beginDaemonDrain("local", "machine-a", "manual", 1_000);
    advance(999); store.reconcileDaemonDrain("rt_a");
    expect(store.getTask(task.id)?.status).toBe("running");
    advance(1_000); store.reconcileDaemonDrain("rt_a");
    expect(store.getTask(task.id)).toMatchObject({ status: "failed", failureReason: "runtime_recovery" });
    expect(db!.query("SELECT status FROM multiremi_turn_attempts WHERE id = ?").get(task.id)).toEqual({ status: "lost" });
    // Public task projection already maps lost -> failed, including the normal cancellation push.
    const cancel = taskInputSnapshot(store, "rt_a", "machine-a", new Set([task.id]), () => {}).find(input => input.type === "task.cancelled");
    expect(cancel?.payload).toMatchObject({ task_id: task.id, status: "failed" });
    expect(store.getDaemonDrainStatus("local", "machine-a")).toMatchObject({ status: "draining", awaiting_daemon_ack: true });
    store.reconcileDaemonDrain("rt_a_other");
    const attempts = db!.query("SELECT id FROM multiremi_turn_attempts WHERE turn_id = (SELECT turn_id FROM multiremi_turn_attempts WHERE id = ?)").all(task.id);
    expect(attempts).toHaveLength(2);
    advance(1_001); ack(store, 0);
    expect(store.getDaemonDrainStatus("local", "machine-a")).toMatchObject({ status: "drained_forced", remaining_tasks: 0, awaiting_daemon_ack: false });
    expect(store.claimTask("rt_a")).toBeNull();
    expect(store.listTasks().find(next => next.parentTaskId === task.id)?.status).toBe("queued");
    store.undrainDaemon("local", "machine-a");
    expect(store.claimTask("rt_a")?.parentTaskId).toBe(task.id);
  });

  it("lets a long CLI update continue after expiry and local zero, then releases only its own fence", () => {
    const { store, agent } = fixture();
    const issue = store.createIssue({ title: "long running", assigneeType: "agent", assigneeId: agent.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "long running" });
    store.claimTask("rt_a"); store.startTask(task.id);
    ack(store, 1);
    const update = store.createRuntimeUpdateRequest("rt_a", { scope: "cli", targetVersion: "0.2.96" });
    expect(store.claimRuntimeUpdateRequest("rt_a")).toBeNull();
    expect(() => store.undrainDaemon("local", "machine-a")).toThrow("CLI update is still active");
    for (let elapsed = 60_000; elapsed < 300_000; elapsed += 60_000) { advance(elapsed); ack(store, 1); }
    advance(300_000); store.reconcileDaemonDrain("rt_a");
    expect(store.claimRuntimeUpdateRequest("rt_a")).toBeNull();
    advance(300_001); ack(store, 0);
    expect(store.claimRuntimeUpdateRequest("rt_a")?.id).toBe(update.id);
    store.reportRuntimeUpdateResult("rt_a", update.id, { status: "completed" });
    expect(store.hasCliUpdateDrainForRuntime("rt_a_other")).toBe(false);
    store.beginDaemonDrain("local", "machine-a", "deploy");
    const second = store.createRuntimeUpdateRequest("rt_a", { scope: "cli", targetVersion: "0.2.97" });
    store.reportRuntimeUpdateResult("rt_a", second.id, { status: "failed", error: "install failed" });
    expect(store.getDaemonDrainStatus("local", "machine-a")).toMatchObject({ mode: "draining", reason: "deploy" });
  });

  it("pushes per-daemon draining while preserving independent platform maintenance", () => {
    const { store } = fixture();
    store.beginDaemonDrain("local", "machine-a");
    expect(runtimeInputSnapshot(store, "rt_a").find(input => input.type === "platform.drain")?.payload.mode).toBe("draining");
    expect(runtimeInputSnapshot(store, "rt_b").find(input => input.type === "platform.drain")?.payload.mode).toBe("normal");
    store.beginPlatformDrain({ operationId: "maintenance", ttlMs: 60_000 });
    store.undrainDaemon("local", "machine-a");
    expect(store.daemonDrainDirective("rt_a").mode).toBe("draining");
  });

  it("persists deadlines over a real SQLite close/reopen", () => {
    const root = mkdtempSync(join(tmpdir(), "mul68-persistence-"));
    const path = join(root, "db.sqlite");
    let handle = openSqliteDatabase(path);
    try {
      let store = new MultiremiStore(handle); store.ensureLocalWorkspace();
      store.registerRuntime({ id: "persisted", name: "persisted", provider: "codex", daemonId: "machine" });
      const original = store.beginDaemonDrain("local", "machine", "deploy", 12_345);
      handle.close(); handle = openSqliteDatabase(path); store = new MultiremiStore(handle);
      expect(store.getDaemonDrainStatus("local", "machine")).toMatchObject({ deadline: original.deadline, reason: "deploy", mode: "draining" });
      expect(store.hasCliUpdateDrainForRuntime("persisted")).toBe(true);
      store.undrainDaemon("local", "machine");
      expect(store.hasCliUpdateDrainForRuntime("persisted")).toBe(false);
    } finally { handle.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("upgrades existing active update requests to persisted drains without changing their deadline on restart", () => {
    const { store } = fixture();
    store.createRuntimeUpdateRequest("rt_a", { scope: "cli", targetVersion: "0.2.96" });
    db!.run("DELETE FROM multiremi_daemon_drains");
    let reopened = new MultiremiStore(db!);
    const state = reopened.getDaemonDrainStatus("local", "machine-a");
    expect(state).toMatchObject({ reason: "cli_update", mode: "draining" });
    advance(10_000); reopened = new MultiremiStore(db!);
    expect(reopened.getDaemonDrainStatus("local", "machine-a").deadline).toBe(state.deadline);
  });

  it("uses the latest daemon-wide report when a provider has been disabled", () => {
    const { store, agent } = fixture();
    const task = store.createTask({ agentId: agent.id, prompt: "long running" });
    store.claimTask("rt_a"); store.startTask(task.id); ack(store, 1);
    store.beginDaemonDrain("local", "machine-a", "manual", 1_000);
    advance(1_000); store.reconcileDaemonDrain("rt_a");
    advance(1_001); store.recordRuntimeDrainAck("rt_a", 0, 0);
    expect(store.getDaemonDrainStatus("local", "machine-a").status).toBe("drained_forced");
  });

  it("validates durations and configurable defaults; a caller-supplied cli_update reason remains explicit", () => {
    const { store } = fixture();
    expect(parseDaemonDrainDuration("1.5s")).toBe(1500);
    for (const value of ["-1s", "0m", "25h", "Infinity", "5", "1x"]) expect(() => parseDaemonDrainDuration(value)).toThrow();
    const before = process.env.MULTIREMI_DAEMON_DRAIN_TIMEOUT_MS;
    try {
      process.env.MULTIREMI_DAEMON_DRAIN_TIMEOUT_MS = "1234";
      expect(store.beginDaemonDrain("local", "machine-a", "cli_update").deadline).toBe("2026-11-17T02:00:01.234Z");
      store.reconcileDaemonDrain("rt_a");
      expect(store.hasCliUpdateDrainForRuntime("rt_a")).toBe(true);
    } finally {
      if (before === undefined) delete process.env.MULTIREMI_DAEMON_DRAIN_TIMEOUT_MS;
      else process.env.MULTIREMI_DAEMON_DRAIN_TIMEOUT_MS = before;
    }
  });

  it("allows members to operate but task credentials only to query, with workspace isolation", async () => {
    const { store, agent } = fixture();
    store.createWorkspaceMember({ id: "member", userId: "member", name: "Member", role: "member" });
    const member = await store.createAccessToken({ name: "member", type: "pat", workspaceId: "local", userId: "member" });
    const task = store.createTask({ agentId: agent.id, prompt: "credential owner" });
    const credential = await store.createAccessToken({ name: "task", type: "task", workspaceId: "local", userId: "member", taskId: task.id, agentId: agent.id });
    const app = createMultiremiApp({ store, authToken: "test-root" });
    const path = "/api/daemons/machine-a/drain";
    const memberHeaders = { Authorization: `Bearer ${member.token}`, "Content-Type": "application/json" };
    const taskHeaders = { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" };
    expect((await app.request(path, { method: "POST", headers: memberHeaders, body: JSON.stringify({ deadline: "10s", reason: "deploy" }) })).status).toBe(200);
    expect((await app.request(path, { headers: taskHeaders })).status).toBe(200);
    expect((await app.request(path, { method: "POST", headers: taskHeaders, body: "{}" })).status).toBe(403);
    expect((await app.request(path, { method: "DELETE", headers: taskHeaders })).status).toBe(403);
    expect((await app.request(path + "?workspace_id=foreign", { headers: taskHeaders })).status).not.toBe(200);
    expect((await app.request(path, { method: "DELETE", headers: memberHeaders })).status).toBe(200);
  });
});
