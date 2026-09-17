import { expect, it } from "bun:test";
import { parseRuntimeCodexProfile } from "@multiremi/contracts/codex-profile";
import { runtimeConnectionModels } from "@multiremi/contracts/runtime-connection";

const profile = { name: "custom", base_url: "https://example.com/v1", model: "first", env_key: "REMI_CODEX_KEY" };

it("supports a connection model allowlist while retaining reported capabilities", () => {
  const connection = parseRuntimeCodexProfile({ ...profile, models: ["first", "second"] })!;
  expect(runtimeConnectionModels(connection, "codex", [
    { id: "second", label: "Second", thinking: { supported_levels: [{ value: "high", label: "High" }] } },
    { id: "unrelated", label: "Unrelated" },
  ])).toMatchObject([
    { id: "first", label: "first", provider: "codex", default: true },
    { id: "second", label: "Second", provider: "codex", default: false, thinking: { supported_levels: [{ value: "high", label: "High" }] } },
  ]);
  expect(runtimeConnectionModels(parseRuntimeCodexProfile(profile)!, "codex", [])).toHaveLength(1);
});

it("rejects invalid model allowlists", () => {
  for (const models of [[], ["second"], ["first", "first"], ["first", " "], ["first", 3], "first", ["first", "bad\nmodel"]]) {
    expect(() => parseRuntimeCodexProfile({ ...profile, models })).toThrow();
  }
});
