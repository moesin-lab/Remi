/** Durable handoff between the installer, the next daemon and an independent POSIX watchdog. */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UpdateResult } from "./cli-update.js";

export const DAEMON_STOP_TIMEOUT_MS = 30_000;
export const DAEMON_SERVICE_STOP_SECONDS = 45;
export const DAEMON_UPDATE_VERIFY_SECONDS = 120;
export interface DaemonUpdateJournal {
  runtimeId: string;
  requestId: string;
  targetVersion: string;
  targetCommit?: string;
  previousVersion: string;
  launcherPath: string;
  snapshotDir: string;
}
export function updateJournalDir(stateDir: string, runtimeId: string, requestId?: string): string {
  const root = join(stateDir, "cli-updates");
  const prefix = `${encodeURIComponent(runtimeId).replaceAll(".", "%2E")}.`;
  if (requestId) return join(root, `${prefix}${encodeURIComponent(requestId).replaceAll(".", "%2E")}`);
  const active = existsSync(root) ? readdirSync(root).find(name => name.startsWith(prefix) && !name.endsWith(".settled")) : null;
  return join(root, active ?? `${prefix}none`);
}
export function readUpdateJournal(directory: string): DaemonUpdateJournal | null {
  try { return JSON.parse(readFileSync(join(directory, "journal.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export function updateDecision(directory: string): string | null {
  try { return readlinkSync(join(directory, "decision")); } catch { return null; }
}
export function decideUpdate(directory: string, decision: "completed" | "rolled_back"): boolean {
  try { symlinkSync(decision, join(directory, "decision")); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return updateDecision(directory) === decision; throw error; }
}
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

/** No dependency on the candidate binary: a release that exits at startup is recoverable. */
export function renderUpdateWatchdog(input: {
  directory: string; journal: DaemonUpdateJournal; restart: string[]; timeoutSeconds?: number;
  fallback?: boolean;
}): string {
  const q = quote;
  const dir = q(input.directory);
  const launcher = q(input.journal.launcherPath);
  const previous = q(join(input.journal.snapshotDir, "previous-launcher"));
  const wrapper = q(join(input.journal.launcherPath, "..", "remi-claude-agent-acp"));
  const oldWrapper = q(join(input.journal.snapshotDir, "previous-wrapper"));
  return `#!/bin/sh
set -eu
sleep ${input.timeoutSeconds ?? DAEMON_UPDATE_VERIFY_SECONDS}
# symlink creation arbitrates against the new daemon's hello + self-check commit.
if ! ln -s rolled_back ${dir}/decision 2>/dev/null; then exit 0; fi
printf '%s\\n' 'target did not register and pass startup self-check before the verification deadline' > ${dir}/reason
cp ${previous} ${launcher}.rollback.tmp
chmod 755 ${launcher}.rollback.tmp
mv -f ${launcher}.rollback.tmp ${launcher}
if [ -f ${oldWrapper} ]; then
  cp ${oldWrapper} ${wrapper}.rollback.tmp
  chmod 755 ${wrapper}.rollback.tmp
  mv -f ${wrapper}.rollback.tmp ${wrapper}
fi
${input.fallback ? `if [ -f ${dir}/candidate.pid ]; then
  candidate=$(cat ${dir}/candidate.pid)
  case "$candidate" in ''|*[!0-9]*) exit 1;; esac
  kill -TERM "$candidate" 2>/dev/null || true
  count=0
  while kill -0 "$candidate" 2>/dev/null && [ "$count" -lt ${DAEMON_SERVICE_STOP_SECONDS} ]; do sleep 1; count=$((count+1)); done
  if kill -0 "$candidate" 2>/dev/null; then kill -KILL "$candidate" 2>/dev/null || true; fi
fi` : ""}
exec ${input.restart.map(q).join(" ")}
`;
}

export function armUpdateWatchdog(input: {
  directory: string; journal: DaemonUpdateJournal; restart: string[];
  manager?: "systemd" | "launchd"; timeoutSeconds?: number;
}): void {
  mkdirSync(input.directory, { recursive: true, mode: 0o700 });
  // Keep prior handoffs as evidence; never reuse their atomic decision.
  if (existsSync(join(input.directory, "journal.json"))) throw new Error("An update handoff already exists");
  const tmp = join(input.directory, "journal.tmp");
  writeFileSync(tmp, JSON.stringify(input.journal), { mode: 0o600 });
  renameSync(tmp, join(input.directory, "journal.json"));
  const script = join(input.directory, "watchdog.sh");
  writeFileSync(script, renderUpdateWatchdog({ ...input, fallback: !input.manager }), { mode: 0o700 });
  if (input.manager) {
    // Transient jobs live outside the daemon unit/job, whose teardown kills its children.
    const command = input.manager === "systemd" ? "systemd-run" : "launchctl";
    const args = input.manager === "systemd"
      ? ["--user", "--collect", `--unit=remi-update-${process.pid}-${Date.now()}`, "/bin/sh", script]
      : ["submit", "-l", `dev.remi.update.${process.pid}.${Date.now()}`, "--", "/bin/sh", script];
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000 });
    if (result.status !== 0) {
      rmSync(input.directory, { recursive: true, force: true });
      throw new Error(`Cannot arm independent watchdog: ${result.stderr || result.error?.message || result.status}`);
    }
  } else {
    const logFd = openSync(join(input.directory, "watchdog.log"), "a", 0o600);
    try {
      const child = spawn("/bin/sh", [script], { detached: true, stdio: ["ignore", logFd, logFd] });
      child.unref();
    } finally { closeSync(logFd); }
  }
}

/** Recover locally when activation/restart setup fails while the predecessor still runs. */
export function restorePreviousLauncher(journal: DaemonUpdateJournal): void {
  const replace = (source: string, destination: string) => {
    const temporary = `${destination}.${process.pid}.rollback.tmp`;
    writeFileSync(temporary, readFileSync(source), { mode: 0o755 });
    renameSync(temporary, destination);
  };
  replace(join(journal.snapshotDir, "previous-launcher"), journal.launcherPath);
  const wrapper = join(journal.snapshotDir, "previous-wrapper");
  if (existsSync(wrapper)) replace(wrapper, join(journal.launcherPath, "..", "remi-claude-agent-acp"));
}

export function journalForInstall(result: Extract<UpdateResult, { status: "installed" }>,
  runtimeId: string, requestId: string, previousVersion: string): DaemonUpdateJournal {
  if (!existsSync(join(result.snapshotDir, "previous-launcher"))) throw new Error("No previous launcher available for automatic rollback");
  return { runtimeId, requestId, targetVersion: result.version, targetCommit: result.commit, previousVersion,
    launcherPath: result.launcherPath, snapshotDir: result.snapshotDir };
}

/** Bind before provider preparation or registration can hang. Only the candidate version owns this pid. */
export function bindUpdateCandidate(stateDir: string, version: string, pid = process.pid, commit?: string | null): void {
  const root = join(stateDir, "cli-updates");
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.endsWith(".settled")) continue;
    const directory = join(root, entry.name);
    const journal = readUpdateJournal(directory);
    if (!matchesUpdateIdentity(journal, version, commit)) continue;
    writeFileSync(join(directory, "candidate.pid"), String(pid), { mode: 0o600 });
  }
}

/** A version alone cannot attest a build when the platform pins a commit. */
export function matchesUpdateIdentity(journal: DaemonUpdateJournal | null, version: string, commit?: string | null): boolean {
  return !!journal && journal.targetVersion === version.replace(/^v/, "")
    && (!journal.targetCommit || journal.targetCommit === commit);
}
