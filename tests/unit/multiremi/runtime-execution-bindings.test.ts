import { afterEach, describe, expect, it } from "bun:test";
import { runtimeInputSnapshot } from "@multiremi/api/daemon-protocol/runtime-input-snapshot.js";
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
  daemon.runtimeBindingDiscoveries = new Map();
  daemon.runtimeBindingProbeTasks = new Set();
  daemon.runtimeBindingApplication = 0;
  daemon.stopped = true;
  daemon.runtimeCodexProfile = null;
  daemon.runtimeClaudeProfile = null;
  daemon.client = { reportRuntimeBindingAcks: async () => {}, getRuntimeCodexProfileKey: async (_runtimeId: string, id: string) => { keys.push(id); return `secret-${id}`; } };
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

describe("central binding catalog refresh", () => {
  const activeDaemons: any[] = [];
  afterEach(async () => {
    for (const daemon of activeDaemons.splice(0)) {
      daemon.stopped = true;
      for (const entry of daemon.runtimeBindingDiscoveries.values()) { entry.abort.abort(); clearTimeout(entry.timer); }
      await Promise.allSettled([...daemon.runtimeBindingDiscoveries.values()].map((entry: any) => entry.probe));
    }
  });

  function active() {
    const { daemon } = daemonForBindings();
    daemon.stopped = false;
    daemon.runtimeRegistrationGeneration = 1;
    Object.assign(daemon.options, { runtimeModelRefreshIntervalMs: 60_000, runtimeModelRetryBaseMs: 60_000 });
    activeDaemons.push(daemon);
    return daemon;
  }

  it("discovers bindings asynchronously without replacing native state or another group", async () => {
    const daemon = active();
    const native = [{ id: "native", label: "Native", provider: "codex", default: true }];
    daemon.runtimeModels = native;
    let release: (() => void) | undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    globalThis.fetch = (async input => {
      if (String(input).includes("held.example")) await held;
      return String(input).includes("failed.example") ? new Response("private-provider-response", { status: 401 })
        : Response.json({ data: [{ id: "custom-a" }, { id: "custom-b" }] });
    }) as typeof fetch;
    const fast = binding();
    fast.profile = { ...fast.profile!, model: "" };
    const slow = binding("slow");
    slow.profile = { ...slow.profile!, base_url: "https://held.example/v1", model: "" };
    const failed = binding("failed");
    failed.profile = { ...failed.profile!, base_url: "https://failed.example/v1", model: "" };
    try {
      await daemon.applyRuntimeExecutionBindings([fast, slow, failed]);
      expect(daemon.runtimeBindingAcks.every((ack: any) => ack.status === "ready")).toBe(true);
      expect(daemon.runtimeBindingDiscoveries.get("slow").probe).toBeDefined();
      await daemon.runtimeBindingDiscoveries.get(fast.groupId).probe;
      await daemon.runtimeBindingDiscoveries.get(failed.groupId).probe;
      expect(daemon.runtimeBindingDiscoveries.get(fast.groupId).ack.model_catalog.models.map((model: any) => model.id)).toEqual(["custom-a", "custom-b"]);
      expect(daemon.runtimeBindingDiscoveries.get(failed.groupId).ack.model_catalog).toEqual({ status: "error", models: [] });
      expect(JSON.stringify(daemon.runtimeBindingAcks)).not.toContain("private-provider-response");
      expect(daemon.runtimeModels).toBe(native);
      release!();
      await daemon.runtimeBindingDiscoveries.get(slow.groupId).probe;
      expect(daemon.runtimeBindingDiscoveries.get(slow.groupId).ack.model_catalog.status).toBe("ready");
    } finally { release!(); }
  });

  it("discards late probes after profile replacement and after a new registration generation", async () => {
    const daemon = active();
    let release: (() => void) | undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    globalThis.fetch = (async input => {
      if (String(input).includes("held.example")) { await held; return Response.json({ data: [{ id: "stale" }] }); }
      return Response.json({ data: [{ id: "current" }] });
    }) as typeof fetch;
    const reports: any[] = [];
    daemon.client.reportRuntimeBindingAcks = async (_rt: string, acks: any[]) => { reports.push(...acks); };
    const old = binding();
    old.profile = { ...old.profile!, base_url: "https://held.example/v1", model: "" };
    try {
      await daemon.applyRuntimeExecutionBindings([old]);
      const oldEntry = daemon.runtimeBindingDiscoveries.get(old.groupId);
      const next = binding(old.groupId, old.profileId!, 2);
      next.profile = { ...next.profile!, model: "" };
      await daemon.applyRuntimeExecutionBindings([next]);
      await daemon.runtimeBindingDiscoveries.get(next.groupId).probe;
      release!();
      await oldEntry.probe;
      expect(reports.filter(ack => ack.model_catalog).every(ack => ack.profileRevision === 2)).toBe(true);
      expect(JSON.stringify(reports)).not.toContain('"id":"stale"');
      let releaseRegistration: (() => void) | undefined;
      const registrationHeld = new Promise<void>(resolve => { releaseRegistration = resolve; });
      globalThis.fetch = (async (_input: unknown) => { await registrationHeld; return Response.json({ data: [{ id: "old-registration" }] }); }) as typeof fetch;
      const rebind = { ...next, generation: "new-binding" };
      await daemon.applyRuntimeExecutionBindings([rebind]);
      const entry = daemon.runtimeBindingDiscoveries.get(rebind.groupId);
      daemon.runtimeRegistrationGeneration++;
      releaseRegistration!();
      await entry.probe;
      expect(JSON.stringify(reports)).not.toContain("old-registration");
    } finally { release!(); }
  });

  it("retains the current catalog on repeated configuration and refreshes it on the discovery cadence", async () => {
    const daemon = active();
    daemon.options.runtimeModelRefreshIntervalMs = 50;
    let calls = 0;
    globalThis.fetch = (async (_input: unknown) => Response.json({ data: [{ id: `model-${++calls}` }] })) as typeof fetch;
    const connection = binding();
    connection.profile = { ...connection.profile!, model: "" };
    await daemon.applyRuntimeExecutionBindings([connection]);
    await daemon.runtimeBindingDiscoveries.get(connection.groupId).probe;
    await daemon.applyRuntimeExecutionBindings([connection]);
    expect(calls).toBe(1);
    expect(daemon.runtimeBindingAcks[0].model_catalog.models[0].id).toBe("model-1");
    const deadline = Date.now() + 1_000;
    while (calls < 2 && Date.now() < deadline) await Bun.sleep(10);
    expect(calls).toBeGreaterThanOrEqual(2);
    await daemon.runtimeBindingDiscoveries.get(connection.groupId).probe;
    expect(daemon.runtimeBindingAcks[0].model_catalog.models[0].id).toBe("model-2");
  });

  it("rebuilds a cancelled binding on authority recovery even when the configuration is identical", async () => {
    const daemon = active();
    let calls = 0;
    globalThis.fetch = (async (_input: unknown) => Response.json({ data: [{ id: `model-${++calls}` }] })) as typeof fetch;
    const connection = binding();
    connection.profile = { ...connection.profile!, model: "" };
    await daemon.applyRuntimeExecutionBindings([connection]);
    const original = daemon.runtimeBindingDiscoveries.get(connection.groupId);
    await original.probe;
    daemon.cancelRuntimeModelRefresh();
    expect(original.abort.signal.aborted).toBe(true);
    expect(daemon.runtimeBindingDiscoveries.size).toBe(0);
    await daemon.applyRuntimeExecutionBindings([connection]);
    const recovered = daemon.runtimeBindingDiscoveries.get(connection.groupId);
    expect(recovered).not.toBe(original);
    await recovered.probe;
    expect(recovered.ack.model_catalog.models[0].id).toBe("model-2");
  });

  it("does not let a delayed credential lookup republish an older concurrent configuration", async () => {
    const daemon = active();
    let release: (() => void) | undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    daemon.client.getRuntimeCodexProfileKey = async (_rt: string, id: string) => {
      if (id.endsWith("_1")) await held;
      return "private-test-key";
    };
    globalThis.fetch = (async (_input: unknown) => Response.json({ data: [{ id: "current" }] })) as typeof fetch;
    const old = binding();
    old.profile = { ...old.profile!, model: "" };
    const next = binding(old.groupId, old.profileId!, 2);
    next.profile = { ...next.profile!, model: "" };
    const applyingOld = daemon.applyRuntimeExecutionBindings([old]);
    try {
      await daemon.applyRuntimeExecutionBindings([next]);
      const current = daemon.runtimeBindingDiscoveries.get(next.groupId);
      await current.probe;
      release!();
      await applyingOld;
      expect(daemon.runtimeBindingDiscoveries.get(next.groupId)).toBe(current);
      expect(daemon.runtimeBindingAcks[0].profileRevision).toBe(2);
      expect(daemon.runtimeBindingAcks[0].model_catalog.status).toBe("ready");
    } finally { release!(); await applyingOld; }
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
  it("delivers desired bindings through v2 snapshots and accepts authorized compatibility acknowledgements", async () => {
    const { store, repo } = stateRepo();
    const token = await store.createAccessToken({ name: "Daemon A", type: "daemon", workspaceId: "local", daemonId: "daemon-a" });
    const app = createMultiremiApp({ store, authToken: "test-master" });
    const heartbeat = (runtimeId: string, acknowledgements: unknown[]) => app.request("/api/daemon/heartbeat", {
      method: "POST", headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ runtime_id: runtimeId, execution_profile_protocol: 1, runtime_binding_acks: acknowledgements }),
    });
    const first = await heartbeat("rt_a", []);
    expect(first.status).toBe(200);
    expect((await first.json() as any).runtime_bindings).toBeUndefined();
    expect(runtimeInputSnapshot(store, "rt_a").find(frame => frame.type === "runtime.profile")!.payload.runtime_bindings).toEqual([{ generation: expect.any(String), groupId: "group-a", provider: "codex", profileId: null, profileRevision: null, profile: null }]);
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

  it("preserves unchanged member generations across group metadata and membership API updates", async () => {
    const { store, repo } = stateRepo();
    const original = { ...repo.getRuntimeExecutionBindings("rt_a")[0]!, status: "ready" as const };
    repo.recordRuntimeExecutionBindingAcks("rt_a", [original]);
    const owner = await store.createAccessToken({
      name: "Owner",
      type: "pat",
      workspaceId: "local",
      userId: "local",
    });
    const app = createMultiremiApp({ store, authToken: "test-master" });
    const update = (body: Record<string, unknown>) =>
      app.request("/api/execution-groups/group-a", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${owner.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          workspace_id: "local",
          name: "Renamed",
          provider: "codex",
          profile_id: null,
          runtime_ids: ["rt_a"],
          ...body,
        }),
      });

    const renamed = await update({});
    expect(renamed.status).toBe(200);
    expect((await renamed.json() as any).group.members).toEqual([
      { runtime_id: "rt_a", status: "ready", error: null },
    ]);
    expect(repo.getRuntimeExecutionBindings("rt_a")[0]!.generation).toBe(
      original.generation,
    );

    const expanded = await update({ runtime_ids: ["rt_a", "rt_b"] });
    expect(expanded.status).toBe(200);
    expect((await expanded.json() as any).group.members).toEqual([
      { runtime_id: "rt_a", status: "ready", error: null },
      { runtime_id: "rt_b", status: "pending", error: null },
    ]);
    expect(repo.getRuntimeExecutionBindings("rt_a")[0]!.generation).toBe(
      original.generation,
    );
    expect(repo.getRuntimeExecutionBindings("rt_b")[0]!.generation).not.toBe(
      original.generation,
    );

    const profile = store.saveExecutionProfile("local", {
      name: "Central",
      provider: "codex",
      profile: {
        name: "central",
        base_url: "https://models.example/v1",
        model: "model-a",
        env_key: "REMI_CODEX_TEST_KEY",
        auth_mode: "env",
      },
    });
    const rebound = await update({
      profile_id: profile.id,
      runtime_ids: ["rt_a", "rt_b"],
    });
    expect(rebound.status).toBe(200);
    expect((await rebound.json() as any).group.members).toEqual([
      { runtime_id: "rt_a", status: "pending", error: null },
      { runtime_id: "rt_b", status: "pending", error: null },
    ]);
    expect(repo.getRuntimeExecutionBindings("rt_a")[0]!.generation).not.toBe(
      original.generation,
    );
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
