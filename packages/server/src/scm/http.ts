export class ScmHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds: number | null,
    readonly responseBody: string,
    readonly url: string,
    readonly method: string,
    readonly rateLimited = false,
    readonly rateLimitResetAt: number | null = null,
  ) {
    super(message);
  }
}

export interface ScmHttpResponse<T> {
  data: T;
  headers: Headers;
  status: number;
}

export async function scmRequestJson<T>(
  url: string,
  init: RequestInit,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ScmHttpResponse<T>> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(url, { ...init, signal, redirect: "error" });
  const text = await response.text();
  if (!response.ok) {
    const retryHeader = response.headers.get("retry-after");
    const retryAfter = retryHeader && /^\d+$/u.test(retryHeader) ? Number(retryHeader)
      : retryHeader && Number.isFinite(Date.parse(retryHeader)) ? Math.max(0, Math.ceil((Date.parse(retryHeader) - Date.now()) / 1000)) : null;
    const resetHeader = response.headers.get("x-ratelimit-reset");
    const resetAt = resetHeader && /^\d+$/u.test(resetHeader) ? Number(resetHeader) : null;
    const rateLimited = response.status === 429 || (response.status === 403
      && (response.headers.get("x-ratelimit-remaining") === "0" || retryHeader !== null));
    throw new ScmHttpError(
      `SCM provider request failed (${response.status})`,
      response.status,
      retryAfter !== null && Number.isSafeInteger(retryAfter) ? retryAfter : null,
      text.slice(0, 2_000),
      url,
      String(init.method ?? "GET").toUpperCase(),
      rateLimited,
      resetAt !== null && Number.isSafeInteger(resetAt) ? resetAt : null,
    );
  }
  let data: T;
  try {
    data = (text ? JSON.parse(text) : null) as T;
  } catch {
    throw new ScmHttpError(
      "SCM provider returned invalid JSON",
      response.status,
      null,
      text.slice(0, 2_000),
      url,
      String(init.method ?? "GET").toUpperCase(),
    );
  }
  return { data, headers: response.headers, status: response.status };
}

export function appendQuery(url: string, values: Record<string, string | number | boolean | null | undefined>): string {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined || value === "") continue;
    parsed.searchParams.set(key, String(value));
  }
  return parsed.toString();
}

export function lowerCaseHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  if (headers instanceof Headers) {
    return Object.fromEntries([...headers.entries()].map(([key, value]) => [key.toLowerCase(), value]));
  }
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

export function hasNextLink(value: string | null): boolean {
  if (!value) return false;
  return value.split(",").some((part) => /;\s*rel="next"\s*$/u.test(part.trim()));
}
