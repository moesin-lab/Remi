import { AsyncLocalStorage } from "node:async_hooks";
import { createLogger } from "../logger.js";

/** Only transport/server-availability failures are safe to retry at a loop boundary. */
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

/** Single-flight timer. A failed tick is retried, never an individual SQL statement/commit. */
export class DatabaseRetryLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private active: Promise<unknown> | null = null;
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

  private async tick(generation: number): Promise<void> {
    if (this.stopped || generation !== this.generation) return;
    let delay: number;
    try {
      this.active = Promise.resolve(withDatabaseTimeout(5_000, this.action));
      await this.active;
      if (this.stopped || generation !== this.generation) return;
      // Interval lookup may itself read configuration from the database.
      delay = withDatabaseTimeout(5_000, () => typeof this.interval === "function" ? this.interval() : this.interval);
      if (this.failures) log.info(`${this.name}: database recovered`);
      this.failures = 0;
      this.lastWarning = -Infinity;
    } catch (error) {
      if (!isDatabaseConnectionError(error)) throw error;
      if (this.stopped || generation !== this.generation) return;
      delay = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.min(this.failures++, 16));
      if (Date.now() - this.lastWarning >= 30_000) {
        // Never include SQL, connection URLs, or driver error text.
        log.warn(`${this.name}: database unavailable; retry in ${delay}ms`);
        this.lastWarning = Date.now();
      }
    }
    if (delay <= 0) { this.stopped = true; return; }
    this.schedule(delay, generation);
  }
}
