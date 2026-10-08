// This file is embedded in the host updater. It runs with Bun (management/API)
// or Node (Web launcher) inside the existing base images, without a Docker socket.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, statfs, symlink } from 'node:fs/promises';
import { dirname, posix, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createGunzip } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.REMI_APPLICATION_ROOT || '/opt/remi-application';
export const DATA_SCHEMA_INPUTS = [
  'packages/server/src/store/migrations.ts', 'packages/server/src/store/daemon-routing.ts',
  'packages/server/src/store/db/postgres.ts', 'packages/server/src/store/db/pg-worker.ts',
  'packages/server/src/session-archive/retry-policy.ts', 'packages/contracts/src/attachments.ts',
  'packages/shared/src/db/index.ts',
];
// These image-owned programs cannot change during a code-only update. Changes
// to OS packages, external tools or the entrypoint require base maintenance.
export const API_BASE_INPUTS = ['deploy/docker/Dockerfile.api', 'deploy/docker/api-entrypoint.sh'];
const releasePath = id => {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id || '')) throw new Error('Invalid application release ID');
  return ROOT + '/releases/' + id;
};
const json = async path => JSON.parse(await readFile(path, 'utf8'));
async function atomic(path, value) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  const handle = await open(temporary, 'wx', 0o644);
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
async function fingerprint(root, inputs = DATA_SCHEMA_INPUTS) {
  const source = (await Promise.all(inputs.map(path => readFile(root + '/' + path, 'utf8')))).join('').replaceAll('\r\n', '\n');
  return createHash('sha256').update(source).digest('hex');
}
async function manifest(id) {
  const path = releasePath(id);
  const release = await json(path + '/complete.json');
  if (await fingerprint(path + '/api') !== release.dataSchema) throw new Error('Application migration fingerprint mismatch');
  if (release.application?.apiBase && await fingerprint(path + '/api', API_BASE_INPUTS) !== release.application.apiBase) throw new Error('Application base requirements mismatch');
  await lstat(path + '/web/frontend/apps/web/server.js');
  return release;
}

// Extract files first, links last. No archive entry can write through a link.
// This accepts GNU/PAX archives and workspace links, but rejects absolute paths,
// devices, traversal, escaping links, duplicate paths and unbounded expansion.
export async function extractArchive(archive, destination, compressed = true) {
  const source = createReadStream(archive);
  const stream = compressed ? source.pipe(createGunzip()) : source;
  const iterator = stream[Symbol.asyncIterator]();
  let buffer = Buffer.alloc(0), total = 0;
  async function take(size) {
    while (buffer.length < size) {
      const item = await iterator.next();
      if (item.done) throw new Error('Truncated application archive');
      total += item.value.length;
      if (total > 8 * 1024 ** 3) throw new Error('Application archive exceeds 8 GiB');
      buffer = Buffer.concat([buffer, item.value]);
    }
    const result = buffer.subarray(0, size);
    buffer = buffer.subarray(size);
    return result;
  }
  const field = bytes => bytes.toString('utf8').replace(/\0.*$/s, '');
  function safe(path) {
    if (!path || path.includes('\0') || path.includes('\\') || path.startsWith('/') || path.split('/').includes('..')) throw new Error('Unsafe archive path');
    return posix.normalize(path).replace(/^\.\//, '').replace(/\/$/, '');
  }
  const links = [], names = new Set();
  // Bound open files while overlapping fsync calls. Serial fsync for every
  // dependency file otherwise makes large bundles take many minutes on Docker
  // Desktop. All flushes must succeed before links or completion are published.
  const flushes = new Set();
  let flushError;
  const flush = handle => {
    const task = handle.sync().finally(() => handle.close())
      .catch(error => { flushError ??= error; }).finally(() => flushes.delete(task));
    flushes.add(task);
  };
  let extension = {};
  await mkdir(destination, { recursive: true });
  try {
    for (;;) {
      if (flushError) throw flushError;
      const header = await take(512);
      if (header.every(byte => byte === 0)) break;
      const expected = parseInt(field(header.subarray(148, 156)).trim(), 8);
      const checksum = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
      if (checksum !== expected) throw new Error('Invalid tar header checksum');
      const size = parseInt(field(header.subarray(124, 136)).trim() || '0', 8);
      if (!Number.isSafeInteger(size) || size < 0 || size > 2 * 1024 ** 3) throw new Error('Invalid tar entry size');
      const type = String.fromCharCode(header[156] || 48);
      if (['x', 'g', 'L', 'K'].includes(type)) {
        if (size > 1024 * 1024) throw new Error('Tar metadata is too large');
        const value = await take(size);
        if (type === 'L') extension.path = field(value);
        else if (type === 'K') extension.linkpath = field(value);
        else {
          let offset = 0;
          while (offset < value.length) {
            const space = value.indexOf(32, offset);
            const length = Number(value.subarray(offset, space).toString());
            if (space < offset || !Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > value.length) throw new Error('Invalid PAX record');
            const record = value.subarray(space + 1, offset + length - 1).toString();
            const equal = record.indexOf('=');
            const key = record.slice(0, equal);
            if (key.startsWith('GNU.sparse') || key === 'size') throw new Error('Unsupported PAX entry');
            if (['path', 'linkpath'].includes(key)) {
              if (type === 'g') throw new Error('Global archive paths are not supported');
              extension[key] = record.slice(equal + 1);
            }
            offset += length;
          }
        }
        if (size % 512) await take(512 - size % 512);
        continue;
      }
      const prefix = field(header.subarray(345, 500));
      const name = safe(extension.path || (prefix ? prefix + '/' : '') + field(header.subarray(0, 100)));
      const link = extension.linkpath || field(header.subarray(157, 257));
      extension = {};
      if (names.has(name) || names.size >= 250000) throw new Error('Duplicate or excessive archive entries');
      names.add(name);
      const path = destination + '/' + name;
      await mkdir(dirname(path), { recursive: true });
      if (type === '5') {
        if (size !== 0) throw new Error('Invalid directory size');
        await mkdir(path, { recursive: true });
      } else if (type === '0') {
        const executable = parseInt(field(header.subarray(100, 108)).trim() || '0', 8) & 0o111;
        const handle = await open(path, 'wx', executable ? 0o755 : 0o644);
        try {
          for (let left = size; left > 0;) {
            const length = Math.min(left, 64 * 1024);
            await handle.writeFile(await take(length));
            left -= length;
          }
        } catch (error) { await handle.close(); throw error; }
        flush(handle);
        if (flushes.size >= 16) await Promise.race(flushes);
      } else if (type === '2' || type === '1') {
        if (size !== 0 || !link || link.startsWith('/') || link.includes('\\') || link.includes('\0')) throw new Error('Invalid archive link');
        const target = posix.normalize(type === '2' ? posix.join(posix.dirname(name), link) : link);
        if (target === '..' || target.startsWith('../')) throw new Error('Archive link escapes the release');
        links.push({ path, target, link, type });
      } else throw new Error('Unsupported archive entry type');
      if (size % 512) await take(512 - size % 512);
    }
    await Promise.all(flushes);
    if (flushError) throw flushError;
    // Hardlinks are materialized before symlinks; their targets must be files.
    for (const item of links.filter(item => item.type === '1')) {
      const target = destination + '/' + item.target;
      if (!(await lstat(target)).isFile()) throw new Error('Invalid hardlink target');
      await cp(target, item.path, { errorOnExist: true, force: false });
      const handle = await open(item.path, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
    }
    for (const item of links.filter(item => item.type === '2')) await symlink(item.link, item.path);
    const root = await realpath(destination);
    for (const item of links) {
      const target = await realpath(item.path);
      if (target !== root && !target.startsWith(root + '/')) throw new Error('Resolved archive link escapes the release');
    }
    // Files and links must survive a host power loss before complete.json can
    // make the release selectable. Directory fsync is unavailable on Windows.
    async function syncDirectories(path) {
      for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await syncDirectories(path + '/' + entry.name);
      const handle = await open(path, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
    }
    if (process.platform !== 'win32') await syncDirectories(destination);
  } finally { source.destroy(); stream.destroy(); await Promise.all(flushes); }
}

async function launch(role) {
  if (!['api', 'web'].includes(role)) throw new Error('Unknown application role');
  const selected = await json(ROOT + '/current.json');
  const root = releasePath(selected.id) + '/' + role;
  const executable = role === 'api' ? 'bun' : 'node';
  const args = role === 'api' ? ['run', '--preload', '/remi-application-bootstrap/host-write-fence.ts', 'apps/server/main.ts', 'serve'] : ['frontend/apps/web/server.js'];
  if (role === 'web') await mkdir('/tmp/remi-next-cache', { recursive: true });
  const child = spawn(executable, args, {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, MULTIREMI_VERSION: selected.release.version, REMI_APPLICATION_VERSION: selected.release.version },
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  child.on('error', () => process.exit(1));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
}

async function main() {
  const [command, id, ...args] = process.argv.slice(2);
  if (command === 'launch') { await launch(id); return; }
  if (command === 'verify-running') {
    const [role] = args;
    const expected = releasePath(id) + (role === 'web' ? '/web/frontend/apps/web' : '/api');
    for (const pid of await readdir('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        if (await readlink('/proc/' + pid + '/cwd') !== expected) continue;
        const argv = await readFile('/proc/' + pid + '/cmdline', 'utf8');
        if (argv.includes(role === 'web' ? 'server.js' : 'apps/server/main.ts')) return;
      } catch {} // A process may exit during inspection.
    }
    throw new Error('Service is not running the selected application release');
  }
  await mkdir(ROOT + '/releases', { recursive: true });
  if (command === 'inspect') {
    const disk = await statfs(ROOT);
    let current = null;
    try { current = await json(ROOT + '/current.json'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    console.log(JSON.stringify({ arch: process.arch, bun: process.versions.bun, freeBytes: Number(disk.bavail) * Number(disk.bsize), current }));
  } else if (command === 'seed') {
    const [role] = args;
    if (!['api', 'web'].includes(role)) throw new Error('Invalid seed role');
    const path = releasePath(id);
    const target = path + '/' + role;
    try { await lstat(path + '/seed-' + role + '.json'); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Only the incomplete, validated release child is removed on retry.
    await rm(target, { recursive: true, force: true });
    await mkdir(path, { recursive: true });
    await cp('/app', target, { recursive: true, verbatimSymlinks: true });
    if (role === 'web') {
      const cache = target + '/frontend/apps/web/.next/cache';
      await rm(cache, { recursive: true, force: true });
      await mkdir(dirname(cache), { recursive: true });
      await symlink('/tmp/remi-next-cache', cache);
    }
    await atomic(path + '/seed-' + role + '.json', { copied: true });
  } else if (command === 'finish-seed') {
    const release = JSON.parse(await readFile('/remi-input/manifest.json', 'utf8'));
    if (await fingerprint(releasePath(id) + '/api') !== release.dataSchema) throw new Error('Seed schema does not match the running release');
    await lstat(releasePath(id) + '/seed-api.json'); await lstat(releasePath(id) + '/seed-web.json');
    await atomic(releasePath(id) + '/complete.json', release);
    await manifest(id);
  } else if (command === 'stage') {
    const [expectedHash, version, ref, schema] = args;
    const archive = '/remi-input/archive.tar.gz';
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    if (hash.digest('hex') !== expectedHash) throw new Error('Application archive checksum mismatch');
    const path = releasePath(id);
    try {
      const existing = await json(path + '/complete.json');
      if (existing.applicationSha256 !== expectedHash) throw new Error('Release ID collision');
      await manifest(id); return;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const staging = releasePath('stage-' + randomUUID());
    try {
      await extractArchive(archive, staging);
      const release = await json(staging + '/application.json');
      if (release.version !== version || release.ref !== ref || release.dataSchema !== schema || release.arch !== process.arch) throw new Error('Application archive identity mismatch');
      if (await fingerprint(staging + '/api') !== schema) throw new Error('Application archive migration mismatch');
      if (await fingerprint(staging + '/api', API_BASE_INPUTS) !== release.application?.apiBase) throw new Error('Application archive base requirements mismatch');
      await lstat(staging + '/api/apps/server/main.ts'); await lstat(staging + '/web/frontend/apps/web/server.js');
      // Next's disposable image cache is writable without making code writable.
      const cache = staging + '/web/frontend/apps/web/.next/cache';
      await rm(cache, { recursive: true, force: true });
      await mkdir(dirname(cache), { recursive: true });
      await symlink('/tmp/remi-next-cache', cache);
      await atomic(staging + '/complete.json', { ...release, applicationSha256: expectedHash });
      await rename(staging, path);
    } finally { await rm(staging, { recursive: true, force: true }); }
  } else if (command === 'select') {
    await atomic(ROOT + '/current.json', { id, release: await manifest(id) });
  } else if (command === 'verify') {
    console.log(JSON.stringify(await manifest(id)));
  } else if (command === 'migrate') {
    const url = new URL(process.env.MULTIREMI_DATABASE_URL || '');
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/remi_update_rehearsal' || url.username !== 'remi_rehearsal') throw new Error('Migrations may only run against the isolated rehearsal database');
    const child = spawn('bun', ['--eval',
      "const {openMultiremiDatabase}=await import('./packages/server/src/store/db/postgres.ts');const {runMigrations}=await import('./packages/server/src/store/migrations.ts');const db=openMultiremiDatabase();try{await runMigrations(db)}finally{await db.close()}"],
    { cwd: releasePath(id) + '/api', stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, HOME: '/tmp', MULTIREMI_HOME: '/tmp/remi' } });
    child.stderr.resume();
    // A hung candidate migration must not strand API/Web offline indefinitely.
    // Only this disposable rehearsal process is killed; no provider runs here.
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5 * 60_000);
    try {
      await new Promise((ok, fail) => { child.on('error', fail); child.on('exit', code => code === 0 ? ok() : fail(new Error('Migration rehearsal failed or timed out'))); });
    } finally { clearTimeout(timeout); }
  } else throw new Error('Unknown application control command');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
