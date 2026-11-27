import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { openSqliteDatabase } from "../store/db/sqlite.js";
import { ROOT_DELIVERY_RECEIVER_STATES, type RootDeliveryTuple, type RootDeliveryReceiverState, type RootExecutionLocator } from '@multiremi/contracts/root-delivery.js';
import { serializeRootDeliveryTuple } from './root-delivery-envelope.js';
import { isRestartPolicyReceipt, type PlannedRestartCheckpoint } from "@multiremi/contracts/planned-restart.js";
import { parseTraceTranslatorCheckpoint, TRACE_TRANSLATOR_CHECKPOINT_MAX_BYTES, type TraceTranslatorCheckpoint } from "./trace-translator.js";

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

export const RESTART_RECOVERY_LIMIT_MS = 30 * 60_000;
export const RESTART_RECOVERY_MAX_ATTEMPTS = 24;

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
// Local storage format, independent of peer capability negotiation.
function identityCheckpoint(traceHead: number): PlannedRestartCheckpoint {
  return { version: 1, session_id: null, work_dir: null, trace_head: traceHead, input_ack_seq: 0, delivered_message_ids: [] };
}
function encode(execution: RestartExecution, checkpoint: PlannedRestartCheckpoint): string {
  switch (checkpoint.version) { case 1: break; default: throw new Error("Invalid planned restart journal entry"); }
  const ids = [execution.workspace_id, execution.daemon_id, execution.runtime_id, execution.turn_id,
    execution.attempt_id, execution.handoff_id];
  const counter = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
  if (ids.some(id => typeof id !== "string" || !id || id.length > 256)
    || !counter(execution.generation) || execution.generation >= Number.MAX_SAFE_INTEGER
    || !counter(checkpoint.trace_head) || !counter(checkpoint.input_ack_seq)
    || (checkpoint.policy_receipt !== undefined && !isRestartPolicyReceipt(checkpoint.policy_receipt))
    || [checkpoint.session_id, checkpoint.work_dir].some(value => value !== null && (typeof value !== "string" || value.length > 8192))
    || !Array.isArray(checkpoint.delivered_message_ids) || checkpoint.delivered_message_ids.length > 1024
    || checkpoint.delivered_message_ids.some(id => typeof id !== "string" || !id || id.length > 256)
    || new Set(checkpoint.delivered_message_ids).size !== checkpoint.delivered_message_ids.length
    || (checkpoint.question_ids !== undefined && (!Array.isArray(checkpoint.question_ids) || checkpoint.question_ids.length > 1024
      || checkpoint.question_ids.some(id => typeof id !== "string" || !id || id.length > 256)
      || new Set(checkpoint.question_ids).size !== checkpoint.question_ids.length))
    || Object.keys(execution).some(key => !["workspace_id", "daemon_id", "runtime_id", "turn_id", "attempt_id", "handoff_id", "generation"].includes(key))
    || Object.keys(checkpoint).some(key => !["version", "session_id", "work_dir", "trace_head", "input_ack_seq", "delivered_message_ids", "question_ids", "policy_receipt"].includes(key))) {
    throw new Error("Invalid planned restart journal entry");
  }
  // Canonical field order makes retries insensitive to object construction order.
  return JSON.stringify({ execution: { workspace_id: execution.workspace_id, daemon_id: execution.daemon_id,
    runtime_id: execution.runtime_id, turn_id: execution.turn_id, attempt_id: execution.attempt_id,
    handoff_id: execution.handoff_id, generation: execution.generation }, checkpoint: {
    version: 1, session_id: checkpoint.session_id, work_dir: checkpoint.work_dir, trace_head: checkpoint.trace_head,
    input_ack_seq: checkpoint.input_ack_seq, delivered_message_ids: checkpoint.delivered_message_ids,
    ...(checkpoint.question_ids ? { question_ids: checkpoint.question_ids } : {}),
    ...(checkpoint.policy_receipt ? {policy_receipt:checkpoint.policy_receipt} : {}) } });
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
      );
      CREATE TABLE IF NOT EXISTS planned_restart_retries (
        handoff_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL, next_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS planned_restart_holds (handoff_id TEXT PRIMARY KEY, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS planned_restart_launches (handoff_id TEXT PRIMARY KEY, consumer_id TEXT NOT NULL, generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS planned_restart_trace_identities (
        handoff_id TEXT PRIMARY KEY, payload TEXT NOT NULL, sha256 TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS root_execution_receivers (
        receipt_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, generation INTEGER NOT NULL,
        binding TEXT NOT NULL, envelope_digest TEXT NOT NULL, launch_identity TEXT NOT NULL UNIQUE,
        locator TEXT, started_at TEXT, state TEXT NOT NULL CHECK(state IN ('received','installed','confirmed','started')),
        UNIQUE(attempt_id,generation)
      );`);
  }

  rootExecutions(runtimeId: string) {
    return this.db.query<{ binding: string; digest: string }, [string]>(`SELECT binding,envelope_digest AS digest
      FROM root_execution_receivers current WHERE json_extract(binding,'$.runtime_id')=? AND NOT EXISTS
      (SELECT 1 FROM root_execution_receivers newer WHERE newer.attempt_id=current.attempt_id AND newer.generation>current.generation)`)
      .all(runtimeId).map(row => ({tuple: JSON.parse(row.binding) as RootDeliveryTuple, digest: row.digest}));
  }

  rootEnvelopeDigest(tuple: RootDeliveryTuple): string {
    const row = this.db.query<{digest:string}, [string,string]>(`SELECT envelope_digest AS digest FROM root_execution_receivers current
      WHERE receipt_id=? AND binding=? AND NOT EXISTS (SELECT 1 FROM root_execution_receivers newer
      WHERE newer.attempt_id=current.attempt_id AND newer.generation>current.generation)`).get(tuple.receipt_id, serializeRootDeliveryTuple(tuple));
    if (!row) throw new Error('stale_execution');
    return row.digest;
  }

  receiveRootExecution(tuple: RootDeliveryTuple, envelopeDigest: string): {
    launchIdentity: string; state: RootDeliveryReceiverState; locator: RootExecutionLocator | null;
  } {
    const binding = serializeRootDeliveryTuple(tuple);
    if (!/^sha256:[0-9a-f]{64}$/.test(envelopeDigest)) throw new Error('Invalid envelope digest');
    return this.db.transaction(() => {
      const latest = this.db.query<{ generation: number; binding: string }, [string]>(
        'SELECT generation,binding FROM root_execution_receivers WHERE attempt_id=? ORDER BY generation DESC LIMIT 1',
      ).get(tuple.attempt_id);
      if (latest && (latest.generation > tuple.run_generation ||
          JSON.parse(latest.binding).material_version > tuple.material_version)) throw new Error('stale_execution');
      this.db.run(`INSERT INTO root_execution_receivers(receipt_id,attempt_id,generation,binding,envelope_digest,launch_identity,state)
        VALUES(?,?,?,?,?,?,'received') ON CONFLICT DO NOTHING`,
        [tuple.receipt_id, tuple.attempt_id, tuple.run_generation, binding, envelopeDigest, randomUUID()]);
      const stored = this.db.query<{ launchIdentity: string; state: RootDeliveryReceiverState; locator: string | null; startedAt: string | null }, [string, string, string]>(
        'SELECT launch_identity AS launchIdentity,state,locator,started_at AS startedAt FROM root_execution_receivers WHERE receipt_id=? AND binding=? AND envelope_digest=?',
      ).get(tuple.receipt_id, binding, envelopeDigest);
      if (!stored) throw new Error('receipt_conflict');
      const identity = stored.locator && JSON.parse(stored.locator);
      return { launchIdentity: stored.launchIdentity, state: stored.state, locator: identity && {
        execution_id: identity[0], birth_token_id: identity[1], launch_identity: stored.launchIdentity, carrier_mode: 'immutable_run_env',
        runtime_id: tuple.runtime_id, daemon_id: tuple.daemon_id, incarnation: tuple.incarnation, started_at: stored.startedAt,
      } };
    }).immediate();
  }

  advanceRootExecution(tuple: RootDeliveryTuple, envelopeDigest: string, locator: RootExecutionLocator,
    next: Exclude<RootDeliveryReceiverState, 'received'>): void {
    const binding = serializeRootDeliveryTuple(tuple);
    if (locator.runtime_id !== tuple.runtime_id || locator.daemon_id !== tuple.daemon_id || locator.incarnation !== tuple.incarnation ||
        locator.carrier_mode !== 'immutable_run_env' || !locator.execution_id || !locator.birth_token_id ||
        [locator.execution_id, locator.birth_token_id, locator.launch_identity].some(value => typeof value !== 'string' || !value || value.length > 512)) {
      throw new Error('stale_execution');
    }
    const identity = JSON.stringify([locator.execution_id, locator.birth_token_id, locator.launch_identity]);
    const previous = ROOT_DELIVERY_RECEIVER_STATES[ROOT_DELIVERY_RECEIVER_STATES.indexOf(next) - 1];
    if (!previous || (next === 'started' ? !Number.isFinite(Date.parse(locator.started_at ?? '')) : locator.started_at !== null)) throw new Error('Invalid receiver transition');
    const result = this.db.run(`UPDATE root_execution_receivers SET locator=?,state=?,started_at=?,launch_identity=?
      WHERE receipt_id=? AND binding=? AND envelope_digest=? AND (launch_identity=? OR (state='received' AND locator IS NULL)) AND state IN (?,?)
        AND NOT EXISTS (SELECT 1 FROM root_execution_receivers newer WHERE newer.attempt_id=root_execution_receivers.attempt_id
          AND newer.generation>root_execution_receivers.generation)
        AND (locator IS NULL OR locator=?) AND (started_at IS NULL OR started_at=?)`,
      [identity, next, locator.started_at, locator.launch_identity, tuple.receipt_id, binding, envelopeDigest, locator.launch_identity, previous, next, identity, locator.started_at]);
    if (result.changes !== 1) throw new Error('receipt_conflict');
  }

  /** Optional local optimization, never part of server continuation authority. */
  saveTraceIdentities(execution: RestartExecution, traceHead: number, state: TraceTranslatorCheckpoint): void {
    if (!parseTraceTranslatorCheckpoint(state)) throw new Error("Invalid trace identity snapshot");
    const binding = JSON.parse(encode(execution, identityCheckpoint(traceHead))).execution;
    const payload = JSON.stringify({ execution: binding, trace_head: traceHead, state });
    if (Buffer.byteLength(payload) > TRACE_TRANSLATOR_CHECKPOINT_MAX_BYTES + 8192) throw new Error("Trace identity snapshot exceeds local limit");
    this.db.run(`INSERT INTO planned_restart_trace_identities(handoff_id,payload,sha256) VALUES(?,?,?)
      ON CONFLICT(handoff_id) DO UPDATE SET payload=excluded.payload,sha256=excluded.sha256`,
    [execution.handoff_id, payload, digest(payload)]);
  }

  /** Missing or invalid snapshots must never stop an authorized resume. */
  traceIdentities(entry: RestartJournalEntry, warn: (reason: string) => void): TraceTranslatorCheckpoint | null {
    try {
      const row = this.db.query("SELECT payload,sha256 FROM planned_restart_trace_identities WHERE handoff_id=?")
        .get(entry.execution.handoff_id) as { payload: string; sha256: string } | null;
      if (!row) throw new Error("trace identity snapshot missing");
      if (Buffer.byteLength(row.payload) > TRACE_TRANSLATOR_CHECKPOINT_MAX_BYTES + 8192 || digest(row.payload) !== row.sha256)
        throw new Error("trace identity snapshot digest mismatch");
      const value = JSON.parse(row.payload);
      if (value.trace_head !== entry.checkpoint.trace_head
          || encode(value.execution, entry.checkpoint) !== encode(entry.execution, entry.checkpoint))
        throw new Error("trace identity snapshot binding mismatch");
      const state = parseTraceTranslatorCheckpoint(value.state);
      if (!state) throw new Error("trace identity snapshot invalid");
      return state;
    } catch (error) {
      try { warn(error instanceof Error ? error.message : "trace identity snapshot unavailable"); } catch { /* Diagnostics cannot prevent continuation. */ }
      return null;
    }
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
    return PlannedRestartJournal.read(this.db, handoffId);
  }

  private static read(db: Database, handoffId: string): RestartJournalEntry | null {
    const row = db.query("SELECT * FROM planned_restart_journal WHERE handoff_id=?").get(handoffId) as {
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

  static discover(scope: {server: string; workspace: string; daemon: string; provider: string; legacyPath: string}) {
    const directory = dirname(scope.legacyPath);
    if (scope.legacyPath === ':memory:' || !existsSync(directory)) return [];
    const sources = readdirSync(directory).flatMap(name => {
      const match = /^restart-(.+)-([a-f0-9]{16})\.db$/.exec(name);
      if (!match) return [];
      const provider = match[1]!;
      const path = provider === scope.provider ? scope.legacyPath : join(directory, `${provider}-${digest([scope.server, scope.workspace, scope.daemon, provider].join('|')).slice(0,16)}.db`);
      return digest(path).slice(0,16) === match[2] ? [{journal:join(directory,name),path}] : [];
    });
    const incidents: Array<{ source:string; handoff:string; attempt:string|null; legacyPaths:string[]; awaitingGrant?:boolean }> = [];
    for (const source of sources) {
      const db = openSqliteDatabase(source.journal,{readonly:true});
      try {
        const rows = db.query('SELECT handoff_id FROM planned_restart_journal').all() as Array<{handoff_id:string}>;
        for (const {handoff_id:handoff} of rows) {
          let attempt: string | null = null;
          try {
            const entry = this.read(db,handoff);
            if (entry?.execution.workspace_id === scope.workspace && entry.execution.daemon_id === scope.daemon) {
              if (entry.checkpoint.policy_receipt) {
                const table = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='planned_restart_launches'").get();
                incidents.push({source:source.journal,handoff,attempt:entry.execution.attempt_id,legacyPaths:[],awaitingGrant:!table || !this.launched(db,entry)});
                continue;
              }
              attempt = entry.execution.attempt_id;
            }
          } catch {
            const table = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='planned_restart_trace_identities'").get();
            const trace = table ? db.query('SELECT payload,sha256 FROM planned_restart_trace_identities WHERE handoff_id=?').get(handoff) as {payload:string;sha256:string} | null : null;
            if (trace && digest(trace.payload) === trace.sha256) {
              try {
                const value = JSON.parse(trace.payload);
                encode(value.execution,identityCheckpoint(value.trace_head));
                if (value.execution.handoff_id === handoff && value.execution.workspace_id === scope.workspace && value.execution.daemon_id === scope.daemon && parseTraceTranslatorCheckpoint(value.state)) attempt = value.execution.attempt_id;
              } catch { attempt = null; }
            }
          }
          incidents.push({source:source.journal,handoff,attempt,legacyPaths:[source.path]});
        }
      } finally { db.close(); }
    }
    return incidents;
  }

  entries(): RestartJournalEntry[] {
    const rows = this.db.query("SELECT handoff_id FROM planned_restart_journal ORDER BY handoff_id").all() as { handoff_id: string }[];
    return rows.flatMap(row => {
      try { return [this.get(row.handoff_id)!]; }
      catch { this.hold(row.handoff_id); return []; }
    });
  }

  private static launched(db: Database, entry: RestartJournalEntry): boolean {
    return entry.state === 'resumed' && Boolean(db.query('SELECT 1 FROM planned_restart_launches WHERE handoff_id=? AND consumer_id=? AND generation=?')
      .get(entry.execution.handoff_id,entry.consumer_id,entry.resumed_generation));
  }

  awaitingRecovery(): RestartJournalEntry[] {
    return this.entries().filter(entry => !PlannedRestartJournal.launched(this.db,entry));
  }

  hold(handoffId: string): void {
    this.db.run("INSERT OR IGNORE INTO planned_restart_holds(handoff_id,reason) VALUES(?,'restart_policy_unverifiable')",[handoffId]);
  }

  claimLaunch(entry: RestartJournalEntry): boolean {
    if (!entry.checkpoint.policy_receipt || entry.state !== 'resumed' || entry.resumed_generation !== entry.execution.generation + 1) return false;
    return this.db.run(`INSERT INTO planned_restart_launches(handoff_id,consumer_id,generation)
      SELECT handoff_id,consumer_id,resumed_generation FROM planned_restart_journal WHERE handoff_id=? AND consumer_id=? AND state='resumed'
      AND resumed_generation=? ON CONFLICT(handoff_id) DO NOTHING`, [entry.execution.handoff_id,entry.consumer_id,entry.resumed_generation]).changes === 1;
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

  /** Reserve a retry before sending, so process crashes cannot reset the budget. */
  reserveResume(handoffId: string, now = Date.now()): "ready" | "waiting" | "expired" {
    return this.db.transaction(() => {
      this.db.run(`INSERT INTO planned_restart_retries(handoff_id,started_at,attempts,next_at)
        VALUES(?,?,0,?) ON CONFLICT(handoff_id) DO NOTHING`, [handoffId, now, now]);
      const row = this.db.query("SELECT * FROM planned_restart_retries WHERE handoff_id=?").get(handoffId) as {
        started_at: number; attempts: number; next_at: number;
      };
      if (now - row.started_at >= RESTART_RECOVERY_LIMIT_MS || row.attempts >= RESTART_RECOVERY_MAX_ATTEMPTS) return "expired";
      if (now < row.next_at) return "waiting";
      const delay = Math.min(60_000, 1000 * 2 ** Math.min(row.attempts, 6));
      this.db.run("UPDATE planned_restart_retries SET attempts=attempts+1,next_at=? WHERE handoff_id=?", [now + delay, handoffId]);
      return "ready";
    })();
  }

  remove(handoffId: string): void {
    this.db.transaction(() => {
      if (this.db.query('SELECT 1 FROM planned_restart_holds WHERE handoff_id=?').get(handoffId)) return;
      this.db.run("DELETE FROM planned_restart_trace_identities WHERE handoff_id=?", [handoffId]);
      this.db.run("DELETE FROM planned_restart_retries WHERE handoff_id=?", [handoffId]);
      this.db.run("DELETE FROM planned_restart_journal WHERE handoff_id=?", [handoffId]);
    })();
  }

  close(): void { this.db.close(); }
}

export interface PlannedRestartRemote {
  preflight?(entry: RestartJournalEntry): Promise<boolean>;
  /** Must resolve only after the server has committed the matching checkpoint. */
  suspend(entry: RestartJournalEntry): Promise<void>;
  /** Must perform server resume CAS + fresh execution authorization atomically. */
  resume(entry: RestartJournalEntry): Promise<{ generation: number }>;
}

/** Ordering shared by manual/deploy/update adapters; used by daemon.ts after provider shutdown. */
export class PlannedRestartTransfer {
  private readonly stopping = new Map<string, { execution: string; pending: Promise<RestartJournalEntry> }>();
  constructor(private readonly journal: PlannedRestartJournal, private readonly remote: PlannedRestartRemote) {}

  suspend(execution: RestartExecution, stopAtSafePoint: () => Promise<PlannedRestartCheckpoint>): Promise<RestartJournalEntry> {
    execution = { ...execution };
    const identity = JSON.stringify(JSON.parse(encode(execution, identityCheckpoint(0))).execution);
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
    if (this.remote.preflight && !await this.remote.preflight(entry)) throw new Error('restart_policy_unverifiable');
    if (entry.state === "prepared") {
      await this.remote.suspend(entry);
      this.journal.acknowledge(handoffId);
      entry = this.journal.get(handoffId)!;
      if (this.remote.preflight && !await this.remote.preflight(entry)) throw new Error('restart_policy_unverifiable');
    }
    // Even for a local resumed receipt, recheck remote authority. Cancellation
    // or another execution after a process crash must not be revived locally.
    const receipt = await this.remote.resume(entry);
    this.journal.resumed(handoffId, receipt.generation);
    return this.journal.get(handoffId)!;
  }
}
