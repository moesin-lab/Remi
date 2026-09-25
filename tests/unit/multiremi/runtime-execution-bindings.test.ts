import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import { MultiremiDaemonClient } from "@multiremi/client.js";
import type { RuntimeExecutionBinding } from "@multiremi/contracts/runtime-connection.js";
import { ExecutionBindingStatesRepo } from "@multiremi/store/repos/execution-binding-states-repo.js";
import { StoreContext } from "@multiremi/store/context.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; resetMultiremiTestEnv(); });

function binding(groupId = "group-a", profileId = "ep_a", revision = 1): RuntimeExecutionBinding {
  return {
    generation: "ebg_test", groupId, provider: "codex", profileId, profileRevision: revision,
    profile: { name: "private", base_url: "https://models.example/v1", model: "model-a", env_key: "", auth_mode: "api_key", credential_id: `rck_${profileId}_${revision}` },
  };
}

function daemonForBindings() {
  // Exercise the real configuration/key resolver without starting operating-
  // system services or constructing unrelated workspace supervisors.
  const daemon = Object.create(MultiremiDaemon.prototype) as any;
  const keys: string[] = [];
  daemon.options = { runtimeId: "rt_a", provider: "codex" };
  daemon.runtimeProviderKeys = new Map();
  daemon.runtimeBindingAcks = [];
  daemon.runtimeCodexProfile = null;
  daemon.runtimeClaudeProfile = null;
  daemon.client = { getRuntimeCodexProfileKey: async (_runtimeId: string, id: string) => { keys.push(id); return `secret-${id}`; } };
  return { daemon, keys };
}

describe("central execution binding application", () => {
  it("prepares multiple profiles independently and reports their exact immutable versions", async () => {
    const { daemon, keys } = daemonForBindings();
    const bindings = [binding(), binding("group-b", "ep_b", 3)];
    await daemon.applyRuntimeExecutionBindings(bindings);
    expect(keys).toEqual(["rck_ep_a_1", "rck_ep_b_3"]);
    expect(daemon.runtimeBindingAcks).toEqual(bindings.map(({ generation, groupId, profileId, profileRevision }) => ({ generation, groupId, profileId, profileRevision, status: "ready" })));
    expect(daemon.runtimeCodexProfile).toBeNull();
    expect(daemon.runtimeClaudeProfile).toBeNull();
    await daemon.applyRuntimeExecutionBindings([]);
    expect(daemon.runtimeBindingAcks).toEqual([]);
  });

  it("rejects incompatible engines, unavailable revisions, missing environment keys and credentials without secret leakage", async () => {
    const { daemon } = daemonForBindings();
    daemon.client.getRuntimeCodexProfileKey = async () => { throw new Error("secret-provider-response"); };
    const missingEnv = binding("missing-env");
    missingEnv.profile = { ...missingEnv.profile!, auth_mode: "env", env_key: "REMI_CODEX_TEST_CENTRAL_MISSING" };
    await daemon.applyRuntimeExecutionBindings([
      { ...binding("incompatible"), provider: "claude" },
      { ...binding("missing-version"), profile: null },
      missingEnv,
      binding("missing-key"),
    ]);
    expect(daemon.runtimeBindingAcks.map((ack: any) => ack.status)).toEqual(["error", "error", "error", "error"]);
    expect(JSON.stringify(daemon.runtimeBindingAcks)).not.toContain("secret-provider-response");
  });

  it("sends application acknowledgements and receives next desired bindings over heartbeat", async () => {
    let payload: any;
    const desired = [binding()];
    const acks = [{ generation: "ebg_test", groupId: "group-a", profileId: "ep_a", profileRevision: 1, status: "ready" as const }];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      payload = JSON.parse(String(init?.body));
      return Response.json({ runtime_bindings: desired });
    }) as typeof fetch;
    const result = await new MultiremiDaemonClient("https://remi.example", "daemon-token")
      .heartbeatRuntime("rt_a", undefined, undefined, false, false, undefined, acks);
    expect(payload.execution_profile_protocol).toBe(1);
    expect(payload.runtime_binding_acks).toEqual(acks);
    expect(result.runtime_bindings).toEqual(desired);
  });
});

function stateRepo() {
  const store = createLocalStore();
  store.registerRuntime({ id: "rt_a", name: "A", provider: "codex", workspaceId: "local", daemonId: "daemon-a" });
  store.registerRuntime({ id: "rt_b", name: "B", provider: "codex", workspaceId: "local", daemonId: "daemon-b" });
  db!.run(`INSERT INTO multiremi_execution_groups (id, workspace_id, provider, created_at, name, managed)
    VALUES ('group-a', 'local', 'codex', ?, 'A', 1)`, [new Date().toISOString()]);
  db!.run(`INSERT INTO multiremi_execution_group_members(runtime_id,provider,workspace_id,group_id)
    VALUES('rt_a','codex','local','group-a')`);
  return { store, repo: new ExecutionBindingStatesRepo(new StoreContext(db!, () => store)) };
}

describe("central execution binding readiness", () => {
  it("delivers desired bindings only through an authorized Runtime heartbeat and stores its ack", async () => {
    const { store, repo } = stateRepo();
    const token = await store.createAccessToken({ name: "Daemon A", type: "daemon", workspaceId: "local", daemonId: "daemon-a" });
    const app = createMultiremiApp({ store, authToken: "test-master" });
    const heartbeat = (runtimeId: string, acknowledgements: unknown[]) => app.request("/api/daemon/heartbeat", {
      method: "POST", headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ runtime_id: runtimeId, execution_profile_protocol: 1, runtime_binding_acks: acknowledgements }),
    });
    const first = await heartbeat("rt_a", []);
    expect(first.status).toBe(200);
    expect((await first.json() as any).runtime_bindings).toEqual([{ generation: expect.any(String), groupId: "group-a", provider: "codex", profileId: null, profileRevision: null, profile: null }]);
    const ack = { ...repo.getRuntimeExecutionBindings("rt_a")[0]!, status: "ready" };
    expect((await heartbeat("rt_b", [ack])).status).toBe(403);
    expect(repo.isRuntimeExecutionBindingReady("group-a", "rt_a", null, null)).toBe(false);
    expect((await heartbeat("rt_a", [ack])).status).toBe(200);
    expect(repo.isRuntimeExecutionBindingReady("group-a", "rt_a", null, null)).toBe(true);
  });

  it("does not let old revision acknowledgements overwrite the currently applied revision", () => {
    const { store, repo } = stateRepo();
    const profile = store.saveExecutionProfile("local", {
      name: "Central", provider: "codex",
      profile: { name: "central", base_url: "https://models.example/v1", model: "model-a", env_key: "REMI_CODEX_TEST_KEY", auth_mode: "env" },
    });
    db!.run("UPDATE multiremi_execution_groups SET profile_id = ? WHERE id = 'group-a'", [profile.id]);
    const first = { ...repo.getRuntimeExecutionBindings("rt_a")[0]!, status: "ready" };
    repo.recordRuntimeExecutionBindingAcks("rt_a", [first]);
    expect(repo.isRuntimeExecutionBindingReady("group-a", "rt_a", profile.id, 1)).toBe(true);
    store.saveExecutionProfile("local", { name: profile.name, provider: profile.provider, profile: { ...profile.profile, model: "model-b" } }, profile.id);
    expect(repo.isRuntimeExecutionBindingReady("group-a", "rt_a", profile.id, 2)).toBe(false);
    repo.recordRuntimeExecutionBindingAcks("rt_a", [{ ...first, profileRevision: 2 }]);
    repo.recordRuntimeExecutionBindingAcks("rt_a", [{ ...first, status: "error" }]);
    expect(repo.isRuntimeExecutionBindingReady("group-a", "rt_a", profile.id, 2)).toBe(true);
    expect(repo.isRuntimeExecutionBindingReady("group-a", "rt_a", profile.id, 1)).toBe(false);
  });

  it("clears prior ready state when a Runtime registers after restart", () => {
    const { store, repo } = stateRepo();
    const previous = { ...repo.getRuntimeExecutionBindings("rt_a")[0]!, status: "ready" };
    repo.recordRuntimeExecutionBindingAcks("rt_a", [previous]);
    expect(repo.isRuntimeExecutionBindingReady("group-a", "rt_a", null, null)).toBe(true);
    store.registerRuntime({ id: "rt_a", name: "A", provider: "codex", workspaceId: "local", daemonId: "daemon-a" });
    repo.recordRuntimeExecutionBindingAcks("rt_a", [previous]);
    expect(repo.getRuntimeExecutionBindings("rt_a")[0]!.generation).not.toBe(previous.generation);
    expect(repo.isRuntimeExecutionBindingReady("group-a", "rt_a", null, null)).toBe(false);
  });

  it("rejects delayed acknowledgements after remove/re-add and profile A to B to A reassignment", () => {
    const { store, repo } = stateRepo();
    const original = { ...repo.getRuntimeExecutionBindings("rt_a")[0]!, status: "ready" };
    store.saveExecutionGroup("local", { name: "A", provider: "codex", profile_id: null, runtime_ids: [] }, "group-a");
    store.saveExecutionGroup("local", { name: "A", provider: "codex", profile_id: null, runtime_ids: ["rt_a"] }, "group-a");
    repo.recordRuntimeExecutionBindingAcks("rt_a", [original]);
    expect(repo.isRuntimeExecutionBindingReady("group-a", "rt_a", null, null)).toBe(false);
    const firstProfile = store.saveExecutionProfile("local", {
      name: "Central", provider: "codex",
      profile: { name: "central", base_url: "https://models.example/v1", model: "model-a", env_key: "REMI_CODEX_TEST_KEY", auth_mode: "env" },
    });
    store.saveExecutionGroup("local", { name: "A", provider: "codex", profile_id: firstProfile.id, runtime_ids: ["rt_a"] }, "group-a");
    const profileAck = { ...repo.getRuntimeExecutionBindings("rt_a")[0]!, status: "ready" };
    repo.recordRuntimeExecutionBindingAcks("rt_a", [profileAck]);
    expect(repo.isRuntimeExecutionBindingReady("group-a", "rt_a", firstProfile.id, 1)).toBe(true);
    store.saveExecutionGroup("local", { name: "A", provider: "codex", profile_id: null, runtime_ids: ["rt_a"] }, "group-a");
    store.saveExecutionGroup("local", { name: "A", provider: "codex", profile_id: firstProfile.id, runtime_ids: ["rt_a"] }, "group-a");
    repo.recordRuntimeExecutionBindingAcks("rt_a", [profileAck]);
    expect(repo.isRuntimeExecutionBindingReady("group-a", "rt_a", firstProfile.id, 1)).toBe(false);
    repo.recordRuntimeExecutionBindingAcks("rt_a", [{ ...repo.getRuntimeExecutionBindings("rt_a")[0]!, status: "ready" }]);
    expect(repo.isRuntimeExecutionBindingReady("group-a", "rt_a", firstProfile.id, 1)).toBe(true);
  });

  it("requires a matching acknowledgement from the assigned Runtime", () => {
    const { repo } = stateRepo();
    expect(repo.isRuntimeExecutionBindingReady("group-a", "rt_a", null, null)).toBe(false);
    const ack = { ...repo.getRuntimeExecutionBindings("rt_a")[0]!, status: "ready" };
    repo.recordRuntimeExecutionBindingAcks("rt_b", [ack]);
    expect(repo.isRuntimeExecutionBindingReady("group-a", "rt_a", null, null)).toBe(false);
    repo.recordRuntimeExecutionBindingAcks("rt_a", [{ ...ack, profileId: "wrong" }]);
    expect(repo.isRuntimeExecutionBindingReady("group-a", "rt_a", null, null)).toBe(false);
    repo.recordRuntimeExecutionBindingAcks("rt_a", [{ ...ack, generation: undefined }]);
    expect(repo.isRuntimeExecutionBindingReady("group-a", "rt_a", null, null)).toBe(false);
    repo.recordRuntimeExecutionBindingAcks("rt_a", [ack]);
    expect(repo.isRuntimeExecutionBindingReady("group-a", "rt_a", null, null)).toBe(true);
    repo.recordRuntimeExecutionBindingAcks("rt_a", [{ ...ack, status: "error", error: "private" }]);
    expect(repo.isRuntimeExecutionBindingReady("group-a", "rt_a", null, null)).toBe(false);
    expect(JSON.stringify(db!.query("SELECT * FROM multiremi_execution_binding_states").all())).not.toContain("private");
  });

  it("invalidates readiness when membership or profile revision no longer matches", () => {
    const { repo } = stateRepo();
    const ack = { ...repo.getRuntimeExecutionBindings("rt_a")[0]!, status: "ready" };
    repo.recordRuntimeExecutionBindingAcks("rt_a", [ack]);
    db!.run("UPDATE multiremi_execution_groups SET profile_id = 'ep_missing' WHERE id = 'group-a'");
    expect(repo.isRuntimeExecutionBindingReady("group-a", "rt_a", null, null)).toBe(false);
    repo.recordRuntimeExecutionBindingAcks("rt_a", [{ ...ack, profileId: "ep_missing" }]);
    expect(repo.isRuntimeExecutionBindingReady("group-a", "rt_a", "ep_missing", null)).toBe(false);
    db!.run("UPDATE multiremi_execution_groups SET profile_id = NULL WHERE id = 'group-a'");
    db!.run("DELETE FROM multiremi_execution_group_members WHERE runtime_id = 'rt_a'");
    expect(repo.isRuntimeExecutionBindingReady("group-a", "rt_a", null, null)).toBe(false);
  });
});
