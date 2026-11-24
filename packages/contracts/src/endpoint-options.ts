export interface EndpointModel {
  id: string;
  name?: string;
  context_window?: number;
  max_output_tokens?: number;
  source?: "discovered" | "manual";
}
/** Optional endpoint inventory, not an execution group's model selection. */
export interface EndpointOptions {
  fetch_models?: boolean;
  models_url?: string;
  manual_models?: EndpointModel[];
  headers?: Record<string, string>;
  timeout_ms?: number;
}
export function endpointHttpUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) throw new Error(`Invalid ${label}`);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`Invalid ${label}`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search)
    throw new Error(`${label} must be HTTP(S), without credentials, query or fragment`);
  return url.toString().replace(/\/$/, "");
}
export function parseEndpointOptions(value: unknown): EndpointOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Endpoint options must be an object");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !["fetch_models", "models_url", "manual_models", "headers", "timeout_ms"].includes(key)))
    throw new Error("Unsupported endpoint option");
  const result: EndpointOptions = {};
  if (raw.fetch_models !== undefined) {
    if (typeof raw.fetch_models !== "boolean") throw new Error("fetch_models must be boolean");
    result.fetch_models = raw.fetch_models;
  }
  if (raw.models_url !== undefined && raw.models_url !== "") result.models_url = endpointHttpUrl(raw.models_url, "models_url");
  if (raw.timeout_ms !== undefined) {
    if (!Number.isSafeInteger(raw.timeout_ms) || Number(raw.timeout_ms) < 1000 || Number(raw.timeout_ms) > 120000)
      throw new Error("Probe timeout must be between 1000 and 120000 ms");
    result.timeout_ms = Number(raw.timeout_ms);
  }
  if (raw.headers !== undefined) {
    if (!raw.headers || typeof raw.headers !== "object" || Array.isArray(raw.headers) || Object.keys(raw.headers).length > 32)
      throw new Error("headers must contain at most 32 entries");
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(raw.headers)) {
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || /^(host|content-length|connection|transfer-encoding|cookie|authorization|proxy-authorization|x-api-key|x-goog-api-key)$/i.test(name)
        || /token|secret|password|credential/i.test(name) || typeof value !== "string" || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value))
        throw new Error("Invalid custom header; put authentication secrets in the API key field");
      if (Object.keys(headers).some(existing => existing.toLowerCase() === name.toLowerCase())) throw new Error("Duplicate custom header");
      headers[name] = value;
    }
    result.headers = headers;
  }
  if (raw.manual_models !== undefined) {
    if (!Array.isArray(raw.manual_models) || raw.manual_models.length > 500) throw new Error("At most 500 manual models are allowed");
    const seen = new Set<string>();
    result.manual_models = raw.manual_models.map(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid manual model");
      const row = value as EndpointModel;
      if (typeof row.id !== "string" || !row.id.trim() || row.id !== row.id.trim() || row.id.length > 200 || /[\x00-\x1f\x7f]/.test(row.id) || seen.has(row.id))
        throw new Error("Manual model IDs must be non-empty and unique");
      seen.add(row.id);
      if (row.name !== undefined && (typeof row.name !== "string" || row.name.length > 200 || /[\x00-\x1f\x7f]/.test(row.name))) throw new Error("Invalid model display name");
      for (const key of ["context_window", "max_output_tokens"] as const) {
        if (row[key] !== undefined && (!Number.isSafeInteger(row[key]) || row[key]! <= 0 || row[key]! > 100_000_000))
          throw new Error(`Invalid model ${key}`);
      }
      return { id: row.id, ...(row.name ? { name: row.name } : {}),
        ...(row.context_window ? { context_window: row.context_window } : {}),
        ...(row.max_output_tokens ? { max_output_tokens: row.max_output_tokens } : {}), source: "manual" };
    });
  }
  return result;
}
