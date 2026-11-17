import { AsyncLocalStorage } from "node:async_hooks";

export const SKILL_IMPORT_REQUEST_TIMEOUT_MS = 10_000;
export const SKILL_IMPORT_TIMEOUT_MS = 25_000;

export class SkillImportError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "SkillImportError";
  }
}

export type SkillImportOptions = {
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  totalTimeoutMs?: number;
};

type ImportScope = {
  signal: AbortSignal;
  requestTimeoutMs: number;
  current: string;
};

// Each concurrent import owns its deadline and cancellation context, including
// the nested GitHub discovery and directory traversal helpers.
const scopes = new AsyncLocalStorage<ImportScope>();

export async function withSkillImportDeadline<T>(options: SkillImportOptions, run: () => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const totalTimeoutMs = options.totalTimeoutMs ?? SKILL_IMPORT_TIMEOUT_MS;
  const scope: ImportScope = {
    signal: controller.signal,
    requestTimeoutMs: options.requestTimeoutMs ?? SKILL_IMPORT_REQUEST_TIMEOUT_MS,
    current: "starting import",
  };
  const cancel = () => controller.abort(new SkillImportError(`Skill import cancelled during ${scope.current}`, 408));
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new SkillImportError(
    `Skill import total deadline exceeded (${totalTimeoutMs} ms) during ${scope.current}`, 504,
  )), totalTimeoutMs);
  try {
    return await scopes.run(scope, async () => {
      scope.signal.throwIfAborted();
      const result = await run();
      scope.signal.throwIfAborted();
      return result;
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

// The deadline stays active until the full body is consumed. A race also bounds
// transports/test doubles that ignore AbortSignal; late responses are discarded.
export async function fetchSkillImportResponse(url: string, init: RequestInit = {}, limit: number): Promise<Response> {
  const scope = scopes.getStore();
  if (!scope) throw new Error("skill import request outside import scope");
  scope.signal.throwIfAborted();
  const parsed = new URL(url);
  const operation = parsed.hostname === "raw.githubusercontent.com" || parsed.pathname.endsWith("/file")
    ? `download ${parsed.searchParams.get("path") ?? parsed.pathname}`
    : parsed.pathname.includes("/contents") ? `list contents ${parsed.pathname}`
    : parsed.pathname.includes("/git/trees/") ? "scan repository tree"
    : parsed.hostname === "api.github.com" ? "resolve ref" : "resolve skill metadata";
  const controller = new AbortController();
  let phase = "connect";
  const location = () => `${parsed.hostname} (${operation}; ${phase})`;
  scope.current = location();
  const cancel = () => controller.abort(scope.signal.reason);
  scope.signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new SkillImportError(
    `Skill import upstream request timed out (${scope.requestTimeoutMs} ms) at ${location()}`, 504,
  )), scope.requestTimeoutMs);
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const bounded = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const signal = controller.signal;
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
  try {
    const fetched = await bounded<Response>(Promise.resolve(fetch(url, { ...init, signal: controller.signal })).then((result) => {
      if (controller.signal.aborted) void result.body?.cancel().catch(() => {});
      return result;
    }));
    response = fetched;
    // Error classification only needs status/headers. Never wait for an error
    // body (in particular a rate-limit response) before returning the error.
    if (fetched.status !== 200) {
      void fetched.body?.cancel().catch(() => {});
      return new Response(null, { status: fetched.status, headers: fetched.headers });
    }
    phase = "read body";
    scope.current = location();
    if (Number(fetched.headers.get("content-length") ?? 0) > limit) {
      throw new SkillImportError(`file exceeds ${limit} byte limit`, 400);
    }
    reader = fetched.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      while (true) {
        const { done, value } = await bounded(reader.read());
        if (done) break;
        total += value.byteLength;
        if (total > limit) throw new SkillImportError(`file exceeds ${limit} byte limit`, 400);
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Response(bytes, { status: fetched.status, headers: fetched.headers });
  } finally {
    clearTimeout(timer);
    scope.signal.removeEventListener("abort", cancel);
    // Do not await cancel: a broken stream's cancellation may itself hang.
    if (reader) void reader.cancel().catch(() => {});
    else void response?.body?.cancel().catch(() => {});
    controller.abort();
  }
}
