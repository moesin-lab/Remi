import { fork } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { birth, readFrame, runPaths } from './root-run-supervisor.mjs';
import { RootRunController } from './root-run-controller.mjs';
import { rootRunHost } from './root-run-relay.mjs';

process.umask(0o077);
const config = JSON.parse(process.argv[2]);
const { directory, tuple, lease, term, daemonUid, keyServiceUid, daemonGid, keyServiceGid } = config;
const paths = runPaths(directory, tuple);
const host = rootRunHost(config);
async function authorize(request) {
  const status = await host.readStatus(tuple);
  if (!status.ok || !status.committed || !isDeepStrictEqual(status.tuple, tuple) || !request.lease || !request.term ||
      request.lease !== status.lease_id || request.term !== status.fence_term || !(Date.parse(tuple.material_expires_at) > Date.now()) ||
      !(status.run_state === 'pending_start' && Date.parse(status.start_deadline) > Date.now() &&
        ['replay_envelope', 'send_install_ack', 'start_execution'].includes(status.allowed_recovery_action) ||
        status.run_state === 'running' && status.allowed_recovery_action === 'reattach_running' && status.ack_state === 'confirmed')) throw Error();
  return status;
}
const initialStatus = await authorize({ lease, term });
if (initialStatus.allowed_recovery_action !== 'replay_envelope' || initialStatus.ack_state !== 'pending') throw Error();
await host.planRun(tuple, initialStatus);
const signing = generateKeyPairSync('ed25519');
const execution = randomUUID();
const locator = { execution_id: execution, launch_identity: randomUUID(), carrier_mode: 'immutable_run_env',
  runtime_id: tuple.runtime_id, daemon_id: tuple.daemon_id, incarnation: tuple.incarnation, birth_token_id: null, started_at: null };
let receiver, target, installed, launch;
const controller = new RootRunController();
async function command(message) {
  const id = randomUUID();
  const response = once(receiver, 'message', { signal: AbortSignal.timeout(15000) });
  receiver.send({ ...message, id });
  try {
    const [reply] = await response;
    if (reply.id !== id) throw Error();
    if (reply.failed) throw Error();
    return reply;
  } catch (error) {
    receiver.kill();
    throw error;
  }
}
async function probe() {
  if (birth(receiver.pid) !== target.birth) throw Error();
  const nonce = randomUUID();
  if ((await command({ op: 'probe', nonce })).nonce !== nonce) throw Error();
}
function requireReceiverUid(pid, uid) {
  const ids = readFileSync(`/proc/${pid}/status`, 'utf8').match(/^Uid:\s+(.+)$/m)?.[1].trim().split(/\s+/);
  if (ids?.length !== 4 || ids.some(value => Number(value) !== uid)) throw Error();
}
async function park(status) {
  const plan = await host.planRun(tuple, status);
  if (plan.identities.some(({ uid, gid }) => [daemonUid, keyServiceUid].includes(uid) || [daemonGid, keyServiceGid].includes(gid))) throw Error();
  const identity = reserveIdentity(plan.identities);
  launch = { uid: identity.uid, gid: identity.gid, file: plan.file, args: plan.args, cwd: plan.cwd, sha256: plan.sha256 };
  receiver = fork(fileURLToPath(new URL('./root-run-receiver.mjs', import.meta.url)), [String(identity.uid), String(identity.gid)],
    { execArgv: [], cwd: '/', env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  receiver.once('exit', () => process.exit());
  const [hello] = await once(receiver, 'message', { signal: AbortSignal.timeout(15000) });
  requireReceiverUid(receiver.pid, identity.uid);
  const receiverBirth = birth(receiver.pid);
  locator.birth_token_id = `${receiverBirth}:${randomUUID()}`;
  target = { tuple, locator, pid: receiver.pid, birth: receiverBirth, uid: identity.uid, publicKey: hello.publicKey };
}
function reserveIdentity(pool) {
  for (const identity of pool) {
    const uidPath = join(directory, `uid-${identity.uid}`);
    try { closeSync(openSync(uidPath, 'wx', 0o600)); }
    catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    try { closeSync(openSync(join(directory, `gid-${identity.gid}`), 'wx', 0o600)); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      unlinkSync(uidPath);
      continue;
    }
    const dir = openSync(directory, 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
    return identity;
  }
  throw Error('registered execution identities exhausted');
}
async function handle(request) {
  if (!isDeepStrictEqual(request.tuple, tuple)) throw Error();
  controller.check(request);
  const status = await authorize(request);
  if (request.op === 'install') {
    if (!target) {
      if (receiver || status.allowed_recovery_action !== 'replay_envelope' || status.ack_state !== 'pending') throw Error();
      await park(status);
    }
    await probe();
    if (!installed) {
      const fresh = await authorize(request);
      if (fresh.allowed_recovery_action !== 'replay_envelope') throw Error();
      const sealed = await host.sealInstallation(target, fresh);
      if ((await authorize(request)).allowed_recovery_action !== 'replay_envelope') throw Error();
      const { proof } = await command({ op: 'install', target, envelope: sealed.envelope });
      if (typeof proof !== 'string' || await host.verifyInstallation(target, sealed, proof) !== true) throw Error();
      await authorize(request);
      installed = true;
    }
    return locator;
  }
  if (!installed || !isDeepStrictEqual(request.locator, locator)) throw Error();
  await probe();
  if (request.op === 'attach') {
    await authorize(request);
    return controller.attach(request);
  }
  if (request.op !== 'start') throw Error();
  const fresh = await authorize(request);
  if (fresh.run_state !== 'running' || fresh.ack_state !== 'confirmed') throw Error();
  return controller.startOnce(request, async () => {
    const { identities, file, args, cwd, sha256 } = await host.planRun(tuple, fresh);
    if (!identities.some(({ uid, gid }) => launch.uid === uid && launch.gid === gid) || file !== launch.file ||
        cwd !== launch.cwd || sha256 !== launch.sha256 || !isDeepStrictEqual(args, launch.args)) throw Error();
    if ((await authorize(request)).run_state !== 'running') throw Error();
    const reply = await command({ op: 'start', launch });
    if (reply.started !== true) throw Error();
    return new Date().toISOString();
  });
}
const server = createServer(socket => {
  readFrame(socket).then(request => {
    const answer = async () => {
      let body;
      try {
        let value;
        if (request.op === 'attest') {
          const fresh = await authorize(request);
          if (fresh.run_state !== 'pending_start' || fresh.ack_state !== 'pending' || fresh.allowed_recovery_action !== 'replay_envelope' ||
              !target || !isDeepStrictEqual(tuple, request.tuple) || !receiver.connected || birth(receiver.pid) !== target.birth) throw Error();
          requireReceiverUid(receiver.pid, target.uid);
          value = target;
        } else value = await handle(request);
        body = { ok: true, value, nonce: request.nonce };
      }
      catch { body = { ok: false, nonce: request.nonce }; }
      const signature = sign(null, Buffer.from(JSON.stringify(body)), signing.privateKey).toString('base64url');
      socket.end(JSON.stringify({ body, signature }) + '\n');
    };
    return controller.dispatch(request.op, answer);
  }).catch(() => socket.destroy());
});
// Listen before publishing so even a competing daemon can attach immediately.
const endpoint = join(directory, execution + '.sock');
if (Buffer.byteLength(endpoint) > 107) throw Error('supervisor socket path too long');
server.listen(endpoint);
await once(server, 'listening');
const record = { tuple, pid: process.pid, birth: birth(process.pid), execution, endpoint,
  publicKey: signing.publicKey.export({ type: 'spki', format: 'pem' }) };
const temp = join(directory, execution + '.tmp');
const fd = openSync(temp, 'wx', 0o600);
try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
try { linkSync(temp, paths.journal); } catch (error) {
  if (error.code !== 'EEXIST') throw error;
  unlinkSync(temp);
  await new Promise(resolve => server.close(resolve));
  process.exit(2);
}
if (server.listening) {
  unlinkSync(temp);
  const dir = openSync(directory, 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
  process.stdout.on('error', () => {});
  process.stdout.end('ready\n');
}
