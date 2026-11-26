import { expect, test } from 'bun:test';
import { fork, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, chownSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RootDeliveryTuple } from '@multiremi/contracts/root-delivery.js';

test('multi-UID guest uses production supervisor, authenticated control and reentrant host relay', async () => {
  const root = mkdtempSync('/srv/run-');
  const node = '/usr/bin/node';
  const key = 1102, daemon = 1101, execution = 1103;
  const children: ChildProcess[] = [];
  const evidence: string[] = [];
  const tuple: RootDeliveryTuple = { receipt_id: 'receipt', receipt_version: 1, attempt_id: 'attempt', delivery_version: 2, material_version: 3,
    run_generation: 1, runtime_id: 'runtime', daemon_id: 'daemon', incarnation: 'incarnation', execution_digest: 'approved',
    handoff_id: null, handoff_generation: 1, consumer_id: 'consumer', recipient_key_id: 'key', recipient_key_fingerprint: 'fingerprint',
    execution_config_epoch: 1, input_revision: 1, input_digest: 'input', checkpoint_digest: null, grant_id: 'grant', grant_generation: 1,
    business_payload_digest: 'payload', material_expires_at: new Date(Date.now() + 300000).toISOString() };
  const status = { ok: true, committed: true, tuple, run_state: 'pending_start', ack_state: 'pending',
    lease_id: 'lease', fence_term: 'one', start_deadline: tuple.material_expires_at, allowed_recovery_action: 'replay_envelope' };
  const save = () => writeFileSync(join(root, 'status'), JSON.stringify(status));
  async function peer(role: string) {
    const child = fork(fileURLToPath(new URL('./root-run-supervisor-peer.mjs', import.meta.url)), [role, root],
      { execPath: node, execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'json' });
    children.push(child);
    child.on('message', (message: { evidence?: string }) => { if (message.evidence) evidence.push(message.evidence); });
    expect((await once(child, 'message'))[0]).toEqual({ ready: true, uid: role === 'key' ? key : daemon });
    console.log(`guest ${role} ready`);
    return child;
  }
  async function action(child: ChildProcess, request: Record<string, unknown>) {
    const response = once(child, 'message'); child.send({ tuple, term: status.fence_term, ...request });
    return (await response)[0];
  }
  async function socketReply(endpoint: string) {
    const socket = connect(endpoint); const [bytes] = await once(socket, 'data'); socket.destroy(); return JSON.parse(bytes.toString());
  }
  chmodSync(root, 0o755);
  for (const [name, uid, gid, mode] of [['public', 0, 0, 0o711], ['private', 0, 0, 0o700], ['daemon', daemon, daemon, 0o700],
    ['key', key, daemon, 0o2710], [`model-${execution}`, execution, execution, 0o700],
    [`model-${execution + 1}`, execution + 1, execution + 1, 0o700]] as const) {
    const directory = join(root, name); mkdirSync(directory); chownSync(directory, uid, gid); chmodSync(directory, mode);
  }
  const auth = createServer(socket => socket.once('data', data => socket.end(status.run_state === 'running' &&
    data.toString() === 'guest-only-protected-token' ? '200' : '403')));
  auth.listen(join(root, 'protected')); await once(auth, 'listening'); chmodSync(join(root, 'protected'), 0o666);
  const model = `const net=require('net'),fs=require('fs'),root=${JSON.stringify(root)},dir=root+'/model-'+process.getuid();fs.appendFileSync(dir+'/starts','1');net.createServer(s=>{const c=net.connect(root+'/protected',()=>c.write(process.env.MULTIREMI_TOKEN));c.on('data',d=>{s.end(JSON.stringify([process.getuid(),process.pid,d.toString(),fs.existsSync(root+'/daemon/host.sock')]));c.destroy()})}).listen(dir+'/api',()=>net.connect(root+'/protected').end())`;
  const binding = { grant_id: tuple.grant_id, grant_generation: tuple.grant_generation, execution_digest: tuple.execution_digest,
    execution_config_epoch: tuple.execution_config_epoch, consumer_id: tuple.consumer_id, runtime_id: tuple.runtime_id, daemon_id: tuple.daemon_id,
    incarnation: tuple.incarnation, recipient_key_id: tuple.recipient_key_id, recipient_key_fingerprint: tuple.recipient_key_fingerprint };
  const plan = { binding, identities: [execution, execution + 1].map(uid => ({ uid, gid: uid })), file: node, args: ['-e', model], cwd: '/srv',
    sha256: createHash('sha256').update(readFileSync(node)).digest('hex') };
  const config = { directory: join(root, 'private'), publicDirectory: join(root, 'public'), daemonUid: daemon, daemonGid: daemon,
    keyServiceUid: key, keyServiceGid: key, hostSocket: join(root, 'daemon/host.sock'), approvedPlansFile: join(root, 'plans') };
  const service = fileURLToPath(new URL('../../../packages/daemon/src/agent-runtime/root-run-service.mjs', import.meta.url));
  writeFileSync(join(root, 'plans'), JSON.stringify({ plans: [] }));
  writeFileSync(join(root, 'config'), JSON.stringify(config)); save();
  try {
    const denied = (path: string, reason: string) => {
      const result = spawnSync(node, [service, path], { timeout: 10000, encoding: 'utf8' });
      expect(result.status).toBe(1); expect(result.stderr).toContain(reason);
    };
    const bad = join(root, 'bad-config');
    writeFileSync(bad, JSON.stringify({ ...config, hostModule: '/tmp/override.mjs' })); denied(bad, 'host module override forbidden');
    chmodSync(bad, 0o666); denied(bad, 'untrusted supervisor path');
    writeFileSync(join(root, 'daemon/config'), JSON.stringify(config)); denied(join(root, 'daemon/config'), 'untrusted supervisor path');
    const supervisor = spawn(node, [service, join(root, 'config')], { stdio: ['ignore', 'pipe', 'inherit'] }); children.push(supervisor);
    await Promise.race([once(supervisor.stdout, 'data'), once(supervisor, 'exit').then(() => { throw Error('service exited before ready'); })]);
    console.log('guest service endpoints ready');
    await peer('key'); chownSync(join(root, 'key/seal.sock'), key, daemon);
    const relay = await peer('relay'); const first = await peer('controller');
    expect((await action(first, { op: 'spoof', pid: relay.pid })).ok).toBe(false);
    expect((await action(first, { op: 'install', file: node, args: plan.args })).ok).toBe(false);
    writeFileSync(config.approvedPlansFile, JSON.stringify({ plans: [{ ...plan, sha256: '0'.repeat(64) }] }));
    expect((await action(first, { op: 'install' })).ok).toBe(false);
    writeFileSync(config.approvedPlansFile, JSON.stringify({ plans: [plan] }));
    const approval = readFileSync(config.approvedPlansFile, 'utf8');
    for (const field of Object.keys(binding) as (keyof typeof binding)[]) {
      const changed = { ...tuple, [field]: typeof binding[field] === 'string' ? 'other' : 7, receipt_id: crypto.randomUUID() };
      status.tuple = changed; save();
      expect((await action(first, { op: 'install', tuple: changed })).ok).toBe(false);
    }
    status.tuple = tuple; save();
    writeFileSync(join(root, 'tamper'), '');
    expect((await action(first, { op: 'install' })).ok).toBe(false);
    rmSync(join(root, 'tamper'));
    const install = await action(first, { op: 'install' }); expect(install.ok).toBe(true);
    const locator = install.value; expect(locator.started_at).toBeNull();
    expect((await action(first, { op: 'install' })).value).toEqual(locator);
    const handle = (await action(first, { op: 'attach', locator })).value;
    expect((await action(first, { op: 'attach', locator: { ...locator, birth_token_id: 'wrong' } })).ok).toBe(false);
    expect((await action(first, { op: 'start', handle })).ok).toBe(false);
    Object.assign(status, { run_state: 'running', ack_state: 'confirmed', allowed_recovery_action: 'reattach_running' }); save();
    const modelReady = once(auth, 'connection');
    const start = await action(first, { op: 'start', handle }); expect(start.ok).toBe(true); await modelReady;
    const before = await socketReply(join(root, `model-${execution}/api`)); expect(before).toEqual([execution, expect.any(Number), '200', false]);
    const next = await peer('controller'); expect((await action(next, { op: 'attach', locator })).ok).toBe(false);
    status.fence_term = 'two'; save();
    const current = (await action(next, { op: 'attach', locator })).value;
    expect((await action(first, { op: 'start', handle })).ok).toBe(false);
    const exited = once(first, 'exit'); first.kill(); await exited;
    expect((await action(next, { op: 'start', handle: current })).value).toBe(start.value);
    expect(await socketReply(join(root, `model-${execution}/api`))).toEqual(before);
    status.run_state = 'revoked'; save();
    expect((await action(next, { op: 'start', handle: current })).ok).toBe(false);
    expect((await socketReply(join(root, `model-${execution}/api`)))[2]).toBe('403');
    expect(readFileSync(join(root, `model-${execution}/starts`), 'utf8')).toBe('1');
    expect(evidence).toContain('forged receiver key rejected');
    console.log(`supervisor=0 daemon=${daemon} key=${key} model=${execution} model_pid=${before[1]} requests=200,200,403 starts=1`);
    const nextTuple = { ...tuple, receipt_id: crypto.randomUUID(), attempt_id: crypto.randomUUID(), input_digest: 'next-authorized-input' };
    Object.assign(status, { tuple: nextTuple, run_state: 'pending_start', ack_state: 'pending', allowed_recovery_action: 'replay_envelope' }); save();
    expect((await action(next, { op: 'install', tuple })).ok).toBe(false);
    const second = await action(next, { op: 'install', tuple: nextTuple }); expect(second.ok).toBe(true);
    expect(second.value.execution_id).not.toBe(locator.execution_id);
    const secondHandle = (await action(next, { op: 'attach', tuple: nextTuple, locator: second.value })).value;
    Object.assign(status, { run_state: 'running', ack_state: 'confirmed', allowed_recovery_action: 'reattach_running' }); save();
    const readyAgain = once(auth, 'connection');
    expect((await action(next, { op: 'start', handle: secondHandle })).ok).toBe(true); await readyAgain;
    expect((await socketReply(join(root, `model-${execution + 1}/api`)))[0]).toBe(execution + 1);
    const third = { ...tuple, receipt_id: crypto.randomUUID(), attempt_id: crypto.randomUUID() };
    Object.assign(status, { tuple: third, run_state: 'pending_start', ack_state: 'pending', allowed_recovery_action: 'replay_envelope' }); save();
    expect((await action(next, { op: 'install', tuple: third })).ok).toBe(false);
    expect(readFileSync(config.approvedPlansFile, 'utf8')).toBe(approval);
    console.log(`registered attempts used UIDs ${execution},${execution + 1}; exhausted pool denied the third attempt`);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    for (const name of readdirSync(config.directory).filter(name => name.endsWith('.json'))) process.kill(JSON.parse(readFileSync(join(config.directory, name), 'utf8')).pid);
    auth.close(); rmSync(root, { recursive: true, force: true });
  }
}, 120000);
