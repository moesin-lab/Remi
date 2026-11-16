import { parseRuntimeClaudeProfile, type RuntimeClaudeProfile } from "@multiremi/contracts/claude-profile";
import { runtimeConnectionModels } from "@multiremi/contracts/runtime-connection";
import type { MultiremiRuntimeModel } from "@multiremi/contracts/types.js";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface ClaudeProjectCredentialsOptions {
  /** Task workspace boundary; also include an enclosing Git root below the user home. */
  workspaceRoot?: string;
  /** Host user home, injectable for isolated filesystem tests. Never project configuration. */
  userHome?: string;
}

const canonicalPath = (path: string) => realpath(path).catch(() => resolve(path));
const isWithin = (root: string, path: string) => {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

async function nearestClaudeProjectRoot(cwd: string, userHome: string): Promise<string> {
  for (let directory = cwd; directory !== userHome && dirname(directory) !== directory; directory = dirname(directory)) {
    // .git can be a directory or a file (linked worktree). Do not invoke Git or read its config.
    try { await stat(join(directory, ".git")); return directory; }
    catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        throw new Error(`Cannot determine Claude project boundary at ${directory}`);
      }
    }
  }
  return cwd;
}

/** Claude applies project settings after child env. Reject credential overrides
 * before starting it instead of sending the Runtime key in SDK settings/argv. */
export async function assertRuntimeClaudeProjectCredentials(
  cwd: string,
  options: ClaudeProjectCredentialsOptions = {},
): Promise<void> {
  let directory = await canonicalPath(cwd);
  const userHome = await canonicalPath(options.userHome ?? homedir());
  let root = options.workspaceRoot ? await canonicalPath(options.workspaceRoot) : directory;
  if (!isWithin(root, directory)) throw new Error("Claude project cwd is outside its workspace boundary");
  const gitRoot = await nearestClaudeProjectRoot(directory, userHome);
  // A registered workspace can be a subdirectory of a repository. Claude's
  // local settings may still come from that Git root, so include it too.
  if (isWithin(gitRoot, root)) root = gitRoot;
  // Even an explicitly registered home directory is user configuration. Do not
  // visit it or shared ancestors; CLAUDE_CONFIG_DIR isolates that settings tier.
  for (; directory !== userHome && dirname(directory) !== directory;) {
    for (const name of ["settings.json", "settings.local.json"]) {
      const path = join(directory, ".claude", name);
      let text: string;
      try { text = await readFile(path, "utf8"); }
      catch (error) {
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
        throw new Error(`Cannot read Claude project settings at ${path}`);
      }
      let settings: Record<string, unknown>;
      try { settings = JSON.parse(text.replace(/^\uFEFF/, "")); }
      catch { throw new Error(`Cannot validate Claude project settings at ${path}; fix its JSON before using a Runtime connection`); }
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) continue;
      const env = settings.env && typeof settings.env === "object" ? settings.env : {};
      const conflicts = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"]
        .filter(key => Object.prototype.hasOwnProperty.call(env, key));
      if (Object.prototype.hasOwnProperty.call(settings, "apiKeyHelper")) conflicts.push("apiKeyHelper");
      if (conflicts.length) throw new Error(`Claude project credentials conflict with the Runtime connection: remove ${conflicts.join(", ")} from ${path} and configure credentials in Runtime instead`);
    }
    if (directory === root) return;
    directory = dirname(directory);
  }
}

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
    ANTHROPIC_CUSTOM_HEADERS: Object.entries(profile.endpoint_options?.headers ?? {}).map(([name, value]) => `${name}: ${value}`).join("\n"),
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

export function runtimeClaudeProfileModels(profile: RuntimeClaudeProfile, models: MultiremiRuntimeModel[] = []) {
  return runtimeConnectionModels(profile, "claude", models);
}
