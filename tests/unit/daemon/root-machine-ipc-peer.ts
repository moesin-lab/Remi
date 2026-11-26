import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, publicEncrypt, randomBytes, randomUUID, verify } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RootMachineClient } from '../../../packages/daemon/src/agent-runtime/root-machine-client';
import { challengeEncryptionLabel, machineSignaturePayload, type MachinePublicBinding } from '../../../packages/shared/src/machine-challenge';

const [role, directory, service, daemon, execution] = process.argv.slice(2);
const keys = join(directory, 'keys');
const reference = join(directory, 'public.json');
const files = ['binding.json', 'recipient.pem', 'signing.pem'];

function provision() {
  const recipient = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const signing = generateKeyPairSync('ed25519');
  const identity = {
    deploymentId: 'test-deployment', runtimeId: 'test-runtime', daemonId: 'test-daemon',
    incarnation: 'test-incarnation', consumerId: 'test-consumer', credentialId: 'test-credential',
    credentialDigest: 'a'.repeat(64), recipientKeyId: 'test-key', keyExpiresAtMs: Date.now() + 300_000,
  };
  mkdirSync(keys, { mode: 0o700 });
  const privateFile = { mode: 0o600, flag: 'wx' };
  writeFileSync(join(keys, 'binding.json'), JSON.stringify({ identity, daemonUid: Number(daemon), executionUid: Number(execution) }), privateFile);
  writeFileSync(join(keys, 'recipient.pem'), recipient.privateKey.export({ type: 'pkcs8', format: 'pem' }), privateFile);
  writeFileSync(join(keys, 'signing.pem'), signing.privateKey.export({ type: 'pkcs8', format: 'pem' }), privateFile);
  writeFileSync(reference, JSON.stringify({ ...identity,
    recipientSpki: recipient.publicKey.export({ type: 'spki', format: 'pem' }),
    signingSpki: signing.publicKey.export({ type: 'spki', format: 'pem' }),
  }), { mode: 0o644, flag: 'wx' });
}

async function exercise(authorized: boolean) {
  const client = new RootMachineClient(directory, Number(service));
  const expected: MachinePublicBinding = JSON.parse(readFileSync(reference, 'utf8'));
  const nonce = randomBytes(32);
  const header = { id: randomUUID(), binding: 'b'.repeat(64), purpose: 'delivery.receipt.status', targetId: 'test-receipt', expiresAtMs: Date.now() + 60_000 };
  const encrypted = publicEncrypt({ key: expected.recipientSpki, oaepHash: 'sha256', oaepLabel: challengeEncryptionLabel(header) }, nonce);
  const challenge = { ...header, encryptedNonce: encrypted.toString('base64url') };
  if (!authorized) {
    for (const name of files) {
      assert.throws(() => readFileSync(join(keys, name)), { code: 'EACCES' });
      console.log(`execution: ${name} read denied (EACCES)`);
    }
  }
  async function binding() {
    if (authorized) assert.deepEqual(await client.publicBinding(), expected);
    else await assert.rejects(client.publicBinding(), { message: 'Machine operation denied' });
  }
  async function answer() {
    if (!authorized) {
      await assert.rejects(client.answerChallenge(challenge), { message: 'Machine operation denied' });
      return;
    }
    const proof = await client.answerChallenge(challenge);
    const spki = createPublicKey(expected.recipientSpki).export({ type: 'spki', format: 'der' });
    assert.deepEqual(proof, {
      consumer_id: expected.consumerId, runtime_id: expected.runtimeId, daemon_id: expected.daemonId,
      incarnation: expected.incarnation, recipient_key_id: expected.recipientKeyId,
      recipient_key_fingerprint: `sha256:${createHash('sha256').update(spki).digest('hex')}`,
      nonce: nonce.toString('base64url'), signed_at: proof.signed_at, signature: proof.signature,
    });
    assert.ok(verify(null, machineSignaturePayload(challenge, proof.nonce, proof.signed_at),
      expected.signingSpki, Buffer.from(proof.signature, 'base64url')));
  }
  const failures: unknown[] = [];
  for (const operation of [binding, answer]) {
    try {
      await operation();
      console.log(`${role}: ${operation.name} passed`);
    } catch (error) {
      console.error(`${role}: ${operation.name} failed`, error);
      failures.push(error);
    }
  }
  assert.equal(failures.length, 0, `${role} IPC failures`);
}

switch (role) {
  case 'service': provision(); break;
  case 'daemon': await exercise(true); break;
  case 'execution': await exercise(false); break;
  default: throw new Error('Unknown fixture role');
}
