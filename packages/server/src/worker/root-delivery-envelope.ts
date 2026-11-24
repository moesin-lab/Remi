import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CompactEncrypt, compactDecrypt } from 'jose';
import {
  ROOT_DELIVERY_JWE_ALG, ROOT_DELIVERY_JWE_ENC, ROOT_DELIVERY_MIN_RSA_BITS, ROOT_DELIVERY_PROTOCOL_VERSION,
  type RootDeliveryTuple, type RootDeliveryStatusResponse, type RootDeliveryJweProtectedHeader,
} from '@multiremi/contracts/root-delivery.js';

const bindingFields = {
  receipt_id: true, receipt_version: true, delivery_version: true, material_version: true,
  attempt_id: true, handoff_id: true, handoff_generation: true, run_generation: true, consumer_id: true,
  runtime_id: true, daemon_id: true, incarnation: true, recipient_key_id: true, recipient_key_fingerprint: true,
  execution_config_epoch: true, execution_digest: true, input_revision: true, input_digest: true,
  checkpoint_digest: true, grant_id: true, grant_generation: true, material_expires_at: true, business_payload_digest: true,
} satisfies Record<keyof RootDeliveryTuple, true>;

function reject(): never { throw new Error('Invalid root delivery envelope'); }

export function serializeRootDeliveryTuple(tuple: RootDeliveryTuple): string {
  if (Object.keys(tuple).length !== Object.keys(bindingFields).length ||
      Object.keys(bindingFields).some(field => !Object.hasOwn(tuple, field))) reject();
  const fields = Object.keys(bindingFields) as (keyof RootDeliveryTuple)[];
  for (const field of fields) {
    const value = tuple[field];
    if (value === null && ['handoff_id', 'checkpoint_digest', 'grant_id', 'grant_generation'].includes(field)) continue;
    if (/_(version|generation|revision|epoch)$/.test(field)) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) reject();
    } else if (typeof value !== 'string' || !value || value.length > 512) reject();
  }
  return JSON.stringify(Object.fromEntries(fields.map(field => [field, tuple[field]])));
}

function header(tuple: RootDeliveryTuple): RootDeliveryJweProtectedHeader {
  serializeRootDeliveryTuple(tuple);
  const { recipient_key_id, ...binding } = tuple;
  return { ...binding, kid: recipient_key_id, v: ROOT_DELIVERY_PROTOCOL_VERSION, alg: ROOT_DELIVERY_JWE_ALG, enc: ROOT_DELIVERY_JWE_ENC };
}

function checkKey(key: CryptoKey, type: 'private' | 'public'): void {
  const algorithm = key.algorithm as RsaHashedKeyAlgorithm;
  if (key.type !== type || algorithm.name !== 'RSA-OAEP' || algorithm.hash.name !== 'SHA-256' ||
      !(algorithm.modulusLength >= ROOT_DELIVERY_MIN_RSA_BITS)) reject();
}

function digest(envelope: string): string { return `sha256:${createHash('sha256').update(envelope).digest('hex')}`; }

export async function sealRootDelivery(tuple: RootDeliveryTuple, raw: string, publicKey: CryptoKey) {
  checkKey(publicKey, 'public');
  if (!raw || !(Date.parse(tuple.material_expires_at) > Date.now())) reject();
  const protectedHeader = header(tuple);
  const bytes = new TextEncoder().encode(JSON.stringify({ tuple, raw }));
  try {
    const envelope = await new CompactEncrypt(bytes).setProtectedHeader({ ...protectedHeader }).encrypt(publicKey);
    return { envelope, envelope_digest: digest(envelope) };
  } finally { bytes.fill(0); }
}

export async function openRootDelivery(envelope: string, expected: RootDeliveryTuple,
  authenticatedStatus: RootDeliveryStatusResponse, privateKey: CryptoKey): Promise<string> {
  checkKey(privateKey, 'private');
  const status = authenticatedStatus;
  if (!status.ok || !status.committed || !isDeepStrictEqual(status.tuple, expected) ||
      status.envelope_digest !== digest(envelope) || !['pending_start', 'running'].includes(status.run_state) ||
      !['replay_envelope', 'send_install_ack', 'start_execution', 'reattach_running'].includes(status.allowed_recovery_action) ||
      (status.run_state === 'pending_start' && !(Date.parse(status.start_deadline ?? '') > Date.now())) ||
      !(Date.parse(expected.material_expires_at) > Date.now())) reject();
  const expectedHeader = header(expected);
  const { plaintext, protectedHeader } = await compactDecrypt(envelope, privateKey, {
    keyManagementAlgorithms: [ROOT_DELIVERY_JWE_ALG], contentEncryptionAlgorithms: [ROOT_DELIVERY_JWE_ENC],
  }).catch(reject);
  try {
    if (!isDeepStrictEqual(protectedHeader, expectedHeader)) reject();
    const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
    if (!decoded || typeof decoded.raw !== 'string' || !decoded.raw ||
        !isDeepStrictEqual(decoded, { tuple: expected, raw: decoded.raw })) reject();
    return decoded.raw;
  } catch { return reject(); } finally { plaintext.fill(0); }
}
