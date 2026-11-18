import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { startEdge } from '../../packages/edge/src/index.js';
import { SlotSupervisor } from '../../packages/platform-updater/src/slot-supervisor.mjs';
import { DATA_SCHEMA_INPUTS, API_BASE_INPUTS } from '../../packages/platform-updater/src/container-runtime.mjs';
import { readJson, writeJson } from '../../packages/platform-updater/src/supervisor.mjs';

async function until(check: () => boolean | Promise<boolean>, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(20); }
  throw new Error('State wait timed out');
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'remi-recovery-'));
  const reservations = [0, 1].map(() => Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') }));
  const ports = reservations.map(s => s.port!);
  for (const s of reservations) await s.stop(true);
  const edge = startEdge({ hostname: '127.0.0.1', port: 0, holdMaxMs: 60000, log: () => {} });
  for (const id of ['old', 'new']) {
    await mkdir(join(root, id));
    await writeFile(join(root, id, 'behavior.json'), JSON.stringify({ name: id, neverStandby: id === 'new' }));
  }
  let launchError: 'sync' | 'spawn' | null = null, attempts = 0;
  const controller = new SlotSupervisor(edge, async id => {
    if (launchError) attempts++;
    if (launchError === 'sync') throw new Error('Release is incomplete');
    return { cwd: join(root, id!), executable: launchError === 'spawn' ? join(root, 'missing-runtime') : process.execPath,
      args: [resolve('tests/fixtures/supervisor-slot.ts')], version: id!, env: process.env };
  }, { ports, standbyWait: 800, activateWait: 800, confirmWait: 50 });
  const desired = { mode: 'run' as const, releaseId: 'old', revision: 'initial' };
  await controller.reconcile(desired);
  return { root, edge, ports, controller, desired, attempts: () => attempts,
    failLaunch: (value: typeof launchError) => { launchError = value; },
    async crash() { process.kill(-controller.snapshot().childPid!, 'SIGKILL'); await until(() => !controller.snapshot().childPid); },
    async ready() {
      expect((await fetch(`http://127.0.0.1:${ports[0]}/readyz`)).status).toBe(200);
      expect(edge.status().held).toBe(false);
      // Business responses require the fixture's actual active lifecycle state.
      const response = await fetch(`http://127.0.0.1:${edge.server.port}/`, { signal: AbortSignal.timeout(1000) });
      expect(response.status).toBe(200); expect(await response.text()).toBe('old');
    },
    async close() { await controller.stop(); await rm(root, { recursive: true, force: true }); },
  };
}

test('recovery: neverStandby candidate plus old process group death restores active old slot', async () => {
  const f = await fixture();
  try {
    const switching = f.controller.reconcile({ mode: 'run', releaseId: 'new', revision: 'switch', strategy: 'switch' });
    await until(() => f.controller.snapshot().transition?.phase === 'standby');
    await f.crash(); await switching;
    expect(f.controller.snapshot().transition?.phase).toBe('failed');
    await f.ready();
    await f.controller.reconcile({ mode: 'run', releaseId: 'new', revision: 'switch', strategy: 'switch' });
    await f.ready();
  } finally { await f.close(); }
}, 10000);

for (const failure of ['sync', 'spawn'] as const) {
  test(`recovery: ${failure} launch failure retains original error and exhausts five retries`, async () => {
    const f = await fixture();
    try {
      await f.crash(); f.failLaunch(failure);
      const started = Date.now();
      for (let attempt = 1; attempt < 5; attempt++) {
        await expect(f.controller.reconcile(f.desired)).resolves.toBeUndefined();
        expect(f.attempts()).toBe(attempt);
        expect(f.edge.status().held).toBe(true);
      }
      await expect(f.controller.reconcile(f.desired)).rejects.toThrow(failure === 'sync' ? 'Release is incomplete' : 'ENOENT');
      expect(f.attempts()).toBe(5);
      expect(Date.now() - started).toBeGreaterThanOrEqual(31000);
    } finally { await f.close(); }
  }, 45000);
}

test('recovery: a failed launch can self-heal on repeated reconcile', async () => {
  const f = await fixture();
  try {
    await f.crash(); f.failLaunch('sync');
    await expect(f.controller.reconcile(f.desired)).resolves.toBeUndefined();
    f.failLaunch(null);
    await f.controller.reconcile(f.desired);
    await f.ready();
  } finally { await f.close(); }
}, 10000);

test('recovery: real supervisor interrupted during candidate standby restores previous active release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remi-transaction-'));
  const source = join(root, 'source'), control = join(root, 'control'), program = join(root, 'program');
  const reservations: ReturnType<typeof Bun.serve>[] = [];
  let port = 0;
  for (let attempt = 0; attempt < 30 && !port; attempt++) {
    try {
      const first = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') }); reservations.push(first);
      for (const next of [first.port! + 1, first.port! + 2]) reservations.push(Bun.serve({ hostname: '127.0.0.1', port: next, fetch: () => new Response('') }));
      port = first.port!;
    } catch { for (const server of reservations.splice(0)) await server.stop(true); }
  }
  expect(port).toBeGreaterThan(0);
  const statusPath = join(control, 'api/status.json');
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const start = () => Bun.spawn([process.execPath, resolve('packages/platform-updater/src/supervisor.mjs')], {
    env: { ...process.env, REMI_SUPERVISOR_ROLE: 'api', REMI_SLOT_SWITCH: '1', REMI_SUPERVISOR_SOURCE: source,
      REMI_SUPERVISOR_CONTROL: control, REMI_APPLICATION_ROOT: program, REMI_SUPERVISOR_SEED: join(root, 'seed'),
      REMI_SUPERVISOR_FENCE: resolve('deploy/docker/host-write-fence.ts'), REMI_APPLICATION_BASE_VERSION: 'old',
      REMI_APPLICATION_BASE_REF: 'test', MULTIREMI_PORT: String(port), MULTIREMI_HOST: '127.0.0.1',
      REMI_SLOT_STANDBY_WAIT_MS: '5000', REMI_SLOT_ACTIVATE_WAIT_MS: '1000', REMI_SLOT_CONFIRM_WAIT_MS: '1000' },
    stdout: 'ignore', stderr: 'inherit',
  });
  try {
    for (const file of [...DATA_SCHEMA_INPUTS, ...API_BASE_INPUTS, 'apps/server/main.ts']) {
      const path = join(source, file); await mkdir(dirname(path), { recursive: true }); await writeFile(path, '// fixture');
    }
    const script = await readFile(resolve('tests/fixtures/supervisor-slot.ts'));
    await writeFile(join(source, 'apps/server/main.ts'), script);
    await writeFile(join(source, 'behavior.json'), JSON.stringify({ name: 'old' }));
    // Use a non-null previous ID so recovery must retain the actual old selection.
    for (const id of ['previous', 'rejected']) {
      const release = join(program, 'releases', id);
      await mkdir(join(release, 'api/apps/server'), { recursive: true }); await mkdir(join(release, 'runtime'));
      await writeFile(join(release, 'api/apps/server/main.ts'), script);
      await writeFile(join(release, 'api/behavior.json'), JSON.stringify({ name: id, neverStandby: id === 'rejected' }));
      await writeJson(join(release, 'complete.json'), { version: id });
      await symlink(process.execPath, join(release, 'runtime/bun'));
    }
    for (const server of reservations.splice(0)) await server.stop(true);
    await writeJson(join(control, 'api/desired.json'), { revision: 'initial', releaseId: 'previous', mode: 'run' });
    child = start();
    await until(async () => (await readJson(statusPath))?.transition?.phase === 'succeeded');
    await writeJson(join(control, 'api/desired.json'), { revision: 'interrupted', releaseId: 'rejected', mode: 'run', strategy: 'switch' });
    await until(async () => (await readJson(statusPath))?.transition?.phase === 'standby');
    // Stop before standby expires: this is an unfinished transaction, not a terminal rollback.
    child.kill('SIGTERM'); await child.exited;
    child = start();
    await until(async () => {
      const state = await readJson(statusPath);
      return state?.supervisorPid === child!.pid && state?.transition?.phase === 'failed';
    }, 8000);
    const state = await readJson(statusPath);
    expect(state.releaseId).toBe('previous');
    expect(state.revision).toBe('interrupted');
    expect((await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(1000) })).status).toBe(200);
    expect(await (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) })).text()).toBe('previous');
    // A subsequent heartbeat/reconcile must not retry the bad desired release.
    await Bun.sleep(700);
    expect((await readJson(statusPath)).childPid).toBe(state.childPid);
  } finally {
    if (child) { child.kill('SIGTERM'); await child.exited; }
    for (const server of reservations) await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
