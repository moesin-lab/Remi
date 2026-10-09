#!/usr/bin/env bun
/** Isolated Next -> real API/store -> real update worker. Release transport and
 * deployment inspection are fixtures; this harness never updates a deployment. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import { MultiremiStore } from '@multiremi/store.js';
import { startMultiremiServer } from '@multiremi/api.js';
import { PlatformUpdaterClient } from '@remi-platform/updater/client.js';
import { PlatformUpdateWorker } from '@remi-platform/updater/worker.js';
import { parseApplicationManifest } from '@remi-platform/updater/application-manifest.js';
import type { PlatformDeploymentDriver } from '@remi-platform/updater/types.js';
import type { MultiremiPlatformUpdateMode } from '@multiremi/contracts';

const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('bun run tests/integration/smoke-platform-settings.ts [--port=3349]'); process.exit(0); }
for (const arg of args) assert.match(arg, /^--port=\d+$/);
const port = Number(args.find(arg => arg.startsWith('--port='))?.slice(7) ?? 3349);
assert(Number.isInteger(port) && port > 0 && port < 65536);
const repo = resolve(import.meta.dir, '../..');
const root = mkdtempSync(join(tmpdir(), 'remi-platform-settings-'));
const artifacts = process.env.PLATFORM_SETTINGS_ARTIFACTS ? resolve(process.env.PLATFORM_SETTINGS_ARTIFACTS) : mkdtempSync(join(tmpdir(), 'remi-platform-ui-'));
mkdirSync(artifacts, { recursive: true });
for (const key of Object.keys(process.env)) if (/^(MULTIREMI_|REMI_|FEISHU_)/.test(key)) delete process.env[key];
process.env.NODE_ENV = 'test';
process.env.MULTIREMI_STATE_DIR = join(root, 'state');
process.env.MULTIREMI_UPLOAD_DIR = join(root, 'uploads');
process.env.MULTIREMI_SESSION_ARCHIVE_ROOT = join(root, 'session-archives');
const apiToken = randomUUID(), updaterToken = randomUUID();
const redact = (value: string) => [apiToken, updaterToken].reduce((result, token) => result.split(token).join('[redacted]'), value);
const frontend = `http://127.0.0.1:${port}`;
let next: ChildProcess | null = null, browser: ChildProcess | null = null;
let api: ReturnType<typeof startMultiremiServer> | null = null, control: ReturnType<typeof Bun.serve> | null = null;
let db: ReturnType<typeof openSqliteDatabase> | null = null;
let timer: ReturnType<typeof setInterval> | null = null, logs = '', failure: unknown = null;
const nativeFetch = globalThis.fetch;
try {
  db = openSqliteDatabase(join(root, 'platform.sqlite'));
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  api = startMultiremiServer({ store, authToken: apiToken, platformUpdaterToken: updaterToken,
    hostname: '127.0.0.1', port: 0, backgroundJobs: false, scheduler: null, scmPolling: null, messaging: null, controlPlaneSshMesh: null });
  const backend = `http://127.0.0.1:${api.port}`;
  const defaultFeed = 'https://releases.platform.test/complete.json';
  const current = { version: '1.0.0', ref: 'a'.repeat(40), dataSchema: 'b'.repeat(64), publishedAt: null, releaseUrl: null, manifestUrl: null, apiImage: null, webImage: null };
  const complete = { ...current, version: '1.0.1', ref: 'c'.repeat(40),
    apiImage: `ghcr.io/test/api@sha256:${'a'.repeat(64)}`, webImage: `ghcr.io/test/web@sha256:${'b'.repeat(64)}`,
    sourceUrl: 'https://releases.platform.test/source.tar.gz', sourceSha256: 'c'.repeat(64),
    application: { format: 1, supervisor: 1, bun: '1.3.14', node: '22.23.3', nodeMajor: 22,
      nativeTools: 'a'.repeat(64), apiBase: 'b'.repeat(64), apiLibc: 'glibc 2.36', webLibc: 'glibc 2.36', rollbackSafeFrom: [],
      assets: { 'linux-x64': { url: 'https://releases.platform.test/app.tar.gz', sha256: 'c'.repeat(64) } } } };
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== 'releases.platform.test') return nativeFetch(input, init);
    if (url.pathname === '/offline.json') throw new Error('Fixture source unavailable');
    if (url.pathname === '/images.json') { const { application, ...images } = complete; return Response.json(images); }
    assert.equal(url.href, defaultFeed);
    return Response.json(complete);
  }) as typeof fetch;
  let mode: MultiremiPlatformUpdateMode | undefined = 'images', paused = false;
  const driver: PlatformDeploymentDriver = {
    kind: 'docker_compose', get updateMode() { return mode; },
    async inspect() { return { driver: this.kind, updateMode: mode, currentRelease: current, recentReleases: [current], services: [] }; },
    async preflight() { return { ready: true, checkedAt: new Date().toISOString(), platform: 'linux', arch: 'x64',
      checks: (mode === 'internal_application' ? ['container_supervisors', 'isolated_rehearsal', 'backup', 'postgresql', 'program_storage'] : ['compose', 'backup'])
        .map(code => ({ code, ok: true, message: `${code} ready` })),
    }; },
    async validateRelease(manifest) { if (mode === 'internal_application' || mode === 'host_application') parseApplicationManifest(manifest); },
    async execute(operation) { assert.equal(operation.kind, 'check_updates', 'Fixture must never change services'); return current; },
  };
  const client = new PlatformUpdaterClient(backend, apiToken, updaterToken);
  let worker = new PlatformUpdateWorker(client, driver, defaultFeed), pending: Promise<void> | null = null;
  const tick = async () => {
    if (paused) return;
    if (!pending) pending = worker.tick().finally(() => { pending = null; });
    await pending;
  };
  await tick();
  timer = setInterval(() => void tick().catch(error => { logs += redact(String(error)) + '\n'; }), 500);
  control = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.method !== 'POST' || request.headers.get('Authorization') !== `Bearer ${updaterToken}`) return new Response(null, { status: 401 });
    const input = await request.json() as { mode?: MultiremiPlatformUpdateMode | null; offline?: boolean };
    if (pending) await pending;
    paused = input.offline === true;
    if (paused) db!.run("UPDATE multiremi_platform_state SET updater_heartbeat_at = ? WHERE id = 'platform'", [new Date(0).toISOString()]);
    else { mode = input.mode ?? undefined; worker = new PlatformUpdateWorker(client, driver, defaultFeed); await tick(); }
    return Response.json({ ok: true });
  } });
  next = spawn('node', [require.resolve('next/dist/bin/next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: join(repo, 'frontend/apps/web'), env: { ...process.env, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', REMOTE_API_URL: backend,
      NEXT_PUBLIC_API_URL: '', NEXT_PUBLIC_WS_URL: '', FRONTEND_PORT: String(port) }, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [next.stdout, next.stderr]) stream?.on('data', chunk => { logs = (logs + String(chunk)).slice(-32_000); });
  next.on('error', error => { logs += error.message; });
  const deadline = Date.now() + 90_000;
  for (;;) {
    assert(next.exitCode === null && Date.now() < deadline, redact(logs));
    try { if ((await fetch(`${frontend}/api/health`, { signal: AbortSignal.timeout(1500) })).status < 500) break; } catch {}
    await Bun.sleep(200);
  }
  browser = spawn('node', ['--experimental-strip-types', join(repo, 'tests/integration/smoke-platform-settings-browser.ts')], {
    cwd: repo, env: { ...process.env, NODE_NO_WARNINGS: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  browser.stdout!.on('data', chunk => process.stdout.write(redact(String(chunk))));
  browser.stderr!.on('data', chunk => process.stderr.write(redact(String(chunk))));
  const completed = new Promise<number | null>((done, reject) => { browser!.once('error', reject); browser!.once('close', done); });
  browser.stdin!.end(JSON.stringify({ frontend, apiToken, updaterToken, control: `http://127.0.0.1:${control.port}`, artifacts }));
  assert.equal(await completed, 0, 'Browser smoke failed');
  assert.equal(store.getPlatformState().releaseFeedUrl, null, 'Default source restored in persistent state');
  assert(store.listPlatformOperations(100).every(operation => operation.kind === 'check_updates'), 'No deployment mutation requested');
} catch (error) { failure = error; console.error(redact(String(error))); }
finally {
  if (timer) clearInterval(timer);
  for (const child of [next, browser]) if (child?.pid && child.exitCode === null) {
    if (process.platform === 'win32') await new Promise<void>(done => spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).once('close', () => done()));
    else { try { child === next ? process.kill(-child.pid, 'SIGTERM') : child.kill('SIGTERM'); } catch {} }
  }
  control?.stop(true); api?.stop(true); db?.close(); globalThis.fetch = nativeFetch;
  assert(resolve(root).startsWith(resolve(tmpdir()) + sep) && basename(root).startsWith('remi-platform-settings-'));
  try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { console.warn(`Fixture retained: ${root}`); }
  writeFileSync(join(artifacts, 'server.log'), redact(logs));
}
console.log(JSON.stringify({ ok: failure === null, artifacts, sourceTransport: 'fixture', deploymentDriver: 'read-only fixture', liveApiAndWorker: true }));
process.exit(failure === null ? 0 : 1);
