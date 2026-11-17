import { execFileSync } from "node:child_process";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export interface UpdateServiceRestart {
  command: string[];
  manager?: "systemd" | "launchd";
}

/** Read only: fail before release lookup, staging, or watchdog creation. */
export function assertUpdateServiceLauncher(input: {
  restart?: UpdateServiceRestart;
  launcherPath: string;
  run?: (command: string, args: string[]) => string;
}): void {
  const manager = input.restart?.manager;
  if (!manager) return;
  const run = input.run ?? ((command, args) => execFileSync(command, args, {
    encoding: "utf8", stdio: "pipe", timeout: 10_000, env: { ...process.env },
  }));
  let actual = "<unavailable>";
  try {
    let executable: string | undefined;
    if (manager === "systemd") {
      const unit = input.restart!.command.at(-1);
      if (!unit || !unit.endsWith(".service")) throw new Error("missing systemd unit");
      // `show` returns the manager's effective configuration, including all
      // drop-ins and ExecStart resets. Never infer it from the base unit file.
      const effective = run("systemctl", ["--user", "show", "-p", "ExecStart", "--value", "--", unit]).trim();
      const paths = [...effective.matchAll(/(?:^|[;{]\s*)path=((?:\\.|[^;])+)\s*;/g)];
      if (paths.length === 1) executable = decodeSystemdPath(paths[0]![1]!.trim());
      actual = paths.length ? paths.map(match => decodeSystemdPath(match[1]!.trim())).join(", ") : "<unparseable ExecStart>";
    } else {
      // plutil handles XML and binary plists, XML entities, and Program (which
      // overrides ProgramArguments[0]) without evaluating any shell content.
      const target = input.restart!.command.at(-1);
      if (!target?.startsWith("gui/")) throw new Error("missing launchd service target");
      const loaded = run("launchctl", ["print", target]).trim();
      const loadedPath = loaded.match(/^\s*path = (.+)$/m)?.[1]?.trim();
      const loadedProgram = loaded.match(/^\s*program = (.+)$/m)?.[1]?.trim();
      // launchctl/plist output can include secret environment values. Report
      // only entry paths, never the complete service dump or argv.
      actual = `loaded program=${loadedProgram ?? "<unavailable>"}; plist=${loadedPath ?? "<unavailable>"}`;
      if (!loadedPath || !isAbsolute(loadedPath)) throw new Error("loaded launchd plist path is unavailable");
      if (!loadedProgram || !isAbsolute(loadedProgram) || !sameLauncherSlot(loadedProgram, input.launcherPath)) {
        throw new Error("loaded launchd program does not resolve to the launcher being replaced");
      }
      const content = run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", loadedPath]).trim();
      let plist: { Program?: unknown; ProgramArguments?: unknown[] };
      try { plist = JSON.parse(content); } catch { throw new Error("unparseable launchd plist"); }
      const program = plist.Program ?? plist.ProgramArguments?.[0];
      if (typeof program === "string") executable = program;
      actual += `; plist executable=${executable ?? "<unavailable>"}`;
    }
    if (!executable || !isAbsolute(executable) || !sameLauncherSlot(executable, input.launcherPath)) {
      throw new Error("service executable does not resolve to the launcher being replaced");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`CLI update blocked: ${manager} actual ExecStart/ProgramArguments=${actual}; expected launcher=${input.launcherPath}. ${detail}. Repair with \`remi daemon service install\` and remove conflicting service overrides (see docs/daemon-runtime-upgrades.md); retry after the service uses this launcher.`);
  }
}

function decodeSystemdPath(value: string): string {
  return value.replace(/\\x([0-9a-fA-F]{2})|\\([\\"'])/g, (_, hex: string | undefined, escaped: string) =>
    hex ? String.fromCharCode(parseInt(hex, 16)) : escaped);
}

function sameLauncherSlot(executable: string, launcher: string): boolean {
  // Atomic rename replaces the launcher directory entry, not a symlink's
  // current target. Comparing realpath(launcher) would wrongly accept a unit
  // pointing directly at an old binary when launcher is a symlink to it.
  const slot = (path: string) => join(realpathSync(dirname(resolve(path))), basename(path));
  const expected = slot(launcher);
  const visited = new Set<string>();
  let current = slot(executable);
  // Stop at the entry that rename will replace, even when it is itself a
  // symlink. realpath(executable) would skip that entry in a longer chain.
  for (let links = 0; links < 40; links++) {
    if (current === expected) return true;
    if (visited.has(current) || !lstatSync(current).isSymbolicLink()) return false;
    visited.add(current);
    current = slot(resolve(dirname(current), readlinkSync(current)));
  }
  return false;
}
