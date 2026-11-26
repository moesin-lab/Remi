import { endpointProtocolBaseUrl, type EndpointConnection, type EndpointProtocol } from "@multiremi/contracts/execution-endpoint.js";
import type { EndpointModel } from "@multiremi/contracts/endpoint-options.js";
import { readCapped } from "./http.js";
import { chatCompletionsUrl, v1BaseUrl } from "./protocol-url.js";

export interface EndpointProbeResult {
  protocol: EndpointProtocol;
  operation: "models" | "detect" | "test";
  state: "ok" | "recognized" | "error" | "manual";
  url: string;
  http_status: number | null;
  duration_ms: number;
  error_code?: string;
  message?: string;
  models: EndpointModel[];
  model?: string;
}
export interface EndpointInspection {
  checked_at: string;
  location: "server";
  results: EndpointProbeResult[];
}
export function endpointHeaders(connection: EndpointConnection, protocol: EndpointProtocol, key: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json", ...connection.options?.headers };
  if (protocol === "anthropic-messages") {
    headers["anthropic-version"] = "2023-06-01";
    if (connection.auth_header === "x-api-key") headers["x-api-key"] = key;
    else headers.Authorization = `Bearer ${key}`;
  } else if (protocol === "google-generative") headers["x-goog-api-key"] = key;
  else headers.Authorization = `Bearer ${key}`;
  return headers;
}
export function mergeEndpointModels(discovered: EndpointModel[], manual: EndpointModel[] = []): EndpointModel[] {
  const models = new Map(discovered.map(model => [model.id, model]));
  for (const model of manual) models.set(model.id, { ...models.get(model.id), ...model, source: "manual" });
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}
function modelRow(value: unknown, google: boolean): EndpointModel | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, any>;
  const rawId = google ? row.name : row.id;
  if (typeof rawId !== "string" || !rawId.trim() || rawId.length > 200 || /[\x00-\x1f\x7f]/.test(rawId)) return null;
  if (google && Array.isArray(row.supportedGenerationMethods) && !row.supportedGenerationMethods.includes("generateContent")) return null;
  const id = google ? rawId.replace(/^models\//, "") : rawId.trim();
  const name = row.display_name ?? row.displayName ?? row.name;
  const context = row.context_window ?? row.context_length ?? row.inputTokenLimit ?? row.top_provider?.context_length;
  const output = row.max_output_tokens ?? row.outputTokenLimit ?? row.top_provider?.max_completion_tokens;
  return { id, source: "discovered", ...(typeof name === "string" && name.length <= 200 ? { name } : {}),
    ...(Number.isSafeInteger(context) && context > 0 ? { context_window: context } : {}),
    ...(Number.isSafeInteger(output) && output > 0 ? { max_output_tokens: output } : {}) };
}
function endpointError(status: number): { error_code: string; message: string } {
  if (status === 401 || status === 403) return { error_code: "authentication_failed", message: "认证被拒绝，请检查密钥、认证头和端点权限。" };
  if (status === 404 || status === 405) return { error_code: "route_unavailable", message: "接口路径不可用；检查协议地址，或单独配置模型列表地址。" };
  if (status === 429) return { error_code: "rate_limited", message: "端点限流或额度不足，请稍后重试。" };
  return { error_code: status >= 500 ? "upstream_unavailable" : "request_rejected", message: `端点返回 HTTP ${status}。` };
}
export async function inspectEndpoint(connection: EndpointConnection, key: string, input: {
  operation: "models" | "detect" | "test"; protocol?: EndpointProtocol; model?: string; signal?: AbortSignal;
}, request: typeof fetch = fetch): Promise<EndpointInspection> {
  if (!["models", "detect", "test"].includes(input.operation)) throw new Error("Invalid inspection operation");
  const protocols = input.protocol ? [input.protocol] : connection.protocols;
  if (protocols.some(protocol => !connection.protocols.includes(protocol))) throw new Error("Protocol is not configured on this endpoint");
  if (input.operation === "test" && (!input.protocol || !input.model?.trim() || input.model.length > 200 || /[\x00-\x1f\x7f]/.test(input.model)))
    throw new Error("Model test requires one configured protocol and a model ID");
  const results = await Promise.all(protocols.map(async protocol => {
    const started = performance.now();
    const base = endpointProtocolBaseUrl(connection, protocol).replace(/\/+$/, "");
    const google = protocol === "google-generative";
    const protocolBase = protocol === "anthropic-messages" ? v1BaseUrl(base) : base;
    const modelUrl = connection.options?.models_url ?? `${protocolBase}${google ? "/v1beta/models" : "/models"}`;
    const model = input.operation === "test" ? input.model!.trim() : "__remi_protocol_probe__";
    const url = input.operation === "models" ? modelUrl : google
      ? `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`
      : protocol === "openai-chat-completions" ? chatCompletionsUrl(base, true)
      : `${protocolBase}${protocol === "openai-responses" ? "/responses" : "/messages"}`;
    const result: EndpointProbeResult = { protocol, operation: input.operation, state: "error", url, http_status: null,
      duration_ms: 0, models: [], ...(input.operation === "test" ? { model } : {}) };
    if (input.operation === "models" && connection.options?.fetch_models === false)
      return { ...result, state: "manual" as const, models: mergeEndpointModels([], connection.options.manual_models) };
    const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(connection.options?.timeout_ms ?? 15000)]);
    const headers = endpointHeaders(connection, protocol, key);
    try {
      if (input.operation === "models") {
        const next = new URL(url);
        const seen = new Set<string>();
        const models = new Map<string, EndpointModel>();
        for (let page = 0; page < 100; page++) {
          const response = await request(next, { headers, signal, redirect: "error" });
          result.http_status = response.status;
          if (!response.ok) { await response.body?.cancel(); return { ...result, ...endpointError(response.status), duration_ms: Math.round(performance.now() - started) }; }
          const body = JSON.parse(await readCapped(response, 2_000_000));
          const rows = Array.isArray(body) ? body : google ? body.models ?? body.data : body.data ?? body.models;
          if (!Array.isArray(rows)) throw new Error("invalid_catalog");
          for (const row of rows) { const parsed = modelRow(row, google && typeof row?.name === "string"); if (parsed) models.set(parsed.id, parsed); }
          if (models.size > 10000) throw new Error("catalog_too_large");
          const cursor = google ? body.nextPageToken : body.has_more ? body.last_id : null;
          if (!cursor) break;
          if (typeof cursor !== "string" || seen.has(cursor) || page === 99) throw new Error("invalid_pagination");
          seen.add(cursor); next.searchParams.set(google ? "pageToken" : "after_id", cursor);
        }
        result.models = mergeEndpointModels([...models.values()], connection.options?.manual_models);
        if (!result.models.length) throw new Error("empty_catalog");
        result.state = "ok";
      } else {
        headers["Content-Type"] = "application/json";
        const probe = input.operation === "detect";
        const body = google ? { contents: probe ? [] : [{ role: "user", parts: [{ text: "Reply OK." }] }], generationConfig: { maxOutputTokens: 16 } }
          : protocol === "openai-responses" ? { model, input: probe ? [] : "Reply OK.", max_output_tokens: 16, store: false }
          : { model, messages: probe ? [] : [{ role: "user", content: "Reply OK." }], max_tokens: 16, stream: false };
        const response = await request(url, { method: "POST", headers, body: JSON.stringify(body), signal, redirect: "error" });
        result.http_status = response.status;
        if (!response.ok) {
          await response.body?.cancel();
          if (probe && [400, 422].includes(response.status)) result.state = "recognized";
          else Object.assign(result, endpointError(response.status));
        } else {
          const body = JSON.parse(await readCapped(response, 2_000_000));
          const items = google ? body.candidates : protocol === "anthropic-messages" ? body.content
            : protocol === "openai-responses" ? body.output : body.choices;
          const text = (value: unknown) => typeof value === "string" && value.trim().length > 0;
          const valid = Array.isArray(items) && items.some(item => {
            if (!item || typeof item !== "object") return false;
            if (google) return Array.isArray(item.content?.parts) && item.content.parts.some((part: any) => text(part?.text));
            if (protocol === "anthropic-messages") return item.type === "text" && text(item.text);
            if (protocol === "openai-responses") return item.type === "message" && Array.isArray(item.content)
              && item.content.some((part: any) => part?.type === "output_text" && text(part.text));
            return text(item.message?.content);
          });
          if (!valid) throw new Error("invalid_response");
          result.state = probe ? "recognized" : "ok";
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      result.error_code = signal.aborted ? "timeout" : ["invalid_catalog", "empty_catalog", "invalid_pagination", "catalog_too_large", "invalid_response"].includes(message) ? message
        : error instanceof SyntaxError ? "invalid_json" : "connection_failed";
      result.message = result.error_code === "empty_catalog" ? "端点未返回模型；保留旧目录。可关闭自动获取并手动添加模型。"
        : result.error_code === "timeout" ? "端点请求超时。" : "无法读取有效响应，请检查地址、网络、证书和接口格式。";
    }
    result.duration_ms = Math.round(performance.now() - started);
    return result;
  }));
  return { checked_at: new Date().toISOString(), location: "server", results };
}
