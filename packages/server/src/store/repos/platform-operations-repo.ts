import { createId, nowIso } from "@multiremi/ids.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { parseJson, toJson } from "@multiremi/store/helpers.js";
import type {
  CreatePlatformOperationInput,
  MultiremiPlatformDeploymentDriver,
  MultiremiPlatformAutoUpdateResult,
  MultiremiPlatformOperation,
  MultiremiPlatformOperationStatus,
  MultiremiPlatformRelease,
  MultiremiPlatformService,
  MultiremiPlatformPreflight,
  MultiremiPlatformUpdateMode,
  ReportPlatformOperationInput,
} from "@multiremi/contracts/types.js";
import {
  computeDailyScheduleNextRun,
  DEFAULT_PLATFORM_UPDATE_TIME,
  DEFAULT_PLATFORM_UPDATE_TIMEZONE,
} from "@multiremi/store/schedule.js";

type Row = Record<string, unknown>;

const TERMINAL_STATUSES = new Set<MultiremiPlatformOperationStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "rolled_back",
]);

/** Cancellation is only honored before the container-switch phase begins. */
const CANCELLABLE_STATUSES = new Set<MultiremiPlatformOperationStatus>([
  "queued",
  "preparing",
  "pulling",
  "draining",
  "backing_up",
]);

export function isTerminalPlatformOperationStatus(status: MultiremiPlatformOperationStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export class PlatformOperationConflictError extends Error {
  readonly code = "platform_operation_active";
}

export class PlatformOperationNotCancellableError extends Error {
  readonly code = "platform_operation_not_cancellable";
}

export class PlatformOperationIdempotencyConflictError extends Error {
  readonly code = "platform_operation_idempotency_conflict";
}

export class PlatformOperationReceiptConflictError extends Error {
  readonly code = "platform_operation_receipt_conflict";
}

export class PlatformOperationReceiptValidationError extends Error {
  readonly code = "platform_operation_receipt_invalid";
}

/** The host keeps this outside the database that an update may restore. */
export interface PlatformOperationReceipt {
  operation: MultiremiPlatformOperation;
  report: ReportPlatformOperationInput;
  completedAt: string;
}

export interface PlatformStateRecord {
  updateMode: MultiremiPlatformUpdateMode | null;
  releaseFeedUrl: string | null;
  defaultReleaseFeedUrl: string | null;
  preflight: MultiremiPlatformPreflight | null;
  driver: MultiremiPlatformDeploymentDriver;
  currentRelease: MultiremiPlatformRelease | null;
  latestRelease: MultiremiPlatformRelease | null;
  recentReleases: MultiremiPlatformRelease[];
  services: MultiremiPlatformService[];
  autoUpdateStable: boolean;
  autoUpdateTime: string;
  autoUpdateTimezone: string;
  autoUpdateNextCheckAt: string | null;
  autoUpdateLastCheckedAt: string | null;
  autoUpdateLastResult: MultiremiPlatformAutoUpdateResult | null;
  updaterHeartbeatAt: string | null;
}

export interface PlatformAutoUpdateSettingsInput {
  releaseFeedUrl?: string | null;
  enabled: boolean;
  time: string;
  timezone: string;
}

export class PlatformOperationsRepo {
  constructor(private readonly db: SqlDatabase) {}

  getState(): PlatformStateRecord {
    let row = this.db.query("SELECT * FROM multiremi_platform_state WHERE id = 'platform'").get() as Row | null;
    if (!row) {
      this.ensureState();
      row = this.db.query("SELECT * FROM multiremi_platform_state WHERE id = 'platform'").get() as Row;
    }
    return toState(row);
  }

  setAutoUpdateStable(enabled: boolean): PlatformStateRecord {
    const current = this.getState();
    return this.setAutoUpdateSettings({
      enabled,
      time: current.autoUpdateTime,
      timezone: current.autoUpdateTimezone,
    });
  }

  setAutoUpdateSettings(input: PlatformAutoUpdateSettingsInput, at: Date = new Date()): PlatformStateRecord {
    this.ensureState();
    const now = at.toISOString();
    const nextCheckAt = input.enabled
      ? computeDailyScheduleNextRun(input.time, input.timezone, at)
      : null;
    this.db.run(
      `UPDATE multiremi_platform_state
       SET auto_update_stable = ?, auto_update_time = ?, auto_update_timezone = ?,
           auto_update_next_check_at = ?, updated_at = ?
       WHERE id = 'platform'`,
      [input.enabled ? 1 : 0, input.time, input.timezone, nextCheckAt, now],
    );
    if (input.releaseFeedUrl !== undefined) {
      this.db.run(
        "UPDATE multiremi_platform_state SET release_feed_url = ?, latest_release = NULL, updater_preflight = NULL WHERE id = 'platform'",
        [input.releaseFeedUrl],
      );
    }
    return this.getState();
  }

  claimDueAutoUpdateCheck(at: Date = new Date()): PlatformStateRecord | null {
    const current = this.getState();
    if (!current.autoUpdateStable) return null;
    const now = at.toISOString();
    const dueAt = current.autoUpdateNextCheckAt;
    if (!dueAt || !Number.isFinite(Date.parse(dueAt))) {
      const nextCheckAt = computeDailyScheduleNextRun(current.autoUpdateTime, current.autoUpdateTimezone, at);
      if (dueAt) {
        this.db.run(
          `UPDATE multiremi_platform_state
           SET auto_update_next_check_at = ?, updated_at = ?
           WHERE id = 'platform' AND auto_update_stable = 1 AND auto_update_next_check_at = ?`,
          [nextCheckAt, now, dueAt],
        );
      } else {
        this.db.run(
          `UPDATE multiremi_platform_state
           SET auto_update_next_check_at = ?, updated_at = ?
           WHERE id = 'platform' AND auto_update_stable = 1 AND auto_update_next_check_at IS NULL`,
          [nextCheckAt, now],
        );
      }
      return null;
    }
    if (Date.parse(dueAt) > at.getTime()) return null;
    const nextCheckAt = computeDailyScheduleNextRun(current.autoUpdateTime, current.autoUpdateTimezone, at);
    const result = this.db.run(
      `UPDATE multiremi_platform_state
       SET auto_update_next_check_at = ?, auto_update_last_checked_at = ?,
           auto_update_last_result = 'checking', updated_at = ?
       WHERE id = 'platform' AND auto_update_stable = 1 AND auto_update_next_check_at = ?`,
      [nextCheckAt, now, now, dueAt],
    );
    return result.changes > 0 ? this.getState() : null;
  }

  setAutoUpdateResult(result: MultiremiPlatformAutoUpdateResult): PlatformStateRecord {
    this.ensureState();
    this.db.run(
      "UPDATE multiremi_platform_state SET auto_update_last_result = ?, updated_at = ? WHERE id = 'platform'",
      [result, nowIso()],
    );
    return this.getState();
  }

  heartbeat(input: {
    updateMode?: MultiremiPlatformUpdateMode | null;
    defaultReleaseFeedUrl?: string | null;
    releaseFeedUrl?: string | null;
    preflight?: MultiremiPlatformPreflight | null;
    driver: MultiremiPlatformDeploymentDriver;
    currentRelease?: MultiremiPlatformRelease | null;
    latestRelease?: MultiremiPlatformRelease | null;
    recentReleases?: MultiremiPlatformRelease[];
    services?: MultiremiPlatformService[];
  }): PlatformStateRecord {
    const current = this.getState();
    const now = nowIso();
    // A legacy full inspection cannot attest to a mode. A keepalive must not erase it.
    const fullInspection = input.currentRelease !== undefined || input.services !== undefined;
    const updateMode = input.updateMode !== undefined ? input.updateMode
      : fullInspection || input.driver !== current.driver ? null : current.updateMode;
    const defaultFeed = input.defaultReleaseFeedUrl === undefined ? current.defaultReleaseFeedUrl : input.defaultReleaseFeedUrl;
    const invalidate = input.driver !== current.driver || updateMode !== current.updateMode
      || (current.releaseFeedUrl === null && defaultFeed !== current.defaultReleaseFeedUrl);
    // Ignore results fetched from a source that changed while the request was in flight,
    // including a changed default URL after restarting the updater.
    const sourceMatches = (input.releaseFeedUrl === undefined || input.releaseFeedUrl === current.releaseFeedUrl)
      && (!input.preflight?.source || input.preflight.source.url === (current.releaseFeedUrl ?? defaultFeed));
    const preflight = sourceMatches && input.preflight !== undefined ? input.preflight : invalidate ? null : current.preflight;
    const row = this.db.query(
      `UPDATE multiremi_platform_state
       SET driver = ?, update_mode = ?, updater_preflight = ?, current_release = ?, latest_release = ?, recent_releases = ?, services = ?,
           updater_heartbeat_at = ?, updated_at = ?, default_release_feed_url = ?
       WHERE id = 'platform' RETURNING *`,
    ).get(
        input.driver,
        updateMode,
        toJson(preflight),
        toJson(input.currentRelease === undefined ? current.currentRelease : input.currentRelease),
        toJson(sourceMatches && input.latestRelease !== undefined ? input.latestRelease : invalidate ? null : current.latestRelease),
        toJson(input.recentReleases ?? current.recentReleases),
        toJson(input.services ?? current.services),
        now,
        now,
        defaultFeed,
    ) as Row;
    return toState(row);
  }

  create(input: CreatePlatformOperationInput, requestedBy: string): MultiremiPlatformOperation {
    const requestId = input.requestId?.trim() || null;
    if (requestId) {
      const existing = this.findByRequestId(requestedBy, requestId);
      if (existing) {
        if (!sameRequest(existing, input)) {
          throw new PlatformOperationIdempotencyConflictError(
            "requestId was already used for a different platform operation",
          );
        }
        return existing;
      }
    }
    const state = this.getState();
    const id = createId("pop");
    const now = nowIso();
    try {
      this.db.run(
        `INSERT INTO multiremi_platform_operations (
          id, idempotency_key, kind, status, driver, active_slot, target_version, target_ref,
          target_manifest, progress, requested_by, created_at, updated_at
        ) VALUES (?, ?, ?, 'queued', ?, 1, ?, ?, ?, '{}', ?, ?, ?)`,
        [
          id,
          requestId,
          input.kind,
          state.driver,
          input.targetVersion ?? null,
          input.targetRef ?? null,
          toJson(input.targetManifest ?? {}),
          requestedBy,
          now,
          now,
        ],
      );
    } catch (error) {
      const message = String((error as Error).message ?? error).toLowerCase();
      if (message.includes("unique") || message.includes("duplicate")) {
        if (requestId) {
          const existing = this.findByRequestId(requestedBy, requestId);
          if (existing && sameRequest(existing, input)) return existing;
          if (existing) throw new PlatformOperationIdempotencyConflictError("requestId was already used for a different platform operation");
        }
        throw new PlatformOperationConflictError("another platform operation is already active");
      }
      throw error;
    }
    return this.get(id)!;
  }

  findByRequestId(requestedBy: string, requestId: string): MultiremiPlatformOperation | null {
    const row = this.db.query(
      "SELECT * FROM multiremi_platform_operations WHERE requested_by = ? AND idempotency_key = ? LIMIT 1",
    ).get(requestedBy, requestId) as Row | null;
    return row ? toOperation(row) : null;
  }

  get(id: string): MultiremiPlatformOperation | null {
    const row = this.db.query("SELECT * FROM multiremi_platform_operations WHERE id = ?").get(id) as Row | null;
    return row ? toOperation(row) : null;
  }

  active(): MultiremiPlatformOperation | null {
    const row = this.db.query(
      "SELECT * FROM multiremi_platform_operations WHERE active_slot = 1 ORDER BY created_at ASC LIMIT 1",
    ).get() as Row | null;
    return row ? toOperation(row) : null;
  }

  list(limit = 20): MultiremiPlatformOperation[] {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = this.db.query(
      "SELECT * FROM multiremi_platform_operations ORDER BY created_at DESC LIMIT ?",
    ).all(safeLimit) as Row[];
    return rows.map(toOperation);
  }

  claim(): MultiremiPlatformOperation | null {
    const pending = this.db.query(
      "SELECT id, status FROM multiremi_platform_operations WHERE active_slot = 1 ORDER BY created_at ASC LIMIT 1",
    ).get() as { id?: string; status?: string } | null;
    if (!pending?.id) return null;
    if (pending.status !== "queued") return this.get(pending.id);
    const now = nowIso();
    const result = this.db.run(
      `UPDATE multiremi_platform_operations
       SET status = 'preparing', started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE id = ? AND status = 'queued'`,
      [now, now, pending.id],
    );
    return result.changes > 0 ? this.get(pending.id) : null;
  }

  /**
   * Operator-initiated cancellation. A queued operation cancels immediately;
   * a claimed pre-switch operation is flagged and the updater finalizes it
   * (releasing the drain lease it may hold). From `switching` on, cancellation
   * is rejected — the container swap is already in flight.
   */
  requestCancel(id: string): MultiremiPlatformOperation {
    const current = this.get(id);
    if (!current) throw new PlatformOperationNotCancellableError("operation not found");
    if (TERMINAL_STATUSES.has(current.status) || !CANCELLABLE_STATUSES.has(current.status)) {
      throw new PlatformOperationNotCancellableError(
        `operation is ${current.status} and can no longer be cancelled`,
      );
    }
    const now = nowIso();
    if (current.status === "queued") {
      const result = this.db.run(
        `UPDATE multiremi_platform_operations
         SET status = 'cancelled', cancel_requested = 1, active_slot = NULL, updated_at = ?, finished_at = ?
         WHERE id = ? AND status = 'queued'`,
        [now, now, id],
      );
      if (result.changes > 0) return this.get(id)!;
      // Lost the race to the updater's claim — fall through to the flag path.
    }
    const flagged = this.db.run(
      `UPDATE multiremi_platform_operations SET cancel_requested = 1, updated_at = ? WHERE id = ?
       AND status IN ('preparing', 'pulling', 'draining', 'backing_up')`,
      [now, id],
    );
    if (flagged.changes === 0) throw new PlatformOperationNotCancellableError("operation has entered the switch phase");
    return this.get(id)!;
  }

  report(id: string, input: ReportPlatformOperationInput): MultiremiPlatformOperation | null {
    return this.db.transaction(() => this.reportWithinTransaction(id, input))();
  }

  private reportWithinTransaction(id: string, input: ReportPlatformOperationInput): MultiremiPlatformOperation | null {
    const current = this.get(id);
    if (!current) return null;
    if (TERMINAL_STATUSES.has(current.status)) return current;
    const now = nowIso();
    const terminal = TERMINAL_STATUSES.has(input.status);
    const updated = this.db.run(
      `UPDATE multiremi_platform_operations
       SET status = ?, progress = ?, output = ?, error = ?, previous_release = ?, result_release = ?,
           active_slot = ?, updated_at = ?, finished_at = ?
       WHERE id = ?${input.status === "switching" || input.status === "restarting" ? " AND cancel_requested = 0" : ""}`,
      [
        input.status,
        toJson(input.progress ?? current.progress),
        input.output === undefined ? current.output : input.output,
        input.error === undefined ? current.error : input.error,
        toJson(input.previousRelease === undefined ? current.previousRelease : input.previousRelease),
        toJson(input.resultRelease === undefined ? current.resultRelease : input.resultRelease),
        terminal ? null : 1,
        now,
        terminal ? now : null,
        id,
      ],
    );
    if (updated.changes === 0) throw new PlatformOperationConflictError("operation was cancelled before switching");
    if (["switching", "restarting", "verifying", "rolling_back"].includes(input.status)) {
      // Older API releases only understand lease expiry. Preserve a fence
      // they understand when this control-plane state survives DB rollback.
      this.db.run(
        `UPDATE multiremi_platform_maintenance SET expires_at = ?, updated_at = ?
         WHERE id = 'platform' AND mode = 'draining' AND operation_id = ?`,
        ["9999-12-31T23:59:59.999Z", now, id],
      );
    } else if (terminal) {
      this.db.run(
        `UPDATE multiremi_platform_maintenance
         SET mode = 'normal', operation_id = NULL, started_at = NULL, expires_at = NULL, reason = NULL, updated_at = ?
         WHERE id = 'platform' AND operation_id = ?`,
        [now, id],
      );
    }
    return this.get(id);
  }

  /**
   * Restore operation history lost with a database backup, and finish any
   * pre-switch operation resurrected by that backup. Replaying a receipt must
   * never release an unrelated operation's active slot or maintenance gate.
   */
  reconcile(receipts: PlatformOperationReceipt[]): MultiremiPlatformOperation[] {
    if (!Array.isArray(receipts) || receipts.length > 100) {
      throw new PlatformOperationReceiptValidationError("receipts must be an array of at most 100 entries");
    }
    receipts.forEach(validateReceipt);
    return this.db.transaction(() => {
      for (const receipt of receipts) {
        const { operation, report, completedAt } = receipt;
        const existing = this.get(operation.id);
        const keyed = operation.requestId ? this.findByRequestId(operation.requestedBy, operation.requestId) : null;
        if ((existing && !sameOperationIdentity(existing, operation)) || (keyed && keyed.id !== operation.id)) {
          throw new PlatformOperationReceiptConflictError(`operation ${operation.id} does not match the host receipt identity`);
        }
        if (existing && TERMINAL_STATUSES.has(existing.status)) {
          if (existing.status !== report.status) {
            throw new PlatformOperationReceiptConflictError(`operation ${operation.id} already has a different terminal outcome`);
          }
          const resultRelease = report.resultRelease === undefined ? operation.resultRelease : report.resultRelease;
          if ((existing.resultRelease?.ref ?? null) !== (resultRelease?.ref ?? null)) {
            throw new PlatformOperationReceiptConflictError(`operation ${operation.id} already has a different terminal release`);
          }
          continue;
        }
        if (!existing) {
          // Insert directly as terminal: a new active operation may already
          // exist, and a historical receipt must not contend for its slot.
          this.db.run(
            `INSERT INTO multiremi_platform_operations (
              id, idempotency_key, kind, status, driver, active_slot, target_version, target_ref,
              target_manifest, progress, requested_by, output, error, previous_release,
              result_release, cancel_requested, created_at, updated_at, started_at, finished_at
            ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              operation.id, operation.requestId ?? null, operation.kind, report.status, operation.driver,
              operation.targetVersion, operation.targetRef, toJson(operation.targetManifest),
              toJson(report.progress ?? operation.progress), operation.requestedBy,
              report.output === undefined ? operation.output : report.output,
              report.error === undefined ? operation.error : report.error,
              toJson(report.previousRelease === undefined ? operation.previousRelease : report.previousRelease),
              toJson(report.resultRelease === undefined ? operation.resultRelease : report.resultRelease),
              operation.cancelRequested ? 1 : 0, operation.createdAt, completedAt,
              operation.startedAt, completedAt,
            ],
          );
        } else {
          this.reportWithinTransaction(operation.id, report);
          this.db.run(
            "UPDATE multiremi_platform_operations SET updated_at = ?, finished_at = ? WHERE id = ?",
            [completedAt, completedAt, operation.id],
          );
          if (existing.requestedBy === "system:auto-update") {
            this.setAutoUpdateResult(report.status === "succeeded" ? "updated" : "failed");
          }
        }
      }
      for (const { operation } of receipts) {
        this.db.run(
          `UPDATE multiremi_platform_maintenance
           SET mode = 'normal', operation_id = NULL, started_at = NULL, expires_at = NULL, reason = NULL, updated_at = ?
           WHERE id = 'platform' AND operation_id = ?`,
          [nowIso(), operation.id],
        );
      }
      return receipts.map(({ operation }) => this.get(operation.id)!);
    })();
  }

  private ensureState(): void {
    const now = nowIso();
    this.db.run(
      `INSERT INTO multiremi_platform_state (id, driver, created_at, updated_at)
       VALUES ('platform', 'systemd_release', ?, ?) ON CONFLICT(id) DO NOTHING`,
      [now, now],
    );
  }
}

function toState(row: Row): PlatformStateRecord {
  return {
    updateMode: row.update_mode ? String(row.update_mode) as MultiremiPlatformUpdateMode : null,
    releaseFeedUrl: row.release_feed_url ? String(row.release_feed_url) : null,
    defaultReleaseFeedUrl: row.default_release_feed_url ? String(row.default_release_feed_url) : null,
    preflight: parseJson<MultiremiPlatformPreflight | null>(row.updater_preflight, null),
    driver: String(row.driver ?? "systemd_release") as MultiremiPlatformDeploymentDriver,
    currentRelease: parseNullableRelease(row.current_release),
    latestRelease: parseNullableRelease(row.latest_release),
    recentReleases: parseJson<MultiremiPlatformRelease[]>(row.recent_releases, []),
    services: parseJson<MultiremiPlatformService[]>(row.services, []),
    autoUpdateStable: Number(row.auto_update_stable ?? 0) === 1,
    autoUpdateTime: String(row.auto_update_time ?? DEFAULT_PLATFORM_UPDATE_TIME),
    autoUpdateTimezone: String(row.auto_update_timezone ?? DEFAULT_PLATFORM_UPDATE_TIMEZONE),
    autoUpdateNextCheckAt: row.auto_update_next_check_at ? String(row.auto_update_next_check_at) : null,
    autoUpdateLastCheckedAt: row.auto_update_last_checked_at ? String(row.auto_update_last_checked_at) : null,
    autoUpdateLastResult: row.auto_update_last_result
      ? String(row.auto_update_last_result) as MultiremiPlatformAutoUpdateResult
      : null,
    updaterHeartbeatAt: row.updater_heartbeat_at ? String(row.updater_heartbeat_at) : null,
  };
}

function toOperation(row: Row): MultiremiPlatformOperation {
  return {
    id: String(row.id),
    requestId: row.idempotency_key ? String(row.idempotency_key) : null,
    kind: String(row.kind) as MultiremiPlatformOperation["kind"],
    status: String(row.status) as MultiremiPlatformOperationStatus,
    driver: String(row.driver) as MultiremiPlatformDeploymentDriver,
    targetVersion: row.target_version ? String(row.target_version) : null,
    targetRef: row.target_ref ? String(row.target_ref) : null,
    targetManifest: parseJson<Record<string, unknown>>(row.target_manifest, {}),
    progress: parseJson<Record<string, unknown>>(row.progress, {}),
    requestedBy: String(row.requested_by),
    output: row.output ? String(row.output) : null,
    error: row.error ? String(row.error) : null,
    previousRelease: parseNullableRelease(row.previous_release),
    resultRelease: parseNullableRelease(row.result_release),
    cancelRequested: Number(row.cancel_requested ?? 0) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: row.started_at ? String(row.started_at) : null,
    finishedAt: row.finished_at ? String(row.finished_at) : null,
  };
}

function sameRequest(existing: MultiremiPlatformOperation, input: CreatePlatformOperationInput): boolean {
  return existing.kind === input.kind
    && existing.targetVersion === (input.targetVersion ?? null)
    && existing.targetRef === (input.targetRef ?? null)
    && JSON.stringify(existing.targetManifest) === JSON.stringify(input.targetManifest ?? {});
}

function sameOperationIdentity(left: MultiremiPlatformOperation, right: MultiremiPlatformOperation): boolean {
  return left.id === right.id && left.requestId === (right.requestId ?? null)
    && left.requestedBy === right.requestedBy && left.createdAt === right.createdAt
    && left.driver === right.driver && left.kind === right.kind
    && left.targetVersion === right.targetVersion && left.targetRef === right.targetRef
    && canonicalJson(left.targetManifest) === canonicalJson(right.targetManifest);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function validateReceipt(receipt: PlatformOperationReceipt): void {
  const operation = receipt?.operation;
  const report = receipt?.report;
  if (!operation || !report || !["update", "rollback"].includes(operation.kind)
    || !TERMINAL_STATUSES.has(report.status)
    || typeof operation.id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(operation.id)
    || typeof operation.requestedBy !== "string" || !operation.requestedBy.trim()
    || !["systemd_release", "docker_compose", "local_profile"].includes(operation.driver)
    || !validTimestamp(operation.createdAt) || !validTimestamp(receipt.completedAt)
    || Date.parse(receipt.completedAt) < Date.parse(operation.createdAt)
    || (operation.startedAt !== null && !validTimestamp(operation.startedAt))
    || !nullableString(operation.targetVersion) || !nullableString(operation.targetRef)
    || !nullableString(operation.output) || !nullableString(operation.error)
    || (report.output !== undefined && !nullableString(report.output))
    || (report.error !== undefined && !nullableString(report.error))
    || typeof operation.cancelRequested !== "boolean"
    || !isRecord(operation.progress) || (report.progress !== undefined && !isRecord(report.progress))
    || !operation.targetManifest || typeof operation.targetManifest !== "object" || Array.isArray(operation.targetManifest)
    || (operation.requestId != null && !/^[A-Za-z0-9._:-]{1,128}$/.test(operation.requestId))) {
    throw new PlatformOperationReceiptValidationError("invalid terminal operation receipt");
  }
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

function parseNullableRelease(value: unknown): MultiremiPlatformRelease | null {
  return value === null || value === undefined || value === ""
    ? null
    : parseJson<MultiremiPlatformRelease | null>(value, null);
}
