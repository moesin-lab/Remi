import { currentBackgroundTerm, StaleLiveTermError } from "./live-term.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createLogger } from "../logger.js";

/** Only transport/server-availability failures count toward database outage backoff. */
export function isDatabaseConnectionError(error: unknown): boolean {
  if (error instanceof DatabaseUnavailableError) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && (code.startsWith("08")
    || ["57P01", "57P02", "57P03", "ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT",
      "ERR_POSTGRES_CONNECTION_CLOSED", "ERR_POSTGRES_CONNECTION_TIMEOUT", "ERR_POSTGRES_CONNECTION_REFUSED"].includes(code));
}

export class DatabaseUnavailableError extends Error {
  readonly code = "database_unavailable";
  constructor(message = "Database temporarily unavailable; retry shortly") {
    super(message);
    this.name = "DatabaseUnavailableError";
  }
}

const timeoutContext = new AsyncLocalStorage<number>();
const deadlineContext = new AsyncLocalStorage<{ at: number; active: boolean }>();
export function withDatabaseTimeout<T>(timeoutMs: number, action: () => T): T {
  return timeoutContext.run(timeoutMs, action);
}
/** Recompute the remaining budget for every SQL boundary, including synchronous bridges. */
export async function withDatabaseDeadline<T>(at: number, action: () => T | Promise<T>): Promise<T> {
  const context = { at, active: true };
  try { return await deadlineContext.run(context, action); }
  finally {
    // Jobs spawned by startup inherit ALS. Once startup settles, they must use
    // their own normal query budgets rather than an expired activation budget.
    context.active = false;
  }
}
export function databaseTimeoutMs(options: { cleanup?: boolean } = {}): number | undefined {
  const timeout = timeoutContext.getStore();
  // Cleanup must reach the worker even after an activation deadline expires:
  // otherwise a live transaction (or the worker's lost-transaction flag) leaks
  // into unrelated requests. Give it a fresh, bounded transport budget.
  if (options.cleanup) return Math.min(timeout ?? 5_000, 5_000);
  const deadline = deadlineContext.getStore();
  if (!deadline?.active) return timeout;
  const remaining = Math.ceil(deadline.at - performance.now());
  if (remaining <= 0) throw new DatabaseUnavailableError("Database operation deadline exceeded");
  return Math.min(timeout ?? Infinity, remaining);
}

const log = createLogger("db-recovery");

/**
 * Single-flight timer; never replays an individual SQL statement/commit.
 * Unexpected action/interval errors are reported at ERROR and the next tick runs
 * at the normal cadence (one-shot loops stop), without changing database outage
 * backoff/recovery state. If interval lookup fails, use the last known cadence
 * or retryMaxMs until a cadence has been read successfully.
 */
export class DatabaseRetryLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private active: Promise<unknown> | null = null;
  private generation = 0;
  private failures = 0;
  private lastWarning = -Infinity;
  private lastInterval: number;

  constructor(private readonly name: string, private readonly action: () => unknown | Promise<unknown>,
    private readonly interval: number | (() => number),
    private readonly retryBaseMs = 1_000, private readonly retryMaxMs = 30_000) {
    this.lastInterval = typeof interval === "number" ? interval : retryMaxMs;
  }

  start(delayMs = 0): void {
    if (!this.stopped) return;
    this.stopped = false;
    const generation = ++this.generation;
    if (delayMs <= 0) void this.tick(generation);
    else this.schedule(delayMs, generation);
  }

  stop(): Promise<void> {
    this.stopped = true;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return this.active?.then(() => {}, () => {}) ?? Promise.resolve();
  }

  private schedule(delay: number, generation: number): void {
    if (this.stopped || generation !== this.generation) return;
    this.timer = setTimeout(() => { void this.tick(generation); }, delay);
    this.timer.unref?.();
  }

  private readInterval(): number {
    return this.lastInterval = withDatabaseTimeout(5_000,
      () => typeof this.interval === "function" ? this.interval() : this.interval);
  }

  private async tick(generation: number): Promise<void> {
    if (this.stopped || generation !== this.generation) return;
    let delay: number;
    let readingInterval = false;
    try {
      this.active = Promise.resolve(withDatabaseTimeout(5_000, () => {
        currentBackgroundTerm()?.assertCurrent();
        return this.action();
      }));
      await this.active;
      if (this.stopped || generation !== this.generation) return;
      // Interval lookup may itself read configuration from the database.
      readingInterval = true;
      delay = this.readInterval();
      if (this.failures) log.info(`${this.name}: database recovered`);
      this.failures = 0;
      this.lastWarning = -Infinity;
    } catch (error) {
      if (error instanceof StaleLiveTermError) { this.stopped = true; return; }
      if (!isDatabaseConnectionError(error)) {
        // Report even a late failure, but never let an obsolete tick rearm.
        log.error(`${this.name}: unexpected maintenance error`, error);
        if (this.stopped || generation !== this.generation) return;
        delay = this.lastInterval;
        if (!readingInterval) {
          // Action failed: still honor the current configured cadence, including 0.
          try { delay = this.readInterval(); }
          catch (intervalError) {
            if (isDatabaseConnectionError(intervalError)) {
              delay = Math.max(delay, this.retryMaxMs);
            } else {
              log.error(`${this.name}: unexpected maintenance interval error`, intervalError);
            }
          }
        }
        if (this.stopped || generation !== this.generation) return;
      } else {
        if (this.stopped || generation !== this.generation) return;
        delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.min(this.failures++, 16));
        if (Date.now() - this.lastWarning >= 30_000) {
          // Never include SQL, connection URLs, or driver error text.
          log.warn(`${this.name}: database unavailable; retry in ${delay}ms`);
          this.lastWarning = Date.now();
        }
      }
    }
    if (delay <= 0) { this.stopped = true; return; }
    this.schedule(delay, generation);
  }
}
