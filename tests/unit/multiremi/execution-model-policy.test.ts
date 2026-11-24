import { blockExecutionGroupCatalog, executionEndpointGroupCatalog } from "@multiremi/store/runtime-model-catalog.js";
import { expect, it } from "bun:test";
import { parseExecutionModelPolicy, executionModelPolicyReason } from "@multiremi/contracts/execution-endpoint.js";

it("validates exact block IDs and preserves existing allowlist/default semantics", () => {
  expect(parseExecutionModelPolicy(undefined)).toEqual({});
  expect(parseExecutionModelPolicy({ blocked_models: [] })).toEqual({});
  const policy = parseExecutionModelPolicy({ model: "Keep", models: ["Keep", "hide"], blocked_models: ["hide", "future"] });
  expect(executionModelPolicyReason(policy, "hide")).toBe("model_blocked_by_policy");
  expect(executionModelPolicyReason(policy, "Keep")).toBeNull();
  expect(executionModelPolicyReason({ blocked_models: ["hide"] }, "Hide")).toBeNull();
  expect(executionModelPolicyReason(policy, "other")).toBe("model_not_allowed_by_policy");
  expect(() => parseExecutionModelPolicy({ model: "hide", blocked_models: ["hide"] })).toThrow("model_policy.model");
  expect(() => parseExecutionModelPolicy({ model: "other", models: ["Keep"] })).toThrow("allowlist");
  for (const blocked_models of [["a", "a"], [""], [" a"], ["a\n"], [12], "a", Array.from({ length: 201 }, (_, i) => `${i}`)])
    expect(() => parseExecutionModelPolicy({ blocked_models })).toThrow("blocked_models");
});

it("filters every member with the same policy before intersection and preserves ready-empty catalogs", () => {
  const group = { id: "g", provider: "codex", runtimeIds: ["a", "b"], modelPolicy: { models: ["keep", "hide"], blocked_models: ["hide"] } };
  const snapshot = (id: string) => ({ status: "ready" as const, models: (id === "a" ? ["hide", "keep", "only-a"] : ["hide", "keep"])
    .map(id => ({ id, label: id, provider: "codex", default: id === "hide" })) });
  const catalog = executionEndpointGroupCatalog(group, snapshot);
  expect(catalog.models.map(model => model.id)).toEqual(["keep"]);
  expect(catalog.models[0]?.default).toBe(true);
  const empty = executionEndpointGroupCatalog({ ...group, modelPolicy: { blocked_models: ["hide", "keep", "only-a"] } }, snapshot);
  expect(empty.model_catalog_status).toBe("ready");
  expect(empty.models).toEqual([]);
});

it("leaves legacy catalogs unchanged without blocks and removes blocked fixed models", () => {
  const catalog = { provider: "codex", online_runtime_count: 1, models: [{ id: "fixed", label: "Fixed", default: true }] };
  expect(blockExecutionGroupCatalog(catalog, {})).toBe(catalog);
  expect(blockExecutionGroupCatalog(catalog, { blocked_models: ["fixed"] }).models).toEqual([]);
});
