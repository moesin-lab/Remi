import { createMultiremiApp } from "@multiremi/api.js";
import { afterEach, describe, expect, it } from "bun:test";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";
import { migrateLegacyExecutionProfiles } from "@multiremi/store/execution-profile-migration.js";
const profile = {
  name: "central",
  base_url: "https://example.test/v1",
  model: "model",
  env_key: "",
  auth_mode: "api_key" as const,
};
const originalKey = process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
afterEach(() => {
  if (originalKey === undefined)
    delete process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
  else process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = originalKey;
  resetMultiremiTestEnv();
});
function setup() {
  process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString(
    "base64",
  );
  const store = createLocalStore();
  const runtime = store.registerRuntime({
    name: "machine",
    provider: "codex",
    workspaceId: "local",
    metadata: { codex_profiles: 1 },
  });
  return { store, runtime };
}
describe("Central execution configuration", () => {
  it("does not create groups during discovery and supports multiple explicitly assigned profiles", () => {
    const { store, runtime } = setup();
    expect(store.listExecutionGroups("local")).toEqual([]);
    const p = store.saveExecutionProfile("local", {
      name: "Gateway",
      provider: "codex",
      profile,
      api_key: "first-secret",
    });
    const a = store.saveExecutionGroup("local", {
      name: "Custom",
      provider: "codex",
      profile_id: p.id,
      runtime_ids: [runtime.id],
    });
    const b = store.saveExecutionGroup("local", {
      name: "Official",
      provider: "codex",
      profile_id: null,
      runtime_ids: [runtime.id],
    });
    expect(store.getRuntime(runtime.id)!.executionGroupIds!.sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect(
      store.getRuntimeCodexProfileKey(runtime.id, p.profile.credential_id!),
    ).toBe("first-secret");
    const outsider = store.registerRuntime({
      name: "outsider",
      provider: "codex",
    });
    expect(
      store.getRuntimeCodexProfileKey(outsider.id, p.profile.credential_id!),
    ).toBeNull();
    store.updateRuntime(runtime.id, { name: "renamed" });
    expect(store.getExecutionGroup(a.id)!.runtimeIds).toEqual([runtime.id]);
  });
  it("keeps immutable revision and key history, resets readiness when revision changes", () => {
    const { store, runtime } = setup();
    const first = store.saveExecutionProfile("local", {
      name: "Gateway",
      provider: "codex",
      profile,
      api_key: "first-secret",
    });
    const group = store.saveExecutionGroup("local", {
      name: "Custom",
      provider: "codex",
      profile_id: first.id,
      runtime_ids: [runtime.id],
    });
    store.recordRuntimeExecutionBindingAcks(runtime.id, [
      {
        generation: store.getRuntimeExecutionBindings(runtime.id)[0]!
          .generation,
        groupId: group.id,
        profileId: first.id,
        profileRevision: 1,
        status: "ready",
      },
    ]);
    expect(
      store.isRuntimeExecutionBindingReady(group.id, runtime.id, first.id, 1),
    ).toBe(true);
    const second = store.saveExecutionProfile(
      "local",
      {
        name: "Gateway",
        provider: "codex",
        profile: { ...profile, model: "new" },
        api_key: "second-secret",
      },
      first.id,
    );
    expect(second.revision).toBe(2);
    expect(store.getExecutionProfile(first.id, "local", 1)?.profile.model).toBe(
      "model",
    );
    expect(
      store.getExecutionProfileKey(
        first.id,
        "local",
        1,
        first.profile.credential_id!,
      ),
    ).toBe("first-secret");
    expect(
      store.getRuntimeCodexProfileKey(runtime.id, first.profile.credential_id!),
    ).toBeNull();
    expect(
      store.isRuntimeExecutionBindingReady(group.id, runtime.id, first.id, 2),
    ).toBe(false);
    expect(() => store.deleteExecutionProfile(first.id, "local")).toThrow(
      "still used",
    );
    expect(JSON.stringify(second)).not.toContain("secret");
    expect(
      JSON.stringify(
        db!
          .query("SELECT * FROM multiremi_execution_profile_credentials")
          .all(),
      ),
    ).not.toContain("first-secret");
  });
  it("authorizes human administrators and only releases central credentials to the assigned daemon", async () => {
    const { store, runtime } = setup();
    store.registerRuntime({
      id: runtime.id,
      name: runtime.name,
      provider: "codex",
      daemonId: "central-daemon",
      ownerId: "local",
      workspaceId: "local",
    });
    store.createWorkspaceMember({
      id: "member",
      userId: "member",
      workspaceId: "local",
      name: "Member",
      role: "member",
    });
    const owner = await store.createAccessToken({
      name: "Owner",
      type: "pat",
      workspaceId: "local",
      userId: "local",
    });
    const member = await store.createAccessToken({
      name: "Member",
      type: "pat",
      workspaceId: "local",
      userId: "member",
    });
    const daemon = await store.createAccessToken({
      name: "Daemon",
      type: "daemon",
      workspaceId: "local",
      userId: "local",
      daemonId: "central-daemon",
    });
    const other = await store.createAccessToken({
      name: "Other",
      type: "daemon",
      workspaceId: "local",
      userId: "local",
      daemonId: "other-daemon",
    });
    const app = createMultiremiApp({ store, authToken: "test-master" });
    const request = (
      path: string,
      token: string,
      method = "GET",
      body?: unknown,
    ) =>
      app.request(path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const input = {
      name: "Gateway",
      provider: "codex",
      profile,
      api_key: "central-secret",
    };
    expect(
      (await request("/api/execution-profiles", member.token, "POST", input))
        .status,
    ).toBe(403);
    const created = await request(
      "/api/execution-profiles",
      owner.token,
      "POST",
      input,
    );
    expect(created.status).toBe(201);
    const { profile: saved } = await created.json();
    expect(JSON.stringify(saved)).not.toContain("central-secret");
    const grouped = await request(
      "/api/execution-groups",
      owner.token,
      "POST",
      {
        name: "Group",
        provider: "codex",
        profile_id: saved.id,
        runtime_ids: [runtime.id],
      },
    );
    expect(grouped.status).toBe(201);
    const path = `/api/daemon/runtimes/${runtime.id}/codex-profile-key?credential_id=${saved.profile.credential_id}`;
    expect((await request(path, daemon.token)).status).toBe(200);
    expect((await request(path, other.token)).status).toBe(403);
    expect((await request(path, owner.token)).status).toBe(403);
  });
  it("imports heterogeneous legacy pools without changing their routing and is idempotent", () => {
    const { store, runtime } = setup();
    const other = store.registerRuntime({
      name: "second",
      provider: "codex",
      metadata: { codex_profiles: 1 },
    });
    store.setRuntimeCodexProfile(runtime.id, profile, "first");
    store.setRuntimeCodexProfile(
      other.id,
      { ...profile, model: "second" },
      "second",
    );
    db!.run(
      "INSERT INTO multiremi_execution_groups(id,workspace_id,provider,created_at) VALUES('pool','local','codex','now')",
    );
    for (const id of [runtime.id, other.id])
      db!.run(
        "INSERT INTO multiremi_execution_group_members(runtime_id,provider,workspace_id,group_id) VALUES(?,'codex','local','pool')",
        [id],
      );
    migrateLegacyExecutionProfiles(db!);
    expect(store.getExecutionGroup("pool")!.managed).toBe(false);
    expect(store.listExecutionProfiles("local")).toHaveLength(2);
    expect(
      store.listExecutionGroups("local").filter((group) => group.managed),
    ).toHaveLength(2);
    const first = store.listExecutionProfiles("local")[0]!;
    store.saveExecutionProfile(
      "local",
      { name: "edited", provider: "codex", profile: first.profile },
      first.id,
    );
    migrateLegacyExecutionProfiles(db!);
    expect(store.listExecutionProfiles("local")).toHaveLength(2);
    expect(store.getExecutionProfile(first.id, "local")!.name).toBe("edited");
    expect(store.listExecutionGroups("local")).toHaveLength(3);
  });
  it("imports legacy encrypted profiles and retains legacy snapshot keys", () => {
    const { store, runtime } = setup();
    const old = store.setRuntimeCodexProfile(
      runtime.id,
      profile,
      "old-secret",
    )!;
    db!.run(
      "INSERT INTO multiremi_execution_groups(id,workspace_id,provider,created_at) VALUES('legacy','local','codex','now')",
    );
    db!.run(
      "INSERT INTO multiremi_execution_group_members(runtime_id,provider,workspace_id,group_id) VALUES(?,'codex','local','legacy')",
      [runtime.id],
    );
    migrateLegacyExecutionProfiles(db!);
    const central = store.listExecutionProfiles("local")[0]!;
    expect(central.profile.credential_id).not.toBe(old.credential_id);
    expect(store.getExecutionGroup("legacy")?.profileId).toBe(central.id);
    expect(
      store.getRuntimeCodexProfileKey(
        runtime.id,
        central.profile.credential_id!,
      ),
    ).toBe("old-secret");
    expect(
      store.getRuntimeCodexProfileKey(runtime.id, old.credential_id!),
    ).toBe("old-secret");
  });
});
