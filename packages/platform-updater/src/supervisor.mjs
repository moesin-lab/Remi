// Stable image-owned supervisor. Updates replace only the application child,
// including its bundled Bun/Node executable; no Docker control socket is used.
import { spawn, execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rename, rm, open, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA_SCHEMA_INPUTS, API_BASE_INPUTS } from './container-runtime.mjs';

export async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = path + '.' + randomUUID() + '.tmp';
  const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); }
  finally { await file.close(); }
  await rename(temp, path);
  await syncDirectory(dirname(path));
}
export async function syncDirectory(path) {
  // The supervisor runs on Linux. Windows unit tests cannot fsync directories.
  if (process.platform === 'win32') return;
  const parent = await open(path, 'r');
  try { await parent.sync(); } finally { await parent.close(); }
}
export async function schemaFingerprint(root) {
  return digest((await Promise.all(DATA_SCHEMA_INPUTS.map(path => readFile(join(root, path), 'utf8')))).join(''));
}
export async function syncTree(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await syncTree(path);
    else if (entry.isFile()) {
      const file = await open(path, 'r');
      try { await file.sync(); } finally { await file.close(); }
    }
  }
  await syncDirectory(root);
}
export async function baseFingerprints(root) {
  const source = (await Promise.all(API_BASE_INPUTS.map(path => readFile(join(root, path), 'utf8')))).join('');
  // Bun itself is carried in each release. OS tools and the bootstrap remain
  // image-owned, and changes to them still need an explicit base maintenance.
  return { apiBase: digest(source), nativeTools: digest(source.replace(/oven\/bun:\d+\.\d+\.\d+/g, 'oven/bun:BUNDLED')) };
}
function digest(value) { return createHash('sha256').update(value.replaceAll('\r\n', '\n')).digest('hex'); }
export function releaseDirectory(root, id) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id || '')) throw new Error('Invalid release directory');
  return join(root, 'releases', id);
}
export async function supervise() {
  const role = process.env.REMI_SUPERVISOR_ROLE;
  if (!['api', 'web', 'api-runtime'].includes(role)) throw new Error('Invalid supervisor role');
  const api = role !== 'web';
  const root = process.env.REMI_APPLICATION_ROOT || '/remi-program';
  const control = process.env.REMI_SUPERVISOR_CONTROL || '/remi-control';
  const source = process.env.REMI_SUPERVISOR_SOURCE || '/app';
  const seed = process.env.REMI_SUPERVISOR_SEED || '/remi-seed';
  const directory = join(control, role);
  const base = {
    protocol: 1, role, arch: process.arch,
    version: (process.env.REMI_APPLICATION_BASE_VERSION || '').replace(/^v/, ''),
    ref: process.env.REMI_APPLICATION_BASE_REF || '',
    libc: execFileSync('getconf', ['GNU_LIBC_VERSION'], { encoding: 'utf8' }).trim(),
    runtime: api ? process.versions.bun : process.versions.node,
    ...(api ? { dataSchema: await schemaFingerprint(source), ...await baseFingerprints(source) } : {}),
  };
  await mkdir(directory, { recursive: true });
  let child = null, exit = null, current = null, revision = null, lastProbe = null, closing = false, spawnFailed = false;
  let runningVersion = base.version;
  let lastStart = 0, seedReady = false, lastStatus = 0;
  const baseExecutable = process.execPath;
  const seedTask = (async () => {
    const prior = await readJson(join(seed, 'complete.json'));
    if (prior) {
      if (JSON.stringify(prior) !== JSON.stringify(base)) throw new Error('Seed volume belongs to a different base image');
    } else {
      await mkdir(seed, { recursive: true });
      const staging = join(seed, 'incomplete');
      await rm(staging, { recursive: true, force: true });
      await cp(source, staging, { recursive: true, verbatimSymlinks: true });
      await rm(join(seed, 'source'), { recursive: true, force: true });
      await rename(staging, join(seed, 'source'));
      await cp(baseExecutable, join(seed, api ? 'bun' : 'node'));
      await syncTree(seed);
      await writeJson(join(seed, 'complete.json'), base);
    }
    seedReady = true;
  })();
  let seedError = null;
  seedTask.catch(error => { seedError = error.message; });
  async function stop() {
    if (!child) return;
    const processToStop = child;
    if (!processToStop.pid) { child = null; current = null; return; }
    try { process.kill(-processToStop.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    const timer = setTimeout(() => { try { process.kill(-processToStop.pid, 'SIGKILL'); } catch {} }, 30_000);
    try { await exit; } finally { clearTimeout(timer); }
    // The supervised application's own helpers must not outlive their process
    // group. Agents are separate containers/processes and never enter it.
    try { process.kill(-processToStop.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    child = null; current = null;
  }
  function location(id) {
    const path = id ? releaseDirectory(root, id) : null;
    return { cwd: path ? join(path, api ? 'api' : 'web') : source,
      executable: path ? join(path, 'runtime', api ? 'bun' : 'node') : baseExecutable };
  }
  async function start(id) {
    const { cwd, executable } = location(id);
    const selected = id ? await readJson(join(releaseDirectory(root, id), 'complete.json')) : base;
    if (!selected) throw new Error('Release is incomplete');
    const preload = process.env.REMI_SUPERVISOR_FENCE || '/usr/local/lib/remi/host-write-fence.ts';
    const args = api ? ['run', '--preload', preload, 'apps/server/main.ts', 'serve'] : ['frontend/apps/web/server.js'];
    child = spawn(executable, args, { cwd, detached: true, stdio: 'inherit', env: { ...process.env,
      MULTIREMI_VERSION: selected.version, REMI_APPLICATION_VERSION: selected.version,
      MULTIREMI_HOST_WRITE_FENCE_FILE: join(control, 'write-fence.json'),
      PATH: dirname(executable) + ':' + process.env.PATH,
    } });
    spawnFailed = false;
    exit = new Promise(ok => { child.once('exit', ok); child.once('error', error => { spawnFailed = true; console.error(error.message); ok(); }); });
    current = id; runningVersion = selected.version; lastStart = Date.now();
  }
  const shutdown = () => { closing = true; };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  try {
    while (!closing) {
      const desired = await readJson(join(directory, 'desired.json'));
      if (desired && (!['run', 'stop'].includes(desired.mode) || typeof desired.revision !== 'string')) throw new Error('Invalid supervisor command');
      const id = desired?.releaseId ?? null;
      if (id) releaseDirectory(root, id);
      const dead = child && (spawnFailed || child.exitCode !== null || child.signalCode !== null);
      if (dead) await stop();
      if (desired?.mode === 'stop') await stop();
      else if (child && (current !== id || revision !== (desired?.revision ?? null))) { await stop(); await start(id); }
      else if (!child && Date.now() - lastStart >= 2000) await start(id);
      revision = desired?.revision ?? null;
      const probe = await readJson(join(directory, 'probe.json'));
      if (probe && probe.id !== lastProbe?.id) {
        try {
          const candidate = await readJson(join(releaseDirectory(root, probe.releaseId), 'complete.json'));
          if (!candidate) throw new Error('Candidate is incomplete');
          const version = execFileSync(location(probe.releaseId).executable, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim().replace(/^v/, '');
          const expected = api ? candidate.application.bun : candidate.application.node;
          if (version !== expected) throw new Error('Bundled runtime version mismatch');
          lastProbe = { id: probe.id, ok: true };
        } catch (error) { lastProbe = { id: probe.id, ok: false, error: error.message }; }
      }
      if (Date.now() - lastStatus >= 500) {
        await writeJson(join(directory, 'status.json'), { ...base, version: runningVersion, supervisorPid: process.pid, childPid: child?.pid ?? null,
          releaseId: current, revision, stopped: !child, seedReady, seedError, probe: lastProbe, heartbeatAt: Date.now() });
        lastStatus = Date.now();
      }
      await new Promise(ok => setTimeout(ok, 100));
    }
  } finally { await stop(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  supervise().catch(error => { console.error(error.message); process.exit(1); });
}
