import { withRequestReadCache } from "@multiremi/store/request-read-cache.js";
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
import { parseDaemonDrainDuration } from "@multiremi/contracts/daemon-drain.js";
import { taskInputSnapshot } from "@multiremi/api/daemon-protocol/task-input-snapshot.js";
import { runtimeInputSnapshot } from "@multiremi/api/daemon-protocol/runtime-input-snapshot.js";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import { registerDaemonRuntimeDownlinks } from "@multiremi/worker/daemon-runtime-downlinks.js";
import type { DaemonProtocolClient } from "@multiremi/worker/daemon-protocol-client.js";
import type { MultiremiDaemonHeartbeatConfigAck } from "@multiremi/worker/client.js";
import { MultiremiCliUpdateCoordinator } from "@multiremi/worker/cli-update-coordinator.js";
import { disabledSshMeshRuntime } from "../../helpers/ssh-mesh-isolation.js";
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
  it("invalidates joined runtime drain state on writes and never leaks it across requests", () => {
    const { store } = fixture();
    withRequestReadCache(() => {
      expect(store.hasCliUpdateDrainForRuntime("rt_a")).toBe(false);
      expect(store.hasCliUpdateDrainForRuntime("rt_a_other")).toBe(false);
      store.beginDaemonDrain("local", "machine-a");
      expect(store.hasCliUpdateDrainForRuntime("rt_a")).toBe(true);
      expect(store.hasCliUpdateDrainForRuntime("rt_a_other")).toBe(true);
      expect(store.nextDaemonDrainWakeAt("rt_a")).toBe(start.getTime() + 300_000);
      store.undrainDaemon("local", "machine-a");
      expect(store.hasCliUpdateDrainForRuntime("rt_a")).toBe(false);
      expect(store.nextDaemonDrainWakeAt("rt_a")).toBeNull();
    });
    store.beginDaemonDrain("local", "machine-a");
    withRequestReadCache(() => expect(store.hasCliUpdateDrainForRuntime("rt_a_other")).toBe(true));
  });

  for (const status of ["pending", "running", "restarting", "verifying"] as const) {
    it(`persists the ${status} CLI update fence across startup and rejects undrain`, () => {
      const { store, agent } = fixture();
      const update = store.createRuntimeUpdateRequest("rt_a", { scope: "cli", targetVersion: "0.2.96" });
      db!.run("UPDATE multiremi_runtime_update_requests SET status = ? WHERE id = ?", [status, update.id]);
      // Simulate upgrading an existing database before the persisted fence existed.
      db!.run("DELETE FROM multiremi_daemon_drains");
      const reopened = new MultiremiStore(db!);
      expect(reopened.getDaemonDrainStatus("local", "machine-a").reason).toBe("cli_update");
      reopened.reconcileDaemonDrain("rt_a");
      const task = reopened.createTask({ agentId: agent.id, prompt: "new work" });
      expect(reopened.claimTask("rt_a")).toBeNull();
      expect(reopened.hasCliUpdateDrainForRuntime("rt_a_other")).toBe(true);
      expect(() => reopened.undrainDaemon("local", "machine-a")).toThrow("CLI update is still active");
      expect(reopened.claimTask("rt_b")?.id).toBe(task.id);
    });
  }

  for (const status of ["restarting", "verifying"] as const) for (const owner of ["cli_update", "deploy"] as const) {
    it(`keeps the ${owner} fence but does not apply drain expiry to a ${status} update or its replacement process`, () => {
      const { store, agent } = fixture();
      const task = store.createTask({ agentId: agent.id, prompt: "pre-restart work" });
      store.claimTask("rt_a"); store.startTask(task.id);
      if (owner === "deploy") store.beginDaemonDrain("local", "machine-a", "deploy");
      const update = store.createRuntimeUpdateRequest("rt_a", { scope: "cli", targetVersion: "0.2.96" });
      db!.run("UPDATE multiremi_runtime_update_requests SET status = ?, run_started_at = ? WHERE id = ?", [status, start.toISOString(), update.id]);
      advance(300_001);
      for (const id of ["rt_a", "rt_a_other"]) store.reconcileDaemonDrain(id);
      expect(store.getRuntimeUpdateRequest("rt_a", update.id)?.status).toBe(status);
      expect(store.getTask(task.id)?.status).toBe("running");
      expect(store.getDaemonDrainStatus("local", "machine-a").forced_at).toBeNull();
      expect(store.claimRuntimeUpdateRequest("rt_a")).toBeNull();
      expect(store.hasCliUpdateDrainForRuntime("rt_a_other")).toBe(true);
    });
  }

  for (const outcome of ["completed", "rolled_back"] as const) {
    it(`releases the CLI fence after restart confirmation ends in ${outcome}`, () => {
      const { store, agent } = fixture();
      const update = store.createRuntimeUpdateRequest("rt_a", { scope: "cli", targetVersion: "0.2.96" });
      expect(store.claimRuntimeUpdateRequest("rt_a")?.id).toBe(update.id);
      store.reportRuntimeUpdateResult("rt_a", update.id, { status: "restarting" });
      const reopened = new MultiremiStore(db!);
      expect(reopened.getDaemonDrainStatus("local", "machine-a").mode).toBe("draining");
      reopened.recordDaemonProtocol("rt_a", "machine-a", 2, "0.2.96");
      expect(store.getRuntimeUpdateRequest("rt_a", update.id)?.status).toBe("verifying");
      expect(reopened.reportRuntimeUpdateResult("rt_a", update.id, { status: outcome, self_check: true }).status).toBe(outcome);
      expect(store.getDaemonDrainStatus("local", "machine-a").mode).toBe("normal");
      expect(store.hasCliUpdateDrainForRuntime("rt_a_other")).toBe(false);
      const task = store.createTask({ agentId: agent.id, prompt: "after restart" });
      expect(store.claimTask("rt_a")?.id).toBe(task.id);
    });
  }

  it("accepts an explicit process-wide HTTP report without waiting for a disabled historical lane", async () => {
    const { store, agent } = fixture();
    db!.run("UPDATE multiremi_runtimes SET metadata = ?", [JSON.stringify({ cli_version: DAEMON_MIN_CLI_VERSION })]);
    const task = store.createTask({ agentId: agent.id, prompt: "long tool" });
    store.claimTask("rt_a"); store.startTask(task.id);
    // B's stale process-wide count is retained in storage after it was disabled.
    ack(store, 1);
    store.beginDaemonDrain("local", "machine-a", "manual", 1000);
    advance(1000); store.reconcileDaemonDrain("rt_a");
    const app = createMultiremiApp({ store, authToken: "test-root" });
    const report = async (count: number) => app.request("/api/daemon/heartbeat", { method: "POST",
      headers: { Authorization: "Bearer test-root", "Content-Type": "application/json" },
      body: JSON.stringify({ runtime_id: "rt_a", drain_ack_generation: 0, active_task_count: count,
        active_task_count_scope: "daemon", active_task_ids: [task.id] }) });
    advance(1001); await report(1); // A/B still executing in the current process.
    expect(store.getDaemonDrainStatus("local", "machine-a")).toMatchObject({ status: "draining", remaining_tasks: 1 });
    advance(1002); await report(0); // Only A now exists and has stopped its task.
    expect(store.getDaemonDrainStatus("local", "machine-a")).toMatchObject({ status: "drained_forced", remaining_tasks: 0 });
  });

  it("aggregates HTTP provider counts and returns terminal cancellation to upgrade probes", async () => {
    const { store, agent } = fixture();
    db!.run("UPDATE multiremi_runtimes SET metadata = ?", [JSON.stringify({ cli_version: DAEMON_MIN_CLI_VERSION })]);
    const task = store.createTask({ agentId: agent.id, prompt: "local long task" });
    store.claimTask("rt_a"); store.startTask(task.id);
    const app = createMultiremiApp({ store, authToken: "test-root" });
    const heartbeat = async (id: string, count: number, ids: string[] = []) => {
      const response = await app.request("/api/daemon/heartbeat", { method: "POST",
        headers: { Authorization: "Bearer test-root", "Content-Type": "application/json" },
        body: JSON.stringify({ runtime_id: id, drain_ack_generation: 0, active_task_count: count, active_task_ids: ids }) });
      expect(response.status).toBe(200);
      return response.json();
    };
    await heartbeat("rt_a", 1); await heartbeat("rt_a_other", 0);
    store.beginDaemonDrain("local", "machine-a", "deploy", 1000);
    advance(1000); store.reconcileDaemonDrain("rt_a");
    advance(1001);
    const probe = await heartbeat("rt_a", 1, [task.id, "unknown"]);
    expect(probe.cancelled_tasks).toEqual([{ task_id: task.id, status: "failed" }]);
    advance(1002); await heartbeat("rt_a_other", 0);
    expect(store.getDaemonDrainStatus("local", "machine-a")).toMatchObject({ status: "draining", remaining_tasks: 1 });
    advance(1003); await heartbeat("rt_a", 0);
    expect(store.getDaemonDrainStatus("local", "machine-a")).toMatchObject({ status: "drained_forced", remaining_tasks: 0 });
  });

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

  it("fails an expired CLI drain without recovering or cancelling the running round", () => {
    const { store, agent } = fixture();
    const task = store.createTask({ agentId: agent.id, prompt: "long running" });
    store.claimTask("rt_a"); store.startTask(task.id); ack(store, 1);
    const update = store.createRuntimeUpdateRequest("rt_a", { scope: "cli", targetVersion: "0.2.96" });
    expect(store.claimRuntimeUpdateRequest("rt_a")).toBeNull();
    advance(300_000); store.reconcileDaemonDrain("rt_a");
    expect(store.getRuntimeUpdateRequest("rt_a", update.id)).toMatchObject({ status: "failed" });
    expect(store.getRuntimeUpdateRequest("rt_a", update.id)?.error).toContain(task.id);
    expect(store.getTask(task.id)?.status).toBe("running");
    expect(store.getDaemonDrainStatus("local", "machine-a").mode).toBe("normal");
    expect(store.claimRuntimeUpdateRequest("rt_a")).toBeNull();
  });

  it("keeps a busy update pending until natural drain, then hands off the original deadline", () => {
    const { store, agent } = fixture();
    const task = store.createTask({ agentId: agent.id, prompt: "finishes naturally" });
    store.claimTask("rt_a"); store.startTask(task.id); ack(store, 1);
    const update = store.createRuntimeUpdateRequest("rt_a", { scope: "cli", targetVersion: "0.2.96" });
    expect(store.claimRuntimeUpdateRequest("rt_a")).toBeNull();
    expect(store.getRuntimeUpdateRequest("rt_a", update.id)?.status).toBe("pending");
    store.completeTask(task.id, { output: "done" }); ack(store, 0);
    expect(store.heartbeatRuntime("rt_a").pending_update).toMatchObject({ id: update.id, drain_deadline: "2026-11-17T02:05:00.000Z" });
  });

  for (const reason of ["manual", "deploy"] as const) it(`omits an expired ${reason} deadline from an HTTP upgrade claim`, async () => {
    const { store } = fixture();
    db!.run("UPDATE multiremi_runtimes SET metadata = ?", [JSON.stringify({ cli_version: DAEMON_MIN_CLI_VERSION })]);
    ack(store, 0);
    const original = store.beginDaemonDrain("local", "machine-a", reason, 60_000);
    advance(600_000);
    ack(store, 0);
    const update = store.createRuntimeUpdateRequest("rt_a", { scope: "cli", targetVersion: "0.2.96" });
    const snapshot = runtimeInputSnapshot(store, "rt_a").find(input => input.type === "runtime.update")!;
    expect(snapshot.payload.id).toBe(update.id);
    expect(snapshot.payload).not.toHaveProperty("drain_deadline");
    const app = createMultiremiApp({ store, authToken: "test-root" });
    const response = await app.request("/api/daemon/heartbeat", { method: "POST",
      headers: { Authorization: "Bearer test-root", "Content-Type": "application/json" },
      body: JSON.stringify({ runtime_id: "rt_a", drain_ack_generation: 0, active_task_count: 0 }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pending_update).toMatchObject({ id: update.id, scope: "cli", target_version: "0.2.96" });
    expect(body.pending_update).not.toHaveProperty("drain_deadline");
    expect(store.getRuntimeUpdateRequest("rt_a", update.id)?.status).toBe("running");
    expect(store.getDaemonDrainStatus("local", "machine-a")).toMatchObject({ reason, deadline: original.deadline });
  });

  for (const reason of ["manual", "deploy"] as const) it(`preserves an existing ${reason} drain after a failed update`, () => {
    const { store } = fixture();
    const original = store.beginDaemonDrain("local", "machine-a", reason);
    const update = store.createRuntimeUpdateRequest("rt_a", { scope: "cli", targetVersion: "0.2.96" });
    store.reportRuntimeUpdateResult("rt_a", update.id, { status: "failed", error: "checksum mismatch" });
    expect(store.getDaemonDrainStatus("local", "machine-a")).toMatchObject({ mode: "draining", reason, deadline: original.deadline });
  });

  it("does not release another request's drain on a sibling failure", () => {
    const { store } = fixture();
    const owner = store.createRuntimeUpdateRequest("rt_a", { scope: "cli", targetVersion: "0.2.96" });
    const sibling = store.createRuntimeUpdateRequest("rt_a_other", { scope: "cli", targetVersion: "0.2.97" });
    store.reportRuntimeUpdateResult("rt_a_other", sibling.id, { status: "failed", error: "checksum mismatch" });
    expect(store.getDaemonDrainStatus("local", "machine-a").mode).toBe("draining");
    expect(store.getRuntimeUpdateRequest("rt_a", owner.id)?.status).toBe("pending");
  });

  for (const busy of [false, true]) it(`hands a failed owner's drain to the oldest pending sibling, then ${busy ? "expires it without pending residue" : "claims and completes it"}`, () => {
    const { store, agent } = fixture();
    const task = busy ? store.createTask({ agentId: agent.id, prompt: "still busy" }) : null;
    if (task) { store.claimTask("rt_a"); store.startTask(task.id); ack(store, 1); }
    const first = store.createRuntimeUpdateRequest("rt_a", { scope: "cli", targetVersion: "0.2.96" });
    const originalDeadline = store.getDaemonDrainStatus("local", "machine-a").deadline;
    advance(1_000);
    const second = store.createRuntimeUpdateRequest("rt_a_other", { scope: "cli", targetVersion: "0.2.97" });
    // Another physical daemon must not become the successor.
    store.createRuntimeUpdateRequest("rt_b", { scope: "cli", targetVersion: "0.2.98" });
    advance(10_000);
    store.reportRuntimeUpdateResult("rt_a", first.id, { status: "failed", error: "checksum mismatch" });
    expect(store.getDaemonDrainStatus("local", "machine-a")).toMatchObject({ mode: "draining", deadline: "2026-11-17T02:05:10.000Z" });
    expect(store.getDaemonDrainStatus("local", "machine-a").deadline).not.toBe(originalDeadline);
    expect(db!.query("SELECT update_request_id FROM multiremi_daemon_drains WHERE daemon_id = 'machine-a'").get()).toEqual({ update_request_id: second.id });
    expect(store.getRuntimeUpdateRequest("rt_a_other", second.id)?.status).toBe("pending");
    if (busy) {
      expect(store.claimRuntimeUpdateRequest("rt_a_other")).toBeNull();
      advance(310_000); ack(store, 1); store.reconcileDaemonDrain("rt_a_other");
      expect(store.getRuntimeUpdateRequest("rt_a_other", second.id)).toMatchObject({ status: "failed" });
      expect(store.getRuntimeUpdateRequest("rt_a_other", second.id)?.error).toContain(task!.id);
      expect(store.getTask(task!.id)?.status).toBe("running");
      expect(store.claimRuntimeUpdateRequest("rt_a_other")).toBeNull();
    } else {
      expect(store.claimRuntimeUpdateRequest("rt_a_other")?.id).toBe(second.id);
      store.reportRuntimeUpdateResult("rt_a_other", second.id, { status: "restarting" });
      store.recordDaemonProtocol("rt_a_other", "machine-a", 2, "0.2.97");
      store.reportRuntimeUpdateResult("rt_a_other", second.id, { status: "completed", self_check: true });
    }
    expect(store.getDaemonDrainStatus("local", "machine-a").mode).toBe("normal");
    expect(db!.query("SELECT id FROM multiremi_runtime_update_requests WHERE runtime_id IN ('rt_a', 'rt_a_other') AND status = 'pending'").all()).toEqual([]);
    expect(store.getDaemonDrainStatus("local", "machine-b").mode).toBe("draining");
  });

  for (const ownerStatus of ["pending", "running", "restarting", "verifying"] as const) {
    it(`blocks sibling admission via claim, snapshot and running report while owner is ${ownerStatus}`, () => {
      const { store } = fixture();
      const owner = store.createRuntimeUpdateRequest("rt_a", { scope: "cli", targetVersion: "0.2.96" });
      const sibling = store.createRuntimeUpdateRequest("rt_a_other", { scope: "cli", targetVersion: "0.2.97" });
      db!.run("UPDATE multiremi_runtime_update_requests SET status = ? WHERE id = ?", [ownerStatus, owner.id]);
      advance(1_000);
      expect(store.claimRuntimeUpdateRequest("rt_a_other")).toBeNull();
      store.claimAcknowledgedRuntimeRequest("rt_a_other", "update", sibling.id);
      expect(runtimeInputSnapshot(store, "rt_a_other").filter(input => input.type === "runtime.update")).toEqual([]);
      expect(() => store.reportRuntimeUpdateResult("rt_a_other", sibling.id, { status: "running" })).toThrow("admission denied");
      expect(store.getRuntimeUpdateRequest("rt_a_other", sibling.id)).toMatchObject({ status: "pending", updatedAt: new Date(start.getTime() + 1_000).toISOString() });
      advance(10_000);
      store.reportRuntimeUpdateResult("rt_a", owner.id, { status: "failed", error: "owner failed" });
      advance(20_000);
      const entity = runtimeInputSnapshot(store, "rt_a_other").find(input => input.type === "runtime.update");
      expect(entity?.payload).toMatchObject({ id: sibling.id, drain_deadline: "2026-11-17T02:05:10.000Z" });
      expect(Date.parse(String(entity?.payload.drain_deadline)) - Date.now()).toBe(290_000);
      expect(store.claimRuntimeUpdateRequest("rt_a_other")?.id).toBe(sibling.id);
      store.reportRuntimeUpdateResult("rt_a_other", sibling.id, { status: "restarting" });
      store.recordDaemonProtocol("rt_a_other", "machine-a", 2, "0.2.97");
      store.reportRuntimeUpdateResult("rt_a_other", sibling.id, { status: "completed", self_check: true });
      expect(store.getDaemonDrainStatus("local", "machine-a").mode).toBe("normal");
    });
  }

  for (const activeStatus of ["running", "restarting", "verifying"] as const) {
    it(`serializes CLI updates under manual drain while first is ${activeStatus}`, () => {
      const { store } = fixture();
      const drain = store.beginDaemonDrain("local", "machine-a", "manual");
      const first = store.createRuntimeUpdateRequest("rt_a", { scope: "cli", targetVersion: "0.2.96" });
      const second = store.createRuntimeUpdateRequest("rt_a_other", { scope: "cli", targetVersion: "0.2.97" });
      const sent = runtimeInputSnapshot(store, "rt_a_other").find(input => input.type === "runtime.update")!;
      expect(sent.payload.id).toBe(second.id);
      expect(store.claimRuntimeUpdateRequest("rt_a")?.id).toBe(first.id);
      sent.claimed?.();
      expect(store.getRuntimeUpdateRequest("rt_a_other", second.id)?.status).toBe("pending");
      db!.run("UPDATE multiremi_runtime_update_requests SET status = ? WHERE id = ?", [activeStatus, first.id]);
      expect(store.claimRuntimeUpdateRequest("rt_a_other")).toBeNull();
      expect(runtimeInputSnapshot(store, "rt_a_other").filter(input => input.type === "runtime.update")).toEqual([]);
      expect(() => store.reportRuntimeUpdateResult("rt_a_other", second.id, { status: "running" })).toThrow("admission denied");
      expect(store.getRuntimeUpdateRequest("rt_a_other", second.id)?.status).toBe("pending");
      store.reportRuntimeUpdateResult("rt_a", first.id, { status: "failed" });
      expect(runtimeInputSnapshot(store, "rt_a_other").find(input => input.type === "runtime.update")?.payload.id).toBe(second.id);
      store.reportRuntimeUpdateResult("rt_a_other", second.id, { status: "running" });
      store.reportRuntimeUpdateResult("rt_a_other", second.id, { status: "restarting" });
      store.recordDaemonProtocol("rt_a_other", "machine-a", 2, "0.2.97");
      store.reportRuntimeUpdateResult("rt_a_other", second.id, { status: "completed", self_check: true });
      expect(store.getDaemonDrainStatus("local", "machine-a")).toMatchObject({ mode: "draining", reason: "manual", deadline: drain.deadline });
    });
  }

  it("selects the earliest pending CLI sibling on the same physical daemon", () => {
    const { store } = fixture();
    const first = store.createRuntimeUpdateRequest("rt_a", { scope: "cli", targetVersion: "0.2.96" });
    advance(1_000);
    const oldest = store.createRuntimeUpdateRequest("rt_a_other", { scope: "cli", targetVersion: "0.2.97" });
    store.registerRuntime({ id: "rt_a_third", daemonId: "machine-a", provider: "codex", name: "third", workspaceId: "local" });
    advance(2_000);
    store.createRuntimeUpdateRequest("rt_a_third", { scope: "cli", targetVersion: "0.2.98" });
    store.reportRuntimeUpdateResult("rt_a", first.id, { status: "failed", error: "checksum mismatch" });
    expect(db!.query("SELECT update_request_id FROM multiremi_daemon_drains WHERE daemon_id = 'machine-a'").get()).toEqual({ update_request_id: oldest.id });
  });

  it("hands off an expired owner's fence with a fresh deadline", () => {
    const { store, agent } = fixture();
    const task = store.createTask({ agentId: agent.id, prompt: "busy across two deadlines" });
    store.claimTask("rt_a"); store.startTask(task.id); ack(store, 1);
    const first = store.createRuntimeUpdateRequest("rt_a", { scope: "cli", targetVersion: "0.2.96" });
    advance(1_000);
    const second = store.createRuntimeUpdateRequest("rt_a_other", { scope: "cli", targetVersion: "0.2.97" });
    advance(300_000); store.reconcileDaemonDrain("rt_a");
    expect(store.getRuntimeUpdateRequest("rt_a", first.id)?.status).toBe("failed");
    expect(store.getRuntimeUpdateRequest("rt_a_other", second.id)?.status).toBe("pending");
    expect(store.getDaemonDrainStatus("local", "machine-a").deadline).toBe("2026-11-17T02:10:00.000Z");
    advance(600_000); ack(store, 1); store.reconcileDaemonDrain("rt_a_other");
    expect(store.getRuntimeUpdateRequest("rt_a_other", second.id)?.status).toBe("failed");
    expect(store.getDaemonDrainStatus("local", "machine-a").mode).toBe("normal");
    expect(store.getTask(task.id)?.status).toBe("running");
  });

  it("carries the persisted remaining deadline from runtime snapshot through downlink mapping into the daemon", async () => {
    const { store } = fixture();
    const request = store.createRuntimeUpdateRequest("rt_a", { scope: "cli", targetVersion: "0.2.96" });
    advance(290_000);
    store.heartbeatRuntime("rt_a", { claimPending: false });
    const entity = runtimeInputSnapshot(store, "rt_a").find(input => input.type === "runtime.update")!;
    expect(entity.payload).toMatchObject({ id: request.id, drain_deadline: "2026-11-17T02:05:00.000Z" });
    const root = mkdtempSync(join(tmpdir(), "mul80-downlink-"));
    try {
      const daemon = new MultiremiDaemon({ serverUrl: "http://127.0.0.1:1", provider: "codex", runtimeId: "rt_a",
        workspacesRoot: root, repoCacheRoot: join(root, "repos"), sshMeshManager: disabledSshMeshRuntime() });
      const coordinator = new MultiremiCliUpdateCoordinator();
      const deadlines: number[] = [];
      const pause = coordinator.pauseClaimsUntilIdle.bind(coordinator);
      coordinator.pauseClaimsUntilIdle = (deadline, stopped) => { deadlines.push(deadline); return pause(deadline, stopped); };
      const reports: Array<{ status: string; error?: string }> = [];
      Object.assign(daemon, { cliUpdateCoordinator: coordinator, activeTaskCount: 1, activeTaskIds: new Set(["racing-task"]),
        client: { reportRuntimeUpdateResult: async (_rt: string, _id: string, report: { status: string }) => { reports.push(report); } } });
      coordinator.register({ provider: "codex", activeTaskCount: () => 1, activeTaskIds: () => ["racing-task"],
        pendingClaimCount: () => 0, claimsPaused: () => false, pauseClaims: () => {}, releaseClaims: () => {} });
      const handlers = new Map<string, (frame: any) => Promise<void>>();
      const transport = { registerFrameHandler: (type: string, handler: (frame: any) => Promise<void>) => handlers.set(type, handler),
        dedupe: { claim: () => true, release: () => {} }, send: () => {} } as unknown as DaemonProtocolClient;
      registerDaemonRuntimeDownlinks(transport, () => "rt_a",
        (rt, input) => (daemon as unknown as { handleHeartbeatAck(rt: string, input: MultiremiDaemonHeartbeatConfigAck): Promise<boolean> }).handleHeartbeatAck(rt, input),
        async () => {});
      const applying = handlers.get(entity.type)!({ rt: "rt_a", payload: entity.payload });
      expect(deadlines).toEqual([start.getTime() + 300_000]);
      expect(deadlines[0]! - Date.now()).toBe(10_000);
      advance(300_000);
      await applying;
      expect(reports).toEqual([{ status: "failed", error: "CLI update drain deadline exceeded; remaining tasks: codex: racing-task" }]);
    } finally { rmSync(root, { recursive: true, force: true }); }
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

  for (const outcome of ["completed", "rolled_back"] as const) it(`retains a CLI drain across SQLite close/reopen until ${outcome} confirmation`, () => {
    const root = mkdtempSync(join(tmpdir(), "mul80-cli-persistence-"));
    const path = join(root, "db.sqlite");
    let handle = openSqliteDatabase(path);
    try {
      let store = new MultiremiStore(handle); store.ensureLocalWorkspace();
      store.registerRuntime({ id: "persisted", name: "persisted", provider: "codex", daemonId: "machine" });
      const update = store.createRuntimeUpdateRequest("persisted", { scope: "cli", targetVersion: "0.2.96" });
      const deadline = store.getDaemonDrainStatus("local", "machine").deadline;
      store.claimRuntimeUpdateRequest("persisted");
      store.reportRuntimeUpdateResult("persisted", update.id, { status: "restarting" });
      handle.close(); handle = openSqliteDatabase(path); store = new MultiremiStore(handle);
      expect(store.getDaemonDrainStatus("local", "machine")).toMatchObject({ mode: "draining", deadline, expiry_action: "fail_update" });
      store.recordDaemonProtocol("persisted", "machine", 2, "0.2.96");
      store.reportRuntimeUpdateResult("persisted", update.id, { status: outcome, self_check: true });
      expect(store.getDaemonDrainStatus("local", "machine").mode).toBe("normal");
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
