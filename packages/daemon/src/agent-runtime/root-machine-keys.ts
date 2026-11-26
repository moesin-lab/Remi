import { constants, createHash, createPublicKey, privateDecrypt, sign, type KeyObject } from 'node:crypto';
import { ROOT_DELIVERY_MIN_RSA_BITS, type RootDeliveryMachineProof } from '@multiremi/contracts/root-delivery.js';
import { challengeEncryptionLabel, machineSignaturePayload, type MachineChallenge } from '@shared/machine-challenge.js';

type MachineIdentity = Omit<RootDeliveryMachineProof, 'recipient_key_fingerprint' | 'nonce' | 'signature' | 'signed_at'>;

export class RootMachineKeys {
  readonly #recipient: KeyObject;
  readonly #signer: KeyObject;
  readonly #binding;

  constructor(identity: MachineIdentity, recipient: KeyObject, signer: KeyObject) {
    if (recipient.type !== 'private' || recipient.asymmetricKeyType !== 'rsa' ||
        (recipient.asymmetricKeyDetails?.modulusLength ?? 0) < ROOT_DELIVERY_MIN_RSA_BITS ||
        signer.type !== 'private' || signer.asymmetricKeyType !== 'ed25519') throw new Error('Invalid machine keys');
    this.#recipient = recipient;
    this.#signer = signer;
    const key = createPublicKey(recipient);
    const {consumer_id, runtime_id, daemon_id, incarnation, recipient_key_id} = identity;
    if ([consumer_id, runtime_id, daemon_id, incarnation, recipient_key_id].some(value =>
      typeof value !== 'string' || !value.trim() || value.length > 512)) throw new Error('Invalid machine identity');
    this.#binding = Object.freeze({ consumer_id, runtime_id, daemon_id, incarnation, recipient_key_id, recipient_key_fingerprint: `sha256:${createHash('sha256')
      .update(key.export({format:'der',type:'spki'})).digest('hex')}`,
      signing_spki: createPublicKey(signer).export({format:'pem',type:'spki'}).toString(),
      recipient_spki: key.export({format:'pem',type:'spki'}).toString() });
  }

  publicBinding() { return this.#binding; }

  answerChallenge(challenge: MachineChallenge): RootDeliveryMachineProof {
    const now = Date.now();
    if (!Number.isSafeInteger(challenge.expiresAtMs) || challenge.expiresAtMs <= now || challenge.expiresAtMs > now + 60_000 ||
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
      const { consumer_id, runtime_id, daemon_id, incarnation, recipient_key_id, recipient_key_fingerprint } = this.#binding;
      return { consumer_id, runtime_id, daemon_id, incarnation, recipient_key_id, recipient_key_fingerprint, nonce, signed_at,
        signature: sign(null, machineSignaturePayload(challenge, nonce, signed_at), this.#signer).toString('base64url') };
    } finally { nonceBytes.fill(0); }
  }
}
