import { DatabaseRetryLoop } from "@shared/db/recovery.js";
import { withDbJob } from "@shared/observability/db-sources.js";

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

  stop(): void {
    this.timer?.stop();
    this.timer = null;
  }

  sweep(): void {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const now = Date.now();
      for (const job of typeof this.refresh === "function" ? [this.refresh] : this.refresh) {
        job(now);
      }
    } finally {
      this.sweeping = false;
    }
  }
}
