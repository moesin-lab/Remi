import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startEdge } from '../../packages/edge/src/index.js';
import { SlotSupervisor } from '../../packages/platform-updater/src/slot-supervisor.mjs';

for (const [name, behavior] of Object.entries({ success: {}, oldNoTerm: {}, noTerm: { noTerm: true }, releaseFailure: {}, unhealthyAfter: { unhealthyAfter: 200 }, immediateExit: { immediateExit: true },
  standbyTimeout: { neverStandby: true }, activateFailure: { activateFails: true },
  readinessTimeout: { neverReady: true }, crashAfter30s: { crashAfter: 30000 } })) {
  test(`two releases: ${name}, continuous edge requests succeed`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'remi-slots-'));
    const reservations = [0, 1].map(() => Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') }));
    const ports = reservations.map(server => server.port!);
    const edge = startEdge({ hostname: '127.0.0.1', port: 0, holdMaxMs: 10000, log: () => {} });
    for (const server of reservations) await server.stop(true);
    const controller = new SlotSupervisor(edge, async (id: string | null) => ({ cwd: join(root, id!), executable: process.execPath,
      args: [resolve('tests/fixtures/supervisor-slot.ts')], version: id!, env: process.env }),
      { ports, standbyWait: 500, activateWait: 500, releaseWait: 500, confirmWait: name === 'crashAfter30s' ? 32000 : name === 'unhealthyAfter' ? 4100 : 200 });
    let probing = true, failures = 0, count = 0;
    let probe: Promise<void> | undefined;
    try {
      for (const id of ['old', 'new']) { await mkdir(join(root, id!)); await writeFile(join(root, id, 'behavior.json'), JSON.stringify({ name: id, ...(id === 'new' ? behavior : { releaseFails: name === 'releaseFailure', noTerm: name === 'oldNoTerm' }) })); }
      await controller.reconcile({ mode: 'run', releaseId: 'old', revision: 'initial' });
      const oldPid = controller.snapshot().childPid;
      probe = (async () => { while (probing) {
        try { const response = await fetch(`http://127.0.0.1:${edge.server.port}/`, { signal: AbortSignal.timeout(9000) });
          if (response.status !== 200 || !['old', 'new'].includes(await response.text())) failures++;
        } catch { failures++; }
        count++; await Bun.sleep(10);
      } })();
      await controller.reconcile({ mode: 'run', releaseId: 'new', revision: 'switch', strategy: 'switch' });
      expect(controller.snapshot().transition!.phase).toBe(name === 'success' ? 'succeeded' : 'failed');
      expect(controller.snapshot().releaseId).toBe(name === 'success' ? 'new' : 'old');
      if (['immediateExit', 'standbyTimeout', 'activateFailure', 'readinessTimeout', 'releaseFailure', 'noTerm', 'oldNoTerm'].includes(name)) expect(controller.snapshot().childPid).toBe(oldPid);
      probing = false; await probe;
      expect(count).toBeGreaterThan(0); expect(failures).toBe(0);
    } finally { probing = false; await probe; await controller.stop(); await rm(root, { recursive: true, force: true }); }
  }, 45000);
}

for (const interruptedPhase of ['disabled', 'terminal', 'standby', 'releasing', 'activating', 'confirming', 'rolling_back']) {
test(`image supervisor restores previous release after ${interruptedPhase} restart`, async () => {
  const { readFile, symlink } = await import('node:fs/promises');
  const { DATA_SCHEMA_INPUTS, API_BASE_INPUTS } = await import('../../packages/platform-updater/src/container-runtime.mjs');
  const { readJson, writeJson } = await import('../../packages/platform-updater/src/supervisor.mjs');
  const root = await mkdtemp(join(tmpdir(), 'remi-supervisor-'));
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
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const statusPath = join(control, 'api/status.json');
  async function until(check: () => Promise<boolean>, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(50); }
    throw new Error('Supervisor state wait timed out');
  }
  const start = () => Bun.spawn([process.execPath, resolve('packages/platform-updater/src/supervisor.mjs')], {
    env: { ...process.env, REMI_SUPERVISOR_ROLE: 'api', REMI_SUPERVISOR_SOURCE: source,
      REMI_SUPERVISOR_CONTROL: control, REMI_APPLICATION_ROOT: program, REMI_SUPERVISOR_SEED: join(root, 'seed'),
      REMI_SUPERVISOR_FENCE: resolve('deploy/docker/host-write-fence.ts'), REMI_APPLICATION_BASE_VERSION: 'old',
      REMI_APPLICATION_BASE_REF: 'test', REMI_SLOT_SWITCH: interruptedPhase === 'disabled' ? undefined : '1', MULTIREMI_PORT: String(port), MULTIREMI_HOST: '127.0.0.1',
      REMI_SLOT_STANDBY_WAIT_MS: '1600', REMI_SLOT_ACTIVATE_WAIT_MS: '2000', REMI_SLOT_CONFIRM_WAIT_MS: '2500' },
    stdout: 'ignore', stderr: 'inherit',
  });
  try {
    for (const file of [...DATA_SCHEMA_INPUTS, ...API_BASE_INPUTS, 'apps/server/main.ts', 'empty.ts']) {
      const path = join(source, file); await mkdir((await import('node:path')).dirname(path), { recursive: true });
      await writeFile(path, '// fixture');
    }
    await writeFile(join(source, 'apps/server/main.ts'), await readFile(resolve('tests/fixtures/supervisor-slot.ts')));
    await writeFile(join(source, 'behavior.json'), JSON.stringify({ name: 'old', pidFile: join(root, 'old.pid'), releaseDelay: interruptedPhase === 'releasing' ? 1200 : 0, reactivateDelay: interruptedPhase === 'rolling_back' ? 1200 : 0 }));
    const release = join(program, 'releases', 'rejected');
    await mkdir(join(release, 'api/apps/server'), { recursive: true }); await mkdir(join(release, 'runtime'));
    await writeFile(join(release, 'api/apps/server/main.ts'), await readFile(resolve('tests/fixtures/supervisor-slot.ts')));
    await writeFile(join(release, 'api/behavior.json'), JSON.stringify({ name: 'new', pidFile: join(root, 'new.pid'), neverStandby: ['terminal', 'standby'].includes(interruptedPhase), activateDelay: interruptedPhase === 'activating' ? 1200 : 0, activateFails: interruptedPhase === 'rolling_back' }));
    await writeJson(join(release, 'complete.json'), { version: 'new' });
    await symlink(process.execPath, join(release, 'runtime/bun'));
    for (const server of reservations.splice(0)) await server.stop(true);
    child = start();
    await until(async () => Boolean((await readJson(statusPath))?.seedReady && (await readJson(statusPath))?.childPid && (interruptedPhase === 'disabled' || (await readJson(statusPath))?.transition?.phase === 'succeeded')));
    if (interruptedPhase === 'disabled') {
      expect((await readJson(statusPath)).slotSwitch).toBeUndefined();
      expect(await readJson(join(control, 'api/slot-selection.json'))).toBeNull();
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('old');
      return;
    }
    const bootPid = (await readJson(statusPath)).childPid;
    await Bun.sleep(700);
    expect((await readJson(statusPath)).childPid).toBe(bootPid);
    await writeJson(join(control, 'api/desired.json'), { revision: 'rejected-switch', releaseId: 'rejected', mode: 'run', strategy: 'switch' });
    if (['terminal', 'standby'].includes(interruptedPhase)) await until(async () => (await readJson(statusPath))?.transition?.phase === 'standby');
    if (interruptedPhase === 'terminal') {
      const heartbeat = (await readJson(statusPath)).heartbeatAt;
      await until(async () => (await readJson(statusPath))?.heartbeatAt > heartbeat);
      await until(async () => (await readJson(statusPath))?.transition?.phase === 'failed');
      expect((await readJson(statusPath)).releaseId).toBeNull();
      child.kill('SIGTERM'); await child.exited;
    } else {
      await until(async () => (await readJson(statusPath))?.transition?.phase === interruptedPhase);
      const saved = await readJson(join(control, 'api/slot-selection.json'));
      expect(saved.transition.hasPrevious).toBe(true);
      expect(saved.transition.target).toBe('rejected');
      // Simulate a container crash: supervisor and its child process groups die.
      child.kill('SIGKILL'); await child.exited;
      for (const name of ['old', 'new']) {
        try { process.kill(-Number(await readFile(join(root, name + '.pid'), 'utf8')), 'SIGKILL'); } catch (error: any) { if (error.code !== 'ESRCH' && error.code !== 'ENOENT') throw error; }
      }
    }
    child = start();
    await until(async () => Boolean((await readJson(statusPath))?.supervisorPid === child!.pid && (await readJson(statusPath))?.childPid));
    await Bun.sleep(600);
    expect((await readJson(statusPath)).transition.phase).toBe('failed');
    expect((await readJson(statusPath)).releaseId).toBeNull();
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('old');
    // The fallback path starts standby/activate while the host fence is held.
    await writeJson(join(control, 'write-fence.json'), { operationId: 'pop_offline' });
    await writeJson(join(control, 'api/desired.json'), { revision: 'offline-stop', releaseId: null, mode: 'stop' });
    await until(async () => (await readJson(statusPath))?.stopped === true);
    await writeJson(join(control, 'api/desired.json'), { revision: 'offline-run', releaseId: null, mode: 'run' });
    await until(async () => (await readJson(statusPath))?.revision === 'offline-run' && (await readJson(statusPath))?.transition?.phase === 'succeeded');
    expect((await fetch(`http://127.0.0.1:${port}/api/issues`, { method: 'POST' })).status).toBe(503);
    expect((await readJson(join(control, 'write-fence.json'))).operationId).toBe('pop_offline');
  } finally {
    if (child) { child.kill('SIGTERM'); await child.exited; }
    for (const server of reservations) await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 25000);
}

test('a live child crash holds edge requests until the same release restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remi-slot-restart-'));
  const reservations = [0, 1].map(() => Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') }));
  const ports = reservations.map(server => server.port!);
  const edge = startEdge({ hostname: '127.0.0.1', port: 0, holdMaxMs: 5000, log: () => {} });
  for (const server of reservations) await server.stop(true);
  const controller = new SlotSupervisor(edge, async () => ({ cwd: root, executable: process.execPath,
    args: [resolve('tests/fixtures/supervisor-slot.ts')], version: 'old', env: process.env }),
    { ports, standbyWait: 2000, activateWait: 2000 });
  let request: Promise<Response> | undefined;
  try {
    await writeFile(join(root, 'behavior.json'), JSON.stringify({ name: 'old' }));
    const desired = { mode: 'run' as const, releaseId: 'old', revision: 'stable' };
    await controller.reconcile(desired);
    const pid = controller.snapshot().childPid!;
    process.kill(-pid, 'SIGKILL');
    const deadline = Date.now() + 2000;
    while (controller.snapshot().childPid && Date.now() < deadline) await Bun.sleep(10);
    expect(edge.status().held).toBe(true);
    request = fetch(`http://127.0.0.1:${edge.server.port}/`, { signal: AbortSignal.timeout(5000) });
    const started = Date.now();
    await controller.reconcile(desired);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(controller.snapshot().childPid).not.toBe(pid);
    const response = await request;
    expect(response.status).toBe(200); expect(await response.text()).toBe('old');
  } finally { await request?.catch(() => {}); await controller.stop(); await rm(root, { recursive: true, force: true }); }
}, 10000);

test('standby timeout concurrent with old live crash restores an active old slot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remi-slot-concurrent-'));
  const reservations = [0, 1].map(() => Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') }));
  const ports = reservations.map(server => server.port!);
  const edge = startEdge({ hostname: '127.0.0.1', port: 0, holdMaxMs: 5000, log: () => {} });
  for (const server of reservations) await server.stop(true);
  const controller = new SlotSupervisor(edge, async id => ({ cwd: join(root, id!), executable: process.execPath,
    args: [resolve('tests/fixtures/supervisor-slot.ts')], version: id!, env: process.env }),
    { ports, standbyWait: 700, activateWait: 1000, confirmWait: 100 });
  let probing = true, failures = 0, count = 0;
  let probe: Promise<void> | undefined;
  try {
    for (const id of ['old', 'new']) {
      await mkdir(join(root, id));
      await writeFile(join(root, id, 'behavior.json'), JSON.stringify({ name: id, neverStandby: id === 'new' }));
    }
    await controller.reconcile({ mode: 'run', releaseId: 'old', revision: 'stable' });
    const oldPid = controller.snapshot().childPid!;
    const changing = controller.reconcile({ mode: 'run', releaseId: 'new', revision: 'candidate', strategy: 'switch' });
    await Bun.sleep(100);
    process.kill(-oldPid, 'SIGKILL');
    while (controller.snapshot().childPid === oldPid) await Bun.sleep(10);
    probe = (async () => { while (probing) {
      try {
        const response = await fetch(`http://127.0.0.1:${edge.server.port}/`, { signal: AbortSignal.timeout(4500) });
        if (response.status !== 200 || await response.text() !== 'old') failures++;
      } catch { failures++; }
      count++; await Bun.sleep(10);
    } })();
    await changing;
    expect(controller.snapshot().transition!.phase).toBe('failed');
    expect(controller.snapshot().releaseId).toBe('old');
    expect(controller.snapshot().childPid).not.toBe(oldPid);
    expect(edge.status().held).toBe(false);
    // Repeating the failed desired must keep the recovered release serving.
    await controller.reconcile({ mode: 'run', releaseId: 'new', revision: 'candidate', strategy: 'switch' });
    expect((await fetch(`http://127.0.0.1:${ports[0]}/readyz`)).status).toBe(200);
    probing = false; await probe;
    expect(count).toBeGreaterThan(0); expect(failures).toBe(0);
  } finally { probing = false; await probe; await controller.stop(); await rm(root, { recursive: true, force: true }); }
}, 10000);

for (const launchFailures of [1, 5]) {
  test(`live restart handles ${launchFailures} launch exception(s) within the retry budget`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'remi-slot-launch-'));
    const reservations = [0, 1].map(() => Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') }));
    const ports = reservations.map(server => server.port!);
    const edge = startEdge({ hostname: '127.0.0.1', port: 0, holdMaxMs: 40000, log: () => {} });
    for (const server of reservations) await server.stop(true);
    let launches = 0;
    const controller = new SlotSupervisor(edge, async () => {
      launches++;
      if (launches > 1 && launches <= launchFailures + 1) throw new Error('Release is incomplete');
      return { cwd: root, executable: process.execPath, args: [resolve('tests/fixtures/supervisor-slot.ts')], version: 'old', env: process.env };
    }, { ports, standbyWait: 1000, activateWait: 1000 });
    const desired = { mode: 'run' as const, releaseId: 'old', revision: 'stable' };
    try {
      await writeFile(join(root, 'behavior.json'), JSON.stringify({ name: 'old' }));
      await controller.reconcile(desired);
      process.kill(-controller.snapshot().childPid!, 'SIGKILL');
      while (controller.snapshot().childPid) await Bun.sleep(10);
      for (let failure = 1; failure <= launchFailures; failure++) {
        if (failure === 5) await expect(controller.reconcile(desired)).rejects.toThrow('Live slot failed five consecutive restarts: Release is incomplete');
        else await expect(controller.reconcile(desired)).resolves.toBeUndefined();
        expect(edge.status().held).toBe(true);
        expect(controller.snapshot().childPid).toBeNull();
      }
      expect(launches).toBe(launchFailures + 1);
      if (launchFailures < 5) {
        await controller.reconcile(desired);
        const response = await fetch(`http://127.0.0.1:${edge.server.port}/`);
        expect(response.status).toBe(200); expect(await response.text()).toBe('old');
      }
    } finally { await controller.stop(); await rm(root, { recursive: true, force: true }); }
  }, 40000);
}
