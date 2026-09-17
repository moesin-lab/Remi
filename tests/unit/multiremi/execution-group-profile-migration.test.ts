import { afterEach, expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import { encryptRuntimeProviderKey } from "@multiremi/runtime-provider-credentials.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

const originalKey = process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
afterEach(() => {
  if (originalKey === undefined) delete process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
  else process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = originalKey;
  resetMultiremiTestEnv();
});

it.each(["codex", "claude"])("migrates %s credentials without decryption and keeps group configuration after a member leaves", provider => {
  const store = createLocalStore();
  const runtime = store.registerRuntime({ id: "legacy", name: "Legacy", provider, ownerId: "local", executionGroupId: "shared", metadata: { [`${provider}_profiles`]: 1 } });
  const profile = { name: "custom", model: "custom-model", base_url: "https://example.com/v1", env_key: "", auth_mode: "api_key", credential_id: "rck_legacy" };
  process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString("base64");
  const ciphertext = encryptRuntimeProviderKey("legacy-test-key", { workspaceId: "local", runtimeId: runtime.id, credentialId: profile.credential_id });
  db!.run(`INSERT INTO multiremi_runtime_${provider}_profiles (runtime_id, profile) VALUES (?, ?)`, [runtime.id, JSON.stringify(profile)]);
  db!.run("INSERT INTO multiremi_runtime_provider_credentials (id, runtime_id, ciphertext) VALUES (?, ?, ?)", [profile.credential_id, runtime.id, ciphertext]);
  db!.run("DELETE FROM multiremi_schema_migrations WHERE id = 'execution_group_profiles_v1'");
  delete process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
  const migrated = new MultiremiStore(db!);
  expect(migrated.getExecutionGroupProfile("local", "shared")).toMatchObject(profile);
  expect(db!.query(`SELECT * FROM multiremi_runtime_${provider}_profiles`).all()).toEqual([]);
  expect(db!.query("SELECT ciphertext FROM multiremi_execution_group_credentials WHERE id = ?").get(profile.credential_id)).toEqual({ ciphertext });
  process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString("base64");
  expect(migrated.getRuntimeCodexProfileKey(runtime.id, profile.credential_id)).toBe("legacy-test-key");
  migrated.updateRuntime(runtime.id, { executionGroupId: null });
  expect(migrated.getRuntimeExecutionProfile(runtime.id, provider)).toBeNull();
  expect(migrated.getExecutionGroupProfile("local", "shared")).toMatchObject(profile);
  const peer = migrated.registerRuntime({ name: "Replacement", provider, executionGroupId: "shared", metadata: { [`${provider}_profiles`]: 1 } });
  expect(migrated.getRuntimeExecutionProfile(peer.id, provider)).toMatchObject(profile);
  expect(migrated.getRuntimeCodexProfileKey(peer.id, profile.credential_id)).toBe("legacy-test-key");
  const reopened = new MultiremiStore(db!);
  expect(reopened.getExecutionGroupProfile("local", "shared")).toMatchObject(profile);
});

it("splits conflicting legacy connections and preserves pinned agents and unconfigured members", () => {
  const store = createLocalStore();
  for (const id of ["a", "b", "c"]) store.registerRuntime({ id, name: id, provider: "codex", executionGroupId: "shared" });
  const pinned = store.createAgent({ name: "Pinned", provider: "codex", runtimeId: "b" });
  const pooled = store.createAgent({ name: "Grouped", provider: "codex", executionGroupId: "shared" });
  for (const id of ["a", "b"]) db!.run("INSERT INTO multiremi_runtime_codex_profiles (runtime_id, profile) VALUES (?, ?)", [id, JSON.stringify({ name: id, model: "common", base_url: `https://${id}.example/v1`, env_key: "REMI_CODEX_KEY" })]);
  db!.run("DELETE FROM multiremi_schema_migrations WHERE id = 'execution_group_profiles_v1'");
  const migrated = new MultiremiStore(db!);
  const bGroup = migrated.getRuntime("b")!.executionGroupIds![0]!;
  const aGroup = migrated.getRuntime("a")!.executionGroupIds![0]!;
  expect(bGroup).not.toBe("shared");
  expect(migrated.getExecutionGroupProfile("local", "shared")).toBeNull();
  expect(migrated.getExecutionGroupProfile("local", aGroup)?.base_url).toBe("https://a.example/v1");
  expect(migrated.getExecutionGroupProfile("local", bGroup)?.base_url).toBe("https://b.example/v1");
  expect(migrated.getRuntimeExecutionProfile("c", "codex")).toBeNull();
  expect(migrated.getAgent(pinned.id)?.executionGroupId).toBe(bGroup);
  expect(migrated.getAgent(pooled.id)?.executionGroupId).toBe("shared");
  migrated.registerRuntime({ id: "b", name: "Reconnected", provider: "codex" });
  expect(migrated.getRuntime("b")?.executionGroupIds).toEqual([bGroup]);
  const reopened = new MultiremiStore(db!);
  expect(reopened.listExecutionGroups("local")).toEqual(migrated.listExecutionGroups("local"));
});
