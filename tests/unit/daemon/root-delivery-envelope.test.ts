import { beforeAll, expect, test } from 'bun:test';
import { compactDecrypt, CompactEncrypt } from 'jose';
import { createHash } from 'node:crypto';
import { sealRootDelivery, openRootDelivery, recipientFingerprint } from '../../../packages/server/src/worker/root-delivery-envelope.js';
import type { RootDeliveryTuple } from '@multiremi/contracts/root-delivery.js';
import { fixtureDeliveryTuple, fixtureDeliveryStatusResponse } from '../../fixtures/root-authority.js';

let tuple: RootDeliveryTuple;
const createKeys = (modulusLength: number) => crypto.subtle.generateKey({ name: 'RSA-OAEP', hash: 'SHA-256',
  modulusLength, publicExponent: new Uint8Array([1, 0, 1]) }, false, ['encrypt', 'decrypt']);
let keys: CryptoKeyPair;
let sealed: Awaited<ReturnType<typeof sealRootDelivery>>;
const status = () => ({ ...fixtureDeliveryStatusResponse, tuple, envelope_digest: sealed.envelope_digest, start_deadline: tuple.material_expires_at });

beforeAll(async () => {
  keys = await createKeys(3072);
  tuple = { ...fixtureDeliveryTuple, recipient_key_fingerprint: recipientFingerprint(keys.publicKey), material_expires_at: new Date(Date.now() + 600_000).toISOString() };
  sealed = await sealRootDelivery(tuple, 'test-material', keys.publicKey);
});

test('requires the committed ciphertext and matching execution before opening the material', async () => {
  expect(await openRootDelivery(sealed.envelope, tuple, status(), keys.privateKey)).toBe('test-material');
  const substitution = await sealRootDelivery(tuple, 'different-test-material', keys.publicKey);
  await expect(openRootDelivery(substitution.envelope, tuple, status(), keys.privateKey)).rejects.toThrow();
  const moved = { ...tuple, incarnation: 'replacement' };
  await expect(openRootDelivery(sealed.envelope, moved, { ...status(), tuple: moved }, keys.privateKey)).rejects.toThrow();
  await expect(openRootDelivery(sealed.envelope, tuple, { ...status(), committed: false }, keys.privateKey)).rejects.toThrow();
  await expect(openRootDelivery(sealed.envelope, tuple, { ...status(), start_deadline: null }, keys.privateKey)).rejects.toThrow();
});

test('rejects tampering, unrecognized protected fields and mismatched plaintext binding even with the ciphertext digest', async () => {
  const original = await compactDecrypt(sealed.envelope, keys.privateKey);
  const pieces = sealed.envelope.split('.');
  pieces[4] = (pieces[4]!.startsWith('A') ? 'B' : 'A') + pieces[4]!.slice(1);
  const ciphertexts = [pieces.join('.'),
    await new CompactEncrypt(original.plaintext).setProtectedHeader({ ...original.protectedHeader, extra: true }).encrypt(keys.publicKey),
    await new CompactEncrypt(new TextEncoder().encode(JSON.stringify({ raw: 'other', tuple: { ...tuple, delivery_version: 2 } })))
      .setProtectedHeader(original.protectedHeader).encrypt(keys.publicKey)];
  for (const ciphertext of ciphertexts) {
    const envelope_digest = `sha256:${createHash('sha256').update(ciphertext).digest('hex')}`;
    await expect(openRootDelivery(ciphertext, tuple, { ...status(), envelope_digest }, keys.privateKey)).rejects.toThrow();
  }
});

test('rejects weak and incorrect recipient keys', async () => {
  const weak = await createKeys(2048);
  await expect(sealRootDelivery(tuple, 'test-material', weak.publicKey)).rejects.toThrow();
  const other = await createKeys(3072);
  await expect(sealRootDelivery(tuple, 'test-material', other.publicKey)).rejects.toThrow();
  await expect(openRootDelivery(sealed.envelope, tuple, status(), other.privateKey)).rejects.toThrow();
});
