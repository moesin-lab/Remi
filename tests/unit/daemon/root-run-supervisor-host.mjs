import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { CompactEncrypt, importJWK } from 'jose';
import { RootRunSupervisor } from '../../../packages/daemon/src/agent-runtime/root-run-supervisor.mjs';

const { directory } = JSON.parse(process.argv[2]);
export async function readStatus() { return JSON.parse(readFileSync(join(directory, 'authority'))); }
export async function planRun() { return JSON.parse(readFileSync(join(directory, 'plan'))); }
export async function sealInstallation(target, status) {
  const proofClient = new RootRunSupervisor({ directory });
  const actual = await proofClient.request(target.tuple, { op: 'attest', lease: status.lease_id, term: status.fence_term });
  if (JSON.stringify(actual) !== JSON.stringify(target)) throw Error('receiver attestation mismatch');
  const nonce = randomUUID();
  const raw = 'test-only-material';
  const envelope = await new CompactEncrypt(Buffer.from(JSON.stringify({ target, nonce, raw, turnId: 'turn' })))
    .setProtectedHeader({ alg: 'RSA-OAEP-256', enc: 'A256GCM', kid: target.locator.birth_token_id })
    .encrypt(await importJWK(target.publicKey, 'RSA-OAEP-256'));
  writeFileSync(join(directory, 'target'), JSON.stringify(target));
  return { verificationId: nonce, envelope };
}
export async function verifyInstallation(target, sealed, proof) {
  const { tuple } = target;
  const message = ['remi.root.install.v1', sealed.verificationId, tuple.receipt_id, tuple.attempt_id,
    tuple.delivery_version, tuple.run_generation, target.locator.launch_identity];
  return proof === createHmac('sha256', 'test-only-material').update(JSON.stringify(message)).digest('base64url');
}
