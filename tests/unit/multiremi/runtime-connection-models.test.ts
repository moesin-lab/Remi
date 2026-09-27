import { expect, it } from "bun:test";
import { parseRuntimeConnectionProfile, runtimeConnectionModels, runtimeConnectionSnapshot } from "@multiremi/contracts/runtime-connection";

const profile = { name: "custom", base_url: "http://127.0.0.1:8000/v1", model: "configured", env_key: "REMI_CODEX_TEST_KEY" };

it("keeps discovered alternatives and their exact capabilities without changing the configured default", () => {
  const models = [
    { id: "alternative", label: "Alternative", default: true, thinking: { supportedLevels: [{ value: "low", label: "Low" }] } },
    { id: "configured", label: "Configured", default: false, thinking: { supportedLevels: [{ value: "high", label: "High" }] } },
  ];
  expect(runtimeConnectionModels(profile, "codex", models)).toEqual([
    { ...models[1], provider: "codex", default: true },
    { ...models[0], provider: "codex", default: false },
  ]);
  expect(models[0]!.default).toBe(true);
  expect(models[1]!.default).toBe(false);
});

it("retains an omitted configured alias without borrowing another model's capabilities", () => {
  const alternative = { id: "alternative", label: "Alternative", thinking: { supportedLevels: [{ value: "high", label: "High" }] } };
  expect(runtimeConnectionModels(profile, "codex", [alternative])).toEqual([
    { id: "configured", label: "configured", provider: "codex", default: true },
    { ...alternative, provider: "codex", default: false },
  ]);
});

it("uses an explicit allowlist while preserving exact reported capabilities", () => {
  const models = [
    { id: "allowed", label: "Allowed", thinking: { supportedLevels: [{ value: "high", label: "High" }] } },
    { id: "hidden", label: "Hidden", thinking: { supportedLevels: [{ value: "low", label: "Low" }] } },
  ];
  expect(runtimeConnectionModels({ ...profile, models: ["configured", "allowed", "declared"] }, "codex", models)).toEqual([
    { id: "configured", label: "configured", provider: "codex", default: true },
    { ...models[0], provider: "codex", default: false },
    { id: "declared", label: "declared", provider: "codex", default: false },
  ]);
});

it("validates allowlists and strips them from daemon/task snapshots", () => {
  const allowed = parseRuntimeConnectionProfile({ ...profile, models: ["configured", "allowed"] }, "REMI_CODEX_")!;
  expect(runtimeConnectionSnapshot(allowed, "allowed")).toEqual({ ...profile, model: "allowed", auth_mode: "env" });
  expect(runtimeConnectionSnapshot(allowed, "hidden")?.model).toBe("configured");
  expect(runtimeConnectionSnapshot(profile, "discovered")?.model).toBe("discovered");
  expect(() => parseRuntimeConnectionProfile({ ...profile, models: ["allowed"] }, "REMI_CODEX_")).toThrow("including the default model");
  expect(() => parseRuntimeConnectionProfile({ ...profile, models: ["configured", "configured"] }, "REMI_CODEX_")).toThrow("unique model IDs");
});
