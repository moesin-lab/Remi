import { describe, expect, it } from "bun:test";
import { catalogAllowsModel, runtimeTargetModelCatalog, type RuntimeModelCatalogSource } from "@multiremi/store/runtime-model-catalog.js";
import type { MultiremiRuntime } from "@multiremi/contracts/types.js";

const legacyProfile = { name: "legacy", base_url: "https://legacy.example/v1", model: "same-model", env_key: "REMI_CODEX_KEY" };
const centralProfile = { ...legacyProfile, name: "central", base_url: "https://central.example/v1" };
const source = {
  getRuntimeExecutionProfile: () => legacyProfile,
  getRelayModelDiscovery: () => false,
  listGatewayModelReasoning: () => [],
} as unknown as RuntimeModelCatalogSource;
const runtime = {
  id: "runtime", provider: "codex", status: "online", ownerId: "owner", visibility: "private",
  models: [{ id: "same-model", label: "Legacy model", provider: "codex", default: true,
    thinking: { supportedLevels: [{ value: "high", label: "High" }] } }],
} as MultiremiRuntime;

describe("central execution profile model catalogs", () => {
  it("keeps legacy behavior when no group override is supplied", () => {
    const catalog = runtimeTargetModelCatalog(source, "workspace", runtime);
    expect(catalog[0]?.models[0]?.thinking?.supported_levels).toEqual([{ value: "high", label: "High" }]);
  });

  it("does not copy capabilities from an unrelated endpoint with the same model ID", () => {
    const catalog = runtimeTargetModelCatalog(source, "workspace", runtime, centralProfile);
    expect(catalog[0]?.models).toEqual([{ id: "same-model", label: "same-model", provider: "codex", default: true }]);
  });

  it("uses the central model even when the machine reports a different legacy model", () => {
    const catalog = runtimeTargetModelCatalog(source, "workspace", runtime, { ...centralProfile, model: "central-model" });
    expect(catalog[0]?.models.map(model => model.id)).toEqual(["central-model"]);
  });

  it("treats an explicit null as default connection instead of restoring the legacy profile", () => {
    expect(runtimeTargetModelCatalog(source, "workspace", runtime, null)[0]?.models).toEqual([]);
  });

  it("retains default machine models when there is no legacy connection to exclude", () => {
    const noLegacy = { ...source, getRuntimeExecutionProfile: () => null };
    expect(runtimeTargetModelCatalog(noLegacy, "workspace", runtime, null)[0]?.models[0]?.id).toBe("same-model");
  });
  it("does not inherit another connection's failed native catalog or default effort", () => {
    const failed = { ...runtime, models: [{ ...runtime.models[0]!,
      catalog: { status: "error" as const, error: "Old endpoint failed" },
      thinking: { status: "error" as const, supportedLevels: [], error: "Old endpoint failed" },
    }] };
    const catalog = runtimeTargetModelCatalog(source, "workspace", failed, centralProfile)[0]!;
    expect(catalog.runtime_catalog_status).toBeUndefined();
    expect(catalog.default_thinking?.status).not.toBe("error");
    expect(catalogAllowsModel(catalog, centralProfile.model)).toBe(true);
    expect(catalog.models[0]?.thinking).toBeUndefined();
  });

  it("preserves the full discovered directory only for an equivalent connection", () => {
    const discovered = { ...runtime, models: [...runtime.models,
      { id: "another-model", label: "Another", provider: "codex", default: false,
        thinking: { supportedLevels: [{ value: "low", label: "Low" }] } },
    ] };
    const same = runtimeTargetModelCatalog(source, "workspace", discovered, { ...legacyProfile, name: "renamed" })[0]!;
    expect(same.models.map(model => model.id)).toEqual(["same-model", "another-model"]);
    expect(same.models[1]?.thinking?.supported_levels).toEqual([{ value: "low", label: "Low" }]);
    const different = runtimeTargetModelCatalog(source, "workspace", discovered, centralProfile)[0]!;
    expect(different.models.map(model => model.id)).toEqual(["same-model"]);
  });

});
