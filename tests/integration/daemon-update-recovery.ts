/** Real local API + compiled daemon + shared installer + independent watchdog.
 * Upstream release metadata and ACP use explicit fixtures; no production service or provider is used.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import { startMultiremiServer } from "@multiremi/api.js";
import { SystemdRehearsal } from "./daemon-update-systemd.js";

export async function runUpdateRecovery(output: string, systemd = false) {
  const parent = systemd ? resolve(process.env.REMI_REHEARSAL_ROOT ?? join(realpathSync(homedir()), ".cache/remi-rehearsals")) : tmpdir();
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "mul28-recovery-"));
  const manager = systemd ? new SystemdRehearsal(root) : null;
  const evidence: any = { kind: "isolated-daemon-update", scenarios: [], systemd, fixture_release: true, fixture_acp: true, root };
  mkdirSync(output, { recursive: true });
  const repo = resolve(import.meta.dir, "../..");
  const processes: ReturnType<typeof Bun.spawn>[] = [];
  const logs: string[] = [];
  const collectors: Promise<void>[] = [];
  const db = openSqliteDatabase(join(root, "api.sqlite"));
  const store = new MultiremiStore(db); store.ensureLocalWorkspace();
  const token = await store.createAccessToken({ name: "MUL-28 isolated daemon", type: "daemon", workspaceId: "local", daemonId: "mul28-rehearsal" });
  const server = startMultiremiServer({ store, scheduler: null, backgroundJobs: false, authToken: crypto.randomUUID(), hostname: "127.0.0.1", port: 0 });
  let metadata: any = {};
  let archive: Uint8Array = new Uint8Array();
  const releases = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new URL(request.url).pathname === "/metadata" ? Response.json(metadata) : new Response(Buffer.from(archive)) });
  for (const port of [server.port!, releases.port!]) assert(![6131, 6132, 6133, 6134].includes(port));
  evidence.ports = [server.port, releases.port];
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !/^(MULTIREMI_|REMI_|CODEX_|CLAUDE_|OPENAI_|ANTHROPIC_|INVOCATION_ID|XPC_SERVICE_NAME)/.test(k))) as Record<string, string>;
  Object.assign(env, { NODE_ENV: "test", MULTIREMI_UPDATE_REHEARSAL: "1", HOME: join(root, "home"), TMPDIR: join(root, "tmp"),
    MULTIREMI_STATE_DIR: join(root, "state"), MULTIREMI_TEST_RUN_ROOT: join(root, "locks"), MULTIREMI_WORKSPACES_ROOT: join(root, "workspaces"),
    MULTIREMI_INSTALL_ROOT: join(root, "install"), MULTIREMI_BIN_DIR: join(root, "home/.local/bin"),
    MULTIREMI_SERVER_URL: `http://127.0.0.1:${server.port}`, MULTIREMI_TOKEN: token.token,
    MULTIREMI_DAEMON_PORT: "0", REHEARSAL_RELEASE_URL: `http://127.0.0.1:${releases.port}`,
    REHEARSAL_SYSTEMD: systemd ? "1" : "0", PATH: `${resolve(process.execPath, "..")}:${process.env.PATH}`,
    REHEARSAL_BUN: process.execPath, REHEARSAL_FAKE_ACP: join(repo, "tests/fixtures/acp/fake-steering-agent.ts"),
  });
  for (const name of ["home", "tmp", "state", "locks", "workspaces", "install/versions/old", "home/.local/bin", "candidate"]) mkdirSync(join(root, name), { recursive: true });
  const oldBinary = join(root, "install/versions/old/remi");
  const candidate = join(root, "candidate/remi");
  const launcher = join(root, "home/.local/bin/remi");
  async function command(argv: string[]) {
    const result = Bun.spawn(argv, { cwd: repo, stdout: "pipe", stderr: "pipe", env });
    const [stdout, stderr, code] = await Promise.all([new Response(result.stdout).text(), new Response(result.stderr).text(), result.exited]);
    assert.equal(code, 0, stderr); return stdout;
  }
  let interrupted = "";
  const onInterrupt = (signal: string) => { interrupted = signal; };
  process.on("SIGINT", onInterrupt); process.on("SIGTERM", onInterrupt);
  async function wait(label: string, predicate: () => boolean | Promise<boolean>, budget = 30_000) {
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) { if (interrupted) throw new Error(`Interrupted: ${interrupted}`); if (await predicate()) return; await Bun.sleep(50); }
    throw new Error(`Timeout ${label}; see update-recovery.log`);
  }
  function runtime() { return store.listRuntimes().find(rt => rt.daemonId === "mul28-rehearsal"); }
  async function launch() {
    if (manager) return manager.launch(launcher, env, repo, [oldBinary, process.execPath, env.REHEARSAL_FAKE_ACP!]);
    const child = Bun.spawn([launcher, "daemon", "start", "--foreground"], { env, cwd: repo, stdout: "pipe", stderr: "pipe" });
    processes.push(child);
    for (const stream of [child.stdout, child.stderr]) collectors.push((async () => { for await (const bytes of stream) logs.push(new TextDecoder().decode(bytes).replaceAll(token.token, "<redacted>")); })());
    return child;
  }
  async function taskEvidence() {
    const agent = store.createAgent({ name: "MUL-28 acceptance", provider: "codex", runtimeId: runtime()!.id });
    const chat = store.createChatSession({ agentId: agent.id });
    const task = store.sendChatMessage(chat.id, { body: "Verify restored daemon takes work" }).task;
    await wait("task completion", () => store.getTask(task.id)?.status === "completed");
    assert.match(store.getTask(task.id)!.result!, /MUL28_TASK_OK/);
    return { task_id: task.id, status: store.getTask(task.id)!.status };
  }
  const observed = new Map<string, string[]>();
  const capture = (runtimeId: string) => {
    for (const [id, states] of observed) {
      const state = store.getRuntimeUpdateRequest(runtimeId, id)?.status;
      if (state && states.at(-1) !== state) states.push(state);
    }
  };
  const hello = store.recordDaemonProtocol.bind(store);
  store.recordDaemonProtocol = (...args) => { const result = hello(...args); capture(args[0]); return result; };
  const report = store.reportRuntimeUpdateResult.bind(store);
  store.reportRuntimeUpdateResult = (...args) => { capture(args[0]); const result = report(...args); capture(args[0]); return result; };
  let failure: unknown;
  try {
    evidence.sha = (await command(["git", "rev-parse", "HEAD"])).trim();
    for (const [version, binary] of [["1.0.0", oldBinary], ["1.0.1", candidate]]) {
      await command([process.execPath, "build", "--compile", "--define", `MULTIREMI_VERSION=${JSON.stringify(version)}`, "tests/fixtures/daemon-update-entry.ts", "--outfile", binary!]);
    }
    writeFileSync(launcher, `#!/bin/sh\nexec '${oldBinary}' "$@"\n`, { mode: 0o755 });
    await launch();
    await wait("old daemon hello", () => runtime()?.metadata.cli_version === "1.0.0");
    for (const crash of [false, true]) {
      const previousLauncher = readFileSync(launcher, "utf8");
      const beforeUnit = manager?.state();
      const target = crash ? "1.0.2" : "1.0.1";
      if (crash) { writeFileSync(candidate, `#!/bin/sh\nif [ "$1" = --version ]; then echo ${target}; exit 0; fi\nexit 23\n`); chmodSync(candidate, 0o755); }
      await command(["tar", "-czf", join(root, "release.tar.gz"), "-C", join(root, "candidate"), "remi"]);
      archive = readFileSync(join(root, "release.tar.gz"));
      metadata = { tag_name: `v${target}`, assets: [{ name: `remi-${target}-linux-${process.arch}.tar.gz`, browser_download_url: `${env.REHEARSAL_RELEASE_URL}/release.tar.gz`, size: archive.length, digest: `sha256:${createHash("sha256").update(archive).digest("hex")}` }] };
      const rt = runtime()!;
      const request = store.createRuntimeUpdateRequest(rt.id, { target_version: target });
      const states: string[] = ["pending"]; observed.set(request.id, states);
      const scenario: any = { kind: crash ? "startup-exit-rollback" : (systemd ? "normal-update-systemd" : "normal-update-without-service-manager"), states, unit_before: beforeUnit };
      evidence.scenarios.push(scenario);
      await wait(`update ${target}`, () => {
        manager?.discoverWatchdogs();
        const state = store.getRuntimeUpdateRequest(rt.id, request.id)!.status;
        if (states.at(-1) !== state) states.push(state);
        return ["completed", "rolled_back", "failed", "timeout"].includes(state);
      }, systemd ? 120_000 : 30_000);
      const result = store.getRuntimeUpdateRequest(rt.id, request.id)!;
      Object.assign(scenario, { result, observed_version: runtime()!.metadata.cli_version, unit_after: manager?.state() });
      assert.equal(result.status, crash ? "rolled_back" : "completed", result.error ?? "Unexpected result");
      assert.equal(runtime()!.metadata.cli_version, crash ? "1.0.1" : target);
      if (!crash) assert.deepEqual(states, ["pending", "running", "restarting", "verifying", "completed"]);
      else { assert(result.error?.includes("verification deadline")); assert.equal(readFileSync(launcher, "utf8"), previousLauncher); }
      if (manager) assert(manager.watchdogs.size >= (crash ? 2 : 1), "Real independent watchdog unit not observed");
      Object.assign(scenario, { watchdog_units: manager ? [...manager.watchdogs] : [],
        task: await taskEvidence(), launcher: readFileSync(launcher, "utf8") });
      // The fallback process writes its pid into the active journal before hello.
      const settled = readdirSync(join(root, "state/cli-updates")).filter(name => name.endsWith(".settled"));
      evidence.settled = settled;
      scenario.watchdog_decisions = settled.map(name => {
        const directory = join(root, "state/cli-updates", name);
        return { name, decision: readlinkSync(join(directory, "decision")),
          reason: (() => { try { return readFileSync(join(directory, "reason"), "utf8").trim(); } catch { return null; } })(),
          script: readFileSync(join(directory, "watchdog.sh"), "utf8") };
      });
    }
    evidence.ok = true;
  } catch (error) { failure = error; evidence.ok = false; evidence.error = String(error); }
  finally {
    // Successors inherit the log pipes but are detached from the initial parent.
    const pids = new Set<number>(processes.map(p => p.pid));
    const updateRoot = join(root, "state/cli-updates");
    try { for (const name of readdirSync(updateRoot)) {
      if (!manager) { try { pids.add(Number(readFileSync(join(updateRoot, name, "candidate.pid"), "utf8"))); } catch {} }
    } } catch {}
    for (const pid of pids) if (pid > 1) { try { process.kill(pid, "SIGTERM"); } catch {} }
    await Bun.sleep(500);
    for (const pid of pids) if (pid > 1) { try { process.kill(pid, "SIGKILL"); } catch {} }
    releases.stop(true); server.stop(true); db.close();
    if (manager) {
      try {
        evidence.cleanup = await manager.cleanup(evidence.ports);
        logs.push(evidence.cleanup.logs.daemon.replaceAll(token.token, "<redacted>"));
        assert(evidence.cleanup.ok, "Cleanup or production snapshot comparison failed");
      } catch (error) { failure ??= error; evidence.ok = false; evidence.cleanup_error = String(error); }
    }
    writeFileSync(join(output, "update-recovery.log"), logs.join("\n"));
    writeFileSync(join(output, "update-recovery.json"), JSON.stringify(evidence, null, 2).replaceAll(token.token, "<redacted>"));
    try { for (const name of readdirSync(updateRoot)) {
      try { writeFileSync(join(output, `${name}-watchdog.log`), readFileSync(join(updateRoot, name, "watchdog.log"))); } catch {}
    } } catch {}
    process.off("SIGINT", onInterrupt); process.off("SIGTERM", onInterrupt);
    if (manager || !failure) rmSync(root, { recursive: true, force: true });
  }
  if (failure) throw failure;
  return evidence;
}
if (import.meta.main) {
  const systemd = process.argv.includes("--systemd");
  if (systemd && process.env.MULTIREMI_SYSTEMD_REHEARSAL !== "1") {
    console.log("SKIP: real user systemd rehearsal requires MULTIREMI_SYSTEMD_REHEARSAL=1; no fallback executed");
  } else await runUpdateRecovery(resolve(process.argv.find(arg => arg.startsWith("--output="))?.slice(9) ?? (systemd ? join(realpathSync(homedir()), ".cache/remi-rehearsal-results") : "/tmp/mul28-recovery-results")), systemd);
}
