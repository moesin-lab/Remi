import { expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import { UNIFIED_MODEL_MIGRATION } from "@multiremi/store/unified-model-schema.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";

pendingTurnBackendTests("execution binding catalog startup upgrade", (fixture, backend) => {
  it("upgrades an already unified database without losing old bindings, accepts the current catalog and reopens idempotently", () => {
    const f = fixture();
    const runtime = f.store.registerRuntime({ name: "Existing machine", provider: "codex", metadata: { codex_profiles: 1 } });
    const profile = f.store.saveExecutionProfile("local", { name: "Existing connection", provider: "codex",
      profile: { name: "existing", base_url: "http://127.0.0.1:8788/v1", model: "legacy-model",
        auth_mode: "env", env_key: "REMI_CODEX_MIGRATION_FIXTURE" } });
    const group = f.store.saveExecutionGroup("local", { name: "Existing group", provider: "codex", profile_id: profile.id,
      runtime_ids: [runtime.id] });
    const old = f.store.getRuntimeExecutionBindings(runtime.id)[0]!;
    f.store.recordRuntimeExecutionBindingAcks(runtime.id, [{ ...old, status: "ready" }]);
    const updated = f.store.saveExecutionProfile("local", { name: profile.name, provider: "codex",
      profile: { ...profile.profile, model: "" } }, profile.id);
    const before = f.db.query("SELECT profile_id,profile_revision,generation,status FROM multiremi_execution_binding_states").get();
    expect(updated.revision).toBe(2);
    expect(f.db.query("SELECT id FROM multiremi_schema_migrations WHERE id=?").get(UNIFIED_MODEL_MIGRATION)).not.toBeNull();
    f.db.exec("ALTER TABLE multiremi_execution_binding_states DROP COLUMN model_catalog");
    expect(f.db.query("PRAGMA table_info(multiremi_execution_binding_states)").all().some(column => column.name === "model_catalog")).toBe(false);

    const reopen = () => {
      if (backend === "PostgreSQL") f.reopen();
      else f.store = new MultiremiStore(f.db);
    };
    reopen();
    expect(f.db.query("PRAGMA table_info(multiremi_execution_binding_states)").all().some(column => column.name === "model_catalog")).toBe(true);
    expect(f.db.query("SELECT profile_id,profile_revision,generation,status FROM multiremi_execution_binding_states").get()).toEqual(before);
    expect(f.store.getExecutionGroup(group.id)?.runtimeIds).toEqual([runtime.id]);
    expect(f.store.getExecutionProfile(profile.id, "local")?.revision).toBe(2);
    const current = f.store.getRuntimeExecutionBindings(runtime.id)[0]!;
    const model_catalog = { status: "ready" as const, models: [{ id: "discovered-model", label: "Discovered",
      provider: "codex", default: true, thinking: { status: "supported" as const, supportedLevels: [{ value: "medium", label: "Medium" }] } }] };
    f.store.recordRuntimeExecutionBindingAcks(runtime.id, [{ ...old, status: "ready", model_catalog }]);
    expect(f.store.getRuntimeBindingModelCatalog(group.id, runtime.id)).toBeNull();
    f.store.recordRuntimeExecutionBindingAcks(runtime.id, [{ ...current, status: "ready", model_catalog }]);
    expect(f.store.getRuntimeBindingModelCatalog(group.id, runtime.id)).toEqual(model_catalog);
    const accepted = f.db.query("SELECT profile_id,profile_revision,generation,status,model_catalog FROM multiremi_execution_binding_states").get();
    reopen();
    reopen();
    expect(f.db.query("SELECT profile_id,profile_revision,generation,status,model_catalog FROM multiremi_execution_binding_states").get()).toEqual(accepted);
    expect(f.store.getRuntimeBindingModelCatalog(group.id, runtime.id)).toEqual(model_catalog);
    const agent = f.store.createAgent({ name: "Discovered automatic model", provider: "codex", executionGroupId: group.id });
    const task = f.store.createTask({ agentId: agent.id, prompt: "Freeze the discovered model after upgrade" });
    const claimed = f.store.claimTask(runtime.id)!;
    expect(claimed.id).toBe(task.id);
    expect(claimed.executionModel).toBe("discovered-model");
    expect(claimed.codexProfile?.model).toBe("discovered-model");
  }, 30_000);
});
