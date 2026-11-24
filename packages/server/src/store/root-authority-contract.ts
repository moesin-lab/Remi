import type { AuthorityNodeRef } from './authority-provenance.js';
import type { GrantSubject, RecordedGrant } from './root-grants.js';
import type { SecurityTx } from './security-write.js';
import type * as Public from '@multiremi/contracts/root-authority.js';
import type * as Delivery from '@multiremi/contracts/root-delivery.js';

declare const verified: unique symbol;
type Verified<Kind extends string> = { readonly [verified]: Kind };

export interface VersionedRef {
  readonly id: string;
  readonly version: number;
}

export interface CredentialOrigin {
  readonly credential: VersionedRef;
  readonly familyId: string;
  readonly node: AuthorityNodeRef;
}

export type CredentialProof = { readonly kind: 'absent' | 'invalid' }
  | (Verified<'credential'> & { readonly kind: 'independent' | 'dependent'; readonly proofVersion: VersionedRef });

export interface AuthorityUse {
  readonly action: string;
  readonly actualTarget: { readonly type: string; readonly id: string };
  readonly use: string;
}

export interface CurrentAuthority {
  readonly transport: Public.RootTransportIdentity;
  readonly subject: GrantSubject | null;
  readonly credentialOrigin: CredentialOrigin | null;
  readonly attemptId: string | null;
  readonly recordedGrant: RecordedGrant | null;
  readonly scope: 'system' | null;
  readonly effectiveRoot: boolean;
  readonly reason: string;
  readonly checkedRevision: number;
}

export interface FinalExecution {
  readonly attemptId: string;
  readonly runtimeId: string;
  readonly daemonId: string;
  readonly incarnation: string;
  readonly configEpoch: number;
  readonly executionDigest: string;
  readonly providerTrust: VersionedRef;
  readonly checkpointTrust: VersionedRef | null;
}

export interface InputManifest extends VersionedRef {
  readonly digest: string;
}

export interface AdmissionTicket extends Verified<'admission'> {
  readonly execution: FinalExecution;
  readonly manifest: InputManifest;
  readonly runtimeTrust: VersionedRef;
  readonly invocation: VersionedRef;
  readonly grant: RecordedGrant;
  readonly admissionRevision: number;
}

export interface IssueCredentialInput {
  readonly actor: Verified<'actor'>;
  readonly proof: CredentialProof;
  readonly beneficiary: GrantSubject;
  readonly purpose: AuthorityUse;
  readonly parents: Verified<'server-resolved-parents'>;
  readonly ceilingMs: number;
  readonly expectedVersion: number;
  readonly preparedMaterial: Verified<'prepared-material'>;
}

export interface IssuedCredential extends CredentialOrigin {
  readonly subject: GrantSubject;
  readonly continuousParents: readonly AuthorityNodeRef[];
  readonly evidenceParents: readonly AuthorityNodeRef[];
  readonly expiresAtMs: number;
  readonly material: Verified<'issued-material'>;
}

export interface AuthorityKernel {
  resolveCurrent(proof: CredentialProof, request: AuthorityUse): CurrentAuthority;
  authorizeWrite(tx: SecurityTx, proof: CredentialProof, request: AuthorityUse): CurrentAuthority & Verified<'actor'>;
  admitAttempt(tx: SecurityTx, subject: GrantSubject, invocation: Verified<'invocation'>,
    execution: FinalExecution, manifest: InputManifest): { eligibility: 'none' } | { eligibility: 'root'; ticket: AdmissionTicket };
  consumeAdmission(tx: SecurityTx, ticket: AdmissionTicket, inserted: FinalExecution, manifest: InputManifest): void;
  issue(tx: SecurityTx, input: IssueCredentialInput): IssuedCredential;
  grant(tx: SecurityTx, actor: Verified<'actor'>, input: Public.CreateRootGrantRequest): Public.CreateRootGrantResponse;
  revokeGrant(tx: SecurityTx, actor: Verified<'actor'>, grantId: string, input: Public.RevokeRootGrantRequest): Public.RevokeRootGrantResponse;
  grantRuntimeTrust(tx: SecurityTx, actor: Verified<'actor'>, input: Public.GrantRootRuntimeTrustRequest): Public.GrantRootRuntimeTrustResponse;
  revokeRuntimeTrust(tx: SecurityTx, actor: Verified<'actor'>, trustId: string, input: Public.RevokeRootRuntimeTrustRequest): Public.RevokeRootRuntimeTrustResponse;
  revokeFamily(tx: SecurityTx, actor: Verified<'actor'>, familyId: string, input: Public.RevokeCredentialFamilyRequest): Public.RevokeCredentialFamilyResponse;
}

export interface ReceiptService {
  prepareOffer(preparation: Verified<'preparation'>): Promise<Verified<'candidate'>>;
  activateForReceipt(tx: SecurityTx, candidate: Verified<'candidate'>, receipt: Delivery.RootDeliveryTuple): Delivery.RootDeliveryActivationResponse;
  resolveReceiptStatus(machine: Verified<'machine'>, execution: Delivery.RootDeliveryExecutionKey): Delivery.RootDeliveryStatusResponse;
  replayReceipt(tx: SecurityTx, machine: Verified<'machine'>, input: Omit<Delivery.RootDeliveryReplayRequest, 'machine_proof'>): Delivery.RootDeliveryReplayResponse;
  ackReceiptInstalled(tx: SecurityTx, machine: Verified<'machine'>, input: Omit<Delivery.RootDeliveryInstallAckRequest, 'machine_proof'>): Delivery.RootDeliveryInstallAckResponse;
  acceptReceiptDelivery(delivery: Delivery.RootDeliveryEnvelopePayload, status: Delivery.RootDeliveryStatusResponse): Promise<Delivery.RootExecutionLocator>;
  confirmReceiptInstallation(execution: Delivery.RootExecutionLocator): Promise<Delivery.RootDeliveryInstallAckResponse>;
}
