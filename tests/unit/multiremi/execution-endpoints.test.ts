import { afterEach, beforeEach, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";
import { executionGroupModelCatalog } from "@multiremi/api/helpers/agents.js";
import { resetMultiremiTestEnv } from "./helpers.js";

const key = "endpoint-test-secret";
const connection = { base_url: "http://127.0.0.1:8788/v1", protocols: ["openai-responses", "anthropic-messages"],
  auth_mode: "api_key", env_key: "", auth_header: "bearer" };
beforeEach(() => { process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 71).toString("base64"); });
afterEach(resetMultiremiTestEnv);

pendingTurnBackendTests("shared gateway endpoints", (fixture, backend) => {
  it("retains good inventory on failure, ignores superseded revisions and keeps drafts unsaved", async () => {
    const { store } = fixture();
    const endpoint = store.saveExecutionEndpoint("local", { name: "Catalog", connection, api_key: key });
    const inspection = { checked_at: "2026-11-14T00:00:00Z", location: "server" as const, results: [{
      protocol: "openai-responses" as const, operation: "models" as const, state: "ok" as const,
      url: "https://catalog.invalid/models", http_status: 200, duration_ms: 2, models: [{ id: "retained" }],
    }] };
    store.recordExecutionEndpointInspection(endpoint.id, "local", endpoint.revision, inspection);
    store.recordExecutionEndpointInspection(endpoint.id, "local", endpoint.revision, { ...inspection,
      results: [{ ...inspection.results[0]!, state: "error", models: [], error_code: "empty_catalog" }] });
    expect(store.getExecutionEndpointCatalog(endpoint.id, "local")[0]).toMatchObject({ models: [{ id: "retained" }], error_code: "empty_catalog" });
    const changed = store.saveExecutionEndpoint("local", { name: "Catalog", connection: { ...connection, options: { fetch_models: false, manual_models: [{ id: "manual" }] } } }, endpoint.id);
    store.recordExecutionEndpointInspection(endpoint.id, "local", endpoint.revision, { ...inspection, results: [{ ...inspection.results[0]!, models: [{ id: "stale" }] }] });
    expect(store.getExecutionEndpointCatalog(endpoint.id, "local")[0].models).toEqual([{ id: "retained" }]);
    const app = createMultiremiApp({ store });
    const result = await app.request("/api/execution-endpoints/inspect", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint_id: changed.id, connection: { ...changed.connection, options: { fetch_models: false, manual_models: [{ id: "draft-only" }] } }, operation: "models" }) });
    expect(result.status).toBe(200);
    const body = await result.json();
    expect(body.persisted).toBe(false);
    for (const row of body.inspection.results) expect(row).toMatchObject({ state: "manual", models: [{ id: "draft-only" }] });
    expect(store.getExecutionEndpoint(changed.id, "local")?.connection.options?.manual_models?.[0]?.id).toBe("manual");
    expect(store.getExecutionEndpointCatalog(endpoint.id, "other")).toEqual([]);
  });

  it("requires endpoint options support before reporting a binding ready", () => {
    const { store } = fixture();
    const endpoint = store.saveExecutionEndpoint("local", { name: "Manual catalog", connection: { ...connection,
      options: { fetch_models: false, manual_models: [{ id: "manual" }] } }, api_key: key });
    const runtime = store.registerRuntime({ name: "Old runtime", provider: "codex", metadata: { execution_endpoints: 1, codex_profiles: 1 } });
    const group = store.saveExecutionGroup("local", { name: "Manual group", provider: "codex", endpoint_id: endpoint.id, runtime_ids: [runtime.id] });
    const binding = store.getRuntimeExecutionBindings(runtime.id)[0]!;
    store.recordRuntimeExecutionBindingAcks(runtime.id, [{ ...binding, status: "ready", model_catalog: { status: "ready", models: [{ id: "manual", label: "manual", provider: "codex", default: true }] } }]);
    expect(store.getExecutionGroupMembers(group.id, "local")[0]).toMatchObject({ status: "error" });
    expect(store.getExecutionGroupMembers(group.id, "local")[0]?.error).toContain("Upgrade");
  });

  it("never uses server environment secrets for a Runtime endpoint probe", async () => {
    const { store } = fixture();
    const app = createMultiremiApp({ store });
    const result = await app.request("/api/execution-endpoints/inspect", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connection: { ...connection, auth_mode: "env", env_key: "REMI_ENDPOINT_TEST", options: { fetch_models: false } }, operation: "test", protocol: "openai-responses", model: "test", api_key: "ignored" }) });
    expect(result.status).toBe(400);
    expect(await result.text()).toContain("Runtime environment credential");
  });

  it("shares one endpoint and credential across different engines without storing model choices on it", async () => {
    const { store } = fixture();
    const app = createMultiremiApp({ store });
    const response = await app.request("/api/execution-endpoints", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Gateway", connection, api_key: key }) });
    expect(response.status).toBe(201);
    const body = await response.text();
    expect(body).not.toContain(key);
    const endpoint = JSON.parse(body).endpoint;
    expect(endpoint.connection.model).toBeUndefined();
    expect(endpoint.provider).toBeUndefined();
    for (const provider of ["claude", "codex"] as const) {
      const runtime = store.registerRuntime({ name: provider, provider, metadata: { execution_endpoints: 1, [`${provider}_profiles`]: 1 } });
      const group = store.saveExecutionGroup("local", { name: provider, provider, endpoint_id: endpoint.id, runtime_ids: [runtime.id],
        model_policy: { model: `${provider}-model`, models: [`${provider}-model`] } });
      const binding = store.getRuntimeExecutionBindings(runtime.id)[0]!;
      expect(binding.profile?.base_url).toBe(connection.base_url);
      expect(binding.profile?.model).toBe(`${provider}-model`);
      expect(binding.profileId).toBe(endpoint.id);
      expect(store.executionProfilesRepo().getKeyForRuntime(runtime.id, endpoint.connection.credential_id)).toBe(key);
      expect(group.endpointId).toBe(endpoint.id);
    }
    expect(store.listExecutionEndpoints("local")).toHaveLength(1);
  });

  it("rejects incompatible bindings, credential reference substitution and unsupported model fields", () => {
    const { store } = fixture();
    const endpoint = store.saveExecutionEndpoint("local", { name: "One", connection, api_key: key });
    expect(() => store.saveExecutionGroup("local", { name: "Wrong protocol", provider: "antigravity", endpoint_id: endpoint.id, runtime_ids: [] }))
      .toThrow("API protocol");
    expect(() => store.saveExecutionEndpoint("local", { name: "Wrong shape", connection: { ...connection, model: "x" }, api_key: key }))
      .toThrow("connection settings only");
    expect(() => store.saveExecutionEndpoint("local", { name: "Foreign reference", connection: { ...connection, credential_id: endpoint.connection.credential_id } }))
      .toThrow("API key is required");
    store.saveExecutionGroup("local", { name: "Codex", provider: "codex", endpoint_id: endpoint.id, runtime_ids: [] });
    expect(() => store.saveExecutionEndpoint("local", { name: "One", connection: { ...connection, protocols: ["anthropic-messages"] } }, endpoint.id))
      .toThrow("still required");
    expect(() => store.deleteExecutionEndpoint(endpoint.id, "local")).toThrow("still used");
  });

  it("invalidates every affected group on credential rotation while preserving a claimed task's exact key and model", () => {
    const { store } = fixture();
    const endpoint = store.saveExecutionEndpoint("local", { name: "Shared", connection, api_key: key });
    const runtime = store.registerRuntime({ name: "Codex", provider: "codex", metadata: { execution_endpoints: 1, codex_profiles: 1 } });
    const group = store.saveExecutionGroup("local", { name: "Build", provider: "codex", endpoint_id: endpoint.id, runtime_ids: [runtime.id] });
    const binding = store.getRuntimeExecutionBindings(runtime.id)[0]!;
    store.recordRuntimeExecutionBindingAcks(runtime.id, [{ ...binding, status: "ready", model_catalog: { status: "ready",
      models: [{ id: "discovered", label: "Discovered", provider: "codex", default: true }] } }]);
    const agent = store.createAgent({ name: "Worker", provider: "codex", executionGroupId: group.id });
    const task = store.createTask({ agentId: agent.id, prompt: "Check" });
    const claim = store.claimTask(runtime.id)!;
    expect(claim?.id).toBe(task.id);
    expect(claim.executionConnection).toMatchObject({ endpoint_id: endpoint.id, endpoint_revision: 1, mode: "endpoint" });
    expect(claim.executionModel).toBe("discovered");
    const changed = store.saveExecutionEndpoint("local", { name: "Shared", connection, api_key: "rotated-test-secret" }, endpoint.id);
    expect(changed.revision).toBe(2);
    expect(store.getExecutionGroupMembers(group.id, "local")[0]?.status).toBe("pending");
    expect(store.executionProfilesRepo().getKeyForRuntime(runtime.id, endpoint.connection.credential_id!)).toBe(key);
    expect(store.getTask(task.id)?.executionConnection?.endpoint_revision).toBe(1);
    const stranger = store.registerRuntime({ name: "Unbound", provider: "codex" });
    expect(store.executionProfilesRepo().getKeyForRuntime(stranger.id, changed.connection.credential_id!)).toBeNull();
  });

  it("keeps local authentication independent of a configured workspace gateway and requires a capable daemon", () => {
    const { store } = fixture();
    store.upsertRelayConfig("local", "codex", { fragment: 'model_provider="gateway"\n[model_providers.gateway]\nbase_url="https://global.test/v1"\nwire_api="responses"',
      tokenOp: "set", authToken: "workspace-key-not-for-native" });
    const runtime = store.registerRuntime({ name: "Native", provider: "codex", metadata: { execution_endpoints: 1, codex_profiles: 1 } });
    const group = store.saveExecutionGroup("local", { name: "Local", provider: "codex", endpoint_id: null, runtime_ids: [runtime.id] });
    const binding = store.getRuntimeExecutionBindings(runtime.id)[0]!;
    expect(binding).toMatchObject({ connectionMode: "native", profileId: null, profile: null });
    store.recordRuntimeExecutionBindingAcks(runtime.id, [{ ...binding, status: "ready", model_catalog: { status: "ready",
      models: [{ id: "native-model", label: "Native", provider: "codex", default: true }] } }]);
    expect(executionGroupModelCatalog(store, "local", group.id, "local")[0]?.models.map(model => model.id)).toEqual(["native-model"]);
    const agent = store.createAgent({ name: "Native worker", provider: "codex", executionGroupId: group.id });
    store.createTask({ agentId: agent.id, prompt: "Native" });
    const claim = store.claimTask(runtime.id)!;
    expect(claim?.executionConnection).toEqual({ mode: "native", provider: "codex", endpoint_id: null, endpoint_revision: null, profile: null });
    expect(claim.executionModel).toBe("native-model");
    store.updateRuntime(runtime.id, { metadata: { execution_endpoints: 0 } });
    expect(store.getExecutionGroupMembers(group.id, "local")[0]?.error).toContain("Upgrade");
  });

  it("migrates old profiles and gateways in place, preserves frozen credential revisions and reopens idempotently", () => {
    const f = fixture();
    const legacy = f.store.saveExecutionProfile("local", { name: "Legacy", provider: "codex",
      profile: { name: "legacy", base_url: connection.base_url, auth_mode: "api_key", env_key: "", model: "old-model" }, api_key: key });
    const runtime = f.store.registerRuntime({ name: "Legacy machine", provider: "codex" });
    const group = f.store.saveExecutionGroup("local", { name: "Existing", provider: "codex", profile_id: legacy.id, runtime_ids: [runtime.id] });
    f.db.run(`INSERT INTO multiremi_relay_config(workspace_id,engine,fragment,auth_token,revision,updated_at)
      VALUES('local','claude',?,?,1,?)`, [JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://legacy.test" } }), "legacy-relay-key", new Date().toISOString()]);
    const legacyOptionsGroup = f.store.saveExecutionGroup("local", { name: "Declared context", provider: "claude", profile_id: null, runtime_ids: [] });
    f.db.run(`INSERT INTO multiremi_gateway_model_context(workspace_id,engine,model_id,context_window,updated_at)
      VALUES('local','claude','large-context','1m',?)`, [new Date().toISOString()]);
    f.db.run("DELETE FROM multiremi_schema_migrations WHERE id='execution_endpoints_v1'");
    if (backend === "PostgreSQL") f.reopen(); else f.store = new MultiremiStore(f.db);
    const migrated = f.store.getExecutionEndpoint(legacy.id, "local")!;
    expect(migrated.revision).toBe(2);
    expect(migrated.connection.protocols).toEqual(["openai-responses"]);
    expect(f.store.getExecutionGroup(group.id)?.modelPolicy).toEqual({ model: "old-model" });
    expect(f.store.getExecutionProfileKey(legacy.id, "local", 1, legacy.profile.credential_id!)).toBe(key);
    expect(f.store.getRelayConfigForDaemon("local").claude?.authToken).toBe("legacy-relay-key");
    expect(f.store.getExecutionGroup(legacyOptionsGroup.id)?.connectionMode).toBe("legacy");
    expect(f.db.query("SELECT auth_token FROM multiremi_relay_config WHERE workspace_id='local' AND engine='claude'").get()?.auth_token).toBe("");
    if (backend === "PostgreSQL") f.reopen(); else f.store = new MultiremiStore(f.db);
    expect(f.store.getExecutionEndpoint(legacy.id, "local")?.revision).toBe(2);
    expect(f.store.listExecutionEndpoints("local")).toHaveLength(2);
  }, 30_000);

  it("system AI references existing endpoints and cannot consume a daemon-only environment credential", () => {
    const { store } = fixture();
    const endpoint = store.saveExecutionEndpoint("local", { name: "System", connection, api_key: key });
    store.setSystemModelEndpoints("local", { "anthropic-messages": endpoint.id });
    expect(store.getRelayConfigForDaemon("local").claude?.authToken).toBe(key);
    expect(store.getSystemModelEndpoints("local")["anthropic-messages"]).toBe(endpoint.id);
    expect(() => store.deleteExecutionEndpoint(endpoint.id, "local")).toThrow("system AI");
    const env = store.saveExecutionEndpoint("local", { name: "Machine only", connection: {
      ...connection, auth_mode: "env", env_key: "REMI_ENDPOINT_TEST" } });
    expect(() => store.setSystemModelEndpoints("local", { "anthropic-messages": env.id })).toThrow("stored API");
    expect(() => store.setSystemModelEndpoints("local", { "openai-chat-completions": endpoint.id })).toThrow("incompatible");
    store.setSystemModelEndpoints("local", { "anthropic-messages": null });
    store.deleteExecutionEndpoint(endpoint.id, "local");
    expect(store.getExecutionEndpoint(endpoint.id, "local")).toBeNull();
  });
});
