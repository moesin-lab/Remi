import { constants, createHash, createPublicKey, publicEncrypt, randomBytes, randomUUID, verify } from 'node:crypto';
import { ROOT_DELIVERY_MIN_RSA_BITS, type RootDeliveryMachineProof } from '@multiremi/contracts/root-delivery.js';
import type { SqlDatabase } from './db/postgres.js';
import { assertUnrevokedAncestry } from './authority-provenance.js';
import { SecurityAbort, withSecurityTarget, type SecurityTx } from './security-write.js';
import type { ReceiptService } from './root-authority-contract.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const reject = (): never => { throw new SecurityAbort('root_authority_revoked'); };
type MachineBrand = Parameters<ReceiptService['resolveReceiptStatus']>[0];
export type VerifiedMachine = MachineBrand & Readonly<{
  runtimeId: string; daemonId: string; incarnation: string; consumerId: string; keyId: string; fingerprint: string;
  challengeId: string; proofDigest: string; authorityNodeId: string; generation: number;
}>;
const verifiedMachines = new WeakMap<MachineBrand, { db: SqlDatabase; credentialDigest: string; purpose: string; targetId: string; binding: string; handle: VerifiedMachine; connection?: MachineConnection }>();

declare const connectionBrand: unique symbol;
export interface MachineConnection { readonly [connectionBrand]: true }
const connections = new WeakMap<object, MachineConnection>();
const connectionProofs = new WeakMap<MachineConnection, { db: SqlDatabase; owner: object; credentialDigest: string; id: string }>();

export function bindMachineConnection(db: SqlDatabase, owner: object, bearer: string): MachineConnection | null {
  if (connections.has(owner)) return reject();
  if (!bearer) return null;
  const credentialDigest = hash(bearer);
  const token = db.query(`SELECT t.expires_at FROM multiremi_access_tokens t JOIN multiremi_workspaces w ON w.id=t.workspace_id
    WHERE t.token_hash=? AND t.type='daemon' AND t.daemon_id IS NOT NULL AND t.revoked_at IS NULL AND NOT EXISTS
    (SELECT 1 FROM multiremi_daemon_retirements d WHERE d.workspace_id=t.workspace_id AND d.daemon_id=t.daemon_id)`).get(credentialDigest);
  if (!token || token.expires_at!==null && !(Date.parse(token.expires_at)>Date.now())) return null;
  const connection = Object.freeze({}) as MachineConnection;
  connections.set(owner,connection);
  connectionProofs.set(connection,{db,owner,credentialDigest,id:randomUUID()});
  return connection;
}

export function releaseMachineConnection(owner: object): void {
  const connection = connections.get(owner);
  if (connection) connectionProofs.delete(connection);
  connections.delete(owner);
}

function currentConnectionDigest(db: SqlDatabase, connection: string | MachineConnection): string {
  if (typeof connection==='string') return hash(connection);
  const proof = connectionProofs.get(connection);
  if (!proof || proof.db!==db || connections.get(proof.owner)!==connection) return reject();
  return proof.credentialDigest;
}

function nonceDigest(connection: string | MachineConnection, nonce: string): string {
  return typeof connection==='string' ? hash(nonce) : hash(JSON.stringify([connectionProofs.get(connection)!.id,nonce]));
}

function enrollment(db: SqlDatabase, runtimeId: string, credentialDigest: string) {
  const row = db.query(`SELECT e.*,r.workspace_id,t.expires_at FROM multiremi_machine_enrollments e
    JOIN multiremi_runtimes r ON r.id=e.runtime_id AND r.daemon_id=e.daemon_id
    JOIN multiremi_workspaces w ON w.id=r.workspace_id
    JOIN multiremi_access_tokens t ON t.id=e.credential_id AND t.token_hash=e.credential_digest AND t.type='daemon'
      AND t.daemon_id=e.daemon_id AND t.workspace_id=r.workspace_id AND t.revoked_at IS NULL
    JOIN multiremi_authority_nodes n ON n.node_id=e.authority_node_id AND n.generation=e.generation AND n.kind='machine_registration'
      AND n.subject_type='daemon' AND n.subject_id=e.daemon_id
    WHERE e.runtime_id=? AND e.credential_digest=? AND e.retired_at_ms IS NULL AND e.isolation_verified_at_ms>0
      AND e.isolation_verified_at_ms<=? AND e.key_expires_at_ms>? AND e.immutable_carrier_verified_at_ms>0 AND e.immutable_carrier_verified_at_ms<=?
      AND e.attestation_expires_at_ms>? AND length(trim(e.attestation_id))>0 AND NOT EXISTS(SELECT 1 FROM multiremi_daemon_retirements retired
        WHERE retired.daemon_id=e.daemon_id AND retired.workspace_id=r.workspace_id)`).get(runtimeId,credentialDigest,Date.now(),Date.now(),Date.now(),Date.now());
  if (!row || row.expires_at !== null && !(Date.parse(row.expires_at)>Date.now())) return reject();
  const recipientKey = createPublicKey(row.recipient_spki);
  const signingKey = createPublicKey(row.signing_spki);
  if (recipientKey.asymmetricKeyType !== 'rsa' || (recipientKey.asymmetricKeyDetails?.modulusLength ?? 0)<ROOT_DELIVERY_MIN_RSA_BITS
    || signingKey.asymmetricKeyType !== 'ed25519') return reject();
  const fingerprint = `sha256:${hash(recipientKey.export({ format: 'der',type: 'spki' }))}`;
  const binding = JSON.stringify([row.deployment_id,row.runtime_id,row.daemon_id,row.incarnation,row.consumer_id,row.credential_id,
    row.credential_digest,row.generation,row.recipient_key_id,fingerprint,row.signing_spki,Number(row.key_expires_at_ms),row.authority_node_id,
    row.attestation_id,Number(row.immutable_carrier_verified_at_ms),Number(row.isolation_verified_at_ms),Number(row.attestation_expires_at_ms)]);
  return { row,recipientKey,signingKey,fingerprint,binding: hash(binding) };
}

export interface MachineChallenge {
  id: string; encryptedNonce: string; binding: string; purpose: string; targetId: string; expiresAtMs: number;
}

export function machineSignaturePayload(challenge: Omit<MachineChallenge,'encryptedNonce'>, nonce: string, signedAt: string): Buffer {
  return Buffer.from(JSON.stringify(['remi.machine.challenge.v1',challenge.id,challenge.binding,challenge.purpose,challenge.targetId,
    challenge.expiresAtMs,nonce,signedAt]));
}

export function beginMachineChallenge(db: SqlDatabase, tx: SecurityTx, connection: string | MachineConnection, runtimeId: string, purpose: string, targetId: string): MachineChallenge {
  return withSecurityTarget(db,tx,`machine:${runtimeId}`,() => {
    const {row,recipientKey,binding} = enrollment(db,runtimeId,currentConnectionDigest(db,connection));
    assertUnrevokedAncestry(db,tx,{ nodeId: row.authority_node_id,generation: Number(row.generation) });
    const id = randomUUID();
    const nonce = randomBytes(32);
    const expiresAtMs = Math.min(Date.now()+60_000,Number(row.key_expires_at_ms));
    const encryptedNonce = publicEncrypt({ key: recipientKey,oaepHash: 'sha256',padding: constants.RSA_PKCS1_OAEP_PADDING },nonce).toString('base64url');
    db.query(`INSERT INTO multiremi_machine_challenges(challenge_id,incarnation,purpose,target_id,nonce_digest,binding_digest,expires_at_ms)
      VALUES(?,?,?,?,?,?,?)`).run(id,row.incarnation,purpose,targetId,nonceDigest(connection,nonce.toString('base64url')),binding,expiresAtMs);
    nonce.fill(0);
    return { id,encryptedNonce,binding,purpose,targetId,expiresAtMs };
  });
}

export function verifyMachineChallenge(db: SqlDatabase, tx: SecurityTx, connection: string | MachineConnection, challengeId: string, purpose: string, targetId: string,
  proof: RootDeliveryMachineProof): VerifiedMachine {
  return withSecurityTarget(db,tx,`machine:${proof.runtime_id}`,() => {
    const credentialDigest = currentConnectionDigest(db,connection);
    const {row,fingerprint,binding,signingKey} = enrollment(db,proof.runtime_id,credentialDigest);
    assertUnrevokedAncestry(db,tx,{ nodeId: row.authority_node_id,generation: Number(row.generation) });
    const challenge = db.query(`SELECT expires_at_ms FROM multiremi_machine_challenges WHERE challenge_id=? AND incarnation=? AND purpose=?
      AND target_id=? AND nonce_digest=? AND binding_digest=? AND consumed_at_ms IS NULL`).get(challengeId,row.incarnation,purpose,targetId,nonceDigest(connection,proof.nonce),binding);
    if (!challenge || proof.consumer_id !== row.consumer_id || proof.daemon_id !== row.daemon_id || proof.incarnation !== row.incarnation
      || proof.recipient_key_id !== row.recipient_key_id || proof.recipient_key_fingerprint !== fingerprint) return reject();
    const now = Date.now();
    const signed = Date.parse(proof.signed_at);
    const expiresAtMs = Number(challenge.expires_at_ms);
    if (!(signed<=now && signed>=now-60_000 && expiresAtMs>now) || !verify(null,machineSignaturePayload({id:challengeId,binding,purpose,targetId,expiresAtMs},
      proof.nonce,proof.signed_at),signingKey,Buffer.from(proof.signature,'base64url'))) return reject();
    const proofDigest = hash(proof.signature);
    if (!db.query(`UPDATE multiremi_machine_challenges SET consumed_at_ms=?,proof_digest=? WHERE challenge_id=? AND expires_at_ms>?
      AND consumed_at_ms IS NULL RETURNING challenge_id`).get(now,proofDigest,challengeId,Date.now())) return reject();
    const handle = Object.freeze({ runtimeId: proof.runtime_id,daemonId: proof.daemon_id,incarnation: proof.incarnation,consumerId: proof.consumer_id,
      keyId: proof.recipient_key_id,fingerprint,challengeId,proofDigest,authorityNodeId: String(row.authority_node_id),generation: Number(row.generation) }) as VerifiedMachine;
    verifiedMachines.set(handle,{db,credentialDigest,purpose,targetId,binding,handle,...(typeof connection==='string'?{}:{connection})});
    return handle;
  });
}

export function requireCurrentMachine(db: SqlDatabase, tx: SecurityTx, proof: MachineBrand, purpose: string, targetId: string): VerifiedMachine {
  const evidence = verifiedMachines.get(proof);
  if (!evidence || evidence.db!==db || evidence.purpose!==purpose || evidence.targetId!==targetId) return reject();
  const handle = evidence.handle;
  return withSecurityTarget(db,tx,`machine:${handle.runtimeId}`,() => {
    if (evidence.connection) currentConnectionDigest(db,evidence.connection);
    if (!db.query(`SELECT challenge_id FROM multiremi_machine_challenges WHERE challenge_id=? AND proof_digest=? AND binding_digest=?
      AND consumed_at_ms IS NOT NULL AND expires_at_ms>?`).get(handle.challengeId,handle.proofDigest,evidence.binding,Date.now())) return reject();
    const current = enrollment(db,handle.runtimeId,evidence.credentialDigest);
    if (current.binding!==evidence.binding) return reject();
    assertUnrevokedAncestry(db,tx,{ nodeId: handle.authorityNodeId,generation: handle.generation });
    return handle;
  });
}

export function readVerifiedTrustChallenge(db: SqlDatabase, tx: SecurityTx, runtimeId: string, challengeId: string, response: string) {
  const receipt = db.query(`SELECT c.binding_digest,e.credential_digest FROM multiremi_machine_challenges c JOIN multiremi_machine_enrollments e
    ON e.incarnation=c.incarnation WHERE c.challenge_id=? AND c.target_id=? AND e.runtime_id=? AND c.purpose='root.runtime-trust.grant'
    AND c.consumed_at_ms IS NOT NULL AND c.expires_at_ms>? AND c.proof_digest=?`).get(challengeId,runtimeId,runtimeId,Date.now(),response);
  if (!receipt) return reject();
  const verified = enrollment(db,runtimeId,receipt.credential_digest);
  assertUnrevokedAncestry(db,tx,{ nodeId: verified.row.authority_node_id,generation: Number(verified.row.generation) });
  if (verified.binding !== receipt.binding_digest) return reject();
  return { runtimeId,workspaceId: String(verified.row.workspace_id),daemonId: String(verified.row.daemon_id),incarnation: String(verified.row.incarnation),
    keyId: String(verified.row.recipient_key_id), fingerprint: verified.fingerprint, expires: Number(verified.row.key_expires_at_ms),
    attestationExpiry: Number(verified.row.attestation_expires_at_ms),authorityNodeId: String(verified.row.authority_node_id) };
}

export function recordedMachineBindingIsCurrent(db: SqlDatabase, tx: SecurityTx, runtimeId: string, challengeId: string): boolean {
  return withSecurityTarget(db,tx,`management:runtime:${runtimeId}`,() => {
    const receipt = db.query(`SELECT c.binding_digest,e.credential_digest FROM multiremi_machine_challenges c JOIN multiremi_machine_enrollments e
      ON e.incarnation=c.incarnation WHERE c.challenge_id=? AND c.target_id=? AND e.runtime_id=? AND c.consumed_at_ms IS NOT NULL`).get(challengeId,runtimeId,runtimeId);
    if (!receipt) return false;
    try { return enrollment(db,runtimeId,receipt.credential_digest).binding===receipt.binding_digest; } catch(error) {
      if (error instanceof SecurityAbort && error.code==='root_authority_revoked') return false;
      throw error;
    }
  });
}
