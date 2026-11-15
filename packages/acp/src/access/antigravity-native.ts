import { isAbsolute } from "node:path";
import { ANTIGRAVITY_ACCESS, ANTIGRAVITY_BLANKED_ENV } from "./antigravity.js";
import type { AcpAccessConfig, AcpAccessEnvInput, AcpLaunchCommand } from "./types.js";

/** Local login is an explicit connection, never a fallback from gateway auth. */
export function nativeAntigravityLaunch(home?: string, permissionMode?: string, executable?: string): AcpLaunchCommand {
  if (!home || !isAbsolute(home)) throw new Error("[antigravity_home_required] Local Antigravity needs an absolute session home");
  return {
    executable: executable?.trim() || "agy",
    args: ["acp", "--stdio", "--gemini-dir", home, "--app-data-dir", "antigravity-cli",
      "--include-default-customizations=false",
      ...(["bypassPermissions", "dontAsk"].includes(permissionMode ?? "") ? ["--dangerously-skip-permissions"] : [])],
  };
}

export function buildNativeAntigravityEnv(input: AcpAccessEnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ANTIGRAVITY_BLANKED_ENV) env[key] = "";
  for (const key of Object.keys(input.daemonEnv)) {
    if (key.startsWith("AGY_") || key.startsWith("ANTIGRAVITY_")) env[key] = "";
  }
  return { ...env, GEMINI_HOME: input.home, BROWSER: "/usr/bin/false",
    AGY_ACP_ENABLE_GATEWAY_AUTH: "", AGY_LLM_GATEWAY_URL: "", AGY_LLM_GATEWAY_API_KEY: "" };
}

export const ANTIGRAVITY_NATIVE_ACCESS: AcpAccessConfig = {
  ...ANTIGRAVITY_ACCESS,
  launch: () => ({ executable: "agy", args: ["acp", "--stdio"] }),
  healthProblem: () => Bun.which("agy", { PATH: process.env.PATH }) ? null : "Local Antigravity requires agy on PATH",
  retiredExecutables: [],
  buildEnv: buildNativeAntigravityEnv,
  modelRequired: false,
  effort: "selector",
  usage: "bridge",
  turnStallTimeoutMs: null,
};
