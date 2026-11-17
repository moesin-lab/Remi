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
  githubHeaders?: (url: URL) => HeadersInit | Promise<HeadersInit>;
  requestTimeoutMs?: number;
  totalTimeoutMs?: number;
};

type ImportScope = {
  signal: AbortSignal;
  requestTimeoutMs: number;
  current: string;
  secrets: Set<string>;
  githubHeaders?: SkillImportOptions["githubHeaders"];
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
    secrets: new Set(),
    githubHeaders: options.githubHeaders,
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
  } catch (error) {
    if (error instanceof Error) {
      let message = error.message;
      for (const secret of scope.secrets) message = message.replaceAll(secret, "[REDACTED]");
      throw new SkillImportError(message, error instanceof SkillImportError ? error.status : 502);
    }
    throw new SkillImportError("Skill import failed", 502);
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
    let target = parsed;
    let credentialsAllowed = true;
    let fetched: Response;
    for (let redirects = 0; ; redirects++) {
      const headers = new Headers(init.headers);
      headers.delete("Authorization");
      const official = target.protocol === "https:" && !target.port && !target.username && !target.password
        && ["github.com", "api.github.com", "raw.githubusercontent.com"].includes(target.hostname);
      if (official && credentialsAllowed) {
        const supplied = scope.githubHeaders
          ? await bounded(Promise.resolve(scope.githubHeaders(target)))
          : process.env.GITHUB_TOKEN?.trim()
            ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN.trim()}` } : {};
        const authorization = new Headers(supplied).get("authorization");
        if (authorization) {
          scope.secrets.add(authorization);
          const secret = authorization.replace(/^Bearer\s+/i, "");
          if (secret) scope.secrets.add(secret);
          headers.set("Authorization", authorization);
        }
      }
      try {
        fetched = await bounded<Response>(Promise.resolve(fetch(target.toString(), {
          ...init, method: "GET", headers, redirect: "manual", signal: controller.signal,
        })).then((result) => {
          if (controller.signal.aborted) void result.body?.cancel().catch(() => {});
          return result;
        }));
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        // Transport exceptions may include request headers. Do not propagate them.
        throw new SkillImportError("Skill import upstream request failed", 502);
      }
      if (![301, 302, 303, 307, 308].includes(fetched.status) || !fetched.headers.has("location")) break;
      void fetched.body?.cancel().catch(() => {});
      if (redirects >= 5) throw new SkillImportError("Skill import upstream redirect limit exceeded", 502);
      const next = new URL(fetched.headers.get("location")!, target);
      if (!["http:", "https:"].includes(next.protocol) || next.username || next.password) {
        throw new SkillImportError("Skill import upstream redirect is invalid", 502);
      }
      if (next.origin !== target.origin) credentialsAllowed = false;
      target = next;
    }
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
    let text = new TextDecoder().decode(bytes);
    for (const secret of scope.secrets) text = text.replaceAll(secret, "[REDACTED]");
    return new Response(text, { status: fetched.status, headers: fetched.headers });
  } finally {
    clearTimeout(timer);
    scope.signal.removeEventListener("abort", cancel);
    // Do not await cancel: a broken stream's cancellation may itself hang.
    if (reader) void reader.cancel().catch(() => {});
    else void response?.body?.cancel().catch(() => {});
    controller.abort();
  }
}
