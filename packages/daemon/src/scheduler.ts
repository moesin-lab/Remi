import { DatabaseRetryLoop, isDatabaseConnectionError } from "@shared/db/recovery.js";
import { withDbJob } from "@shared/observability/db-sources.js";
import { Cron } from "croner";
import { createLogger } from "@shared/logger.js";
import type {
  AutopilotStore,
  AutopilotFailureThresholdCandidate,
  AutopilotFailureThresholdOptions,
  Autopilot,
  AutopilotRun,
  AutopilotTrigger,
} from "@daemon/contracts/types.js";

const log = createLogger("multiremi-scheduler");
const DEFAULT_FAILURE_MONITOR_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FAILURE_MONITOR_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_FAILURE_MONITOR_MIN_RUNS = 50;
const DEFAULT_FAILURE_MONITOR_FAIL_RATIO = 0.9;
const DEFAULT_FAILURE_MONITOR_STARTUP_DELAY_MS = 60 * 1000;
const DEFAULT_ISSUE_ARCHIVE_SWEEP_STARTUP_DELAY_MS = 60 * 1000;

interface ScheduledAutopilotJob {
  expression: string;
  job: Cron;
  retry: DatabaseRetryLoop;
}

export interface MultiremiSchedulerOptions {
  store: AutopilotStore;
  pollIntervalMs?: number;
  failureMonitorIntervalMs?: number;
  failureMonitorLookbackMs?: number;
  failureMonitorMinRuns?: number;
  failureMonitorFailRatio?: number;
  failureMonitorStartupDelayMs?: number;
  issueArchiveSweepIntervalMs?: number;
  issueArchiveSweepStartupDelayMs?: number;
}

export class MultiremiScheduler {
  private store: AutopilotStore;
  private pollIntervalMs: number;
  private failureMonitorIntervalMs: number;
  private failureMonitorLookbackMs: number;
  private failureMonitorMinRuns: number;
  private failureMonitorFailRatio: number;
  private failureMonitorStartupDelayMs: number;
  private issueArchiveSweepIntervalMs: number | null;
  private issueArchiveSweepStartupDelayMs: number;
  private jobs = new Map<string, ScheduledAutopilotJob>();
  private syncLoop: DatabaseRetryLoop | null = null;
  private failureLoop: DatabaseRetryLoop | null = null;
  private archiveLoop: DatabaseRetryLoop | null = null;
  private running = false;

  constructor(options: MultiremiSchedulerOptions) {
    this.store = options.store;
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.failureMonitorIntervalMs = options.failureMonitorIntervalMs ?? DEFAULT_FAILURE_MONITOR_INTERVAL_MS;
    this.failureMonitorLookbackMs = options.failureMonitorLookbackMs ?? DEFAULT_FAILURE_MONITOR_LOOKBACK_MS;
    this.failureMonitorMinRuns = options.failureMonitorMinRuns ?? DEFAULT_FAILURE_MONITOR_MIN_RUNS;
    this.failureMonitorFailRatio = options.failureMonitorFailRatio ?? DEFAULT_FAILURE_MONITOR_FAIL_RATIO;
    this.failureMonitorStartupDelayMs = options.failureMonitorStartupDelayMs ?? DEFAULT_FAILURE_MONITOR_STARTUP_DELAY_MS;
    this.issueArchiveSweepIntervalMs = options.issueArchiveSweepIntervalMs ?? null;
    this.issueArchiveSweepStartupDelayMs = options.issueArchiveSweepStartupDelayMs
      ?? DEFAULT_ISSUE_ARCHIVE_SWEEP_STARTUP_DELAY_MS;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    let recovered = false;
    this.syncLoop = new DatabaseRetryLoop("scheduler.sync", () => withDbJob("scheduler.sync", () => {
      if (!recovered) {
        this.store.recoverLostScheduleTriggers();
        this.store.recoverLostRuntimeProvisionSchedules();
        recovered = true;
      }
      this.sync();
    }), this.pollIntervalMs);
    this.syncLoop.start();
    this.startFailureMonitor();
    this.startIssueArchiveSweep();
  }

  stop(): void {
    this.running = false;
    this.syncLoop?.stop();
    this.failureLoop?.stop();
    this.archiveLoop?.stop();
    for (const entry of this.jobs.values()) { entry.job.stop(); entry.retry.stop(); }
    this.jobs.clear();
  }

  sync(): void {
    this.store.advanceScheduledTargetRuns?.();
    this.tickDueTriggers();
    this.tickRuntimeProvisions();
    this.tickSystemEvents();
    this.tickScmEvents();
    const active = new Map(
      this.store.listAutopilots()
        .filter(isSchedulable)
        .filter((autopilot) => !hasScheduleTrigger(this.store, autopilot))
        .map((autopilot) => [autopilot.id, autopilot]),
    );

    for (const [id, entry] of this.jobs) {
      const autopilot = active.get(id);
      if (!autopilot || autopilot.cronExpression !== entry.expression) {
        entry.job.stop();
        entry.retry.stop();
        this.jobs.delete(id);
      }
    }

    for (const autopilot of active.values()) {
      if (this.jobs.has(autopilot.id)) continue;
      this.addJob(autopilot);
    }
  }

  scheduledCount(): number {
    return this.jobs.size;
  }

  scheduledIds(): string[] {
    return [...this.jobs.keys()];
  }

  trigger(autopilotId: string): AutopilotRun | null {
    return this.runScheduledAutopilot(autopilotId);
  }

  tickDueTriggers(now: Date = new Date()): AutopilotRun[] {
    const runs: AutopilotRun[] = [];
    for (const trigger of this.store.claimDueScheduleTriggers(now)) {
      const run = this.runScheduleTrigger(trigger);
      if (run) runs.push(run);
    }
    return runs;
  }

  tickRuntimeProvisions(now: Date = new Date()): number {
    let fired = 0;
    for (const provision of this.store.claimDueRuntimeProvisions(now)) {
      try {
        this.store.enqueueWorkspaceRuntimeProvision(provision.id);
        fired += 1;
      } catch (error) {
        if (isDatabaseConnectionError(error) || error instanceof TypeError || error instanceof ReferenceError) throw error;
        log.warn(`Runtime provision ${provision.id} dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.store.advanceRuntimeProvisionNextRun(provision.id, now);
    }
    return fired;
  }

  tickSystemEvents(now: Date = new Date()): AutopilotRun[] {
    return this.store.dispatchPendingSystemEvents(now);
  }

  tickScmEvents(now: Date = new Date()): AutopilotRun[] {
    return this.store.dispatchPendingScmEvents(now);
  }

  runFailureMonitorOnce(
    options: AutopilotFailureThresholdOptions = {},
  ): AutopilotFailureThresholdCandidate[] {
    const paused = this.store.pauseAutopilotsExceedingFailureThreshold({
      lookbackMs: this.failureMonitorLookbackMs,
      minRuns: this.failureMonitorMinRuns,
      failRatioThreshold: this.failureMonitorFailRatio,
      ...options,
    });
    if (paused.length) {
      log.info(`Autopilot failure monitor paused ${paused.length} autopilot(s)`);
    }
    return paused;
  }

  runIssueArchiveSweepOnce(now: Date = new Date()): Array<{ id: string }> {
    const archived = this.store.archiveEligibleIssues(now);
    if (archived.length) log.info(`Issue archive sweep archived ${archived.length} issue(s)`);
    return archived;
  }

  private startFailureMonitor(): void {
    if (this.failureMonitorIntervalMs <= 0) return;
    this.failureLoop = new DatabaseRetryLoop("scheduler.failure-monitor",
      () => withDbJob("scheduler.failure-monitor", () => this.runFailureMonitorOnce()), this.failureMonitorIntervalMs);
    this.failureLoop.start(this.failureMonitorStartupDelayMs);
  }

  private startIssueArchiveSweep(): void {
    if (this.issueArchiveSweepStartupDelayMs <= 0) return;
    this.archiveLoop = new DatabaseRetryLoop("scheduler.issue-archive",
      () => withDbJob("scheduler.issue-archive", () => this.runIssueArchiveSweepOnce()),
      () => this.issueArchiveSweepIntervalMs ?? this.store.issueArchiveSweepIntervalMs());
    this.archiveLoop.start(this.issueArchiveSweepStartupDelayMs);
  }

  private addJob(autopilot: Autopilot): void {
    const expression = autopilot.cronExpression;
    if (!expression) return;
    try {
      const retry = new DatabaseRetryLoop("scheduler.autopilot",
        () => withDbJob("scheduler.autopilot", () => this.runScheduledAutopilot(autopilot.id)), 0);
      const job = new Cron(expression, {
        catch: (err) => { throw err; },
        name: `multiremi:${autopilot.id}`,
        protect: true,
        unref: true,
      }, () => {
        retry.start();
      });
      this.jobs.set(autopilot.id, { expression, job, retry });
    } catch (err) {
      log.warn(`Invalid autopilot cron expression for ${autopilot.id}: ${(err as Error).message}`);
    }
  }

  private runScheduledAutopilot(autopilotId: string): AutopilotRun | null {
    const autopilot = this.store.getAutopilot(autopilotId);
    if (!autopilot || !isSchedulable(autopilot)) return null;
    try {
      return this.store.runAutopilot(autopilotId, {
        source: "schedule",
        payload: {
          cronExpression: autopilot.cronExpression,
          triggerLabel: autopilot.triggerLabel,
        },
      });
    } catch (err) {
      if (isDatabaseConnectionError(err) || err instanceof TypeError || err instanceof ReferenceError) throw err;
      log.warn(`Scheduled autopilot ${autopilotId} skipped: ${(err as Error).message}`);
      return null;
    }
  }

  private runScheduleTrigger(trigger: AutopilotTrigger): AutopilotRun | null {
    let connectionFailed = false;
    try {
      return this.store.runAutopilot(trigger.autopilotId, {
        source: "schedule",
        triggerId: trigger.id,
        payload: {
          cronExpression: trigger.cronExpression,
          triggerLabel: trigger.label,
          triggerId: trigger.id,
          trigger_id: trigger.id,
          timezone: trigger.timezone,
        },
      });
    } catch (err) {
      if (isDatabaseConnectionError(err) || err instanceof TypeError || err instanceof ReferenceError) {
        connectionFailed = true;
        throw err;
      }
      log.warn(`Scheduled autopilot trigger ${trigger.id} skipped: ${(err as Error).message}`);
      return null;
    } finally {
      if (!connectionFailed) this.store.advanceScheduleTriggerNextRun(trigger.id);
    }
  }
}

function isSchedulable(autopilot: Autopilot): boolean {
  return autopilot.status === "active"
    && autopilot.triggerKind === "schedule"
    && Boolean(autopilot.cronExpression?.trim());
}

function hasScheduleTrigger(store: AutopilotStore, autopilot: Autopilot): boolean {
  return store.listAutopilotTriggers(autopilot.id).some((trigger) => trigger.kind === "schedule" && Boolean(trigger.cronExpression?.trim()));
}
