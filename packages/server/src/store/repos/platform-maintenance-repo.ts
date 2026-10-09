import { nowIso } from "@multiremi/ids.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import type {
  MultiremiPlatformDrainStatus,
  MultiremiPlatformMaintenance,
} from "@multiremi/contracts/types.js";
import { RUNTIME_HEARTBEAT_STALE_MS } from "./runtimes-repo.js";

type Row = Record<string, unknown>;

export const PLATFORM_DRAIN_DEFAULT_TTL_MS = 120_000;
export const PLATFORM_DRAIN_MIN_TTL_MS = 30_000;
export const PLATFORM_DRAIN_MAX_TTL_MS = 10 * 60_000;

export class PlatformDrainConflictError extends Error {
  readonly code = "platform_drain_conflict";
}

/**
 * Persistent platform maintenance (drain) state. One row, survives API
 * restarts. Pre-switch leases expire lazily so an abandoned preparation does
 * not stop scheduling. Once switching starts, only a terminal host receipt
 * may release the gate: the API can return before Web verification or rollback.
 */
export class PlatformMaintenanceRepo {
  constructor(private readonly db: SqlDatabase) {}

  /** One fresh, narrow read per mutation; no operation payload or lease writes. */
  writeBlockingOperationId(): string | null {
    const row = this.db.query(
      `SELECT operation.id FROM multiremi_platform_maintenance maintenance
       JOIN multiremi_platform_operations operation ON operation.id = maintenance.operation_id
       WHERE maintenance.id = 'platform' AND maintenance.mode = 'draining'
         AND operation.active_slot = 1
         AND operation.status IN ('switching', 'restarting', 'verifying', 'rolling_back')`,
    ).get() as { id: string } | null;
    return row?.id ?? null;
  }

  get(nowMs = Date.now()): MultiremiPlatformMaintenance {
    this.ensureRow();
    const maintenance = this.read();
    if (maintenance.mode !== "draining") return maintenance;
    const expiresAt = maintenance.expiresAt ? Date.parse(maintenance.expiresAt) : Number.NaN;
    if (Number.isFinite(expiresAt) && expiresAt > nowMs) return maintenance;
    // API downtime can outlast the lease during migration or a DB restore.
    // Do not admit new tasks until the host verifies both API and Web, or
    // finishes recovery. This state is persisted in the pre-switch backup.
    const switching = maintenance.operationId && this.db.query(
      `SELECT id FROM multiremi_platform_operations
       WHERE id = ? AND active_slot = 1 AND status IN ('switching', 'restarting', 'verifying', 'rolling_back')`,
    ).get(maintenance.operationId);
    if (switching) return maintenance;
    // An abandoned preparation/drain is safe to release on lease expiry.
    this.db.run(
      `UPDATE multiremi_platform_maintenance
       SET mode = 'normal', operation_id = NULL, started_at = NULL, expires_at = NULL, reason = NULL, updated_at = ?
       WHERE id = 'platform' AND mode = 'draining'
         AND NOT EXISTS (
           SELECT 1 FROM multiremi_platform_operations
           WHERE id = multiremi_platform_maintenance.operation_id AND active_slot = 1
             AND status IN ('switching', 'restarting', 'verifying', 'rolling_back')
         )`,
      [nowIso()],
    );
    return this.read();
  }

  /**
   * normal → draining bumps the generation; re-beginning for the same
   * operation is an idempotent lease renewal. A different operation while
   * draining is a conflict (operations are already serialized by active_slot,
   * so this only guards buggy callers).
   */
  beginDrain(input: { operationId: string; reason?: string | null; ttlMs?: number }): MultiremiPlatformMaintenance {
    const current = this.get();
    const ttl = clampTtl(input.ttlMs);
    const now = Date.now();
    const nowStr = nowIso();
    const expiresAt = new Date(now + ttl).toISOString();
    if (current.mode === "draining") {
      if (current.operationId !== input.operationId) {
        throw new PlatformDrainConflictError(
          `platform is already draining for operation ${current.operationId ?? "unknown"}`,
        );
      }
      this.db.run(
        `UPDATE multiremi_platform_maintenance SET expires_at = ?, updated_at = ? WHERE id = 'platform' AND mode = 'draining'`,
        [expiresAt, nowStr],
      );
      return this.read();
    }
    this.db.run(
      `UPDATE multiremi_platform_maintenance
       SET mode = 'draining', generation = generation + 1, operation_id = ?, started_at = ?, expires_at = ?, reason = ?, updated_at = ?
       WHERE id = 'platform' AND mode = 'normal'`,
      [input.operationId, nowStr, expiresAt, input.reason ?? null, nowStr],
    );
    return this.read();
  }

  /** Returns null when the lease is no longer held by this operation. */
  renewDrain(operationId: string, ttlMs?: number): MultiremiPlatformMaintenance | null {
    const current = this.get();
    if (current.mode !== "draining" || current.operationId !== operationId) return null;
    const expiresAt = new Date(Date.now() + clampTtl(ttlMs)).toISOString();
    const result = this.db.run(
      `UPDATE multiremi_platform_maintenance
       SET expires_at = ?, updated_at = ?
       WHERE id = 'platform' AND mode = 'draining' AND operation_id = ?`,
      [expiresAt, nowIso(), operationId],
    );
    return result.changes > 0 ? this.read() : null;
  }

  /**
   * Idempotent, and fail closed during a switch. The host must reconcile a
   * terminal result before releasing a gate that protects possible rollback.
   */
  releaseDrain(operationId: string): MultiremiPlatformMaintenance {
    this.ensureRow();
    this.db.run(
      `UPDATE multiremi_platform_maintenance
       SET mode = 'normal', operation_id = NULL, started_at = NULL, expires_at = NULL, reason = NULL, updated_at = ?
       WHERE id = 'platform' AND mode = 'draining' AND operation_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM multiremi_platform_operations
           WHERE id = multiremi_platform_maintenance.operation_id AND active_slot = 1
             AND status IN ('switching', 'restarting', 'verifying', 'rolling_back')
         )`,
      [nowIso(), operationId],
    );
    return this.get();
  }

  recordRuntimeDrainAck(runtimeId: string, generation: number, activeTasks: number | null): void {
    this.db.run(
      `UPDATE multiremi_runtimes
       SET drain_ack_generation = ?, drain_ack_at = ?, drain_reported_active_tasks = ?
       WHERE id = ?`,
      [Math.max(0, Math.floor(generation)), nowIso(), activeTasks == null ? null : Math.max(0, Math.floor(activeTasks)), runtimeId],
    );
  }

  /**
   * Aggregated drain gate. `ready` requires every effectively-online runtime
   * to have acknowledged the current generation AND the server-authoritative
   * in-flight task count to be zero. Offline runtimes are excluded from the
   * ack quorum, but their unrecovered in-flight tasks still hold the gate —
   * failing safe toward the drain timeout instead of switching under load.
   */
  drainStatus(nowMs = Date.now()): MultiremiPlatformDrainStatus {
    const maintenance = this.get(nowMs);
    const runtimes = this.db.query(
      "SELECT id, name, daemon_id, status, last_heartbeat_at, drain_ack_generation, drain_reported_active_tasks FROM multiremi_runtimes",
    ).all() as Row[];
    const online = runtimes.filter((row) => {
      if (String(row.status ?? "") === "offline") return false;
      const heartbeat = row.last_heartbeat_at ? Date.parse(String(row.last_heartbeat_at)) : Number.NaN;
      return Number.isFinite(heartbeat) && nowMs - heartbeat <= RUNTIME_HEARTBEAT_STALE_MS;
    });
    const acked = online.filter(
      (row) => Number(row.drain_ack_generation ?? -1) >= maintenance.generation,
    );
    const pendingRuntimes = online
      .filter((row) => Number(row.drain_ack_generation ?? -1) < maintenance.generation)
      .map((row) => ({
        id: String(row.id),
        name: String(row.name ?? ""),
        daemonId: row.daemon_id ? String(row.daemon_id) : null,
      }));
    const activeRow = this.db.query(
      `SELECT COUNT(*) AS n FROM multiremi_turn_execution_records
       WHERE status IN ('dispatched', 'running', 'waiting_local_directory', 'awaiting_human')`,
    ).get() as { n?: number } | null;
    // A provider can still be shutting down or flushing its outbox after the
    // task row is terminal. Both the daemon and server must report zero.
    const reportedActive = runtimes.reduce((sum, row) => sum + Math.max(0, Number(row.drain_reported_active_tasks ?? 0)), 0);
    const activeTasks = Math.max(Number(activeRow?.n ?? 0), reportedActive);
    return {
      maintenance,
      onlineDaemons: online.length,
      ackedDaemons: acked.length,
      activeTasks,
      pendingRuntimes,
      ready: maintenance.mode === "draining" && pendingRuntimes.length === 0 && activeTasks === 0,
    };
  }

  private read(): MultiremiPlatformMaintenance {
    const row = this.db.query(
      "SELECT * FROM multiremi_platform_maintenance WHERE id = 'platform'",
    ).get() as Row;
    return {
      mode: String(row.mode ?? "normal") === "draining" ? "draining" : "normal",
      generation: Number(row.generation ?? 0),
      operationId: row.operation_id ? String(row.operation_id) : null,
      startedAt: row.started_at ? String(row.started_at) : null,
      expiresAt: row.expires_at ? String(row.expires_at) : null,
      reason: row.reason ? String(row.reason) : null,
    };
  }

  private ensureRow(): void {
    const now = nowIso();
    this.db.run(
      `INSERT INTO multiremi_platform_maintenance (id, mode, generation, created_at, updated_at)
       VALUES ('platform', 'normal', 0, ?, ?) ON CONFLICT(id) DO NOTHING`,
      [now, now],
    );
  }
}

function clampTtl(ttlMs: number | undefined): number {
  if (!Number.isFinite(ttlMs) || ttlMs == null) return PLATFORM_DRAIN_DEFAULT_TTL_MS;
  return Math.max(PLATFORM_DRAIN_MIN_TTL_MS, Math.min(PLATFORM_DRAIN_MAX_TTL_MS, Math.floor(ttlMs)));
}
