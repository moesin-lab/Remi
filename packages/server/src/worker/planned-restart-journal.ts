import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openSqliteDatabase } from "../store/db/sqlite.js";
import type { PlannedRestartCheckpoint } from "@multiremi/contracts/planned-restart.js";

export interface RestartExecution {
  workspace_id: string;
  daemon_id: string;
  runtime_id: string;
  turn_id: string;
  attempt_id: string;
  handoff_id: string;
  generation: number;
}
export interface RestartJournalEntry {
  execution: RestartExecution;
  checkpoint: PlannedRestartCheckpoint;
  /** Created before any resume RPC; response loss cannot create a second consumer. */
  consumer_id: string;
  state: "prepared" | "acknowledged" | "resumed";
  resumed_generation: number | null;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function encode(execution: RestartExecution, checkpoint: PlannedRestartCheckpoint): string {
  const ids = [execution.workspace_id, execution.daemon_id, execution.runtime_id, execution.turn_id,
    execution.attempt_id, execution.handoff_id];
  const counter = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
  if (ids.some(id => typeof id !== "string" || !id || id.length > 256)
    || !counter(execution.generation) || execution.generation >= Number.MAX_SAFE_INTEGER
    || checkpoint.version !== 1 || !counter(checkpoint.trace_head) || !counter(checkpoint.input_ack_seq)
    || [checkpoint.session_id, checkpoint.work_dir].some(value => value !== null && (typeof value !== "string" || value.length > 8192))
    || !Array.isArray(checkpoint.delivered_message_ids) || checkpoint.delivered_message_ids.length > 1024
    || checkpoint.delivered_message_ids.some(id => typeof id !== "string" || !id || id.length > 256)
    || new Set(checkpoint.delivered_message_ids).size !== checkpoint.delivered_message_ids.length
    || Object.keys(execution).some(key => !["workspace_id", "daemon_id", "runtime_id", "turn_id", "attempt_id", "handoff_id", "generation"].includes(key))
    || Object.keys(checkpoint).some(key => !["version", "session_id", "work_dir", "trace_head", "input_ack_seq", "delivered_message_ids"].includes(key))) {
    throw new Error("Invalid planned restart journal entry");
  }
  // Canonical field order makes retries insensitive to object construction order.
  return JSON.stringify({ execution: { workspace_id: execution.workspace_id, daemon_id: execution.daemon_id,
    runtime_id: execution.runtime_id, turn_id: execution.turn_id, attempt_id: execution.attempt_id,
    handoff_id: execution.handoff_id, generation: execution.generation }, checkpoint: {
    version: 1, session_id: checkpoint.session_id, work_dir: checkpoint.work_dir, trace_head: checkpoint.trace_head,
    input_ack_seq: checkpoint.input_ack_seq, delivered_message_ids: checkpoint.delivered_message_ids } });
}

/**
 * Process-local evidence of a stopped execution. FULL synchronous commits precede
 * the server checkpoint RPC. A prepared row is NOT permission to exclude orphans
 * or decrement the drain count: only the server's checkpoint acknowledgement is.
 */
export class PlannedRestartJournal {
  private readonly db: Database;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = openSqliteDatabase(path, { create: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS planned_restart_journal (
        handoff_id TEXT PRIMARY KEY, payload TEXT NOT NULL, sha256 TEXT NOT NULL,
        consumer_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','acknowledged','resumed')),
        resumed_generation INTEGER
      );`);
  }

  prepare(execution: RestartExecution, checkpoint: PlannedRestartCheckpoint): RestartJournalEntry {
    const payload = encode(execution, checkpoint);
    return this.db.transaction(() => {
      const old = this.get(execution.handoff_id);
      if (old) {
        if (encode(old.execution, old.checkpoint) !== payload) throw new Error("Planned restart journal conflict");
        return old;
      }
      this.db.run(`INSERT INTO planned_restart_journal (handoff_id,payload,sha256,consumer_id,state)
        VALUES (?,?,?,?,'prepared')`, [execution.handoff_id, payload, digest(payload), randomUUID()]);
      return this.get(execution.handoff_id)!;
    })();
  }

  get(handoffId: string): RestartJournalEntry | null {
    const row = this.db.query("SELECT * FROM planned_restart_journal WHERE handoff_id=?").get(handoffId) as {
      payload: string; sha256: string; consumer_id: string; state: RestartJournalEntry["state"]; resumed_generation: number | null;
    } | null;
    if (!row) return null;
    if (digest(row.payload) !== row.sha256) throw new Error("Corrupt planned restart journal");
    const value = JSON.parse(row.payload) as Pick<RestartJournalEntry, "execution" | "checkpoint">;
    if (encode(value.execution, value.checkpoint) !== row.payload || value.execution.handoff_id !== handoffId
      || !["prepared", "acknowledged", "resumed"].includes(row.state)
      || typeof row.consumer_id !== "string" || row.consumer_id.length < 16
      || (row.state === "resumed" ? row.resumed_generation !== value.execution.generation + 1 : row.resumed_generation !== null)) {
      throw new Error("Corrupt planned restart journal");
    }
    return { ...value, consumer_id: row.consumer_id, state: row.state, resumed_generation: row.resumed_generation };
  }

  entries(): RestartJournalEntry[] {
    const rows = this.db.query("SELECT handoff_id FROM planned_restart_journal ORDER BY handoff_id").all() as { handoff_id: string }[];
    return rows.map(row => this.get(row.handoff_id)!);
  }

  acknowledge(handoffId: string): void {
    this.db.transaction(() => {
      if (!this.get(handoffId)) throw new Error("Missing planned restart journal entry");
      this.db.run("UPDATE planned_restart_journal SET state='acknowledged' WHERE handoff_id=? AND state='prepared'", [handoffId]);
    })();
  }

  resumed(handoffId: string, generation: number): void {
    this.db.transaction(() => {
      const entry = this.get(handoffId);
      if (!entry || entry.state === "prepared" || generation !== entry.execution.generation + 1) throw new Error("Invalid planned restart resume receipt");
      this.db.run("UPDATE planned_restart_journal SET state='resumed',resumed_generation=? WHERE handoff_id=?", [generation, handoffId]);
    })();
  }

  close(): void { this.db.close(); }
}

export interface PlannedRestartRemote {
  /** Must resolve only after the server has committed the matching checkpoint. */
  suspend(entry: RestartJournalEntry): Promise<void>;
  /** Must perform server resume CAS + fresh execution authorization atomically. */
  resume(entry: RestartJournalEntry): Promise<{ generation: number }>;
}

/** Ordering shared by manual/deploy/update adapters; not yet wired into daemon.ts. */
export class PlannedRestartTransfer {
  private readonly stopping = new Map<string, { execution: string; pending: Promise<RestartJournalEntry> }>();
  constructor(private readonly journal: PlannedRestartJournal, private readonly remote: PlannedRestartRemote) {}

  suspend(execution: RestartExecution, stopAtSafePoint: () => Promise<PlannedRestartCheckpoint>): Promise<RestartJournalEntry> {
    execution = { ...execution };
    const identity = JSON.stringify(JSON.parse(encode(execution, { version: 1, session_id: null, work_dir: null,
      trace_head: 0, input_ack_seq: 0, delivered_message_ids: [] })).execution);
    const inFlight = this.stopping.get(execution.handoff_id);
    if (inFlight) {
      if (inFlight.execution !== identity) return Promise.reject(new Error("Planned restart journal conflict"));
      return inFlight.pending;
    }
    const pending = this.suspendOnce(execution, stopAtSafePoint).finally(() => this.stopping.delete(execution.handoff_id));
    this.stopping.set(execution.handoff_id, { execution: identity, pending });
    return pending;
  }

  private async suspendOnce(execution: RestartExecution, stopAtSafePoint: () => Promise<PlannedRestartCheckpoint>): Promise<RestartJournalEntry> {
    let entry = this.journal.get(execution.handoff_id);
    if (entry && JSON.stringify(entry.execution) !== JSON.stringify(JSON.parse(encode(execution, entry.checkpoint)).execution)) {
      throw new Error("Planned restart journal conflict");
    }
    if (!entry) {
      // The adapter must stop provider output and flush reports/trace before
      // returning. If it fails, there is no local or server suspension receipt.
      const checkpoint = await stopAtSafePoint();
      entry = this.journal.prepare(execution, checkpoint);
    }
    if (entry.state === "prepared") {
      await this.remote.suspend(entry);
      this.journal.acknowledge(execution.handoff_id);
    }
    return this.journal.get(execution.handoff_id)!;
  }

  /** New process retries ambiguous checkpoint RPCs before requesting activation. */
  async resume(handoffId: string): Promise<RestartJournalEntry> {
    let entry = this.journal.get(handoffId);
    if (!entry) throw new Error("Missing planned restart journal entry");
    if (entry.state === "prepared") {
      await this.remote.suspend(entry);
      this.journal.acknowledge(handoffId);
      entry = this.journal.get(handoffId)!;
    }
    // Even for a local resumed receipt, recheck remote authority. Cancellation
    // or another execution after a process crash must not be revived locally.
    const receipt = await this.remote.resume(entry);
    this.journal.resumed(handoffId, receipt.generation);
    return this.journal.get(handoffId)!;
  }
}
