import { timingSafeEqual } from "node:crypto";

export const API_SHUTDOWN_TIMEOUT_MS = 25_000;

export type SlotState = "standby" | "activating" | "active" | "draining" | "released" | "failed" | "exited";
export interface SlotConfiguration {
  id: string;
  start: "standby" | "active";
  controlToken: string;
  lockTimeoutMs: number;
  drainTimeoutMs: number;
  stopTimeoutMs?: number;
}

export function resolveSlotConfiguration(env: NodeJS.ProcessEnv): SlotConfiguration | null {
  if (env.MULTIREMI_SLOT === undefined && env.MULTIREMI_SLOT_START === undefined) return null;
  const start = env.MULTIREMI_SLOT_START ?? "active";
  if (start !== "standby" && start !== "active") throw new Error("MULTIREMI_SLOT_START must be standby or active");
  if (!env.MULTIREMI_SLOT?.trim()) throw new Error("MULTIREMI_SLOT is required in slot mode");
  if (!env.MULTIREMI_SLOT_CONTROL_TOKEN?.trim()) throw new Error("MULTIREMI_SLOT_CONTROL_TOKEN is required in slot mode");
  const milliseconds = (name: string, fallback: number): number => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
    return value;
  };
  return {
    id: env.MULTIREMI_SLOT.trim(), start, controlToken: env.MULTIREMI_SLOT_CONTROL_TOKEN,
    lockTimeoutMs: milliseconds("MULTIREMI_SLOT_LOCK_TIMEOUT_MS", 10_000),
    drainTimeoutMs: milliseconds("MULTIREMI_SLOT_DRAIN_TIMEOUT_MS", 20_000),
    stopTimeoutMs: milliseconds("MULTIREMI_SLOT_STOP_TIMEOUT_MS", 5_000),
  };
}

type SlotGuard = { close(): Promise<void> };

export interface SlotHooks {
  /** Native HTTP count, excluding control handlers; SSE is subtracted here. */
  pendingRequests?(): number;
  acquire(signal: AbortSignal): Promise<SlotGuard>;
  /** A3 supplies the live term here, after acquiring the role lock. */
  fence?(signal: AbortSignal): Promise<number | string | null>;
  start(): void | Promise<void>;
  disconnect(): void;
  stop(): void | Promise<void>;
}

export class DrainTimeoutError extends Error {
  constructor(readonly inFlight: number) { super("drain_timeout"); }
}

/** Serializes transitions; a failed activation keeps its listener for retry/rollback. */
export class SlotLifecycle {
  state: SlotState = "standby";
  term: number | string | null = null;
  private guard: SlotGuard | null = null;
  private exiting = false;
  private drainTimedOut = false;
  private activationCleanup: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly requests = new Set<symbol>();
  private readonly streams = new Set<() => void>();

  constructor(readonly config: SlotConfiguration, private readonly version: string, private readonly hooks: SlotHooks) {}

  status() { return { slot: this.config.id, state: this.state, version: this.version, ...(this.state === "active" ? { term: this.term } : {}) }; }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action);
    this.queue = next.catch(() => {});
    return next;
  }

  activate(): Promise<void> {
    return this.serialize(async () => {
      if (this.state === "active") return;
      if (this.exiting || this.state === "exited") throw new Error("slot has exited");
      if (this.drainTimedOut && this.state === "draining") {
        // HTTP timeout occurs before disconnect/stop, so the existing activation
        // is intact. Rollback must reuse its locks, term and running jobs.
        this.drainTimedOut = false;
        this.state = "active";
        return;
      }
      if (this.guard) throw new Error("release the previous activation before retrying");
      this.state = "activating";
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let started = false;
      const activation = (async () => {
        const guard = await this.hooks.acquire(controller.signal);
        if (controller.signal.aborted) { await guard.close(); return; }
        this.guard = guard;
        const term = await this.hooks.fence?.(controller.signal) ?? null;
        if (controller.signal.aborted) return;
        this.term = term;
        started = true;
        await this.hooks.start();
        if (!controller.signal.aborted) this.state = "active";
      })();
      try {
        await Promise.race([activation, new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("activation_timeout"));
          }, this.config.lockTimeoutMs);
        })]);
      } catch (error) {
        controller.abort();
        this.state = "failed";
        // No jobs exist during connect/SQL/fence. Do not wait for a late fence
        // or let it start jobs after the deadline. Discard the lock session.
        // The acquisition above mutates guard asynchronously.
        const guard = this.guard as SlotGuard | null;
        if (started) {
          // An asynchronous start hook may still be unwinding. Fail within the
          // activation deadline, but retain ownership until it and stop finish.
          this.activationCleanup = activation.catch(() => {}).then(() => this.hooks.stop()).then(async () => {
            await guard?.close();
            if (this.guard === guard) this.guard = null;
          }).finally(() => { this.activationCleanup = null; });
          void this.activationCleanup.catch(() => {});
        } else {
          await guard?.close();
          this.guard = null;
        }
        this.term = null;
        throw error;
      } finally { clearTimeout(timer); }
    });
  }

  release(): Promise<void> {
    return this.serialize(async () => {
      if (this.state === "released" || this.state === "exited") return;
      if (this.activationCleanup) throw new Error("activation cleanup pending; role lock retained");
      if (this.drainTimedOut) throw new DrainTimeoutError(this.pendingRequests());
      this.state = "draining";
      const deadline = Date.now() + this.config.drainTimeoutMs;
      while (this.pendingRequests() > 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(0, deadline - Date.now()))));
      }
      const inFlight = this.pendingRequests();
      if (inFlight > 0) {
        this.drainTimedOut = true;
        throw new DrainTimeoutError(inFlight);
      }
      for (const close of this.streams) close();
      this.hooks.disconnect();
      await this.hooks.stop();
      await this.guard?.close();
      this.guard = null;
      this.term = null;
      this.state = "released";
    });
  }

  async exit(): Promise<void> {
    this.exiting = true;
    await this.release();
    this.state = "exited";
  }

  async waitForRequests(): Promise<void> {
    while (this.pendingRequests() > 0) await new Promise(resolve => setTimeout(resolve, 10));
  }

  private pendingRequests(): number {
    return Math.max(this.requests.size, (this.hooks.pendingRequests?.() ?? 0) - this.streams.size);
  }

  /** Return ordinary bodies untouched: a pull proxy crashes Bun on client abort. */
  async request(req: Request, handler: () => Response | Promise<Response>): Promise<Response> {
    const key = Symbol();
    this.requests.add(key);
    let closeStream: (() => void) | undefined;
    const finish = () => {
      this.requests.delete(key);
      if (closeStream) this.streams.delete(closeStream);
      req.signal.removeEventListener("abort", finish);
    };
    try {
      const response = await handler();
      const streaming = response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream");
      if (!response.body || !streaming) {
        finish();
        return response;
      }
      this.requests.delete(key);
      const reader = response.body.getReader();
      req.signal.addEventListener("abort", finish, { once: true });
      if (req.signal.aborted) finish();
      let closed = false;
      const body = new ReadableStream<Uint8Array>({
        start: controller => {
          if (!streaming) return;
          closeStream = () => {
            if (closed) return;
            closed = true;
            finish();
            controller.close();
            void reader.cancel().catch(() => {});
          };
          this.streams.add(closeStream);
        },
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (closed) return;
            if (chunk.done) { closed = true; finish(); controller.close(); }
            else controller.enqueue(chunk.value);
          } catch (error) { if (!closed) { closed = true; finish(); controller.error(error); } }
        },
        async cancel(reason) { closed = true; finish(); await reader.cancel(reason); },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { finish(); throw error; }
  }

  authorized(req: Request, address: string | undefined): boolean {
    if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
    const authorization = req.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) return false;
    const supplied = Buffer.from(authorization.slice(7));
    const expected = Buffer.from(this.config.controlToken);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
}
