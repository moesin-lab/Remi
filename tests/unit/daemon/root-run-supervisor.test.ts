import { expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { CompactEncrypt, importJWK } from 'jose';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { birth } from '../../../packages/daemon/src/agent-runtime/root-run-supervisor.mjs';
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

test('receiver refuses a service identity as execution UID', async () => {
  const node = execFileSync('which', ['node'], { encoding: 'utf8' }).trim();
  const receiver = fileURLToPath(new URL('../../../packages/daemon/src/agent-runtime/root-run-receiver.mjs', import.meta.url));
  const child = spawn(node, [receiver, '0', '0'], { stdio: 'ignore' });
  expect((await once(child, 'exit'))[0]).toBe(1);
});
