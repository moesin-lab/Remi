import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { RootDeliveryEnvelopePayload, RootDeliveryStatusResponse, RootDeliveryTuple } from '@multiremi/contracts/root-delivery.js';
import { resolveTaskContext, ROOT_CARRIER_IMMUTABLE_ENV, ROOT_CARRIER_MODE_ENV, ROOT_DELIVERY_VERSION_ENV,
  ROOT_RECEIPT_ID_ENV, ROOT_RUN_GENERATION_ENV } from '@shared/task-context-file.js';
import { rootBusinessPayloadDigest } from '@shared/root-business-payload.js';
import { openRootDelivery } from './root-delivery-envelope.js';

type Env = Readonly<Record<string, string | undefined>>;
type MachineTarget = Pick<RootDeliveryTuple, 'runtime_id' | 'daemon_id' | 'incarnation' | 'consumer_id' | 'recipient_key_id' | 'recipient_key_fingerprint'>;

export interface InstallChallenge {
  readonly nonce: string;
  readonly receiptId: string;
  readonly attemptId: string;
  readonly deliveryVersion: number;
  readonly runGeneration: number;
  readonly launchIdentity: string;
}

const processSettings = new Set(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']);

function authenticator(raw: string, challenge: InstallChallenge): Buffer {
  const message = JSON.stringify(['remi.root.install.v1', challenge.nonce, challenge.receiptId, challenge.attemptId,
    challenge.deliveryVersion, challenge.runGeneration, challenge.launchIdentity]);
  return createHmac('sha256', raw).update(message).digest();
}

export function acknowledgeRunEnvironment(challenge: InstallChallenge, env: Env = process.env): string {
  const context = resolveTaskContext(env);
  if (!context.token || context.source !== 'root_immutable_env' || context.rootCarrier?.violation ||
      context.attemptId !== challenge.attemptId || context.rootCarrier?.receiptId !== challenge.receiptId ||
      context.rootCarrier.deliveryVersion !== challenge.deliveryVersion || context.rootCarrier.runGeneration !== challenge.runGeneration) {
    throw new Error('Root material installation failed');
  }
  return authenticator(context.token, challenge).toString('base64url');
}

export async function prepareRunInstallation(delivery: RootDeliveryEnvelopePayload, currentStatus: RootDeliveryStatusResponse,
  local: MachineTarget, privateKey: CryptoKey, launchIdentity: string, baseEnv: Env) {
  const tuple = delivery.tuple;
  const target: MachineTarget = { runtime_id: tuple.runtime_id, daemon_id: tuple.daemon_id, incarnation: tuple.incarnation,
    consumer_id: tuple.consumer_id, recipient_key_id: tuple.recipient_key_id, recipient_key_fingerprint: tuple.recipient_key_fingerprint };
  if (!isDeepStrictEqual(local, target) || !launchIdentity || currentStatus.run_state !== 'pending_start' || currentStatus.ack_state !== 'pending' ||
      delivery.run_state !== 'pending_start' || currentStatus.allowed_recovery_action !== 'replay_envelope' || !currentStatus.lease_id || !currentStatus.fence_term ||
      delivery.lease_id !== currentStatus.lease_id || delivery.fence_term !== currentStatus.fence_term || delivery.start_deadline !== currentStatus.start_deadline ||
      delivery.envelope_digest !== currentStatus.envelope_digest || rootBusinessPayloadDigest(delivery.frozen_business_payload) !== tuple.business_payload_digest) {
    throw new Error('stale_execution');
  }
  const raw = await openRootDelivery(delivery.envelope, tuple, currentStatus, privateKey);
  const challenge: InstallChallenge = Object.freeze({ nonce: randomBytes(32).toString('base64url'), receiptId: tuple.receipt_id,
    attemptId: tuple.attempt_id, deliveryVersion: tuple.delivery_version, runGeneration: tuple.run_generation, launchIdentity });
  const expected = authenticator(raw, challenge);
  const clean = Object.fromEntries(Object.entries(baseEnv).filter(([key, value]) => processSettings.has(key.toUpperCase()) && typeof value === 'string'));
  const turnId = delivery.frozen_business_payload.turn_id;
  if (typeof turnId !== 'string' || !turnId) throw new Error('receipt_conflict');
  const env = Object.freeze({ ...clean, [ROOT_CARRIER_MODE_ENV]: ROOT_CARRIER_IMMUTABLE_ENV, [ROOT_RECEIPT_ID_ENV]: tuple.receipt_id,
    [ROOT_RUN_GENERATION_ENV]: String(tuple.run_generation), [ROOT_DELIVERY_VERSION_ENV]: String(tuple.delivery_version),
    MULTIREMI_TOKEN: raw, MULTIREMI_ATTEMPT_ID: tuple.attempt_id, MULTIREMI_TURN_ID: turnId });
  let consumed = false;
  return { env, challenge, verify(reply: string) {
    if (consumed || typeof reply !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(reply) ||
        !timingSafeEqual(Buffer.from(reply, 'base64url'), expected) || !(Date.parse(tuple.material_expires_at) > Date.now()) ||
        !(Date.parse(currentStatus.start_deadline ?? '') > Date.now())) throw new Error('Root material installation failed');
    consumed = true;
    expected.fill(0);
  } };
}
