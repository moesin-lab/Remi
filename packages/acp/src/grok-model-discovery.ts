import type { AgentAdapter } from "@shared/contracts/acp-protocol.js";
import type { AcpClient } from "./client.js";
import type { AcpModelCapability } from "./provider.js";
import { record } from "./session-failure.js";

export async function discoverGrokModelCapabilities(
  client: AcpClient,
  adapter: AgentAdapter,
  env: Readonly<Record<string, string | undefined>>,
): Promise<AcpModelCapability[]> {
  const initialized = await client.initialize(adapter.buildInitializeMeta?.({}));
  const authentication = adapter.selectAuthentication?.(initialized, env);
  if (authentication) await client.authenticate(authentication.methodId, authentication.meta);

  let state = record(initialized._meta?.modelState);
  if (!Array.isArray(state?.availableModels) || state.availableModels.length === 0) {
    const response = record(await client.listGrokModels());
    if (response?.error != null) throw new Error("Grok model catalog could not be listed");
    state = record(response?.result);
  }
  if (!Array.isArray(state?.availableModels) || state.availableModels.length === 0) {
    throw new Error("Grok model catalog is empty or invalid");
  }

  return state.availableModels.map((value): AcpModelCapability => {
    const model = record(value);
    if (typeof model?.modelId !== "string" || !model.modelId.trim()) {
      throw new Error("Grok model catalog contains an invalid model");
    }
    const meta = record(model._meta);
    const supported = meta?.supportsReasoningEffort;
    const advertised = meta?.reasoningEfforts;
    if (advertised !== undefined && !Array.isArray(advertised)) {
      throw new Error("Grok model catalog contains invalid reasoning levels");
    }
    const levels = (supported === false ? [] : advertised ?? []).map((value: unknown) => {
      const level = record(value);
      if (typeof level?.value !== "string" || !level.value.trim()) {
        throw new Error("Grok model catalog contains an invalid reasoning level");
      }
      return {
        value: level.value,
        label: typeof level.label === "string" ? level.label
          : typeof level.name === "string" ? level.name : level.value,
        ...(typeof level.description === "string" ? { description: level.description } : {}),
        default: level.default === true,
      };
    });
    const defaultLevel = levels.find(level => level.default)?.value;
    return {
      id: model.modelId,
      label: typeof model.name === "string" && model.name ? model.name : model.modelId,
      ...(typeof model.description === "string" ? { description: model.description } : {}),
      default: model.modelId === state.currentModelId,
      effort: {
        status: levels.length ? "supported"
          : supported === false || advertised !== undefined ? "unsupported" : "unknown",
        ...(defaultLevel ? { defaultLevel } : {}),
        supportedLevels: levels.map(({ default: _default, ...level }) => level),
      },
    };
  });
}
