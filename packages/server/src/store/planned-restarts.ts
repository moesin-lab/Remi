import { createHash } from "node:crypto";
import type { StoreContext } from "./context.js";
import { PlatformMaintenanceRepo } from "./repos/platform-maintenance-repo.js";
import { lockLane } from "./inbox/lane-machine.js";
import { nowIso } from "@multiremi/ids.js";

/** A checkpoint contains references and receipts, never credentials or message bodies. */
export interface PlannedRestartCheckpoint {
  version: 1;
  session_id: string | null;
  work_dir: string | null;
  trace_head: number;
  input_ack_seq: number;
  delivered_message_ids: string[];
}
export interface PlannedRestartScope { workspaceId: string; runtimeId: string; daemonId: string }
export interface PlannedRestartHandoff {
  attempt_id: string;
  turn_id: string;
  handoff_id: string;
  generation: number;
  state: "requested" | "suspended" | "resuming" | "running";
  consumer_id: string | null;
  checkpoint: PlannedRestartCheckpoint | null;
}

export class PlannedRestartError extends Error {
  constructor(readonly code: "stale_execution" | "invalid_checkpoint" | "drain_not_active" | "resume_fenced") { super(code); }
}


function decode(row: any): PlannedRestartHandoff {
  if (row.state !== "requested" && (!row.checkpoint || createHash("sha256").update(row.checkpoint).digest("hex") !== row.checkpoint_sha256)) {
    throw new PlannedRestartError("invalid_checkpoint");
  }
  return { attempt_id: row.attempt_id, turn_id: row.turn_id, handoff_id: row.handoff_id,
    generation: Number(row.generation), state: row.state, consumer_id: row.consumer_id,
    checkpoint: row.checkpoint ? JSON.parse(row.checkpoint) : null };
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
   * transaction. There is no committed resuming lease to strand on a crash.
   * A duplicate response for the same consumer returns its committed generation.
   */
  resume(attemptId: string, handoffId: string, consumerId: string, scope: PlannedRestartScope,
    authorize: (generation: number, checkpoint: PlannedRestartCheckpoint) => void): PlannedRestartHandoff {
    return this.ctx.db.transaction(() => {
      const attempt = this.lock(attemptId, scope);
      this.assertLive(attempt);
      if (typeof consumerId !== "string" || consumerId.length < 16 || consumerId.length > 256) throw new PlannedRestartError("stale_execution");
      const handoff = this.get(attemptId);
      if (!handoff || handoff.handoff_id !== handoffId) throw new PlannedRestartError("stale_execution");
      if (handoff.state === "running" && handoff.consumer_id === consumerId) return handoff;
      if (handoff.state !== "suspended") throw new PlannedRestartError("stale_execution");
      // Manual fences survive replacement. Undrain is explicit; a CLI owner
      // must finish candidate verification before any resumed execution.
      if (this.drain(scope) || new PlatformMaintenanceRepo(this.ctx.db).get().mode === "draining") throw new PlannedRestartError("resume_fenced");
      const generation = handoff.generation + 1;
      this.ctx.db.run(`UPDATE multiremi_planned_restarts SET state='resuming',consumer_id=?,generation=?,updated_at=?
        WHERE attempt_id=? AND handoff_id=? AND state='suspended'`, [consumerId, generation, nowIso(), attemptId, handoffId]);
      authorize(generation, handoff.checkpoint!);
      this.ctx.db.run("UPDATE multiremi_planned_restarts SET state='running',updated_at=? WHERE attempt_id=?", [nowIso(), attemptId]);
      return this.get(attemptId)!;
    })();
  }

  /** All execution writes (including decisions/input/terminal reports) must call under their lock. */
  assertExecutionWithinTransaction(attemptId: string, generation: number | undefined): void {
    if (!this.ctx.db.inTransaction) throw new Error("Execution generation requires the caller transaction and workspace/lane locks");
    const current = this.get(attemptId);
    if (!current) {
      if ((generation ?? 0) !== 0) throw new PlannedRestartError("stale_execution");
      return;
    }
    if (!["requested", "running"].includes(current.state) || current.generation !== (generation ?? 0)) throw new PlannedRestartError("stale_execution");
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
      || Object.keys(value).some(key => !["version", "session_id", "work_dir", "trace_head", "input_ack_seq", "delivered_message_ids"].includes(key))) {
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
      input_ack_seq: value.input_ack_seq, delivered_message_ids: [...value.delivered_message_ids] };
  }
}
