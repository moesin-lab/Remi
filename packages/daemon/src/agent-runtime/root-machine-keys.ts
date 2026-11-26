import { constants, createHash, createPublicKey, privateDecrypt, sign, type KeyObject } from 'node:crypto';
import { ROOT_DELIVERY_MIN_RSA_BITS, type RootDeliveryMachineProof } from '@multiremi/contracts/root-delivery.js';
import { challengeEncryptionLabel, machineSignaturePayload, type MachineChallenge, type MachinePublicBinding } from '@shared/machine-challenge.js';
import { isDeepStrictEqual } from 'node:util';
import { CompactEncrypt } from 'jose';
import type { RootDeliveryEnvelopePayload, RootDeliveryStatusResponse } from '@multiremi/contracts/root-delivery.js';
import { acknowledgeRunEnvironment, prepareRunInstallation } from '@shared/root-run-installation.js';
import type { RootRunTarget } from './root-run-supervisor.mjs';
import { verifyRootRunTarget, type RootRunEndpoint } from './root-run-endpoint.mjs';

type MachineIdentity = Omit<MachinePublicBinding, 'signingSpki' | 'recipientSpki'>;

export class RootMachineKeys {
  readonly #recipient: KeyObject;
  readonly #signer: KeyObject;
  readonly #binding;
  readonly #target;

  constructor(identity: MachineIdentity, recipient: KeyObject, signer: KeyObject) {
    if (recipient.type !== 'private' || recipient.asymmetricKeyType !== 'rsa' ||
        (recipient.asymmetricKeyDetails?.modulusLength ?? 0) < ROOT_DELIVERY_MIN_RSA_BITS ||
        signer.type !== 'private' || signer.asymmetricKeyType !== 'ed25519') throw new Error('Invalid machine keys');
    this.#recipient = recipient;
    this.#signer = signer;
    const key = createPublicKey(recipient);
    const {deploymentId, credentialId, credentialDigest, keyExpiresAtMs, consumerId, runtimeId, daemonId, incarnation, recipientKeyId} = identity;
    if ([deploymentId, credentialId, consumerId, runtimeId, daemonId, incarnation, recipientKeyId].some(value =>
      typeof value !== 'string' || !value.trim() || value.length > 512) || !/^[a-f0-9]{64}$/.test(credentialDigest) ||
      !Number.isSafeInteger(keyExpiresAtMs) || keyExpiresAtMs <= Date.now()) throw new Error('Invalid machine identity');
    this.#binding = Object.freeze({deploymentId, credentialId, credentialDigest, keyExpiresAtMs, consumerId, runtimeId, daemonId, incarnation, recipientKeyId,
      signingSpki: createPublicKey(signer).export({format:'pem',type:'spki'}).toString(), recipientSpki: key.export({format:'pem',type:'spki'}).toString()});
    this.#target = Object.freeze({consumer_id: consumerId, runtime_id: runtimeId, daemon_id: daemonId, incarnation, recipient_key_id: recipientKeyId,
      recipient_key_fingerprint: `sha256:${createHash('sha256').update(key.export({format:'der',type:'spki'})).digest('hex')}`});
  }

  publicBinding() { return this.#binding; }

  async installEnvelope(delivery: RootDeliveryEnvelopePayload, status: RootDeliveryStatusResponse, target: RootRunTarget,
    endpoint: RootRunEndpoint, executionUid: number) {
    const { locator, publicKey } = target;
    if (this.#binding.keyExpiresAtMs <= Date.now() || target.uid !== executionUid || !isDeepStrictEqual(target.tuple,delivery.tuple) ||
        locator.carrier_mode !== 'immutable_run_env' || locator.started_at !== null || !locator.birth_token_id ||
        locator.incarnation !== this.#target.incarnation || locator.runtime_id !== this.#target.runtime_id ||
        locator.daemon_id !== this.#target.daemon_id || publicKey.kty !== 'RSA' || 'd' in publicKey) throw new Error('Invalid run target');
    await verifyRootRunTarget(endpoint,target,status);
    const algorithm = {name:'RSA-OAEP',hash:'SHA-256'};
    const receiver = await crypto.subtle.importKey('jwk',publicKey,algorithm,false,['encrypt']);
    if ((receiver.algorithm as RsaHashedKeyAlgorithm).modulusLength < ROOT_DELIVERY_MIN_RSA_BITS) throw new Error('Invalid receiver key');
    const pkcs8 = this.#recipient.export({type:'pkcs8',format:'der'});
    let recipient: CryptoKey;
    try { recipient = await crypto.subtle.importKey('pkcs8',pkcs8,algorithm,false,['decrypt']); }
    finally { pkcs8.fill(0); }
    const { env, challenge } = await prepareRunInstallation(delivery,status,this.#target,recipient,locator.launch_identity,{});
    const verificationId = createHash('sha256').update(acknowledgeRunEnvironment(challenge,env)).digest('hex');
    const bytes = Buffer.from(JSON.stringify({target,raw:env.MULTIREMI_TOKEN,turnId:env.MULTIREMI_TURN_ID,nonce:challenge.nonce}));
    try {
      const envelope = await new CompactEncrypt(bytes).setProtectedHeader({alg:'RSA-OAEP-256',enc:'A256GCM',kid:locator.birth_token_id}).encrypt(receiver);
      return {envelope,verificationId};
    } finally { bytes.fill(0); }
  }

  answerChallenge(challenge: MachineChallenge): RootDeliveryMachineProof {
    const now = Date.now();
    if (this.#binding.keyExpiresAtMs <= now || !Number.isSafeInteger(challenge.expiresAtMs) || challenge.expiresAtMs <= now || challenge.expiresAtMs > now + 60_000 ||
        !/^[a-f0-9]{64}$/.test(challenge.binding) || !/^[0-9a-f-]{36}$/.test(challenge.id) ||
        typeof challenge.targetId !== 'string' || !challenge.targetId || challenge.targetId.length > 512 ||
        !['root.runtime-trust.grant','delivery.receipt.status','delivery.receipt.replay','delivery.receipt.install_ack','task.start'].includes(challenge.purpose) ||
        typeof challenge.encryptedNonce !== 'string' || challenge.encryptedNonce.length > 2048) throw new Error('Invalid machine challenge');
    const nonceBytes = privateDecrypt({key:this.#recipient, oaepHash:'sha256', padding:constants.RSA_PKCS1_OAEP_PADDING,
      oaepLabel:challengeEncryptionLabel(challenge)}, Buffer.from(challenge.encryptedNonce,'base64url'));
    try {
      if (nonceBytes.length !== 32) throw new Error('Invalid machine challenge');
      const nonce = nonceBytes.toString('base64url');
      const signed_at = new Date(now).toISOString();
      return { ...this.#target, nonce, signed_at,
        signature: sign(null, machineSignaturePayload(challenge, nonce, signed_at), this.#signer).toString('base64url') };
    } finally { nonceBytes.fill(0); }
  }
}
