import { disabledSshMeshRuntime } from "../../helpers/ssh-mesh-isolation.js";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MultiremiRuntimeUpdateScope } from "@multiremi/contracts/types.js";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import { MultiremiCliUpdateCoordinator } from "@multiremi/worker/cli-update-coordinator.js";
import { instantiateCoResidentWorkerDaemons } from "../../../apps/remi/cli/multiremi.js";

interface UpdateReport {
  status: "running" | "restarting" | "completed" | "failed";
  output?: string;
  error?: string;
}

interface TestDaemonState {
  activeTaskCount: number;
  drainingTaskCount: number;
  pendingClaimCount: number;
  claimsPaused: boolean;
  cliUpdateCoordinator: MultiremiCliUpdateCoordinator | null;
  client: {
    claimTask?(runtimeId: string): Promise<unknown>;
    reportRuntimeUpdateResult(
      runtimeId: string,
      requestId: string,
      report: UpdateReport,
    ): Promise<void>;
  };
  updateRunner?: (targetVersion: string) => string | Promise<string>;
  updateRestartSpec?: { command: string[]; manager?: "systemd" | "launchd" };
  updateAgentCli(): Promise<string>;
  reinstallAcpBridge(): string;
  handleRuntimeUpdate(
    runtimeId: string,
    requestId: string,
    targetVersion: string,
    scope: MultiremiRuntimeUpdateScope,
  ): Promise<void>;
  claimTask(runtimeId: string): Promise<unknown>;
}

describe("co-resident CLI update coordination", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("rejects a CLI update when a sibling provider is busy and names it", async () => {
    const [claude, codex] = createDaemons();
    const claudeState = state(claude);
    const codexState = state(codex);
    const reports = captureReports(claudeState);
    let updateCalls = 0;
    claudeState.updateRunner = () => {
      updateCalls++;
      return "updated";
    };
    codexState.activeTaskCount = 2;

    await claudeState.handleRuntimeUpdate("rt_claude", "upd_busy", "v9.9.9", "cli");

    expect(updateCalls).toBe(0);
    expect(reports).toEqual([{
      status: "failed",
      error: "CLI update blocked: provider is busy: codex (2 active tasks); retry when all providers are idle",
    }]);
    expect(claudeState.claimsPaused).toBe(false);
    expect(codexState.claimsPaused).toBe(false);
  });

  it("pauses claims on every provider before replacing the shared CLI", async () => {
    const [claude, codex] = createDaemons();
    const claudeState = state(claude);
    const codexState = state(codex);
    const reports = captureReports(claudeState);
    claudeState.updateRunner = () => {
      expect(claudeState.claimsPaused).toBe(true);
      expect(codexState.claimsPaused).toBe(true);
      return "updated together";
    };

    await claudeState.handleRuntimeUpdate("rt_claude", "upd_idle", "v9.9.9", "cli");

    expect(reports).toEqual([
      { status: "running" },
      { status: "restarting", output: "updated together" },
    ]);
    expect(claudeState.claimsPaused).toBe(true);
    expect(codexState.claimsPaused).toBe(true);
    expect(claude.restartRequested()).toBe(true);
  });

  it("does not treat a sibling's durable report drain as active agent execution", async () => {
    const [claude, codex] = createDaemons();
    const claudeState = state(claude);
    const codexState = state(codex);
    const reports = captureReports(claudeState);
    codexState.activeTaskCount = 0;
    codexState.drainingTaskCount = 3;
    claudeState.updateRunner = () => "updated while reports drain";

    await claudeState.handleRuntimeUpdate("rt_claude", "upd_draining", "v9.9.9", "cli");

    expect(reports).toEqual([
      { status: "running" },
      { status: "restarting", output: "updated while reports drain" },
    ]);
    expect(claudeState.claimsPaused).toBe(true);
    expect(codexState.claimsPaused).toBe(true);
  });

  it("rejects a CLI update while a sibling has pending dispatch work", async () => {
    const [claude, codex] = createDaemons();
    const claudeState = state(claude);
    const codexState = state(codex);
    const reports = captureReports(claudeState);
    codexState.pendingClaimCount = 1;

    await claudeState.handleRuntimeUpdate("rt_claude", "upd_claiming", "v9.9.9", "cli");

    expect(reports).toEqual([{
      status: "failed",
      error: "CLI update blocked: provider is checking for new work: codex; retry when all providers are idle",
    }]);
    expect(claudeState.claimsPaused).toBe(false);
    expect(codexState.claimsPaused).toBe(false);
    expect(codexState.pendingClaimCount).toBe(1);

    codexState.pendingClaimCount = 0;
    expect(codexState.pendingClaimCount).toBe(0);
  });

  it("releases every provider claim pause when a CLI update fails", async () => {
    const [claude, codex] = createDaemons();
    const claudeState = state(claude);
    const codexState = state(codex);
    const reports = captureReports(claudeState);
    claudeState.updateRunner = () => {
      expect(claudeState.claimsPaused).toBe(true);
      expect(codexState.claimsPaused).toBe(true);
      throw new Error("binary replacement failed");
    };

    await claudeState.handleRuntimeUpdate("rt_claude", "upd_failed", "v9.9.9", "cli");

    expect(reports).toEqual([
      { status: "running" },
      { status: "failed", error: "binary replacement failed" },
    ]);
    expect(claudeState.claimsPaused).toBe(false);
    expect(codexState.claimsPaused).toBe(false);
  });

  it("keeps agent and ACP updates independent from a busy sibling", async () => {
    for (const scope of ["agent", "acp"] as const) {
      const [claude, codex] = createDaemons();
      const claudeState = state(claude);
      const codexState = state(codex);
      const reports = captureReports(claudeState);
      let updateCalls = 0;
      claudeState.updateAgentCli = async () => {
        updateCalls++;
        return "agent updated";
      };
      claudeState.reinstallAcpBridge = () => {
        updateCalls++;
        return "bridge updated";
      };
      codexState.activeTaskCount = 1;

      await claudeState.handleRuntimeUpdate("rt_claude", `upd_${scope}`, "latest", scope);

      expect(updateCalls).toBe(1);
      expect(reports.map((report) => report.status)).toEqual(["running", "completed"]);
      expect(claudeState.claimsPaused).toBe(false);
      expect(codexState.claimsPaused).toBe(false);
    }
  });

  it("fails legacy Agent requests instead of updating a different Claude or Codex installation", async () => {
    const daemons = createDaemons();
    for (const daemon of daemons) {
      const daemonState = state(daemon);
      const reports = captureReports(daemonState);
      await daemonState.handleRuntimeUpdate("rt_managed", "upd_agent", "latest", "agent");
      expect(reports).toEqual([
        { status: "running" },
        { status: "failed", error: "Agent and ACP versions are managed by the Remi release; upgrade the machine's Remi CLI instead" },
      ]);
      expect(daemonState.claimsPaused).toBe(false);
      expect(daemon.restartRequested()).toBe(false);
    }
  });

  it("preserves the single-provider update gate when no coordinator is injected", async () => {
    const [daemon] = createDaemons(1);
    const daemonState = state(daemon);
    const reports = captureReports(daemonState);
    daemonState.activeTaskCount = 1;

    expect(daemonState.cliUpdateCoordinator).toBeNull();
    await daemonState.handleRuntimeUpdate("rt_claude", "upd_single", "v9.9.9", "cli");

    expect(reports).toEqual([{
      status: "failed",
      error: "daemon is busy; retry update when idle",
    }]);
    expect(daemonState.claimsPaused).toBe(false);
  });

  it("reports failed and resumes sibling claims when the real installer rejects the effective service entry", async () => {
    const [daemon, sibling] = createDaemons();
    const daemonState = state(daemon);
    const reports = captureReports(daemonState);
    const root = mkdtempSync(join(tmpdir(), "multiremi-cli-entry-mismatch-"));
    roots.push(root);
    const mocks = join(root, "bin");
    mkdirSync(mocks);
    const launcher = join(mocks, "remi");
    writeFileSync(launcher, "unchanged launcher");
    writeFileSync(join(mocks, "systemctl"), `#!/bin/sh\nprintf '%s\\n' '{ path=${root}/versions/old/remi ; }'\n`, { mode: 0o755 });
    const keys = ["PATH", "MULTIREMI_BIN_DIR", "MULTIREMI_INSTALL_ROOT", "MULTIREMI_STATE_DIR"];
    const original = keys.map(key => process.env[key]);
    daemonState.updateRunner = undefined;
    daemonState.updateRestartSpec = { manager: "systemd", command: ["systemctl", "--user", "restart", "--no-block", "fixture.service"] };
    try {
      process.env.PATH = `${mocks}:${original[0]}`;
      process.env.MULTIREMI_BIN_DIR = mocks;
      process.env.MULTIREMI_INSTALL_ROOT = join(root, "install");
      process.env.MULTIREMI_STATE_DIR = join(root, "state");
      await daemonState.handleRuntimeUpdate("rt_fixture", "upd_entry", "9.9.9", "cli");
    } finally {
      keys.forEach((key, index) => {
        if (original[index] === undefined) delete process.env[key];
        else process.env[key] = original[index];
      });
    }
    expect(reports.map(report => report.status)).toEqual(["running", "failed"]);
    expect(reports.at(-1)?.error).toContain(`expected launcher=${launcher}`);
    expect(reports.at(-1)?.error).toContain(`${root}/versions/old/remi`);
    expect(daemon.restartRequested()).toBe(false);
    expect(sibling!.restartRequested()).toBe(false);
    expect(daemonState.claimsPaused).toBe(false);
    expect(state(sibling).claimsPaused).toBe(false);
    expect(readFileSync(launcher, "utf8")).toBe("unchanged launcher");
    expect(existsSync(join(root, "install"))).toBe(false);
    expect(existsSync(join(root, "state"))).toBe(false);
  });

  function createDaemons(count = 2): MultiremiDaemon[] {
    const root = mkdtempSync(join(tmpdir(), "multiremi-cli-update-coordinator-"));
    roots.push(root);
    return instantiateCoResidentWorkerDaemons([
      {
        sshMeshManager: disabledSshMeshRuntime(),
        serverUrl: "http://127.0.0.1:1",
        provider: "claude",
        workspacesRoot: root,
        repoCacheRoot: join(root, "repo-cache-claude"),
      },
      ...(count > 1
        ? [{
          sshMeshManager: disabledSshMeshRuntime(),
          serverUrl: "http://127.0.0.1:1",
          provider: "codex",
          workspacesRoot: root,
          repoCacheRoot: join(root, "repo-cache-codex"),
        }]
        : []),
    ]);
  }
});

function state(daemon: MultiremiDaemon | undefined): TestDaemonState {
  if (!daemon) throw new Error("Expected daemon");
  return daemon as unknown as TestDaemonState;
}

function captureReports(daemon: TestDaemonState): UpdateReport[] {
  const reports: UpdateReport[] = [];
  daemon.client = {
    reportRuntimeUpdateResult: async (_runtimeId, _requestId, report) => {
      reports.push(report);
    },
  };
  return reports;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => { resolve = promiseResolve; });
  return { promise, resolve };
}
