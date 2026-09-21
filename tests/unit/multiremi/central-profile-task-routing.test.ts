import { afterEach, describe, expect, it } from "bun:test";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function setup() {
  const store = createLocalStore();
  const runtime = store.registerRuntime({
    name: "Shared worker", provider: "codex", daemonId: "shared", ownerId: "local",
    metadata: { codex_profiles: 1, execution_profile_protocol: 1 },
  });
  const profile = (name: string) => store.saveExecutionProfile("local", {
    name, provider: "codex",
    profile: { name, base_url: `https://${name}.example/v1`, model: `${name}-model`, auth_mode: "env", env_key: "REMI_CODEX_TEST_KEY" },
  });
  const first = profile("first");
  const second = profile("second");
  const group = (name: string, profileId: string | null) => store.saveExecutionGroup("local", {
    name, provider: "codex", profile_id: profileId, runtime_ids: [runtime.id],
  });
  const a = group("First", first.id);
  const b = group("Second", second.id);
  const agentA = store.createAgent({ name: "First", provider: "codex", executionGroupId: a.id });
  const agentB = store.createAgent({ name: "Second", provider: "codex", executionGroupId: b.id });
  const ready = (groupId: string) => {
    const binding = store.getRuntimeExecutionBindings(runtime.id).find(item => item.groupId === groupId)!;
    store.recordRuntimeExecutionBindingAcks(runtime.id, [{ ...binding, status: "ready" }]);
  };
  return { store, runtime, first, second, a, b, agentA, agentB, ready };
}

describe("central profile task routing", () => {
  it("keeps unacknowledged work queued without blocking another ready group on the same runtime", () => {
    const { store, runtime, a, b, agentA, agentB, second, ready } = setup();
    const blocked = store.createTask({ agentId: agentA.id, prompt: "wait" });
    const runnable = store.createTask({ agentId: agentB.id, prompt: "execute" });
    expect(store.claimTask(runtime.id)).toBeNull();
    ready(b.id);
    const claimed = store.claimTask(runtime.id)!;
    expect(claimed.id).toBe(runnable.id);
    expect(claimed.codexProfile).toEqual(second.profile);
    expect(store.getTask(blocked.id)?.status).toBe("queued");
    expect(store.getExecutionGroup(a.id)?.runtimeIds).toContain(runtime.id);
  });

  it("freezes connections per task and fences the next revision until applied", () => {
    const { store, runtime, first, a, agentA, ready } = setup();
    ready(a.id);
    const task = store.createTask({ agentId: agentA.id, prompt: "original" });
    const original = store.claimTask(runtime.id)!;
    expect(original.codexProfile).toEqual(first.profile);
    store.startTask(task.id);
    const updated = store.saveExecutionProfile("local", {
      name: first.name, provider: "codex", profile: { ...first.profile, base_url: "https://replacement.example/v1" },
    }, first.id);
    expect(store.getTask(task.id)?.codexProfile).toEqual(first.profile);
    store.completeTask(task.id, { output: "done" });
    const queued = store.createTask({ agentId: agentA.id, prompt: "updated" });
    expect(store.claimTask(runtime.id)).toBeNull();
    store.recordRuntimeExecutionBindingAcks(runtime.id, [{ groupId: a.id, profileId: first.id, profileRevision: first.revision, status: "ready" }]);
    expect(store.claimTask(runtime.id)).toBeNull();
    ready(a.id);
    const claimed = store.claimTask(runtime.id)!;
    expect(claimed.id).toBe(queued.id);
    expect(claimed.codexProfile).toEqual(updated.profile);
    expect(claimed.executionFingerprint).not.toBe(original.executionFingerprint);
  });

  it("reclaims a frozen dispatch using its original connection while a new revision is pending", () => {
    const { store, runtime, first, a, agentA, ready } = setup();
    store.updateAgent(agentA.id, { model: first.profile.model });
    ready(a.id);
    const task = store.createTask({ agentId: agentA.id, prompt: "recover frozen dispatch" });
    const original = store.claimTask(runtime.id)!;
    store.saveExecutionProfile("local", {
      name: first.name, provider: "codex",
      profile: { ...first.profile, base_url: "https://next.example/v1", model: "next-model" },
    }, first.id);
    db!.run("UPDATE multiremi_tasks SET dispatched_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", task.id]);
    const recovered = store.claimTask(runtime.id)!;
    expect(recovered.id).toBe(task.id);
    expect(recovered.codexProfile).toEqual(original.codexProfile);
    expect(recovered.executionFingerprint).toBe(original.executionFingerprint);
  });

  it("retires unstarted snapshots when Agent model settings change and preserves running work", () => {
    const { store, runtime, first, a, agentA, ready } = setup();
    ready(a.id);
    const firstTask = store.createTask({ agentId: agentA.id, prompt: "unstarted" });
    store.claimTask(runtime.id);
    store.saveExecutionProfile("local", {
      name: first.name, provider: "codex", profile: { ...first.profile, model: "replacement" },
    }, first.id);
    store.updateAgent(agentA.id, { model: "replacement" });
    expect(store.getTask(firstTask.id)?.status).toBe("cancelled");
    ready(a.id);
    const secondTask = store.createTask({ agentId: agentA.id, prompt: "running" });
    expect(store.claimTask(runtime.id)?.id).toBe(secondTask.id);
    store.startTask(secondTask.id);
    store.updateAgent(agentA.id, { thinkingLevel: "high" });
    expect(store.getTask(secondTask.id)?.status).toBe("running");
    expect(store.getTask(secondTask.id)?.codexProfile?.model).toBe("replacement");
  });

  it("uses an explicit default connection rather than a legacy runtime override", () => {
    const { store, runtime, first, a, agentA, ready } = setup();
    store.setRuntimeCodexProfile(runtime.id, first.profile);
    store.saveExecutionGroup("local", { name: "Default", provider: "codex", profile_id: null, runtime_ids: [runtime.id] }, a.id);
    ready(a.id);
    const task = store.createTask({ agentId: agentA.id, prompt: "default" });
    expect(store.claimTask(runtime.id)?.codexProfile).toBeNull();
    expect(store.getTask(task.id)?.status).toBe("dispatched");
  });

  it("revokes new claims when a member is removed and requires acknowledgment after rejoining", () => {
    const { store, runtime, first, a, agentA, ready } = setup();
    ready(a.id);
    const task = store.createTask({ agentId: agentA.id, prompt: "membership" });
    store.saveExecutionGroup("local", { name: a.name, provider: "codex", profile_id: first.id, runtime_ids: [] }, a.id);
    expect(store.claimTask(runtime.id)).toBeNull();
    store.saveExecutionGroup("local", { name: a.name, provider: "codex", profile_id: first.id, runtime_ids: [runtime.id] }, a.id);
    expect(store.claimTask(runtime.id)).toBeNull();
    ready(a.id);
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
  });
});
