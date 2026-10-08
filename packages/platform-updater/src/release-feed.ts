import type { MultiremiPlatformRelease } from "@multiremi/contracts";

export async function fetchReleaseFeed(url: string | null): Promise<MultiremiPlatformRelease | null> {
  if (!url) return null;
  return parseReleaseFeed(await fetchReleaseJson(url), url);
}

export function parseReleaseFeed(body: unknown, url: string): MultiremiPlatformRelease {
  const value = unwrapReleaseManifest(body);
  if (typeof value.version !== "string" || typeof value.ref !== "string") {
    throw new Error("release feed latest release is invalid");
  }
  if (!/^v?\d+\.\d+\.\d+$/.test(value.version)) throw new Error("release feed version must be SemVer");
  if (value.manifestUrl) assertHttpsUrl(String(value.manifestUrl), "release manifest URL");
  return {
    dataSchema: stringOrNull(value.dataSchema),
    version: value.version,
    ref: value.ref,
    publishedAt: stringOrNull(value.publishedAt),
    releaseUrl: stringOrNull(value.releaseUrl),
    // A feed may itself be the manifest (directly or inside `latest`). Keep a
    // usable address for Web/CLI and scheduled updates in either form.
    manifestUrl: stringOrNull(value.manifestUrl) ?? url,
    apiImage: stringOrNull(value.apiImage),
    webImage: stringOrNull(value.webImage),
  };
}

export function unwrapReleaseManifest(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("release feed is invalid");
  const candidate = "latest" in body ? body.latest : body;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("release feed has no latest release");
  return candidate as Record<string, unknown>;
}

export function assertHttpsUrl(value: string, label: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} is invalid`); }
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
  if (url.username || url.password || url.hash) throw new Error(`${label} must not contain credentials or a fragment`);
}

export async function fetchReleaseJson(url: string): Promise<unknown> {
  const response = await fetchReleaseResponse(url);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty release response");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > 1024 * 1024) throw new Error("Release metadata exceeds 1 MiB");
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function fetchReleaseResponse(url: string, timeoutMs = 120_000): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  for (let redirects = 0; redirects < 6; redirects++) {
    assertHttpsUrl(url, "release URL");
    const response = await fetch(url, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Release redirect has no location");
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Release fetch returned ${response.status}`); }
    return response;
  }
  throw new Error("Too many release redirects");
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
