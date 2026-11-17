import { shouldBypassProxy } from "./no-proxy.js";

/** Start the Bun transport synchronously: fetch and node:http snapshot proxy env here. */
export function withNoProxyRoute<T>(url: string | URL, start: () => T): T {
  if (!shouldBypassProxy(url)) return start();
  const previous = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
  try {
    process.env.NO_PROXY = new URL(url).hostname;
    process.env.no_proxy = process.env.NO_PROXY;
    return start();
  } finally {
    for (const key of ["NO_PROXY", "no_proxy"] as const) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

/** Re-evaluate NO_PROXY on every redirect, before Bun starts the next hop. */
export async function proxyFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  let target = input;
  let options = init;
  const mode = init?.redirect ?? (input instanceof Request ? input.redirect : "follow");
  for (let hops = 0; ; hops++) {
    const url = target instanceof Request ? target.url : String(target);
    // Clone before sending so a 307/308 can replay a Request body.
    const replay = target instanceof Request && target.body && mode === "follow" ? target.clone() : target;
    const response = await withNoProxyRoute(url, () => fetch(target, { ...options, redirect: "manual" }));
    if (![301, 302, 303, 307, 308].includes(response.status) || mode === "manual") {
      if (hops > 0) Object.defineProperty(response, "redirected", { value: true });
      return response;
    }
    const location = response.headers.get("location");
    if (mode === "error" || (location !== null && hops === 20)) {
      await response.body?.cancel();
      throw new TypeError(mode === "error" ? "Unexpected redirect" : "Too many redirects");
    }
    if (location === null) {
      if (hops > 0) Object.defineProperty(response, "redirected", { value: true });
      return response;
    }
    await response.body?.cancel();
    const next = new URL(location, url);
    if (!["http:", "https:"].includes(next.protocol) || next.username || next.password) {
      throw new TypeError("Invalid redirect URL");
    }
    const method = (options?.method ?? (target instanceof Request ? target.method : "GET")).toUpperCase();
    const headers = new Headers(options?.headers ?? (target instanceof Request ? target.headers : undefined));
    const dropBody = ((response.status === 301 || response.status === 302) && method === "POST")
      || (response.status === 303 && method !== "GET" && method !== "HEAD");
    if (next.origin !== new URL(url).origin) {
      for (const name of ["authorization", "proxy-authorization", "cookie", "cookie2", "host"]) headers.delete(name);
    }
    if (dropBody) {
      for (const name of ["content-encoding", "content-language", "content-location", "content-type", "content-length"]) headers.delete(name);
    } else if (options?.body instanceof ReadableStream) {
      throw new TypeError("Cannot replay a streaming body across a redirect");
    }
    options = { ...options, headers, ...(dropBody ? { method: "GET", body: null } : {}) };
    target = replay instanceof Request
      ? new Request(new Request(next, replay), { method: dropBody ? "GET" : method, headers,
          body: dropBody || method === "GET" || method === "HEAD" ? null : replay.body,
          signal: replay.signal })
      : next;
  }
}

export function proxyWebSocket(url: string, init: { headers: Record<string, string> }): WebSocket {
  // Bun WebSocket does not auto-detect HTTP(S)_PROXY, unlike fetch.
  const secure = new URL(url).protocol === "wss:";
  const proxy = shouldBypassProxy(url) ? undefined : secure
    ? process.env.https_proxy ?? process.env.HTTPS_PROXY
    : process.env.http_proxy ?? process.env.HTTP_PROXY;
  // The DOM constructor overload omits Bun's headers/proxy options.
  return new WebSocket(url, { ...init, ...(proxy ? { proxy } : {}) } as never);
}
