import type { SqlDatabase } from "./db/postgres.js";
import { createHash } from "node:crypto";
import { createId, nowIso } from "../ids.js";
import { legacyEndpointConnection, providerEndpointProtocol } from "@multiremi/contracts/execution-endpoint.js";
import { extractBaseUrl, extractAntigravityDefaultModel } from "../relay/fragment.js";
import { encryptRuntimeProviderKey } from "../runtime-provider-credentials.js";
import { parse as parseToml } from "smol-toml";

/** Preserve immutable old revisions/credentials; never merge endpoints merely because their URLs match. */
export function migrateExecutionEndpoints(db: SqlDatabase): void {
  const profiles = db.query(`SELECT v.* FROM multiremi_execution_profiles p
    JOIN multiremi_execution_profile_versions v ON v.workspace_id=p.workspace_id AND v.id=p.id AND v.revision=p.revision
    WHERE p.provider IN ('claude','codex') AND p.deleted_at IS NULL`).all() as {
      id: string; workspace_id: string; name: string; provider: string; revision: number; profile: string; created_at: string;
    }[];
  for (const row of profiles) {
    const profile = JSON.parse(row.profile);
    const connection = legacyEndpointConnection(row.provider, profile);
    const revision = row.revision + 1;
    db.run(`INSERT INTO multiremi_execution_profile_versions(id,workspace_id,name,provider,revision,profile,created_at,updated_at)
      VALUES(?,?,?,'endpoint',?,?,?,?)`, [row.id, row.workspace_id, row.name, revision, JSON.stringify(connection), row.created_at, nowIso()]);
    db.run("UPDATE multiremi_execution_profiles SET provider='endpoint',revision=? WHERE workspace_id=? AND id=?", [revision, row.workspace_id, row.id]);
    db.run(`UPDATE multiremi_execution_groups SET connection_mode='endpoint',model_policy=? WHERE workspace_id=? AND profile_id=?`,
      [JSON.stringify({ ...(profile.model ? { model: profile.model } : {}), ...(profile.models ? { models: profile.models } : {}) }), row.workspace_id, row.id]);
  }
  const relays = db.query("SELECT workspace_id,engine,fragment,auth_token FROM multiremi_relay_config")
    .all() as { workspace_id: string; engine: "claude" | "codex" | "antigravity"; fragment: string; auth_token: string }[];
  const defaults = new Map<string, string>();
  const defaultModels = new Map<string, string>();
  // Preserve legacy execution semantics for declarations/options that do not yet
  // have a group-owned equivalent; importing an address must not silently erase them.
  const legacyOnly = new Set<string>();
  for (const relay of relays) {
    const identity = JSON.stringify([relay.workspace_id, relay.engine]);
    const declaredReasoning = db.query("SELECT model_id FROM multiremi_gateway_model_reasoning WHERE workspace_id=? AND engine=? LIMIT 1")
      .get(relay.workspace_id, relay.engine);
    const declaredContext = db.query("SELECT model_id FROM multiremi_gateway_model_context WHERE workspace_id=? AND engine=? LIMIT 1")
      .get(relay.workspace_id, relay.engine);
    let extraOptions = false;
    if (relay.fragment.trim()) {
      if (relay.engine === "claude") {
        const fragment = JSON.parse(relay.fragment);
        extraOptions = Object.keys(fragment.env ?? {}).some(key => key !== "ANTHROPIC_BASE_URL");
      } else if (relay.engine === "codex") {
        const fragment = parseToml(relay.fragment);
        const providers = fragment.model_providers as Record<string, Record<string, unknown>> | undefined;
        extraOptions = Object.values(providers ?? {}).some(provider =>
          Object.keys(provider).some(key => !["name", "base_url", "wire_api", "requires_openai_auth"].includes(key)));
      }
    }
    if (declaredReasoning || declaredContext || extraOptions) legacyOnly.add(identity);
    const base = extractBaseUrl(relay.engine, relay.fragment);
    // Empty configuration is native authentication. Incomplete configured gateways
    // retain their legacy row for diagnosis rather than inventing credentials.
    if (!base || !relay.auth_token) continue;
    const id = `ep_relay_${createHash("sha256").update(JSON.stringify([relay.workspace_id, relay.engine])).digest("hex").slice(0, 24)}`;
    const credential = createId("rck");
    const connection = { base_url: base, protocols: relay.engine === "codex" ? ["openai-responses", "openai-chat-completions"] : [providerEndpointProtocol(relay.engine)!],
      protocol_paths: { [providerEndpointProtocol(relay.engine)!]: "", ...(relay.engine === "codex" ? { "openai-chat-completions": "" } : {}) },
      auth_mode: "api_key", env_key: "", auth_header: "bearer", credential_id: credential };
    db.run("INSERT INTO multiremi_execution_profile_credentials(id,profile_id,workspace_id,ciphertext) VALUES(?,?,?,?)",
      [credential, id, relay.workspace_id, encryptRuntimeProviderKey(relay.auth_token, {
        workspaceId: relay.workspace_id, runtimeId: id, credentialId: credential,
      })]);
    const name = `Imported gateway / ${relay.engine}`;
    db.run(`INSERT INTO multiremi_execution_profiles(id,workspace_id,name,provider,revision) VALUES(?,?,?,'endpoint',1)`,
      [id, relay.workspace_id, name]);
    db.run(`INSERT INTO multiremi_execution_profile_versions(id,workspace_id,name,provider,revision,profile,created_at,updated_at)
      VALUES(?,?,?,'endpoint',1,?,?,?)`, [id, relay.workspace_id, name, JSON.stringify(connection), nowIso(), nowIso()]);
    db.run("UPDATE multiremi_relay_config SET endpoint_id=?,auth_token='' WHERE workspace_id=? AND engine=?",
      [id, relay.workspace_id, relay.engine]);
    defaults.set(JSON.stringify([relay.workspace_id, relay.engine]), id);
    if (relay.engine === "antigravity") {
      const model = extractAntigravityDefaultModel(relay.fragment);
      if (model) defaultModels.set(JSON.stringify([relay.workspace_id, relay.engine]), model);
    }
  }
  const existingDefaults = db.query("SELECT workspace_id,engine,endpoint_id FROM multiremi_relay_config WHERE endpoint_id IS NOT NULL")
    .all() as { workspace_id: string; engine: string; endpoint_id: string }[];
  for (const row of existingDefaults) defaults.set(JSON.stringify([row.workspace_id, row.engine]), row.endpoint_id);
  const groups = db.query("SELECT id,workspace_id,provider FROM multiremi_execution_groups WHERE managed=1 AND profile_id IS NULL")
    .all() as { id: string; workspace_id: string; provider: string }[];
  for (const group of groups) {
    if (legacyOnly.has(JSON.stringify([group.workspace_id, group.provider]))) continue;
    const endpoint = defaults.get(JSON.stringify([group.workspace_id, group.provider])) ?? null;
    const incomplete = !endpoint && relays.some(r => r.workspace_id === group.workspace_id && r.engine === group.provider && r.fragment.trim());
    if (incomplete) continue;
    const model = defaultModels.get(JSON.stringify([group.workspace_id, group.provider]));
    db.run("UPDATE multiremi_execution_groups SET connection_mode=?,profile_id=?,model_policy=? WHERE workspace_id=? AND id=?",
      [endpoint ? "endpoint" : "native", endpoint, JSON.stringify(model ? { model } : {}), group.workspace_id, group.id]);
  }
  // Group-less agents previously depended on an implicit workspace fallback.
  // Materialize that choice without changing existing frozen task snapshots.
  const agents = db.query(`SELECT id,workspace_id,provider,runtime_id FROM multiremi_agents
    WHERE execution_group_id IS NULL AND archived_at IS NULL AND provider IN ('claude','codex','antigravity','grok')`)
    .all() as { id: string; workspace_id: string; provider: string; runtime_id: string | null }[];
  for (const agent of agents) {
    if (legacyOnly.has(JSON.stringify([agent.workspace_id, agent.provider]))) continue;
    const endpoint = defaults.get(JSON.stringify([agent.workspace_id, agent.provider])) ?? null;
    if (!endpoint && relays.some(r => r.workspace_id === agent.workspace_id && r.engine === agent.provider && r.fragment.trim())) continue;
    const id = `eg_endpoint_${createHash("sha256").update(JSON.stringify([agent.workspace_id, agent.provider, agent.runtime_id ?? ""])).digest("hex").slice(0, 24)}`;
    db.run(`INSERT INTO multiremi_execution_groups(id,workspace_id,provider,name,description,created_at,managed,profile_id,connection_mode,model_policy)
      VALUES(?,?,?,?,?,?,1,?,?,?) ON CONFLICT(workspace_id,id) DO NOTHING`,
      [id, agent.workspace_id, agent.provider, `Imported / ${agent.provider}${agent.runtime_id ? " / " + agent.runtime_id : ""}`, "", nowIso(), endpoint, endpoint ? "endpoint" : "native",
        JSON.stringify(defaultModels.has(JSON.stringify([agent.workspace_id, agent.provider]))
          ? { model: defaultModels.get(JSON.stringify([agent.workspace_id, agent.provider])) } : {})]);
    const runtimes = db.query(`SELECT id FROM multiremi_runtimes WHERE COALESCE(workspace_id,'local')=? AND (provider=? OR provider='any')
      ${agent.runtime_id ? "AND id=?" : ""}`).all(agent.workspace_id, agent.provider, ...(agent.runtime_id ? [agent.runtime_id] : [])) as { id: string }[];
    for (const runtime of runtimes) db.run(`INSERT INTO multiremi_execution_group_members(runtime_id,provider,workspace_id,group_id)
      VALUES(?,?,?,?) ON CONFLICT(workspace_id,group_id,runtime_id) DO NOTHING`, [runtime.id, agent.provider, agent.workspace_id, id]);
    db.run("UPDATE multiremi_agents SET execution_group_id=? WHERE workspace_id=? AND id=?", [id, agent.workspace_id, agent.id]);
  }
  db.run("DELETE FROM multiremi_execution_binding_generations");
  db.run("DELETE FROM multiremi_execution_binding_states");
}
