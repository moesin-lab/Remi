/** Linux host observation only. Never imports product code or writes protected paths. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

export const FORBIDDEN_PORTS = [6131, 6132, 6133, 6134];
export const SESSION_ENV = ['INVOCATION_ID', 'JOURNAL_STREAM', 'SYSTEMD_EXEC_PID', 'NOTIFY_SOCKET', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'];
export function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || FORBIDDEN_PORTS.includes(port)) throw new Error(`Unsafe harness port: ${port}`);
}
export function isolatedEnv(root: string): Record<string, string> {
  // Allowlist, rather than cloning the task's tokens, provider credentials or systemd context.
  return { BUN_BE_BUN: '1', PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: join(root, 'home'),
    TMPDIR: join(root, 'tmp'), NODE_ENV: 'test', REMI_HOME: join(root, 'home/.remi'),
    MULTIREMI_STATE_DIR: join(root, 'state'), MULTIREMI_TEST_RUN_ROOT: join(root, 'locks'),
    MULTIREMI_WORKSPACES_ROOT: join(root, 'workspaces'), MULTIREMI_DAEMON_PORT: '19131',
    MULTIREMI_BACKGROUND_JOBS: 'false', MULTIREMI_SSH_MESH_ENABLED: 'false' };
}
export function processIdentity(pid: number) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return { pid, starttime: fields[19]!, ppid: Number(fields[1]) };
}
function missing(error: unknown) { return ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? ''); }
function identity(path: string) {
  try { const s = statSync(path); return { path, dev: String(s.dev), ino: String(s.ino) }; }
  catch (error) { if (missing(error)) return { path, absent: true }; throw error; }
}
export function fingerprint(path: string): Record<string, unknown> {
  try {
    const s = lstatSync(path);
    return { path, dev: String(s.dev), ino: String(s.ino), mode: s.mode,
      sha256: createHash('sha256').update(s.isSymbolicLink() ? readlinkSync(path) : readFileSync(path)).digest('hex') };
  } catch (error) { if (missing(error)) return { path, absent: true }; throw error; }
}
function owners(root: string) {
  if (!existsSync(root)) return [];
  return readdirSync(root).sort().flatMap(name => {
    const path = join(root, name, 'owner.lock/owner.json');
    if (!existsSync(path)) return [];
    const owner = JSON.parse(readFileSync(path, 'utf8'));
    return [{ ...fingerprint(path), pid: owner.pid, process_start_id: owner.process_start_id, released: owner.released }];
  });
}
export function snapshotProduction() {
  if (process.platform !== 'linux') throw new Error('Isolation observation requires Linux /proc');
  const home = homedir(), accountHome = userInfo().homedir;
  const statePaths = [...new Set([process.env.MULTIREMI_STATE_DIR, join(home, '.multiremi'), join(accountHome, '.multiremi'), process.env.REMI_HOME, join(home, '.remi')].filter((s): s is string => Boolean(s)))].map(resolvePath => resolve(resolvePath));
  const protectedFiles = [...new Set([join(home, '.remi/config.toml'), join(home, '.remi/config.json'), join(home, '.config/systemd/user/multiremi-daemon.service'), ...statePaths.flatMap(path => [join(path, 'config.json'), join(path, 'daemon.json')])])];
  const leaseRoots = [...new Set([home, accountHome])].map(path => join(path, '.multiremi/workspace-supervisors'));
  const sockets: Array<{ port: number; inode: string }> = [];
  for (const path of ['/proc/net/tcp', '/proc/net/tcp6']) {
    for (const line of readFileSync(path, 'utf8').trim().split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/), port = parseInt(fields[1]!.split(':')[1]!, 16);
      if (fields[3] === '0A' && FORBIDDEN_PORTS.includes(port)) sockets.push({ port, inode: fields[9]! });
    }
  }
  const observationErrors: string[] = [];
  const portOwners: Array<{ port: number; inode: string; pid: number; starttime: string }> = [];
  const daemons: ReturnType<typeof processIdentity>[] = [];
  for (const entry of readdirSync('/proc').filter(s => /^\d+$/.test(s)).sort((a, b) => Number(a) - Number(b))) {
    try {
      const pid = Number(entry);
      if (statSync(`/proc/${pid}`).uid !== process.getuid!()) continue;
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (cmd.some(part => /(?:^|\/)remi(?:$|\.ts$)|multiremi/.test(part)) && cmd.includes('daemon')) daemons.push(processIdentity(pid));
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        let target: string;
        try { target = readlinkSync(`/proc/${pid}/fd/${fd}`); } catch (error) { if (missing(error)) continue; if ((error as NodeJS.ErrnoException).code === 'EACCES') { observationErrors.push(`Cannot inspect fd of pid ${pid}`); break; } throw error; }
        const socket = sockets.find(s => target === `socket:[${s.inode}]`);
        if (socket) portOwners.push({ ...socket, ...processIdentity(pid) });
      }
    } catch (error) {
      if (missing(error)) continue;
      // Same-user daemons must be observable; do not claim success on permission errors.
      if ((error as NodeJS.ErrnoException).code === 'EACCES') { observationErrors.push(`Cannot inspect pid ${entry}`); continue; }
      throw error;
    }
  }
  for (const socket of sockets) if (!portOwners.some(owner => owner.inode === socket.inode)) observationErrors.push(`Cannot identify listener on protected port ${socket.port} (inode ${socket.inode})`);
  const leases = leaseRoots.flatMap(owners);
  for (const owner of leases) {
    if (!owner.released && typeof owner.pid === 'number') {
      try { const p = processIdentity(owner.pid); if (!daemons.some(d => d.pid === p.pid)) daemons.push(p); }
      catch (error) { if (!missing(error)) throw error; }
    }
  }
  return { production_instance: daemons.length || sockets.length ? 'present' : 'absent',
    observation_errors: observationErrors.sort(), listeners: sockets.sort((a,b) => a.port - b.port),
    daemons: daemons.sort((a, b) => a.pid - b.pid), ports: portOwners.sort((a, b) => a.port - b.port || a.pid - b.pid),
    state_directories: statePaths.map(identity), static_configuration: protectedFiles.map(fingerprint), leases };
}
export function compareSnapshots(before: ReturnType<typeof snapshotProduction>, after: ReturnType<typeof snapshotProduction>) {
  const changed = Object.keys(before).filter(key => key !== 'observation_errors').filter(key => JSON.stringify(before[key as keyof typeof before]) !== JSON.stringify(after[key as keyof typeof after]));
  return { unchanged: changed.length === 0, fully_observed: before.observation_errors.length === 0 && after.observation_errors.length === 0, changed };
}
