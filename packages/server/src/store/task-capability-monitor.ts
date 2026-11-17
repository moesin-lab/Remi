import { DatabaseRetryLoop, isDatabaseConnectionError } from "@shared/db/recovery.js";
import { withDbJob } from "@shared/observability/db-sources.js";
import { createLogger } from "@shared/logger.js";

const log = createLogger("capability-monitor");

export const QUEUED_CAPABILITY_SWEEP_MS = 60_000;

export class TaskCapabilityMonitor {
  private timer: DatabaseRetryLoop | null = null;
  private sweeping = false;

  constructor(private readonly refresh: ((now: number) => unknown) | readonly ((now: number) => unknown)[]) {}

  start(): void {
    if (this.timer) return;
    this.timer = new DatabaseRetryLoop("capability.sweep", () => withDbJob("capability.sweep", () => this.sweep()), QUEUED_CAPABILITY_SWEEP_MS);
    this.timer.start();
  }

  stop(): Promise<void> {
    const stopped = this.timer?.stop();
    this.timer = null;
    return stopped ?? Promise.resolve();
  }

  sweep(): void {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const now = Date.now();
      let connectionError: unknown;
      for (const job of typeof this.refresh === "function" ? [this.refresh] : this.refresh) {
        try { job(now); }
        catch (error) {
          if (isDatabaseConnectionError(error)) connectionError ??= error;
          else log.error("Unexpected maintenance job error", error);
        }
      }
      // Preserve outage backoff after giving every independent job a chance.
      if (connectionError) throw connectionError;
    } finally {
      this.sweeping = false;
    }
  }
}
