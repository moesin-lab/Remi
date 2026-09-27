import { afterEach, describe, expect, it } from "bun:test";
import { executionGroupModelCatalog } from "@multiremi/api/helpers/agents.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function group(store: MultiremiStore, id: string, runtimeIds: string[], workspace = "local", provider = "codex") {
  return store.saveExecutionGroup(workspace, { name: id, provider, profile_id: null, runtime_ids: runtimeIds }, id);
}

/** An existing legacy group retains dispatch compatibility during migration. */
function legacyGroup(store: MultiremiStore, id: string, runtimeIds: string[]) {
  const result = group(store, id, runtimeIds);
  db!.run("UPDATE multiremi_execution_groups SET managed = 0 WHERE id = ?", [id]);
  return result;
}

describe("Execution groups", () => {
  it("does not turn machine discovery into capability configuration", () => {
    const store = createStore();
    for (const provider of ["codex", "claude", "antigravity", "any"]) {
      const runtime = store.registerRuntime({ name: provider, provider, daemonId: "machine" });
      expect(runtime.executionGroupIds).toEqual([]);
    }
    expect(store.listExecutionGroups("local")).toEqual([]);
  });

  it("keeps explicit membership across registration and display-name changes", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ name: "Laptop", provider: "codex", daemonId: "machine" });
    group(store, "shared", [runtime.id]);
    store.updateRuntime(runtime.id, { name: "Renamed" });
    store.registerRuntime({ id: runtime.id, name: "Restart", provider: "codex", daemonId: "machine" });
    const reopened = new MultiremiStore(db!);
    expect(reopened.getExecutionGroup("shared")?.runtimeIds).toEqual([runtime.id]);
    const sibling = reopened.registerRuntime({ name: "Sibling", provider: "codex", daemonId: "machine" });
    expect(sibling.executionGroupIds).toEqual([]);
  });

  it("clears prior binding readiness when the daemon re-registers", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ name: "Machine", provider: "codex", daemonId: "machine" });
    group(store, "shared", [runtime.id]);
    db!.run(`INSERT INTO multiremi_execution_binding_states
      (workspace_id, group_id, runtime_id, profile_id, profile_revision, status, updated_at)
      VALUES ('local', 'shared', ?, NULL, NULL, 'ready', ?)`, [runtime.id, new Date().toISOString()]);
    store.registerRuntime({ id: runtime.id, name: "Restart", provider: "codex", daemonId: "machine" });
    expect(db!.query("SELECT status FROM multiremi_execution_binding_states WHERE runtime_id = ?").get(runtime.id)).toBeNull();
    expect(store.getExecutionGroup("shared")?.runtimeIds).toEqual([runtime.id]);
  });

  it("supports multiple groups on the same Runtime without weakening owner or workspace checks", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ name: "Private", provider: "codex", ownerId: "alice" });
    group(store, "one", [runtime.id]);
    group(store, "two", [runtime.id]);
    for (const id of ["one", "two"]) {
      const agent = store.createAgent({ name: id, provider: "codex", ownerId: "alice", executionGroupId: id });
      expect(store.runtimeCanRunAgent(runtime, agent)).toBe(true);
      expect(store.runtimeCanRunAgent(runtime, { ...agent, ownerId: "bob" })).toBe(false);
      expect(store.runtimeCanRunAgent(runtime, { ...agent, workspaceId: "foreign" })).toBe(false);
    }
    const direct = store.createAgent({ name: "Direct", provider: "codex", ownerId: "alice", runtimeId: runtime.id });
    expect(direct.executionGroupId).toBeNull();
  });

  it("rejects incompatible machines and scopes identically named groups by workspace", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ name: "Codex", provider: "codex" });
    const claude = store.registerRuntime({ name: "Claude", provider: "claude" });
    expect(() => group(store, "shared", [claude.id])).toThrow("incompatible");
    group(store, "shared", [runtime.id]);
    store.createWorkspace({ id: "team", name: "Team", slug: "team" });
    const foreign = store.registerRuntime({ name: "Foreign", provider: "claude", workspaceId: "team" });
    expect(() => group(store, "foreign", [foreign.id])).toThrow("incompatible");
    group(store, "shared", [foreign.id], "team", "claude");
    expect(store.getExecutionGroup("shared")?.runtimeIds).toEqual([runtime.id]);
    expect(store.getExecutionGroup("shared", "team")?.runtimeIds).toEqual([foreign.id]);
  });

  it("uses each group's fixed profile independently of the machine's old profile", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ name: "Codex", provider: "codex", metadata: { codex_profiles: 1 } });
    store.setRuntimeCodexProfile(runtime.id, { name: "legacy", base_url: "https://legacy.example", model: "legacy", env_key: "REMI_CODEX_KEY" });
    for (const model of ["first", "second"]) {
      const profile = store.saveExecutionProfile("local", { name: model, provider: "codex", profile: { name: model, base_url: `https://${model}.example`, model, env_key: "REMI_CODEX_KEY" } });
      store.saveExecutionGroup("local", { name: model, provider: "codex", profile_id: profile.id, runtime_ids: [runtime.id] }, model);
      const agent = store.createAgent({ name: model, provider: "codex", executionGroupId: model, model });
      expect(store.runtimeCanRunAgent(runtime, agent)).toBe(true);
      expect(store.runtimeCanRunAgent(runtime, { ...agent, model: "legacy" })).toBe(false);
    }
    group(store, "default", [runtime.id]);
    const agent = store.createAgent({ name: "Default", provider: "codex", executionGroupId: "default", model: "legacy" });
    expect(store.runtimeCanRunAgent(runtime, agent)).toBe(false);
  });

  it("rechecks legacy model evidence per member and does not block another agent", () => {
    const store = createStore();
    const first = store.registerRuntime({ name: "A", provider: "codex", models: [{ id: "a", label: "A", provider: "codex", default: true }] });
    const second = store.registerRuntime({ name: "B", provider: "codex", models: [{ id: "b", label: "B", provider: "codex", default: true }] });
    legacyGroup(store, "legacy", [first.id, second.id]);
    const a = store.createAgent({ name: "A", provider: "codex", executionGroupId: "legacy", model: "a" });
    const b = store.createAgent({ name: "B", provider: "codex", executionGroupId: "legacy", model: "b" });
    const taskA = store.createTask({ agentId: a.id, prompt: "A" });
    const taskB = store.createTask({ agentId: b.id, prompt: "B" });
    expect(store.claimTask(second.id)?.id).toBe(taskB.id);
    expect(store.claimTask(first.id)?.id).toBe(taskA.id);
    store.cancelTask(taskA.id);
    store.updateRuntime(first.id, { models: [] });
    const queued = store.createTask({ agentId: a.id, prompt: "No evidence" });
    expect(store.claimTask(first.id)).toBeNull();
    expect(store.getTask(queued.id)?.status).toBe("queued");
  });

  it("removing membership leaves queued work available to remaining legacy members", () => {
    const store = createStore();
    const first = store.registerRuntime({ name: "A", provider: "codex" });
    const second = store.registerRuntime({ name: "B", provider: "codex" });
    legacyGroup(store, "original", [first.id, second.id]);
    const agent = store.createAgent({ name: "Worker", provider: "codex", executionGroupId: "original" });
    const task = store.createTask({ agentId: agent.id, prompt: "Group only" });
    legacyGroup(store, "original", [second.id]);
    expect(store.claimTask(first.id)).toBeNull();
    expect(store.claimTask(second.id)?.id).toBe(task.id);
  });

  it("reclaims a lost dispatch only within its group after a member leaves", () => {
    const store = createStore();
    const first = store.registerRuntime({ name: "A", provider: "codex" });
    const second = store.registerRuntime({ name: "B", provider: "codex" });
    legacyGroup(store, "original", [first.id, second.id]);
    const agent = store.createAgent({ name: "Worker", provider: "codex", executionGroupId: "original" });
    const task = store.createTask({ agentId: agent.id, prompt: "Lost claim" });
    expect(store.claimTask(first.id)?.id).toBe(task.id);
    legacyGroup(store, "original", [second.id]);
    db!.run("UPDATE multiremi_tasks SET dispatched_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", task.id]);
    expect(store.claimTask(first.id)).toBeNull();
    expect(store.getTask(task.id)?.status).toBe("queued");
    expect(store.claimTask(second.id)?.id).toBe(task.id);
  });

  it("cancels a frozen dispatch when its agent switches groups", () => {
    const store = createStore();
    const first = store.registerRuntime({ name: "A", provider: "codex" });
    const second = store.registerRuntime({ name: "B", provider: "codex" });
    legacyGroup(store, "original", [first.id]);
    legacyGroup(store, "target", [second.id]);
    const agent = store.createAgent({ name: "Worker", provider: "codex", executionGroupId: "original" });
    const task = store.createTask({ agentId: agent.id, prompt: "Not started" });
    expect(store.claimTask(first.id)?.id).toBe(task.id);
    store.updateAgent(agent.id, { executionGroupId: "target" });
    expect(store.getTask(task.id)?.status).toBe("cancelled");
    expect(store.claimTask(first.id)).toBeNull();
    expect(store.claimTask(second.id)).toBeNull();
  });

  for (const authMode of ["env", "api_key"] as const) {
    it(`preserves proven ${authMode} thinking capability through profile migration`, () => {
      const previousKey = process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
      process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
      try {
        const store = createStore();
        const runtime = store.registerRuntime({ name: "Legacy", provider: "codex", metadata: { codex_profiles: 1 } });
        legacyGroup(store, "old", [runtime.id]);
        store.setRuntimeCodexProfile(runtime.id, { name: "legacy", base_url: "https://legacy.example/v1", model: "custom", auth_mode: authMode, env_key: "REMI_CODEX_KEY" }, authMode === "api_key" ? "old-key" : undefined);
        store.updateRuntimeModels(runtime.id, [{ id: "custom", label: "Custom", provider: "codex", default: true, thinking: { supportedLevels: [{ value: "high", label: "High" }] } }], store.getRuntimeCodexProfile(runtime.id));
        const agent = store.createAgent({ name: "Reasoner", provider: "codex", executionGroupId: "old", model: "custom", thinkingLevel: "high" });
        db!.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", ["central_execution_profiles_legacy_v1"]);
        const migrated = new MultiremiStore(db!);
        const profile = migrated.getGroupExecutionProfile("old", "local")!;
        expect(migrated.getExecutionGroup("old")?.managed).toBe(true);
        const models = executionGroupModelCatalog(migrated, "local", "old", "local")[0]!.models;
        expect(models[0]?.thinking?.supported_levels.map(level => level.value)).toEqual(["high"]);
        migrated.recordRuntimeExecutionBindingAcks(runtime.id, migrated.getRuntimeExecutionBindings(runtime.id).map(binding => ({ ...binding, status: "ready" })));
        const task = migrated.createTask({ agentId: agent.id, prompt: "Still supports high" });
        expect(migrated.claimTask(runtime.id)?.id).toBe(task.id);
        migrated.cancelTask(task.id);
        migrated.saveExecutionProfile("local", { name: "Renamed", provider: "codex", profile: profile.profile }, profile.id);
        expect(executionGroupModelCatalog(migrated, "local", "old", "local")[0]?.models[0]?.thinking).toBeDefined();
        migrated.saveExecutionProfile("local", { name: "Changed", provider: "codex", profile: { ...profile.profile, base_url: "https://different.example/v1" } }, profile.id);
        expect(executionGroupModelCatalog(migrated, "local", "old", "local")[0]?.models[0]?.thinking).toBeUndefined();
        if (authMode === "api_key") {
          migrated.saveExecutionProfile("local", { name: "Rotated", provider: "codex", profile: profile.profile, api_key: "new-key" }, profile.id);
          expect(executionGroupModelCatalog(migrated, "local", "old", "local")[0]?.models[0]?.thinking).toBeUndefined();
        }
      } finally {
        if (previousKey === undefined) delete process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
        else process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = previousKey;
      }
    });
  }

  it("backfills legacy pins during migration without changing their owner or machine pin", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ name: "Legacy", provider: "codex", daemonId: "machine", executionGroupId: "old-group" });
    const agent = store.createAgent({ name: "Pinned", provider: "codex", runtimeId: runtime.id });
    db!.run("DELETE FROM multiremi_schema_migrations WHERE id = ?", ["execution_groups_v1"]);
    const reopened = new MultiremiStore(db!);
    expect(reopened.getAgent(agent.id)).toMatchObject({ runtimeId: runtime.id, executionGroupId: "old-group", ownerId: "local" });
    expect(reopened.getExecutionGroup("old-group")?.managed).toBe(false);
  });
});
