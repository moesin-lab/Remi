import { afterEach, describe, expect, it } from "bun:test";
import { executionGroupModelCatalog } from "@multiremi/api/helpers/agents.js";
import { parseRuntimeCodexProfile } from "@multiremi/contracts/codex-profile.js";
import type { MultiremiRuntimeModel } from "@multiremi/contracts/types.js";
import { taskExecutionTarget } from "@multiremi/contracts/task-execution.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function model(id: string, defaultModel: boolean, levels = ["medium", "high"]): MultiremiRuntimeModel {
  return { id, label: id, provider: "codex", default: defaultModel,
    thinking: { status: levels.length ? "supported" : "unsupported",
      supportedLevels: levels.map(value => ({ value, label: value })) } };
}

function setup() {
  const store = createLocalStore();
  const runtimes = ["a", "b"].map(id => store.registerRuntime({ id: `rt_${id}`, name: id, provider: "codex",
    workspaceId: "local", metadata: { codex_profiles: 1 } }));
  const profile = store.saveExecutionProfile("local", { name: "Discovered", provider: "codex",
    profile: { name: "discovered", base_url: "http://127.0.0.1:8788/v1", auth_mode: "env", env_key: "REMI_CODEX_TEST_KEY" } });
  const group = store.saveExecutionGroup("local", { name: "Discovery", provider: "codex", profile_id: profile.id,
    runtime_ids: runtimes.map(runtime => runtime.id) });
  const agent = store.createAgent({ name: "Auto", provider: "codex", executionGroupId: group.id });
  const report = (index: number, models: MultiremiRuntimeModel[], groupId = group.id) => {
    const binding = store.getRuntimeExecutionBindings(runtimes[index]!.id).find(binding => binding.groupId === groupId)!;
    store.recordRuntimeExecutionBindingAcks(runtimes[index]!.id, [{ ...binding, status: "ready",
      model_catalog: { status: "ready", models } }]);
  };
  return { store, runtimes, profile, group, agent, report };
}

describe("capability-group model discovery", () => {
  it("accepts a central connection without a model but keeps legacy Runtime profiles strict", () => {
    const { profile } = setup();
    expect(profile.profile.model).toBe("");
    expect(() => parseRuntimeCodexProfile(profile.profile)).toThrow("model is required");
  });

  it("waits for every member then freezes the common model rather than the claim machine's default", () => {
    const { store, runtimes, group, agent, report } = setup();
    const task = store.createTask({ agentId: agent.id, prompt: "Auto select" });
    expect(store.claimTask(runtimes[0]!.id)).toBeNull();
    report(0, [model("x", true, ["low"]), model("y", false)]);
    expect(store.claimTask(runtimes[0]!.id)).toBeNull();
    report(1, [model("y", true, ["high"]), model("z", false)]);
    const catalog = executionGroupModelCatalog(store, "local", group.id, "local")[0]!;
    expect(catalog.model_catalog_status).toBe("ready");
    expect(catalog.models.map(model => model.id)).toEqual(["y"]);
    expect(catalog.models[0]!.thinking?.supported_levels.map(level => level.value)).toEqual(["high"]);
    expect(catalog.models[0]!.default).toBe(true);
    expect(catalog.default_thinking?.supported_levels.map(level => level.value)).toEqual(["high"]);
    const claimed = store.claimTask(runtimes[0]!.id)!;
    expect(claimed.id).toBe(task.id);
    expect(claimed.executionModel).toBe("y");
    expect(claimed.codexProfile?.model).toBe("y");
    expect(taskExecutionTarget(claimed.agent, claimed).model).toBe("y");
    report(0, [model("replacement", true)]);
    report(1, [model("replacement", true)]);
    expect(store.getTask(task.id)?.executionModel).toBe("y");
    expect(store.getTask(task.id)?.codexProfile?.model).toBe("y");
  });

  it("does not reuse native capabilities, another group's catalog or an old profile revision", () => {
    const { store, runtimes, profile, group, agent, report } = setup();
    store.updateRuntimeModels(runtimes[0]!.id, [model("native", true, ["ultra"])]);
    const other = store.saveExecutionGroup("local", { name: "Same profile, separate binding", provider: "codex",
      profile_id: profile.id, runtime_ids: [runtimes[0]!.id] });
    report(0, [model("separate", true)], other.id);
    expect(executionGroupModelCatalog(store, "local", group.id, "local")[0]!.models).toEqual([]);
    report(0, [model("current", true)]);
    report(1, [model("current", true)]);
    const old = store.getRuntimeExecutionBindings(runtimes[0]!.id).find(binding => binding.groupId === group.id)!;
    const next = store.saveExecutionProfile("local", { name: profile.name, provider: "codex",
      profile: { ...profile.profile, base_url: "http://127.0.0.1:8789/v1" } }, profile.id);
    expect(next.revision).toBe(2);
    store.recordRuntimeExecutionBindingAcks(runtimes[0]!.id, [{ ...old, status: "ready",
      model_catalog: { status: "ready", models: [model("stale", true)] } }]);
    expect(store.getRuntimeBindingModelCatalog(group.id, runtimes[0]!.id)).toBeNull();
    expect(executionGroupModelCatalog(store, "local", group.id, "local")[0]!.models).toEqual([]);
    store.createTask({ agentId: agent.id, prompt: "Do not use stale discovery" });
    expect(store.claimTask(runtimes[0]!.id)).toBeNull();
    expect(store.listRuntimeModels(runtimes[0]!.id).map(model => model.id)).toEqual(["native"]);
  });

  it("preserves current discovery on legacy acks, broadcasts only changes and rejects malformed capabilities", () => {
    const { store, runtimes, group, report } = setup();
    const events: string[] = [];
    store.onWorkspaceEvent(event => { if (event.type === "daemon:models_updated") events.push(event.type); });
    const entry = model("valid", true);
    report(0, [entry]);
    report(0, [entry]);
    expect(events).toHaveLength(1);
    const binding = store.getRuntimeExecutionBindings(runtimes[0]!.id).find(binding => binding.groupId === group.id)!;
    store.recordRuntimeExecutionBindingAcks(runtimes[0]!.id, [{ ...binding, status: "ready" }]);
    expect(store.getRuntimeBindingModelCatalog(group.id, runtimes[0]!.id)?.models[0]?.id).toBe("valid");
    store.recordRuntimeExecutionBindingAcks(runtimes[0]!.id, [{ ...binding, status: "ready",
      model_catalog: { status: "ready", models: [{ ...entry, thinking: { status: "invalid", error: "secret-provider-response", supportedLevels: [] } }] } }]);
    expect(store.getRuntimeBindingModelCatalog(group.id, runtimes[0]!.id)).toEqual({ status: "error", models: [] });
    expect(JSON.stringify(db!.query("SELECT model_catalog FROM multiremi_execution_binding_states").all())).not.toContain("secret-provider-response");
    expect(events).toHaveLength(2);
    report(0, [entry]);
    expect(store.getRuntimeBindingModelCatalog(group.id, runtimes[0]!.id)?.status).toBe("ready");
  });

  it("keeps explicit manual models working when a supplier has no discovery endpoint", () => {
    const { store, runtimes, profile, group, agent } = setup();
    store.saveExecutionProfile("local", { name: profile.name, provider: "codex",
      profile: { ...profile.profile, model: "manual", models: ["manual", "alias"] } }, profile.id);
    for (const runtime of runtimes) store.recordRuntimeExecutionBindingAcks(runtime.id,
      [{ ...store.getRuntimeExecutionBindings(runtime.id).find(binding => binding.groupId === group.id), status: "ready",
        model_catalog: { status: "error", models: [] } }]);
    store.updateAgent(agent.id, { model: "alias" });
    const task = store.createTask({ agentId: agent.id, prompt: "Manual alias" });
    expect(store.claimTask(runtimes[0]!.id)?.codexProfile?.model).toBe("alias");
    expect(store.getTask(task.id)?.executionModel).toBe("alias");
  });

  it("keeps a group pending for an offline undiscovered member and recovers when it reports", () => {
    const { store, runtimes, group, report } = setup();
    db!.run("UPDATE multiremi_runtimes SET status='offline' WHERE id=?", [runtimes[1]!.id]);
    report(0, [model("shared", true)]);
    expect(executionGroupModelCatalog(store, "local", group.id, "local")[0]).toMatchObject({
      model_catalog_status: "unknown", models: [], online_runtime_count: 1,
    });
    store.heartbeatRuntime(runtimes[1]!.id, { claimPending: false });
    report(1, [model("shared", true)]);
    expect(executionGroupModelCatalog(store, "local", group.id, "local")[0]).toMatchObject({
      model_catalog_status: "ready", online_runtime_count: 2,
    });
  });

  it("keeps a frozen automatic task eligible while a newer connection is still undiscovered", () => {
    const { store, runtimes, profile, agent, report } = setup();
    report(0, [model("frozen", true)]);
    report(1, [model("frozen", true)]);
    const original = store.createTask({ agentId: agent.id, prompt: "Original automatic target", maxAttempts: 1 });
    const claimed = store.claimTask(runtimes[0]!.id)!;
    expect(claimed.id).toBe(original.id);
    store.startTask(original.id);
    store.failTask(original.id, { error: "offline", failureReason: "runtime_offline" });
    store.saveExecutionProfile("local", { name: profile.name, provider: "codex",
      profile: { ...profile.profile, base_url: "http://127.0.0.1:8789/v1" } }, profile.id);
    const fresh = store.createTask({ agentId: agent.id, prompt: "Wait for the new supplier", priority: 10 });
    const retry = store.createTask({ agentId: agent.id, prompt: "Keep the frozen target", executionModel: claimed.executionModel,
      executionFingerprint: claimed.executionFingerprint, codexProfile: claimed.codexProfile, provider: "codex" });
    expect(store.claimTask(runtimes[0]!.id)?.id).toBe(retry.id);
    expect(store.getTask(retry.id)?.codexProfile?.model).toBe("frozen");
    expect(store.getTask(fresh.id)?.status).toBe("queued");
  });

  it("matches automatic reasoning against the whole group's selected-model intersection", () => {
    const { store, runtimes, agent, report } = setup();
    report(0, [model("x", true), model("y", false)]);
    report(1, [model("y", true, ["high"]), model("z", false)]);
    store.updateAgent(agent.id, { thinkingLevel: "medium" });
    const task = store.createTask({ agentId: agent.id, prompt: "Require matching group reasoning" });
    expect(store.claimTask(runtimes[0]!.id)).toBeNull();
    store.updateAgent(agent.id, { thinkingLevel: "high" });
    const claimed = store.claimTask(runtimes[0]!.id)!;
    expect(claimed.id).toBe(task.id);
    expect(taskExecutionTarget(claimed.agent, claimed)).toEqual({ model: "y", thinkingLevel: "high" });
  });

  it("filters automatic allowlists against discovery instead of declaring unreported aliases", () => {
    const { store, runtimes, profile, group, agent, report } = setup();
    store.saveExecutionProfile("local", { name: profile.name, provider: "codex",
      profile: { ...profile.profile, models: ["a", "ghost"] } }, profile.id);
    expect(executionGroupModelCatalog(store, "local", group.id, "local")[0]!.models).toEqual([]);
    report(0, [model("a", true), model("outside-allowlist", false)]);
    report(1, [model("a", true)]);
    expect(executionGroupModelCatalog(store, "local", group.id, "local")[0]!.models.map(model => model.id)).toEqual(["a"]);
    const binding = store.getRuntimeExecutionBindings(runtimes[0]!.id).find(binding => binding.groupId === group.id)!;
    store.recordRuntimeExecutionBindingAcks(runtimes[0]!.id, [{ ...binding, status: "ready", model_catalog: { status: "error", models: [] } }]);
    expect(executionGroupModelCatalog(store, "local", group.id, "local")[0]).toMatchObject({ model_catalog_status: "error", models: [] });
    const task = store.createTask({ agentId: agent.id, prompt: "Wait for actual discovery" });
    expect(store.claimTask(runtimes[0]!.id)).toBeNull();
    report(0, [model("a", true)]);
    expect(store.claimTask(runtimes[0]!.id)?.id).toBe(task.id);
  });

  it("does not turn a resolved automatic default into permission for a removed allowlist alias", () => {
    const { store, runtimes, profile, group, agent, report } = setup();
    store.saveExecutionProfile("local", { name: profile.name, provider: "codex",
      profile: { ...profile.profile, models: ["a", "ghost"] } }, profile.id);
    report(0, [model("a", true), model("ghost", false)]);
    report(1, [model("a", true), model("ghost", false)]);
    store.updateAgent(agent.id, { model: "ghost" });
    const task = store.createTask({ agentId: agent.id, prompt: "Require the formerly discovered alias" });
    report(0, [model("a", true)]);
    report(1, [model("a", true)]);
    expect(executionGroupModelCatalog(store, "local", group.id, "local")[0]!.models.map(model => model.id)).toEqual(["a"]);
    expect(store.claimTask(runtimes[0]!.id)).toBeNull();
    expect(store.getTask(task.id)?.status).toBe("queued");
  });
});
