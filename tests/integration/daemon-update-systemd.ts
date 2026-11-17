/** Read-only production snapshots and ownership-scoped transient unit operations. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DAEMON_SERVICE_STOP_SECONDS } from "@shared/daemon-update.js";

function run(argv: string[], allowFailure = false) {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  const stdout = result.stdout.toString();
  if (!allowFailure) assert.equal(result.exitCode, 0, `${argv[0]}: ${result.stderr}`);
  return stdout.trim();
}
function units() {
  return run(["systemctl", "--user", "list-units", "--all", "--no-legend", "--plain", "remi-*rehearsal*", "remi-update-*"])
    .split("\n").filter(Boolean).map(line => line.trim().split(/\s+/)[0]!);
}
function listing(path: string): unknown {
  if (!existsSync(path)) return null;
  return readdirSync(path).sort().map(name => {
    const file = join(path, name), stat = lstatSync(file);
    return { name, mode: stat.mode, size: stat.size, link: stat.isSymbolicLink() ? readlinkSync(file) : null };
  });
}
function hostRun(argv: string[], allowFailure = false) {
  return run(["/usr/bin/systemd-run", "--user", "--wait", "--pipe", "--collect", "--quiet",
    `--unit=remi-rehearsal-observe-${randomUUID()}`, ...argv], allowFailure);
}
function listeners() { return hostRun(["/usr/bin/ss", "-H", "-ltnp"]); }
export function productionSnapshot() {
  const home = homedir(), binary = join(home, ".local/bin/remi");
  return {
    unit: run(["systemctl", "--user", "show", "-p", "MainPID", "-p", "ExecStart", "multiremi-daemon.service"]),
    remi_sha256: existsSync(binary) ? createHash("sha256").update(readFileSync(binary)).digest("hex") : null,
    stable: listing(join(home, ".remi/profiles/stable")),
    dropins: listing(join(home, ".config/systemd/user/multiremi-daemon.service.d")),
    listeners: listeners().split("\n").filter(line => /:613[1-4]\b/.test(line)).sort(),
  };
}
export class SystemdRehearsal {
  readonly unit = `remi-rehearsal-${randomUUID()}.service`;
  readonly watchdogs = new Set<string>();
  readonly monitor = this.unit.replace(".service", "-monitor.service");
  readonly before = productionSnapshot();
  constructor(readonly root: string) {
    assert.equal(process.platform, "linux", "systemd rehearsal requires Linux");
    assert(existsSync("/usr/bin/systemd-run"), "systemd-run missing; no fallback allowed");
    assert.deepEqual(units(), [], "Existing rehearsal/update units; stop without touching them");
  }
  private monitoring = false;
  async launch(executable: string, env: Record<string, string>, cwd: string, dependencies: string[]) {
    // A reachable user bus alone does not prove the manager shares our mount namespace.
    const probe = Bun.spawnSync(["/usr/bin/systemd-run", "--user", "--wait", "--pipe", "--collect",
      `--unit=${this.unit.replace(".service", "-probe.service")}`, "/bin/sh", "-c", 'for file do test -r "$file" || exit 1; done', "preflight", this.root, executable, ...dependencies],
      { stdout: "pipe", stderr: "pipe" });
    assert.equal(probe.exitCode, 0, `User manager cannot see the isolated root or its dependencies (permissions or mount namespace); no fallback allowed: ${probe.stderr}`);
    if (!this.monitoring) {
      run(["/usr/bin/systemd-run", "--user", "--collect", `--unit=${this.monitor}`,
        "/usr/bin/python3", join(cwd, "tests/fixtures/daemon-update-monitor.py"), this.root]);
      this.monitoring = true;
    }
    // Pass only fixture settings. Manager-provided INVOCATION_ID identifies the real unit.
    // Keep a failed transient definition until rollback restarts it. --collect would
    // unload it after exit 23, unlike the installed product service.
    run(["/usr/bin/systemd-run", "--user", `--unit=${this.unit}`,
      `--property=TimeoutStopSec=${DAEMON_SERVICE_STOP_SECONDS}s`, "--property=KillMode=control-group",
      `--property=WorkingDirectory=${cwd}`,
      ...Object.entries(env).filter(([key]) => /^(HOME|PATH|TMPDIR|NODE_ENV|MULTIREMI_|REHEARSAL_)/.test(key))
        .map(([key, value]) => `--setenv=${key}=${value}`), executable, "daemon", "start", "--foreground"]);
  }
  stopDaemon() {
    run(["systemctl", "--user", "stop", this.unit]);
    run(["systemctl", "--user", "reset-failed", this.unit], true);
  }
  watchdogActivity(since: string) {
    return hostRun(["/usr/bin/journalctl", "--user", "--since", since, "--no-pager", "-o", "short-iso-precise"])
      .split("\n").filter(line => line.includes("remi-update-"));
  }
  state() {
    return run(["systemctl", "--user", "show", this.unit, "-p", "MainPID", "-p", "ExecStart", "-p", "ActiveState", "-p", "SubState", "-p", "TimeoutStopUSec", "-p", "KillMode", "-p", "ExecMainStartTimestamp", "-p", "ExecMainStartTimestampMonotonic", "-p", "ExecMainPID", "-p", "ExecMainCode", "-p", "ExecMainStatus", "-p", "Result"]);
  }
  discoverWatchdogs() {
    for (const unit of units().filter(unit => unit.startsWith("remi-update-"))) {
      const exec = run(["systemctl", "--user", "show", unit, "-p", "ExecStart"]);
      if (exec.includes(`${this.root}/state/cli-updates/`)) this.watchdogs.add(unit);
    }
  }
  journal(unit = this.unit) {
    return hostRun(["/usr/bin/journalctl", "--user", "-u", unit, "--no-pager", "-o", "short-iso-precise"], true);
  }
  async cleanup(ports: number[]) {
    this.discoverWatchdogs();
    const logs = { daemon: this.journal(), watchdogs: [...this.watchdogs].map(unit => ({ unit, journal: this.journal(unit) })) };
    for (const unit of [...this.watchdogs, this.unit, this.monitor]) {
      run(["systemctl", "--user", "stop", unit], true);
      run(["systemctl", "--user", "reset-failed", unit], true);
    }
    const deadline = Date.now() + 5000;
    while (units().length && Date.now() < deadline) await Bun.sleep(50);
    const remaining = units();
    const processes = JSON.parse(hostRun(["/usr/bin/python3", "-c", `
import json, pathlib
found = []
for path in pathlib.Path('/proc').glob('[0-9]*/environ'):
    try:
        if ${JSON.stringify(`MULTIREMI_STATE_DIR=${this.root}/state`)}.encode() + bytes([0]) in path.read_bytes():
            found.append(path.parent.name)
    except (PermissionError, FileNotFoundError, ProcessLookupError):
        pass
print(json.dumps(sorted(found)))
`]));
    const daemonPorts = [...logs.daemon.matchAll(/Repo checkout server listening on 127\.0\.0\.1:(\d+)/g)].map(match => Number(match[1]));
    const allPorts = [...new Set([...ports, ...daemonPorts])];
    const listening = listeners().split("\n").filter(line => allPorts.some(port => new RegExp(`:${port}\\b`).test(line)));
    const after = productionSnapshot();
    return { logs, isolated_ports: allPorts, remaining_units: remaining, remaining_processes: processes, remaining_listeners: listening,
      production_before: this.before, production_after: after, production_unchanged: JSON.stringify(this.before) === JSON.stringify(after),
      ok: !remaining.length && !processes.length && !listening.length && JSON.stringify(this.before) === JSON.stringify(after) };
  }
}
