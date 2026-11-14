import { createId, nowIso } from "@multiremi/ids.js";
import type { StoreContext } from "../context.js";
import { encryptRuntimeProviderKey } from "@multiremi/runtime-provider-credentials.js";
import { legacyEndpointConnection, parseEndpointConnection, providerEndpointProtocol, type ExecutionEndpoint, type ExecutionEndpointInput } from "@multiremi/contracts/execution-endpoint.js";

/** Endpoints share the existing revision/credential store, preserving frozen credential identities. */
export class ExecutionEndpointsRepo {
  constructor(private readonly ctx: StoreContext) {}
  get(id: string, workspaceId: string, revision?: number): ExecutionEndpoint | null {
    const row = this.ctx.db.query(`SELECT v.* FROM multiremi_execution_profiles p
      JOIN multiremi_execution_profile_versions v ON v.workspace_id=p.workspace_id AND v.id=p.id
      WHERE p.workspace_id=? AND p.id=?
      AND ${revision === undefined ? "p.deleted_at IS NULL AND v.revision=p.revision" : "v.revision=?"}`)
      .get(workspaceId, id, ...(revision === undefined ? [] : [revision])) as
      (Omit<ExecutionEndpoint, "connection"> & { profile: string; provider: string }) | null;
    if (!row) return null;
    return { id: row.id, workspace_id: row.workspace_id, name: row.name, revision: row.revision,
      connection: row.provider === "endpoint" ? JSON.parse(row.profile) : legacyEndpointConnection(row.provider, JSON.parse(row.profile)),
      created_at: row.created_at, updated_at: row.updated_at };
  }
  list(workspaceId: string): ExecutionEndpoint[] {
    const rows = this.ctx.db.query("SELECT id FROM multiremi_execution_profiles WHERE workspace_id=? AND deleted_at IS NULL ORDER BY name,id")
      .all(workspaceId) as { id: string }[];
    return rows.map(row => this.get(row.id, workspaceId)!);
  }
  save(workspaceId: string, input: ExecutionEndpointInput, id = createId("ep")): ExecutionEndpoint {
    if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 128) throw new Error("Endpoint name is required (maximum 128 characters)");
    const connection = parseEndpointConnection(input.connection);
    const key = input.api_key;
    if (key !== undefined && (typeof key !== "string" || !key.trim() || key.length > 8192 || /[\x00-\x1f\x7f]/.test(key)))
      throw new Error("Invalid endpoint API key");
    if (key !== undefined && connection.auth_mode !== "api_key") throw new Error("API keys require api_key authentication");
    return this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      const previous = this.get(id, workspaceId);
      const stored = this.ctx.db.query(`SELECT p.provider,v.profile FROM multiremi_execution_profiles p
        JOIN multiremi_execution_profile_versions v ON v.workspace_id=p.workspace_id AND v.id=p.id AND v.revision=p.revision
        WHERE p.id=? AND p.workspace_id=?`).get(id, workspaceId) as { provider: string; profile: string } | null;
      if (!previous && this.ctx.db.query("SELECT id FROM multiremi_execution_profiles WHERE id=? AND workspace_id=?").get(id, workspaceId))
        throw new Error("Endpoint ID already belongs to another connection");
      const groups = this.ctx.db.query("SELECT provider FROM multiremi_execution_groups WHERE workspace_id=? AND profile_id=?")
        .all(workspaceId, id) as { provider: string }[];
      if (groups.some(group => !connection.protocols.includes(providerEndpointProtocol(group.provider)!)))
        throw new Error("Endpoint protocol is still required by an execution group");
      const systemUses = this.ctx.db.query("SELECT engine FROM multiremi_relay_config WHERE workspace_id=? AND endpoint_id=?")
        .all(workspaceId, id) as { engine: string }[];
      if (systemUses.some(use => !connection.protocols.includes(use.engine === "codex" ? "openai-chat-completions" : providerEndpointProtocol(use.engine)!) || connection.auth_mode !== "api_key"))
        throw new Error("System AI still requires this endpoint protocol and stored API credential");
      if (stored && stored.provider !== "endpoint") {
        const legacy = JSON.parse(stored.profile);
        this.ctx.db.run("UPDATE multiremi_execution_groups SET connection_mode='endpoint',model_policy=? WHERE workspace_id=? AND profile_id=?",
          [JSON.stringify({ ...(legacy.model ? { model: legacy.model } : {}), ...(legacy.models ? { models: legacy.models } : {}) }), workspaceId, id]);
      }
      // A caller cannot substitute another endpoint's credential reference.
      delete connection.credential_id;
      if (connection.auth_mode === "api_key") {
        const credentialId = key === undefined ? previous?.connection.credential_id : createId("rck");
        if (!credentialId) throw new Error("An API key is required for this endpoint");
        connection.credential_id = credentialId;
        if (typeof key === "string") this.ctx.db.run(
          "INSERT INTO multiremi_execution_profile_credentials(id,profile_id,workspace_id,ciphertext) VALUES(?,?,?,?)",
          [credentialId, id, workspaceId, encryptRuntimeProviderKey(key.trim(), { workspaceId, runtimeId: id, credentialId })]);
      }
      const time = nowIso();
      const result: ExecutionEndpoint = { id, workspace_id: workspaceId, name: input.name.trim(),
        revision: (previous?.revision ?? 0) + 1, connection, created_at: previous?.created_at ?? time, updated_at: time };
      this.ctx.db.run(`INSERT INTO multiremi_execution_profiles(id,workspace_id,name,provider,revision,deleted_at)
        VALUES(?,?,?,'endpoint',?,NULL) ON CONFLICT(workspace_id,id) DO UPDATE SET name=excluded.name,revision=excluded.revision,provider=excluded.provider`,
        [id, workspaceId, result.name, result.revision]);
      this.ctx.db.run(`INSERT INTO multiremi_execution_profile_versions(id,workspace_id,name,provider,revision,profile,created_at,updated_at)
        VALUES(?,?,?,'endpoint',?,?,?,?)`, [id, workspaceId, result.name, result.revision, JSON.stringify(connection), result.created_at, time]);
      this.ctx.db.run("UPDATE multiremi_relay_config SET revision=revision+1 WHERE workspace_id=? AND endpoint_id=?", [workspaceId, id]);
      return result;
    })();
  }
}
