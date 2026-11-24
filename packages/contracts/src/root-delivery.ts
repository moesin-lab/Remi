/**
 * MUL-1 A2 machine wire & delivery receipt contracts (§4.3, §10.1).
 *
 * Contract invariants:
 * - Standard JWE Compact (RFC 7516/7518): `alg=RSA-OAEP-256`, `enc=A256GCM`,
 *   RSA >= 3072 bits, implemented via `jose` (B owns server direct dependency,
 *   D updates unified `bun.lock`; no custom cryptography here).
 * - First activation commits receipt/run/Q, active credential + provenance, and
 *   immutable recipient-bound JWE envelope atomically. Same-receipt replay
 *   returns the SAME envelope, expiry, and delivery/material versions without
 *   rotating raw bearer or bumping `delivery_version`.
 * - `status` NEVER contains `raw`, `envelope`, private payload, or raw material digest.
 * - Persistent journal entries store ONLY non-secret tuple/locator/state fields.
 * - Root execution carrier uses immutable per-run process env (`immutable_run_env`),
 *   never legacy disk context file fallback.
 */

export const ROOT_DELIVERY_JWE_ALG = "RSA-OAEP-256" as const;
export const ROOT_DELIVERY_JWE_ENC = "A256GCM" as const;
export const ROOT_DELIVERY_MIN_RSA_BITS = 3072 as const;
export const ROOT_DELIVERY_PROTOCOL_VERSION = 1 as const;

export const ROOT_CARRIER_MODES = ["immutable_run_env"] as const;
export type RootCarrierMode = (typeof ROOT_CARRIER_MODES)[number];

export const ROOT_DELIVERY_RECEIVER_STATES = [
  "received",
  "installed",
  "confirmed",
  "started",
] as const;
export type RootDeliveryReceiverState = (typeof ROOT_DELIVERY_RECEIVER_STATES)[number];

export const ROOT_DELIVERY_RUN_STATES = [
  "prepared",
  "pending_start",
  "running",
  "terminal",
  "expired",
  "revoked",
] as const;
export type RootDeliveryRunState = (typeof ROOT_DELIVERY_RUN_STATES)[number];

export const ROOT_DELIVERY_ACK_STATES = [
  "pending",
  "installed",
  "confirmed",
] as const;
export type RootDeliveryAckState = (typeof ROOT_DELIVERY_ACK_STATES)[number];

export const ROOT_DELIVERY_RECOVERY_ACTIONS = [
  "wait_activation",
  "replay_envelope",
  "send_install_ack",
  "start_execution",
  "reattach_running",
  "abort_stale",
] as const;
export type RootDeliveryRecoveryAction = (typeof ROOT_DELIVERY_RECOVERY_ACTIONS)[number];

/**
 * Complete non-secret binding tuple shared across prepare, activation, status,
 * replay, install-ack, JWE protected context, and non-secret daemon journal.
 */
export interface RootDeliveryTuple {
  readonly receipt_id: string;
  readonly receipt_version: number;
  readonly delivery_version: number;
  readonly material_version: number;
  readonly attempt_id: string;
  readonly handoff_id: string | null;
  readonly handoff_generation: number;
  readonly run_generation: number;
  readonly consumer_id: string;
  readonly runtime_id: string;
  readonly daemon_id: string;
  readonly incarnation: string;
  readonly recipient_key_id: string;
  readonly recipient_key_fingerprint: string;
  readonly execution_config_epoch: number;
  readonly execution_digest: string;
  readonly input_revision: number;
  readonly input_digest: string;
  readonly checkpoint_digest: string | null;
  readonly grant_id: string | null;
  readonly grant_generation: number | null;
  readonly material_expires_at: string;
  readonly business_payload_digest: string;
}

/**
 * Authenticated JWE protected header context (§4.3).
 * Never carries raw credential material.
 */
export interface RootDeliveryJweProtectedHeader {
  readonly alg: typeof ROOT_DELIVERY_JWE_ALG;
  readonly enc: typeof ROOT_DELIVERY_JWE_ENC;
  readonly v: typeof ROOT_DELIVERY_PROTOCOL_VERSION;
  readonly kid: string;
  readonly receipt_id: string;
  readonly receipt_version: number;
  readonly delivery_version: number;
  readonly material_version: number;
  readonly attempt_id: string;
  readonly handoff_id: string | null;
  readonly handoff_generation: number;
  readonly run_generation: number;
  readonly consumer_id: string;
  readonly runtime_id: string;
  readonly daemon_id: string;
  readonly incarnation: string;
  readonly recipient_key_fingerprint: string;
  readonly execution_config_epoch: number;
  readonly execution_digest: string;
  readonly input_revision: number;
  readonly input_digest: string;
  readonly checkpoint_digest: string | null;
  readonly grant_id: string | null;
  readonly grant_generation: number | null;
  readonly material_expires_at: string;
  readonly business_payload_digest: string;
}

/**
 * Non-secret machine identity & recipient-key possession proof sent by the daemon
 * on status/replay/install-ack so recovery never depends on a stale task bearer.
 */
export interface RootDeliveryMachineProof {
  readonly consumer_id: string;
  readonly runtime_id: string;
  readonly daemon_id: string;
  readonly incarnation: string;
  readonly recipient_key_id: string;
  readonly recipient_key_fingerprint: string;
  readonly nonce: string;
  readonly signature: string;
  readonly signed_at: string;
}

/** Non-secret execution lookup key used by `delivery.receipt.status`. */
export interface RootDeliveryExecutionKey {
  readonly attempt_id: string;
  readonly handoff_id?: string | null;
  readonly receipt_id?: string | null;
}

/** Uplink RPC payload: `delivery.receipt.status` (§4.3, §10.1). */
export interface RootDeliveryStatusRequest {
  readonly execution_key: RootDeliveryExecutionKey;
  readonly machine_proof: RootDeliveryMachineProof;
}

/**
 * Reply for `delivery.receipt.status`.
 *
 * SECURITY INVARIANT: MUST NOT include `raw`, `envelope`, `frozen_business_payload`,
 * or raw material digest. `envelope_digest` is the non-secret SHA-256 of the
 * committed JWE ciphertext bytes used to authenticate the issuer against trusted status.
 */
export interface RootDeliveryStatusResponse {
  readonly ok: true;
  readonly committed: boolean;
  readonly tuple: RootDeliveryTuple | null;
  readonly envelope_digest: string | null;
  readonly run_state: RootDeliveryRunState;
  readonly ack_state: RootDeliveryAckState;
  readonly start_deadline: string | null;
  readonly lease_id: string | null;
  readonly fence_term: string | null;
  readonly allowed_recovery_action: RootDeliveryRecoveryAction;
  readonly security_revision: number;
}

/**
 * Committed delivery payload returned by first activation or same-receipt replay.
 * Wire frames carry ONLY the recipient-bound JWE `envelope`, never plaintext `raw`.
 */
export interface RootDeliveryEnvelopePayload {
  readonly tuple: RootDeliveryTuple;
  readonly envelope: string;
  readonly envelope_digest: string;
  readonly frozen_business_payload: Readonly<Record<string, unknown>>;
  readonly start_deadline: string | null;
  readonly lease_id: string | null;
  readonly fence_term: string | null;
  readonly run_state: Extract<RootDeliveryRunState, "pending_start" | "running">;
}

/** First-time activation response (`activateForReceipt` wire projection). */
export interface RootDeliveryActivationResponse extends RootDeliveryEnvelopePayload {
  readonly ok: true;
  readonly activation: "committed";
}

/** Uplink RPC payload: `delivery.receipt.replay` (§4.3, §10.1). */
export interface RootDeliveryReplayRequest {
  readonly receipt_id: string;
  readonly expected_receipt_version: number;
  readonly expected_delivery_version: number;
  readonly run_lease_id: string | null;
  readonly fence_term: string | null;
  readonly machine_proof: RootDeliveryMachineProof;
}

/** Same-receipt replay response: returns the identical committed envelope & versions. */
export interface RootDeliveryReplayResponse extends RootDeliveryEnvelopePayload {
  readonly ok: true;
  readonly replay: true;
}

/** Non-secret execution process locator & birth identity for unique reattach (§4.3 #5). */
export interface RootExecutionLocator {
  readonly execution_id: string;
  readonly launch_identity: string;
  readonly carrier_mode: RootCarrierMode;
  readonly runtime_id: string;
  readonly daemon_id: string;
  readonly incarnation: string;
  readonly birth_token_id: string | null;
  readonly started_at: string | null;
}

/** Uplink RPC payload: `delivery.receipt.install_ack` (§4.3, §10.1). */
export interface RootDeliveryInstallAckRequest {
  readonly tuple: Pick<
    RootDeliveryTuple,
    | "receipt_id"
    | "receipt_version"
    | "delivery_version"
    | "material_version"
    | "attempt_id"
    | "handoff_id"
    | "run_generation"
    | "consumer_id"
    | "runtime_id"
    | "daemon_id"
    | "incarnation"
    | "recipient_key_id"
    | "recipient_key_fingerprint"
  >;
  readonly envelope_digest: string;
  readonly execution_locator: RootExecutionLocator;
  readonly installed_at: string;
  readonly machine_proof: RootDeliveryMachineProof;
}

export interface RootDeliveryInstallAckResponse {
  readonly ok: true;
  readonly ack_state: "confirmed";
  readonly run_state: RootDeliveryRunState;
  readonly start_deadline: string | null;
  readonly lease_id: string | null;
  readonly fence_term: string | null;
  readonly idempotent_replay: boolean;
}

/**
 * Non-secret persistent daemon journal entry (§4.3).
 * Never persists raw bearer, decrypted plaintext, process env, or prompt body.
 */
export interface RootDeliveryJournalEntry {
  readonly tuple: RootDeliveryTuple;
  readonly envelope_digest: string;
  readonly state: RootDeliveryReceiverState;
  readonly launch_identity: string | null;
  readonly execution_locator: RootExecutionLocator | null;
  readonly lease_id: string | null;
  readonly fence_term: string | null;
  readonly start_deadline: string | null;
  readonly updated_at: string;
}

/** Fields forbidden on `RootDeliveryStatusResponse` and `RootDeliveryJournalEntry`. */
export const ROOT_DELIVERY_FORBIDDEN_STATUS_FIELDS = [
  "raw",
  "raw_token",
  "rawToken",
  "token",
  "bearer",
  "plaintext",
  "envelope",
  "jwe",
  "frozen_business_payload",
  "material_digest",
  "materialDigest",
] as const;

export function assertStatusResponseHasNoSecrets(value: Readonly<Record<string, unknown>>): void {
  for (const field of ROOT_DELIVERY_FORBIDDEN_STATUS_FIELDS) {
    if (field in value && value[field] !== undefined) {
      throw new Error(`RootDeliveryStatusResponse must not expose secret/envelope field "${field}"`);
    }
  }
}

export function isMonotonicReceiverTransition(
  current: RootDeliveryReceiverState | null,
  next: RootDeliveryReceiverState,
): boolean {
  const order: Record<RootDeliveryReceiverState, number> = {
    received: 0,
    installed: 1,
    confirmed: 2,
    started: 3,
  };
  if (current === null) return next === "received";
  return order[next] >= order[current];
}
