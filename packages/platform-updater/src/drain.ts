import type { ReportPlatformOperationInput } from "@multiremi/contracts";
import { PlatformDrainLostError, type PlatformDrainStatusWire, type PlatformUpdaterClient } from "./client.js";

// Zero disables the task-wait deadline, not the renewable crash-recovery lease.
export const DEFAULT_DRAIN_TIMEOUT_MS = 0;
export const DEFAULT_DRAIN_POLL_MS = 5_000;
export const DEFAULT_DRAIN_LEASE_TTL_MS = 120_000;

export function resolveDrainTimeoutMs(value: string | number | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DRAIN_TIMEOUT_MS;
}

/** Base for drain outcomes that abort the operation BEFORE any switch ran. */
export class DrainAbortedError extends Error {}

/** Drain wait ended without the platform reaching zero active tasks. */
export class DrainTimeoutError extends DrainAbortedError {
  constructor(readonly status: PlatformDrainStatusWire | null, timeoutMs: number) {
    super(
      `platform drain timed out after ${Math.round(timeoutMs / 1000)}s; the container switch was NOT executed and task scheduling has been restored`
      + (status ? ` (${status.acked_daemons}/${status.online_daemons} daemons acknowledged, ${status.active_tasks} tasks still active)` : ""),
    );
    this.name = "DrainTimeoutError";
  }
}

/** The operator cancelled the operation before the switch phase. */
export class DrainCancelledError extends DrainAbortedError {
  constructor() {
    super("platform operation was cancelled before the container switch; task scheduling has been restored");
    this.name = "DrainCancelledError";
  }
}

/**
 * Gate handed to deployment drivers: block until the platform is drained
 * (claims paused everywhere, zero in-flight tasks). The coordinator renews the
 * drain lease on every poll and throughout backup. Before commit, an updater
 * crash releases the platform via TTL; committed switches stay pinned until
 * recovery is verified. On timeout/cancel the drain is released before throwing;
 * on success the drain stays held (the switch runs under it) until release().
 */
export interface PlatformDrainGate {
  /** Renew and recheck immediately before committing the service switch. */
  assertReady(): Promise<void>;
  waitUntilDrained(
    report: (input: ReportPlatformOperationInput) => Promise<void>,
  ): Promise<void>;
  release(): Promise<void>;
}

export interface PlatformDrainCoordinatorOptions {
  /** Zero (the default) waits until ready or cancelled, with no task-wait deadline. */
  timeoutMs?: number;
  pollMs?: number;
  leaseTtlMs?: number;
  reason?: string | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class PlatformDrainCoordinator implements PlatformDrainGate {
  private keeper: ReturnType<typeof setInterval> | null = null;
  private renewing: Promise<void> | null = null;
  private leaseError: Error | null = null;
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly leaseTtlMs: number;
  private readonly reason: string | null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly client: PlatformUpdaterClient,
    private readonly operationId: string,
    options: PlatformDrainCoordinatorOptions = {},
  ) {
    this.timeoutMs = resolveDrainTimeoutMs(options.timeoutMs);
    this.pollMs = options.pollMs ?? DEFAULT_DRAIN_POLL_MS;
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_DRAIN_LEASE_TTL_MS;
    this.reason = options.reason ?? null;
    this.sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
    this.now = options.now ?? (() => Date.now());
  }

  async waitUntilDrained(
    report: (input: ReportPlatformOperationInput) => Promise<void>,
  ): Promise<void> {
    await this.client.drainBegin(this.operationId, this.reason, this.leaseTtlMs);
    const startedAt = this.now();
    let lastStatus: PlatformDrainStatusWire | null = null;
    for (;;) {
      let renewal;
      try {
        renewal = await this.client.drainRenew(this.operationId, this.leaseTtlMs);
      } catch (error) {
        if (error instanceof PlatformDrainLostError) {
          // The lease expired (long API outage) or was released elsewhere.
          // Re-acquire instead of switching without protection.
          await this.client.drainBegin(this.operationId, this.reason, this.leaseTtlMs);
          continue;
        }
        throw error;
      }
      lastStatus = renewal.status;
      const waitedMs = this.now() - startedAt;
      if (renewal.cancel_requested) {
        await this.release();
        throw new DrainCancelledError();
      }
      if (renewal.status.ready) {
        this.startKeeper();
        await report({
          status: "draining",
          progress: {
            message: "All daemons paused and no tasks are running; switching now",
            drain: drainProgress(renewal.status, waitedMs, this.timeoutMs, "ready"),
          },
        });
        return;
      }
      if (this.timeoutMs > 0 && waitedMs >= this.timeoutMs) {
        await report({
          status: "draining",
          progress: {
            message: "Drain timed out; the switch was not executed",
            drain: drainProgress(renewal.status, waitedMs, this.timeoutMs, "timeout"),
          },
        });
        await this.release();
        throw new DrainTimeoutError(lastStatus, this.timeoutMs);
      }
      await report({
        status: "draining",
        progress: {
          message: renewal.status.active_tasks > 0
            ? `Waiting for ${renewal.status.active_tasks} running task(s) to finish`
            : `Waiting for daemons to pause claims (${renewal.status.acked_daemons}/${renewal.status.online_daemons} acknowledged)`,
          drain: drainProgress(renewal.status, waitedMs, this.timeoutMs, "waiting"),
        },
      });
      await this.sleep(this.pollMs);
    }
  }

  async release(): Promise<void> {
    this.stopKeeper();
    await this.renewing;
    await this.client.drainRelease(this.operationId);
  }

  /** Stop local timers without releasing a committed, unverified switch. */
  stopKeeper(): void {
    if (this.keeper) clearInterval(this.keeper);
    this.keeper = null;
  }

  async assertReady(): Promise<void> {
    if (this.leaseError) throw this.leaseError;
    const renewal = await this.client.drainRenew(this.operationId, this.leaseTtlMs);
    if (renewal.cancel_requested) throw new DrainCancelledError();
    if (!renewal.status.ready || renewal.maintenance.operationId !== this.operationId) {
      throw new DrainAbortedError("drain is no longer ready; service switch was not executed");
    }
  }

  private startKeeper(): void {
    if (this.keeper) return;
    this.keeper = setInterval(() => {
      if (this.renewing) return;
      this.renewing = this.assertReady().catch((error: unknown) => {
        this.leaseError = error instanceof Error ? error : new Error(String(error));
      }).finally(() => { this.renewing = null; });
    }, Math.max(10, Math.min(this.pollMs, this.leaseTtlMs / 3)));
    this.keeper.unref();
  }
}

function drainProgress(
  status: PlatformDrainStatusWire,
  waitedMs: number,
  timeoutMs: number,
  state: "waiting" | "ready" | "timeout",
): Record<string, unknown> {
  return {
    generation: status.generation,
    online_daemons: status.online_daemons,
    acked_daemons: status.acked_daemons,
    active_tasks: status.active_tasks,
    pending_runtimes: status.pending_runtimes,
    waited_ms: waitedMs,
    timeout_ms: timeoutMs,
    state,
  };
}
