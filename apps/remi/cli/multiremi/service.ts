import { DAEMON_SERVICE_STOP_SECONDS } from "@shared/daemon-update.js";
/**
 * Multiremi CLI — daemon launch spec plus launchd/systemd unit templating.
 *
 * Extracted verbatim from the former single-file `cli/multiremi.ts`.
 */

import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, extname, join, relative, resolve, sep } from "node:path";
import { type CliOptions, stringOpt, numberOpt } from "./options.js";

export const DEFAULT_DAEMON_PORT = 6131;

export interface MultiremiDaemonLaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  stateDir: string;
  logPath: string;
  pidPath: string;
  port: number;
}

export type MultiremiDaemonServicePlatform = "launchd" | "systemd";

export type DaemonRestartPlan =
  | { kind: "service-manager"; command: string; args: string[] }
  | { kind: "spawn-successor" };

/**
 * How a foreground daemon should hand off to a freshly installed binary.
 *
 * Under systemd or launchd the manager owns the service cgroup and is already
 * configured to restart the unit (`Restart=always` / `KeepAlive`). Spawning a
 * detached successor is wrong there in both directions: exiting the main
 * process makes systemd tear the cgroup down and take the successor with it,
 * and staying alive to dodge that leak leaves one idle supervisor per upgrade
 * inside the unit — the pile grows every release and every one of them keeps
 * its runtime registration alive under the same identity.
 *
 * Ask the manager for a restart instead. It replaces the entire cgroup with a
 * single process on the new binary, which also clears any pile left behind by
 * an older release.
 */
export function planDaemonRestart(input: {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** Contents of /proc/self/cgroup, used to name the unit without systemctl. */
  cgroup?: string | null;
  uid?: number | null;
  defaultUnitName?: string;
}): DaemonRestartPlan {
  const fallbackUnit = input.defaultUnitName ?? "multiremi-daemon.service";
  if (input.platform === "linux" && input.env.INVOCATION_ID) {
    const unit = systemdUnitFromCgroup(input.cgroup) ?? fallbackUnit;
    return { kind: "service-manager", command: "systemctl", args: ["--user", "restart", "--no-block", unit] };
  }
  const label = input.env.XPC_SERVICE_NAME;
  if (input.platform === "darwin" && label) {
    const uid = input.uid ?? 0;
    return { kind: "service-manager", command: "launchctl", args: ["kickstart", "-k", `gui/${uid}/${label}`] };
  }
  return { kind: "spawn-successor" };
}

/**
 * The unit this process runs in, read from /proc/self/cgroup, e.g.
 * `multiremi-daemon.service`.
 *
 * Only the unified (`0::`) and `name=systemd` hierarchies follow systemd's unit
 * tree. On a cgroup v1 host the controller hierarchies (`pids`, `memory`, …)
 * stop at the user manager, so the first `.service` there is
 * `user@<uid>.service` — a system unit `systemctl --user` cannot find, which
 * silently sent every upgrade back to the spawned-successor path.
 */
export function systemdUnitFromCgroup(cgroup: string | null | undefined): string | null {
  if (!cgroup) return null;
  const paths = new Map<string, string>();
  for (const line of cgroup.split("\n")) {
    const match = /^\d+:([^:]*):(.*)$/.exec(line.trim());
    if (match) paths.set(match[1]!, match[2]!);
  }
  for (const hierarchy of ["", "name=systemd"]) {
    const last = paths.get(hierarchy)?.split("/").filter(Boolean).at(-1);
    if (last && last.endsWith(".service")) return last;
  }
  return null;
}

export type SuccessorRestartPlan =
  | { kind: "none" }
  | { kind: "blocked"; unit: string; mainPid: number; reason: string }
  | { kind: "service-manager"; unit: string; mainPid: number; command: string; args: string[] };

/**
 * Whether this daemon was spawned beside its systemd unit's main process and
 * should ask systemd to collapse the unit into a single process.
 *
 * Releases before the cgroup fix could not name the unit on cgroup v1 hosts,
 * so their upgrade fell back to spawning a successor and left the predecessor
 * (and every earlier one) inside the unit. The release that ships the fix is
 * still started by that old code, so the first process on the new binary is
 * such a successor; restarting the unit from here is what retires the pile
 * without waiting for another release.
 *
 * Restarting the unit kills every process in it, so this only proceeds for a
 * process the fallback itself spawned: every ancestor up to the unit's main
 * process must be a foreground daemon. Task processes run inside the unit and
 * inherit INVOCATION_ID, but a daemon a task starts has a shell or agent
 * runtime between it and the unit's daemons, whatever HOME, state directory
 * or port it was given. The main process must itself be a foreground daemon,
 * so an unrelated unit that happens to host a daemon is never restarted. And
 * no other daemon may hold a workspace supervisor lease, since a live lease
 * means a daemon may be running tasks.
 */
export function planSpawnedSuccessorRestart(input: {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  cgroup: string | null | undefined;
  pid: number;
  mainPid: (unit: string) => number | null;
  parentPid: (pid: number) => number | null;
  commandLine: (pid: number) => string[] | null;
  activeSupervisorPids: () => number[];
}): SuccessorRestartPlan {
  if (input.platform !== "linux" || !input.env.INVOCATION_ID) return { kind: "none" };
  const unit = systemdUnitFromCgroup(input.cgroup);
  if (!unit) return { kind: "none" };
  const mainPid = input.mainPid(unit);
  if (!mainPid || mainPid === input.pid) return { kind: "none" };
  if (!isForegroundDaemonCommand(input.commandLine(mainPid))) {
    return { kind: "blocked", unit, mainPid, reason: "the unit's main process is not a foreground daemon" };
  }
  if (!descendsThroughDaemons(input.pid, mainPid, input.parentPid, input.commandLine)) {
    return { kind: "blocked", unit, mainPid, reason: "this process was not spawned by the unit's daemons" };
  }
  let supervisors: number[];
  try {
    supervisors = input.activeSupervisorPids().filter((pid) => pid !== input.pid);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "blocked", unit, mainPid, reason: `workspace supervisor leases are unreadable (${message})` };
  }
  if (supervisors.length > 0) {
    return { kind: "blocked", unit, mainPid, reason: `daemon pid ${supervisors.join(", ")} still owns a workspace root` };
  }
  return { kind: "service-manager", unit, mainPid, command: "systemctl", args: ["--user", "restart", "--no-block", unit] };
}

/**
 * Whether `pid` reaches `mainPid` through foreground daemons only — the chain
 * the spawn fallback leaves behind, one successor per release. A missing
 * parent (the process exited, or the walk hit the service manager) is false.
 */
function descendsThroughDaemons(
  pid: number,
  mainPid: number,
  parentPid: (pid: number) => number | null,
  commandLine: (pid: number) => string[] | null,
): boolean {
  let current = parentPid(pid);
  for (let depth = 0; current && depth < 64; depth++) {
    if (current === mainPid) return true;
    if (!isForegroundDaemonCommand(commandLine(current))) return false;
    current = parentPid(current);
  }
  return false;
}

/** `… daemon start … --foreground …`, as written by the service installer and the spawn fallback. */
function isForegroundDaemonCommand(argv: string[] | null | undefined): boolean {
  if (!argv) return false;
  const daemon = argv.indexOf("daemon");
  return daemon >= 0 && argv[daemon + 1] === "start" && argv.includes("--foreground");
}

export interface MultiremiDaemonServiceSpec {
  platform: MultiremiDaemonServicePlatform;
  label: string;
  unitName: string;
  path: string;
  content: string;
  enableCommands: string[][];
  disableCommands: string[][];
}

export function buildMultiremiDaemonLaunchSpec(
  options: CliOptions = {},
  programName = "multiremi",
  argv = process.argv,
  execPath = process.execPath,
  forRestart = false,
): MultiremiDaemonLaunchSpec {
  const launcher = currentProcessLauncher(argv, execPath, forRestart);
  const port = daemonPortFromOptions(options);
  const paths = multiremiDaemonPaths();
  return {
    command: launcher.command,
    args: [
      ...launcher.argsPrefix,
      ...programSubcommandPrefix(programName),
      ...buildDaemonForegroundArgs(options),
    ],
    env: daemonLaunchEnv(options),
    stateDir: paths.stateDir,
    logPath: paths.logPath,
    pidPath: paths.pidPath,
    port,
  };
}

export function buildMultiremiDaemonServiceSpec(
  options: CliOptions = {},
  programName = "multiremi",
  platform = detectMultiremiServicePlatform(),
  homeDir = homedir(),
  argv = process.argv,
  execPath = process.execPath,
): MultiremiDaemonServiceSpec {
  if (stringOpt(options.token, undefined)) {
    throw new Error("daemon service install does not write tokens into service files; run `multiremi login --token <token>` first");
  }
  const spec = buildMultiremiDaemonLaunchSpec(options, programName, argv, execPath);
  const serviceDir = stringOpt(options.serviceDir ?? options["service-dir"], undefined);
  const path = multiremiDaemonServicePath(platform, homeDir, serviceDir);
  const label = "dev.remi.multiremi.daemon";
  const unitName = "multiremi-daemon.service";
  const env = {
    ...spec.env,
    MULTIREMI_STATE_DIR: spec.stateDir,
  };
  const content = platform === "launchd"
    ? renderLaunchdService({ label, spec, env })
    : renderSystemdService({ spec, env });
  return {
    platform,
    label,
    unitName,
    path,
    content,
    enableCommands: platform === "launchd"
      ? launchdEnableCommands(label, path)
      : [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", unitName]],
    disableCommands: platform === "launchd"
      ? launchdDisableCommands(label)
      : [["systemctl", "--user", "disable", "--now", unitName], ["systemctl", "--user", "daemon-reload"]],
  };
}

export function detectMultiremiServicePlatform(platform = process.platform): MultiremiDaemonServicePlatform {
  return platform === "darwin" ? "launchd" : "systemd";
}

export function servicePlatformFromOptions(options: CliOptions): MultiremiDaemonServicePlatform {
  const platform = stringOpt(options.platform, undefined);
  if (!platform) return detectMultiremiServicePlatform();
  if (platform === "launchd" || platform === "systemd") return platform;
  throw new Error("invalid daemon service platform; expected launchd or systemd");
}

export function multiremiDaemonServicePath(
  platform: MultiremiDaemonServicePlatform,
  homeDir = homedir(),
  serviceDir?: string | null,
): string {
  if (serviceDir) {
    return join(serviceDir, platform === "launchd" ? "dev.remi.multiremi.daemon.plist" : "multiremi-daemon.service");
  }
  if (platform === "launchd") return join(homeDir, "Library", "LaunchAgents", "dev.remi.multiremi.daemon.plist");
  return join(homeDir, ".config", "systemd", "user", "multiremi-daemon.service");
}

export function buildDaemonForegroundArgs(options: CliOptions = {}): string[] {
  const args = ["daemon", "start", "--foreground"];
  pushStringOption(args, "--server", options.server ?? options["server-url"]);
  pushStringOption(args, "--workspace", options.workspace ?? options["workspace-id"]);
  pushStringOption(args, "--provider", options.provider);
  pushStringOption(args, "--runtime-id", options.runtimeId ?? options["runtime-id"]);
  pushStringOption(args, "--daemon-id", options.daemonId ?? options["daemon-id"]);
  pushStringOption(args, "--daemon-port", options.daemonPort ?? options["daemon-port"]);
  pushStringOption(args, "--repo-cache-root", options.repoCacheRoot ?? options["repo-cache-root"]);
  pushStringOption(args, "--name", options.name ?? options["runtime-name"]);
  pushStringOption(args, "--device-name", options["device-name"] ?? options.deviceName);
  pushStringOption(args, "--max-concurrency", options["max-concurrency"] ?? options.maxConcurrency);
  pushStringOption(args, "--log-level", options.logLevel ?? options["log-level"]);
  return args;
}

export function multiremiDaemonPaths(stateDir = process.env.MULTIREMI_STATE_DIR ?? join(homedir(), ".multiremi")): {
  stateDir: string;
  pidPath: string;
  logPath: string;
} {
  return {
    stateDir,
    pidPath: join(stateDir, "daemon.pid"),
    logPath: join(stateDir, "daemon.log"),
  };
}

export function daemonPortFromOptions(options: CliOptions): number {
  return numberOpt(options.daemonPort ?? options["daemon-port"], process.env.MULTIREMI_DAEMON_PORT, DEFAULT_DAEMON_PORT);
}

export function daemonLaunchEnv(options: CliOptions): Record<string, string> {
  const env: Record<string, string> = {};
  const token = stringOpt(options.token, undefined);
  if (token) env.MULTIREMI_TOKEN = token;
  return env;
}

export function renderLaunchdService(input: {
  label: string;
  spec: MultiremiDaemonLaunchSpec;
  env: Record<string, string>;
}): string {
  const argv = [input.spec.command, ...input.spec.args]
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join("\n");
  const envEntries = Object.entries(input.env)
    .map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`)
    .join("\n");
  const envBlock = envEntries
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n${envEntries}\n  </dict>\n`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
${argv}
  </array>
${envBlock}  <key>WorkingDirectory</key>
  <string>${escapeXml(input.spec.stateDir)}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(input.spec.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(input.spec.logPath)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>ExitTimeOut</key>
  <integer>${DAEMON_SERVICE_STOP_SECONDS}</integer>
  <key>AbandonProcessGroup</key>
  <false/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
}

export function renderSystemdService(input: {
  spec: MultiremiDaemonLaunchSpec;
  env: Record<string, string>;
}): string {
  const execStart = [input.spec.command, ...input.spec.args].map(systemdQuote).join(" ");
  const envLines = Object.entries(input.env)
    .map(([key, value]) => `Environment="${systemdEnvironmentEscape(key)}=${systemdEnvironmentEscape(value)}"`)
    .join("\n");
  return `[Unit]
Description=Multiremi daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
WorkingDirectory=${systemdQuote(input.spec.stateDir)}
${envLines}
Restart=always
RestartSec=10
TimeoutStopSec=${DAEMON_SERVICE_STOP_SECONDS}
KillMode=control-group
StandardOutput=append:${input.spec.logPath}
StandardError=append:${input.spec.logPath}

[Install]
WantedBy=default.target
`;
}

export function launchdEnableCommands(label: string, path: string): string[][] {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) return [["launchctl", "load", "-w", path]];
  return [
    ["launchctl", "bootstrap", `gui/${uid}`, path],
    ["launchctl", "enable", `gui/${uid}/${label}`],
  ];
}

export function launchdDisableCommands(label: string): string[][] {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) return [["launchctl", "unload", "-w", multiremiDaemonServicePath("launchd")]];
  return [["launchctl", "bootout", `gui/${uid}/${label}`]];
}

export function runServiceCommands(commands: string[][]): void {
  for (const [command, ...args] of commands) {
    execFileSync(command, args, { stdio: "inherit" });
  }
}

export function currentProcessLauncher(argv: string[], execPath: string, forRestart = false): { command: string; argsPrefix: string[] } {
  const executable = basename(execPath, extname(execPath)).toLowerCase();
  const script = argv[1];
  if ((executable === "bun" || executable.startsWith("bun-")) && script) {
    return { command: execPath, argsPrefix: [script] };
  }
  return { command: stableDaemonLauncher(execPath, forRestart) ?? execPath, argsPrefix: [] };
}

/** Only prefer a stable launcher when it execs this installed version. Never run it to probe. */
function stableDaemonLauncher(execPath: string, forRestart: boolean): string | null {
  const installRoot = process.env.MULTIREMI_INSTALL_ROOT?.trim() || join(homedir(), ".local", "lib", "remi");
  let executable: string;
  let versions: string;
  try {
    executable = realpathSync(execPath);
    versions = realpathSync(join(installRoot, "versions"));
  } catch {
    return null;
  }
  const versionPath = relative(versions, executable).split(sep);
  if (versionPath.length !== 2 || versionPath[0] === ".." || versionPath[1] !== "remi") return null;

  const binDir = process.env.MULTIREMI_BIN_DIR?.trim();
  // POSIX PATH empty entries mean cwd; an unset MULTIREMI_BIN_DIR does not.
  const directories = [...(binDir ? [binDir] : []), ...(process.env.PATH?.split(delimiter) ?? [])];
  for (const directory of directories) {
    const candidate = resolve(directory, "remi");
    if (candidate === resolve(execPath)) continue;
    try {
      accessSync(candidate, constants.X_OK);
      const stat = statSync(candidate);
      if (!stat.isFile() || stat.size > 64 * 1024) continue;
      const content = readFileSync(candidate, "utf8");
      if (!/^#!\s*\/(?:bin|usr\/bin)\/(?:sh|bash)(?:\r?\n)/.test(content)) continue;
      const matches = content.split("\n").some((line) => {
        const command = line.match(/^\s*exec\s+(.+)$/)?.[1];
        const target = command && literalShellCommand(command);
        // Relative exec paths depend on the service cwd, so only trust absolute targets.
        if (!target || !target.startsWith(sep)) return false;
        const resolved = realpathSync(target);
        if (resolved === executable) return true;
        const next = relative(versions, resolved).split(sep);
        return forRestart && next.length === 2 && next[0] !== ".." && next[1] === "remi";
      });
      if (matches) return candidate;
    } catch {
      // Missing, unreadable or non-executable PATH entries leave the binary unchanged.
    }
  }
  return null;
}

/** Decode one literal shell word without evaluating substitutions or running the script. */
function literalShellCommand(command: string): string | null {
  let value = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else value += char;
    } else if (char === "\\") {
      const next = command[++index];
      if (next === undefined || next === "\n") return null;
      if (quote === '"' && !'"\\$`'.includes(next)) value += "\\";
      value += next;
    } else if (char === quote) {
      quote = null;
    } else if (!quote && (char === "'" || char === '"')) {
      quote = char;
    } else if (char === "$" || char === "`") {
      return null;
    } else if (!quote && /\s/.test(char)) {
      return value || null;
    } else if (!quote && /[;&|<>()*?\[~]/.test(char)) {
      return null;
    } else {
      value += char;
    }
  }
  return quote ? null : value || null;
}

export function programSubcommandPrefix(programName: string): string[] {
  const parts = programName.trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts.slice(1) : [];
}

export function pushStringOption(args: string[], flag: string, value: unknown): void {
  const option = stringOpt(value, undefined);
  if (option) args.push(flag, option);
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function systemdQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value.replace(/%/g, "%%");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/%/g, "%%")}"`;
}

export function systemdEnvironmentEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/%/g, "%%");
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
