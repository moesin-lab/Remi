import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { RelayConfigResponse, RelayEngine } from "@multiremi/core/api";

function hasGatewayBase(engine: "codex" | "claude", fragment: string) {
  try {
    if (engine === "claude") return !!JSON.parse(fragment)?.env?.ANTHROPIC_BASE_URL;
    const config = parseToml(fragment) as { model_provider?: string; model_providers?: Record<string, { base_url?: string }> };
    const providers = config.model_providers ?? {};
    const provider = config.model_provider ?? Object.keys(providers)[0];
    return !!(provider && providers[provider]?.base_url);
  } catch {
    return false;
  }
}

export function titleGatewayProtocol(config: RelayConfigResponse | undefined) {
  if (config?.codex?.hasToken && hasGatewayBase("codex", config.codex.fragment)) return "openai-chat-completions";
  if (config?.claude?.hasToken && hasGatewayBase("claude", config.claude.fragment)) return "anthropic-messages";
  return undefined;
}

/**
 * Re-indent a stored gateway fragment for the editor.
 *
 * The server keeps a fragment byte-for-byte, so one written by a script or the
 * CLI can arrive as a single line. Claude and Antigravity fragments are JSON and
 * re-indent losslessly. The daemon already parses the Codex TOML and serializes
 * it with the same library before writing config.toml, so the normalized text is
 * what actually takes effect. Text that does not parse is returned untouched so
 * the editor still shows exactly what is stored.
 */
export function formatRelayFragment(engine: RelayEngine, fragment: string): string {
  const trimmed = fragment.trim();
  if (!trimmed) return fragment;
  try {
    if (engine === "codex") return stringifyToml(parseToml(trimmed)).trimEnd();
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return fragment;
  }
}
