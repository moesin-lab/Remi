import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { mergeCodexSkillSettings } from "../agent-plugins/codex-home.js";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseEnv } from "node:util";
import { parse as parseYaml } from "yaml";
import type { AgentTask } from "@daemon/contracts/types.js";
import type { IssueSessionProviderHome } from "./session-home.js";
import { LocalDirectoryError } from "./ephemeral.js";

const MAX_FILE_BYTES = 256 * 1024;
// Leave room for provider-discovered project instructions in Codex's default budget.
const MAX_CONTEXT_BYTES = 24 * 1024;
/** The whole `AGENTS.md`: Remi's notes get what the local context leaves, up to their own cap. */
export const PROVIDER_INSTRUCTIONS_MAX_BYTES = 48 * 1024;
const REMI_INSTRUCTIONS_MAX_BYTES = 32 * 1024;
const LOCAL_CONTEXT_HEADING = "# Runtime workspace local context";
/** The first line of every `AGENTS.md` Remi writes; it tells Remi's own file from anyone else's. */
export const PROVIDER_INSTRUCTIONS_MARKER = "<!-- Written by Remi for this session and rewritten before every turn; edits do not persist. -->";
/** Claude reads only `CLAUDE.md` from its config dir; this one imports the shared file. */
const CLAUDE_IMPORT = "@AGENTS.md\n";

/** Paths are registered centrally; contents are read only here, on the owning host. */
export function prepareRuntimeWorkspaceContext(
  task: AgentTask,
  providerHome: IssueSessionProviderHome,
  workDir: string,
  options: { baseHome?: string; userHome?: string } = {},
): Record<string, string> {
  const context = runtimeWorkspaceContext(task, providerHome, workDir, options);
  if (!context) return {};
  writeProviderInstructions(providerHome, { local: context.instructions });
  return context.env;
}

/**
 * The runtime workspace's local instructions and env file, read on this host:
 * instruction files from the workspace root down to the working directory and
 * the registered context paths, with the workspace's own skill catalog. Explicit
 * Codex development workspaces retain their user's native guidance and Skill settings;
 * other providers do not inherit personal instructions or skills (ADR 0023).
 * The instructions are never sent to the server; the caller writes them into the
 * provider home with {@link writeProviderInstructions}.
 */
export function runtimeWorkspaceContext(
  task: AgentTask,
  providerHome: IssueSessionProviderHome,
  workDir: string,
  options: { baseHome?: string; userHome?: string } = {},
): { instructions: string; env: Record<string, string> } | null {
  const workspace = task.runtimeWorkspace;
  if (!workspace) return null;
  const root = realpathSync(workspace.rootPath);
  const cwd = containedPath(root, workDir);
  const sections: string[] = [];
  const seen = new Set<string>();
  const codex = providerHome.provider === "codex";
  const nativeSkillRoots: Record<string, string> = {};
  const userHome = options.userHome ?? homedir();
  const userCodexHome = join(userHome, ".codex");
  const baseHome = options.baseHome ?? process.env.CODEX_HOME ?? userCodexHome;
  const instructionNames = providerHome.provider === "codex"
    ? ["AGENTS.override.md", "AGENTS.md", "AGENT.md"] : providerHome.provider === "antigravity" || providerHome.provider === "grok"
      ? ["AGENTS.md", "AGENT.md"] : ["CLAUDE.md", "AGENTS.md", "AGENT.md"];

  const addInstructions = (file: string, boundary?: string) => {
    if (!existsSync(file)) return;
    const canonical = boundary ? containedPath(boundary, file) : realpathSync(file);
    if (seen.has(canonical)) return;
    seen.add(canonical);
    sections.push(`\n## Local instructions: ${file}\n${readText(canonical)}`);
  };
  const addSkills = (directory: string, boundary: string) => {
    if (!existsSync(directory)) return;
    const canonical = containedPath(boundary, directory);
    const files = existsSync(join(canonical, "SKILL.md")) ? [join(canonical, "SKILL.md")]
      : readdirSync(canonical).sort().map(name => join(canonical, name, "SKILL.md")).filter(existsSync);
    if (files.length > 256) throw new LocalDirectoryError("Runtime workspace skill directory exceeds 256 skills");
    for (const file of files) {
      const source = containedPath(boundary, file);
      if (seen.has(source)) continue;
      seen.add(source);
      const content = readText(source);
      const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const metadata = frontmatter ? parseYaml(frontmatter[1]!, { maxAliasCount: 0 }) : {};
      const name = typeof metadata?.name === "string" ? metadata.name : basename(dirname(source));
      const description = typeof metadata?.description === "string" ? metadata.description : "Read SKILL.md when relevant.";
      sections.push(`- Skill ${JSON.stringify(name)}: ${JSON.stringify(description)}. Read ${JSON.stringify(source)}; resolve supporting files beside that file.`);
    }
  };

  const addNativeSkills = (key: string, directory: string, boundary?: string) => {
    if (!existsSync(directory)) return;
    const canonical = boundary ? containedPath(boundary, directory) : realpathSync(directory);
    if (!statSync(canonical).isDirectory()) throw new LocalDirectoryError("Runtime workspace skill root must be a directory");
    if (boundary) validateNativeSkillPaths(canonical, boundary);
    nativeSkillRoots[key] = canonical;
  };

  if (codex) {
    // The explicit development workspace keeps native user guidance while its history stays isolated.
    const globalHome = instructionNames.some(name => existsSync(join(baseHome, name))) ? baseHome : userCodexHome;
    const global = instructionNames.find(name => existsSync(join(globalHome, name)));
    if (global) addInstructions(join(globalHome, global));
    addNativeSkills("user", join(userCodexHome, "skills"));
    if (resolve(baseHome) !== resolve(userCodexHome)) addNativeSkills("provider", join(baseHome, "skills"));
  }

  // Codex discovers workspace skills natively; other providers need a local catalog.
  if (!codex) sections.push("\n## Local skills\nWhen a listed skill is relevant, read its original SKILL.md and follow its instructions before working.");
  const ancestors = workspaceAncestors(root, cwd);
  const nativeInstructionRoot = codex ? codexProjectRoot(cwd) : null;
  for (const directory of ancestors) {
    const file = instructionNames.find(name => existsSync(join(directory, name)));
    // Git-root -> cwd instructions are already loaded by native Codex; AGENT.md is a legacy fallback.
    if (file && (!codex || file === "AGENT.md" || !isWithin(nativeInstructionRoot!, directory))) addInstructions(join(directory, file), root);
    if (codex) {
      const skills = join(directory, ".agents", "skills");
      if (existsSync(skills)) validateNativeSkillPaths(containedPath(root, skills), root);
    } else addSkills(join(directory, ".agents", "skills"), root);
    if (providerHome.provider === "claude") addSkills(join(directory, ".claude", "skills"), root);
    if (providerHome.provider === "grok") addSkills(join(directory, ".grok", "skills"), root);
  }
  for (const [index, source] of workspace.contextPaths.entries()) {
    const path = containedPath(root, resolve(root, source));
    if (statSync(path).isDirectory()) {
      if (codex) addNativeSkills(`context-${index}`, path, root);
      else addSkills(path, root);
    }
    else addInstructions(path, root);
  }
  const content = `${LOCAL_CONTEXT_HEADING}\nInstructions below are ordered from ${codex ? "user to " : ""}workspace root to working directory. More specific directory instructions take precedence.\n${sections.join("\n")}\n`;
  if (Buffer.byteLength(content) > MAX_CONTEXT_BYTES) {
    throw new LocalDirectoryError("Runtime workspace local context exceeds 24 KiB; reduce instruction files or the skill catalog");
  }
  if (codex) {
    reconcileNativeSkillRoots(providerHome.home, nativeSkillRoots);
    const source = join(userCodexHome, "config.toml");
    if (existsSync(source)) {
      const target = join(providerHome.home, "config.toml");
      assertUnlinkedFile(target);
      writeFileSync(target, mergeCodexSkillSettings(readText(target), readText(source)), { mode: 0o600 });
    }
  }
  return { instructions: content, env: runtimeWorkspaceEnv(task, root, providerHome.provider) };
}

/** What Remi's notes may use of `AGENTS.md` next to `local`. */
export function remiInstructionsBudget(local: string | null | undefined): number {
  const marker = Buffer.byteLength(PROVIDER_INSTRUCTIONS_MARKER) + 2;
  return Math.min(REMI_INSTRUCTIONS_MAX_BYTES, PROVIDER_INSTRUCTIONS_MAX_BYTES - marker - (local ? Buffer.byteLength(local) + 1 : 0));
}

/** The session's `AGENTS.md`, in its provider home (`CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `GEMINI_HOME`). */
export function providerInstructionsPath(providerHome: IssueSessionProviderHome): string {
  return join(providerHome.home, "AGENTS.md");
}

/**
 * Write the provider's own instruction file in its daemon-owned home (ADR 0023):
 * `AGENTS.md` with Remi's notes first, then the runtime workspace's local
 * context; for Claude also `CLAUDE.md`, which imports it. Never a working
 * directory or a local project folder. Each file is replaced atomically and only
 * when its content changed; with neither part, the files Remi wrote are removed.
 * Returns the `AGENTS.md` content now in effect.
 */
export function writeProviderInstructions(
  providerHome: IssueSessionProviderHome,
  parts: { remi?: string | null; local?: string | null },
): string | null {
  const body = [parts.remi, parts.local].filter((part): part is string => Boolean(part?.trim()))
    .map(part => part.endsWith("\n") ? part : `${part}\n`).join("\n");
  const agents = providerInstructionsPath(providerHome);
  const claude = providerHome.provider === "claude" ? join(providerHome.home, "CLAUDE.md") : null;
  if (!body) {
    removeOwnFile(agents, current => current.startsWith(PROVIDER_INSTRUCTIONS_MARKER) || current.startsWith(LOCAL_CONTEXT_HEADING));
    if (claude) removeOwnFile(claude, current => current === CLAUDE_IMPORT || current.startsWith(LOCAL_CONTEXT_HEADING));
    return null;
  }
  const content = `${PROVIDER_INSTRUCTIONS_MARKER}\n\n${body}`;
  if (Buffer.byteLength(content) > PROVIDER_INSTRUCTIONS_MAX_BYTES) {
    throw new LocalDirectoryError("Provider instructions exceed 48 KiB; reduce instruction files or the skill catalog");
  }
  writeOwnFile(agents, content);
  if (claude) writeOwnFile(claude, CLAUDE_IMPORT);
  return content;
}

/** A model can rewrite its own home; Remi never writes through a link it finds there. */
function ownFileStat(path: string): ReturnType<typeof lstatSync> | null {
  const stat = lstatSync(path, { throwIfNoEntry: false }) ?? null;
  if (stat && (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1)) {
    throw new LocalDirectoryError("Runtime workspace provider instructions must be an unlinked regular file");
  }
  return stat;
}

function writeOwnFile(path: string, content: string): void {
  if (ownFileStat(path) && readFileSync(path, "utf8") === content) return;
  const temporary = `${path}.remi-${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function removeOwnFile(path: string, ours: (content: string) => boolean): void {
  if (ownFileStat(path) && ours(readFileSync(path, "utf8"))) unlinkSync(path);
}

function runtimeWorkspaceEnv(task: AgentTask, root: string, provider: IssueSessionProviderHome["provider"]): Record<string, string> {
  const workspace = task.runtimeWorkspace!;
  if (!workspace.envFile) return {};
  const env = parseEnv(readText(containedPath(root, resolve(root, workspace.envFile))));
  // Runtime/task identity and provider homes/routing stay authoritative.
  // Antigravity also owns its home, gateway routing and Google credentials
  // (blanked by its environment builder); other providers may use Google tools.
  const antigravity = provider === "antigravity";
  for (const key of Object.keys(env)) {
    if (/^(MULTIREMI_|CODEX_HOME$|CLAUDE_CONFIG_DIR$|OPENAI_|ANTHROPIC_)/i.test(key)
      || (antigravity && /^(GEMINI_HOME$|GEMINI_API_KEY$|AGY_|GOOGLE_|ANTIGRAVITY_)/i.test(key))) {
      throw new LocalDirectoryError(`Runtime workspace env file cannot override ${key}`);
    }
  }
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** The pinned bridge discovers <additional-directory>/.agents/skills natively. */
export function codexRuntimeWorkspaceDirectories(task: AgentTask, workDir: string, providerHome?: IssueSessionProviderHome): string[] {
  const root = realpathSync(task.runtimeWorkspace!.rootPath);
  const cwd = containedPath(root, workDir);
  const ancestors = workspaceAncestors(root, cwd).filter(directory => existsSync(join(directory, ".agents", "skills")));
  return [...new Set([root, ...ancestors, ...(providerHome ? [providerHome.home] : [])])];
}

function workspaceAncestors(root: string, cwd: string): string[] {
  const ancestors: string[] = [];
  for (let directory = cwd; ; directory = dirname(directory)) {
    ancestors.unshift(directory);
    if (directory === root) return ancestors;
    if (dirname(directory) === directory) throw new LocalDirectoryError("Runtime workspace cwd escapes root");
  }
}

function codexProjectRoot(cwd: string): string {
  for (let directory = cwd; ; directory = dirname(directory)) {
    if (existsSync(join(directory, ".git"))) return directory;
    if (dirname(directory) === directory) return cwd;
  }
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function validateNativeSkillPaths(directory: string, root: string): void {
  const pending = [directory];
  const seen = new Set<string>();
  while (pending.length) {
    const current = containedPath(root, pending.pop()!);
    if (seen.has(current)) continue;
    seen.add(current);
    if (existsSync(join(current, "SKILL.md"))) {
      containedPath(root, join(current, "SKILL.md"));
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = join(current, entry.name);
      if (entry.isDirectory() || (entry.isSymbolicLink() && existsSync(child) && statSync(child).isDirectory())) pending.push(child);
    }
  }
}

function reconcileNativeSkillRoots(home: string, desired: Record<string, string>): void {
  const root = join(home, "skills", "remi-runtime-workspace");
  for (const directory of [join(home, "skills"), root]) {
    const info = lstatSync(directory, { throwIfNoEntry: false });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new LocalDirectoryError("Runtime workspace native Skill storage must be an unlinked directory");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const manifest = join(root, "managed.json");
  assertUnlinkedFile(manifest);
  const previous = existsSync(manifest) ? JSON.parse(readText(manifest)) : {};
  if (!previous || typeof previous !== "object" || Array.isArray(previous)
    || Object.entries(previous).some(([key, value]) => !/^(user|provider|context-\d+)$/.test(key) || typeof value !== "string" || !isAbsolute(value))) {
    throw new LocalDirectoryError("Runtime workspace native Skill manifest is invalid");
  }
  const keys = new Set([...Object.keys(previous), ...Object.keys(desired)]);
  // Validate the complete publication before changing any alias. A later
  // unmanaged conflict must not strand earlier published aliases.
  for (const key of keys) {
    const target = join(root, key);
    const info = lstatSync(target, { throwIfNoEntry: false });
    if (info && (!info.isSymbolicLink() || !previous[key] || resolve(dirname(target), readlinkSync(target)) !== previous[key])) {
      throw new LocalDirectoryError("Runtime workspace native Skill alias is not managed by this workspace");
    }
  }

  for (const key of keys) {
    const target = join(root, key);
    const info = lstatSync(target, { throwIfNoEntry: false });
    if (info && previous[key] === desired[key]) continue;
    if (info) unlinkSync(target);

    // Record ownership atomically before publishing a new link. If either
    // operation fails, the next preparation can safely finish this alias.
    if (desired[key]) previous[key] = desired[key];
    else delete previous[key];
    publishNativeSkillManifest(manifest, previous);
    if (desired[key]) symlinkSync(desired[key], target, process.platform === "win32" ? "junction" : "dir");
  }
}

function publishNativeSkillManifest(manifest: string, owned: Record<string, string>): void {
  const temporary = join(dirname(manifest), `.managed-${randomUUID()}.json`);
  let created = false;
  try {
    writeFileSync(temporary, JSON.stringify(owned), { mode: 0o600, flag: "wx" });
    created = true;
    assertUnlinkedFile(manifest);
    renameSync(temporary, manifest);
  } finally {
    if (created && existsSync(temporary)) unlinkSync(temporary);
  }
}

function assertUnlinkedFile(path: string): void {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink > 1)) {
    throw new LocalDirectoryError("Runtime workspace generated file must be an unlinked regular file");
  }
}

function containedPath(root: string, path: string): string {
  const canonical = realpathSync(path);
  const rel = relative(root, canonical);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new LocalDirectoryError("Runtime workspace context path escapes its root");
  }
  return canonical;
}

function readText(path: string): string {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new LocalDirectoryError(`Runtime workspace context must be a file under 256 KiB: ${path}`);
  return readFileSync(path, "utf8");
}
