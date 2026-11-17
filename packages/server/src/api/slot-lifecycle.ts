import { timingSafeEqual } from "node:crypto";

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

export interface SlotHooks {
  /** Native HTTP count, excluding control handlers; SSE is subtracted here. */
  pendingRequests?(): number;
  acquire(): Promise<{ close(): Promise<void> }>;
  /** A3 supplies the live term here, after acquiring the role lock. */
  fence?(): Promise<number | string | null>;
  start(): void | Promise<void>;
  disconnect(): void;
  stop(): void | Promise<void>;
}

/** Serializes transitions; a failed activation keeps its listener for retry/rollback. */
export class SlotLifecycle {
  state: SlotState = "standby";
  term: number | string | null = null;
  private guard: { close(): Promise<void> } | null = null;
  private exiting = false;
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
      if (this.guard) throw new Error("release the previous activation before retrying");
      this.state = "activating";
      try {
        this.guard = await this.hooks.acquire();
        this.term = await this.hooks.fence?.() ?? null;
        await this.hooks.start();
        this.state = "active";
      } catch (error) {
        this.state = "failed";
        // Retain ownership if stopping fails: never hand live jobs to a successor.
        await this.hooks.stop();
        await this.guard?.close();
        this.guard = null;
        throw error;
      }
    });
  }

  release(): Promise<void> {
    return this.serialize(async () => {
      if (this.state === "released" || this.state === "exited") return;
      this.state = "draining";
      const deadline = Date.now() + this.config.drainTimeoutMs;
      while (this.pendingRequests() > 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(0, deadline - Date.now()))));
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
