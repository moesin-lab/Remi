import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTask } from "@daemon/contracts/types.js";
import { LocalPathLocker, resolveTaskWorkDir } from "@daemon/agent-runtime/workspace/ephemeral.js";
import { resolveTaskProviderHome, prepareIssueSessionProviderHome } from "@daemon/agent-runtime/workspace/session-home.js";
import { prepareRuntimeWorkspaceContext } from "@daemon/agent-runtime/workspace/runtime-context.js";
import { codexRuntimeWorkspaceDirectories } from "@daemon/agent-runtime/workspace/runtime-context.js";
import { mergeCodexSkillSettings } from "@daemon/agent-runtime/agent-plugins/codex-home.js";
import { writeAgentSkillContext } from "@daemon/agent-runtime/skills/ephemeral.js";
import { workspaceBlock } from "@daemon/agent-runtime/capabilities/workspace.js";
import type { EphemeralContext } from "@daemon/agent-runtime/types.js";
import { parse as parseToml } from "smol-toml";
import { buildTaskPrompt } from "@daemon/agent-runtime/prompts/ephemeral.js";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "remi-runtime-workspace-test-"));
  temporary.push(base);
  const root = join(base, "workbench");
  const cwd = join(root, "repository");
  const baseHome = join(base, "user-home", ".codex");
  for (const path of [cwd, baseHome, join(root, ".agents", "skills", "private")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(baseHome, "AGENTS.md"), "Use the local compiler.");
  writeFileSync(join(root, "AGENTS.md"), "PARENT_PRIVATE_INSTRUCTION");
  writeFileSync(join(root, ".agents", "skills", "private", "SKILL.md"), "---\nname: private\ndescription: Use when inspecting local research.\n---\nPRIVATE_SKILL_BODY");
  writeFileSync(join(cwd, ".env.local"), 'DEPENDENCY_HOME="../dependencies"\nLOCAL_FEATURE=1\n');
  writeFileSync(join(cwd, "ignored-state.txt"), "Keep me between tasks.");
  const task = {
    id: "tsk_local", workspaceId: "local", prompt: "Inspect", issueId: null, chatSessionId: "chat_local",
    runtimeWorkspaceId: "rws_local", runtimeWorkspace: {
      id: "rws_local", workspaceId: "local", daemonId: "laptop", rootPath: root, cwd: "repository",
      name: "Local research", contextPaths: [], envFile: "repository/.env.local", archivedAt: null,
    },
    agent: { id: "agt_local", name: "Local", provider: "codex", skills: [], instructions: "", customEnv: {} },
    project: null, projectResources: [], repos: [],
  } as unknown as AgentTask;
  const options = {
    daemonIds: ["laptop"], workspacesRoot: join(base, "daemon-state"), locker: new LocalPathLocker(),
    signal: new AbortController().signal, runtimeWorkspaceLeaseRoot: join(base, "leases"),
    onWaitLocalDirectory: () => {},
  };
  return { base, root, cwd, baseHome, task, options };
}

describe("Runtime workspace local execution", () => {
  it("keeps default runtime leases in the shared test run root", async () => {
    const { cwd, task, options } = fixture();
    const resolved = await resolveTaskWorkDir(task, { ...options, runtimeWorkspaceLeaseRoot: undefined });
    try {
      const leasesRoot = join(process.env.MULTIREMI_TEST_RUN_ROOT!, "shared-locks", "runtime-workspace-leases");
      const entries = readdirSync(leasesRoot);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.some(entry => {
        const ownerPath = join(leasesRoot, entry, "owner.lock", "owner.json");
        return existsSync(ownerPath) && JSON.parse(readFileSync(ownerPath, "utf8")).workspace_root === realpathSync(cwd);
      })).toBe(true);
      expect(existsSync(join(process.env.MULTIREMI_STATE_DIR!, "runtime-workspace-leases"))).toBe(false);
    } finally { resolved.release?.(); }
  });

  it("uses the original non-Git directory and retains ignored files across tasks", async () => {
    const { root, cwd, task, options } = fixture();
    const before = readdirSync(cwd);
    const resolved = await resolveTaskWorkDir(task, options);
    expect(resolved.workDir).toBe(cwd);
    expect(resolved.ensureDir).toBe(false);
    expect(resolved.localDirectory).toBe(true);
    resolved.release?.();
    const reused = await resolveTaskWorkDir({ ...task, id: "second" }, options);
    try {
      expect(reused.workDir).toBe(cwd);
      expect(readdirSync(cwd)).toEqual(before);
      expect(readFileSync(join(cwd, "ignored-state.txt"), "utf8")).toBe("Keep me between tasks.");
      expect(existsSync(join(root, ".multiremi"))).toBe(false);
    } finally { reused.release?.(); }
  });

  it("loads parent and user context locally without embedding file contents in the server prompt", async () => {
    const { base, root, cwd, baseHome, task, options } = fixture();
    const home = resolveTaskProviderHome(task, options.workspacesRoot, options.workspacesRoot)!;
    await prepareIssueSessionProviderHome(home, { baseCodexHome: baseHome, linkCodexAuth: false });
    const env = prepareRuntimeWorkspaceContext(task, home, cwd, { baseHome, userHome: join(base, "user-home") });
    const instructions = readFileSync(join(home.home, "AGENTS.md"), "utf8");
    expect(instructions).toContain("Use the local compiler.");
    expect(instructions).toContain("PARENT_PRIVATE_INSTRUCTION");
    expect(instructions).not.toContain("Use when inspecting local research.");
    expect(codexRuntimeWorkspaceDirectories(task, cwd, home)).toContain(realpathSync(root));
    expect(codexRuntimeWorkspaceDirectories(task, cwd, home)).toContain(home.home);
    expect(instructions).not.toContain("PRIVATE_SKILL_BODY");
    expect(env).toEqual({ DEPENDENCY_HOME: "../dependencies", LOCAL_FEATURE: "1" });
    expect(buildTaskPrompt(task)).not.toContain("PARENT_PRIVATE_INSTRUCTION");
    expect(buildTaskPrompt(task)).not.toContain("LOCAL_FEATURE");
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("PARENT_PRIVATE_INSTRUCTION");
    expect(existsSync(join(cwd, ".multiremi"))).toBe(false);
  });

  it("leaves Git instructions and a large imperfect Skill catalog to native Codex", async () => {
    const { base, root, cwd, baseHome, task, options } = fixture();
    mkdirSync(join(cwd, ".git"));
    writeFileSync(join(cwd, "AGENTS.md"), "REPOSITORY_RULES_".repeat(1200));
    const skillRoot = join(baseHome, "skills");
    for (let index = 0; index < 108; index++) {
      const directory = join(skillRoot, `skill-${index}`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "SKILL.md"), `---\nname: skill-${index}\ndescription: Use when: ${"complete trigger description ".repeat(20)}\n---\nOriginal body\n`);
    }
    const home = resolveTaskProviderHome(task, options.workspacesRoot, options.workspacesRoot)!;
    await prepareIssueSessionProviderHome(home, { baseCodexHome: baseHome, linkCodexAuth: false });
    prepareRuntimeWorkspaceContext(task, home, cwd, { baseHome, userHome: join(base, "user-home") });

    const instructions = readFileSync(join(home.home, "AGENTS.md"), "utf8");
    expect(instructions).toContain("Use the local compiler.");
    expect(instructions).toContain("PARENT_PRIVATE_INSTRUCTION");
    expect(instructions).not.toContain("REPOSITORY_RULES_");
    expect(instructions).not.toContain("complete trigger description");
    expect(readlinkSync(join(home.home, "skills", "remi-runtime-workspace", "user"))).toBe(realpathSync(skillRoot));
    expect(readFileSync(join(skillRoot, "skill-0", "SKILL.md"), "utf8")).toContain("Use when:");
  });

  it("inherits true user guidance and Skill settings when the auth home has no guidance", async () => {
    const { base, cwd, baseHome, task, options } = fixture();
    const authHome = join(base, "aiden-auth");
    mkdirSync(authHome);
    writeFileSync(join(baseHome, "config.toml"), '[skills]\nmax_context_tokens = 4000\n[[skills.config]]\npath = "/skills/disabled/SKILL.md"\nenabled = false\n[model_providers.ignored]\nbase_url = "DO_NOT_COPY"\n');
    const home = resolveTaskProviderHome(task, options.workspacesRoot, options.workspacesRoot)!;
    await prepareIssueSessionProviderHome(home, { baseCodexHome: authHome, linkCodexAuth: false });
    prepareRuntimeWorkspaceContext(task, home, cwd, { baseHome: authHome, userHome: join(base, "user-home") });

    expect(readFileSync(join(home.home, "AGENTS.md"), "utf8")).toContain("Use the local compiler.");
    const config = parseToml(readFileSync(join(home.home, "config.toml"), "utf8"));
    expect(config.skills).toEqual({ max_context_tokens: 4000, config: [{ path: "/skills/disabled/SKILL.md", enabled: false }] });
    expect(config.model_providers).toBeUndefined();
    writeFileSync(join(authHome, "AGENTS.md"), "EXPLICIT_AUTH_HOME_GUIDANCE");
    prepareRuntimeWorkspaceContext(task, home, cwd, { baseHome: authHome, userHome: join(base, "user-home") });
    expect(readFileSync(join(home.home, "AGENTS.md"), "utf8")).toContain("EXPLICIT_AUTH_HOME_GUIDANCE");
    expect(readFileSync(join(home.home, "AGENTS.md"), "utf8")).not.toContain("Use the local compiler.");
  });

  it("retains legacy AGENT.md guidance inside a Git root that native Codex will not read", async () => {
    const { base, cwd, baseHome, task, options } = fixture();
    mkdirSync(join(cwd, ".git"));
    writeFileSync(join(cwd, "AGENT.md"), "LEGACY_GIT_GUIDANCE");
    const home = resolveTaskProviderHome(task, options.workspacesRoot, options.workspacesRoot)!;
    await prepareIssueSessionProviderHome(home, { baseCodexHome: baseHome, linkCodexAuth: false });
    prepareRuntimeWorkspaceContext(task, home, cwd, { baseHome, userHome: join(base, "user-home") });
    expect(readFileSync(join(home.home, "AGENTS.md"), "utf8")).toContain("LEGACY_GIT_GUIDANCE");
  });

  it("registers ancestor and DB Skill roots through the existing bridge directories", async () => {
    const { base, root, cwd, baseHome, task, options } = fixture();
    const nested = join(cwd, "nested");
    mkdirSync(nested);
    mkdirSync(join(cwd, ".agents", "skills"), { recursive: true });
    const home = resolveTaskProviderHome(task, options.workspacesRoot, options.workspacesRoot)!;
    await prepareIssueSessionProviderHome(home, { baseCodexHome: baseHome, linkCodexAuth: false });
    task.agent!.skills = [{ name: "db-skill", description: "Use when verifying DB Skill discovery.", content: "Database body" }] as NonNullable<AgentTask["agent"]>["skills"];
    writeAgentSkillContext(home.home, task);
    prepareRuntimeWorkspaceContext(task, home, nested, { baseHome, userHome: join(base, "user-home") });
    const directories = codexRuntimeWorkspaceDirectories(task, nested, home);
    expect(directories).toEqual([realpathSync(root), realpathSync(cwd), home.home]);
    const skillMarkdown = readFileSync(join(home.home, ".agents", "skills", "db-skill", "SKILL.md"), "utf8");
    expect(skillMarkdown).toContain("\n---\nDatabase body");
    expect(workspaceBlock.ephemeral!({ task, workDir: nested, providerHome: home } as EphemeralContext)).toEqual({ cwd: nested, addDirs: directories });
  });

  it("reconciles only owned native Skill aliases and preserves explicit context", async () => {
    const { base, root, cwd, baseHome, task, options } = fixture();
    const explicit = join(root, "extra-skills");
    mkdirSync(explicit);
    writeFileSync(join(explicit, "SKILL.md"), "---\nname: explicit\ndescription: Use when: preserving exact metadata.\n---\nSupporting body\n");
    writeFileSync(join(root, "extra.md"), "EXPLICIT_EXTRA_INSTRUCTIONS");
    task.runtimeWorkspace!.contextPaths = ["extra-skills", "extra.md"];
    const home = resolveTaskProviderHome(task, options.workspacesRoot, options.workspacesRoot)!;
    await prepareIssueSessionProviderHome(home, { baseCodexHome: baseHome, linkCodexAuth: false });
    const other = join(home.home, "skills", "unrelated-native-skill");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "SKILL.md"), "Preserve this native Skill.");
    prepareRuntimeWorkspaceContext(task, home, cwd, { baseHome, userHome: join(base, "user-home") });
    const alias = join(home.home, "skills", "remi-runtime-workspace", "context-0");
    expect(readlinkSync(alias)).toBe(realpathSync(explicit));
    expect(readFileSync(join(home.home, "AGENTS.md"), "utf8")).toContain("EXPLICIT_EXTRA_INSTRUCTIONS");

    task.runtimeWorkspace!.contextPaths = ["extra.md"];
    prepareRuntimeWorkspaceContext(task, home, cwd, { baseHome, userHome: join(base, "user-home") });
    expect(lstatSync(alias, { throwIfNoEntry: false })).toBeUndefined();
    expect(readFileSync(join(other, "SKILL.md"), "utf8")).toBe("Preserve this native Skill.");
  });

  it("rejects escaping context and Skill aliases, oversized instructions, and linked targets", async () => {
    const { base, root, cwd, baseHome, task, options } = fixture();
    const home = resolveTaskProviderHome(task, options.workspacesRoot, options.workspacesRoot)!;
    await prepareIssueSessionProviderHome(home, { baseCodexHome: baseHome, linkCodexAuth: false });
    const outside = join(base, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "SKILL.md"), "Outside workspace.");
    symlinkSync(outside, join(root, "outside"), "dir");
    task.runtimeWorkspace!.contextPaths = ["outside"];
    expect(() => prepareRuntimeWorkspaceContext(task, home, cwd, { baseHome, userHome: join(base, "user-home") })).toThrow("escapes");
    task.runtimeWorkspace!.contextPaths = [];
    symlinkSync(outside, join(root, ".agents", "skills", "escape"), "dir");
    expect(() => prepareRuntimeWorkspaceContext(task, home, cwd, { baseHome, userHome: join(base, "user-home") })).toThrow("escapes");
    rmSync(join(root, ".agents", "skills", "escape"));
    writeFileSync(join(root, "large.md"), "x".repeat(24 * 1024));
    task.runtimeWorkspace!.contextPaths = ["large.md"];
    expect(() => prepareRuntimeWorkspaceContext(task, home, cwd, { baseHome, userHome: join(base, "user-home") })).toThrow("24 KiB");
    task.runtimeWorkspace!.contextPaths = [];
    const target = join(home.home, "AGENTS.md");
    writeFileSync(target, "Keep linked target unchanged.");
    linkSync(target, join(base, "linked-target"));
    expect(() => prepareRuntimeWorkspaceContext(task, home, cwd, { baseHome, userHome: join(base, "user-home") })).toThrow("unlinked");
    expect(readFileSync(target, "utf8")).toBe("Keep linked target unchanged.");
  });

  it("does not let an uninstalled dangling Skill link block native discovery", async () => {
    const { base, root, cwd, baseHome, task, options } = fixture();
    symlinkSync(join(base, "removed-skill"), join(root, ".agents", "skills", "removed"), "dir");
    const home = resolveTaskProviderHome(task, options.workspacesRoot, options.workspacesRoot)!;
    await prepareIssueSessionProviderHome(home, { baseCodexHome: baseHome, linkCodexAuth: false });
    expect(() => prepareRuntimeWorkspaceContext(task, home, cwd, { baseHome, userHome: join(base, "user-home") })).not.toThrow();
  });

  it("preflights all native aliases before publishing an earlier alias", async () => {
    const { base, cwd, baseHome, task, options } = fixture();
    const authHome = join(base, "auth-home");
    mkdirSync(join(authHome, "skills"), { recursive: true });
    mkdirSync(join(baseHome, "skills"));
    const home = resolveTaskProviderHome(task, options.workspacesRoot, options.workspacesRoot)!;
    await prepareIssueSessionProviderHome(home, { baseCodexHome: authHome, linkCodexAuth: false });
    const nativeRoot = join(home.home, "skills", "remi-runtime-workspace");
    mkdirSync(join(nativeRoot, "provider"), { recursive: true });
    expect(() => prepareRuntimeWorkspaceContext(task, home, cwd, { baseHome: authHome, userHome: join(base, "user-home") })).toThrow("not managed");
    expect(lstatSync(join(nativeRoot, "user"), { throwIfNoEntry: false })).toBeUndefined();
  });

  it("can reenter native alias publication after a later ownership write fails", async () => {
    const { base, cwd, baseHome, task, options } = fixture();
    const authHome = join(base, "auth-home");
    mkdirSync(join(authHome, "skills"), { recursive: true });
    mkdirSync(join(baseHome, "skills"));
    const home = resolveTaskProviderHome(task, options.workspacesRoot, options.workspacesRoot)!;
    await prepareIssueSessionProviderHome(home, { baseCodexHome: authHome, linkCodexAuth: false });
    const original = fs.renameSync;
    let publications = 0;
    const fault = spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (String(target).endsWith("/remi-runtime-workspace/managed.json") && ++publications === 2) throw new Error("injected manifest publication failure");
      original(source, target);
    });
    try {
      expect(() => prepareRuntimeWorkspaceContext(task, home, cwd, { baseHome: authHome, userHome: join(base, "user-home") })).toThrow("injected manifest");
    } finally { fault.mockRestore(); }
    expect(() => prepareRuntimeWorkspaceContext(task, home, cwd, { baseHome: authHome, userHome: join(base, "user-home") })).not.toThrow();
    const nativeRoot = join(home.home, "skills", "remi-runtime-workspace");
    expect(readlinkSync(join(nativeRoot, "user"))).toBe(realpathSync(join(baseHome, "skills")));
    expect(readlinkSync(join(nativeRoot, "provider"))).toBe(realpathSync(join(authHome, "skills")));
  });

  it("rejects a dangling generated AGENTS symlink before creating its external target", async () => {
    const { base, cwd, baseHome, task, options } = fixture();
    const home = resolveTaskProviderHome(task, options.workspacesRoot, options.workspacesRoot)!;
    await prepareIssueSessionProviderHome(home, { baseCodexHome: baseHome, linkCodexAuth: false });
    const outside = join(base, "not-created.md");
    symlinkSync(outside, join(home.home, "AGENTS.md"));
    expect(() => prepareRuntimeWorkspaceContext(task, home, cwd, { baseHome, userHome: join(base, "user-home") })).toThrow("unlinked");
    expect(existsSync(outside)).toBe(false);
  });

  it("validates Skill settings without copying unrelated native configuration", () => {
    const current = 'model_provider = "aiden"\n[model_providers.aiden]\nbase_url = "http://local/v1"\n';
    const source = '[skills]\nmax_context_tokens = 2000\n[[skills.config]]\npath = "/skill/SKILL.md"\nenabled = false\nsecret = "discard"\n[plugins.unrelated]\nenabled = true\n';
    const merged = parseToml(mergeCodexSkillSettings(current, source));
    expect(merged.model_provider).toBe("aiden");
    expect(merged.plugins).toBeUndefined();
    expect(merged.skills).toEqual({ max_context_tokens: 2000, config: [{ path: "/skill/SKILL.md", enabled: false }] });
    expect(() => mergeCodexSkillSettings(current, '[skills]\nmax_context_tokens = 0')).toThrow("integer");
    expect(() => mergeCodexSkillSettings(current, '[[skills.config]]\npath = "/skill"\nenabled = "false"')).toThrow("boolean");
  });

  it("fails closed on wrong hosts, missing directories and escaping cwd", async () => {
    const { task, options } = fixture();
    await expect(resolveTaskWorkDir(task, { ...options, daemonIds: ["other"] })).rejects.toThrow("unavailable");
    task.runtimeWorkspace!.cwd = "missing";
    await expect(resolveTaskWorkDir(task, options)).rejects.toThrow("does not exist");
    task.runtimeWorkspace!.cwd = "../user-home";
    await expect(resolveTaskWorkDir(task, options)).rejects.toThrow("escapes");
  });

  it("serializes independently instantiated daemon lockers and cancels waiting cleanly", async () => {
    const { task, options } = fixture();
    const first = await resolveTaskWorkDir(task, options);
    const controller = new AbortController();
    let waited = false;
    try {
      const second = resolveTaskWorkDir({ ...task, id: "second" }, {
        ...options, locker: new LocalPathLocker(), signal: controller.signal,
        onWaitLocalDirectory: () => { waited = true; controller.abort(); },
      });
      await expect(second).rejects.toThrow();
      expect(waited).toBe(true);
    } finally { first.release?.(); }
    const third = await resolveTaskWorkDir({ ...task, id: "third" }, options);
    third.release?.();
  });
});
