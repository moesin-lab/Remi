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
export function withDatabaseTimeout<T>(timeoutMs: number, action: () => T): T {
  return timeoutContext.run(timeoutMs, action);
}
export function databaseTimeoutMs(): number | undefined { return timeoutContext.getStore(); }

const log = createLogger("db-recovery");

/**
 * Single-flight timer; never replays an individual SQL statement/commit.
 * Unexpected action/interval errors are reported at ERROR and the next tick runs
 * after retryMaxMs, without changing database outage backoff/recovery state.
 */
export class DatabaseRetryLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private generation = 0;
  private failures = 0;
  private lastWarning = -Infinity;

  constructor(private readonly name: string, private readonly action: () => unknown | Promise<unknown>,
    private readonly interval: number | (() => number),
    private readonly retryBaseMs = 1_000, private readonly retryMaxMs = 30_000) {}

  start(delayMs = 0): void {
    if (!this.stopped) return;
    this.stopped = false;
    const generation = ++this.generation;
    if (delayMs <= 0) void this.tick(generation);
    else this.schedule(delayMs, generation);
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay: number, generation: number): void {
    if (this.stopped || generation !== this.generation) return;
    this.timer = setTimeout(() => { void this.tick(generation); }, delay);
    this.timer.unref?.();
  }

  private async tick(generation: number): Promise<void> {
    if (this.stopped || generation !== this.generation) return;
    let delay: number;
    try {
      await withDatabaseTimeout(5_000, this.action);
      if (this.stopped || generation !== this.generation) return;
      // Interval lookup may itself read configuration from the database.
      delay = withDatabaseTimeout(5_000, () => typeof this.interval === "function" ? this.interval() : this.interval);
      if (this.failures) log.info(`${this.name}: database recovered`);
      this.failures = 0;
      this.lastWarning = -Infinity;
    } catch (error) {
      if (!isDatabaseConnectionError(error)) {
        // Report even a late failure, but never let an obsolete tick rearm.
        log.error(`${this.name}: unexpected maintenance error`, error);
        if (this.stopped || generation !== this.generation) return;
        // Do not consult a possibly broken interval callback or call this an outage.
        delay = this.retryMaxMs;
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
