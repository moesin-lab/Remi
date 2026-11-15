import { expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import type { MultiremiTaskWithAgent } from "@multiremi/contracts/types.js";
import { executionLaneForTask } from "@daemon/agent-runtime/workspace/layout.js";
import { prepareIssueExecutionDirectory } from "@daemon/agent-runtime/workspace/session-home.js";
import { disabledSshMeshRuntime } from "../../helpers/ssh-mesh-isolation.js";

it("rejects credentials restored into the actual Issue execution cwd before creating a provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "remi-claude-final-cwd-"));
  let enteredProvider = false;
  const daemon = new MultiremiDaemon({
    sshMeshManager: disabledSshMeshRuntime(),
    serverUrl: "http://127.0.0.1:1", token: "fixture", runtimeId: "fixture", provider: "claude",
    daemonId: "fixture", workspaceId: "local", gcEnabled: false, workspacesRoot: root,
    providerFactory: () => { enteredProvider = true; throw new Error("unexpected provider entry"); },
  });
  const state = daemon as any;
  const task = {
    id: "credentials-test", workspaceId: "local", issueId: "issue", issueSessionId: "session",
    repos: [], projectResources: [], holdsWorkspace: true,
    agent: { id: "agent", name: "Test", provider: "claude", model: "custom", instructions: "" },
    claudeProfile: { name: "custom", base_url: "https://custom.example", model: "custom", env_key: "REMI_CLAUDE_CUSTOM" },
  } as unknown as MultiremiTaskWithAgent;
  try {
    const cwd = await prepareIssueExecutionDirectory(root, executionLaneForTask(task)!);
    const workspace = join(root, "work", "issue");
    await mkdir(workspace, { recursive: true });
    expect(cwd).not.toBe(workspace);
    state.assertWorkspaceRootOwner = () => {};
    state.recordSubjectUse = () => {};
    state.registerTaskRepos = async () => [];
    state.prepareTaskWorkspace = async () => ({ checkouts: [], repos: [], warnings: [] });
    state.enqueueTaskReport = () => {};
    state.restoreReclaimedWorkspace = async () => {
      await mkdir(join(cwd, ".claude"));
      await writeFile(join(cwd, ".claude", "settings.local.json"), '{"env":{"ANTHROPIC_AUTH_TOKEN":"fake-private-token"}}');
    };
    const error = await state.runAgent(task, new AbortController().signal, { workDir: workspace, ensureDir: false })
      .catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(join(cwd, ".claude", "settings.local.json"));
    expect(error.message).not.toContain("fake-private-token");
    expect(enteredProvider).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
