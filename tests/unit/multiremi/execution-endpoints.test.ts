import { runMigrations } from "@multiremi/store/migrations.js";
import { useEndpointEncryptionKey } from "../../helpers/endpoint-encryption.js";
import { afterEach, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";
import { executionGroupModelCatalog } from "@multiremi/api/helpers/agents.js";
import { createResponsibleTestIssue, resetMultiremiTestEnv } from "./helpers.js";

const key = "endpoint-test-secret";
const connection = { base_url: "http://127.0.0.1:8788/v1", protocols: ["openai-responses", "anthropic-messages"],
  auth_mode: "api_key", env_key: "", auth_header: "bearer" };
useEndpointEncryptionKey();
afterEach(resetMultiremiTestEnv);

pendingTurnBackendTests("shared gateway endpoints", (fixture, backend) => {
  it.each([true, false])("keeps frozen retries after a policy block and capability sweep (fallback: %s)", (fallback) => {
    const { store } = fixture();
    const endpoint = store.saveExecutionEndpoint("local", { name: "Frozen gateway", connection, api_key: key });
    const runtime = store.registerRuntime({ name: "Frozen Codex", provider: "codex", metadata: { execution_endpoints: 1, codex_profiles: 1 } });
    const input = { name: "Frozen group", provider: "codex", endpoint_id: endpoint.id, runtime_ids: [runtime.id] };
    const group = store.saveExecutionGroup("local", input);
    const ack = () => {
      const binding = store.getRuntimeExecutionBindings(runtime.id)[0]!;
      store.recordRuntimeExecutionBindingAcks(runtime.id, [{ ...binding, status: "ready", model_catalog: { status: "ready",
        models: ["primary", "fallback"].map(id => ({ id, label: id, provider: "codex", default: id === "primary" })) } }]);
    };
    ack();
    const agent = store.createAgent({ name: "Frozen agent", provider: "codex", executionGroupId: group.id, model: "primary",
      ...(fallback ? { fallbackModel: "fallback" } : {}) });
    const issue = createResponsibleTestIssue(store, { title: "Frozen retry", assigneeType: "agent", assigneeId: agent.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Keep frozen model" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    const frozen = store.getTask(task.id)!;
    expect(frozen.executionFingerprint).toBeTruthy();
    store.saveExecutionGroup("local", { ...input, model_policy: { blocked_models: ["primary"] } }, group.id);
    ack();
    store.failTask(task.id, { error: "Infrastructure timeout", failureReason: "timeout" });
    const retry = store.listTasks().find(candidate => candidate.parentTaskId === task.id)!;
    expect(retry).toMatchObject({ status: "queued", fallbackSwitched: false,
      executionFingerprint: frozen.executionFingerprint, executionModel: frozen.executionModel,
      executionConnection: frozen.executionConnection, codexProfile: frozen.codexProfile });
    const afterFiveMinutes = Date.parse(retry.createdAt) + 6 * 60_000;
    expect(store.refreshQueuedCapabilityWaitReasons(afterFiveMinutes).alerted).toBe(0);
    expect(store.getTask(retry.id)).toMatchObject({ status: "queued", waitReason: null, fallbackSwitched: false });
    expect(store.listTasks().filter(candidate => candidate.parentTaskId === retry.id)).toEqual([]);
    expect(store.claimTask(runtime.id)).toMatchObject({ id: retry.id, executionModel: frozen.executionModel,
      executionFingerprint: frozen.executionFingerprint, executionConnection: frozen.executionConnection,
      codexProfile: frozen.codexProfile, fallbackSwitched: false });
  });

  it("blocks exact IDs across catalog, API selection, enqueue and claim while preserving frozen work", async () => {
    const { store } = fixture();
    const endpoint = store.saveExecutionEndpoint("local", { name: "Policy gateway", connection, api_key: key });
    const runtime = store.registerRuntime({ name: "Policy Codex", provider: "codex", metadata: { execution_endpoints: 1, codex_profiles: 1 } });
    const input = { name: "Policy group", provider: "codex", endpoint_id: endpoint.id, runtime_ids: [runtime.id] };
    const group = store.saveExecutionGroup("local", input);
    const ack = () => {
      const binding = store.getRuntimeExecutionBindings(runtime.id)[0]!;
      store.recordRuntimeExecutionBindingAcks(runtime.id, [{ ...binding, status: "ready", model_catalog: { status: "ready",
        models: ["blocked", "allowed", "Blocked"].map(id => ({ id, label: id, provider: "codex", default: id === "blocked" })) } }]);
    };
    ack();
    const agent = store.createAgent({ name: "Saved", provider: "codex", executionGroupId: group.id, model: "blocked" });
    const claimedTask = store.createTask({ agentId: agent.id, prompt: "Already claimed" });
    expect(store.claimTask(runtime.id)?.id).toBe(claimedTask.id);
    const queuedTask = store.createTask({ agentId: agent.id, prompt: "Not claimed" });
    store.saveExecutionGroup("local", { ...input, model_policy: { blocked_models: ["blocked", "future"] } }, group.id);
    ack();
    const catalog = executionGroupModelCatalog(store, "local", group.id, "local")[0]!;
    expect(catalog.models.map(model => model.id)).toEqual(["allowed", "Blocked"]);
    expect(catalog.models.find(model => model.default)?.id).toBe("allowed");
    expect(catalog.blocked_models).toEqual(["blocked", "future"]);
    expect(store.getAgent(agent.id)?.model).toBe("blocked");
    expect(() => store.createTask({ agentId: agent.id, prompt: "New" })).toThrow("model blocked by policy");
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(store.getTask(queuedTask.id)?.status).toBe("queued");
    store.refreshQueuedCapabilityWaitReasons(Date.now() + 180_000);
    expect(store.getTask(queuedTask.id)?.waitReason).toContain("model_blocked_by_policy");
    expect(store.getTask(claimedTask.id)?.executionModel).toBe("blocked");
    expect(store.getTask(claimedTask.id)?.codexProfile?.model).toBe("blocked");
    const app = createMultiremiApp({ store });
    const invalidDefault = await app.request(`/api/execution-groups/${group.id}`, { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, model_policy: { model: "blocked", blocked_models: ["blocked"] } }) });
    expect(invalidDefault.status).toBe(400);
    expect(await invalidDefault.json()).toMatchObject({ code: "model_blocked_by_policy", field: "model_policy.model" });
    const saved = await (await app.request(`/api/agents/${agent.id}`)).json();
    expect(saved.model_policy_reason).toBe("model_blocked_by_policy");
    const denied = await app.request("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Cannot select", provider: "codex", execution_group_id: group.id, model: "blocked" }) });
    expect(denied.status).toBe(400);
    expect(await denied.json()).toMatchObject({ code: "model_blocked_by_policy" });
    const frozen = store.getTask(claimedTask.id)!;
    store.cancelTask(claimedTask.id);
    const retry = store.createTask({ agentId: agent.id, prompt: "Retry frozen execution", runtimeId: runtime.id,
      executionModel: frozen.executionModel, executionConnection: frozen.executionConnection,
      codexProfile: frozen.codexProfile, executionFingerprint: frozen.executionFingerprint, pluginSnapshot: frozen.pluginSnapshot });
    const retryClaim = store.claimTask(runtime.id);
    expect(retryClaim?.id).toBe(retry.id);
    expect(retryClaim?.executionModel).toBe("blocked");
    store.cancelTask(retry.id);
    const auto = store.createAgent({ name: "Automatic", provider: "codex", executionGroupId: group.id });
    const next = store.createTask({ agentId: auto.id, prompt: "Automatic default" });
    const claim = store.claimTask(runtime.id);
    expect(claim?.id).toBe(next.id);
    expect(claim?.executionModel).toBe("allowed");
    expect(claim?.codexProfile?.model).toBe("allowed");
    store.saveExecutionGroup("local", { ...input, model_policy: { blocked_models: [] } }, group.id);
    ack();
    store.refreshQueuedCapabilityWaitReasons(Date.now() + 180_000);
    expect(store.getTask(queuedTask.id)?.waitReason).toBeNull();
  });

  it("retains blocks through legacy profile updates and rejects a blocked legacy default atomically", () => {
    const { store } = fixture();
    const profile = store.saveExecutionProfile("local", { name: "Legacy", provider: "codex",
      profile: { name: "legacy", base_url: connection.base_url, auth_mode: "api_key", env_key: "", model: "keep" }, api_key: key });
    const endpoint = store.saveExecutionEndpoint("local", { name: "Converted", connection, api_key: key }, profile.id);
    const group = store.saveExecutionGroup("local", { name: "Blocked group", provider: "codex", endpoint_id: endpoint.id,
      runtime_ids: [], model_policy: { model: "keep", blocked_models: ["hide"] } });
    store.saveExecutionProfile("local", { name: "Edited", provider: "codex", profile: { ...profile.profile, model: "keep" } }, profile.id);
    expect(store.getExecutionGroup(group.id)?.modelPolicy.blocked_models).toEqual(["hide"]);
    expect(() => store.saveExecutionProfile("local", { name: "Bad", provider: "codex", profile: { ...profile.profile, model: "hide" } }, profile.id))
      .toThrow("default model is blocked");
    expect(store.getExecutionGroup(group.id)?.modelPolicy.model).toBe("keep");
  });

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

  it("caches ID-only catalog reads for a migrated relay and isolates previews and stale revisions", async () => {
    const { store, db } = fixture();
    let model = "saved-model";
    let beforeResponse: (() => void) | undefined;
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      if (new URL(request.url).pathname !== "/proxy/v1/models") return new Response(null, { status: 404 });
      beforeResponse?.();
      return Response.json({ data: [{ id: model }] });
    } });
    try {
      const baseUrl = `${upstream.url.origin}/proxy/v1/`;
      db.run(`INSERT INTO multiremi_relay_config(workspace_id,engine,fragment,auth_token,revision,updated_at)
        VALUES('local','claude',?,?,1,?)`, [JSON.stringify({ env: { ANTHROPIC_BASE_URL: baseUrl } }), key, new Date().toISOString()]);
      db.run("DELETE FROM multiremi_schema_migrations WHERE id='execution_endpoints_v1'");
      runMigrations(db, { historicalMaintenance: true });
      const endpoint = store.getExecutionEndpoint(store.getSystemModelEndpoints("local")["anthropic-messages"]!, "local")!;
      expect(endpoint.connection.base_url).toBe(baseUrl);
      const app = createMultiremiApp({ store });
      const inspect = async (overrides: Record<string, unknown> = {}) => {
        const response = await app.request("/api/execution-endpoints/inspect", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspace_id: "local", endpoint_id: endpoint.id, operation: "models", protocol: "anthropic-messages", ...overrides }) });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.inspection.results).toMatchObject([{ state: "ok", models: [{ id: model }] }]);
        return body.persisted;
      };
      const catalogs = async () => {
        const response = await app.request(`/api/execution-endpoints/${endpoint.id}/catalog?workspace_id=local`);
        expect(response.status).toBe(200);
        return (await response.json()).catalogs;
      };
      expect(await inspect()).toBe(true);
      expect(await catalogs()).toMatchObject([{ revision: endpoint.revision, models: [{ id: model }] }]);
      model = "editor-refresh";
      expect(await inspect({ protocol: undefined })).toBe(true);
      expect(await catalogs()).toMatchObject([{ protocol: "anthropic-messages", models: [{ id: model }] }]);
      model = "saved-null";
      expect(await inspect({ connection: null })).toBe(true);
      const saved = await catalogs();
      expect(saved).toMatchObject([{ models: [{ id: model }] }]);
      model = "preview";
      expect(await inspect({ connection: endpoint.connection })).toBe(false);
      expect(await inspect({ api_key: "preview-key" })).toBe(false);
      expect(await catalogs()).toEqual(saved);
      beforeResponse = () => { store.saveExecutionEndpoint("local", { name: "Updated", connection: endpoint.connection }, endpoint.id); };
      await inspect();
      const updated = store.getExecutionEndpoint(endpoint.id, "local")!;
      expect(updated.revision).toBeGreaterThan(endpoint.revision);
      expect(await catalogs()).toEqual(saved);
      beforeResponse = undefined;
      expect(await inspect({ connection: updated.connection })).toBe(false);
      expect(await catalogs()).toEqual(saved);
    } finally {
      upstream.stop(true);
    }
  });

  it("refreshes and reads one saved protocol catalog with workspace-scoped human credentials", async () => {
    const { store } = fixture();
    const endpoint = store.saveExecutionEndpoint("local", { name: "System catalog", connection: { ...connection,
      options: { fetch_models: false, manual_models: [{ id: "summary" }] } }, api_key: key });
    const app = createMultiremiApp({ store, authToken: "master" });
    const owner = await store.createAccessToken({ workspaceId: "local", type: "pat", name: "Owner", userId: "local" });
    const daemon = await store.createAccessToken({ workspaceId: "local", type: "daemon", name: "Daemon" });
    const inspect = (token: string, protocol: string) => app.request("/api/execution-endpoints/inspect", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: "local", endpoint_id: endpoint.id, operation: "models", protocol }),
    });
    const catalog = (token: string, workspace: string) => app.request(`/api/execution-endpoints/${endpoint.id}/catalog?workspace_id=${workspace}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect((await inspect(daemon.token, "anthropic-messages")).status).toBe(403);
    expect((await catalog(daemon.token, "local")).status).toBe(403);
    expect((await inspect(owner.token, "openai-chat-completions")).status).toBe(400);
    const refresh = await inspect(owner.token, "anthropic-messages");
    expect(refresh.status).toBe(200);
    const inspection = await refresh.json();
    expect(inspection.persisted).toBe(true);
    expect(inspection.inspection.results).toMatchObject([{ protocol: "anthropic-messages", state: "manual" }]);
    expect(JSON.stringify(inspection)).not.toContain(key);
    const snapshot = await catalog(owner.token, "local");
    expect(snapshot.status).toBe(200);
    expect((await snapshot.json()).catalogs).toMatchObject([{ protocol: "anthropic-messages", models: [{ id: "summary" }] }]);
    const other = store.createWorkspace({ name: "Other" });
    const otherOwner = await store.createAccessToken({ workspaceId: other.id, type: "pat", name: "Other owner", userId: "local" });
    expect((await catalog(otherOwner.token, other.id)).status).toBe(404);
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
    runMigrations(f.db, { historicalMaintenance: true });
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
