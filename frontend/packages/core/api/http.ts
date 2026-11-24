import { abortableDelay, maintenanceBudget, MAINTENANCE_RETRY_LIMIT_MS, pauseSendTimeout, retryAfterMs, useContinuityStore } from "../platform-lifecycle/continuity";
import { type Logger, noopLogger } from "../logger";
import { createRequestId } from "../utils";
import { getCurrentSlug } from "../platform/workspace-storage";

/** Identifies the calling client to the server.
 *  Sent on every HTTP request as X-Client-Platform / X-Client-Version /
 *  X-Client-OS so the backend can log, gate, or split metrics by client.
 *  See server/internal/middleware/client.go for the receiving end. */
export interface ApiClientIdentity {
  /** Logical client kind. Server expects: "web" | "desktop" | "cli" | "daemon". */
  platform?: string;
  /** Client/app version string (e.g. "0.1.0", git tag, commit). */
  version?: string;
  /** Operating system the client is running on: "macos" | "windows" | "linux". */
  os?: string;
}

export interface ApiClientOptions {
  logger?: Logger;
  onUnauthorized?: () => void;
  /** Identifies the client to the server. Sent as X-Client-* headers. */
  identity?: ApiClientIdentity;
}

export class ApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  // Raw decoded JSON body (when the server returned one). Carries structured
  // error fields like `code` so callers can branch on machine-readable
  // identifiers instead of pattern-matching the human-readable message.
  readonly body?: unknown;

  constructor(message: string, status: number, statusText: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

export interface SafeErrorDetails {
  name: string;
  message: string;
  status?: number;
  statusText?: string;
}

/** Projects errors onto an explicit logging allowlist so response bodies and causes cannot leak. */
export function toSafeErrorDetails(error: unknown): SafeErrorDetails {
  if (error instanceof ApiError) {
    return {
      name: error.name,
      message: error.message,
      status: error.status,
      statusText: error.statusText,
    };
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "UnknownError", message: "Unknown error" };
}

// Thrown by getAttachmentTextContent when the server refuses to inline a
// file because it exceeds the 2 MB cap. UI maps to a "too large, please
// download" affordance with the Download CTA still available.
export class PreviewTooLargeError extends Error {
  constructor() {
    super("attachment too large for inline preview");
    this.name = "PreviewTooLargeError";
  }
}

// Thrown by getAttachmentTextContent when the server's text whitelist
// rejects the content type. Normally the client's isPreviewable() guard
// catches this earlier, but the two whitelists can drift — surfacing the
// 415 as a typed error makes the drift visible.
export class PreviewUnsupportedError extends Error {
  constructor() {
    super("attachment type not supported for inline preview");
    this.name = "PreviewUnsupportedError";
  }
}

/** Shared transport for every endpoint module: base URL, auth/CSRF/identity
 *  headers, the 401 recovery hook, request-id logging and the two fetch
 *  primitives. Endpoint modules receive one instance and own nothing else. */
export interface HttpRequestInit extends RequestInit {
  extraHeaders?: Record<string, string>;
  /** Only callers backed by a verified server dedupe contract may opt in. */
  retrySafe?: boolean;
}

export class HttpClient {
  private readonly baseUrl: string;
  private token: string | null = null;
  readonly logger: Logger;
  private readonly options: ApiClientOptions;

  constructor(baseUrl: string, options?: ApiClientOptions) {
    this.baseUrl = baseUrl;
    this.options = options ?? {};
    this.logger = options?.logger ?? noopLogger;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  setToken(token: string | null) {
    this.token = token;
  }

  private readCsrfToken(): string | null {
    if (typeof document === "undefined") return null;
    const match = document.cookie
      .split("; ")
      .find((c) => c.startsWith("multimira_csrf="));
    return match ? match.split("=")[1] ?? null : null;
  }

  authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    const slug = getCurrentSlug();
    if (slug) headers["X-Workspace-Slug"] = slug;
    const csrf = this.readCsrfToken();
    if (csrf) headers["X-CSRF-Token"] = csrf;
    const id = this.options.identity;
    if (id?.platform) headers["X-Client-Platform"] = id.platform;
    if (id?.version) headers["X-Client-Version"] = id.version;
    if (id?.os) headers["X-Client-OS"] = id.os;
    return headers;
  }

  handleUnauthorized() {
    this.token = null;
    // Workspace id is owned by the URL-driven workspace-storage singleton
    // (set by [workspaceSlug]/layout.tsx). On 401, the auth flow navigates
    // to /login which leaves the workspace route, and the next workspace
    // entry will overwrite the id. No clear needed here.
    this.options.onUnauthorized?.();
  }

  async parseErrorMessage(res: Response, fallback: string): Promise<string> {
    try {
      const data = await res.json() as { error?: string | { message?: string; code?: string } };
      if (typeof data.error === "string" && data.error) return data.error;
      if (data.error && typeof data.error === "object" && typeof data.error.message === "string" && data.error.message) {
        return data.error.message;
      }
    } catch {
      // Ignore non-JSON error bodies.
    }
    return fallback;
  }

  // Reads the response body once for both human-readable error message and
  // structured fields. The Response stream can only be consumed once, so
  // both pieces have to come from a single read.
  private async parseErrorBody(res: Response, fallback: string): Promise<{ message: string; body: unknown }> {
    try {
      const data = await res.json() as { error?: string | { message?: string; code?: string } };
      const message = typeof data.error === "string" && data.error
        ? data.error
        : data.error && typeof data.error === "object" && typeof data.error.message === "string" && data.error.message
          ? data.error.message
          : fallback;
      return { message, body: data };
    } catch {
      return { message: fallback, body: undefined };
    }
  }

  // Sends the request with the standard headers (auth, CSRF, request id,
  // client identity) and runs the shared error path (401 → handleUnauthorized,
  // structured ApiError, status-aware log level). Returns the raw Response so
  // callers can decide how to decode the body — JSON for the typed `fetch<T>`
  // path, plain text for the attachment-preview proxy, etc.
  async fetchRaw(
    path: string,
    init?: HttpRequestInit,
  ): Promise<Response> {
    const rid = createRequestId();
    const start = Date.now();
    const method = init?.method ?? "GET";

    const headers: Record<string, string> = {
      "X-Request-ID": rid,
      ...this.authHeaders(),
      ...(init?.extraHeaders ?? {}),
      ...((init?.headers as Record<string, string>) ?? {}),
    };

    this.logger.info(`→ ${method} ${path}`, { rid });

    const { retrySafe, extraHeaders: _extraHeaders, ...requestInit } = init ?? {};
    const read = method === "GET" || method === "HEAD";
    const trackedWrite = !read;
    if (trackedWrite) useContinuityStore.setState(s => ({ pendingWrites: s.pendingWrites + 1 }));
    try {
      const budget = maintenanceBudget(init?.signal);
      let attempt = 0;
      let res: Response;
      for (;;) {
        init?.signal?.throwIfAborted();
        let failure: unknown;
        let response: Response | undefined;
        try {
          response = await fetch(`${this.baseUrl}${path}`, { ...requestInit, headers, credentials: "include" });
        } catch (error) {
          if (init?.signal?.aborted || !retrySafe || !(error instanceof TypeError)) throw error;
          failure = error;
        }
        const maintenance = response?.status === 503 && response.headers.has("Retry-After");
        if (response?.status === 503) {
          const body: unknown = await response.clone().json().catch(() => null);
          if (body && typeof body === "object" && "code" in body && body.code === "platform_update_in_progress") {
            useContinuityStore.setState({ switching: true });
          }
        }
        // Next rewrite's ECONNREFUSED response is a bare 500, not 502.
        // Never reinterpret application JSON 500s as proxy/network failures.
        const proxyUnavailable = retrySafe && response?.status === 500 &&
          !response.headers.get("Content-Type")?.includes("application/json") &&
          await response.clone().text() === "Internal Server Error";
        const retry = proxyUnavailable || failure !== undefined || (response && (
          (retrySafe && [502, 503, 504].includes(response.status)) || (read && maintenance)
        ));
        if (!retry) { res = response!; break; }
        const delay = Math.max(250, retryAfterMs(response?.headers.get("Retry-After") ?? null)
          ?? Math.min(1000 * 2 ** attempt, 15_000) * (0.8 + Math.random() * 0.4));
        if (budget.waited + delay >= MAINTENANCE_RETRY_LIMIT_MS) {
          if (failure) throw failure;
          if (proxyUnavailable) throw new TypeError("Web proxy unavailable; delivery is unconfirmed");
          res = response!;
          break;
        }
        await response?.body?.cancel();
        const resume = pauseSendTimeout(init?.signal);
        try { await abortableDelay(delay, init?.signal); } finally { resume(); }
        budget.waited += delay;
        attempt++;
      }

      if (!res.ok) {
        if (res.status === 401) this.handleUnauthorized();
        const { message, body } = await this.parseErrorBody(res, `API error: ${res.status} ${res.statusText}`);
        const logLevel = res.status === 404 ? "warn" : "error";
        this.logger[logLevel](`← ${res.status} ${path}`, { rid, duration: `${Date.now() - start}ms`, error: message });
        throw new ApiError(message, res.status, res.statusText, body);
      }

      this.logger.info(`← ${res.status} ${path}`, { rid, duration: `${Date.now() - start}ms` });
      return res;
    } finally {
      if (trackedWrite) useContinuityStore.setState(s => ({ pendingWrites: s.pendingWrites - 1 }));
    }
  }

  async fetch<T>(path: string, init?: HttpRequestInit): Promise<T> {
    const res = await this.fetchRaw(path, {
      ...init,
      extraHeaders: { "Content-Type": "application/json", ...(init?.extraHeaders ?? {}) },
    });
    // Handle 204 No Content
    if (res.status === 204) {
      return undefined as T;
    }
    return res.json() as Promise<T>;
  }
}
