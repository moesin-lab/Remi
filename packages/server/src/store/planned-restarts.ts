import { Questions } from "./inbox/questions.js";
import { afterCommit } from "./db/postgres.js";
import { createHash } from "node:crypto";
import type { StoreContext } from "./context.js";
import { PlatformMaintenanceRepo } from "./repos/platform-maintenance-repo.js";
import { lockLane } from "./inbox/lane-machine.js";
import { nowIso } from "@multiremi/ids.js";

import type { PlannedRestartCheckpoint } from "@multiremi/contracts/planned-restart.js";
export type { PlannedRestartCheckpoint } from "@multiremi/contracts/planned-restart.js";

// Fixed grace from the resume CAS, never extended by retries or heartbeat activity.
export const PLANNED_RESTART_START_GRACE_MS = 5 * 60_000;

export interface PlannedRestartScope { workspaceId: string; runtimeId: string; daemonId: string }
export interface PlannedRestartHandoff {
  attempt_id: string;
  turn_id: string;
  handoff_id: string;
  generation: number;
  state: "requested" | "suspended" | "resuming" | "running" | "terminated";
  consumer_id: string | null;
  checkpoint: PlannedRestartCheckpoint | null;
}

export class PlannedRestartError extends Error {
  constructor(readonly code: "stale_execution" | "invalid_checkpoint" | "drain_not_active" | "resume_fenced" | "capacity") { super(code); }
}


function decode(row: any): PlannedRestartHandoff {
  const terminated = row.state === "running" && row.consumer_id === null;
  if (!terminated && row.state !== "requested" && (!row.checkpoint || createHash("sha256").update(row.checkpoint).digest("hex") !== row.checkpoint_sha256)) {
    throw new PlannedRestartError("invalid_checkpoint");
  }
  return { attempt_id: row.attempt_id, turn_id: row.turn_id, handoff_id: row.handoff_id,
    generation: Number(row.generation), state: terminated ? "terminated" : row.state, consumer_id: row.consumer_id,
    checkpoint: !terminated && row.checkpoint ? JSON.parse(row.checkpoint) : null };
}

/**
 * Planned handoff is orthogonal to the user-visible turn/attempt machine. All
 * writers take workspace then lane locks, just like turn completion and retry.
 * No method creates an attempt or advances an input receipt.
 */
export class PlannedRestarts {
  constructor(private readonly ctx: StoreContext) {}

  get(attemptId: string): PlannedRestartHandoff | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_planned_restarts WHERE attempt_id=?").get(attemptId);
    return row ? decode(row) : null;
  }

  pendingForRuntime(runtimeId: string): Map<string, PlannedRestartHandoff> {
    const rows = this.ctx.db.query("SELECT * FROM multiremi_planned_restarts WHERE runtime_id=? AND state IN ('requested','suspended','resuming')").all(runtimeId);
    return new Map(rows.map(row => { const value = decode(row); return [value.attempt_id, value]; }));
  }

  /** Durable terminal receipt uses the existing revoked tombstone encoding,
   * compatible with level-3 databases and older writers (which also fence it).
   * Never decode a checkpoint or hydrate an offer before reconciling liveness. */
  reconcileTerminal(attemptId: string, scope: PlannedRestartScope, handoffId?: string): boolean {
    return this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(scope.workspaceId);
      const p = this.ctx.db.query("SELECT * FROM multiremi_planned_restarts WHERE attempt_id=?").get(attemptId);
      if (!p || p.workspace_id !== scope.workspaceId || p.runtime_id !== scope.runtimeId
        || p.daemon_id !== scope.daemonId || (handoffId !== undefined && p.handoff_id !== handoffId)) return false;
      const a = this.ctx.db.query(`SELECT a.status,t.status AS turn_status,t.current_attempt_id,
        t.session_id,t.agent_id,t.execution_scope FROM multiremi_turn_attempts a
        JOIN multiremi_turns t ON t.id=a.turn_id WHERE a.id=?`).get(attemptId);
      if (!a) return false;
      lockLane(this.ctx, a.session_id, a.agent_id, a.execution_scope);
      if (p.state === "running" && p.consumer_id === null) return true;
      if (a.current_attempt_id === attemptId && ["running", "awaiting_human", "pending"].includes(a.turn_status)
        && ["accepted", "running", "waiting_local_directory"].includes(a.status)) return false;
      this.revokeWithinTransaction(attemptId);
      return true;
    })();
  }

  private lock(attemptId: string, scope: PlannedRestartScope) {
    this.ctx.lockWorkspaceRuntimeLifecycle(scope.workspaceId);
    const runtime = this.ctx.runtimes().getRuntimeLite(scope.runtimeId);
    const row = this.ctx.db.query(`SELECT a.*,t.workspace_id,t.session_id AS conversation_id,
      t.agent_id,t.execution_scope,t.status AS turn_status,t.current_attempt_id
      FROM multiremi_turn_attempts a JOIN multiremi_turns t ON t.id=a.turn_id WHERE a.id=?`).get(attemptId);
    if (!runtime || (runtime.workspaceId ?? "local") !== scope.workspaceId
      || (runtime.daemonId ?? runtime.id) !== scope.daemonId
      || this.ctx.runtimes().isDaemonRetired(scope.workspaceId, scope.daemonId)
      || !row || row.workspace_id !== scope.workspaceId || row.runtime_id !== scope.runtimeId
      || row.current_attempt_id !== attemptId) throw new PlannedRestartError("stale_execution");
    const previous = this.ctx.db.query("SELECT workspace_id,runtime_id,daemon_id FROM multiremi_planned_restarts WHERE attempt_id=?").get(attemptId);
    if (previous && (previous.workspace_id !== scope.workspaceId || previous.runtime_id !== scope.runtimeId
      || previous.daemon_id !== scope.daemonId)) throw new PlannedRestartError("stale_execution");
    lockLane(this.ctx, row.conversation_id, row.agent_id, row.execution_scope);
    return row;
  }

  private assertLive(row: any) {
    if (!["running", "awaiting_human", "pending"].includes(row.turn_status)
      || !["accepted", "running", "waiting_local_directory"].includes(row.status)) throw new PlannedRestartError("stale_execution");
  }

  private drain(scope: PlannedRestartScope) {
    return this.ctx.db.query("SELECT * FROM multiremi_daemon_drains WHERE workspace_id=? AND daemon_id=?")
      .get(scope.workspaceId, scope.daemonId);
  }

  /** Called only after admission is fenced. Replays cannot replace a committed checkpoint. */
  request(attemptId: string, scope: PlannedRestartScope): PlannedRestartHandoff {
    return this.ctx.db.transaction(() => {
      const attempt = this.lock(attemptId, scope);
      this.assertLive(attempt);
      const drain = this.drain(scope);
      if (!drain) throw new PlannedRestartError("drain_not_active");
      const old = this.ctx.db.query("SELECT * FROM multiremi_planned_restarts WHERE attempt_id=?").get(attemptId);
      if (old && old.state !== "running" && (old.state !== "requested" || old.drain_id === drain.drain_id)) return decode(old);
      const at = nowIso();
      // Stable across a lost request response. A new drain has a unique identity;
      // the generation distinguishes multiple handoffs within one fence.
      const generation = Number(old?.generation ?? 0);
      const id = createHash("sha256").update(JSON.stringify([scope.workspaceId, scope.daemonId,
        attemptId, drain.drain_id, generation])).digest("hex");
      this.ctx.db.run(`INSERT INTO multiremi_planned_restarts
        (attempt_id,turn_id,workspace_id,runtime_id,daemon_id,handoff_id,drain_id,generation,state,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,'requested',?,?) ON CONFLICT(attempt_id) DO UPDATE SET
        handoff_id=excluded.handoff_id,drain_id=excluded.drain_id,state='requested',
        consumer_id=NULL,checkpoint=NULL,checkpoint_sha256=NULL,updated_at=excluded.updated_at`,
      [attemptId, attempt.turn_id, scope.workspaceId, scope.runtimeId, scope.daemonId, id,
        drain.drain_id, generation, at, at]);
      afterCommit(this.ctx.db, () => this.ctx.emitWorkspaceEvent({ type: "daemon:task_input", workspaceId: scope.workspaceId,
        actorType: "system", actorId: null, payload: { runtime_id: scope.runtimeId, task_id: attemptId } }));
      return this.get(attemptId)!;
    })();
  }

  /** Provider stopped and local journal fsynced BEFORE this call. CAS races completion. */
  suspend(attemptId: string, handoffId: string, generation: number, checkpoint: PlannedRestartCheckpoint,
    scope: PlannedRestartScope): PlannedRestartHandoff {
    return this.ctx.db.transaction(() => {
      const attempt = this.lock(attemptId, scope);
      this.assertLive(attempt);
      const handoff = this.get(attemptId);
      if (!handoff || handoff.handoff_id !== handoffId || handoff.generation !== generation
        || !["requested", "suspended"].includes(handoff.state)) throw new PlannedRestartError("stale_execution");
      const value = this.validateCheckpoint(checkpoint, attempt);
      const encoded = JSON.stringify(value);
      const digest = createHash("sha256").update(encoded).digest("hex");
      const stored = this.ctx.db.query("SELECT checkpoint_sha256 FROM multiremi_planned_restarts WHERE attempt_id=?").get(attemptId);
      if (handoff.state === "suspended") {
        if (stored.checkpoint_sha256 !== digest) throw new PlannedRestartError("invalid_checkpoint");
        return handoff;
      }
      const drain = this.drain(scope);
      const identity = this.ctx.db.query("SELECT drain_id FROM multiremi_planned_restarts WHERE attempt_id=?").get(attemptId);
      if (!drain || drain.drain_id !== identity.drain_id) throw new PlannedRestartError("drain_not_active");
      this.ctx.db.run(`UPDATE multiremi_planned_restarts SET state='suspended',checkpoint=?,checkpoint_sha256=?,updated_at=?
        WHERE attempt_id=? AND handoff_id=? AND generation=? AND state='requested'`,
      [encoded, digest, nowIso(), attemptId, handoffId, generation]);
      return this.get(attemptId)!;
    })();
  }

  /**
   * Consume the checkpoint CAS and authorize the fresh usage run in ONE
   * transaction. The resuming receipt remains protected until the daemon acknowledges task.start.
   * A duplicate response for the same consumer returns its committed generation.
   */
  resume(attemptId: string, handoffId: string, consumerId: string, scope: PlannedRestartScope,
    deliver: (generation: number, checkpoint: PlannedRestartCheckpoint, phase: 'activate' | 'replay') => void): PlannedRestartHandoff {
    if (this.reconcileTerminal(attemptId, scope, handoffId)) throw new PlannedRestartError("stale_execution");
    return this.ctx.db.transaction(() => {
      const attempt = this.lock(attemptId, scope);
      this.assertLive(attempt);
      if (typeof consumerId !== "string" || consumerId.length < 16 || consumerId.length > 256) throw new PlannedRestartError("stale_execution");
      const handoff = this.get(attemptId);
      if (!handoff || handoff.handoff_id !== handoffId) throw new PlannedRestartError("stale_execution");
      if (handoff.state === "resuming" && this.resumeExpired(attemptId)) throw new PlannedRestartError("stale_execution");
      const replay = ["resuming", "running"].includes(handoff.state) && handoff.consumer_id === consumerId;
      if (!replay && handoff.state !== "suspended") throw new PlannedRestartError("stale_execution");
      // Manual fences survive replacement. Undrain is explicit; a CLI owner
      // must finish candidate verification before any resumed execution.
      if (this.drain(scope) || new PlatformMaintenanceRepo(this.ctx.db).get().mode === "draining") throw new PlannedRestartError("resume_fenced");
      if (replay) {
        deliver(handoff.generation, handoff.checkpoint!, 'replay');
        return handoff;
      }
      const generation = handoff.generation + 1;
      this.ctx.db.run(`UPDATE multiremi_planned_restarts SET state='resuming',consumer_id=?,generation=?,updated_at=?
        WHERE attempt_id=? AND handoff_id=? AND state='suspended'`, [consumerId, generation, nowIso(), attemptId, handoffId]);
      new Questions(this.ctx).preparePlannedRestartResume(attemptId, handoff.handoff_id, generation, handoff.checkpoint?.question_ids ?? []);
      deliver(generation, handoff.checkpoint!, 'activate');
      return this.get(attemptId)!;
    })();
  }

  /** All execution writes (including decisions/input/terminal reports) must call under their lock. */
  assertExecutionWithinTransaction(attemptId: string, generation: number | undefined): void {
    if (!this.ctx.db.inTransaction) throw new Error("Execution generation requires the caller transaction and workspace/lane locks");
    if (generation !== undefined && (!Number.isSafeInteger(generation) || generation < 0)) throw new PlannedRestartError("stale_execution");
    const current = this.get(attemptId);
    this.assertExecution(current, generation);
  }

  private assertExecution(current: PlannedRestartHandoff | null, generation: number | undefined): void {
    if (!current) {
      if ((generation ?? 0) !== 0) throw new PlannedRestartError("stale_execution");
      return;
    }
    // A revoked receipt is a tombstone, never an execution grant, even if a
    // caller guesses its new generation. Expiry also fences late starts before
    // the next safety sweep has applied the ordinary crash policy.
    if ((current.state === "running" && current.consumer_id === null)
      || (current.state === "resuming" && this.resumeExpired(current.attempt_id))) throw new PlannedRestartError("stale_execution");
    if (!["requested", "resuming", "running"].includes(current.state) || current.generation !== (generation ?? 0)) throw new PlannedRestartError("stale_execution");
  }

  private resumeExpired(attemptId: string): boolean {
    const row = this.ctx.db.query("SELECT updated_at FROM multiremi_planned_restarts WHERE attempt_id=?").get(attemptId);
    return !!row && Date.now() - Date.parse(row.updated_at) >= PLANNED_RESTART_START_GRACE_MS;
  }

  /** Transport writes serialize with resume CAS, including the live trace sink. */
  withExecution<T>(attemptId: string, generation: unknown, scope: PlannedRestartScope, write: () => T, startConsumer?: string): T {
    return this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(scope.workspaceId);
      if (generation !== undefined && (!Number.isSafeInteger(generation) || Number(generation) < 0)) throw new PlannedRestartError("stale_execution");
      const current = this.get(attemptId);
      if (current) {
        this.lock(attemptId, scope);
        // Re-read after the lane lock. A handoff may have advanced while
        // acquiring it; the earlier observation is not execution authority.
        this.assertExecutionWithinTransaction(attemptId, generation as number | undefined);
      } else {
        // request() needs this same workspace lock to insert the first handoff.
        // Absence stays valid until commit; avoid an identical second SELECT.
        this.assertExecution(null, generation as number | undefined);
      }
      const result = write();
      // A resume response can be lost after its CAS commits. Only the durable
      // start from that exact consumer proves the daemon received execution.
      if (current?.state === "resuming" && startConsumer === current.consumer_id) {
        this.ctx.db.run("UPDATE multiremi_planned_restarts SET state='running',updated_at=? WHERE attempt_id=? AND state='resuming' AND consumer_id=?",
          [nowIso(), attemptId, startConsumer]);
      }
      return result;
    })();
  }

  /** Read after the provider stopped and its ordered reports were acknowledged. */
  checkpointReferences(attemptId: string, scope: PlannedRestartScope): PlannedRestartCheckpoint {
    return this.ctx.db.transaction(() => {
      const attempt = this.lock(attemptId, scope);
      this.assertLive(attempt);
      if (this.get(attemptId)?.state !== "requested") throw new PlannedRestartError("stale_execution");
      return { version: 1 as const, session_id: attempt.session_id ?? null, work_dir: attempt.work_dir ?? null,
        input_ack_seq: Number(attempt.input_ack_seq ?? 0), trace_head: 0, delivered_message_ids: [],
        question_ids: new Questions(this.ctx).plannedRestartWaits(attemptId).map(message => message.id) };
    })();
  }

  /** The offer safety sweep also handles a replacement that connected once
   * without a usable journal and will never issue another runtime.ready. */
  recoverExpiredResumes(runtimeId: string): void {
    const runtime = this.ctx.runtimes().getRuntimeLite(runtimeId);
    if (!runtime) return;
    this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(runtime.workspaceId ?? "local");
      const stale = this.ctx.db.query(`SELECT p.attempt_id,p.daemon_id FROM multiremi_planned_restarts p
        JOIN multiremi_turn_attempts a ON a.id=p.attempt_id JOIN multiremi_turns t ON t.id=a.turn_id
        WHERE p.runtime_id=? AND NOT (p.state='running' AND p.consumer_id IS NULL)
        AND (a.status NOT IN ('accepted','running','waiting_local_directory')
          OR t.status NOT IN ('running','awaiting_human','pending') OR t.current_attempt_id IS NULL OR t.current_attempt_id<>a.id)`)
        .all(runtimeId);
      for (const row of stale) this.reconcileTerminal(row.attempt_id,
        { workspaceId: runtime.workspaceId ?? "local", runtimeId, daemonId: row.daemon_id });
      const expired = this.ctx.db.query(`SELECT p.attempt_id FROM multiremi_planned_restarts p
        JOIN multiremi_turn_execution_records a ON a.id=p.attempt_id
        WHERE p.runtime_id=? AND p.state='resuming' AND p.updated_at<=?
        AND a.status IN ('running','waiting_local_directory','awaiting_human')`)
        .all(runtimeId, new Date(Date.now() - PLANNED_RESTART_START_GRACE_MS).toISOString());
      for (const row of expired) this.ctx.tasks().recoverOrphanAttempt(runtimeId, row.attempt_id);
    })();
  }

  /** Called only for an absent attempt under recoverOrphans' workspace lock. */
  expireUnstartedResumeWithinTransaction(attemptId: string): void {
    if (!this.ctx.db.inTransaction) throw new Error("Resume expiry requires a lifecycle transaction");
    const row = this.ctx.db.query("SELECT * FROM multiremi_planned_restarts WHERE attempt_id=?").get(attemptId);
    if (!row || row.state !== "resuming" || Date.now() - Date.parse(row.updated_at) < PLANNED_RESTART_START_GRACE_MS) return;
    this.lock(attemptId, { workspaceId: row.workspace_id, runtimeId: row.runtime_id, daemonId: row.daemon_id });
    // The workspace/lane locks serialize this revocation with task.start and
    // resume. Keep accounting history, but revoke execution before crash retry.
    this.revokeWithinTransaction(attemptId);
  }

  private revokeWithinTransaction(attemptId: string): void {
    this.ctx.db.run("UPDATE multiremi_planned_restarts SET state='running',generation=generation+1,consumer_id=NULL,updated_at=? WHERE attempt_id=?",
      [nowIso(), attemptId]);
    this.ctx.db.run("UPDATE multiremi_usage_task_scopes SET active_run_id=NULL WHERE task_id=?", [attemptId]);
    this.ctx.db.run("UPDATE multiremi_access_tokens SET revoked_at=? WHERE type='task' AND task_id=? AND revoked_at IS NULL", [nowIso(), attemptId]);
  }

  /** A complete canonical recovery package cannot be delivered. No new run may start. */
  rejectUndeliverableResume(attemptId: string, handoffId: string, consumerId: string, scope: PlannedRestartScope): void {
    this.ctx.db.transaction(() => {
      const attempt = this.lock(attemptId, scope);
      this.assertLive(attempt);
      const handoff = this.get(attemptId);
      if (!handoff || handoff.handoff_id !== handoffId || (handoff.state !== "suspended"
        && !(handoff.state === "resuming" && handoff.consumer_id === consumerId))) throw new PlannedRestartError("stale_execution");
      this.revokeWithinTransaction(attemptId);
      // Recover only this absent execution, never other tasks on this runtime.
      this.ctx.tasks().recoverOrphanAttempt(scope.runtimeId, attemptId);
    })();
  }

  /** No checkpoint acknowledgement => ordinary crash policy, including a requested handoff. */
  protectsFromOrphanRecovery(attemptId: string): boolean {
    const state = this.get(attemptId)?.state;
    return state === "suspended" || state === "resuming";
  }

  private validateCheckpoint(value: PlannedRestartCheckpoint, attempt: any): PlannedRestartCheckpoint {
    const nonnegative = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
    if (!value || value.version !== 1 || !nonnegative(value.trace_head) || !nonnegative(value.input_ack_seq)
      || value.input_ack_seq !== Number(attempt.input_ack_seq ?? 0)
      || value.session_id !== (attempt.session_id ?? null) || value.work_dir !== (attempt.work_dir ?? null)
      || !Array.isArray(value.delivered_message_ids) || value.delivered_message_ids.length > 1024
      || value.delivered_message_ids.some(id => typeof id !== "string" || !id || id.length > 256)
      || new Set(value.delivered_message_ids).size !== value.delivered_message_ids.length
      || Object.keys(value).some(key => !["version", "session_id", "work_dir", "trace_head", "input_ack_seq", "delivered_message_ids", "question_ids"].includes(key))) {
      throw new PlannedRestartError("invalid_checkpoint");
    }
    const questionIds = value.question_ids ?? [];
    if (!Array.isArray(questionIds) || JSON.stringify(questionIds) !== JSON.stringify(new Questions(this.ctx).plannedRestartWaits(attempt.id).map(message => message.id))) {
      throw new PlannedRestartError("invalid_checkpoint");
    }
    // Each delivered receipt must belong to this conversation and have been
    // offered to this attempt. Never manufacture acknowledgement from a file.
    for (const id of value.delivered_message_ids) {
      const message = this.ctx.db.query(`SELECT seq FROM multiremi_conversation_log
        WHERE id=? AND session_id=? AND kind='message' AND deleted_at IS NULL`).get(id, attempt.conversation_id);
      if (!message || Number(message.seq) > Number(attempt.projection_to_seq ?? 0)) throw new PlannedRestartError("invalid_checkpoint");
    }
    return { version: 1, session_id: value.session_id, work_dir: value.work_dir, trace_head: value.trace_head,
      input_ack_seq: value.input_ack_seq, delivered_message_ids: [...value.delivered_message_ids],
      ...(value.question_ids ? { question_ids: [...value.question_ids] } : {}) };
  }
}
