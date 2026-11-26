import { once } from 'node:events';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { CompactEncrypt, importJWK } from 'jose';
import { RootRunSupervisor, birth, readFrame } from '../../../packages/daemon/src/agent-runtime/root-run-supervisor.mjs';
import { serviceRequest, verifyRootRunTarget } from '../../../packages/daemon/src/agent-runtime/root-run-endpoint.mjs';

const [role, root] = process.argv.slice(2);
const uid = role === 'key' ? 1102 : 1101;
process.setgroups([]); process.setgid(uid); process.setuid(uid);
const config = { endpoint: `${root}/public/control.sock`, supervisorUid: 0 };
const client = new RootRunSupervisor(config);
async function listen(path, mode, handle) {
  const server = createServer(socket => {
    readFrame(socket).then(async message => {
      try { socket.end(JSON.stringify({ nonce: message.nonce, ok: true, value: await handle(message) }) + '\n'); }
      catch (error) { console.error(role, error.message); socket.end(JSON.stringify({ nonce: message.nonce, ok: false }) + '\n'); }
    }).catch(() => socket.destroy());
  });
  server.listen(path); await once(server, 'listening'); chmodSync(path, mode);
}
if (role === 'key') {
  await listen(`${root}/key/seal.sock`, 0o660, async ({ target, status }) => {
    const endpoint = { endpoint: `${root}/public/target.sock`, supervisorUid: 0 };
    const actual = await verifyRootRunTarget(endpoint, target, status);
    try { await verifyRootRunTarget(endpoint, { ...target, publicKey: {} }, status); }
    catch { process.send({ evidence: 'forged receiver key rejected' }); }
    const nonce = randomUUID();
    const raw = 'guest-only-protected-token';
    const tuple = target.tuple;
    const proof = createHmac('sha256', raw).update(JSON.stringify(['remi.root.install.v1', nonce, tuple.receipt_id, tuple.attempt_id,
      tuple.delivery_version, tuple.run_generation, target.locator.launch_identity])).digest('base64url');
    const envelope = await new CompactEncrypt(Buffer.from(JSON.stringify({ target: actual, raw, nonce, turnId: 'turn' })))
      .setProtectedHeader({ alg: 'RSA-OAEP-256', enc: 'A256GCM', kid: actual.locator.birth_token_id }).encrypt(await importJWK(actual.publicKey, 'RSA-OAEP-256'));
    return { envelope, verificationId: createHash('sha256').update(proof).digest('hex') };
  });
} else if (role === 'relay') {
  await listen(`${root}/daemon/host.sock`, 0o600, async message => {
    if (message.op === 'status') return JSON.parse(readFileSync(`${root}/status`));
    if (message.op !== 'seal') throw Error('unexpected operation');
    return new Promise((resolve, reject) => {
      const socket = process.getBuiltinModule('net').connect(`${root}/key/seal.sock`);
      readFrame(socket).then(body => {
        if (!body.ok || body.nonce !== message.nonce) return reject(Error('seal failed'));
        if (existsSync(`${root}/tamper`)) body.value.verificationId = '0'.repeat(64);
        resolve(body.value);
      }, reject).finally(() => socket.destroy());
      socket.write(JSON.stringify(message) + '\n');
    });
  });
} else {
  process.on('message', async ({ op, tuple, handle, locator, term, pid }) => {
    try {
      let value;
      if (op === 'spoof') value = await serviceRequest(config, { op: 'install', pid, birth: birth(pid), controller: 'fake', tuple, lease: 'lease', term });
      else if (op === 'install') value = await client.ensureInstalled(tuple, 'lease', term);
      else if (op === 'attach') value = await client.attach(tuple, locator, 'lease', term);
      else value = await client.startOnce(handle);
      process.send({ ok: true, value });
    } catch (error) { process.send({ ok: false, error: error.message }); }
  });
}
process.send({ ready: true, uid: process.getuid() });
