import { expect, it } from "bun:test";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";
import type { PlannedRestartCheckpoint } from "@multiremi/store/planned-restarts.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PlannedRestartJournal, PlannedRestartTransfer, type PlannedRestartRemote } from "@multiremi/worker/planned-restart-journal.js";

pendingTurnBackendTests("planned restart handoff", fixture => {
  function setup() {
    const f = fixture();
    const scope = { workspaceId: "local", runtimeId: "rt_planned", daemonId: "daemon_planned" };
    f.store.registerRuntime({ id: scope.runtimeId, daemonId: scope.daemonId, name: "Planned restart", provider: "codex", workspaceId: scope.workspaceId });
    const agent = f.store.createAgent({ name: "Restart agent", provider: "codex", runtimeId: scope.runtimeId });
    const task = f.store.createTask({ agentId: agent.id, prompt: "Continue the same turn", maxAttempts: 1 });
    expect(f.store.claimTask(scope.runtimeId)?.id).toBe(task.id);
    f.store.startTask(task.id);
    const offer = f.store.getDaemonTurnBridge().offerInput(f.store.getTaskWithAgent(task.id)!);
    const checkpoint: PlannedRestartCheckpoint = { version: 1, session_id: null, work_dir: null, trace_head: 12,
      input_ack_seq: Number(f.db.query("SELECT input_ack_seq FROM multiremi_turn_attempts WHERE id=?").get(task.id).input_ack_seq ?? 0),
      delivered_message_ids: offer.input_messages.map(message => message.id) };
    const planned = () => f.store.plannedRestarts();
    const request = () => {
      f.store.beginDaemonDrain(scope.workspaceId, scope.daemonId, "manual", 1_000);
      return planned().request(task.id, scope);
    };
    const suspend = () => {
      const h = request();
      return planned().suspend(task.id, h.handoff_id, h.generation, checkpoint, scope);
    };
    return { f, scope, task, offer, checkpoint, planned, request, suspend };
  }

  it("keeps unread long confirmed steer in the canonical completeness window", () => {
    const x = setup(), bridge = x.f.store.getDaemonTurnBridge();
    const long = x.f.store.createTaskSteerMessage({ taskId: x.task.id, kind: "steer", content: "x".repeat(9000) });
    const pending = x.f.store.createTaskSteerMessage({ taskId: x.task.id, kind: "steer", content: "Still pending" });
    const before = bridge.offerInput(x.f.store.getTaskWithAgent(x.task.id)!);
    const h = x.request();
    const checkpoint = x.planned().checkpointReferences(x.task.id, x.scope);
    checkpoint.delivered_message_ids = [long.id];
    x.planned().suspend(x.task.id, h.handoff_id, 0, checkpoint, x.scope);
    x.f.store.undrainDaemon(x.scope.workspaceId, x.scope.daemonId);
    x.planned().resume(x.task.id, h.handoff_id, "complete-window-consumer", x.scope, () => {});
    const resumed = bridge.offerInput(x.f.store.getTaskWithAgent(x.task.id)!);
    expect(resumed.input_messages.some(message => message.id === long.id)).toBe(false);
    expect(resumed.input_messages.some(message => message.id === pending.id)).toBe(true);
    expect(resumed.input_messages[0]!.body_md.split("\n")[0]).not.toContain('"complete":true');
    const snapshot = bridge.snapshot(x.scope, new Set([x.task.id]));
    expect(snapshot.messages.some(entry => entry.message.id === long.id)).toBe(false);
    expect(snapshot.messages.find(entry => entry.message.id === pending.id)!.message.body_md.split("\n")[0]).not.toContain('"complete":true');
    expect(bridge.rpc("turn.input", { turn_id: resumed.turn_id, attempt_id: x.task.id, generation: 1,
      input_to_seq: before.input_to_seq, message_ids: resumed.input_messages.map(message => message.id) }, x.scope))
      .toMatchObject({ ok: false, code: "input_gap" });
  });

  it("requires a persisted admission fence and keeps request replay stable", () => {
    const x = setup();
    expect(() => x.planned().request(x.task.id, x.scope)).toThrow("drain_not_active");
    const h = x.request();
    expect(x.request()).toEqual(h);
    expect(x.planned().protectsFromOrphanRecovery(x.task.id)).toBe(false);
    expect(() => x.f.transaction(() => x.planned().assertExecutionWithinTransaction(x.task.id, 0))).not.toThrow();
  });

  it("fences transport writes before and after the first handoff", () => {
    const x = setup();
    let writes = 0;
    const write = (generation?: number) => x.planned().withExecution(x.task.id, generation, x.scope, () => ++writes);
    expect(write()).toBe(1);
    expect(() => write(1)).toThrow("stale_execution");
    const h = x.suspend();
    expect(() => write(0)).toThrow("stale_execution");
    x.f.store.undrainDaemon(x.scope.workspaceId, x.scope.daemonId);
    x.planned().resume(x.task.id, h.handoff_id, "transport-write-consumer", x.scope, () => {});
    expect(() => write(0)).toThrow("stale_execution");
    expect(write(1)).toBe(2);
    expect(writes).toBe(2);
  });

  it("persists the same attempt without spending its last retry or changing visible status", () => {
    const x = setup();
    const before = x.f.db.query("SELECT * FROM multiremi_turn_attempts WHERE id=?").get(x.task.id);
    const turn = x.f.db.query("SELECT * FROM multiremi_turns WHERE id=?").get(x.offer.turn_id);
    const h = x.suspend();
    x.f.reopen(); // Real connection reopen on PG; SQLite persistence has a separate disk test below.
    expect(x.f.store.plannedRestarts().get(x.task.id)).toEqual(h);
    expect(x.f.db.query("SELECT * FROM multiremi_turn_attempts WHERE id=?").get(x.task.id)).toEqual(before);
    expect(x.f.db.query("SELECT * FROM multiremi_turns WHERE id=?").get(x.offer.turn_id)).toEqual(turn);
    expect(x.f.store.getTask(x.task.id)).toMatchObject({ status: "running", attempt: 1, maxAttempts: 1 });
    expect(Number(x.f.db.query("SELECT COUNT(*) AS n FROM multiremi_turn_attempts WHERE turn_id=?").get(x.offer.turn_id).n)).toBe(1);
  });

  it("requires identical checkpoint contents on replay", () => {
    const x = setup(), h = x.suspend();
    expect(x.planned().suspend(x.task.id, h.handoff_id, 0, x.checkpoint, x.scope)).toEqual(h);
    expect(() => x.planned().suspend(x.task.id, h.handoff_id, 0, { ...x.checkpoint, trace_head: 13 }, x.scope)).toThrow("invalid_checkpoint");
    expect(x.planned().get(x.task.id)).toEqual(h);
  });

  it("rejects stale handoff identities and generations without changing its committed journal", () => {
    const x = setup(), h = x.suspend();
    expect(() => x.planned().suspend(x.task.id, "another-drain", 0, x.checkpoint, x.scope)).toThrow("stale_execution");
    expect(() => x.planned().suspend(x.task.id, h.handoff_id, 1, x.checkpoint, x.scope)).toThrow("stale_execution");
    expect(() => x.planned().resume(x.task.id, "another-drain", "consumer-00000001", x.scope, () => {})).toThrow("stale_execution");
    expect(x.planned().get(x.task.id)).toEqual(h);
  });

  it("rejects invented input receipts and credentials instead of persisting arbitrary JSON", () => {
    const x = setup(), h = x.request();
    const invalid = [
      { ...x.checkpoint, input_ack_seq: x.checkpoint.input_ack_seq + 1 },
      { ...x.checkpoint, delivered_message_ids: ["not-an-offered-message"] },
      { ...x.checkpoint, delivered_message_ids: [...x.checkpoint.delivered_message_ids, ...x.checkpoint.delivered_message_ids] },
      { ...x.checkpoint, session_id: "invented-provider-session" },
      { ...x.checkpoint, work_dir: "/another-machine" },
      { ...x.checkpoint, trace_head: -1 },
      { ...x.checkpoint, trace_head: 0.5 },
      { ...x.checkpoint, token: "must-not-be-journaled" },
    ];
    for (const checkpoint of invalid) {
      expect(() => x.planned().suspend(x.task.id, h.handoff_id, 0, checkpoint, x.scope)).toThrow("invalid_checkpoint");
      expect(x.planned().get(x.task.id)?.state).toBe("requested");
    }
  });

  it("rejects a delivered receipt from another conversation", () => {
    const x = setup(), h = x.request();
    const otherAgent = x.f.store.createAgent({ name: "Other conversation", provider: "codex" });
    const otherTask = x.f.store.createTask({ agentId: otherAgent.id, prompt: "Other input" });
    const message = x.f.db.query("SELECT trigger_message_id FROM multiremi_turns WHERE current_attempt_id=?").get(otherTask.id);
    expect(() => x.planned().suspend(x.task.id, h.handoff_id, 0,
      { ...x.checkpoint, delivered_message_ids: [message.trigger_message_id] }, x.scope)).toThrow("invalid_checkpoint");
  });

  it("requires the original fence at checkpoint commit even after undrain", () => {
    const x = setup(), h = x.request();
    x.f.store.undrainDaemon(x.scope.workspaceId, x.scope.daemonId);
    expect(() => x.planned().suspend(x.task.id, h.handoff_id, 0, x.checkpoint, x.scope)).toThrow("drain_not_active");
    expect(x.planned().protectsFromOrphanRecovery(x.task.id)).toBe(false);
  });

  it("distinguishes two drain fences created in the same clock tick", () => {
    const x = setup(), h = x.request();
    x.f.store.undrainDaemon(x.scope.workspaceId, x.scope.daemonId);
    const replacement = x.request();
    expect(replacement.handoff_id).not.toBe(h.handoff_id);
    expect(() => x.planned().suspend(x.task.id, h.handoff_id, 0, x.checkpoint, x.scope)).toThrow("stale_execution");
    expect(x.planned().suspend(x.task.id, replacement.handoff_id, 0, x.checkpoint, x.scope).state).toBe("suspended");
  });

  it("blocks execution while suspended and permits exactly one resume consumer after undrain", () => {
    const x = setup(), h = x.suspend();
    expect(x.planned().protectsFromOrphanRecovery(x.task.id)).toBe(true);
    expect(() => x.f.transaction(() => x.planned().assertExecutionWithinTransaction(x.task.id, 0))).toThrow("stale_execution");
    expect(() => x.planned().resume(x.task.id, h.handoff_id, "consumer-00000001", x.scope, () => {})).toThrow("resume_fenced");
    x.f.store.undrainDaemon(x.scope.workspaceId, x.scope.daemonId);
    let authorized = 0;
    const resume = () => x.planned().resume(x.task.id, h.handoff_id, "consumer-00000001", x.scope, (generation, checkpoint) => {
      expect(generation).toBe(1); expect(checkpoint).toEqual(x.checkpoint); authorized++;
    });
    const resumed = resume();
    expect(resumed).toMatchObject({ generation: 1, state: "running", consumer_id: "consumer-00000001" });
    expect(resume()).toEqual(resumed);
    expect(() => x.planned().resume(x.task.id, h.handoff_id, "consumer-00000002", x.scope, () => {})).toThrow("stale_execution");
    expect(authorized).toBe(1);
    expect(() => x.f.transaction(() => x.planned().assertExecutionWithinTransaction(x.task.id, 1))).not.toThrow();
    expect(() => x.f.transaction(() => x.planned().assertExecutionWithinTransaction(x.task.id, 0))).toThrow("stale_execution");
    expect(() => x.f.transaction(() => x.planned().assertExecutionWithinTransaction(x.task.id, undefined))).toThrow("stale_execution");
  });

  it("does not resume behind a CLI update owner even after the previous manual fence was removed", () => {
    const x = setup(), h = x.suspend();
    x.f.store.undrainDaemon(x.scope.workspaceId, x.scope.daemonId);
    x.f.store.createRuntimeUpdateRequest(x.scope.runtimeId, { scope: "cli", targetVersion: "0.2.96" });
    expect(() => x.planned().resume(x.task.id, h.handoff_id, "consumer-00000001", x.scope, () => {})).toThrow("resume_fenced");
    expect(x.planned().get(x.task.id)?.state).toBe("suspended");
  });

  it("rolls back activation and its associated execution authorization together", () => {
    const x = setup(), h = x.suspend();
    x.f.store.undrainDaemon(x.scope.workspaceId, x.scope.daemonId);
    const before = x.f.db.query("SELECT progress_summary FROM multiremi_turn_attempts WHERE id=?").get(x.task.id);
    expect(() => x.planned().resume(x.task.id, h.handoff_id, "consumer-00000001", x.scope, () => {
      x.f.db.run("UPDATE multiremi_turn_attempts SET progress_summary='must roll back' WHERE id=?", [x.task.id]);
      throw new Error("authorization unavailable");
    })).toThrow("authorization unavailable");
    expect(x.f.db.query("SELECT progress_summary FROM multiremi_turn_attempts WHERE id=?").get(x.task.id)).toEqual(before);
    expect(x.planned().get(x.task.id)?.state).toBe("suspended");
    expect(x.planned().get(x.task.id)?.generation).toBe(0);
    expect(x.planned().get(x.task.id)?.consumer_id).toBeNull();
    expect(x.planned().resume(x.task.id, h.handoff_id, "consumer-00000002", x.scope, () => {}).generation).toBe(1);
  });

  it("rejects a corrupt stored checkpoint before granting a replacement authority", () => {
    const x = setup(), h = x.suspend();
    x.f.store.undrainDaemon(x.scope.workspaceId, x.scope.daemonId);
    x.f.db.run("UPDATE multiremi_planned_restarts SET checkpoint=? WHERE attempt_id=?", [JSON.stringify({ ...x.checkpoint, trace_head: 999 }), x.task.id]);
    let authorized = false;
    expect(() => x.planned().resume(x.task.id, h.handoff_id, "consumer-00000001", x.scope, () => { authorized = true; })).toThrow("invalid_checkpoint");
    expect(authorized).toBe(false);
  });

  it("uses a new handoff identity and another generation for a subsequent restart", () => {
    const x = setup(), first = x.suspend();
    x.f.store.undrainDaemon(x.scope.workspaceId, x.scope.daemonId);
    x.planned().resume(x.task.id, first.handoff_id, "consumer-00000001", x.scope, () => {});
    const second = x.request();
    expect(second.handoff_id).not.toBe(first.handoff_id);
    expect(second.generation).toBe(1);
    expect(() => x.planned().suspend(x.task.id, first.handoff_id, 0, x.checkpoint, x.scope)).toThrow("stale_execution");
    x.planned().suspend(x.task.id, second.handoff_id, 1, x.checkpoint, x.scope);
    x.f.store.undrainDaemon(x.scope.workspaceId, x.scope.daemonId);
    expect(x.planned().resume(x.task.id, second.handoff_id, "consumer-00000002", x.scope, () => {}).generation).toBe(2);
    expect(() => x.f.transaction(() => x.planned().assertExecutionWithinTransaction(x.task.id, 1))).toThrow("stale_execution");
    expect(() => x.f.transaction(() => x.planned().assertExecutionWithinTransaction(x.task.id, 2))).not.toThrow();
    expect(x.f.store.getTask(x.task.id)?.attempt).toBe(1);
  });

  it("does not revive an attempt when cancellation wins the checkpoint race", () => {
    const x = setup(), h = x.request();
    x.f.store.cancelTask(x.task.id);
    expect(() => x.planned().suspend(x.task.id, h.handoff_id, 0, x.checkpoint, x.scope)).toThrow("stale_execution");
    expect(x.f.store.getTask(x.task.id)?.status).toBe("cancelled");
    expect(x.planned().get(x.task.id)?.state).toBe("requested");
  });

  it("does not resume when cancellation wins after a committed checkpoint", () => {
    const x = setup(), h = x.suspend();
    x.f.store.undrainDaemon(x.scope.workspaceId, x.scope.daemonId);
    x.f.store.cancelTask(x.task.id);
    expect(() => x.planned().resume(x.task.id, h.handoff_id, "consumer-00000001", x.scope, () => {})).toThrow("stale_execution");
  });

  it("rejects a different runtime, daemon or workspace", () => {
    const x = setup(), h = x.request();
    for (const scope of [
      { ...x.scope, workspaceId: "another-workspace" },
      { ...x.scope, daemonId: "another-machine" },
      { ...x.scope, runtimeId: "another-runtime" },
    ]) expect(() => x.planned().suspend(x.task.id, h.handoff_id, 0, x.checkpoint, scope)).toThrow("stale_execution");
    expect(x.planned().get(x.task.id)).toEqual(h);
  });

  it("keeps existing crash policy when no acknowledged checkpoint exists", () => {
    const x = setup();
    x.request();
    expect(x.planned().protectsFromOrphanRecovery(x.task.id)).toBe(false);
    expect(x.f.store.recoverOrphans(x.scope.runtimeId)).toEqual({ orphaned: 1, retried: 0 });
    expect(x.f.store.getTask(x.task.id)).toMatchObject({ status: "failed", failureReason: "runtime_recovery" });
  });
});

it("recovers daemon journal and server checkpoint across real SQLite close/open with one authorized consumer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mul31-restart-"));
  const path = join(directory, "store.db");
  let db = openSqliteDatabase(path);
  let second: ReturnType<typeof openSqliteDatabase> | undefined;
  let journal = new PlannedRestartJournal(join(directory, "daemon.db"));
  try {
    let store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    const scope = { workspaceId: "local", runtimeId: "rt_disk", daemonId: "daemon_disk" };
    store.registerRuntime({ id: scope.runtimeId, daemonId: scope.daemonId, name: "Disk", provider: "codex", workspaceId: scope.workspaceId });
    const agent = store.createAgent({ name: "Disk agent", provider: "codex", runtimeId: scope.runtimeId });
    const task = store.createTask({ agentId: agent.id, prompt: "survive SQLite reopen", maxAttempts: 1 });
    store.claimTask(scope.runtimeId); store.startTask(task.id);
    store.beginDaemonDrain(scope.workspaceId, scope.daemonId);
    const h = store.plannedRestarts().request(task.id, scope);
    const savedInput = db.query("SELECT input_ack_seq FROM multiremi_turn_attempts WHERE id=?").get(task.id) as { input_ack_seq: number | null };
    const checkpoint: PlannedRestartCheckpoint = { version: 1, session_id: null, work_dir: null,
      trace_head: 42, input_ack_seq: Number(savedInput.input_ack_seq ?? 0), delivered_message_ids: [] };
    let authorizations = 0;
    let loseResumeResponse = true;
    const remote: PlannedRestartRemote = {
      suspend: async entry => { store.plannedRestarts().suspend(task.id, entry.execution.handoff_id, entry.execution.generation, entry.checkpoint, scope); },
      resume: async entry => {
        const result = store.plannedRestarts().resume(task.id, entry.execution.handoff_id, entry.consumer_id, scope, () => { authorizations++; });
        if (loseResumeResponse) { loseResumeResponse = false; throw new Error("response lost after authorization"); }
        return { generation: result.generation };
      },
    };
    const transfer = new PlannedRestartTransfer(journal, remote);
    const saved = await transfer.suspend({ workspace_id: scope.workspaceId, daemon_id: scope.daemonId,
      runtime_id: scope.runtimeId, turn_id: h.turn_id, attempt_id: task.id, handoff_id: h.handoff_id, generation: 0 }, async () => checkpoint);
    expect(saved.state).toBe("acknowledged");
    journal.close();
    journal = new PlannedRestartJournal(join(directory, "daemon.db"));
    db.close();
    db = openSqliteDatabase(path);
    store = new MultiremiStore(db);
    expect(store.plannedRestarts().get(task.id)?.checkpoint).toEqual(checkpoint);
    store.undrainDaemon(scope.workspaceId, scope.daemonId);
    second = openSqliteDatabase(path);
    const other = new MultiremiStore(second);
    await expect(new PlannedRestartTransfer(journal, remote).resume(h.handoff_id)).rejects.toThrow("response lost after authorization");
    expect(journal.get(h.handoff_id)?.state).toBe("acknowledged");
    journal.close(); journal = new PlannedRestartJournal(join(directory, "daemon.db"));
    expect((await new PlannedRestartTransfer(journal, remote).resume(h.handoff_id)).resumed_generation).toBe(1);
    expect(authorizations).toBe(1);
    expect(() => other.plannedRestarts().resume(task.id, h.handoff_id, "consumer-disk-0002", scope, () => {})).toThrow("stale_execution");
    expect(other.plannedRestarts().resume(task.id, h.handoff_id, saved.consumer_id, scope, () => {}).generation).toBe(1);
    expect(other.getTask(task.id)).toMatchObject({ attempt: 1, maxAttempts: 1, status: "running" });
  } finally {
    journal.close(); second?.close(); db.close(); rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
