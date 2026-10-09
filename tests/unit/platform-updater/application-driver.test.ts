import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContainerApplicationDriver, LocalProfileCommandRunner } from '@remi-platform/updater/application-driver.js';
import { assertApplicationCompatible, parseApplicationManifest, type ApplicationManifest } from '@remi-platform/updater/application-manifest.js';
import { DATA_SCHEMA, READY_GATE, safetyCommand, testBackup } from './helpers.js';
import type { MultiremiPlatformOperation, ReportPlatformOperationInput } from '@multiremi/contracts';
import type { CommandOptions, CommandRunner } from '@remi-platform/updater/types.js';

const API = 'sha256:' + 'a'.repeat(64), WEB = 'sha256:' + 'b'.repeat(64), PG = 'sha256:' + 'c'.repeat(64);
const BASE = createHash('sha256').update('test base runtime').digest('hex');
const roots: string[] = [];
let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(async () => { fetchSpy?.mockRestore(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'remi-application-driver-')); roots.push(root);
  await writeFile(join(root, 'compose.yml'), 'services: {}');
  await writeFile(join(root, 'compose.env'), 'REMI_API_IMAGE=unchanged-api\nREMI_WEB_IMAGE=unchanged-web\n');
  const previous = { version: '1.0.0', ref: '1'.repeat(40), dataSchema: DATA_SCHEMA, publishedAt: null, releaseUrl: null, manifestUrl: null, apiImage: API, webImage: WEB };
  await writeFile(join(root, 'current-release.json'), JSON.stringify(previous));
  const bytes = Buffer.from('application archive fixture');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const manifest: ApplicationManifest = { ...previous, version: '1.0.1', ref: '2'.repeat(40), application: { format: 1, bun: '1.3.14', nodeMajor: 22, apiLibc: 'glibc 2.36', webLibc: 'glibc 2.36', apiBase: BASE, rollbackSafeFrom: [], assets: { 'linux-x64': { url: 'https://releases.example/application.tar.gz', sha256: hash } } } };
  const calls: Array<{ command: string; args: string[] }> = [];
  const events: string[] = [];
  const state = { selected: '', volume: false, failMigration: false, loseColumns: false, failRecovery: false, drainReady: true, running: '', rehearsalContainers: '', rehearsalReadyAfter: 0, rehearsalProbes: 0 };
  const runner: CommandRunner = {
    async run(command: string, args: string[], options?: CommandOptions) {
      calls.push({ command, args });
      const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
      if (command === 'test-dump') events.push('backup');
      const handled = safetyCommand(command, args, options);
      if (handled && !args.includes('config')) return handled;
      if (args[0] === 'compose') {
        if (args.includes('cat') && args.some(arg => arg.endsWith('/packages/server/src/store/migrations.ts'))) return ok('test migrations');
        if (args.includes('config')) return ok(JSON.stringify({ name: 'remi-test', services: { api: {}, web: {}, postgres: {} } }));
        if (args.includes('stop')) events.push('stop');
        if (args.includes('up')) events.push('bootstrap');
        if (args.includes('restart')) events.push('restart');
        if (args.includes('ps') && args.includes('--quiet')) return ok(args.at(-1) + '-container');
        return ok();
      }
      if (args[0] === 'inspect') {
        const image = args.at(-1) === 'web-container' ? WEB : args.at(-1) === 'postgres-container' ? PG : API;
        if (args.includes('{{.Image}}')) return ok(image);
        if (args.includes('{{.Id}} {{.Image}}')) return ok(args.at(-1) + ' ' + image);
        return ok(JSON.stringify({ Id: args.at(-1), Image: image, State: { Running: true }, Mounts: [] }));
      }
      if (args[0] === 'ps') return ok(args.includes('label=io.remi.application.rehearsal=true') ? state.rehearsalContainers : state.running);
      if (args[0] === 'exec') {
        if (args.includes('/app/deploy/docker/Dockerfile.api')) return ok('test base runtime');
        if (args.includes('process.arch')) return ok('x64');
        if (args.includes('--version')) return ok('1.3.14');
        if (args.includes('process.versions.node.split(".")[0]')) return ok('22');
        if (args.includes('GNU_LIBC_VERSION')) return ok('glibc 2.36');
        if (args.includes('pg_restore')) events.push('restore-scratch');
        if (args.includes('psql') && args.includes('SELECT 1')) {
          state.rehearsalProbes++;
          if (state.rehearsalProbes <= state.rehearsalReadyAfter) return { exitCode: 2, stdout: '', stderr: 'database "remi_update_rehearsal" does not exist' };
          events.push('rehearsal-ready');
          return ok('1');
        }
        if (args.includes('psql')) return ok(state.loseColumns && events.includes('migrate') ? '' : 'public.messages.id:integer:int4:NO');
        return ok();
      }
      if (args[0] === 'volume') {
        if (args[1] === 'ls') return ok(state.volume ? 'remi-test_application-releases' : '');
        if (args[1] === 'create') state.volume = true;
        return ok(args[1] === 'inspect' ? 'remi-test' : '');
      }
      if (args[0] === 'run') {
        const entry = args.indexOf('/remi-application-bootstrap/runtime.mjs');
        const action = entry >= 0 ? args[entry + 1] : '';
        if (action === 'inspect') return ok(JSON.stringify({ freeBytes: 100 * 1024 ** 3 }));
        if (action === 'verify') return ok(JSON.stringify(manifest));
        if (action === 'select') {
          state.selected = args[entry + 2]!; events.push('select:' + state.selected);
          if (state.failRecovery && state.selected.startsWith('seed-')) return { exitCode: 1, stdout: '', stderr: '' };
        }
        if (action === 'migrate') {
          events.push('migrate');
          if (state.failMigration) return { exitCode: 1, stdout: '', stderr: '' };
        }
      }
      return ok();
    },
  };
  const driver = new ContainerApplicationDriver({ kind: 'docker_compose', composeFile: join(root, 'compose.yml'), envFile: join(root, 'compose.env'), stateDir: root, backup: testBackup(root), apiHealthUrl: 'http://api.test/readyz', webHealthUrl: 'http://web.test/login', minimumFreeBytes: 1 }, runner);
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (url: string | URL | Request) => String(url).startsWith('https:') ? new Response(bytes) : Response.json({ ok: true })) as typeof fetch) as typeof fetchSpy;
  const operation = { id: 'pop_app', kind: 'update', driver: 'docker_compose', status: 'preparing', targetRef: null, targetVersion: '1.0.1', targetManifest: manifest as unknown as Record<string, unknown>, progress: {}, cancelRequested: false, requestedBy: 'local', error: null, previousRelease: null, resultRelease: null, createdAt: '', updatedAt: '', startedAt: null, finishedAt: null } as MultiremiPlatformOperation;
  const reports: ReportPlatformOperationInput[] = [];
  const report = async (value: ReportPlatformOperationInput) => { reports.push(value); events.push('report:' + value.status); };
  const gate = { ...READY_GATE, async waitUntilDrained() { events.push('drain'); if (!state.drainReady) throw new Error('Agent is still running'); }, async assertReady() { events.push('drain-ready'); } };
  return { root, driver, runner, calls, events, state, manifest, previous, operation, report, reports, gate, hash };
}

describe('container application updates', () => {
  it('pins the local Docker context and prevents inherited variables from redirecting backups or Compose', async () => {
    const runner = new LocalProfileCommandRunner({ async run(command, args, options) {
      expect(command).toBe('docker');
      expect(args.slice(0, 2)).toEqual(['--context', process.platform === 'win32' ? 'desktop-linux' : 'default']);
      for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'REMI_API_IMAGE', 'POSTGRES_PASSWORD', 'COMPOSE_FILE', 'MULTIREMI_TOKEN']) expect(options?.env?.[key]).toBeUndefined();
      expect(options?.stdoutFile).toBe('owned-backup.dump');
      const probe = Bun.spawn([process.execPath, '-e', 'process.exit(["DOCKER_HOST","DOCKER_CONTEXT","REMI_API_IMAGE","POSTGRES_PASSWORD","COMPOSE_FILE","MULTIREMI_TOKEN"].some(key => key in process.env) ? 1 : 0)'], {
        env: { ...process.env, ...options?.env }, stdout: 'ignore', stderr: 'ignore',
      });
      expect(await probe.exited).toBe(0);
      return { stdout: '', stderr: '', exitCode: 0 };
    } });
    await runner.run('docker', ['exec', 'owned-postgres', 'pg_dump'], { stdoutFile: 'owned-backup.dump', env: {
      DOCKER_HOST: 'ssh://another-machine', DOCKER_CONTEXT: 'remote', REMI_API_IMAGE: 'another-image',
      POSTGRES_PASSWORD: 'unrelated', COMPOSE_FILE: 'another-project.yml', MULTIREMI_TOKEN: 'unrelated',
    } });
  });
  it('bootstraps once with existing image IDs, preserves data and retains the old release', async () => {
    const f = await fixture();
    const result = await f.driver.execute(f.operation, f.report, f.gate);
    expect(result?.version).toBe('1.0.1');
    expect(f.events.indexOf('stop')).toBeGreaterThan(f.events.indexOf('drain-ready'));
    expect(f.events.indexOf('backup')).toBeGreaterThan(f.events.indexOf('stop'));
    expect(f.events.indexOf('bootstrap')).toBeGreaterThan(f.events.lastIndexOf('migrate'));
    const overlay = JSON.parse(await readFile(join(f.root, 'compose.application.json'), 'utf8'));
    expect(overlay.services.api.image).toBe(API); expect(overlay.services.web.image).toBe(WEB);
    expect(overlay.services.api.volumes[0].read_only).toBe(true);
    expect(await readFile(join(f.root, 'persistent/user-data.txt'), 'utf8')).toBe('preserve all user data');
    expect(await readFile(join(f.root, 'compose.env'), 'utf8')).toBe('REMI_API_IMAGE=unchanged-api\nREMI_WEB_IMAGE=unchanged-web\n');
    expect(f.calls.some(call => call.args[0] === 'pull' || call.args.includes('build'))).toBe(false);
    const mutating = f.calls.filter(call => call.args[0] === 'compose' && call.args.some(arg => ['stop', 'up', 'restart'].includes(arg)));
    expect(mutating.every(call => !call.args.includes('postgres') && !call.args.includes('daemon') && !call.args.includes('ssh-mesh-control-plane'))).toBe(true);
    expect((await f.driver.inspect()).recentReleases.map(release => release.version)).toContain('1.0.0');
    expect((await f.driver.pendingFinalization())?.report.status).toBe('succeeded');
    await f.driver.finalize(f.operation.id);
    expect(await f.driver.pendingFinalization()).toBeNull();
  });

  it('subsequent updates restart the same containers without compose up or image changes', async () => {
    const f = await fixture();
    await f.driver.execute(f.operation, f.report, f.gate); await f.driver.finalize(f.operation.id);
    f.calls.length = 0; f.events.length = 0;
    await f.driver.execute({ ...f.operation, id: 'pop_second' }, f.report, f.gate);
    expect(f.events).toContain('restart'); expect(f.events).not.toContain('bootstrap');
    expect(f.calls.filter(call => call.args.includes('{{.Id}} {{.Image}}'))).toHaveLength(4);
  });

  it('rejects a bad checksum or active agent before stopping any service', async () => {
    const f = await fixture();
    f.manifest.application.assets['linux-x64']!.sha256 = 'e'.repeat(64);
    await expect(f.driver.execute(f.operation, f.report, f.gate)).rejects.toThrow('SHA-256');
    expect(f.events).not.toContain('stop');
    f.manifest.application.assets['linux-x64']!.sha256 = f.hash; f.state.drainReady = false;
    await expect(f.driver.execute(f.operation, f.report, f.gate)).rejects.toThrow('Agent is still running');
    expect(f.events).not.toContain('stop');
  });

  it('rehearses changed schemas only when explicitly declared rollback compatible', async () => {
    const f = await fixture();
    const changed = { ...f.manifest, dataSchema: 'd'.repeat(64) };
    expect(() => assertApplicationCompatible(f.previous, changed)).toThrow('compatibility declaration');
    changed.application.rollbackSafeFrom = [DATA_SCHEMA];
    expect(() => assertApplicationCompatible(f.previous, changed)).not.toThrow();
    f.state.loseColumns = true;
    await expect(f.driver.execute(f.operation, f.report, f.gate)).rejects.toThrow('removed or changed');
    expect((await f.driver.inspect()).currentRelease?.version).toBe('1.0.0');
    expect((await f.driver.pendingFinalization())?.report.status).toBe('failed');
    expect(f.calls.some(call => call.args.includes('pg_restore') && call.args.includes('postgres-container'))).toBe(false);
  });

  it('waits for the rehearsal database over TCP before restoring into it', async () => {
    const f = await fixture(); f.state.rehearsalReadyAfter = 2;
    await f.driver.execute(f.operation, f.report, f.gate);
    const probes = f.calls.filter(call => call.args.includes('SELECT 1'));
    expect(probes).toHaveLength(3);
    expect(probes.every(call => call.args[0] === 'exec' && call.args[1]?.startsWith('remi-rehearsal-')
      && call.args.includes('127.0.0.1') && call.args.includes('remi_update_rehearsal'))).toBe(true);
    expect(f.events.indexOf('restore-scratch')).toBeGreaterThan(f.events.indexOf('rehearsal-ready'));
    expect(f.events.filter(event => event === 'restore-scratch')).toHaveLength(1);
  });

  it('keeps the rehearsal readiness budget and never restores when its database stays unavailable', async () => {
    const f = await fixture(); f.state.rehearsalReadyAfter = 41;
    const sleep = spyOn(Bun, 'sleep').mockImplementation(async () => {});
    try {
      await expect(f.driver.execute(f.operation, f.report, f.gate)).rejects.toThrow('Isolated migration database did not become ready');
      expect(f.state.rehearsalProbes).toBe(41);
      expect(sleep.mock.calls).toEqual(Array.from({ length: 40 }, () => [500]));
      expect(f.events).not.toContain('restore-scratch');
      expect(f.events).not.toContain('migrate');
      const removals = f.calls.filter(call => call.args[0] === 'rm');
      expect(removals).toHaveLength(1);
      expect(removals[0]!.args.at(-1)).toMatch(/^remi-rehearsal-pop_app-[a-f0-9]{8}$/);
      expect((await f.driver.pendingFinalization())?.report.status).toBe('failed');
    } finally { sleep.mockRestore(); }
  });

  it('recovers code after migration failure without restoring or deleting live data', async () => {
    const f = await fixture(); f.state.failMigration = true;
    await expect(f.driver.execute(f.operation, f.report, f.gate)).rejects.toThrow('migration rehearsal');
    expect(f.state.selected).toBe(`seed-${f.previous.ref}`);
    expect(await readFile(join(f.root, 'persistent/user-data.txt'), 'utf8')).toBe('preserve all user data');
    expect(f.calls.filter(call => call.args[0] === 'rm').every(call => call.args.at(-1)?.startsWith('remi-rehearsal-'))).toBe(true);
    const count = f.calls.length;
    await expect(f.driver.execute({ ...f.operation, status: 'verifying' }, f.report, f.gate)).rejects.toThrow('migration rehearsal');
    expect(f.calls.length).toBe(count);
  });

  it('keeps maintenance pinned if recovery fails and rejects corrupt recovery metadata', async () => {
    const f = await fixture(); f.state.failMigration = true; f.state.failRecovery = true;
    await expect(f.driver.execute(f.operation, f.report, f.gate)).rejects.toThrow('scheduling remains paused');
    await expect(f.driver.finalize(f.operation.id)).rejects.toThrow('not terminal');
    const path = join(f.root, 'application-operation-pop_app.json');
    const journal = JSON.parse(await readFile(path, 'utf8'));
    journal.installation.volume = 'production-database';
    await writeFile(path, JSON.stringify(journal));
    await expect(f.driver.recoverInterrupted()).rejects.toThrow('Recovery journal is invalid');
  });

  it('validates bundle presence, target CPU and base runtime before draining', async () => {
    const f = await fixture();
    expect(() => parseApplicationManifest(f.previous)).toThrow('no supported application bundle');
    f.manifest.application.bun = '1.4.0';
    await expect(f.driver.validateRelease(f.manifest)).rejects.toThrow('base runtime');
    f.manifest.application.bun = '1.3.14'; f.manifest.application.apiBase = 'd'.repeat(64);
    await expect(f.driver.validateRelease(f.manifest)).rejects.toThrow('base runtime');
    f.manifest.application.apiBase = BASE; f.manifest.application.assets = {};
    await expect(f.driver.validateRelease(f.manifest)).rejects.toThrow('architecture');
    expect(f.events).not.toContain('stop');
  });

  it('recovers a committed host journal without relying on an API report', async () => {
    const f = await fixture(); f.state.failMigration = true; f.state.failRecovery = true;
    await expect(f.driver.execute(f.operation, f.report, f.gate)).rejects.toThrow('scheduling remains paused');
    f.state.failRecovery = false;
    f.state.rehearsalContainers = 'abcdef123456 remi-rehearsal-pop_app-abcd1234';
    await f.driver.recoverInterrupted();
    expect(f.calls.some(call => call.args[0] === 'rm' && call.args.at(-1) === 'abcdef123456')).toBe(true);
    expect(f.state.selected).toBe(`seed-${f.previous.ref}`);
    expect((await f.driver.pendingFinalization())?.report.status).toBe('failed');
    expect(await readFile(join(f.root, 'persistent/user-data.txt'), 'utf8')).toBe('preserve all user data');
    await f.driver.finalize(f.operation.id);
    expect(await f.driver.pendingFinalization()).toBeNull();
  });

  it('rejects an unmanaged split API or retired sidecar before touching running services', async () => {
    const f = await fixture(); f.state.running = 'api\nweb\napi-runtime';
    await expect(f.driver.execute(f.operation, f.report, f.gate)).rejects.toThrow('Include the running api-runtime');
    f.state.running = 'api\nweb\nfeishu-sidecar';
    await expect(f.driver.execute(f.operation, f.report, f.gate)).rejects.toThrow('Retire the obsolete');
    expect(f.events).not.toContain('stop');
  });

  it('removes partial downloads after a stream failure and leaves services running', async () => {
    const f = await fixture();
    fetchSpy!.mockImplementation(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1, 2])); },
      pull(controller) { controller.error(new Error('Disconnected download')); },
    })));
    await expect(f.driver.execute(f.operation, f.report, f.gate)).rejects.toThrow('Disconnected download');
    expect((await readdir(f.root)).some(name => name.endsWith('.tar.gz'))).toBe(false);
    expect(f.events).not.toContain('stop');
  });
});
