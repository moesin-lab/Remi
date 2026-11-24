import type { RuntimeConnectionProfile } from "./runtime-connection.js";
import { parseExecutionConnectionProfile } from "./execution-profile.js";
import { parseEndpointOptions, endpointHttpUrl, type EndpointOptions } from "./endpoint-options.js";

export const ENDPOINT_PROTOCOLS = ["openai-responses", "openai-chat-completions", "anthropic-messages", "google-generative"] as const;
export type EndpointProtocol = typeof ENDPOINT_PROTOCOLS[number];
export interface EndpointConnection {
  base_url: string;
  protocols: EndpointProtocol[];
  protocol_paths?: Partial<Record<EndpointProtocol, string>>;
  protocol_urls?: Partial<Record<EndpointProtocol, string>>;
  options?: EndpointOptions;
  auth_mode: "api_key" | "env";
  env_key: string;
  auth_header: "bearer" | "x-api-key";
  credential_id?: string;
}
export interface ExecutionEndpoint {
  id: string;
  workspace_id: string;
  name: string;
  revision: number;
  connection: EndpointConnection;
  created_at: string;
  updated_at: string;
}
export interface ExecutionEndpointInput {
  name: string;
  connection: unknown;
  api_key?: unknown;
}
export class ExecutionModelPolicyError extends Error {
  constructor(public readonly code: string, message: string, public readonly field?: string) { super(message); }
}
export interface ExecutionModelPolicy {
  model?: string;
  models?: string[];
  /** Exact, case-sensitive IDs; takes precedence over models. */
  blocked_models?: string[];
}
export interface ExecutionConnectionSnapshot {
  mode: "native" | "endpoint";
  provider: "claude" | "codex" | "antigravity" | "grok";
  endpoint_id: string | null;
  endpoint_revision: number | null;
  profile: (RuntimeConnectionProfile & { auth_header?: "bearer" | "x-api-key" }) | null;
}
export function parseExecutionConnectionSnapshot(value: unknown): ExecutionConnectionSnapshot | null {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid execution connection snapshot");
  const row = value as ExecutionConnectionSnapshot;
  if (!["claude", "codex", "antigravity", "grok"].includes(row.provider)) throw new Error("Invalid execution connection provider");
  if (row.mode === "native") {
    if (row.endpoint_id !== null || row.endpoint_revision !== null || row.profile !== null) throw new Error("Native connection must not contain endpoint settings");
    return { mode: "native", provider: row.provider, endpoint_id: null, endpoint_revision: null, profile: null };
  }
  if (row.mode !== "endpoint" || typeof row.endpoint_id !== "string" || !row.endpoint_id
    || !Number.isSafeInteger(row.endpoint_revision) || row.endpoint_revision! < 1 || row.provider === "grok")
    throw new Error("Invalid endpoint snapshot identity");
  const profile = parseExecutionConnectionProfile(row.provider, row.profile);
  if (!profile) throw new Error("Endpoint profile is required");
  return { mode: row.mode, provider: row.provider, endpoint_id: row.endpoint_id, endpoint_revision: row.endpoint_revision, profile };
}
export function providerEndpointProtocol(provider: string): EndpointProtocol | null {
  return provider === "codex" ? "openai-responses" : provider === "claude"
    ? "anthropic-messages" : provider === "antigravity" ? "google-generative" : null;
}
export function endpointProtocolBaseUrl(connection: EndpointConnection, protocol: EndpointProtocol): string {
  if (!connection.protocols.includes(protocol)) throw new Error("Endpoint does not support the requested API protocol");
  if (connection.protocol_urls?.[protocol]) return connection.protocol_urls[protocol]!;
  const suffix = connection.protocol_paths?.[protocol]
    ?? (protocol.startsWith("openai-") && !/\/v\d+$/.test(connection.base_url) ? "/v1" : "");
  return connection.base_url + suffix;
}
export function legacyEndpointConnection(provider: string, profile: RuntimeConnectionProfile & { auth_header?: "bearer" | "x-api-key" }): EndpointConnection {
  const protocol = providerEndpointProtocol(provider);
  if (!protocol) throw new Error("Legacy connection provider has no endpoint protocol");
  return { base_url: profile.base_url, protocols: [protocol], auth_mode: profile.auth_mode ?? "env",
    protocol_paths: { [protocol]: "" },
    env_key: profile.env_key, auth_header: profile.auth_header ?? "bearer",
    ...(profile.credential_id ? { credential_id: profile.credential_id } : {}) };
}
export function parseEndpointConnection(value: unknown): EndpointConnection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Endpoint connection must be an object");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["base_url", "protocols", "protocol_paths", "protocol_urls", "options", "auth_mode", "env_key", "auth_header", "credential_id"].includes(key)))
    throw new Error("Endpoints contain connection settings only; select models on the execution group");
  const protocols = input.protocols;
  if (!Array.isArray(protocols) || !protocols.length || new Set(protocols).size !== protocols.length
    || protocols.some(protocol => !ENDPOINT_PROTOCOLS.includes(protocol as EndpointProtocol)))
    throw new Error("Endpoint protocols must be a non-empty list of supported API protocols");
  let url: URL;
  try {
    if (typeof input.base_url !== "string" || input.base_url.length > 2048 || /[\x00-\x20\x7f]/.test(input.base_url)) throw new Error();
    url = new URL(input.base_url);
  } catch { throw new Error("Invalid endpoint base_url"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Endpoint URL must be HTTP(S), without credentials, query or fragment");
  if (input.auth_mode !== "api_key" && input.auth_mode !== "env") throw new Error("Invalid endpoint authentication mode");
  const envKey = input.env_key ?? "";
  if (typeof envKey !== "string" || (input.auth_mode === "env" && !/^REMI_(ENDPOINT|CODEX|CLAUDE|ANTIGRAVITY)_[A-Z0-9_]{1,100}$/.test(envKey)))
    throw new Error("Endpoint environment credentials require a REMI_ENDPOINT_* variable");
  const header = input.auth_header ?? "bearer";
  if (header !== "bearer" && header !== "x-api-key") throw new Error("Invalid endpoint authentication header");
  const credentialId = input.credential_id;
  if (credentialId !== undefined && (typeof credentialId !== "string" || !/^rck_[a-zA-Z0-9_-]{1,100}$/.test(credentialId)))
    throw new Error("Invalid endpoint credential reference");
  const paths = input.protocol_paths;
  if (paths !== undefined && (!paths || typeof paths !== "object" || Array.isArray(paths)
    || Object.entries(paths).some(([protocol, path]) => !protocols.includes(protocol) || typeof path !== "string"
      || path.length > 512 || (path !== "" && (!path.startsWith("/") || path.startsWith("//")))
      || /[?#\\\s]/.test(path) || path.split("/").includes(".."))))
    throw new Error("Protocol paths must be relative URL paths for the endpoint's selected protocols");
  const urls = input.protocol_urls;
  let protocolUrls: EndpointConnection["protocol_urls"];
  if (urls !== undefined) {
    if (!urls || typeof urls !== "object" || Array.isArray(urls)) throw new Error("protocol_urls must be an object");
    protocolUrls = {};
    for (const [protocol, value] of Object.entries(urls)) {
      if (!protocols.includes(protocol)) throw new Error("Protocol address requires an enabled protocol");
      protocolUrls[protocol as EndpointProtocol] = normalizeEndpointBaseUrl(endpointHttpUrl(value, "protocol URL"), protocol as EndpointProtocol);
    }
  }
  return { base_url: url.toString().replace(/\/$/, ""), protocols: protocols as EndpointProtocol[],
    ...(protocolUrls ? { protocol_urls: protocolUrls } : {}),
    ...(input.options !== undefined ? { options: parseEndpointOptions(input.options) } : {}),
    ...(paths ? { protocol_paths: paths as EndpointConnection["protocol_paths"] } : {}),
    auth_mode: input.auth_mode, env_key: input.auth_mode === "env" ? envKey : "", auth_header: header,
    ...(input.auth_mode === "api_key" && credentialId ? { credential_id: credentialId as string } : {}) };
}
export function parseExecutionModelPolicy(value: unknown): ExecutionModelPolicy {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("model_policy must be an object");
  const policy = value as ExecutionModelPolicy;
  if (Object.keys(policy).some(key => key !== "model" && key !== "models" && key !== "blocked_models")) throw new Error("Unsupported model policy field");
  const valid = (id: unknown): id is string => typeof id === "string" && !!id.trim()
    && id === id.trim() && id.length <= 200 && !/[\x00-\x1f\x7f]/.test(id);
  if (policy.model !== undefined && policy.model !== "" && !valid(policy.model)) throw new Error("Invalid default model");
  if (policy.models !== undefined && (!Array.isArray(policy.models) || !policy.models.length || policy.models.length > 200
    || policy.models.some(id => !valid(id)) || new Set(policy.models).size !== policy.models.length
    || (policy.model && !policy.models.includes(policy.model)))) throw new Error("Model allowlist must contain unique IDs and the default model");
  if (policy.blocked_models !== undefined && (!Array.isArray(policy.blocked_models) || policy.blocked_models.length > 200
    || policy.blocked_models.some(id => !valid(id)) || new Set(policy.blocked_models).size !== policy.blocked_models.length))
    throw new Error("model_policy.blocked_models must contain at most 200 unique model IDs");
  if (policy.model && executionModelPolicyReason(policy, policy.model) === "model_blocked_by_policy")
    throw new ExecutionModelPolicyError("model_blocked_by_policy", "model_policy.model: default model is blocked by policy", "model_policy.model");
  return { ...(policy.blocked_models?.length ? { blocked_models: policy.blocked_models } : {}), ...(policy.model ? { model: policy.model } : {}), ...(policy.models ? { models: policy.models } : {}) };
}

/** Shared policy decision for catalogs, Agent validation and task eligibility. */
export function executionModelPolicyReason(policy: ExecutionModelPolicy, model: string): "model_blocked_by_policy" | "model_not_allowed_by_policy" | null {
  if (policy.blocked_models?.includes(model)) return "model_blocked_by_policy";
  if (policy.models && !policy.models.includes(model)) return "model_not_allowed_by_policy";
  return null;
}

/** Adapt a protocol endpoint at the group boundary; stored endpoints never own models or engines. */
export function endpointRuntimeProfile(id: string, connection: EndpointConnection, provider: string,
  policy: ExecutionModelPolicy = {}): RuntimeConnectionProfile & { auth_header?: "bearer" | "x-api-key" } {
  const protocol = providerEndpointProtocol(provider);
  if (!protocol || !connection.protocols.includes(protocol)) throw new Error("Endpoint does not support this execution engine's API protocol");
  const baseUrl = endpointProtocolBaseUrl(connection, protocol);
  if (provider === "antigravity" && /\/v1(?:beta)?\/?$/.test(baseUrl))
    throw new Error("Google Generative endpoint path must omit /v1 and /v1beta");
  return {
    name: id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
    base_url: baseUrl,
    auth_mode: connection.auth_mode, env_key: connection.env_key,
    ...(connection.credential_id ? { credential_id: connection.credential_id } : {}),
    model: policy.model ?? "", ...(policy.models ? { models: policy.models } : {}),
    ...(provider === "claude" ? { auth_header: connection.auth_header } : {}),
    ...(connection.options ? { endpoint_options: connection.options } : {}),
  };
}

/** Accept pasted request/model-list URLs without inventing a different host or version prefix. */
export function normalizeEndpointBaseUrl(value: string, protocol: EndpointProtocol): string {
  const url = new URL(value.trim());
  url.search = ""; url.hash = "";
  let path = url.pathname.replace(/\/+$/, "");
  path = path.replace(/\/(?:chat\/completions|responses|messages|models(?:\/[^/]+:(?:streamGenerateContent|generateContent))?)$/, "");
  if (protocol === "anthropic-messages") path = path.replace(/\/v1$/, "");
  if (protocol === "google-generative") path = path.replace(/\/v1(?:beta)?$/, "");
  url.pathname = path || "/";
  return url.toString().replace(/\/$/, "");
}
