import { parseRuntimeClaudeProfile, type RuntimeClaudeProfile } from "@multiremi/contracts/claude-profile";

/** Non-secret routing applied to both the isolated settings and child environment. */
export function runtimeClaudeProfileRouting(profile: RuntimeClaudeProfile): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: profile.base_url,
    ANTHROPIC_MODEL: profile.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: profile.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: profile.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: profile.model,
    CLAUDE_CODE_SUBAGENT_MODEL: profile.model,
    CLAUDE_CODE_USE_BEDROCK: "0",
    CLAUDE_CODE_USE_VERTEX: "0",
    CLAUDE_CODE_USE_FOUNDRY: "0",
    CLAUDE_MODEL_CONFIG: "",
    ANTHROPIC_CUSTOM_HEADERS: "",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

export function runtimeClaudeProfileEnv(profile: RuntimeClaudeProfile, token: string): Record<string, string> {
  return {
    ...runtimeClaudeProfileRouting(profile),
    ANTHROPIC_API_KEY: profile.auth_header === "x-api-key" ? token : "",
    ANTHROPIC_AUTH_TOKEN: profile.auth_header === "x-api-key" ? "" : token,
    CLAUDE_CODE_OAUTH_TOKEN: "",
  };
}

export function resolveRuntimeClaudeProfile(input: RuntimeClaudeProfile, env: NodeJS.ProcessEnv = process.env, apiKey?: string) {
  const profile = parseRuntimeClaudeProfile(input)!;
  const token = (profile.auth_mode === "api_key" ? apiKey : env[profile.env_key])?.trim();
  if (!token) throw new Error(profile.auth_mode === "api_key" ? "Claude profile API key is unavailable" : `Claude profile requires ${profile.env_key} in the Runtime process environment; configure it and restart the Runtime`);
  return {
    fragment: JSON.stringify({ model: profile.model, env: runtimeClaudeProfileRouting(profile) }),
    auth_token: token,
    revision: 0,
  };
}

export function runtimeClaudeProfileModels(profile: RuntimeClaudeProfile) {
  return [{ id: profile.model, label: profile.model, provider: "claude", default: true }];
}
