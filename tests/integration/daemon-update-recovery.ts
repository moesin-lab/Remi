/** Real local API + compiled daemon + shared installer + independent watchdog.
 * Upstream release metadata and ACP use explicit fixtures; no production service or provider is used.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  const stateTimes = new Map<string, Record<string, number>>();
  const capture = (runtimeId: string) => {
    for (const [id, states] of observed) {
      const state = store.getRuntimeUpdateRequest(runtimeId, id)?.status;
      if (state && states.at(-1) !== state) {
        states.push(state);
        let times = stateTimes.get(id);
        if (!times) { times = {}; stateTimes.set(id, times); }
        times[state] ??= Date.now();
      }
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
      const fromVersion = runtime()!.metadata.cli_version;
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
      const scenario: any = { kind: crash ? "startup-exit-rollback" : (systemd ? "normal-update-systemd" : "normal-update-without-service-manager"), states, from_version: fromVersion, to_version: target, starts_from_previous_scenario: crash, unit_before: beforeUnit, unit_samples: [] };
      evidence.scenarios.push(scenario);
      await wait(`update ${target}`, () => {
        manager?.discoverWatchdogs();
        if (manager) {
          const unit = manager.state();
          if (scenario.unit_samples.at(-1)?.unit !== unit) scenario.unit_samples.push({ at_ms: Date.now(), unit });
        }
        const state = store.getRuntimeUpdateRequest(rt.id, request.id)!.status;
        if (states.at(-1) !== state) states.push(state);
        if (state === "restarting") scenario.restarting_at_ms ??= Date.now();
        return ["completed", "rolled_back", "failed", "timeout"].includes(state);
      }, systemd ? 120_000 : 30_000);
      const result = store.getRuntimeUpdateRequest(rt.id, request.id)!;
      Object.assign(scenario, { state_times_ms: stateTimes.get(request.id), result, observed_version: runtime()!.metadata.cli_version, unit_after: manager?.state() });
      assert.equal(result.status, crash ? "rolled_back" : "completed", result.error ?? "Unexpected result");
      assert.equal(runtime()!.metadata.cli_version, crash ? "1.0.1" : target);
      if (!crash) assert.deepEqual(states, ["pending", "running", "restarting", "verifying", "completed"]);
      else { assert(result.error?.includes("verification deadline")); assert.equal(readFileSync(launcher, "utf8"), previousLauncher); }
      if (manager) assert(manager.watchdogs.size >= (crash ? 2 : 1), "Real independent watchdog unit not observed");
      Object.assign(scenario, { watchdog_units: manager ? [...manager.watchdogs] : [],
        task: await taskEvidence(), launcher: readFileSync(launcher, "utf8"),
        final_launcher_target: readFileSync(launcher, "utf8").match(/^exec (.+) "\$@"$/m)?.[1] });
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
    if (manager) {
      // Intentionally bypass the launcher, reproducing an outdated service definition.
      manager.stopDaemon();
      await manager.launch(oldBinary, env, repo, [process.execPath, env.REHEARSAL_FAKE_ACP!]);
      await wait("direct binary daemon hello", () => runtime()?.metadata.cli_version === "1.0.0");
      const fileSnapshot = () => {
        const tree = (path: string): any => {
          const stat = lstatSync(path);
          if (stat.isSymbolicLink()) return { link: readlinkSync(path) };
          if (stat.isDirectory()) return Object.fromEntries(readdirSync(path).sort().map(name => [name, tree(join(path, name))]));
          return { mode: stat.mode, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
        };
        return { launcher: readFileSync(launcher, "utf8"),
          versions: tree(join(root, "install/versions")), bin: tree(env.MULTIREMI_BIN_DIR!),
          update_journals: tree(join(root, "state/cli-updates")) };
      };
      const before = fileSnapshot();
      const unitBefore = manager.state();
      const watchdogsBefore = [...manager.watchdogs];
      const since = new Date().toISOString().replace("T", " ").replace("Z", " UTC");
      const rt = runtime()!;
      const request = store.createRuntimeUpdateRequest(rt.id, { target_version: "1.0.2" });
      const states = ["pending"]; observed.set(request.id, states);
      const scenario: any = { kind: "direct-binary-service-rejected", from_version: "1.0.0", to_version: "1.0.2",
        starts_from_previous_scenario: false, states, unit_before: unitBefore, files_before: before, unit_samples: [] };
      evidence.scenarios.push(scenario);
      await wait("direct binary service update rejection", () => {
        capture(rt.id);
        scenario.unit_samples.push({ at_ms: Date.now(), unit: manager.state() });
        return ["failed", "completed", "rolled_back", "timeout"].includes(store.getRuntimeUpdateRequest(rt.id, request.id)!.status);
      });
      const result = store.getRuntimeUpdateRequest(rt.id, request.id)!;
      Object.assign(scenario, { result, state_times_ms: stateTimes.get(request.id),
        observed_version: runtime()!.metadata.cli_version, task: await taskEvidence() });
      // Include post-rejection work in the no-restart/no-watchdog observation window.
      manager.discoverWatchdogs();
      Object.assign(scenario, { unit_after: manager.state(), files_after: fileSnapshot(),
        watchdog_units_before: watchdogsBefore, watchdog_units_after: [...manager.watchdogs],
        watchdog_journal_since: since, watchdog_start_journal: manager.watchdogActivity(since),
        launcher: readFileSync(launcher, "utf8"),
        final_launcher_target: readFileSync(launcher, "utf8").match(/^exec (.+) "\$@"$/m)?.[1] });
      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /CLI update blocked: systemd actual ExecStart/);
      assert(result.error?.includes(oldBinary));
      assert(result.error?.includes(`expected launcher=${launcher}`));
      assert(!states.some(state => ["restarting", "verifying"].includes(state)));
      for (const unit of [scenario.unit_after, ...scenario.unit_samples.map((sample: any) => sample.unit)]) {
        for (const field of ["MainPID", "ExecMainStartTimestamp", "ExecMainStartTimestampMonotonic"]) {
          const pattern = new RegExp(`^${field}=(.*)$`, "m");
          assert.equal(unit.match(pattern)?.[1], unitBefore.match(pattern)?.[1], `${field} changed during rejection`);
        }
      }
      assert.deepEqual(scenario.files_after, before);
      assert.deepEqual(scenario.watchdog_units_after, watchdogsBefore);
      assert.deepEqual(scenario.watchdog_start_journal, []);
      assert.equal(scenario.observed_version, "1.0.0");
      scenario.files_unchanged = true;
      scenario.no_restart = true;
      scenario.no_watchdog_started = true;
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
    if (manager && evidence.cleanup) {
      const readEvents = (path: string) => { try { return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
      evidence.fixture_lifecycle = readEvents(join(root, "state/fixture-lifecycle.jsonl"));
      evidence.process_observations = readEvents(join(root, "process-observations.jsonl"));
      const journal = evidence.cleanup.logs.daemon as string;
      evidence.fallback_successors = [...journal.matchAll(/^(\S+).*restarting with updated binary \(pid (\d+)\)/gm)].map(match => {
        const pid = Number(match[2]);
        const at = Date.parse(match[1]!);
        const lifecycle = evidence.fixture_lifecycle.filter((event: any) => event.pid === pid);
        const samples = evidence.process_observations.filter((event: any) => event.pid === pid);
        const first = samples[0]?.at_ms ?? lifecycle[0]?.at_ms;
        const disappeared = samples.find((event: any) => event.event === "disappeared")?.at_ms;
        const zombie = samples.find((event: any) => event.state === "Z");
        return { pid, at_ms: at, lifecycle, samples, first_seen_ms: first ?? null, disappeared_ms: disappeared ?? null,
          observed_span_ms: first && disappeared ? disappeared - first : null,
          spawn_log_to_disappearance_ms: disappeared ? disappeared - at : null,
          observed_signals: lifecycle.filter((event: any) => event.event === "signal").map((event: any) => event.signal),
          zombie_exit_status: zombie?.exit_status ?? null,
          ready_observed: lifecycle.some((event: any) => event.event === "ready" && event.ready),
          provider_created_observed: lifecycle.some((event: any) => event.event === "provider-created"),
          limitation: "Only observed lifecycle signals or zombie exit_status identify termination; disappearance is not proof of a signal. Missing entry/ready/provider events cannot prove what happened before instrumentation started." };
      });
      for (const scenario of evidence.scenarios) {
        const restartingAt = scenario.state_times_ms?.restarting ?? scenario.restarting_at_ms;
        const oldPid = scenario.unit_before?.match(/^MainPID=(\d+)/m)?.[1];
        const next = scenario.unit_samples.find((sample: any) => { const pid = sample.unit.match(/^MainPID=(\d+)/m)?.[1]; return pid && pid !== "0" && pid !== oldPid; });
        scenario.restarting_to_new_mainpid_ms = restartingAt && next ? next.at_ms - restartingAt : null;
        scenario.new_mainpid_observation = next ?? null;
        const firstExec = scenario.unit_samples.find((sample: any) => { const pid = sample.unit.match(/^ExecMainPID=(\d+)/m)?.[1]; return pid && pid !== "0" && pid !== oldPid; });
        scenario.first_new_execmain_observation = firstExec ?? null;
        scenario.restarting_to_first_execmain_observed_ms = restartingAt && firstExec ? firstExec.at_ms - restartingAt : null;
        scenario.timing_precision = "Observed upper bounds from 50ms polling plus command latency; a startup-exit candidate can disappear before a live MainPID sample. ExecMainPID/ExecMainStatus and start timestamps retain that candidate's execution.";
        const from = Date.parse(scenario.result?.createdAt ?? "");
        const to = Date.parse(scenario.result?.updatedAt ?? "");
        const lines = journal.split("\n").map(line => ({ line, at_ms: Date.parse(line.split(" ")[0]!) }))
          .filter(entry => entry.at_ms >= from && entry.at_ms <= to + 1000);
        scenario.restart_journal = lines.map(entry => entry.line);
        scenario.fallback_successor_pids = evidence.fallback_successors.filter((entry: any) => entry.at_ms >= from && entry.at_ms <= to + 1000).map((entry: any) => entry.pid);
        scenario.stop_timeout_observed = scenario.restart_journal.some((line: string) => /stop-sigterm.*timed out|Killing process/.test(line));
        const stopping = lines.find(entry => /Stopping /.test(entry.line));
        const stopped = lines.find(entry => /Stopped /.test(entry.line));
        const started = lines.find(entry => /Started /.test(entry.line));
        scenario.stop_elapsed_ms = stopping && stopped ? stopped.at_ms - stopping.at_ms : null;
        scenario.manager_restart_elapsed_ms = stopping && started ? started.at_ms - stopping.at_ms : null;
      }
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
