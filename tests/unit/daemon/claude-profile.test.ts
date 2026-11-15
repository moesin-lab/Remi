import { expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { parseRuntimeClaudeProfile } from "@multiremi/contracts/claude-profile";
import { assertRuntimeClaudeProjectCredentials, resolveRuntimeClaudeProfile, runtimeClaudeProfileEnv, runtimeClaudeProfileRouting } from "@daemon/agent-runtime/claude-profile.js";
import { prepareIssueSessionProviderHome, type IssueSessionProviderHome } from "@daemon/agent-runtime/workspace/session-home.js";
import { ClaudeAdapter } from "@acp/adapters/claude-code/index.js";

const profile = { name: "custom", base_url: "http://127.0.0.1:9000", model: "unlisted-model", env_key: "REMI_CLAUDE_CUSTOM" };

it("rejects project credential overrides without disclosing their values or changing project settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "remi-claude-project-auth-"));
  try {
    const cwd = join(root, "project", "child");
    await mkdir(cwd, { recursive: true });
    await mkdir(join(root, "project", ".claude"));
    const path = join(root, "project", ".claude", "settings.local.json");
    const safe = { env: { ANTHROPIC_BASE_URL: "http://old.invalid", ANTHROPIC_MODEL: "old" }, hooks: {} };
    await writeFile(path, JSON.stringify(safe));
    await assertRuntimeClaudeProjectCredentials(cwd, { workspaceRoot: join(root, "project") });
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "apiKeyHelper"]) {
      const text = JSON.stringify(key === "apiKeyHelper" ? { ...safe, apiKeyHelper: "private-value" } : { ...safe, env: { [key]: "private-value" } });
      await writeFile(path, text);
      const error = await assertRuntimeClaudeProjectCredentials(cwd, { workspaceRoot: join(root, "project") }).catch(error => error as Error);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error("Expected project credential conflict");
      expect(error.message).toContain(key);
      expect(error.message).not.toContain("private-value");
      expect(await readFile(path, "utf8")).toBe(text);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("ignores user and shared ancestor credentials while checking both project settings files", async () => {
  const root = await mkdtemp(join(tmpdir(), "remi-claude-home-boundary-"));
  try {
    const userHome = join(root, "home");
    const workspaceRoot = join(userHome, ".remi", "workspaces", "issue");
    const cwd = join(workspaceRoot, "nested", "child");
    await mkdir(cwd, { recursive: true });
    for (const directory of [root, userHome, join(userHome, ".remi")]) {
      await mkdir(join(directory, ".claude"));
      await writeFile(join(directory, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "personal-secret" } }));
    }
    const options = { workspaceRoot, userHome };
    await assertRuntimeClaudeProjectCredentials(cwd, options);
    await assertRuntimeClaudeProjectCredentials(cwd, { userHome }); // Non-Git: cwd only.
    await assertRuntimeClaudeProjectCredentials(userHome, { workspaceRoot: userHome, userHome });
    for (const directory of [workspaceRoot, join(workspaceRoot, "nested"), cwd]) {
      await mkdir(join(directory, ".claude"));
      for (const name of ["settings.json", "settings.local.json"]) {
        const path = join(directory, ".claude", name);
        await writeFile(path, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "project-secret" } }));
        const error = await assertRuntimeClaudeProjectCredentials(cwd, options).catch(error => error);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain(path);
        expect(error.message).not.toContain("project-secret");
        await rm(path);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("finds Git and linked worktree roots for local subdirectories and canonicalizes explicit boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "remi-claude-git-boundary-"));
  try {
    const project = join(root, "project");
    const cwd = join(project, "child");
    await mkdir(cwd, { recursive: true });
    await mkdir(join(project, ".claude"));
    await writeFile(join(project, ".claude", "settings.json"), '{"apiKeyHelper":"private-value"}');
    for (const linked of [false, true]) {
      if (linked) await writeFile(join(project, ".git"), "gitdir: /unused/worktree/metadata");
      else await mkdir(join(project, ".git"));
      await expect(assertRuntimeClaudeProjectCredentials(cwd)).rejects.toThrow("apiKeyHelper");
      await expect(assertRuntimeClaudeProjectCredentials(cwd, { workspaceRoot: cwd })).rejects.toThrow("apiKeyHelper");
      await rm(join(project, ".git"), { recursive: true });
    }
    const alias = join(root, "alias");
    await symlink(project, alias, process.platform === "win32" ? "junction" : "dir");
    await expect(assertRuntimeClaudeProjectCredentials(join(alias, "child"), { workspaceRoot: project })).rejects.toThrow("apiKeyHelper");
    await expect(assertRuntimeClaudeProjectCredentials(cwd, { workspaceRoot: join(root, "unrelated") })).rejects.toThrow("outside its workspace boundary");
    await writeFile(join(project, ".claude", "settings.json"), "invalid-json-secret");
    await expect(assertRuntimeClaudeProjectCredentials(cwd, { workspaceRoot: project })).rejects.toThrow("fix its JSON");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("validates Claude auth headers and fails closed when its dedicated environment credential is missing", () => {
  expect(parseRuntimeClaudeProfile(profile)?.auth_header).toBe("bearer");
  expect(() => parseRuntimeClaudeProfile({ ...profile, auth_header: "custom-header" })).toThrow("auth_header");
  expect(() => parseRuntimeClaudeProfile({ ...profile, env_key: "REMI_CODEX_KEY" })).toThrow("REMI_CLAUDE_");
  expect(() => resolveRuntimeClaudeProfile(profile, { ANTHROPIC_API_KEY: "unrelated" })).toThrow("REMI_CLAUDE_CUSTOM");
});

it("keeps keys out of the isolated settings and sends the selected auth header only through child env", async () => {
  const root = await mkdtemp(join(tmpdir(), "remi-claude-profile-"));
  try {
    const original = JSON.stringify({ model: "old-model", env: { ANTHROPIC_BASE_URL: "https://old.example", ANTHROPIC_API_KEY: "old-key", CLAUDE_CODE_USE_BEDROCK: "1" } });
    await writeFile(join(root, "settings.json"), original);
    const home: IssueSessionProviderHome = { storageRoot: root, root: join(root, "execution"), home: join(root, "execution", "home"), provider: "claude", agentId: "agent", sessionId: "session", generation: 1 };
    for (const auth_header of ["bearer", "x-api-key"] as const) {
      const configured = { ...profile, auth_header };
      const relay = resolveRuntimeClaudeProfile(configured, { REMI_CLAUDE_CUSTOM: "in-memory-key" });
      await prepareIssueSessionProviderHome(home, { baseClaudeConfigDir: root, linkClaudeCredentials: false, relayFragment: relay.fragment });
      const text = await readFile(join(home.home, "settings.json"), "utf8");
      expect(text).not.toContain("in-memory-key");
      expect(text).not.toContain("old-key");
      expect(JSON.parse(text)).toMatchObject({ model: profile.model, env: { ANTHROPIC_BASE_URL: profile.base_url, CLAUDE_CODE_USE_BEDROCK: "0" } });
      const env = runtimeClaudeProfileEnv(configured, relay.auth_token);
      expect(env.ANTHROPIC_API_KEY).toBe(auth_header === "x-api-key" ? "in-memory-key" : "");
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe(auth_header === "bearer" ? "in-memory-key" : "");
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("");
      const settings = { model: profile.model, env: runtimeClaudeProfileRouting(configured) };
      const meta = new ClaudeAdapter().buildSessionMeta({ model: profile.model, claudeSettings: settings });
      expect(meta?.claudeCode?.options?.settings).toEqual(settings);
      expect(JSON.stringify(meta)).not.toContain("in-memory-key");
    }
    expect(await readFile(join(root, "settings.json"), "utf8")).toBe(original);
    expect(await Bun.file(join(home.home, ".credentials.json")).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("loads only isolated user settings for Runtime connections whose actual cwd is HOME", async () => {
  const root = await mkdtemp(join(tmpdir(), "remi-claude-home-cwd-"));
  try {
    const adapter = new ClaudeAdapter();
    const claudeSettings = { model: profile.model, env: runtimeClaudeProfileRouting(profile) };
    expect(adapter.buildSessionMeta({ cwd: homedir(), claudeSettings })?.claudeCode?.options?.settingSources).toEqual(["user"]);
    const alias = join(root, "alias");
    await symlink(homedir(), alias, process.platform === "win32" ? "junction" : "dir");
    expect(adapter.buildSessionMeta({ cwd: alias, claudeSettings })?.claudeCode?.options?.settingSources).toEqual(["user"]);
    expect(adapter.buildSessionMeta({ cwd: root, claudeSettings })?.claudeCode?.options?.settingSources).toBeUndefined();
    expect(adapter.buildSessionMeta({ cwd: homedir(), model: profile.model })?.claudeCode?.options?.settingSources).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});
