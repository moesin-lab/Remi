export interface MachinePublicBinding {
  deploymentId: string;
  runtimeId: string;
  daemonId: string;
  incarnation: string;
  consumerId: string;
  credentialId: string;
  credentialDigest: string;
  recipientKeyId: string;
  recipientSpki: string;
  signingSpki: string;
  keyExpiresAtMs: number;
}

export interface MachineChallenge {
  id: string;
  encryptedNonce: string;
  binding: string;
  purpose: string;
  targetId: string;
  expiresAtMs: number;
}

type ChallengeHeader = Omit<MachineChallenge, 'encryptedNonce'>;

export function challengeEncryptionLabel(challenge: ChallengeHeader): Buffer {
  return Buffer.from(JSON.stringify(['remi.machine.nonce.v1', challenge.id, challenge.binding, challenge.purpose,
    challenge.targetId, challenge.expiresAtMs]));
}

export function machineSignaturePayload(challenge: ChallengeHeader, nonce: string, signedAt: string): Buffer {
  return Buffer.from(JSON.stringify(['remi.machine.challenge.v1', challenge.id, challenge.binding, challenge.purpose,
    challenge.targetId, challenge.expiresAtMs, nonce, signedAt]));
}
