import type { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { openSqliteDatabase } from "../store/db/sqlite.js";
import type { PolicyOfferIdentity } from "@multiremi/contracts/system-prompt-policy.js";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createLogger } from "@shared/logger.js";
import type { TaskMessageInput } from "@multiremi/contracts/types.js";
import { MultiremiDaemonHttpError } from "./client.js";
import { DaemonProtocolRpcError } from "./daemon-protocol-client.js";
import { DAEMON_FRAME_MAX_BYTES, DAEMON_UPLINK_WINDOW_FRAMES, DAEMON_UPLINK_WINDOW_BYTES } from "@multiremi/contracts/daemon-protocol.js";
import { outboxRecordBytes } from "./report-frames.js";
import { splitUsageReport } from "./usage-report-chunks.js";
/** Rows one delivery batch takes; legacy `messages` rows batch to the same message count. */
export const DEFAULT_TASK_MESSAGE_BATCH_COUNT = 256;

const log = createLogger("multiremi-outbox");

export type MultiremiOutboxKind =
  | "turn.complete"
  | "start"
  | "prompt"
  | "session_pin"
  | "progress"
  | "messages"
  | "usage"
  | "workspace"
  | "complete"
  | "fail"
  | "runtime.binding_state"
  | "runtime.update_result"
  | "runtime.command_result"
  | "runtime.model_list_result"
  | "runtime.local_skills_result"
  | "runtime.directory_scan_result"
  | "runtime.gc_run_result"
  | "runtime.local_skill_import_result"
  | "runtime.bot_menu_result"
  | "feishu.outbound_result"
  | "plugin.state";

const TERMINAL_KINDS = new Set<MultiremiOutboxKind>(["complete", "turn.complete", "fail"]);
const EXECUTION_KINDS = new Set<MultiremiOutboxKind>(["start", "prompt", "session_pin", "progress", "messages", "workspace", "complete", "turn.complete", "fail"]);

export interface MultiremiOutboxRecord {
  id: number;
  taskId: string;
  kind: MultiremiOutboxKind;
  payload: Record<string, unknown>;
  seq: number;
  terminal: boolean;
  attempts: number;
}

export interface MultiremiOutboxStats {
  pending: number;
  pendingNonTerminal: number;
  blocked: number;
  pendingTerminal: number;
  pendingTasks: number;
  oldestPendingCreatedAt: string | null;
  droppedTotal: number;
  fileBytes: number;
  overCapBytes: number;
}

export type MultiremiOutboxDrainResult = "delivered" | "blocked" | "aborted";

export interface MultiremiTaskReportOutboxOptions {
  discoverRestartHolds?: () => Array<{ source: string; handoff: string; attempt: string | null; legacyPaths: string[]; awaitingGrant?:boolean }>;
  /** SQLite file path; ":memory:" for tests. Parent directory is created. */
  path: string;
  /** Sends one reliable frame and waits for its individual res. */
  deliver: (record: MultiremiOutboxRecord) => Promise<void | Record<string, unknown>>;
  canSend?: () => boolean;
  /** Legacy wire adaptation runs before frame/window byte accounting. */
  prepareDelivery?: (record: MultiremiOutboxRecord) => MultiremiOutboxRecord;
  /** Bounded exponential backoff schedule; the last entry repeats. */
  backoffScheduleMs?: number[];
  /** Soft cap: compact covered progress/session_pin/workspace rows, retaining all other reliable reports. */
  maxBytes?: number;
  /** Called once when a task's queue enters the blocked state. */
  onTaskBlocked?: (taskId: string, error: string) => void;
  /** Maximum consecutive message records delivered in one API request. */
  deliveryBatchSize?: number;
}

const DEFAULT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DISCARDED_TASK_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * One durable process-wide pump. Row ids are reliable WS seqs; each task or
 * rt: partition is ordered, while independent partitions share the bounded
 * frame/byte window. Only covered overwrite reports are compacted at the soft size cap.
 * Revoked task execution drops obsolete execution reports; usage frames retain
 * their own server authorization. Other permanent errors block a partition;
 * task_not_found discards it instead,
 * and steer_pending hands completion back to the executor or reports recovery.
 */
export class MultiremiTaskReportOutbox {
  private readonly db: Database;
  private readonly statements = new Map<string, ReturnType<Database["query"]>>();
  private readonly deliver: MultiremiTaskReportOutboxOptions["deliver"];
  private readonly backoff: number[];
  private readonly maxBytes: number;
  private readonly onTaskBlocked: ((taskId: string, error: string) => void) | null;
  private readonly deliveryBatchSize: number;
  private readonly inFlight = new Map<string, { bytes: number; done: Promise<void> }>();
  private readonly canSend: () => boolean;
  private readonly prepareDelivery: NonNullable<MultiremiTaskReportOutboxOptions["prepareDelivery"]>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private scheduled = false;
  private readonly drainWaiters = new Map<string, Array<(result: MultiremiOutboxDrainResult) => void>>();
  private readonly recordWaiters = new Map<number, { taskId: string; resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
  private closed = false;

  constructor(options: MultiremiTaskReportOutboxOptions) {
    if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    this.db = openSqliteDatabase(options.path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    if (options.path !== ":memory:") {
      // Payloads mirror task reports (transcripts, prompts) — owner-only, like
      // the rest of the daemon state dir.
      try {
        chmodSync(options.path, 0o600);
      } catch {
        // Non-fatal on filesystems without chmod support.
      }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outbox_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        seq INTEGER NOT NULL,
        terminal INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        last_error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_task_seq ON outbox_events(task_id, seq);
      CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox_events(status);
      CREATE TABLE IF NOT EXISTS policy_offer_receipts (
        workspace_id TEXT NOT NULL, daemon_id TEXT NOT NULL, runtime_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL, offer_generation TEXT NOT NULL, content_hash TEXT NOT NULL,
        receipt_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','launch_claimed','terminal')),
        PRIMARY KEY(workspace_id,daemon_id,runtime_id,attempt_id)
      );
      CREATE TABLE IF NOT EXISTS outbox_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS restart_incidents(source TEXT, handoff TEXT, high_id INTEGER NOT NULL, PRIMARY KEY(source,handoff));
      CREATE TABLE IF NOT EXISTS restart_members(source TEXT, handoff TEXT, task_id TEXT, PRIMARY KEY(source,handoff,task_id));
      CREATE INDEX IF NOT EXISTS restart_member_tasks ON restart_members(task_id);
      CREATE TABLE IF NOT EXISTS restart_delivery_evidence(event_id INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS restart_uncertain(source TEXT,handoff TEXT,server_high TEXT,PRIMARY KEY(source,handoff));
      CREATE TABLE IF NOT EXISTS restart_mappings(source TEXT,handoff TEXT,task_id TEXT,PRIMARY KEY(source,handoff,task_id));
      CREATE TABLE IF NOT EXISTS unverified_report_origins(task_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS held_best_effort_reports(id INTEGER PRIMARY KEY,task_id TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS verified_new_attempts(task_id TEXT PRIMARY KEY,receipt_id TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS policy_execution_lanes(task_id TEXT PRIMARY KEY,receipt_id TEXT NOT NULL,lane TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS restart_source_rows(source TEXT, handoff TEXT, store_id TEXT, original_id INTEGER,
        original_key TEXT, task_id TEXT, PRIMARY KEY(source,handoff,store_id,original_key));
      CREATE TABLE IF NOT EXISTS legacy_outbox_origins(event_id INTEGER PRIMARY KEY, store_id TEXT, original_id INTEGER,
        original_key TEXT, route_runtime TEXT, UNIQUE(store_id,original_key));
      CREATE TRIGGER IF NOT EXISTS restart_preserve_delete BEFORE DELETE ON outbox_events
        WHEN EXISTS(SELECT 1 FROM restart_members WHERE task_id=OLD.task_id) OR EXISTS(SELECT 1 FROM unverified_report_origins WHERE task_id=OLD.task_id) BEGIN SELECT RAISE(IGNORE); END;
      CREATE TRIGGER IF NOT EXISTS restart_preserve_update BEFORE UPDATE ON outbox_events
        WHEN EXISTS(SELECT 1 FROM restart_members WHERE task_id=OLD.task_id) OR EXISTS(SELECT 1 FROM unverified_report_origins WHERE task_id=OLD.task_id) BEGIN SELECT RAISE(IGNORE); END;
      CREATE TABLE IF NOT EXISTS outbox_discarded_tasks (
        task_id TEXT PRIMARY KEY,
        keep_terminal INTEGER NOT NULL,
        keep_usage INTEGER NOT NULL DEFAULT 0,
        discarded_at TEXT NOT NULL
      );
    `);
    const discardedColumns = this.query("PRAGMA table_info(outbox_discarded_tasks)").all() as Array<{ name: string }>;
    if (!discardedColumns.some(column => column.name === "keep_usage")) {
      this.db.exec("ALTER TABLE outbox_discarded_tasks ADD COLUMN keep_usage INTEGER NOT NULL DEFAULT 0");
    }
    this.deliver = options.deliver;
    this.canSend = options.canSend ?? (() => true);
    this.prepareDelivery = options.prepareDelivery ?? (record => record);
    this.backoff = options.backoffScheduleMs?.length ? options.backoffScheduleMs : DEFAULT_BACKOFF_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.onTaskBlocked = options.onTaskBlocked ?? null;
    this.deliveryBatchSize = Math.max(1, Math.floor(options.deliveryBatchSize ?? DEFAULT_TASK_MESSAGE_BATCH_COUNT));
    this.db.transaction(() => {
      for (const incident of options.discoverRestartHolds?.() ?? []) {
        if (incident.awaitingGrant && incident.attempt) this.db.run("INSERT OR IGNORE INTO restart_members VALUES('pending-grant',?,?)",[incident.handoff,incident.attempt]);
        else if (incident.awaitingGrant === false && incident.attempt) this.db.run("DELETE FROM restart_members WHERE source='pending-grant' AND handoff=? AND task_id=?",[incident.handoff,incident.attempt]);
        else this.freezeIncident(incident);
      }
    })();
    // A paused completion belonged to the previous process's executor. Recover
    // its original reply directly; no provider remains to act on the reminder.
    this.db.run(`UPDATE outbox_events SET status='pending', next_attempt_at=NULL,
      payload=json_set(payload, '$.input_unread_fallback', json('true'))
      WHERE status='input_unread' AND kind='turn.complete'`);
    this.db.run("UPDATE outbox_events SET next_attempt_at = NULL WHERE status = 'pending'");
    // Older versions parked late usage behind a rejected execution report.
    // Recovered usage must still pass the server's immutable-run AND current
    // daemon authorization; this only removes the local delivery obstruction.
    const revoked = this.query("SELECT key FROM outbox_meta WHERE key LIKE 'blocked-code:%' AND value='authority_revoked'").all() as Array<{ key: string }>;
    for (const row of revoked) {
      const taskId = row.key.slice("blocked-code:".length);
      if (!this.query("SELECT id FROM outbox_events WHERE task_id=? AND kind='usage' LIMIT 1").get(taskId)) continue;
      this.purgeTask(taskId, { keepUsage: true });
      this.db.run("UPDATE outbox_events SET status='pending',last_error=NULL,next_attempt_at=NULL WHERE task_id=? AND kind='usage'", [taskId]);
    }
    // Old daemons persistently blocked the whole runtime partition on these
    // admission rejections. Recover once at startup; never replay their running
    // reports as admission now that their original executor is gone.
    const rejectedUpdates = this.query("SELECT key FROM outbox_meta WHERE key LIKE 'blocked-code:%' AND value IN ('cli_update_not_admitted','cli_update_not_runnable')").all() as Array<{ key: string }>;
    this.db.transaction(() => {
      for (const row of rejectedUpdates) {
        const taskId = row.key.slice("blocked-code:".length);
        this.db.run("DELETE FROM outbox_events WHERE task_id=? AND status='blocked' AND kind='runtime.update_result' AND json_extract(payload,'$.status')='running'", [taskId]);
        this.db.run("UPDATE outbox_events SET status='pending',last_error=NULL,next_attempt_at=NULL WHERE task_id=? AND status='blocked'", [taskId]);
        this.db.run("DELETE FROM outbox_meta WHERE key IN (?,?)", [`blocked:${taskId}`, `blocked-code:${taskId}`]);
      }
    })();
    const invalid = this.query("SELECT key FROM outbox_meta WHERE key LIKE 'blocked-code:%' AND value='invalid_report'").all() as Array<{ key: string }>;
    for (const row of invalid) {
      const taskId = row.key.slice("blocked-code:".length);
      // Older generic HTTP authority failures used the same fallback code.
      // Only an explicit payload-validation RPC rejection proves this upgrade
      // can reopen the partition; HTTP/global authority barriers stay intact.
      if (this.readMeta(`blocked:${taskId}`) !== "daemon RPC failed: invalid_report") continue;
      this.db.run("UPDATE outbox_events SET status='pending',last_error=NULL,next_attempt_at=NULL WHERE task_id=? AND status='blocked'", [taskId]);
      this.db.run("DELETE FROM outbox_meta WHERE key IN (?,?)", [`blocked:${taskId}`, `blocked-code:${taskId}`]);
    }
  }

  policyReceipt(scope: Pick<PolicyOfferIdentity, 'workspace_id' | 'daemon_id' | 'runtime_id' | 'attempt_id'>) {
    return this.db.query(`SELECT * FROM policy_offer_receipts WHERE workspace_id=? AND daemon_id=? AND runtime_id=? AND attempt_id=?`)
      .get(scope.workspace_id, scope.daemon_id, scope.runtime_id, scope.attempt_id) as (PolicyOfferIdentity & {state:'prepared'|'launch_claimed'|'terminal'}) | null;
  }

  private readonly heldAttempts = new Set<string>();

  private freezeIncident(incident: { source: string; handoff: string; attempt: string | null; legacyPaths: string[] }): void {
    const { source, handoff, attempt } = incident;
    this.db.transaction(() => {
      const created = this.db.run(`INSERT OR IGNORE INTO restart_incidents SELECT ?,?,COALESCE(MAX(id),0) FROM outbox_events`, [source,handoff]);
      if (attempt) {
        this.db.run('INSERT OR IGNORE INTO restart_mappings VALUES(?,?,?)',[source,handoff,attempt]);
        this.db.run('INSERT OR IGNORE INTO restart_members VALUES(?,?,?)', [source,handoff,attempt]);
        if (this.query('SELECT 1 FROM restart_mappings WHERE source=? AND handoff=? AND task_id<>? LIMIT 1').get(source,handoff,attempt)) {
          this.db.run('INSERT OR IGNORE INTO restart_members SELECT source,handoff,task_id FROM restart_source_rows WHERE source=? AND handoff=?',[source,handoff]);
          this.db.run('INSERT OR IGNORE INTO restart_uncertain(source,handoff) VALUES(?,?)',[source,handoff]);
          return;
        }
        this.db.run('DELETE FROM restart_members WHERE source=? AND handoff=? AND task_id<>?', [source,handoff,attempt]);
        this.db.run('DELETE FROM restart_uncertain WHERE source=? AND handoff=?',[source,handoff]);
        return;
      }
      if (!created.changes) return;
      this.db.run('INSERT INTO restart_uncertain(source,handoff) VALUES(?,?)',[source,handoff]);
      this.db.run(`INSERT OR IGNORE INTO restart_members SELECT ?,?,e.task_id FROM outbox_events e WHERE e.task_id NOT LIKE 'rt:%' AND NOT EXISTS (
        SELECT 1 FROM policy_execution_lanes l JOIN policy_offer_receipts p ON p.attempt_id=l.task_id AND p.receipt_id=l.receipt_id
        WHERE l.task_id=e.task_id AND l.lane<>? AND json_valid(e.payload) AND json_extract(e.payload,'$.receipt_id')=l.receipt_id
        AND json_extract(e.payload,'$.offer_generation')=p.offer_generation AND json_extract(e.payload,'$.content_hash')=p.content_hash
        AND json_extract(e.payload,'$.runtime_id')=p.runtime_id AND p.state IN ('launch_claimed','terminal'))`, [source,handoff,source]);
      this.db.run(`INSERT OR IGNORE INTO restart_source_rows SELECT ?,?,'shared',id,idempotency_key,task_id FROM outbox_events
        WHERE task_id IN (SELECT task_id FROM restart_members WHERE source=? AND handoff=?)`,[source,handoff,source,handoff]);
      for (const path of incident.legacyPaths) {
        if (!existsSync(path)) continue;
        const legacy = openSqliteDatabase(path, { readonly: true });
        try {
          let cursor = 0;
          for (;;) {
            const rows = legacy.query('SELECT id,task_id,idempotency_key FROM outbox_events WHERE id>? ORDER BY id LIMIT 128').all(cursor) as Array<{id:number;task_id:string;idempotency_key:string}>;
            for (const row of rows) if (!row.task_id.startsWith('rt:')) {
              this.db.run('INSERT OR IGNORE INTO restart_members VALUES(?,?,?)',[source,handoff,row.task_id]);
              this.db.run('INSERT OR IGNORE INTO restart_source_rows VALUES(?,?,?,?,?,?)',[source,handoff,path,row.id,row.idempotency_key,row.task_id]);
            }
            if (rows.length < 128) break;
            cursor = rows[rows.length-1]!.id;
          }
        } finally { legacy.close(); }
      }
    }).immediate();
  }

  isHeld(taskId: string): boolean {
    return this.heldAttempts.has(taskId) || Boolean(this.query('SELECT 1 FROM restart_members WHERE task_id=? UNION ALL SELECT 1 FROM unverified_report_origins WHERE task_id=? LIMIT 1').get(taskId,taskId));
  }

  uncertainHandoffs() {
    return this.query('SELECT source,handoff,server_high FROM restart_uncertain ORDER BY source,handoff').all() as Array<{source:string;handoff:string;server_high:string|null}>;
  }

  mappedHandoffs(source: string) {
    return this.query(`SELECT handoff AS handoff_id,MIN(task_id) AS attempt_id FROM restart_mappings WHERE source=? GROUP BY handoff HAVING count(*)=1`)
      .all(source) as Array<{handoff_id:string;attempt_id:string}>;
  }

  hasIndependentHold(taskId: string, handoff: string): boolean {
    return Boolean(this.query(`SELECT 1 FROM restart_members WHERE task_id=? AND (source<>'pending-grant' OR handoff<>?)
      UNION ALL SELECT 1 FROM unverified_report_origins WHERE task_id=? LIMIT 1`).get(taskId,handoff,taskId));
  }

  recordHandoffEvidence(source: string, handoff: string, attempt: string | null, high: string): void {
    if (attempt) this.freezeIncident({source,handoff,attempt,legacyPaths:[]});
    else this.db.run('UPDATE restart_uncertain SET server_high=COALESCE(server_high,?) WHERE source=? AND handoff=?',[high,source,handoff]);
  }

  canProveNewAttempt(createdAt: unknown): boolean {
    return !this.query('SELECT 1 FROM restart_uncertain WHERE server_high IS NULL OR ?<=server_high LIMIT 1').get(typeof createdAt === 'string' ? createdAt : '');
  }

  recordNewAttempt(identity: PolicyOfferIdentity, createdAt: string, lane: string): void {
    this.db.run('INSERT OR IGNORE INTO policy_execution_lanes VALUES(?,?,?)',[identity.attempt_id,identity.receipt_id,lane]);
    if (this.canProveNewAttempt(createdAt)) this.db.run('INSERT OR IGNORE INTO verified_new_attempts VALUES(?,?,?)',[identity.attempt_id,identity.receipt_id,createdAt]);
  }

  hasRestartIncident(): boolean {
    return Boolean(this.query('SELECT 1 FROM restart_incidents LIMIT 1').get());
  }

  preserveBestEffort(taskId: string, kind:string, payload:Record<string,unknown>): void {
    this.db.run('INSERT INTO held_best_effort_reports(task_id,kind,payload) VALUES(?,?,?)',[taskId,kind,JSON.stringify(payload)]);
  }

  incidentSequence(): number {
    return (this.query('SELECT COALESCE(MAX(rowid),0) AS seq FROM restart_incidents').get() as {seq:number}).seq;
  }

  heldSince(record: MultiremiOutboxRecord, sequence: number): boolean {
    return this.isHeld(record.taskId) || Boolean(this.query(`SELECT 1 FROM restart_incidents i JOIN restart_source_rows r ON r.source=i.source AND r.handoff=i.handoff
      WHERE i.rowid>? AND r.store_id='shared' AND r.original_id=? LIMIT 1`).get(sequence,record.id));
  }

  classifyReport(taskId: string, receipt: unknown): boolean {
    if (taskId.startsWith('rt:')) return false;
    if (this.isHeld(taskId)) return true;
    if (!this.query('SELECT 1 FROM restart_uncertain LIMIT 1').get()) return false;
    const known = this.query('SELECT created_at FROM verified_new_attempts WHERE task_id=? AND receipt_id=?').get(taskId,String(receipt ?? '')) as {created_at:string}|null;
    if (known && this.canProveNewAttempt(known.created_at)) return false;
    const otherLane = this.query(`SELECT 1 FROM policy_execution_lanes l WHERE task_id=? AND receipt_id=?
      AND NOT EXISTS(SELECT 1 FROM restart_uncertain WHERE source=l.lane)`).get(taskId,String(receipt ?? ''));
    if (otherLane) return false;
    this.db.run('INSERT OR IGNORE INTO unverified_report_origins VALUES(?)',[taskId]);
    return true;
  }

  preparedOffers(runtimeId: string): PolicyOfferIdentity[] {
    return this.db.query(`SELECT workspace_id,daemon_id,runtime_id,attempt_id,offer_generation,content_hash,receipt_id FROM policy_offer_receipts
      WHERE runtime_id=? AND state='prepared' ORDER BY attempt_id`).all(runtimeId) as PolicyOfferIdentity[];
  }

  holdAttempt(taskId: string, hold: boolean): void {
    if (hold) this.heldAttempts.add(taskId);
    else if (this.heldAttempts.delete(taskId)) this.ensurePump(taskId);
  }

  releaseRestartGrant(taskId:string,handoff:string): void {
    this.db.run("DELETE FROM restart_members WHERE source='pending-grant' AND handoff=? AND task_id=?",[handoff,taskId]);
    this.holdAttempt(taskId,false);
  }

  reportIdentity(taskId:string, runtimeId:unknown): Partial<PolicyOfferIdentity> {
    if (typeof runtimeId !== 'string') return {};
    return this.db.query(`SELECT offer_generation,content_hash,receipt_id FROM policy_offer_receipts WHERE attempt_id=?
      AND runtime_id=? AND state IN ('launch_claimed','terminal')`).get(taskId,runtimeId) ?? {};
  }

  preparePolicyReceipt(identity: Omit<PolicyOfferIdentity, 'receipt_id'>) {
    const {workspace_id, daemon_id, runtime_id, attempt_id, offer_generation, content_hash} = identity;
    this.db.run(`INSERT INTO policy_offer_receipts(workspace_id,daemon_id,runtime_id,attempt_id,offer_generation,content_hash,receipt_id,state)
      VALUES(?,?,?,?,?,?,?,'prepared') ON CONFLICT(workspace_id,daemon_id,runtime_id,attempt_id) DO NOTHING`,
      [workspace_id,daemon_id,runtime_id,attempt_id,offer_generation,content_hash,randomUUID()]);
    return this.policyReceipt(identity)!;
  }

  transitionPolicyReceipt(identity: PolicyOfferIdentity, operation: 'launch'|'forget_revoked'|'terminal'): boolean {
    const sql = operation === 'forget_revoked' ? 'DELETE FROM policy_offer_receipts' :
      `UPDATE policy_offer_receipts SET state='${operation === 'launch' ? 'launch_claimed' : 'terminal'}'`;
    return this.db.run(`${sql} WHERE workspace_id=? AND daemon_id=? AND runtime_id=? AND attempt_id=?
      AND offer_generation=? AND content_hash=? AND receipt_id=? AND state=?`, [identity.workspace_id, identity.daemon_id,
      identity.runtime_id, identity.attempt_id, identity.offer_generation, identity.content_hash, identity.receipt_id,
      operation === 'terminal' ? 'launch_claimed' : 'prepared']).changes === 1;
  }

  /** Persist a report and wake the task's delivery pump. Never throws on queue pressure. */
  enqueue(taskId: string, kind: MultiremiOutboxKind, payload: Record<string, unknown>): number | null {
    if (this.closed) throw new Error("outbox is closed");
    this.classifyReport(taskId,payload.receipt_id);
    const snapshot = payload.usageSnapshot as import("@multiremi/contracts/usage-accounting.js").TaskUsageSnapshot | undefined;
    if (kind === "usage" && snapshot?.version === 2 && Array.isArray(snapshot.units)) {
      const chunks = splitUsageReport(snapshot);
      if (chunks.length > 1) {
        let lastId: number | null = null;
        for (const chunk of chunks) lastId = this.enqueue(taskId, kind, { ...payload, usageSnapshot: chunk });
        return lastId;
      }
    }
    const terminal = TERMINAL_KINDS.has(kind);
    const discarded = this.query(
      "SELECT keep_terminal, keep_usage FROM outbox_discarded_tasks WHERE task_id = ?",
    ).get(taskId) as { keep_terminal: number; keep_usage: number } | null;
    if (discarded && !this.isHeld(taskId) && !(Number(discarded.keep_terminal) === 1 && terminal)
      && !(Number(discarded.keep_usage) === 1 && kind === "usage")) {
      const total = Number(this.readMeta("dropped_total") ?? 0) + 1;
      this.writeMeta("dropped_total", String(total));
      log.debug(`outbox discarded ${kind} report for tombstoned task ${taskId}`);
      return null;
    }
    const idRow = this.query("SELECT seq FROM sqlite_sequence WHERE name = 'outbox_events'").get() as { seq: number } | null;
    const id = Number(idRow?.seq ?? 0) + 1;
    const oversized = outboxRecordBytes({ id, taskId, kind, payload, seq: id, terminal, attempts: 0 }) > DAEMON_FRAME_MAX_BYTES;
    const blocked = this.readMeta(`blocked:${taskId}`) !== null || oversized;
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO outbox_events (idempotency_key, task_id, kind, payload, seq, terminal, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [randomUUID(), taskId, kind, JSON.stringify(oversized && !this.isHeld(taskId) ? {} : payload), id, terminal ? 1 : 0, blocked ? "blocked" : "pending", new Date().toISOString()],
      );
      // Keep the saved reply until a valid successor terminal is durable. A new
      // id puts that successor after reports produced during the reminder.
      if (terminal && !blocked) this.db.run(
        "DELETE FROM outbox_events WHERE task_id=? AND status='input_unread'", [taskId]);
    })();
    // A complete marker may follow multiple bounded chunks. It never proves
    // that one body contains older units, so pending usage deltas are retained.
    if (oversized) this.blockPartition(taskId, "protocol_violation: encoded report exceeds 1 MiB");
    this.enforceSizeCap();
    this.ensurePump(taskId);
    return id;
  }

  enqueueAndWait(taskId: string, kind: MultiremiOutboxKind, payload: Record<string, unknown>, timeoutMs = 30_000, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const id = this.enqueue(taskId, kind, payload);
    if (id === null) return Promise.resolve({ ok: true });
    const blocked = this.readMeta(`blocked:${taskId}`);
    if (blocked) return Promise.reject(new DaemonProtocolRpcError(this.readMeta(`blocked-code:${taskId}`) ?? "protocol_violation", false));
    return new Promise((resolve, reject) => {
      const clear = () => { clearTimeout(timer); signal?.removeEventListener("abort", interrupted); };
      const interrupted = () => {
        clear();
        this.recordWaiters.delete(id);
        if (terminal) resolve({ ok: true, queued: true });
        else reject(new DaemonProtocolRpcError("daemon_unreachable", true));
      };
      const terminal = TERMINAL_KINDS.has(kind);
      const timer = setTimeout(() => {
        clear();
        this.recordWaiters.delete(id);
        log.warn(`outbox result wait timed out for ${taskId} (${kind} id ${id}); retained for replay`);
        if (terminal) resolve({ ok: true, queued: true });
        else reject(new DaemonProtocolRpcError("daemon_timeout", true));
      }, timeoutMs);
      this.recordWaiters.set(id, { taskId,
        resolve: value => { clear(); resolve(value); },
        reject: error => { clear(); reject(error); },
      });
      signal?.addEventListener("abort", interrupted, { once: true });
      if (signal?.aborted) interrupted();
    });
  }

  /** Copy old provider queues once; their files remain recoverable. */
  importLegacy(path: string, runtimeId?: string): void {
    if (path === ":memory:") return;
    const source = openSqliteDatabase(path, { readonly: true });
    try {
      const prefix = createHash("sha256").update(path).digest("hex");
      source.transaction(() => this.db.transaction(() => {
        const rows = source.query('SELECT * FROM outbox_events ORDER BY id');
        for (const row of rows.iterate() as Iterable<Record<string,unknown>>) {
          const key = `imported:${prefix}:${row.idempotency_key}`;
          if (this.readMeta(key)) continue;
          this.classifyReport(String(row.task_id),toRecord(row).payload.receipt_id);
          const inserted = this.db.run(`INSERT INTO outbox_events(idempotency_key,task_id,kind,payload,seq,terminal,status,attempts,next_attempt_at,last_error,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)`,[String(row.idempotency_key),String(row.task_id),String(row.kind),String(row.payload),Number(row.seq),Number(row.terminal),
              String(row.status),Number(row.attempts),row.next_attempt_at == null ? null : Number(row.next_attempt_at),row.last_error == null ? null : String(row.last_error),String(row.created_at)]);
          this.db.run('INSERT INTO legacy_outbox_origins VALUES(?,?,?,?,?)',[Number(inserted.lastInsertRowid),path,Number(row.id),String(row.idempotency_key),runtimeId ?? null]);
          if (row.status === 'blocked' && !this.isHeld(String(row.task_id))) this.blockPartition(String(row.task_id), 'legacy permanent delivery error');
          this.writeMeta(key, "1");
        }
      })())();
    } finally { source.close(); }
    const backup = `${path}.migrated-v2`;
    const destination = ["", "-wal", "-shm"].some(suffix => existsSync(`${backup}${suffix}`))
      ? `${path}.${randomUUID()}.migrated-v2` : backup;
    renameSync(path, destination);
    // A crashed v1 writer can leave committed rows only in its WAL.
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${path}${suffix}`)) renameSync(`${path}${suffix}`, `${destination}${suffix}`);
    }
  }

  /** Resolves when the task queue is empty (delivered), blocked, or the signal aborts. */
  async waitForTaskDrain(taskId: string, signal?: AbortSignal): Promise<MultiremiOutboxDrainResult> {
    const immediate = this.taskDrainState(taskId);
    if (immediate) return immediate;
    if (signal?.aborted) return "aborted";
    this.ensurePump(taskId);
    return await new Promise<MultiremiOutboxDrainResult>((resolve) => {
      let settled = false;
      const finish = (result: MultiremiOutboxDrainResult) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () => finish("aborted");
      const waiters = this.drainWaiters.get(taskId) ?? [];
      waiters.push(finish);
      this.drainWaiters.set(taskId, waiters);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const state = this.taskDrainState(taskId);
      if (state) this.settleDrainWaiters(taskId, state);
    });
  }

  /** Restart recovery: pump every task with pending rows and wait for the queues to settle. */
  async flushAll(signal?: AbortSignal): Promise<void> {
    const rows = this.query(
      "SELECT DISTINCT task_id FROM outbox_events WHERE status = 'pending'",
    ).all() as Array<{ task_id: string }>;
    await Promise.all(rows.map((row) => this.waitForTaskDrain(String(row.task_id), signal)));
  }

  pendingTaskIds(): string[] {
    const rows = this.query(
      "SELECT DISTINCT task_id FROM outbox_events WHERE status = 'pending'",
    ).all() as Array<{ task_id: string }>;
    return rows.map((row) => String(row.task_id));
  }

  taskIdsWithPendingTerminal(runtimeId?: string): string[] {
    const rows = this.query(
      `SELECT DISTINCT task_id FROM outbox_events WHERE status IN ('pending', 'input_unread') AND terminal = 1
       AND (? IS NULL OR COALESCE(json_extract(payload, '$.runtime_id'),(SELECT route_runtime FROM legacy_outbox_origins WHERE event_id=outbox_events.id)) = ?)`,
    ).all(runtimeId ?? null, runtimeId ?? null) as Array<{ task_id: string }>;
    return rows.map((row) => String(row.task_id));
  }

  /**
   * Discard reports that no longer have server-side value and prevent future
   * producers from recreating them. A terminal-only tombstone is useful when
   * callers still need to preserve a completion/failure report.
   */
  purgeTask(taskId: string, options: { keepTerminal?: boolean; keepUsage?: boolean } = {}): number {
    if (this.closed || this.isHeld(taskId)) return 0;
    const keepTerminal = options.keepTerminal === true;
    const keepUsage = options.keepUsage === true;
    const discardedAt = new Date().toISOString();
    const cutoff = new Date(Date.now() - DISCARDED_TASK_TTL_MS).toISOString();
    const purge = this.db.transaction(() => {
      this.db.run("DELETE FROM outbox_discarded_tasks WHERE discarded_at < ?", [cutoff]);
      this.db.run(
        `INSERT INTO outbox_discarded_tasks (task_id, keep_terminal, keep_usage, discarded_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           keep_terminal = MIN(outbox_discarded_tasks.keep_terminal, excluded.keep_terminal),
           keep_usage = MIN(outbox_discarded_tasks.keep_usage, excluded.keep_usage),
           discarded_at = excluded.discarded_at`,
        [taskId, keepTerminal ? 1 : 0, keepUsage ? 1 : 0, discardedAt],
      );
      const tombstone = this.query(
        "SELECT keep_terminal, keep_usage FROM outbox_discarded_tasks WHERE task_id = ?",
      ).get(taskId) as { keep_terminal: number; keep_usage: number };
      const result = this.db.run("DELETE FROM outbox_events WHERE task_id = ? AND NOT (terminal = 1 AND ? = 1) AND NOT (kind = 'usage' AND ? = 1)",
        [taskId, Number(tombstone.keep_terminal), Number(tombstone.keep_usage)]);
      return Number(result.changes);
    });
    const purged = purge();
    for (const [id, waiter] of this.recordWaiters) {
      if (waiter.taskId === taskId && !this.query("SELECT id FROM outbox_events WHERE id = ?").get(id)) {
        waiter.resolve({ ok: true, discarded: true });
        this.recordWaiters.delete(id);
      }
    }
    this.db.run("DELETE FROM outbox_meta WHERE key IN (?, ?)", [`blocked:${taskId}`, `blocked-code:${taskId}`]);

    // The pump may be in retry backoff, and drain waiters otherwise only settle
    // from ensurePump().finally(). Re-evaluate both immediately after deletion.
    this.ensurePump(taskId);
    const state = this.taskDrainState(taskId);
    if (state) this.settleDrainWaiters(taskId, state);
    return purged;
  }

  stats(): MultiremiOutboxStats {
    const pending = this.query("SELECT COUNT(*) AS n FROM outbox_events WHERE status IN ('pending', 'input_unread')").get() as { n: number };
    const blocked = this.query("SELECT COUNT(*) AS n FROM outbox_events WHERE status = 'blocked'").get() as { n: number };
    const pendingTerminal = this.query(
      "SELECT COUNT(*) AS n FROM outbox_events WHERE status IN ('pending', 'input_unread') AND terminal = 1",
    ).get() as { n: number };
    const pendingTasks = this.query(
      "SELECT COUNT(DISTINCT task_id) AS n FROM outbox_events WHERE status IN ('pending', 'input_unread')",
    ).get() as { n: number };
    const oldest = this.query(
      "SELECT MIN(created_at) AS at FROM outbox_events WHERE status IN ('pending', 'input_unread')",
    ).get() as { at: string | null };
    const pages = this.query("PRAGMA page_count").get() as { page_count: number };
    const pageSize = this.query("PRAGMA page_size").get() as { page_size: number };
    const fileBytes = Number(pages.page_count) * Number(pageSize.page_size);
    return {
      pending: Number(pending.n),
      pendingNonTerminal: Number(pending.n) - Number(pendingTerminal.n),
      blocked: Number(blocked.n),
      pendingTerminal: Number(pendingTerminal.n),
      pendingTasks: Number(pendingTasks.n),
      oldestPendingCreatedAt: oldest.at ?? null,
      droppedTotal: Number(this.readMeta("dropped_total") ?? 0),
      fileBytes,
      overCapBytes: Math.max(0, fileBytes - this.maxBytes),
    };
  }

  /** Wake every pending pump without waiting (fire-and-forget delivery). */
  pumpAll(): void {
    for (const taskId of this.pendingTaskIds()) this.ensurePump(taskId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const waiter of this.recordWaiters.values()) waiter.reject(new DaemonProtocolRpcError("daemon_unreachable", true));
    this.recordWaiters.clear();
    for (const [taskId] of this.drainWaiters) this.settleDrainWaiters(taskId, "aborted");
    await Promise.allSettled([...this.inFlight.values()].map(item => item.done));
    // Bun 1.3.14 only caches the first 20 db.query() statements. Statements
    // beyond that limit survive db.close() until GC, retaining Windows locks.
    for (const statement of this.statements.values()) statement.finalize();
    this.statements.clear();
    this.db.close(true);
  }

  private taskDrainState(taskId: string): MultiremiOutboxDrainResult | null {
    if (this.closed) return "aborted";
    if (this.readMeta(`blocked:${taskId}`) !== null) return "blocked";
    if (this.query("SELECT id FROM outbox_events WHERE task_id=? AND status='pending' LIMIT 1").get(taskId)) return null;
    const row = this.query(
      "SELECT status FROM outbox_events WHERE task_id = ? ORDER BY seq ASC LIMIT 1",
    ).get(taskId) as { status: string } | null;
    if (!row) return "delivered";
    if (row.status === "blocked") return "blocked";
    return null;
  }

  private settleDrainWaiters(taskId: string, result: MultiremiOutboxDrainResult): void {
    const waiters = this.drainWaiters.get(taskId);
    if (!waiters?.length) return;
    this.drainWaiters.delete(taskId);
    for (const waiter of waiters) waiter(result);
  }

  private ensurePump(taskId: string): void {
    if (this.closed || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.closed) this.runPump();
    });
  }

  private runPump(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const rows = this.query(`SELECT task_id, MIN(id) AS id FROM outbox_events
      GROUP BY task_id ORDER BY id`).all() as Array<{ task_id: string; id: number }>;
    let bytes = [...this.inFlight.values()].reduce((total, item) => total + item.bytes, 0);
    let nextWake = Number.POSITIVE_INFINITY;
    for (const row of rows) {
      if (!this.canSend()) { nextWake = Math.min(nextWake, 100); break; }
      const taskId = row.task_id;
      if (this.isHeld(taskId)) continue;
      if (this.inFlight.has(taskId)) continue;
      const delivery = this.nextDelivery(taskId);
      if (!delivery || delivery.blocked || this.readMeta(`blocked:${taskId}`) !== null) continue;
      const retry = this.query("SELECT next_attempt_at FROM outbox_events WHERE id = ?").get(delivery.record.id) as { next_attempt_at: number | null };
      const delay = Number(retry.next_attempt_at ?? 0) - Date.now();
      if (delay > 0) { nextWake = Math.min(nextWake, delay); continue; }
      delivery.record = this.prepareDelivery(delivery.record);
      const frameBytes = outboxRecordBytes(delivery.record);
      if (frameBytes > DAEMON_FRAME_MAX_BYTES) {
        this.blockPartition(taskId, "protocol_violation: persisted report exceeds 1 MiB");
        continue;
      }
      if (this.inFlight.size >= DAEMON_UPLINK_WINDOW_FRAMES || bytes + frameBytes > DAEMON_UPLINK_WINDOW_BYTES) break;
      bytes += frameBytes;
      const done = Promise.resolve().then(() => this.deliverRecord(delivery)).finally(() => {
        this.inFlight.delete(taskId);
        if (this.closed) return;
        const state = this.taskDrainState(taskId);
        if (state) this.settleDrainWaiters(taskId, state);
        this.ensurePump(taskId);
      });
      this.inFlight.set(taskId, { bytes: frameBytes, done });
    }
    if (Number.isFinite(nextWake)) {
      this.timer = setTimeout(() => { this.timer = null; this.ensurePump(""); }, Math.max(1, nextWake));
      // Bun on Windows may starve the last unreferenced retry timer. close() clears it.
      if (process.platform !== "win32") this.timer.unref?.();
    }
  }

  private async deliverRecord({ record, recordIds }: OutboxDelivery): Promise<void> {
    const taskId = record.taskId;
    const sequence = this.incidentSequence();
    if (this.isHeld(taskId)) return;
    if (!this.query("SELECT id FROM outbox_events WHERE id = ? AND status = 'pending'").get(record.id)) return;
    try {
      const reply = await this.deliver(record);
      if (this.heldSince(record,sequence)) {
        for (const id of recordIds) this.db.run('INSERT OR IGNORE INTO restart_delivery_evidence VALUES(?)',[id]);
        return;
      }
      if (record.terminal && record.payload.receipt_id) this.db.run(`UPDATE policy_offer_receipts SET state='terminal'
        WHERE attempt_id=? AND runtime_id=? AND offer_generation=? AND content_hash=? AND receipt_id=? AND state='launch_claimed'`,
        [taskId,String(record.payload.runtime_id),String(record.payload.offer_generation),String(record.payload.content_hash),String(record.payload.receipt_id)]);
      this.deleteRecords(recordIds);
      for (const id of recordIds) {
        this.recordWaiters.get(id)?.resolve(reply ?? { ok: true });
        this.recordWaiters.delete(id);
      }
    } catch (error) {
      if (this.heldSince(record,sequence)) return;
      if (error instanceof DaemonProtocolRpcError && error.code === "input_unread" && record.kind === "turn.complete") {
        const waiter = this.recordWaiters.get(record.id);
        if (waiter) {
          this.db.run("UPDATE outbox_events SET status='input_unread',next_attempt_at=NULL WHERE id=? AND status='pending'", [record.id]);
          this.recordWaiters.delete(record.id);
          waiter.reject(error);
        } else {
          // Preserve the durable reply across a crash between refusal and retry.
          this.db.run("UPDATE outbox_events SET payload=?,next_attempt_at=NULL WHERE id=? AND status='pending'",
            [JSON.stringify({ ...record.payload, input_unread_fallback: true }), record.id]);
        }
        return;
      }
      if (error instanceof DaemonProtocolRpcError && error.code === "turn_input_pending" && record.kind === "turn.complete") {
        if (this.closed) return;
        const waiter = this.recordWaiters.get(record.id);
        this.deleteRecords(recordIds);
        this.recordWaiters.delete(record.id);
        if (waiter) waiter.reject(error);
        else {
          log.warn(`outbox completion for ${taskId} rejected by steer barrier without a waiting executor; reporting runtime_recovery`);
          this.enqueue(taskId, "fail", { runtime_id: record.payload.runtime_id,
            offer_generation: record.payload.offer_generation, content_hash: record.payload.content_hash, receipt_id: record.payload.receipt_id,
            session_id: record.payload.session_id ?? record.payload.sessionId,
            work_dir: record.payload.work_dir ?? record.payload.workDir,
            failure_reason: "runtime_recovery", error: "完成时有未注入的 steer，执行端已不在" });
        }
        return;
      }
      if (error instanceof DaemonProtocolRpcError && error.code === 'policy_offer_mismatch') {
        this.deleteRecords(recordIds);
        for (const id of recordIds) { this.recordWaiters.get(id)?.reject(error); this.recordWaiters.delete(id); }
        return;
      }
      if (error instanceof DaemonProtocolRpcError && error.code === "task_not_found") {
        log.warn(`outbox partition ${taskId} discarded: task_not_found`);
        this.purgeTask(taskId);
        for (const id of recordIds) {
          this.recordWaiters.get(id)?.resolve({ ok: true, discarded: true });
          this.recordWaiters.delete(id);
        }
        return;
      }
      if (isDeliveredEquivalent(error, record)) {
        this.deleteRecords(recordIds);
        for (const id of recordIds) {
          this.recordWaiters.get(id)?.resolve({ ok: true });
          this.recordWaiters.delete(id);
        }
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof DaemonProtocolRpcError && error.code === "invalid_report" && !error.retryable
        && (record.kind === "usage" || EXECUTION_KINDS.has(record.kind))) {
        // Validation belongs to this payload, not to later independently
        // authorized usage. Keep every rejected constituent durable and reject
        // its actual waiter; a parked record is never an acknowledgement.
        for (const id of recordIds) {
          this.db.run("UPDATE outbox_events SET status='blocked',last_error=? WHERE id=? AND status='pending'", [message.slice(0, 2_000), id]);
          this.recordWaiters.get(id)?.reject(error);
          this.recordWaiters.delete(id);
        }
        return;
      }
      if (error instanceof DaemonProtocolRpcError && error.code === "authority_revoked"
        && (record.kind === "usage" || EXECUTION_KINDS.has(record.kind))) {
        for (const id of recordIds) {
          this.recordWaiters.get(id)?.reject(error);
          this.recordWaiters.delete(id);
        }
        if (record.kind === "usage") {
          // One invalid run cannot prevent a later frame for a bound run from
          // reaching its independent authorization check. Keep rejected facts
          // durable for inspection; never turn rejection into a delivery ACK.
          this.db.run("UPDATE outbox_events SET status='blocked',last_error=? WHERE id=? AND status='pending'", [message.slice(0, 2_000), record.id]);
        } else {
          // After reassignment, every remaining execution report is obsolete.
          // The immutable run can still own consumption that occurred earlier.
          this.purgeTask(taskId, { keepUsage: true });
        }
        return;
      }
      if (record.kind === "runtime.update_result" && record.payload.status === "running"
        && error instanceof DaemonProtocolRpcError && (error.code === "cli_update_not_admitted" || error.code === "cli_update_not_runnable")) {
        // Compatibility for already queued admission reports. Rejection applies
        // only to this attempt, never to later runtime results in the partition.
        this.db.run("DELETE FROM outbox_events WHERE id = ?", [record.id]);
        this.recordWaiters.get(record.id)?.reject(error);
        this.recordWaiters.delete(record.id);
        return;
      }
      if (isPermanentDeliveryError(error)) {
        const blocked = this.db.run(
          `UPDATE outbox_events SET status = 'blocked', last_error = ?
           WHERE task_id = ? AND status = 'pending'
             AND EXISTS (SELECT 1 FROM outbox_events WHERE id = ?)`,
          [message.slice(0, 2_000), taskId, record.id],
        );
        // purgeTask may have deleted the in-flight record while deliver()
        // awaited. In that case, do not let its stale failure block terminal
        // rows that a keepTerminal tombstone still permits.
        if (Number(blocked.changes) === 0) return;
        this.blockPartition(taskId, message, error instanceof DaemonProtocolRpcError ? error.code : "invalid_report");
        for (const id of recordIds) {
          this.recordWaiters.get(id)?.reject(error instanceof Error ? error : new Error(message));
          this.recordWaiters.delete(id);
        }
        return;
      }
      const attempts = record.attempts + 1;
      const delay = this.backoff[Math.min(attempts - 1, this.backoff.length - 1)]!;
      const updated = this.db.run(
        "UPDATE outbox_events SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?",
        [attempts, Date.now() + delay, message.slice(0, 2_000), record.id],
      );
      if (Number(updated.changes) === 0) return;
      if (attempts === 1 || attempts % 10 === 0) {
        log.warn(`outbox delivery for task ${taskId} (${record.kind} seq ${record.seq}) failed, retrying in ${delay}ms: ${message}`);
      }
    }
  }

  private blockPartition(taskId: string, error: string, code = "protocol_violation"): void {
    const first = this.readMeta(`blocked:${taskId}`) === null;
    this.writeMeta(`blocked:${taskId}`, error.slice(0, 2_000));
    this.writeMeta(`blocked-code:${taskId}`, code);
    this.db.run("UPDATE outbox_events SET status = 'blocked', last_error = ? WHERE task_id = ?", [error.slice(0, 2_000), taskId]);
    if (first) {
      log.error(`outbox partition ${taskId} blocked on permanent error: ${error}`);
      this.onTaskBlocked?.(taskId, error);
    }
    this.settleDrainWaiters(taskId, "blocked");
    for (const [id, waiter] of this.recordWaiters) {
      if (waiter.taskId !== taskId) continue;
      waiter.reject(new DaemonProtocolRpcError(code, false));
      this.recordWaiters.delete(id);
    }
  }

  private nextDelivery(taskId: string): OutboxDelivery | null {
    const rows = this.query(
      "SELECT e.*,l.route_runtime FROM outbox_events e LEFT JOIN legacy_outbox_origins l ON l.event_id=e.id WHERE e.task_id = ? AND e.status = 'pending' ORDER BY e.id ASC LIMIT ?",
    ).all(taskId, this.deliveryBatchSize) as Array<Record<string, unknown>>;
    const firstRow = rows[0];
    if (!firstRow) return null;
    const first = toRecord(firstRow);
    if (String(firstRow.status) === "blocked") {
      return { record: first, recordIds: [first.id], blocked: true };
    }
    if (first.kind !== "messages") {
      return { record: first, recordIds: [first.id], blocked: false };
    }

    const records: MultiremiOutboxRecord[] = [];
    const messages: TaskMessageInput[] = [];
    for (const row of rows) {
      if (String(row.status) === "blocked") break;
      const record = toRecord(row);
      if (record.kind !== "messages") break;
      const recordMessages = Array.isArray(record.payload.messages)
        ? record.payload.messages as TaskMessageInput[]
        : [];
      if (records.length > 0 && messages.length + recordMessages.length > DEFAULT_TASK_MESSAGE_BATCH_COUNT) break;
      records.push(record);
      messages.push(...recordMessages);
      if (messages.length >= DEFAULT_TASK_MESSAGE_BATCH_COUNT) break;
    }

    return {
      record: {
        ...first,
        // Only v1 queues hold these rows; the daemon drops them (PR 2), so they are
        // batched for one delete, not coalesced.
        payload: { ...first.payload, messages },
      },
      recordIds: records.map((record) => record.id),
      blocked: false,
    };
  }

  private deleteRecords(recordIds: number[]): void {
    if (recordIds.length === 1) {
      this.db.run("DELETE FROM outbox_events WHERE id = ?", [recordIds[0]!]);
      return;
    }
    const placeholders = recordIds.map(() => "?").join(", ");
    this.db.run(`DELETE FROM outbox_events WHERE id IN (${placeholders})`, recordIds);
  }

  /** Capacity pressure may compact only pending overwrite rows already covered by a newer row. */
  private enforceSizeCap(): void {
    const pages = this.query("PRAGMA page_count").get() as { page_count: number };
    const pageSize = this.query("PRAGMA page_size").get() as { page_size: number };
    const bytes = Number(pages.page_count) * Number(pageSize.page_size);
    if (bytes <= this.maxBytes) return;
    const dropped = Number(this.db.run(`DELETE FROM outbox_events AS old
      WHERE old.status = 'pending' AND old.kind IN ('progress', 'session_pin', 'workspace')
        AND NOT (old.kind = 'progress' AND COALESCE(json_extract(old.payload, '$.final'), 0) = 1)
        AND EXISTS (SELECT 1 FROM outbox_events AS newer WHERE newer.task_id = old.task_id
          AND newer.kind = old.kind AND newer.status = 'pending' AND newer.id > old.id)`).changes);
    if (dropped > 0) {
      const total = Number(this.readMeta("dropped_total") ?? 0) + dropped;
      this.writeMeta("dropped_total", String(total));
      log.warn(`outbox exceeded ${this.maxBytes} bytes; compacted ${dropped} covered overwrite record(s) (total dropped: ${total})`);
    }
    // SQLite can retain allocated pages after compaction; never evict reliable rows to shrink the file.
    log.warn(`outbox remains over its ${this.maxBytes} byte soft cap; retaining reliable reports`);
  }

  private query(sql: string): ReturnType<Database["query"]> {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private readMeta(key: string): string | null {
    const row = this.query("SELECT value FROM outbox_meta WHERE key = ?").get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  private writeMeta(key: string, value: string): void {
    this.db.run(
      "INSERT INTO outbox_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, value],
    );
  }
}

interface OutboxDelivery {
  record: MultiremiOutboxRecord;
  recordIds: number[];
  blocked: boolean;
}

function toRecord(row: Record<string, unknown>): MultiremiOutboxRecord {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(row.payload ?? "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed;
  } catch {
    // A corrupt payload is delivered as empty; the server-side guards make
    // the resulting call a no-op rather than a crash loop.
  }
  if (payload.runtime_id === undefined && typeof row.route_runtime === 'string') payload.runtime_id = row.route_runtime;
  return {
    id: Number(row.id),
    taskId: String(row.task_id),
    kind: String(row.kind) as MultiremiOutboxKind,
    payload,
    seq: Number(row.seq),
    terminal: Number(row.terminal ?? 0) === 1,
    attempts: Number(row.attempts ?? 0),
  };
}

/** Best-effort, last-write-wins reports: rejecting one must not dam the queue. */
const DROPPABLE_KINDS = new Set<MultiremiOutboxKind>(["progress", "session_pin", "workspace"]);

/**
 * Deterministic replays/rejections that must not stall the queue: a `start`
 * replay after the task left dispatched returns 400 (the server already has
 * it), and best-effort status reports (progress/pin/workspace) are dropped on
 * any 4xx exactly like their old fire-and-forget call sites logged-and-moved-on.
 */
function isDeliveredEquivalent(error: unknown, record: MultiremiOutboxRecord): boolean {
  if (error instanceof DaemonProtocolRpcError) return record.kind === "start" && error.code === "start_replayed";
  if (!(error instanceof MultiremiDaemonHttpError)) return false;
  if (record.kind === "start" && error.status === 400 && !record.payload.usage_run_id) return true;
  if (DROPPABLE_KINDS.has(record.kind) && error.status >= 400 && error.status < 500) {
    log.warn(`outbox dropped rejected ${record.kind} report for task ${record.taskId}: ${error.message}`);
    return true;
  }
  return false;
}

/**
 * 401/403/410 are revoked/retired authority; 404 is a deleted task; other 4xx
 * are deterministic rejections. Retrying any of them forever cannot succeed —
 * they park the queue in `blocked` with a diagnostic instead.
 */
function isPermanentDeliveryError(error: unknown): boolean {
  if (error instanceof DaemonProtocolRpcError) return !error.retryable;
  if (!(error instanceof MultiremiDaemonHttpError)) return false;
  return error.status >= 400 && error.status < 500;
}
