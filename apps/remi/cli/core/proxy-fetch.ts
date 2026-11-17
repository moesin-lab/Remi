import { shouldBypassProxy } from "@shared/no-proxy.js";

/** Keep Bun's existing proxy behavior unless NO_PROXY explicitly matches. */
export function cliFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  if (!shouldBypassProxy(url)) return fetch(input, init);

  // Bun 1.3.14 treats proxy: "" as environment auto-detection. Its native
  // fetch reads NO_PROXY synchronously; translate this match into an exact host
  // for that call only. Restore before yielding so concurrent external requests
  // keep their original proxy configuration, including port-specific rules.
  const previous = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
  const host = new URL(url).hostname;
  try {
    process.env.NO_PROXY = host;
    process.env.no_proxy = host;
    return fetch(input, init);
  } finally {
    for (const key of ["NO_PROXY", "no_proxy"] as const) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}
