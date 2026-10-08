import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { MultiremiPlatformOperation } from '@multiremi/contracts';
import { InternalApplicationDriver } from '@remi-platform/updater/internal-driver.js';
import { PlatformUpdaterClient } from '@remi-platform/updater/client.js';
import { preflightResult, RecoveryRequiredError } from '@remi-platform/updater/safety.js';
import type { ApplicationManifest } from '@remi-platform/updater/application-manifest.js';
import { DATA_SCHEMA_INPUTS } from '../../../packages/platform-updater/src/container-runtime.mjs';
import { baseFingerprints, readJson, schemaFingerprint, writeJson } from '../../../packages/platform-updater/src/supervisor.mjs';
import { READY_GATE } from './helpers.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'remi-internal-driver-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const config = { root: join(root, 'program'), state: join(root, 'state'), control: join(root, 'control'), seeds: join(root, 'seeds'),
    dataPaths: [join(root, 'data')], databaseUrl: 'postgresql://remi:fixture-password@database:5432/remi',
    apiHealthUrl: 'http://fixture-api/readyz', webHealthUrl: 'http://fixture-web/login', minimumFreeBytes: 1, verificationTimeoutMs: 1 };
  const id = 'base-' + '1'.repeat(40), releaseRoot = join(config.root, 'releases', id);
  for (const file of [...DATA_SCHEMA_INPUTS.map(file => 'api/' + file), 'api/deploy/docker/Dockerfile.api', 'api/deploy/docker/api-entrypoint.sh', 'api/apps/server/main.ts', 'web/frontend/apps/web/server.js', 'runtime/bun', 'runtime/node']) {
    const path = join(releaseRoot, file); await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.endsWith('Dockerfile.api') ? 'FROM oven/bun:1.3.13\n' : '// fixture\n');
  }
  await mkdir(config.dataPaths[0]!, { recursive: true });
  await writeFile(join(config.dataPaths[0]!, 'transcript'), 'new user data');
  const fingerprints = await baseFingerprints(join(releaseRoot, 'api'));
  const manifest: ApplicationManifest = { version: '1.0.0', ref: '1'.repeat(40), dataSchema: await schemaFingerprint(join(releaseRoot, 'api')),
    apiImage: null, webImage: null, publishedAt: null, releaseUrl: null, manifestUrl: null,
    application: { format: 1, bun: '1.3.13', node: '22.13.1', nodeMajor: 22, supervisor: 1, apiLibc: 'glibc 2.36', webLibc: 'glibc 2.36', ...fingerprints,
      rollbackSafeFrom: [], assets: { [`linux-${process.arch}`]: { url: 'https://releases.example/app.tar.gz', sha256: 'a'.repeat(64) } } } };
  const selection = { id, release: manifest };
  await writeJson(join(releaseRoot, 'complete.json'), manifest);
  await writeJson(join(config.state, 'current.json'), selection);
  const statuses = Object.fromEntries(['api', 'web'].map(role => [role, { protocol: 1, role, arch: process.arch, version: manifest.version, ref: manifest.ref,
    runtime: role === 'api' ? '1.3.13' : '22.13.1', libc: 'glibc 2.36', dataSchema: manifest.dataSchema, ...fingerprints,
    supervisorPid: 10, childPid: 11, releaseId: id, revision: null, stopped: false, heartbeatAt: Date.now(), seedReady: true }])) as Record<string, any>;
  for (const role of ['api', 'web']) {
    await writeJson(join(config.control, role, 'status.json'), statuses[role]);
    await writeJson(join(config.seeds, role, 'complete.json'), statuses[role]);
  }
  await writeJson(join(config.control, 'rehearsal/status.json'), { protocol: 1, isolated: true, heartbeatAt: Date.now() });
  const calls: string[] = [], events: string[] = [];
  const state = { backupFails: false, rehearsalFails: false, healthFails: false };
  const driver = new InternalApplicationDriver(config, { async run(command, args, options) {
    calls.push(command);
    expect(options?.env?.PGPASSWORD).toBe('fixture-password');
    expect(args.join(' ')).not.toContain('fixture-password');
    if (options?.stdoutFile) {
      events.push('backup');
      if (state.backupFails) return { exitCode: 1, stdout: '', stderr: 'failed' };
      await writeFile(options.stdoutFile, 'verified snapshot');
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  } });
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => new Response('', { status: state.healthFails ? 503 : 200 })) as unknown as typeof fetch);
  cleanup.push(async () => { fetchSpy.mockRestore(); });
  // Simulated supervisor protocol; the Docker integration test runs real
  // processes and executes both changed Bun and Node binaries.
  let alive = true;
  const controller = (async () => {
    while (alive) {
      for (const role of ['api', 'web']) {
        const desired = await readJson<any>(join(config.control, role, 'desired.json'));
        const probe = await readJson<any>(join(config.control, role, 'probe.json'));
        if (desired && desired.revision !== statuses[role].revision) {
          events.push(role + ':' + desired.mode);
          Object.assign(statuses[role], { revision: desired.revision, childPid: desired.mode === 'run' ? 22 : null,
            stopped: desired.mode === 'stop', releaseId: desired.mode === 'run' ? desired.releaseId : null });
        }
        if (probe) statuses[role].probe = { id: probe.id, ok: true };
        if (desired || probe) await writeJson(join(config.control, role, 'status.json'), { ...statuses[role], heartbeatAt: Date.now() });
      }
      const job = await readJson<any>(join(config.control, 'rehearsal/job.json'));
      if (job) await writeJson(join(config.control, 'rehearsal/result.json'), { id: job.id, ok: !state.rehearsalFails, error: state.rehearsalFails ? 'Migration removed a column' : undefined });
      await Bun.sleep(5);
    }
  })();
  cleanup.push(async () => { alive = false; await controller; });
  const operation = { id: 'pop_internal', kind: 'restart', status: 'preparing', driver: 'docker_compose', targetVersion: null, targetRef: null, targetManifest: {},
    progress: {}, cancelRequested: false, requestedBy: 'local', error: null, previousRelease: null, resultRelease: null, createdAt: '', updatedAt: '', startedAt: null, finishedAt: null } as MultiremiPlatformOperation;
  const report = async (value: { status?: string }) => { events.push('report:' + value.status); };
  const journal = async (phase: string) => writeJson(join(config.state, 'operations', operation.id + '.json'), { operationId: operation.id, kind: operation.kind, phase, previous: selection, target: selection });
  const preflight = () => { const mock = spyOn(driver, 'preflight').mockResolvedValue(preflightResult([])); cleanup.push(async () => { mock.mockRestore(); }); };
  return { config, driver, manifest, operation, report, selection, journal, preflight, state, calls, events, fetchSpy };
}

describe('socket-free internal application updates', () => {
  it('accepts changed Bun/Node executables while requiring compatible native tools and libc', async () => {
    const f = await fixture();
    const next = structuredClone(f.manifest);
    Object.assign(next.application, { bun: '1.3.14', node: '24.1.0', nodeMajor: 24, apiBase: 'b'.repeat(64) });
    await f.driver.validateRelease(next);
    next.application.nativeTools = 'c'.repeat(64);
    await expect(f.driver.validateRelease(next)).rejects.toThrow('Native API tools');
    next.application.nativeTools = f.manifest.application.nativeTools;
    next.application.apiLibc = 'glibc 2.40';
    await expect(f.driver.validateRelease(next)).rejects.toThrow('OS ABI');
    expect(f.events).toEqual([]);
  });
  it('rejects old bundle formats, missing CPU assets, unreviewed migrations and inconsistent Node versions', async () => {
    const f = await fixture();
    for (const patch of [{ supervisor: undefined }, { node: '24.0.0' }, { assets: {} }]) {
      const next = structuredClone(f.manifest); Object.assign(next.application, patch);
      await expect(f.driver.validateRelease(next)).rejects.toThrow();
    }
    await expect(f.driver.validateRelease({ ...f.manifest, dataSchema: 'd'.repeat(64) })).rejects.toThrow('reviewed');
  });
  it('retains CI base identities for recovery without accepting prerelease update feeds', async () => {
    const f = await fixture();
    await rm(join(f.config.state, 'current.json'));
    for (const role of ['api', 'web']) {
      const path = join(f.config.seeds, role, 'complete.json');
      await writeJson(path, { ...await readJson(path), version: '1.0.0-stable.11111111' });
    }
    expect((await f.driver.inspect()).currentRelease?.version).toBe('1.0.0-stable.11111111');
    await expect(f.driver.validateRelease({ ...f.manifest, version: '1.0.1-test' })).rejects.toThrow('identity');
  });
  it('blocks missing/stale supervisors and a rehearsal service without isolation proof', async () => {
    const f = await fixture();
    const path = join(f.config.control, 'api/status.json');
    await writeJson(path, { ...await readJson(path), heartbeatAt: 0 });
    await writeJson(join(f.config.control, 'rehearsal/status.json'), { protocol: 1, heartbeatAt: Date.now() });
    const result = await f.driver.preflight();
    expect(result.checks.find(check => check.code === 'container_supervisors')?.ok).toBe(false);
    expect(result.checks.find(check => check.code === 'isolated_rehearsal')?.ok).toBe(false);
  });
  it('never stops applications when a task or cancellation prevents drain', async () => {
    const f = await fixture(); f.preflight();
    await expect(f.driver.execute(f.operation, f.report, { ...READY_GATE, async waitUntilDrained() { throw new Error('active task'); } })).rejects.toThrow('active task');
    expect(f.events.some(event => event.endsWith(':stop'))).toBe(false);
    expect(f.calls).toEqual([]);
    expect(await readJson(join(f.config.control, 'write-fence.json'))).toBeNull();
  });
  it.each(['identity', 'runtime', 'migration policy'])('rejects a cached archive advertised with a different %s before stopping children', async mismatch => {
    const f = await fixture(); f.preflight();
    const cached = structuredClone(f.manifest);
    if (mismatch === 'identity') cached.version = '9.9.9';
    else if (mismatch === 'runtime') cached.application.node = '24.1.0';
    else cached.application.rollbackSafeFrom = ['f'.repeat(64)];
    await writeJson(join(f.config.root, 'releases', 'release-' + 'a'.repeat(48), 'complete.json'), { ...cached, archiveSha256: 'a'.repeat(64) });
    await expect(f.driver.execute({ ...f.operation, kind: 'update', targetManifest: f.manifest as unknown as Record<string, unknown> }, f.report, READY_GATE)).rejects.toThrow('Bundle');
    expect(f.events.some(event => event.endsWith(':stop'))).toBe(false);
  });
  it('backs up only after drain and quiescing, then holds the fence until terminal acknowledgement', async () => {
    const f = await fixture(); f.preflight();
    await f.driver.execute(f.operation, f.report, { ...READY_GATE, async assertReady() { f.events.push('drained'); } });
    expect(f.events.indexOf('api:stop')).toBeGreaterThan(f.events.indexOf('drained'));
    expect(f.events.indexOf('backup')).toBeGreaterThan(f.events.indexOf('web:stop'));
    expect((await f.driver.pendingFinalization())?.report.status).toBe('succeeded');
    await expect(f.driver.finalize('pop_other')).rejects.toBeInstanceOf(RecoveryRequiredError);
    await f.driver.finalize(f.operation.id);
    expect(await f.driver.pendingFinalization()).toBeNull();
    expect(f.calls.every(command => ['pg_dump', 'pg_restore', 'tar'].includes(command))).toBe(true);
  });
  it.each(['backupFails', 'rehearsalFails'] as const)('recovers the old program on %s without restoring live data', async failure => {
    const f = await fixture(); f.preflight(); f.state[failure] = true;
    await expect(f.driver.execute(f.operation, f.report, READY_GATE)).rejects.toThrow();
    expect((await f.driver.pendingFinalization())?.report.status).toBe('failed');
    expect(await readFile(join(f.config.dataPaths[0]!, 'transcript'), 'utf8')).toBe('new user data');
    expect(f.calls.filter(command => command === 'pg_restore')).toHaveLength(failure === 'backupFails' ? 0 : 1); // --list only
    await f.driver.finalize(f.operation.id);
  });
  it('recovers committed journals before needing API credentials or connectivity', async () => {
    const f = await fixture(); await f.journal('committed');
    await f.driver.recoverInterrupted();
    expect((await f.driver.pendingFinalization())?.report.status).toBe('failed');
    expect(f.events).toEqual(['api:stop', 'web:stop', 'api:run', 'web:run']);
    expect(f.calls).toEqual([]);
  });
  it('leaves recovery and writes blocked if the retained application is unhealthy', async () => {
    const f = await fixture(); f.state.healthFails = true; await f.journal('committed');
    await expect(f.driver.recoverInterrupted()).rejects.toBeInstanceOf(RecoveryRequiredError);
    await expect(f.driver.finalize(f.operation.id)).rejects.toBeInstanceOf(RecoveryRequiredError);
    const fence = await readJson<{ operationId: string }>(join(f.config.control, 'write-fence.json'));
    expect(fence?.operationId).toBe(f.operation.id);
  });
  it('does not treat corrupt or unreadable journal storage as an empty installation', async () => {
    const f = await fixture(); await f.journal('committed');
    await writeFile(join(f.config.state, 'operations', f.operation.id + '.json'), '{broken');
    await expect(f.driver.recoverInterrupted()).rejects.toBeInstanceOf(RecoveryRequiredError);
    await rm(join(f.config.state, 'operations'), { recursive: true });
    await writeFile(join(f.config.state, 'operations'), 'not a directory');
    await expect(f.driver.recoverInterrupted()).rejects.toThrow();
    expect(f.events).toEqual([]);
  });
  it('distinguishes the pre-commit crash gap from an unknown committed operation', async () => {
    const f = await fixture();
    const operation = { ...f.operation, status: 'switching' as const };
    await expect(f.driver.execute(operation, f.report, READY_GATE)).rejects.toBeInstanceOf(RecoveryRequiredError);
    await f.journal('prepared');
    try { await f.driver.execute(operation, f.report, READY_GATE); throw new Error('expected interruption'); }
    catch (error) { expect(error).not.toBeInstanceOf(RecoveryRequiredError); expect(String(error)).toContain('before the container commit'); }
    expect(f.events).toEqual([]);
  });
  it('replays a verified result without restarting children or touching the database', async () => {
    const f = await fixture(); await f.journal('verified');
    expect(await f.driver.execute({ ...f.operation, status: 'verifying' }, f.report, READY_GATE)).toEqual(f.manifest);
    expect(f.calls).toEqual([]); expect(f.events).toEqual([]);
  });
  it('keeps long operations online without overwriting release and preflight projections', async () => {
    const f = await fixture(); let body: unknown;
    f.fetchSpy.mockImplementation((async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => { body = JSON.parse(String(init?.body)); return Response.json({ state: {} }); }) as typeof fetch);
    await new PlatformUpdaterClient('http://fixture-api', 'test-master', 'test-updater').keepAlive('docker_compose');
    expect(body).toEqual({ driver: 'docker_compose' });
  });
});
