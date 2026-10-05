import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

const originalKey = process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
afterEach(() => {
  if (originalKey === undefined)
    delete process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
  else process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = originalKey;
  resetMultiremiTestEnv();
});
const connection = {
  name: "Team provider",
  profile: {
    name: "team",
    base_url: "https://example.test/v1",
    model: "default-model",
    models: ["default-model", "fast-model"],
    env_key: "",
    auth_mode: "api_key",
  },
  api_key: "isolated-test-key",
};
function setup() {
  process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 12).toString(
    "base64",
  );
  const store = createLocalStore();
  const runtime = store.registerRuntime({
    name: "Machine",
    provider: "codex",
    workspaceId: "local",
    metadata: { codex_profiles: 1 },
  });
  return {
    store,
    runtime,
    input: {
      name: "Development",
      description: "Build and review",
      provider: "codex",
      profile_id: null,
      runtime_ids: [runtime.id],
      connection,
    },
  };
}

describe("Group-owned configuration workflow", () => {
  it("creates a group, connection and model catalog in one request without returning secrets", async () => {
    const { store, runtime, input } = setup();
    const app = createMultiremiApp({ store });
    const response = await app.request("/api/execution-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(201);
    const body = await response.text();
    expect(body).not.toContain(connection.api_key);
    const { group } = JSON.parse(body);
    expect(group).toMatchObject({
      name: input.name,
      description: input.description,
      provider: "codex",
      runtime_ids: [runtime.id],
      profile_revision: 1,
    });
    const profile = store.getExecutionProfile(group.profile_id, "local")!;
    expect(profile.provider).toBe("codex");
    expect(store.getRuntimeCodexProfile(runtime.id)).toBeNull();
    expect(
      store.getRuntimeCodexProfileKey(
        runtime.id,
        profile.profile.credential_id!,
      ),
    ).toBe(connection.api_key);
    const catalog = (await (
      await app.request(`/api/models?execution_group_id=${group.id}`)
    ).json()) as any;
    expect(catalog.providers[0].models.map((model: any) => model.id)).toEqual([
      "default-model",
      "fast-model",
    ]);
    const createAgent = (model: string) =>
      app.request("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `Developer ${model}`,
          execution_group_id: group.id,
          model,
        }),
      });
    expect((await createAgent("fast-model")).status).toBe(201);
    expect((await createAgent("unconfigured-model")).status).toBe(400);
    const listed = (await (
      await app.request("/api/execution-groups")
    ).json()) as any;
    expect(listed.groups[0].description).toBe(input.description);
  });

  it("updates the selected shared connection atomically and keeps the saved credential", () => {
    const { store, runtime, input } = setup();
    const group = store.saveExecutionGroup("local", input);
    const other = store.saveExecutionGroup("local", {
      name: "Review",
      provider: "codex",
      profile_id: group.profileId,
      runtime_ids: [runtime.id],
    });
    const bindings = store.getRuntimeExecutionBindings(runtime.id);
    store.recordRuntimeExecutionBindingAcks(
      runtime.id,
      bindings.map((binding) => ({ ...binding, status: "ready" })),
    );
    const updated = store.saveExecutionGroup(
      "local",
      {
        ...input,
        profile_id: group.profileId,
        connection: {
          name: connection.name,
          profile: { ...connection.profile, model: "fast-model" },
        },
      },
      group.id,
    );
    expect(updated.profileId).toBe(group.profileId);
    expect(updated.profileRevision).toBe(2);
    expect(store.listExecutionProfiles("local")).toHaveLength(1);
    expect(store.getExecutionGroup(other.id)?.profileRevision).toBe(2);
    expect(
      store.getRuntimeCodexProfileKey(
        runtime.id,
        store.getExecutionProfile(group.profileId!, "local")!.profile
          .credential_id!,
      ),
    ).toBe(connection.api_key);
    for (const id of [group.id, other.id])
      expect(store.getExecutionGroupMembers(id, "local")[0]?.status).toBe(
        "pending",
      );
    store.recordRuntimeExecutionBindingAcks(
      runtime.id,
      bindings.map((binding) => ({ ...binding, status: "ready" })),
    );
    expect(store.getExecutionGroupMembers(group.id, "local")[0]?.status).toBe(
      "pending",
    );
  });

  it("rolls back new connections and credentials if membership or group metadata is invalid", () => {
    const { store, input } = setup();
    expect(() =>
      store.saveExecutionGroup("local", { ...input, runtime_ids: ["missing"] }),
    ).toThrow("incompatible");
    expect(() =>
      store.saveExecutionGroup("local", {
        ...input,
        description: "x".repeat(2001),
      }),
    ).toThrow("description");
    expect(store.listExecutionProfiles("local")).toEqual([]);
    expect(store.listExecutionGroups("local")).toEqual([]);
    expect(
      db!
        .query(
          "SELECT COUNT(*) AS n FROM multiremi_execution_profile_credentials",
        )
        .get(),
    ).toEqual({ n: 0 });
  });

  it("rolls back a shared connection edit if the group cannot be saved", () => {
    const { store, runtime, input } = setup();
    const group = store.saveExecutionGroup("local", input);
    const bindings = store.getRuntimeExecutionBindings(runtime.id);
    store.recordRuntimeExecutionBindingAcks(
      runtime.id,
      bindings.map((binding) => ({ ...binding, status: "ready" })),
    );
    expect(() =>
      store.saveExecutionGroup(
        "local",
        {
          ...input,
          name: "",
          profile_id: group.profileId,
          connection: { ...connection, api_key: "replacement-key" },
        },
        group.id,
      ),
    ).toThrow("name");
    expect(store.getExecutionProfile(group.profileId!, "local")?.revision).toBe(
      1,
    );
    expect(store.getExecutionGroupMembers(group.id, "local")[0]?.status).toBe(
      "ready",
    );
    expect(
      db!
        .query(
          "SELECT COUNT(*) AS n FROM multiremi_execution_profile_credentials",
        )
        .get(),
    ).toEqual({ n: 1 });
  });

  it("does not allow cross-workspace profile writes or unsupported connection engines", () => {
    const { store, input } = setup();
    store.createWorkspace({ id: "other", name: "Other", slug: "other" });
    const foreign = store.saveExecutionProfile("other", {
      ...connection,
      provider: "codex",
    });
    expect(() =>
      store.saveExecutionGroup("local", { ...input, profile_id: foreign.id }),
    ).toThrow("workspace");
    expect(store.getExecutionProfile(foreign.id, "other")?.revision).toBe(1);
    expect(() =>
      store.saveExecutionGroup("local", { ...input, provider: "antigravity" }),
    ).toThrow("Claude or Codex");
    expect(() =>
      store.saveExecutionGroup("local", { ...input, connection: null as any }),
    ).toThrow("connection");
    expect(store.listExecutionGroups("local")).toEqual([]);
  });

  it("persists organization metadata across restart and preserves it for older callers", () => {
    const { store, runtime, input } = setup();
    const group = store.saveExecutionGroup("local", input);
    const bindings = store.getRuntimeExecutionBindings(runtime.id);
    store.recordRuntimeExecutionBindingAcks(
      runtime.id,
      bindings.map((binding) => ({ ...binding, status: "ready" })),
    );
    const olderInput = {
      name: "Renamed",
      provider: "codex",
      profile_id: group.profileId,
      runtime_ids: [runtime.id],
    };
    store.saveExecutionGroup("local", olderInput, group.id);
    expect(store.getExecutionGroupMembers(group.id, "local")[0]?.status).toBe(
      "ready",
    );
    const reopened = new MultiremiStore(db!);
    expect(reopened.getExecutionGroup(group.id)?.description).toBe(
      input.description,
    );
    reopened.saveExecutionGroup(
      "local",
      { ...olderInput, description: "" },
      group.id,
    );
    expect(reopened.getExecutionGroup(group.id)?.description).toBe("");
  });
});
