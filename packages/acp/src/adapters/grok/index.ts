/** Grok Build adapter for its native ACP-over-stdio agent mode. */
import type {
  AgentAdapter,
  AgentPromptResultMetadata,
  AgentSessionOptions,
  AskUserQuestionData,
  InitializeResult,
  NewSessionMeta,
  PromptResult,
  ToolCallProgressUpdate,
  ToolCallUpdate,
} from "@shared/contracts/acp-protocol.js";
import { canonicalToolName, titleToToolName } from "../tool-name.js";

const USD_TICKS_PER_DOLLAR = 10_000_000_000;

export class GrokAdapter implements AgentAdapter {
  readonly agentType = "grok";
  readonly promptUsageSettleScope = "turn" as const;
  readonly sessionRestoreMethod = "load" as const;
  readonly sessionPermissionModeMethod = "session-meta" as const;
  readonly modelSelectionMethod = "set-model" as const;

  buildLaunchArgs(args: string[]): string[] {
    return ["--no-auto-update", "agent", ...args, "stdio"];
  }

  buildInitializeMeta(options: AgentSessionOptions): Record<string, unknown> {
    return {
      ...(options.systemPrompt?.trim() ? { rules: options.systemPrompt.trim() } : {}),
      startupHints: {
        nonInteractive: true,
        skipGitStatus: true,
        skipProjectLayout: true,
      },
    };
  }

  selectAuthentication(
    result: InitializeResult,
    env: Readonly<Record<string, string | undefined>>,
  ): { methodId: string; meta: Record<string, unknown> } | null {
    const methods = new Set((result.authMethods ?? []).map((method) => method.id));
    if (methods.size === 0) return null;
    const defaultMethod = stringValue(asRecord(result._meta)?.defaultAuthMethodId);
    if (
      defaultMethod && methods.has(defaultMethod) &&
      (defaultMethod === "cached_token" || defaultMethod === "xai.api_key")
    ) {
      return { methodId: defaultMethod, meta: { headless: true } };
    }
    if (env.XAI_API_KEY?.trim() && methods.has("xai.api_key")) {
      return { methodId: "xai.api_key", meta: { headless: true } };
    }
    if (methods.has("cached_token")) {
      return { methodId: "cached_token", meta: { headless: true } };
    }
    if (methods.has("xai.api_key")) {
      throw new Error("Grok CLI requires XAI_API_KEY or a cached `grok login` session");
    }
    throw new Error(`Grok CLI exposes no headless authentication method (${[...methods].join(", ")})`);
  }

  buildSessionMeta(options: AgentSessionOptions): NewSessionMeta {
    if (options.allowedTools?.length) {
      console.warn(
        `[acp:grok] ignoring allowedTools (${options.allowedTools.join(", ")}): Grok ACP exposes permission policy, not a tool allowlist`,
      );
    }
    return { yoloMode: options.permissionMode === "bypassPermissions" };
  }

  normalizePromptResult(result: PromptResult): AgentPromptResultMetadata {
    const meta = asRecord(result._meta);
    const rawUsage = asRecord(meta?.usage) ?? meta;
    if (!rawUsage) return {};

    let inputTokens = finite(rawUsage.inputTokens);
    const outputTokens = finite(rawUsage.outputTokens);
    const cacheReadTokens = finite(rawUsage.cachedReadTokens ?? rawUsage.cacheReadTokens);
    const cacheWriteTokens = finite(rawUsage.cachedWriteTokens ?? rawUsage.cacheWriteTokens);
    const totalTokens = finite(rawUsage.totalTokens);

    // Grok's input count can include cached reads. Only rebucket when its own
    // total proves that shape, avoiding an accidental double subtraction.
    if (
      inputTokens != null && outputTokens != null && totalTokens === inputTokens + outputTokens &&
      cacheReadTokens != null && cacheReadTokens <= inputTokens
    ) {
      inputTokens -= cacheReadTokens;
    }

    const costTicks = finite(rawUsage.costUsdTicks ?? meta?.costUsdTicks);
    const model = stringValue(meta?.modelId ?? meta?.model_id);
    return {
      usage: {
        inputTokens,
        outputTokens,
        cachedReadTokens: cacheReadTokens,
        cachedWriteTokens: cacheWriteTokens,
        totalTokens,
      },
      model,
      costUsd: costTicks == null ? null : costTicks / USD_TICKS_PER_DOLLAR,
    };
  }

  resolveToolName(update: ToolCallUpdate | ToolCallProgressUpdate): string {
    const legacy = update as ToolCallUpdate & { name?: unknown };
    const raw = asRecord(update.rawInput) ?? asRecord((update as { parameters?: unknown }).parameters);
    const name = stringValue(legacy.name) ?? stringValue(raw?.toolName ?? raw?.tool_name ?? raw?.name);
    if (name) return canonicalToolName(name) ?? titleToToolName(name);
    return titleToToolName(update.title ?? update.kind ?? "unknown");
  }

  extractToolInput(update: ToolCallUpdate | ToolCallProgressUpdate): Record<string, unknown> | undefined {
    const raw = asRecord(update.rawInput) ?? asRecord((update as { parameters?: unknown }).parameters);
    return raw ? { ...raw } : undefined;
  }

  extractResultPreview(update: ToolCallProgressUpdate): string | undefined {
    const legacyOutput = (update as ToolCallProgressUpdate & { output?: unknown }).output;
    const raw = update.rawOutput ?? legacyOutput;
    if (raw != null) return truncate(preview(raw));
    const text = (update.content ?? [])
      .flatMap((item) => item.type === "content" && item.content.type === "text" ? [item.content.text] : [])
      .join("\n")
      .trim();
    return text ? truncate(text) : undefined;
  }

  extractAskUserQuestion(_toolCall: ToolCallProgressUpdate): AskUserQuestionData | null {
    return null;
  }

  isExitPlanMode(_toolCall: ToolCallProgressUpdate): boolean {
    return false;
  }

  defaultExecutable(): string {
    return "grok";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try { return asRecord(JSON.parse(value)); } catch { return undefined; }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return value != null && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function preview(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function truncate(value: string): string {
  return value.length > 800 ? `${value.slice(0, 800)}\n... (truncated)` : value;
}
