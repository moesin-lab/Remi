import type { RuntimeClaudeProfile } from "@multiremi/contracts/claude-profile";
import type { RuntimeCodexProfile } from "@multiremi/contracts/codex-profile";
import type { MultiremiRuntimeModel } from "@multiremi/contracts/types.js";
import { proxyFetch } from "@shared/proxy-fetch.js";
import { readCapped } from "@multiremi/relay/http.js";
import { v1BaseUrl } from "@multiremi/relay/protocol-url.js";
import { validCodexNativeCatalog } from "@multiremi/contracts/codex-model-catalog.js";
import { validateCodexModelCatalog } from "@acp/model-catalog-validation.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Runs on the owning Runtime: custom connections intentionally support loopback/LAN. */
export async function discoverRuntimeProfileModels(
  provider: "codex" | "claude" | "antigravity",
  profile: RuntimeCodexProfile | RuntimeClaudeProfile,
  token: string,
  signal: AbortSignal,
  validate: typeof validateCodexModelCatalog = validateCodexModelCatalog,
): Promise<MultiremiRuntimeModel[]> {
  const manual = (profile.endpoint_options?.manual_models ?? []).map(model => ({
    id: model.id, label: model.name ?? model.id, provider, default: model.id === profile.model,
  }));
  if (profile.endpoint_options?.fetch_models === false) return manual;
  let discovered: MultiremiRuntimeModel[];
  try { discovered = await discoverListedRuntimeModels(provider, profile, token, signal, validate); }
  catch (error) { if (signal.aborted || !manual.length) throw error; return manual; }
  const models = new Map(discovered.map(model => [model.id, model]));
  for (const model of manual) models.set(model.id, { ...models.get(model.id), ...model });
  return [...models.values()];
}

async function discoverListedRuntimeModels(
  provider: "codex" | "claude" | "antigravity",
  profile: RuntimeCodexProfile | RuntimeClaudeProfile,
  token: string,
  signal: AbortSignal,
  validate: typeof validateCodexModelCatalog = validateCodexModelCatalog,
): Promise<MultiremiRuntimeModel[]> {
  const base = profile.base_url.replace(/\/+$/, "");
  const protocolBase = provider === "claude" ? v1BaseUrl(base) : base;
  const url = new URL(profile.endpoint_options?.models_url ?? `${protocolBase}${provider === "antigravity" ? "/v1beta/models" : "/models"}`);
  const headers: Record<string, string> = { Accept: "application/json", ...profile.endpoint_options?.headers };
  if (provider === "claude" && (profile as RuntimeClaudeProfile).auth_header === "x-api-key") headers["x-api-key"] = token;
  else headers.Authorization = `Bearer ${token}`;
  if (provider === "antigravity") headers["x-goog-api-key"] = token;
  if (provider === "claude") headers["anthropic-version"] = "2023-06-01";
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(profile.endpoint_options?.timeout_ms ?? 10_000)]);
  const models = new Map<string, MultiremiRuntimeModel>();
  const cursors = new Set<string>();
  for (;;) {
    const response = await proxyFetch(url, { headers, signal: requestSignal, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      // Never include a provider response body, which may echo authentication headers.
      throw new Error(`Runtime ${provider} model discovery HTTP ${response.status}`);
    }
    const text = await readCapped(response, 1_000_000);
    let body: { data?: unknown; models?: unknown; has_more?: boolean; last_id?: unknown; nextPageToken?: unknown };
    try { body = JSON.parse(text); }
    catch { throw new Error(`Runtime ${provider} model discovery returned invalid JSON`); }
    if (provider === "antigravity") {
      if (!body || !Array.isArray(body.models)) throw new Error("Runtime antigravity model discovery requires a models array");
      for (const item of body.models) {
        if (!item || typeof item.name !== "string" || !item.name.startsWith("models/")) continue;
        if (Array.isArray(item.supportedGenerationMethods) && !item.supportedGenerationMethods.includes("generateContent")) continue;
        const id = item.name.slice(7);
        if (!id || models.has(id)) continue;
        const clean = id.toLowerCase().replace(/-preview$/, "");
        if (clean.startsWith("imagen") || clean.startsWith("dall-e") || clean.endsWith("-image") || clean.endsWith("_image") || clean.includes("image-gen")) continue;
        models.set(id, { id, label: typeof item.displayName === "string" ? item.displayName : id, provider, default: id === profile.model,
          thinking: { status: "unsupported", supportedLevels: [] } });
      }
      if (!body.nextPageToken) break;
      if (typeof body.nextPageToken !== "string" || cursors.has(body.nextPageToken) || cursors.size >= 100)
        throw new Error("Invalid antigravity model discovery pagination");
      cursors.add(body.nextPageToken); url.searchParams.set("pageToken", body.nextPageToken);
      continue;
    }
    if (!body || !Array.isArray(body.data)) throw new Error(`Runtime ${provider} model discovery requires a data array`);
    if (provider === "codex" && body.models !== undefined) {
      if (!validCodexNativeCatalog(body)) throw new Error("Runtime codex model discovery returned invalid native metadata");
      const home = await mkdtemp(join(tmpdir(), "remi-model-discovery-"));
      try {
        const path = join(home, "models.json");
        await writeFile(path, JSON.stringify({ models: body.models }), { mode: 0o600 });
        await validate(path, home, requestSignal);
        requestSignal.throwIfAborted();
      } catch {
        throw new Error("Runtime codex model discovery native metadata validation failed");
      } finally {
        await rm(home, { recursive: true, force: true });
      }
      for (const row of body.models) {
        if (row.visibility === "hide" || !row.supported_in_api || models.has(row.slug)) continue;
        const supportedLevels = row.supported_reasoning_levels.map(level => ({
          value: level.effort, label: level.effort,
          ...(level.description ? { description: level.description } : {}),
        }));
        if (row.default_reasoning_level && !supportedLevels.some(level => level.value === row.default_reasoning_level)) {
          throw new Error("Runtime codex model discovery returned invalid default reasoning metadata");
        }
        models.set(row.slug, {
          id: row.slug, label: row.display_name, provider, default: row.slug === profile.model || row.default === true,
          thinking: { status: supportedLevels.length ? "supported" : "unsupported", supportedLevels,
            ...(row.default_reasoning_level ? { defaultLevel: row.default_reasoning_level } : {}) },
          catalog: { status: "ready" },
        });
      }
      break;
    }
    for (const row of body.data) {
      if (!row || typeof row.id !== "string" || !row.id.trim()) continue;
      const id = row.id.trim();
      if (models.has(id)) continue;
      const thinking = gatewayThinking(row);
      models.set(id, { id, label: typeof row.display_name === "string" && row.display_name.trim() ? row.display_name.trim() : id,
        provider, default: id === profile.model || row.default === true, ...(thinking ? { thinking } : {}) });
    }
    if (provider !== "claude" || !body.has_more) break;
    const cursor = typeof body.last_id === "string" ? body.last_id : "";
    if (!cursor || cursors.has(cursor)) throw new Error("Runtime claude model discovery returned an invalid pagination cursor");
    cursors.add(cursor);
    url.searchParams.set("after_id", cursor);
  }
  if (!models.size) throw new Error(`Runtime ${provider} model discovery returned no models`);
  // Keep the explicitly configured default usable even if the endpoint omits aliases.
  if (profile.model && !models.has(profile.model)) models.set(profile.model, { id: profile.model, label: profile.model, provider, default: true });
  if (!profile.model && ![...models.values()].some(model => model.default)) models.values().next().value!.default = true;
  return [...models.values()];
}

function gatewayThinking(row: Record<string, unknown>): MultiremiRuntimeModel["thinking"] {
  const levels = row.supported_reasoning_levels;
  if (levels === undefined) return undefined;
  const invalid = (): NonNullable<MultiremiRuntimeModel["thinking"]> => ({
    status: "error", supportedLevels: [], error: "gateway returned invalid reasoning metadata",
  });
  if (!Array.isArray(levels)) return invalid();
  const supportedLevels: Array<{ value: string; label: string; description?: string }> = [];
  for (const level of levels) {
    if (!level || typeof level !== "object" || typeof level.effort !== "string" || !level.effort.trim()
      || (level.description !== undefined && typeof level.description !== "string")) return invalid();
    if (!supportedLevels.some(item => item.value === level.effort)) {
      supportedLevels.push({ value: level.effort, label: level.effort,
        ...(level.description ? { description: level.description } : {}) });
    }
  }
  const defaultLevel = row.default_reasoning_level;
  if (defaultLevel != null && (typeof defaultLevel !== "string" || !supportedLevels.some(level => level.value === defaultLevel))) return invalid();
  return { status: supportedLevels.length ? "supported" : "unsupported", supportedLevels,
    ...(typeof defaultLevel === "string" ? { defaultLevel } : {}) };
}
