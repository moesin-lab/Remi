import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideUpdate, renderUpdateWatchdog, updateDecision, DAEMON_STOP_TIMEOUT_MS, DAEMON_SERVICE_STOP_SECONDS, updateJournalDir } from "@shared/daemon-update.js";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import { disabledSshMeshRuntime } from "../../helpers/ssh-mesh-isolation.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "remi-watchdog-")); roots.push(directory);
  const snapshotDir = join(directory, "snapshot"); mkdirSync(snapshotDir);
  const launcherPath = join(directory, "remi");
  writeFileSync(join(snapshotDir, "previous-launcher"), "#!/bin/sh\necho old-version-ready\n", { mode: 0o755 });
  writeFileSync(launcherPath, "#!/bin/sh\nexit 23\n", { mode: 0o755 });
  const journal = { runtimeId: "rt_test", requestId: "upd_test", targetVersion: "9.9.9", previousVersion: "1.0.0", launcherPath, snapshotDir };
  const script = join(directory, "watchdog.sh");
  writeFileSync(script, renderUpdateWatchdog({ directory, journal, restart: [launcherPath], timeoutSeconds: 0.05 }));
  return { directory, script, launcherPath };
}
async function run(script: string) {
  const child = Bun.spawn(["/bin/sh", script], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(stderr).toBe(""); expect(code).toBe(0); return stdout;
}
test("startup-exit candidate rolls back atomically and restarts the old launcher", async () => {
  const f = fixture();
  const candidate = Bun.spawn([f.launcherPath]); expect(await candidate.exited).toBe(23);
  expect(await run(f.script)).toBe("old-version-ready\n");
  expect(updateDecision(f.directory)).toBe("rolled_back");
  expect(readFileSync(join(f.directory, "reason"), "utf8")).toContain("verification deadline");
  expect(decideUpdate(f.directory, "completed")).toBe(false);
});
test("a confirmed hello wins against a late watchdog without changing the launcher", async () => {
  const f = fixture(); const before = readFileSync(f.launcherPath, "utf8");
  expect(decideUpdate(f.directory, "completed")).toBe(true);
  expect(await run(f.script)).toBe("");
  expect(readFileSync(f.launcherPath, "utf8")).toBe(before);
  expect(existsSync(join(f.directory, "reason"))).toBe(false);
});
test("stop deadline kills an unresponsive bridge process group before the manager timeout", async () => {
  expect(DAEMON_STOP_TIMEOUT_MS).toBeLessThan(DAEMON_SERVICE_STOP_SECONDS * 1000);
  const root = mkdtempSync(join(tmpdir(), "remi-stop-deadline-")); roots.push(root);
  const child = spawn("/bin/sh", ["-c", "sleep 300 & wait"], { detached: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  let forced!: () => void;
  const deadline = new Promise<void>(resolve => { forced = resolve; });
  const daemon = new MultiremiDaemon({ serverUrl: "http://127.0.0.1:1", provider: "codex", daemonPort: 0,
    workspacesRoot: root, repoCacheRoot: join(root, "cache"), outboxPath: ":memory:",
    sshMeshManager: disabledSshMeshRuntime(), stopTimeoutMs: 30, onStopTimeout: forced,
  });
  const internals = daemon as any;
  internals.runActive = true;
  internals.liveUpdateProviders.set({ processGroupId: (chat: string) => chat === "hung-chat" ? child.pid : null }, "hung-chat");
  const exit = new Promise(resolve => child.once("exit", resolve));
  try {
    daemon.stop(); await deadline; await exit;
    expect(child.signalCode).toBe("SIGKILL");
    // Killing the negative pgid also kills the sleep child, rather than orphaning it.
    let liveMembers = "";
    if (process.platform === "linux") {
      const result = Bun.spawnSync(["ps", "-eo", "pgid=,stat=,args="]);
      liveMembers = result.stdout.toString().split("\n").filter(line => {
        const [pgid, state] = line.trim().split(/\s+/);
        return pgid === String(child.pid) && !state?.startsWith("Z");
      }).join("\n");
    }
    expect(liveMembers).toBe("");
  } finally { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }
});

test("a late watchdog cannot arbitrate or roll back a later request", async () => {
  const root = mkdtempSync(join(tmpdir(), "remi-watchdog-reuse-")); roots.push(root);
  const first = updateJournalDir(root, "rt_same", "request_1");
  const next = updateJournalDir(root, "rt_same", "request_2");
  expect(first).not.toBe(next);
  mkdirSync(first, { recursive: true }); mkdirSync(next, { recursive: true });
  expect(decideUpdate(first, "completed")).toBe(true);
  expect(decideUpdate(next, "rolled_back")).toBe(true);
  expect(updateDecision(first)).toBe("completed");
  expect(updateDecision(next)).toBe("rolled_back");
});

test("default supervisor exit kills both co-resident providers' detached bridge groups", async () => {
  const root = mkdtempSync(join(tmpdir(), "remi-multi-stop-")); roots.push(root);
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../fixtures/multi-provider-stop.ts"), root], {
    stdout: "pipe", stderr: "pipe",
  });
  let pgids: number[] = [];
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    pgids = JSON.parse(stdout.trim().split("\n").find(line => /^\[\d/.test(line))!);
    expect(pgids).toHaveLength(2);
    expect(code).toBe(1); // default process.exit, no onStopTimeout mock
    expect(stderr).toContain("graceful stop deadline exceeded");
    // Wait for kernel delivery/reaping, then reject any live member including descendants.
    let liveMembers: string[] = [];
    for (let attempt = 0; attempt < 50; attempt++) {
      const result = Bun.spawnSync(["ps", "-eo", "pgid=,stat=,args="]);
      liveMembers = result.stdout.toString().split("\n").filter(line => {
        const [pgid, state] = line.trim().split(/\s+/);
        return pgids.includes(Number(pgid)) && !state?.startsWith("Z");
      });
      if (!liveMembers.length) break;
      await Bun.sleep(20);
    }
    expect(liveMembers).toEqual([]);
  } finally {
    child.kill();
    for (const pgid of pgids) { try { process.kill(-pgid, "SIGKILL"); } catch {} }
  }
}, 10_000);
