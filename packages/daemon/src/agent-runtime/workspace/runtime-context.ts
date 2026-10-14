import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseEnv } from "node:util";
import { parse as parseYaml } from "yaml";
import type { AgentTask } from "@daemon/contracts/types.js";
import type { IssueSessionProviderHome } from "./session-home.js";
import { LocalDirectoryError } from "./ephemeral.js";
import { mergeCodexSkillSettings } from "../agent-plugins/codex-home.js";

const MAX_FILE_BYTES = 256 * 1024;
// Leave room for provider-discovered project instructions in Codex's default budget.
const MAX_CONTEXT_BYTES = 24 * 1024;

/** Paths are registered centrally; contents are read only here, on the owning host. */
export function prepareRuntimeWorkspaceContext(
  task: AgentTask,
  providerHome: IssueSessionProviderHome,
  workDir: string,
  options: { baseHome?: string; userHome?: string } = {},
): Record<string, string> {
  const workspace = task.runtimeWorkspace;
  if (!workspace) return {};
  const root = realpathSync(workspace.rootPath);
  const cwd = containedPath(root, workDir);
  const sections: string[] = [];
  const seen = new Set<string>();
  const userHome = options.userHome ?? homedir();
  const baseHome = options.baseHome ?? (providerHome.provider === "codex"
    ? process.env.CODEX_HOME ?? join(userHome, ".codex")
    : providerHome.provider === "antigravity" ? join(userHome, ".gemini", "antigravity-cli")
      : providerHome.provider === "grok" ? process.env.GROK_HOME ?? join(userHome, ".grok")
      : process.env.CLAUDE_CONFIG_DIR ?? join(userHome, ".claude"));
  const codex = providerHome.provider === "codex";
  const userCodexHome = join(userHome, ".codex");
  const nativeSkillRoots: Record<string, string> = {};
  const instructionNames = providerHome.provider === "codex"
    ? ["AGENTS.override.md", "AGENTS.md", "AGENT.md"] : providerHome.provider === "antigravity"
      ? ["AGENTS.md", "AGENT.md"] : providerHome.provider === "grok"
        ? ["AGENTS.md", "AGENT.md"] : ["CLAUDE.md", "AGENTS.md", "AGENT.md"];

  const addInstructions = (file: string, boundary?: string) => {
    if (!existsSync(file)) return;
    const canonical = boundary ? containedPath(boundary, file) : realpathSync(file);
    if (seen.has(canonical)) return;
    seen.add(canonical);
    sections.push(`\n## Local instructions: ${file}\n${readText(canonical)}`);
  };
  const addSkills = (directory: string, boundary?: string) => {
    if (!existsSync(directory)) return;
    const canonical = boundary ? containedPath(boundary, directory) : realpathSync(directory);
    const files = existsSync(join(canonical, "SKILL.md")) ? [join(canonical, "SKILL.md")]
      : readdirSync(canonical).sort().map(name => join(canonical, name, "SKILL.md")).filter(existsSync);
    if (files.length > 256) throw new LocalDirectoryError("Runtime workspace skill directory exceeds 256 skills");
    for (const file of files) {
      const source = boundary ? containedPath(boundary, file) : realpathSync(file);
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

  // Preserve user-level instructions while keeping native histories/session IDs isolated.
  const globalHome = codex && !instructionNames.some(name => existsSync(join(baseHome, name)))
    ? userCodexHome : baseHome;
  const global = instructionNames.find(name => existsSync(join(globalHome, name)));
  if (global) addInstructions(join(globalHome, global));
  if (codex) {
    addNativeSkills("user", join(userCodexHome, "skills"));
    if (resolve(baseHome) !== resolve(userCodexHome)) addNativeSkills("provider", join(baseHome, "skills"));
  } else {
    sections.push("\n## Local skills\nWhen a listed skill is relevant, read its original SKILL.md and follow its instructions before working.");
    addSkills(join(baseHome, "skills"));
    addSkills(join(userHome, ".agents", "skills"));
  }
  // Database Agent skills are materialized in daemon-owned state, leaving any
  // identically named local skill intact.
  if (!codex) addSkills(join(providerHome.home, providerHome.provider === "claude" ? ".claude" : providerHome.provider === "grok" ? ".grok" : ".agents", "skills"));
  const ancestors = workspaceAncestors(root, cwd);
  const nativeInstructionRoot = codex ? codexProjectRoot(cwd) : null;
  for (const directory of ancestors) {
    const file = instructionNames.find(name => existsSync(join(directory, name)));
    // Codex already reads Git-root -> cwd instructions; copying them into its
    // global AGENTS.md duplicates guidance and consumes the native byte budget.
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
  const content = `# Runtime workspace local context\nInstructions below are ordered from user to workspace root to working directory. More specific directory instructions take precedence.\n${sections.join("\n")}\n`;
  if (Buffer.byteLength(content) > MAX_CONTEXT_BYTES) {
    throw new LocalDirectoryError("Runtime workspace local context exceeds 24 KiB; reduce instruction files or the skill catalog");
  }
  const target = join(providerHome.home, providerHome.provider === "claude" ? "CLAUDE.md" : "AGENTS.md");
  const targetStat = lstatSync(target, { throwIfNoEntry: false });
  if (targetStat && (targetStat.isSymbolicLink() || !targetStat.isFile() || targetStat.nlink > 1)) {
    throw new LocalDirectoryError("Runtime workspace provider instructions must be an unlinked regular file");
  }
  writeFileSync(target, content, { mode: 0o600 });

  if (codex) {
    reconcileNativeSkillRoots(providerHome.home, nativeSkillRoots);
    const source = join(userCodexHome, "config.toml");
    if (existsSync(source)) {
      const configTarget = join(providerHome.home, "config.toml");
      assertUnlinkedFile(configTarget);
      writeFileSync(configTarget, mergeCodexSkillSettings(readText(configTarget), readText(source)), { mode: 0o600 });
    }
  }

  if (!workspace.envFile) return {};
  const env = parseEnv(readText(containedPath(root, resolve(root, workspace.envFile))));
  // Runtime/task identity and provider homes/routing stay authoritative.
  for (const key of Object.keys(env)) {
    if (/^(MULTIREMI_|CODEX_HOME$|CLAUDE_CONFIG_DIR$|OPENAI_|ANTHROPIC_)/i.test(key)) {
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
