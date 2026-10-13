import type { RuntimeClaudeProfile } from "@multiremi/contracts/claude-profile";
import type { RuntimeCodexProfile } from "@multiremi/contracts/codex-profile";
import type { MultiremiRuntimeModel } from "@multiremi/contracts/types.js";
import { readCapped } from "@multiremi/relay/http.js";
import { validCodexNativeCatalog } from "@multiremi/contracts/codex-model-catalog.js";
import { validateCodexModelCatalog } from "@acp/model-catalog-validation.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Runs on the owning Runtime: custom connections intentionally support loopback/LAN. */
export async function discoverRuntimeProfileModels(
  provider: "codex" | "claude",
  profile: RuntimeCodexProfile | RuntimeClaudeProfile,
  token: string,
  signal: AbortSignal,
  validate: typeof validateCodexModelCatalog = validateCodexModelCatalog,
): Promise<MultiremiRuntimeModel[]> {
  const base = profile.base_url.replace(/\/+$/, "");
  const url = new URL(base + (provider === "claude" && !base.endsWith("/v1") ? "/v1/models" : "/models"));
  const headers: Record<string, string> = { Accept: "application/json" };
  if (provider === "claude" && (profile as RuntimeClaudeProfile).auth_header === "x-api-key") headers["x-api-key"] = token;
  else headers.Authorization = `Bearer ${token}`;
  if (provider === "claude") headers["anthropic-version"] = "2023-06-01";
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  const models = new Map<string, MultiremiRuntimeModel>();
  const cursors = new Set<string>();
  for (;;) {
    const response = await fetch(url, { headers, signal: requestSignal, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      // Never include a provider response body, which may echo authentication headers.
      throw new Error(`Runtime ${provider} model discovery HTTP ${response.status}`);
    }
    const text = await readCapped(response, 1_000_000);
    let body: { data?: unknown; models?: unknown; has_more?: boolean; last_id?: unknown };
    try { body = JSON.parse(text); }
    catch { throw new Error(`Runtime ${provider} model discovery returned invalid JSON`); }
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
      models.set(id, { id, label: typeof row.display_name === "string" && row.display_name.trim() ? row.display_name.trim() : id,
        provider, default: id === profile.model || row.default === true });
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
