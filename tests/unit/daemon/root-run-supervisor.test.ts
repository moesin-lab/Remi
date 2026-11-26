import { expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { CompactEncrypt, importJWK } from 'jose';
import { chownSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RootDeliveryTuple } from '@multiremi/contracts/root-delivery.js';
import { birth, RootRunSupervisor } from '../../../packages/daemon/src/agent-runtime/root-run-supervisor.mjs';
import { RootRunController } from '../../../packages/daemon/src/agent-runtime/root-run-controller.mjs';
import { verifyRootRunTarget } from '../../../packages/daemon/src/agent-runtime/root-run-endpoint.mjs';

test('key-service attestation can return while installation owns the control queue', async () => {
  const controller = new RootRunController();
  const entered = Promise.withResolvers<void>();
  const verified = Promise.withResolvers<void>();
  const events: string[] = [];
  const install = controller.dispatch('install', async () => {
    entered.resolve();
    await verified.promise;
    events.push('installed');
  });
  await entered.promise;
  const attach = controller.dispatch('attach', async () => { events.push('attached'); });
  await controller.dispatch('attest', async () => { events.push('attested'); verified.resolve(); });
  await Promise.all([install, attach]);
  expect(events).toEqual(['attested', 'installed', 'attached']);
});

test('key service refuses a receiver key served from a caller-owned writable directory', async () => {
  const directory = mkdtempSync('/tmp/m185-proof-');
  try {
    const { chmodSync } = await import('node:fs');
    chmodSync(directory, 0o777);
    const target = { tuple: {}, publicKey: {} } as Parameters<typeof verifyRootRunTarget>[1];
    const status = { lease_id: 'lease', fence_term: 'term' } as Parameters<typeof verifyRootRunTarget>[2];
    await expect(verifyRootRunTarget({ endpoint: join(directory, 'target.sock'), supervisorUid: 0 }, target, status))
      .rejects.toThrow('untrusted supervisor directory');
  } finally { rmSync(directory, { recursive: true }); }
});

test('parked carrier accepts only its bound ciphertext and releases one model with immutable env', async () => {
  const node = execFileSync('which', ['node'], { encoding: 'utf8' }).trim();
  const carrier = new URL('../../../packages/daemon/src/agent-runtime/root-run-carrier.mjs', import.meta.url).href;
  const receiver = spawn(node, ['--input-type=module', '-e', `import {serveParkedReceiver} from ${JSON.stringify(carrier)};serveParkedReceiver()`],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env: {} });
  const ready = createServer();
  try {
    const hello = once(receiver, 'message');
    ready.listen(0, '127.0.0.1');
    await once(ready, 'listening');
    const [{ publicKey }] = await hello;
    const tuple = { receipt_id: 'r', attempt_id: 'a', run_generation: 1, delivery_version: 2 };
    const locator = { launch_identity: 'launch', birth_token_id: 'birth' };
    const target = { tuple, locator, publicKey, birth: birth(receiver.pid!), pid: receiver.pid, uid: process.getuid!() };
    const nonce = 'challenge';
    const raw = 'synthetic-carrier-test';
    const envelope = await new CompactEncrypt(Buffer.from(JSON.stringify({ target, nonce, raw, turnId: 't' })))
      .setProtectedHeader({ alg: 'RSA-OAEP-256', enc: 'A256GCM', kid: locator.birth_token_id }).encrypt(await importJWK(publicKey, 'RSA-OAEP-256'));
    async function command(fields: Record<string, unknown>) {
      const answer = once(receiver, 'message');
      receiver.send({ id: 'rpc', ...fields });
      return (await answer)[0];
    }
    expect((await command({ op: 'install', target: { ...target, pid: process.pid }, envelope })).failed).toBe(true);
    const proof = createHmac('sha256', raw).update(JSON.stringify(['remi.root.install.v1', nonce, 'r', 'a', 2, 1, 'launch'])).digest('base64url');
    expect((await command({ op: 'install', target, envelope })).proof).toBe(proof);
    expect((await command({ op: 'install', target, envelope })).proof).toBe(proof);
    const port = (ready.address() as { port: number }).port;
    const connected = once(ready, 'connection');
    const launch = { file: node, args: ['-e', `require('net').connect(${port},'127.0.0.1',function(){this.end(JSON.stringify(process.env))});setInterval(()=>{},60000)`], cwd: '/' };
    expect((await command({ op: 'start', launch })).started).toBe(true);
    const [socket] = await connected;
    const [data] = await once(socket, 'data');
    expect(JSON.parse(data.toString())).toMatchObject({ MULTIREMI_TOKEN: raw, MULTIREMI_ATTEMPT_ID: 'a', MULTIREMI_ROOT_CARRIER: 'immutable_run_env' });
    socket.destroy();
    expect((await command({ op: 'start', launch })).failed).toBe(true);
  } finally {
    const exited = once(receiver, 'exit');
    receiver.disconnect();
    await exited;
    ready.close();
  }
}, 15000);

test('controller exit and live takeover fence stale generations and share one start result', async () => {
  const gate = new RootRunController();
  const first = spawn('cat', [], { stdio: ['pipe', 'ignore', 'ignore'] });
  const old = { controller: 'old', lease: 'a', term: 'one', pid: first.pid!, birth: birth(first.pid!) };
  const generation = gate.attach(old);
  const next = { ...old, controller: 'next', pid: process.pid, birth: birth(process.pid) };
  try { expect(() => gate.attach(next)).toThrow(); }
  finally { const exited = once(first, 'exit'); first.stdin.end(); await exited; }
  const current = { ...next, generation: gate.attach(next) };
  const replacement = { ...next, term: 'two', controller: 'replacement' };
  const latest = { ...replacement, generation: gate.attach(replacement) };
  let starts = 0;
  const launch = () => ++starts;
  expect(() => gate.startOnce({ ...old, generation }, launch)).toThrow();
  expect(() => gate.startOnce(current, launch)).toThrow();
  expect(() => gate.attach({ ...next, term: 'two' })).toThrow();
  expect(() => gate.attach({ ...replacement, birth: 'recycled' })).toThrow();
  expect(await Promise.all([gate.startOnce(latest, launch), gate.startOnce(latest, launch)])).toEqual([1, 1]);
  expect(starts).toBe(1);
});

const uid = 61963;
function mapped(path: string) {
  return readFileSync(path, 'utf8').trim().split('\n').some(line => {
    const [base, , count] = line.trim().split(/\s+/).map(Number);
    return uid >= base && uid < base + count;
  });
}
const isolated = process.platform === 'linux' && process.getuid?.() === 0 && mapped('/proc/self/uid_map') &&
  mapped('/proc/self/gid_map') && readFileSync('/proc/self/setgroups', 'utf8').trim() === 'allow';
test(isolated ? 'detached parked receiver survives controller exit and starts one isolated model' :
  'detached supervisor refuses installation when host cannot allocate an isolated UID', async () => {
  const directory = mkdtempSync('/tmp/m185-run-');
  const cwd = mkdtempSync('/tmp/m185-agent-');
  const node = execFileSync('which', ['node'], { encoding: 'utf8' }).trim();
  const config = { directory, node, hostModule: fileURLToPath(new URL('./root-run-supervisor-host.mjs', import.meta.url)) };
  const tuple = { receipt_id: 'receipt', attempt_id: 'attempt', run_generation: 1, runtime_id: 'runtime', daemon_id: 'daemon',
    incarnation: 'incarnation', delivery_version: 2, material_version: 3, material_expires_at: new Date(Date.now() + 120000).toISOString() } as RootDeliveryTuple;
  const status = { ok: true, committed: true, tuple, lease_id: 'lease', fence_term: 'one', ack_state: 'pending',
    start_deadline: tuple.material_expires_at, run_state: 'pending_start', allowed_recovery_action: 'replay_envelope' };
  const save = () => writeFileSync(join(directory, 'authority'), JSON.stringify(status));
  if (isolated) chownSync(cwd, uid, uid);
  const ready = createServer();
  ready.listen(0, '127.0.0.1');
  await once(ready, 'listening');
  const port = (ready.address() as { port: number }).port;
  const model = `import os,json,socket,signal;open('starts','a').write(json.dumps([os.getuid(),os.environ['MULTIREMI_TOKEN'],os.path.exists(${JSON.stringify(join(directory, 'authority'))})])+'\\n');s=socket.create_connection(('127.0.0.1',${port}));signal.pause()`;
  writeFileSync(join(directory, 'plan'), JSON.stringify({ uid, gid: uid, file: '/usr/bin/python3', args: ['-c', model], cwd }));
  save();
  try {
    if (!isolated) {
      const controller = new RootRunSupervisor(config);
      await expect(controller.ensureInstalled(tuple, 'lease', 'one')).rejects.toThrow();
      expect(readdirSync(directory).filter(name => name.endsWith('.json'))).toHaveLength(1);
      expect(existsSync(join(directory, `uid-${uid}`))).toBe(true);
      expect(existsSync(join(directory, 'target'))).toBe(false);
      await expect(controller.ensureInstalled(tuple, 'lease', 'one')).rejects.toThrow();
      expect(existsSync(join(cwd, 'starts'))).toBe(false);
      return;
    }
    const module = new URL('../../../packages/daemon/src/agent-runtime/root-run-supervisor.mjs', import.meta.url).href;
    const code = `import {RootRunSupervisor} from ${JSON.stringify(module)};const client=new RootRunSupervisor(${JSON.stringify(config)});const tuple=${JSON.stringify(tuple)};const loc=await client.ensureInstalled(tuple,'lease','one'); await client.attach(tuple,loc,'lease','one'); console.log(JSON.stringify(loc));`;
    const first = spawn(node, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    first.stdout.on('data', data => { output += data; });
    expect((await once(first, 'exit'))[0]).toBe(0);
    const locator = JSON.parse(output);
    expect(locator.started_at).toBeNull();
    const client = new RootRunSupervisor(config);
    expect(await client.ensureInstalled(tuple, 'lease', 'one')).toEqual(locator);
    const handle = await client.attach(tuple, locator, 'lease', 'one');
    await expect(client.startOnce(handle)).rejects.toThrow();
    const next = new RootRunSupervisor(config);
    await expect(next.attach(tuple, locator, 'lease', 'one')).rejects.toThrow();
    Object.assign(status, { fence_term: 'two', run_state: 'running', ack_state: 'confirmed', allowed_recovery_action: 'reattach_running', start_deadline: new Date(0).toISOString() });
    save();
    await expect(next.attach(tuple, { ...locator, birth_token_id: 'reused' }, 'lease', 'two')).rejects.toThrow();
    const current = await next.attach(tuple, locator, 'lease', 'two');
    await expect(client.startOnce(handle)).rejects.toThrow();
    await expect(client.attach(tuple, locator, 'lease', 'two')).rejects.toThrow();
    const connected = once(ready, 'connection');
    const times = await Promise.all([next.startOnce(current), next.startOnce(current)]);
    expect(times[0]).toBe(times[1]);
    (await connected)[0].destroy();
    expect(readFileSync(join(cwd, 'starts'), 'utf8').trim().split('\n').map(line => JSON.parse(line))).toEqual([[uid, 'test-only-material', false]]);
    status.run_state = 'revoked'; save();
    await expect(next.startOnce(current)).rejects.toThrow();
    await expect(next.ensureInstalled(tuple, 'lease', 'two')).rejects.toThrow();
    const path = join(directory, readdirSync(directory).find(name => name.endsWith('.json'))!);
    const journal = readFileSync(path, 'utf8');
    expect(journal).not.toContain('test-only-material');
    writeFileSync(path, JSON.stringify({ ...JSON.parse(journal), birth: 'reused-pid' }));
    try { await expect(next.startOnce(current)).rejects.toThrow('birth mismatch'); }
    finally { writeFileSync(path, journal); }
  } finally {
    for (const name of readdirSync(directory).filter(name => name.endsWith('.json'))) {
      const record = JSON.parse(readFileSync(join(directory, name),'utf8'));
      try { if (birth(record.pid) === record.birth) process.kill(record.pid); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    ready.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30000);
