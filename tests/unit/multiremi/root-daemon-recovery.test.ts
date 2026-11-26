import { expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { startMultiremiServer } from '@multiremi/api.js';
import { DAEMON_MIN_CLI_VERSION } from '@multiremi/contracts/daemon-protocol.js';
import { DaemonProtocolClient, type DaemonProtocolLane } from '@multiremi/worker/daemon-protocol-client.js';
import { RootReceiptClient } from '@multiremi/worker/root-receipt-client.js';
import { acknowledgeRunEnvironment, prepareRunInstallation } from '@multiremi/worker/root-run-installation.js';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';
import { prepareRecoveryFixture } from './root-daemon-recovery-fixture.js';

pendingTurnBackendTests('root receipt recovery over WS and protected HTTP', fixture => {
  it('replays an interrupted installation and rejects both task copies after provider revocation', async () => {
    const { db, store } = fixture();
    const { delivery, machine, decryptionKey, human, signing, reportPolicy } = await prepareRecoveryFixture(fixture());
    const { tuple, envelope_digest: digest } = delivery;
    const { runtime_id, daemon_id, consumer_id, incarnation, recipient_key_id, recipient_key_fingerprint } = tuple;
    const target = { runtime_id, daemon_id, consumer_id, incarnation, recipient_key_id, recipient_key_fingerprint };
    const workspace = store.createWorkspace({ name: 'Recovery target', slug: 'recovery-target' });
    const server = startMultiremiServer({ store, port: 0, hostname: '127.0.0.1', authToken: 'isolated-master', backgroundJobs: false });
    const origin = `http://127.0.0.1:${server.port}`;
    const client = new DaemonProtocolClient({ serverUrl: origin, token: 'machine-token', daemonId: daemon_id,
      cliVersion: DAEMON_MIN_CLI_VERSION, caps: ['root.delivery', 'prompt.policy.adopt.v1'] });
    let confirmed: () => void;
    const lane: DaemonProtocolLane = {
      runtime: () => ({ runtime_id, provider: 'codex', max_concurrency: 1, active_task_ids: [tuple.attempt_id],
        capabilities: { root_delivery_protocol: 1, root_carrier_modes: ['immutable_run_env'] } }),
      heartbeat: () => ({ active_task_count: 1 }), onRuntimeConfirmed() { confirmed(); },
      async onHeartbeatAck() {}, async probeUpgrade() {}, async onTerminal() {},
    };
    client.addLane(lane);
    const connect = () => new Promise<void>(resolve => { confirmed = resolve; client.startLane(lane); });
    const keys = { async answerChallenge(challenge: Parameters<typeof machine.answerChallenge>[0]) { return machine.answerChallenge(challenge); } };
    const recovery = new RootReceiptClient(client, keys);
    const status = () => recovery.status(tuple, digest);
    async function write(token: string, name: string, expected: number) {
      const response = await fetch(`${origin}/api/workspaces/${workspace.id}`, { method: 'PATCH',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
      await response.text();
      expect(response.status).toBe(expected);
      if (expected === 200) expect(store.getWorkspace(workspace.id)?.name).toBe(name);
    }
    const launch = crypto.randomUUID();
    let stopPeer: (() => Promise<void>) | undefined;
    const jwtEnv = { JWT_SECRET: signing.secret, MULTIREMI_JWT_SIGNING_DOMAIN: signing.domainId, MULTIREMI_JWT_KEY_EPOCH: signing.keyEpoch };
    const prior = Object.fromEntries(Object.keys(jwtEnv).map(key => [key, process.env[key]]));
    try {
      Object.assign(process.env, jwtEnv);
      await connect();
      const pending = await status();
      const original = await prepareRunInstallation(delivery, pending, target, decryptionKey, launch, {});
      const peer = spawn(process.execPath, [fileURLToPath(new URL('./root-daemon-recovery-peer.ts', import.meta.url)),
        `${origin}/api/workspaces/${workspace.id}`], { env: original.env, stdio: ['pipe', 'pipe', 'inherit'] });
      const exited = once(peer, 'exit');
      stopPeer = async () => { peer.stdin.end(); await exited; };
      const replies = createInterface({ input: peer.stdout })[Symbol.asyncIterator]();
      async function requestPeer(command: object) {
        peer.stdin.write(JSON.stringify(command) + '\n');
        const reply = await replies.next();
        if (reply.done) throw new Error('Recovery HTTP peer exited without replying');
        return JSON.parse(reply.value);
      }
      const installed = await requestPeer({ challenge: original.challenge });
      original.verify(installed.proof);
      expect(installed.pid).toBe(peer.pid);
      const locator = { runtime_id, daemon_id, incarnation, execution_id: String(installed.pid), birth_token_id: installed.birthToken,
        launch_identity: launch, carrier_mode: 'immutable_run_env' as const, started_at: null };
      const peerWrite = async (name: string, status: number) => {
        expect(await requestPeer({ name })).toEqual({ pid: peer.pid, birthToken: locator.birth_token_id, status });
        if (status === 200) expect(store.getWorkspace(workspace.id)?.name).toBe(name);
      };
      await peerWrite('Before disconnect', 200);
      client.stopLane(lane);
      await connect();
      const resumed = await status();
      const replayed = await recovery.replay(tuple, resumed);
      expect(replayed.envelope).toBe(delivery.envelope);
      const recovered = await prepareRunInstallation(replayed, resumed, target, decryptionKey, locator.launch_identity, {});
      recovered.verify(acknowledgeRunEnvironment(recovered.challenge, recovered.env));
      const committed = Promise.withResolvers<void>();
      const releaseReply = Promise.withResolvers<void>();
      const delayed = new RootReceiptClient({ async rpc(method, payload, runtime) {
        const reply = await client.rpc(method, payload, runtime);
        if (method === 'delivery.receipt.install_ack') {
          committed.resolve();
          await releaseReply.promise;
        }
        return reply;
      } }, keys);
      const firstAck = delayed.acknowledge(tuple, digest, locator);
      await Promise.race([committed.promise, firstAck]);
      client.stopLane(lane);
      await connect();
      expect((await status()).allowed_recovery_action).toBe('start_execution');
      expect((await recovery.acknowledge(tuple, digest, locator)).idempotent_replay).toBe(true);
      releaseReply.resolve();
      expect((await firstAck).idempotent_replay).toBe(false);
      const start = async (policy?: typeof reportPolicy) => client.event({ t: 'task.start', seq: 1, rt: runtime_id, p: { ...policy, task_id: tuple.attempt_id,
        usage_run_id: consumer_id, root_receipt_id: tuple.receipt_id, execution_locator: locator, machine_proof: await recovery.proof(tuple, 'start') } });
      await expect(start()).rejects.toMatchObject({ code: 'policy_offer_mismatch' });
      expect(await start(reportPolicy)).toMatchObject({ ok: true, execution_authorized: true });
      expect(await start(reportPolicy)).toMatchObject({ ok: true, code: 'start_replayed' });
      expect(await status()).toMatchObject({ allowed_recovery_action: 'reattach_running', tuple: { material_version: tuple.material_version } });
      expect(Number(db.query('SELECT COUNT(*) AS count FROM multiremi_usage_runs WHERE task_id=?').get(tuple.attempt_id).count)).toBe(1);
      await write(recovered.env.MULTIREMI_TOKEN, 'After reconnect', 200);
      await peerWrite('Original process resumed', 200);
      db.query('UPDATE multiremi_authority_nodes SET revoked_at_ms=? WHERE node_id=?').run(Date.now(), 'provider');
      await peerWrite('Denied original', 401);
      await write(recovered.env.MULTIREMI_TOKEN, 'Denied replay', 401);
      expect(store.getWorkspace(workspace.id)?.name).toBe('Original process resumed');
      await write(human, 'Independent dashboard', 200);
    } finally {
      await stopPeer?.();
      client.stopLane(lane);
      await server.stop(true);
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }, 30_000);
});
