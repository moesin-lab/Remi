import { createPublicKey, verify } from 'node:crypto';
import { ROOT_DELIVERY_MIN_RSA_BITS } from '@multiremi/contracts/root-delivery.js';
import type { SqlDatabase } from './db/postgres.js';
import { assertUnrevokedAncestry } from './authority-provenance.js';
import { SecurityAbort, type SecurityTx } from './security-write.js';

export interface MachinePublicBinding {
  deploymentId: string; runtimeId: string; daemonId: string; incarnation: string; consumerId: string;
  credentialId: string; credentialDigest: string; recipientKeyId: string; recipientSpki: string;
  signingSpki: string; keyExpiresAtMs: number;
}

export interface HostAttestation {
  id: string; isolationVerifiedAtMs: number; immutableCarrierVerifiedAtMs: number; expiresAtMs: number; signature: string;
}

export function machineEnrollmentPayload(purpose: 'deployment' | 'attestation', binding: MachinePublicBinding,
  attestation: Omit<HostAttestation, 'signature'>, expectedGeneration: number): Buffer {
  return Buffer.from(JSON.stringify(['remi.machine.enroll.v1', purpose, expectedGeneration, binding.deploymentId, binding.runtimeId,
    binding.daemonId, binding.incarnation, binding.consumerId, binding.credentialId, binding.credentialDigest, binding.recipientKeyId,
    binding.recipientSpki, binding.signingSpki, binding.keyExpiresAtMs, attestation.id, attestation.isolationVerifiedAtMs,
    attestation.immutableCarrierVerifiedAtMs, attestation.expiresAtMs]));
}

export function machineRetirementPayload(deploymentId: string, runtimeId: string, incarnation: string, generation: number): Buffer {
  return Buffer.from(JSON.stringify(['remi.machine.retire.v1', deploymentId, runtimeId, incarnation, generation]));
}

function reject(): never { throw new SecurityAbort('root_authority_revoked'); }

function publicKey(pem: string) {
  if (typeof pem !== 'string' || !pem.startsWith('-----BEGIN PUBLIC KEY-----') || pem.length > 8192) return reject();
  return createPublicKey(pem);
}

function verifySignature(spki: string, payload: Buffer, signature: string) {
  const key = publicKey(spki);
  if (key.asymmetricKeyType !== 'ed25519' || typeof signature !== 'string' || !/^[\w-]{86}$/.test(signature)
    || !verify(null, payload, key, Buffer.from(signature, 'base64url'))) reject();
}

export function requireMachineDeployment(db: SqlDatabase, tx: SecurityTx, deploymentId: string, payload: Buffer, signature: string) {
  const root = db.query(`SELECT r.*, n.generation FROM multiremi_machine_deployment_roots r JOIN multiremi_authority_nodes n
    ON n.node_id=r.authority_node_id AND n.kind='deployment_origin' AND n.subject_type='deployment' AND n.subject_id=r.deployment_id
    WHERE r.deployment_id=?`).get(deploymentId);
  if (!root) return reject();
  assertUnrevokedAncestry(db, tx, { nodeId: root.authority_node_id, generation: Number(root.generation) });
  verifySignature(root.deployment_spki, payload, signature);
  return root;
}

export function requireEnrollmentBinding(db: SqlDatabase, tx: SecurityTx, deploymentProof: string, attestation: HostAttestation,
  binding: MachinePublicBinding, expectedGeneration: number) {
  const root = requireMachineDeployment(db, tx, binding.deploymentId,
    machineEnrollmentPayload('deployment', binding, attestation, expectedGeneration), deploymentProof);
  verifySignature(root.attestor_spki, machineEnrollmentPayload('attestation', binding, attestation, expectedGeneration), attestation.signature);
  const now = Date.now();
  if (![binding.deploymentId, binding.runtimeId, binding.daemonId, binding.incarnation, binding.consumerId, binding.credentialId,
    binding.recipientKeyId, attestation.id].every(value => typeof value === 'string' && value.trim().length > 0 && value.length <= 512)
    || !/^[a-f0-9]{64}$/.test(binding.credentialDigest) || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0
    || ![attestation.isolationVerifiedAtMs, attestation.immutableCarrierVerifiedAtMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= now)
    || ![binding.keyExpiresAtMs, attestation.expiresAtMs].every(value => Number.isSafeInteger(value) && value > now)) return reject();
  const signing = publicKey(binding.signingSpki);
  const recipient = publicKey(binding.recipientSpki);
  if (signing.asymmetricKeyType !== 'ed25519' || recipient.asymmetricKeyType !== 'rsa'
    || (recipient.asymmetricKeyDetails?.modulusLength ?? 0) < ROOT_DELIVERY_MIN_RSA_BITS
    || [root.deployment_spki, root.attestor_spki].some(spki => signing.equals(publicKey(spki)))) return reject();
  const token = db.query(`SELECT t.expires_at FROM multiremi_access_tokens t JOIN multiremi_runtimes r
    ON r.workspace_id=t.workspace_id AND r.daemon_id=t.daemon_id WHERE r.id=? AND r.daemon_id=? AND t.id=? AND t.token_hash=?
    AND t.type='daemon' AND t.revoked_at IS NULL AND NOT EXISTS(SELECT 1 FROM multiremi_daemon_retirements d
    WHERE d.workspace_id=r.workspace_id AND d.daemon_id=r.daemon_id)`).get(binding.runtimeId, binding.daemonId, binding.credentialId, binding.credentialDigest);
  if (!token || token.expires_at !== null && !(Date.parse(token.expires_at) > now)) return reject();
  return root.authority_node_id as string;
}
