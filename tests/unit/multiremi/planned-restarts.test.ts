import { claimWithCurrentRuntime } from "../../helpers/claim-with-current-runtime.js";
import { registerDaemonReportHandlers } from "@multiremi/api/daemon-protocol/report-handlers.js";
import { registerTaskInputRpcs } from "@multiremi/api/daemon-protocol/task-input-rpcs.js";
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
  function setup(maxAttempts = 1) {
    const f = fixture();
    const scope = { workspaceId: "local", runtimeId: "rt_planned", daemonId: "daemon_planned" };
    f.store.registerRuntime({ id: scope.runtimeId, daemonId: scope.daemonId, name: "Planned restart", provider: "codex", workspaceId: scope.workspaceId });
    const agent = f.store.createAgent({ name: "Restart agent", provider: "codex", runtimeId: scope.runtimeId });
    const issue = maxAttempts > 1 ? f.createIssue({ title: "Restart recovery", assigneeType: "agent", assigneeId: agent.id }) : null;
    const task = f.store.createTask({ agentId: agent.id, issueId: issue?.id, prompt: "Continue the same turn", maxAttempts });
    expect(claimWithCurrentRuntime(f.store, scope.runtimeId)?.id).toBe(task.id);
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

  function healthyPeer(x: ReturnType<typeof setup>) {
    x.f.store.updateRuntime(x.scope.runtimeId, { maxConcurrency: 2 });
    const agent = x.f.store.createAgent({ name: "Healthy peer", provider: "codex", runtimeId: x.scope.runtimeId });
    const task = x.f.store.createTask({ agentId: agent.id, prompt: "Keep running", maxAttempts: 1 });
    expect(claimWithCurrentRuntime(x.f.store, x.scope.runtimeId)?.id).toBe(task.id);
    x.f.store.startTask(task.id);
    x.f.store.reportTaskUsageSnapshot(task.id, { version: 2, runId: "healthy-peer-consumer", revision: 0, complete: false, units: [] }, x.scope);
    const snapshot = () => ({ task: x.f.store.getTask(task.id),
      execution: x.f.db.query("SELECT * FROM multiremi_usage_task_scopes WHERE task_id=?").get(task.id) });
    const before = snapshot();
    expect(before.task).toMatchObject({ status: "running", attempt: 1, maxAttempts: 1 });
    return () => expect(snapshot()).toEqual(before);
  }

  it("periodic resume expiry recovers only the target and preserves a healthy peer", () => {
    const x = setup(3), assertPeer = healthyPeer(x), h = x.suspend();
    x.f.store.undrainDaemon(x.scope.workspaceId, x.scope.daemonId);
    x.planned().resume(x.task.id, h.handoff_id, "expired-target-consumer", x.scope, () => {});
    x.f.db.run("UPDATE multiremi_planned_restarts SET updated_at='2000-01-01T00:00:00.000Z' WHERE attempt_id=?", [x.task.id]);
    x.planned().recoverExpiredResumes(x.scope.runtimeId);
    expect(x.f.store.getTask(x.task.id)).toMatchObject({ status: "failed", failureReason: "runtime_recovery" });
    expect(Number(x.f.db.query("SELECT COUNT(*) AS n FROM multiremi_turn_attempts WHERE turn_id=?").get(h.turn_id).n)).toBe(2);
    assertPeer();
  });

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
    expect(resumed).toMatchObject({ generation: 1, state: "resuming", consumer_id: "consumer-00000001" });
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
    x.planned().withExecution(x.task.id, 1, x.scope, () => {}, "consumer-00000001");
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

  it("protects a committed resume with a lost reply until the same consumer starts", () => {
    const x = setup(), h = x.suspend();
    x.f.store.undrainDaemon(x.scope.workspaceId, x.scope.daemonId);
    const consumer = "lost-response-consumer";
    let authorizations = 0;
    const resume = () => x.planned().resume(x.task.id, h.handoff_id, consumer, x.scope, () => { authorizations++; });
    expect(resume().state).toBe("resuming");
    expect(x.f.store.recoverOrphans(x.scope.runtimeId)).toEqual({ orphaned: 0, retried: 0 });
    expect(resume().generation).toBe(1);
    expect(authorizations).toBe(1);
    x.planned().withExecution(x.task.id, 1, x.scope, () => {}, "another-consumer");
    expect(x.planned().protectsFromOrphanRecovery(x.task.id)).toBe(true);
    expect(() => x.planned().withExecution(x.task.id, 0, x.scope, () => {}, consumer)).toThrow("stale_execution");
    x.planned().withExecution(x.task.id, 1, x.scope, () => {}, consumer);
    expect(x.planned().get(x.task.id)?.state).toBe("running");
    expect(x.planned().protectsFromOrphanRecovery(x.task.id)).toBe(false);
  });

  it("expires a no-start resume, fences its consumer and recovers through the crash policy", () => {
    const x = setup(3), h = x.suspend();
    x.f.store.undrainDaemon(x.scope.workspaceId, x.scope.daemonId);
    const consumer = "expired-resume-consumer";
    const resume = () => x.planned().resume(x.task.id, h.handoff_id, consumer, x.scope, () => {
      x.f.store.reportTaskUsageSnapshot(x.task.id, { version: 2, runId: consumer, revision: 0, complete: false, units: [] }, x.scope);
    });
    resume();
    expect(x.f.store.recoverOrphans(x.scope.runtimeId, [])).toEqual({ orphaned: 0, retried: 0 });
    expect(resume().generation).toBe(1);
    x.f.db.run("UPDATE multiremi_planned_restarts SET updated_at='2000-01-01T00:00:00.000Z' WHERE attempt_id=?", [x.task.id]);
    expect(x.f.store.recoverOrphans(x.scope.runtimeId, [])).toEqual({ orphaned: 1, retried: 1 });
    // The server's periodic sweep is also safe after ordinary recovery.
    x.planned().recoverExpiredResumes(x.scope.runtimeId);
    expect(x.f.store.isTaskUsageExecutionAuthorized(x.task.id, consumer, x.scope.runtimeId)).toBe(false);
    expect(() => resume()).toThrow("stale_execution");
    expect(() => x.planned().withExecution(x.task.id, 1, x.scope, () => {} , consumer)).toThrow("stale_execution");
    expect(x.f.store.recoverOrphans(x.scope.runtimeId, [])).toEqual({ orphaned: 0, retried: 0 });
    expect(x.f.store.getTask(x.task.id)).toMatchObject({ status: "failed", failureReason: "runtime_recovery" });
    expect(Number(x.f.db.query("SELECT COUNT(*) AS n FROM multiremi_turn_attempts WHERE turn_id=?").get(h.turn_id).n)).toBe(2);
  });

  it("rejects late start, report and input after an unstarted resume expires", async () => {
    const x = setup(), h = x.suspend(), consumer = "late-expired-consumer";
    x.f.store.undrainDaemon(x.scope.workspaceId, x.scope.daemonId);
    x.planned().resume(x.task.id, h.handoff_id, consumer, x.scope, () => {});
    x.f.db.run("UPDATE multiremi_planned_restarts SET updated_at='2000-01-01T00:00:00.000Z' WHERE attempt_id=?", [x.task.id]);
    const handlers = new Map<string, Function>();
    const register = (type: string, handler: Function) => { handlers.set(type, handler); };
    registerDaemonReportHandlers({ registerEventHandler: register, registerBestEffortHandler: register,
      registerRpcHandler: register } as any, x.f.store);
    const session = { runtimeIds: [x.scope.runtimeId], daemonId: x.scope.daemonId, ownerAccessToken: null };
    const report = (type: string) => handlers.get(type)!({ type, rt: x.scope.runtimeId,
      payload: { task_id: x.task.id, generation: 1, usage_run_id: consumer, summary: "late report" } }, session);
    // Even before the periodic sweep, a delayed start cannot renew the receipt.
    expect(await report("task.start")).toMatchObject({ ok: false, code: "stale_execution" });
    expect(x.f.store.recoverOrphans(x.scope.runtimeId, [])).toEqual({ orphaned: 1, retried: 0 });
    for (const type of ["task.start", "task.progress"]) {
      expect(await report(type)).toMatchObject({ ok: false, code: "stale_execution" });
    }
    expect(x.f.store.getDaemonTurnBridge().rpc("turn.input", { turn_id: h.turn_id, attempt_id: x.task.id,
      generation: 1, input_to_seq: x.offer.input_to_seq, message_ids: x.offer.input_messages.map(message => message.id) }, x.scope))
      .toMatchObject({ ok: false, code: "stale_execution" });
    expect(x.f.store.getTask(x.task.id)?.status).toBe("failed");
    expect(x.planned().get(x.task.id)).toMatchObject({ state: "terminated", consumer_id: null, generation: 2 });
  });

  it("never authorizes a revoked receipt tombstone or exempts it from orphan recovery", () => {
    const x = setup(), h = x.suspend();
    x.f.store.undrainDaemon(x.scope.workspaceId, x.scope.daemonId);
    x.planned().resume(x.task.id, h.handoff_id, "revoked-receipt-consumer", x.scope, () => {});
    // Model the durable state between revocation and crash-policy completion.
    x.f.db.run("UPDATE multiremi_planned_restarts SET state='running',consumer_id=NULL,generation=2 WHERE attempt_id=?", [x.task.id]);
    let writes = 0;
    for (const generation of [undefined, 0, 1, 2, 3]) {
      expect(() => x.planned().withExecution(x.task.id, generation, x.scope, () => ++writes)).toThrow("stale_execution");
      expect(() => x.f.transaction(() => x.planned().assertExecutionWithinTransaction(x.task.id, generation))).toThrow("stale_execution");
    }
    expect(writes).toBe(0);
    expect(x.planned().protectsFromOrphanRecovery(x.task.id)).toBe(false);
    expect(x.f.store.recoverOrphans(x.scope.runtimeId, [])).toEqual({ orphaned: 1, retried: 0 });
    expect(x.f.store.getTask(x.task.id)?.status).toBe("failed");
  });

  it("rejects an oversized canonical recovery before authorization and recovers only that attempt", async () => {
    const x = setup(3), assertPeer = healthyPeer(x), bridge = x.f.store.getDaemonTurnBridge();
    // Each original native request fits a frame, but their complete recovery does not.
    for (let i = 0; i < 2; i++) {
      expect(bridge.rpc("turn.decision", { turn_id: x.offer.turn_id, attempt_id: x.task.id,
        dedupe_key: `large-q-${i}`, wait_id: `large-q-wait-${i}`, body_md: "Choose",
        options: [], metadata: { kind: "question", padding: "x".repeat(600_000),
          questions: [{ fieldKey: "choice", question: { question: "Choose", options: [{ label: "A" }] } }] } }, x.scope).ok).toBe(true);
    }
    const h = x.request();
    const checkpoint = x.planned().checkpointReferences(x.task.id, x.scope);
    expect(checkpoint.question_ids).toHaveLength(2);
    x.planned().suspend(x.task.id, h.handoff_id, 0, checkpoint, x.scope);
    x.f.store.undrainDaemon(x.scope.workspaceId, x.scope.daemonId);
    const handlers = new Map<string, any>();
    const layer = { registerRpcHandler: (type: string, fn: any) => handlers.set(type, fn),
      authorizeRuntimeForTest: async () => ({ ok: true }) };
    registerTaskInputRpcs(layer as any, x.f.store, () => {}, bridge, async () => ({ turn_id: h.turn_id, attempt_id: x.task.id }));
    const consumer = "oversized-resume-consumer";
    const payload = { turn_id: h.turn_id, attempt_id: x.task.id, handoff_id: h.handoff_id, consumer_id: consumer };
    const invoke = () => handlers.get("turn.restart.resume")({ rt: x.scope.runtimeId, payload },
      { runtimeIds: [x.scope.runtimeId], daemonId: x.scope.daemonId, ownerAccessToken: null });
    expect(await invoke()).toMatchObject({ ok: false, code: "capacity", retryable: false });
    expect(x.f.store.getTaskUsageRunRuntime(x.task.id, consumer)).toBeNull();
    expect(x.planned().get(x.task.id)?.consumer_id).toBeNull();
    expect(x.planned().protectsFromOrphanRecovery(x.task.id)).toBe(false);
    expect(x.f.store.getTask(x.task.id)).toMatchObject({ status: "failed", failureReason: "runtime_recovery" });
    expect(Number(x.f.db.query("SELECT COUNT(*) AS n FROM multiremi_turn_attempts WHERE turn_id=?").get(h.turn_id).n)).toBe(2);
    expect(await invoke()).toMatchObject({ ok: false, code: "restart_terminal" });
    assertPeer();
  });

  for (const status of ["lost", "completed", "cancelled", "failed"] as const) {
    it(`terminates a stale running handoff for a ${status} attempt before offer preparation`, async () => {
      const x = setup(3), h = x.suspend();
      x.f.store.undrainDaemon(x.scope.workspaceId, x.scope.daemonId);
      x.planned().resume(x.task.id, h.handoff_id, "stale-restart-consumer", x.scope, () => {});
      x.planned().withExecution(x.task.id, 1, x.scope, () => {}, "stale-restart-consumer");
      x.f.db.run("UPDATE multiremi_turn_attempts SET status=? WHERE id=?", [status, x.task.id]);
      const handlers = new Map<string, any>();
      let prepared = 0;
      registerTaskInputRpcs({ registerRpcHandler: (type: string, fn: any) => handlers.set(type, fn),
        authorizeRuntimeForTest: async () => ({ ok: true }) } as any, x.f.store, () => {}, undefined, async task => {
          prepared++;
          return { ...x.f.store.getDaemonTurnBridge().offerInput(task) };
        });
      const payload = { turn_id: h.turn_id, attempt_id: x.task.id, handoff_id: h.handoff_id,
        consumer_id: "stale-restart-consumer" };
      const invoke = () => handlers.get("turn.restart.resume")({ rt: x.scope.runtimeId, payload },
        { runtimeIds: [x.scope.runtimeId], daemonId: x.scope.daemonId, ownerAccessToken: null });
      expect(await invoke()).toMatchObject({ ok: false, code: "restart_terminal", retryable: false });
      expect(prepared).toBe(0);
      const terminal = x.planned().get(x.task.id);
      expect(terminal).toMatchObject({ state: "terminated", consumer_id: null, generation: 2 });
      expect(await invoke()).toMatchObject({ ok: false, code: "restart_terminal" });
      expect(x.planned().get(x.task.id)).toEqual(terminal);
      expect(x.planned().protectsFromOrphanRecovery(x.task.id)).toBe(false);
    });
  }

  for (const failure of ["null", "throw"] as const) it(`commits terminal cleanup when completion wins offer preparation (${failure})`, async () => {
    const x = setup(), h = x.suspend();
    x.f.store.undrainDaemon(x.scope.workspaceId, x.scope.daemonId);
    const handlers = new Map<string, any>();
    registerTaskInputRpcs({ registerRpcHandler: (type: string, fn: any) => handlers.set(type, fn),
      authorizeRuntimeForTest: async () => ({ ok: true }) } as any, x.f.store, () => {}, undefined, async () => {
        x.f.store.cancelTask(x.task.id);
        if (failure === "throw") throw new Error("stale_attempt");
        return null;
      });
    const reply = await handlers.get("turn.restart.resume")({ rt: x.scope.runtimeId,
      payload: { turn_id: h.turn_id, attempt_id: x.task.id, handoff_id: h.handoff_id, consumer_id: "racing-completion-consumer" } },
      { runtimeIds: [x.scope.runtimeId], daemonId: x.scope.daemonId, ownerAccessToken: null });
    expect(reply).toMatchObject({ ok: false, code: "restart_terminal" });
    expect(x.planned().get(x.task.id)?.state).toBe("terminated");
  });

  it("automatically sweeps legacy running rows after crash retry replaces the attempt", () => {
    const x = setup(3), h = x.suspend();
    x.f.store.undrainDaemon(x.scope.workspaceId, x.scope.daemonId);
    x.planned().resume(x.task.id, h.handoff_id, "old-running-consumer", x.scope, () => {});
    x.planned().withExecution(x.task.id, 1, x.scope, () => {}, "old-running-consumer");
    expect(x.f.store.recoverOrphans(x.scope.runtimeId, [])).toEqual({ orphaned: 1, retried: 1 });
    // Historical level-3 data remains intact until the ordinary safety sweep.
    expect(x.planned().get(x.task.id)?.state).toBe("running");
    x.planned().recoverExpiredResumes(x.scope.runtimeId);
    expect(x.planned().get(x.task.id)?.state).toBe("terminated");
    const terminal = x.planned().get(x.task.id);
    x.planned().recoverExpiredResumes(x.scope.runtimeId);
    expect(x.planned().get(x.task.id)).toEqual(terminal);
    expect(Number(x.f.db.query("SELECT COUNT(*) AS n FROM multiremi_turn_attempts WHERE turn_id=?").get(h.turn_id).n)).toBe(2);
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
    claimWithCurrentRuntime(store, scope.runtimeId); store.startTask(task.id);
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
