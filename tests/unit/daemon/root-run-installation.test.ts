import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { sealRootDelivery } from '@multiremi/worker/root-delivery-envelope.js';
import { prepareRunInstallation } from '@multiremi/worker/root-run-installation.js';
import { rootBusinessPayloadDigest } from '@multiremi/store/root-receipts.js';
import { fixtureDeliveryActivationResponse, fixtureDeliveryTuple, fixtureDeliveryStatusResponse } from '../../fixtures/root-authority.js';

test('requires the isolated child to acknowledge the exact material installed in its environment', async () => {
  const key = await crypto.subtle.generateKey({ name: 'RSA-OAEP', hash: 'SHA-256', modulusLength: 3072,
    publicExponent: new Uint8Array([1,0,1]) }, false, ['encrypt','decrypt']);
  const business = { turn_id: 'integration-turn' };
  const tuple = { ...fixtureDeliveryTuple, material_expires_at: new Date(Date.now() + 120000).toISOString(),
    business_payload_digest: rootBusinessPayloadDigest(business) };
  const envelope = await sealRootDelivery(tuple, 'short-lived-synthetic-material', key.publicKey);
  const delivery = { ...fixtureDeliveryActivationResponse, ...envelope, tuple, frozen_business_payload: business, start_deadline: tuple.material_expires_at };
  const status = { ...fixtureDeliveryStatusResponse, tuple, envelope_digest: envelope.envelope_digest, start_deadline: delivery.start_deadline };
  const local = { runtime_id: tuple.runtime_id, daemon_id: tuple.daemon_id, incarnation: tuple.incarnation, consumer_id: tuple.consumer_id,
    recipient_key_id: tuple.recipient_key_id, recipient_key_fingerprint: tuple.recipient_key_fingerprint };
  const install = await prepareRunInstallation(delivery, status, local, key.privateKey, 'launch-test', {
    MULTIREMI_TASK_CONTEXT_FILE: '/old-task', MULTIREMI_TOKEN: 'old', MULTIREMI_DAEMON_KEY: 'synthetic-machine-secret', PATH: process.env.PATH,
  });
  expect(install.env).not.toHaveProperty('MULTIREMI_TASK_CONTEXT_FILE');
  expect(install.env).not.toHaveProperty('MULTIREMI_DAEMON_KEY');
  const modulePath = fileURLToPath(new URL('../../../packages/server/src/worker/root-run-installation.ts', import.meta.url));
  const program = `import { acknowledgeRunEnvironment } from ${JSON.stringify(modulePath)}; process.stdout.write(acknowledgeRunEnvironment(JSON.parse(await Bun.stdin.text())));`;
  const reply = (env: Record<string, string | undefined>) => {
    const proc = Bun.spawnSync([process.execPath, '-e', program], { env, stdin: Buffer.from(JSON.stringify(install.challenge)), stdout: 'pipe', stderr: 'pipe' });
    expect(proc.exitCode).toBe(0);
    return proc.stdout.toString();
  };
  expect(() => install.verify(reply({ ...install.env, MULTIREMI_TOKEN: 'wrong-fixture' }))).toThrow('installation failed');
  const receipt = reply(install.env);
  install.verify(receipt);
  expect(() => install.verify(receipt)).toThrow('installation failed');
  await expect(prepareRunInstallation({ ...delivery, frozen_business_payload: { turn_id: 'different' } }, status, local,
    key.privateKey, 'launch-test', {})).rejects.toThrow('stale_execution');
  await expect(prepareRunInstallation(delivery, { ...status, run_state: 'running' }, local, key.privateKey, 'launch-test', {})).rejects.toThrow('stale_execution');
});
