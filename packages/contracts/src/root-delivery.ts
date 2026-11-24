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

import { hasDaemonCapability } from "./daemon-compatibility.js";

export const ROOT_DELIVERY_JWE_ALG = "RSA-OAEP-256" as const;
export const ROOT_DELIVERY_JWE_ENC = "A256GCM" as const;
export const ROOT_DELIVERY_MIN_RSA_BITS = 3072 as const;
export const ROOT_DELIVERY_PROTOCOL_VERSION = 1 as const;
export const ROOT_DELIVERY_CAPABILITY = "root.delivery" as const;
export const ROOT_DELIVERY_MODE = "root_envelope" as const;
export const STANDARD_DELIVERY_MODE = "standard" as const;
export type DaemonDeliveryMode = typeof STANDARD_DELIVERY_MODE | typeof ROOT_DELIVERY_MODE;

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

/** Fields forbidden anywhere (top-level or nested) on `RootDeliveryStatusResponse` and `RootDeliveryJournalEntry`. */
export const ROOT_DELIVERY_FORBIDDEN_STATUS_FIELDS = [
  "auth_token",
  "authToken",
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
  "machine_proof",
  "machineProof",
] as const;

/** Plaintext credential / digest fields forbidden on wire root offers, resumes, and frozen business payloads. */
export const ROOT_DELIVERY_FORBIDDEN_WIRE_SECRET_FIELDS = [
  "auth_token",
  "authToken",
  "raw",
  "raw_token",
  "rawToken",
  "token",
  "bearer",
  "plaintext",
  "material_digest",
  "materialDigest",
] as const;

/**
 * Structured object property names forbidden anywhere inside
 * `frozen_business_payload` (and resume `recovered_questions`), whether at
 * top-level or nested inside child objects/arrays.
 *
 * Plain user text strings mentioning these terms (for example inside message
 * bodies or summaries) are NOT scanned or mutated; only structured object keys
 * are rejected so transport secrets cannot be smuggled inside business JSON.
 */
export const ROOT_DELIVERY_FORBIDDEN_BUSINESS_PAYLOAD_FIELDS = [
  ...ROOT_DELIVERY_FORBIDDEN_WIRE_SECRET_FIELDS,
  "envelope",
  "envelope_digest",
  "envelopeDigest",
  "jwe",
  "machine_proof",
  "machineProof",
] as const;

/** Top-level ordinary offer/resume fields forbidden on typed root delivery frames to prevent downgrade to `handleTask`. */
export const ROOT_OFFER_FORBIDDEN_ORDINARY_FIELDS = [
  "prompt",
  "input_from_seq",
  "input_to_seq",
  "input_messages",
  "task",
] as const;

export type RootDeliveryNegotiationErrorCode =
  | "root_delivery_unsupported"
  | "root_runtime_untrusted";

export type DaemonRootWireRejectCode =
  | "root_delivery_invalid"
  | "root_delivery_unsupported";

export interface RootDeliveryRuntimeCapabilities {
  /** Must equal `ROOT_DELIVERY_PROTOCOL_VERSION` (1); missing means unsupported. */
  readonly root_delivery_protocol?: number;
  /** Must include `"immutable_run_env"`; missing means unsupported. */
  readonly root_carrier_modes?: readonly RootCarrierMode[];
}

/**
 * Inputs required to negotiate root delivery eligibility for a daemon connection
 * and target Runtime. Capability advertisement is a prerequisite, NEVER a substitute
 * for active server-side Runtime and consumer trust.
 */
export interface RootDeliveryNegotiationInput {
  readonly hello_caps: readonly string[];
  readonly welcome_caps: readonly string[];
  readonly runtime_capabilities?: RootDeliveryRuntimeCapabilities | null;
  readonly runtime_trusted: boolean;
  readonly consumer_trusted: boolean;
}

export type RootDeliveryNegotiationResult =
  | {
      readonly eligible: true;
      readonly delivery_mode: typeof ROOT_DELIVERY_MODE;
      readonly root_delivery_protocol: typeof ROOT_DELIVERY_PROTOCOL_VERSION;
      readonly carrier_mode: RootCarrierMode;
    }
  | {
      readonly eligible: false;
      readonly code: RootDeliveryNegotiationErrorCode;
      readonly reason: string;
      readonly downgrade_allowed: false;
    };

/**
 * Evaluates whether a connection + Runtime may send/receive typed root delivery.
 * Fails closed on any missing/malformed input, missing capability, version mismatch,
 * unsupported carrier, or non-explicit Runtime/consumer trust. Never authorizes
 * downgrading a root attempt to an ordinary plaintext `task.offer` or
 * `turn.restart.resume` reply.
 */
export function evaluateRootDeliveryNegotiation(
  input: RootDeliveryNegotiationInput,
): RootDeliveryNegotiationResult {
  if (!isPlainRecord(input)) {
    return {
      eligible: false,
      code: "root_delivery_unsupported",
      reason: "Root delivery negotiation input must be an object.",
      downgrade_allowed: false,
    };
  }
  if (!Array.isArray(input.hello_caps) || !hasDaemonCapability(input.hello_caps, ROOT_DELIVERY_CAPABILITY)) {
    return {
      eligible: false,
      code: "root_delivery_unsupported",
      reason: `Daemon hello.caps is missing required "${ROOT_DELIVERY_CAPABILITY}" capability.`,
      downgrade_allowed: false,
    };
  }
  if (!Array.isArray(input.welcome_caps) || !hasDaemonCapability(input.welcome_caps, ROOT_DELIVERY_CAPABILITY)) {
    return {
      eligible: false,
      code: "root_delivery_unsupported",
      reason: `Server welcome.caps did not negotiate "${ROOT_DELIVERY_CAPABILITY}".`,
      downgrade_allowed: false,
    };
  }
  const runtimeCaps = input.runtime_capabilities;
  if (!isPlainRecord(runtimeCaps) || runtimeCaps.root_delivery_protocol !== ROOT_DELIVERY_PROTOCOL_VERSION) {
    return {
      eligible: false,
      code: "root_delivery_unsupported",
      reason: `Runtime capability root_delivery_protocol must equal ${ROOT_DELIVERY_PROTOCOL_VERSION}.`,
      downgrade_allowed: false,
    };
  }
  if (
    !Array.isArray(runtimeCaps.root_carrier_modes)
    || !runtimeCaps.root_carrier_modes.includes("immutable_run_env")
  ) {
    return {
      eligible: false,
      code: "root_delivery_unsupported",
      reason: `Runtime capability root_carrier_modes must include "immutable_run_env".`,
      downgrade_allowed: false,
    };
  }
  if (input.runtime_trusted !== true || input.consumer_trusted !== true) {
    return {
      eligible: false,
      code: "root_runtime_untrusted",
      reason: "Target Runtime and consumer must both be explicitly trusted for root delivery.",
      downgrade_allowed: false,
    };
  }
  return {
    eligible: true,
    delivery_mode: ROOT_DELIVERY_MODE,
    root_delivery_protocol: ROOT_DELIVERY_PROTOCOL_VERSION,
    carrier_mode: "immutable_run_env",
  };
}

/**
 * Typed initial `task.offer` payload for an eligible root execution (MUL-1 A2).
 *
 * Security invariants:
 * - `delivery_mode: "root_envelope"` explicitly branches the daemon receiver to the
 *   protected root delivery path BEFORE `normalizeDaemonTurnOffer` / `handleTask`.
 * - Reuses `RootDeliveryEnvelopePayload` verbatim so initial offer, restart resume,
 *   and `delivery.receipt.replay` share one immutable recipient-bound JWE payload.
 * - Forbids plaintext secrets (`auth_token`, `raw`, `token`, ...) and top-level
 *   ordinary offer fields (`prompt`, `input_from_seq`, `input_to_seq`, `input_messages`),
 *   ensuring legacy parsers reject it instead of downgrading into `handleTask`.
 */
export interface DaemonRootTaskOfferPayload {
  readonly delivery_mode: typeof ROOT_DELIVERY_MODE;
  readonly root_delivery_protocol: typeof ROOT_DELIVERY_PROTOCOL_VERSION;
  readonly carrier_mode: RootCarrierMode;
  readonly turn_id: string;
  readonly attempt_id: string;
  readonly root_delivery: RootDeliveryEnvelopePayload;
}

export interface DaemonStandardTaskOfferPayload {
  readonly delivery_mode?: typeof STANDARD_DELIVERY_MODE;
  readonly root_delivery?: never;
  readonly root_delivery_protocol?: never;
  readonly carrier_mode?: never;
  readonly turn_id: string;
  readonly attempt_id: string;
  readonly input_from_seq: number;
  readonly input_to_seq: number;
  readonly input_messages: readonly unknown[];
  readonly [key: string]: unknown;
}

export type DaemonTaskOfferPayload =
  | DaemonStandardTaskOfferPayload
  | DaemonRootTaskOfferPayload;

/** Typed `turn.restart.resume` RPC request for an eligible root attempt (MUL-1 A2). */
export interface DaemonRootRestartResumeRequest {
  readonly delivery_mode: typeof ROOT_DELIVERY_MODE;
  readonly root_delivery_protocol: typeof ROOT_DELIVERY_PROTOCOL_VERSION;
  readonly carrier_mode: RootCarrierMode;
  readonly turn_id: string;
  readonly attempt_id: string;
  readonly handoff_id: string;
  readonly generation: number;
  readonly consumer_id: string;
  readonly machine_proof: RootDeliveryMachineProof;
}

export interface DaemonStandardRestartResumeRequest {
  readonly delivery_mode?: typeof STANDARD_DELIVERY_MODE;
  readonly root_delivery_protocol?: never;
  readonly carrier_mode?: never;
  readonly machine_proof?: never;
  readonly turn_id: string;
  readonly attempt_id: string;
  readonly handoff_id: string;
  readonly generation: number;
  readonly consumer_id: string;
}

export type DaemonRestartResumeRequestPayload =
  | DaemonStandardRestartResumeRequest
  | DaemonRootRestartResumeRequest;

/**
 * Typed `turn.restart.resume` RPC reply for an eligible root attempt (MUL-1 A2).
 *
 * Security invariants:
 * - Reuses `RootDeliveryEnvelopePayload` verbatim (`envelope`, `envelope_digest`,
 *   `tuple`, `frozen_business_payload`, `lease_id`, `fence_term`, `run_state`).
 * - Top-level `task` is absent (`task?: never`) so a legacy resume consumer reading
 *   `result.task` fails closed rather than entering ordinary `handleTask`.
 */
export interface DaemonRootRestartResumeReply {
  readonly ok: true;
  readonly delivery_mode: typeof ROOT_DELIVERY_MODE;
  readonly root_delivery_protocol: typeof ROOT_DELIVERY_PROTOCOL_VERSION;
  readonly carrier_mode: RootCarrierMode;
  readonly turn_id: string;
  readonly attempt_id: string;
  readonly handoff_id: string;
  readonly generation: number;
  readonly root_delivery: RootDeliveryEnvelopePayload;
  readonly recovered_questions: readonly unknown[];
  readonly task?: never;
}

export interface DaemonStandardRestartResumeReply {
  readonly ok: true;
  readonly delivery_mode?: typeof STANDARD_DELIVERY_MODE;
  readonly root_delivery?: never;
  readonly root_delivery_protocol?: never;
  readonly carrier_mode?: never;
  readonly generation: number;
  readonly task: Readonly<Record<string, unknown>>;
  readonly recovered_questions: readonly unknown[];
}

export type DaemonRestartResumeReplyPayload =
  | DaemonStandardRestartResumeReply
  | DaemonRootRestartResumeReply;

export type DaemonTaskOfferClassification =
  | { readonly kind: "standard" }
  | { readonly kind: "root"; readonly payload: DaemonRootTaskOfferPayload }
  | { readonly kind: "invalid_root"; readonly code: DaemonRootWireRejectCode; readonly reason: string };

export type DaemonRestartResumeRequestClassification =
  | { readonly kind: "standard" }
  | { readonly kind: "root"; readonly payload: DaemonRootRestartResumeRequest }
  | { readonly kind: "invalid_root"; readonly code: DaemonRootWireRejectCode; readonly reason: string };

export type DaemonRestartResumeReplyClassification =
  | { readonly kind: "standard" }
  | { readonly kind: "root"; readonly payload: DaemonRootRestartResumeReply }
  | { readonly kind: "invalid_root"; readonly code: DaemonRootWireRejectCode; readonly reason: string };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, maxLen = 512): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLen;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

const MAX_STRUCTURED_SCAN_DEPTH = 32;

const FORBIDDEN_STATUS_FIELD_SET: ReadonlySet<string> = new Set(ROOT_DELIVERY_FORBIDDEN_STATUS_FIELDS);
const FORBIDDEN_WIRE_SECRET_FIELD_SET: ReadonlySet<string> = new Set(ROOT_DELIVERY_FORBIDDEN_WIRE_SECRET_FIELDS);
const FORBIDDEN_BUSINESS_PAYLOAD_FIELD_SET: ReadonlySet<string> = new Set(
  ROOT_DELIVERY_FORBIDDEN_BUSINESS_PAYLOAD_FIELDS,
);

function findForbiddenField(
  record: Readonly<Record<string, unknown>>,
  forbidden: readonly string[],
): string | null {
  for (const field of forbidden) {
    if (field in record && record[field] !== undefined) return field;
  }
  return null;
}

type StructuredScanResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: "forbidden_field"; readonly path: string; readonly field: string }
  | { readonly ok: false; readonly kind: "invalid_structure"; readonly reason: string };

/**
 * Recursively scans structured objects and arrays for forbidden own property
 * names without inspecting or mutating primitive string values (preserving
 * legitimate user prose). Fails closed on circular references, excessive
 * nesting depth, or (when `requireJsonSafe` is set) non-JSON-safe values.
 */
function scanStructuredValue(
  value: unknown,
  forbiddenSet: ReadonlySet<string>,
  requireJsonSafe: boolean,
  path = "",
  depth = 0,
  ancestors = new WeakSet<object>(),
): StructuredScanResult {
  if (depth > MAX_STRUCTURED_SCAN_DEPTH) {
    return {
      ok: false,
      kind: "invalid_structure",
      reason: `exceeds maximum nesting depth (${MAX_STRUCTURED_SCAN_DEPTH})`,
    };
  }
  if (value === null || value === undefined) {
    return { ok: true };
  }
  const valueType = typeof value;
  if (valueType === "string" || valueType === "boolean") {
    return { ok: true };
  }
  if (valueType === "number") {
    if (requireJsonSafe && !Number.isFinite(value)) {
      return {
        ok: false,
        kind: "invalid_structure",
        reason: `contains non-finite number${path ? ` at "${path}"` : ""}`,
      };
    }
    return { ok: true };
  }
  if (valueType !== "object") {
    if (requireJsonSafe) {
      return {
        ok: false,
        kind: "invalid_structure",
        reason: `contains unsupported ${valueType} value${path ? ` at "${path}"` : ""}`,
      };
    }
    return { ok: true };
  }

  const obj = value as object;
  if (ancestors.has(obj)) {
    return {
      ok: false,
      kind: "invalid_structure",
      reason: `contains circular reference${path ? ` at "${path}"` : ""}`,
    };
  }
  ancestors.add(obj);
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        const entryPath = `${path}[${i}]`;
        const childResult = scanStructuredValue(
          value[i],
          forbiddenSet,
          requireJsonSafe,
          entryPath,
          depth + 1,
          ancestors,
        );
        if (!childResult.ok) return childResult;
      }
      return { ok: true };
    }
    if (!isPlainRecord(value)) {
      if (requireJsonSafe) {
        return {
          ok: false,
          kind: "invalid_structure",
          reason: `contains non-plain object${path ? ` at "${path}"` : ""}`,
        };
      }
      return { ok: true };
    }
    for (const [key, member] of Object.entries(value)) {
      if (member === undefined) continue;
      const keyPath = path ? `${path}.${key}` : key;
      if (forbiddenSet.has(key)) {
        return { ok: false, kind: "forbidden_field", path: keyPath, field: key };
      }
      const childResult = scanStructuredValue(
        member,
        forbiddenSet,
        requireJsonSafe,
        keyPath,
        depth + 1,
        ancestors,
      );
      if (!childResult.ok) return childResult;
    }
    return { ok: true };
  } finally {
    ancestors.delete(obj);
  }
}

/**
 * Returns the first dotted/indexed path of a forbidden structured transport
 * secret key found anywhere inside `payload`, or `null` when clean.
 * Plain string values are never inspected or modified.
 */
export function findForbiddenBusinessPayloadField(payload: unknown): string | null {
  const result = scanStructuredValue(payload, FORBIDDEN_BUSINESS_PAYLOAD_FIELD_SET, false);
  return !result.ok && result.kind === "forbidden_field" ? result.path : null;
}

/**
 * Validates that a `frozen_business_payload` (or nested business projection)
 * is a JSON-safe plain object containing no top-level or nested structured
 * transport secret keys (`auth_token`, `raw`, `envelope`, `machine_proof`, ...).
 */
export function assertFrozenBusinessPayloadHasNoTransportSecrets(
  payload: unknown,
  label = "frozen_business_payload",
): void {
  if (!isPlainRecord(payload)) {
    throw new Error(`${label} must be an object`);
  }
  const scan = scanStructuredValue(payload, FORBIDDEN_BUSINESS_PAYLOAD_FIELD_SET, true);
  if (!scan.ok) {
    if (scan.kind === "forbidden_field") {
      throw new Error(`${label} must not contain transport secret field "${scan.path}"`);
    }
    throw new Error(`${label} ${scan.reason}`);
  }
}

const ROOT_DELIVERY_TUPLE_KEYS: ReadonlySet<string> = new Set([
  "receipt_id",
  "receipt_version",
  "delivery_version",
  "material_version",
  "attempt_id",
  "handoff_id",
  "handoff_generation",
  "run_generation",
  "consumer_id",
  "runtime_id",
  "daemon_id",
  "incarnation",
  "recipient_key_id",
  "recipient_key_fingerprint",
  "execution_config_epoch",
  "execution_digest",
  "input_revision",
  "input_digest",
  "checkpoint_digest",
  "grant_id",
  "grant_generation",
  "material_expires_at",
  "business_payload_digest",
]);

function validateRootDeliveryTupleShape(value: unknown): string | null {
  if (!isPlainRecord(value)) return "root_delivery.tuple must be an object";
  const secretField = findForbiddenField(value, ROOT_DELIVERY_FORBIDDEN_WIRE_SECRET_FIELDS);
  if (secretField) return `root_delivery.tuple must not contain secret field "${secretField}"`;
  const keys = Object.keys(value);
  if (keys.length !== ROOT_DELIVERY_TUPLE_KEYS.size || keys.some((key) => !ROOT_DELIVERY_TUPLE_KEYS.has(key))) {
    return "root_delivery.tuple must contain the exact 23 RootDeliveryTuple fields";
  }
  const requiredNonEmptyStrings = [
    "receipt_id",
    "attempt_id",
    "consumer_id",
    "runtime_id",
    "daemon_id",
    "incarnation",
    "recipient_key_id",
    "recipient_key_fingerprint",
    "execution_digest",
    "input_digest",
    "material_expires_at",
    "business_payload_digest",
  ] as const;
  for (const field of requiredNonEmptyStrings) {
    if (!isNonEmptyString(value[field])) return `root_delivery.tuple.${field} must be a non-empty string`;
  }
  const nullableStrings = ["handoff_id", "checkpoint_digest", "grant_id"] as const;
  for (const field of nullableStrings) {
    if (value[field] !== null && !isNonEmptyString(value[field])) {
      return `root_delivery.tuple.${field} must be null or a non-empty string`;
    }
  }
  if (value.grant_generation !== null && !isNonNegativeInt(value.grant_generation)) {
    return "root_delivery.tuple.grant_generation must be null or a non-negative integer";
  }
  const nonNegativeInts = [
    "receipt_version",
    "delivery_version",
    "material_version",
    "handoff_generation",
    "run_generation",
    "execution_config_epoch",
    "input_revision",
  ] as const;
  for (const field of nonNegativeInts) {
    if (!isNonNegativeInt(value[field])) return `root_delivery.tuple.${field} must be a non-negative integer`;
  }
  if (!isPositiveInt(value.receipt_version) || !isPositiveInt(value.delivery_version) || !isPositiveInt(value.material_version)) {
    return "root_delivery.tuple receipt/delivery/material versions must be >= 1";
  }
  return null;
}

function validateRootDeliveryEnvelopePayloadShape(value: unknown): string | null {
  if (!isPlainRecord(value)) return "root_delivery must be an object";
  const secretField = findForbiddenField(value, ROOT_DELIVERY_FORBIDDEN_WIRE_SECRET_FIELDS);
  if (secretField) return `root_delivery must not contain plaintext secret field "${secretField}"`;
  const tupleErr = validateRootDeliveryTupleShape(value.tuple);
  if (tupleErr) return tupleErr;
  if (!isNonEmptyString(value.envelope, 65536)) return "root_delivery.envelope must be a non-empty JWE compact string";
  if (!isNonEmptyString(value.envelope_digest)) return "root_delivery.envelope_digest must be a non-empty string";
  if (!isPlainRecord(value.frozen_business_payload)) {
    return "root_delivery.frozen_business_payload must be an object";
  }
  const payloadScan = scanStructuredValue(
    value.frozen_business_payload,
    FORBIDDEN_BUSINESS_PAYLOAD_FIELD_SET,
    true,
  );
  if (!payloadScan.ok) {
    return payloadScan.kind === "forbidden_field"
      ? `root_delivery.frozen_business_payload must not contain transport secret field "${payloadScan.path}"`
      : `root_delivery.frozen_business_payload ${payloadScan.reason}`;
  }
  if (value.start_deadline !== null && !isNonEmptyString(value.start_deadline)) {
    return "root_delivery.start_deadline must be null or a non-empty ISO string";
  }
  if (value.lease_id !== null && !isNonEmptyString(value.lease_id)) {
    return "root_delivery.lease_id must be null or a non-empty string";
  }
  if (value.fence_term !== null && !isNonEmptyString(value.fence_term)) {
    return "root_delivery.fence_term must be null or a non-empty string";
  }
  if (value.run_state !== "pending_start" && value.run_state !== "running") {
    return `root_delivery.run_state must be "pending_start" or "running"`;
  }
  return null;
}

function validateMachineProofShape(value: unknown): string | null {
  if (!isPlainRecord(value)) return "machine_proof must be an object";
  const secretField = findForbiddenField(value, ROOT_DELIVERY_FORBIDDEN_WIRE_SECRET_FIELDS);
  if (secretField) return `machine_proof must not contain secret field "${secretField}"`;
  const fields = [
    "consumer_id",
    "runtime_id",
    "daemon_id",
    "incarnation",
    "recipient_key_id",
    "recipient_key_fingerprint",
    "nonce",
    "signature",
    "signed_at",
  ] as const;
  for (const field of fields) {
    if (!isNonEmptyString(value[field], 4096)) return `machine_proof.${field} must be a non-empty string`;
  }
  return null;
}

function hasRootWireIndicators(record: Readonly<Record<string, unknown>>, extraKeys: readonly string[] = []): boolean {
  if ("delivery_mode" in record && record.delivery_mode !== undefined && record.delivery_mode !== STANDARD_DELIVERY_MODE) {
    return true;
  }
  for (const key of ["root_delivery", "root_delivery_protocol", "carrier_mode", ...extraKeys]) {
    if (key in record && record[key] !== undefined) return true;
  }
  return false;
}

export function assertRootWirePayloadHasNoPlaintextSecrets(
  value: Readonly<Record<string, unknown>>,
  label = "root wire payload",
): void {
  const scan = scanStructuredValue(value, FORBIDDEN_WIRE_SECRET_FIELD_SET, false);
  if (!scan.ok) {
    if (scan.kind === "forbidden_field") {
      throw new Error(`${label} must not expose plaintext secret field "${scan.path}"`);
    }
    throw new Error(`${label} ${scan.reason}`);
  }
}

/**
 * Classifies an inbound `task.offer` frame payload BEFORE `normalizeDaemonTurnOffer`.
 * Any frame carrying root indicators that fails validation returns `invalid_root`
 * and MUST be rejected without downgrading to `"standard"` / `handleTask`.
 */
export function classifyDaemonTaskOfferPayload(payload: unknown): DaemonTaskOfferClassification {
  if (!isPlainRecord(payload)) {
    return { kind: "standard" };
  }
  if (!hasRootWireIndicators(payload)) {
    return { kind: "standard" };
  }
  if (payload.delivery_mode !== ROOT_DELIVERY_MODE) {
    return {
      kind: "invalid_root",
      code: "root_delivery_invalid",
      reason: `Root task.offer must set delivery_mode="${ROOT_DELIVERY_MODE}".`,
    };
  }
  if (payload.root_delivery_protocol !== ROOT_DELIVERY_PROTOCOL_VERSION) {
    return {
      kind: "invalid_root",
      code: "root_delivery_unsupported",
      reason: `Unsupported root_delivery_protocol: expected ${ROOT_DELIVERY_PROTOCOL_VERSION}.`,
    };
  }
  if (payload.carrier_mode !== "immutable_run_env") {
    return {
      kind: "invalid_root",
      code: "root_delivery_unsupported",
      reason: `Unsupported root carrier_mode: expected "immutable_run_env".`,
    };
  }
  const secretField = findForbiddenField(payload, ROOT_DELIVERY_FORBIDDEN_WIRE_SECRET_FIELDS);
  if (secretField) {
    return {
      kind: "invalid_root",
      code: "root_delivery_invalid",
      reason: `Root task.offer must not carry plaintext secret field "${secretField}".`,
    };
  }
  const ordinaryField = findForbiddenField(payload, ROOT_OFFER_FORBIDDEN_ORDINARY_FIELDS);
  if (ordinaryField) {
    return {
      kind: "invalid_root",
      code: "root_delivery_invalid",
      reason: `Root task.offer must not carry ordinary offer field "${ordinaryField}".`,
    };
  }
  if (!isNonEmptyString(payload.turn_id) || !isNonEmptyString(payload.attempt_id)) {
    return {
      kind: "invalid_root",
      code: "root_delivery_invalid",
      reason: "Root task.offer requires non-empty turn_id and attempt_id.",
    };
  }
  const envelopeErr = validateRootDeliveryEnvelopePayloadShape(payload.root_delivery);
  if (envelopeErr) {
    return { kind: "invalid_root", code: "root_delivery_invalid", reason: envelopeErr };
  }
  const delivery = payload.root_delivery as RootDeliveryEnvelopePayload;
  if (delivery.tuple.attempt_id !== payload.attempt_id) {
    return {
      kind: "invalid_root",
      code: "root_delivery_invalid",
      reason: "Root task.offer attempt_id does not match root_delivery.tuple.attempt_id.",
    };
  }
  if (delivery.tuple.handoff_id !== null) {
    return {
      kind: "invalid_root",
      code: "root_delivery_invalid",
      reason: "Initial root task.offer must have root_delivery.tuple.handoff_id === null.",
    };
  }
  if (delivery.frozen_business_payload.turn_id !== payload.turn_id) {
    return {
      kind: "invalid_root",
      code: "root_delivery_invalid",
      reason: "Root task.offer turn_id must match root_delivery.frozen_business_payload.turn_id.",
    };
  }
  return {
    kind: "root",
    payload: payload as unknown as DaemonRootTaskOfferPayload,
  };
}

/**
 * Classifies an inbound `turn.restart.resume` RPC request on the server.
 * Any request carrying root indicators that fails validation returns `invalid_root`
 * and MUST be rejected rather than falling back to ordinary plaintext resume.
 */
export function classifyDaemonRestartResumeRequest(payload: unknown): DaemonRestartResumeRequestClassification {
  if (!isPlainRecord(payload)) {
    return { kind: "standard" };
  }
  if (!hasRootWireIndicators(payload, ["machine_proof"])) {
    return { kind: "standard" };
  }
  if (payload.delivery_mode !== ROOT_DELIVERY_MODE) {
    return {
      kind: "invalid_root",
      code: "root_delivery_invalid",
      reason: `Root turn.restart.resume request must set delivery_mode="${ROOT_DELIVERY_MODE}".`,
    };
  }
  if (payload.root_delivery_protocol !== ROOT_DELIVERY_PROTOCOL_VERSION) {
    return {
      kind: "invalid_root",
      code: "root_delivery_unsupported",
      reason: `Unsupported root_delivery_protocol: expected ${ROOT_DELIVERY_PROTOCOL_VERSION}.`,
    };
  }
  if (payload.carrier_mode !== "immutable_run_env") {
    return {
      kind: "invalid_root",
      code: "root_delivery_unsupported",
      reason: `Unsupported root carrier_mode: expected "immutable_run_env".`,
    };
  }
  const secretField = findForbiddenField(payload, ROOT_DELIVERY_FORBIDDEN_WIRE_SECRET_FIELDS);
  if (secretField) {
    return {
      kind: "invalid_root",
      code: "root_delivery_invalid",
      reason: `Root turn.restart.resume request must not carry plaintext secret field "${secretField}".`,
    };
  }
  if (
    !isNonEmptyString(payload.turn_id)
    || !isNonEmptyString(payload.attempt_id)
    || !isNonEmptyString(payload.handoff_id)
    || !isNonNegativeInt(payload.generation)
    || typeof payload.consumer_id !== "string"
    || payload.consumer_id.length < 16
    || payload.consumer_id.length > 256
  ) {
    return {
      kind: "invalid_root",
      code: "root_delivery_invalid",
      reason: "Root turn.restart.resume request requires turn_id, attempt_id, handoff_id, generation, and consumer_id (16..256 chars).",
    };
  }
  const proofErr = validateMachineProofShape(payload.machine_proof);
  if (proofErr) {
    return { kind: "invalid_root", code: "root_delivery_invalid", reason: proofErr };
  }
  const proof = payload.machine_proof as RootDeliveryMachineProof;
  if (proof.consumer_id !== payload.consumer_id) {
    return {
      kind: "invalid_root",
      code: "root_delivery_invalid",
      reason: "Root turn.restart.resume machine_proof.consumer_id must match request consumer_id.",
    };
  }
  return {
    kind: "root",
    payload: payload as unknown as DaemonRootRestartResumeRequest,
  };
}

/**
 * Classifies a `turn.restart.resume` RPC reply on the daemon BEFORE reading `result.task`.
 * Any reply carrying root indicators that fails validation returns `invalid_root`
 * and MUST be rejected rather than downgrading to ordinary `normalizeDaemonTurnOffer(result.task)`.
 */
export function classifyDaemonRestartResumeReply(payload: unknown): DaemonRestartResumeReplyClassification {
  if (!isPlainRecord(payload)) {
    return { kind: "standard" };
  }
  if (!hasRootWireIndicators(payload)) {
    return { kind: "standard" };
  }
  if (payload.ok !== true) {
    return {
      kind: "invalid_root",
      code: "root_delivery_invalid",
      reason: "Root turn.restart.resume reply must set ok=true.",
    };
  }
  if (payload.delivery_mode !== ROOT_DELIVERY_MODE) {
    return {
      kind: "invalid_root",
      code: "root_delivery_invalid",
      reason: `Root turn.restart.resume reply must set delivery_mode="${ROOT_DELIVERY_MODE}".`,
    };
  }
  if (payload.root_delivery_protocol !== ROOT_DELIVERY_PROTOCOL_VERSION) {
    return {
      kind: "invalid_root",
      code: "root_delivery_unsupported",
      reason: `Unsupported root_delivery_protocol: expected ${ROOT_DELIVERY_PROTOCOL_VERSION}.`,
    };
  }
  if (payload.carrier_mode !== "immutable_run_env") {
    return {
      kind: "invalid_root",
      code: "root_delivery_unsupported",
      reason: `Unsupported root carrier_mode: expected "immutable_run_env".`,
    };
  }
  const secretField = findForbiddenField(payload, ROOT_DELIVERY_FORBIDDEN_WIRE_SECRET_FIELDS);
  if (secretField) {
    return {
      kind: "invalid_root",
      code: "root_delivery_invalid",
      reason: `Root turn.restart.resume reply must not carry plaintext secret field "${secretField}".`,
    };
  }
  const ordinaryField = findForbiddenField(payload, ROOT_OFFER_FORBIDDEN_ORDINARY_FIELDS);
  if (ordinaryField) {
    return {
      kind: "invalid_root",
      code: "root_delivery_invalid",
      reason: `Root turn.restart.resume reply must not carry ordinary field "${ordinaryField}".`,
    };
  }
  if (
    !isNonEmptyString(payload.turn_id)
    || !isNonEmptyString(payload.attempt_id)
    || !isNonEmptyString(payload.handoff_id)
    || !isPositiveInt(payload.generation)
    || !Array.isArray(payload.recovered_questions)
  ) {
    return {
      kind: "invalid_root",
      code: "root_delivery_invalid",
      reason: "Root turn.restart.resume reply requires turn_id, attempt_id, handoff_id, generation >= 1, and recovered_questions array.",
    };
  }
  const questionsScan = scanStructuredValue(
    payload.recovered_questions,
    FORBIDDEN_BUSINESS_PAYLOAD_FIELD_SET,
    true,
  );
  if (!questionsScan.ok) {
    return {
      kind: "invalid_root",
      code: "root_delivery_invalid",
      reason: questionsScan.kind === "forbidden_field"
        ? `Root turn.restart.resume reply recovered_questions must not contain transport secret field "${questionsScan.path}".`
        : `Root turn.restart.resume reply recovered_questions ${questionsScan.reason}.`,
    };
  }
  const envelopeErr = validateRootDeliveryEnvelopePayloadShape(payload.root_delivery);
  if (envelopeErr) {
    return { kind: "invalid_root", code: "root_delivery_invalid", reason: envelopeErr };
  }
  const delivery = payload.root_delivery as RootDeliveryEnvelopePayload;
  if (delivery.tuple.attempt_id !== payload.attempt_id) {
    return {
      kind: "invalid_root",
      code: "root_delivery_invalid",
      reason: "Root turn.restart.resume reply attempt_id does not match root_delivery.tuple.attempt_id.",
    };
  }
  if (delivery.tuple.handoff_id !== payload.handoff_id) {
    return {
      kind: "invalid_root",
      code: "root_delivery_invalid",
      reason: "Root turn.restart.resume reply handoff_id does not match root_delivery.tuple.handoff_id.",
    };
  }
  if (delivery.tuple.handoff_generation !== payload.generation) {
    return {
      kind: "invalid_root",
      code: "root_delivery_invalid",
      reason: "Root turn.restart.resume reply generation does not match root_delivery.tuple.handoff_generation.",
    };
  }
  if (delivery.frozen_business_payload.turn_id !== payload.turn_id) {
    return {
      kind: "invalid_root",
      code: "root_delivery_invalid",
      reason: "Root turn.restart.resume reply turn_id must match root_delivery.frozen_business_payload.turn_id.",
    };
  }
  return {
    kind: "root",
    payload: payload as unknown as DaemonRootRestartResumeReply,
  };
}

/** Validated builder for initial root `task.offer` wire payloads. */
export function buildDaemonRootTaskOfferPayload(input: {
  readonly turn_id: string;
  readonly attempt_id: string;
  readonly root_delivery: RootDeliveryEnvelopePayload;
  readonly carrier_mode?: RootCarrierMode;
}): DaemonRootTaskOfferPayload {
  const candidate: DaemonRootTaskOfferPayload = {
    delivery_mode: ROOT_DELIVERY_MODE,
    root_delivery_protocol: ROOT_DELIVERY_PROTOCOL_VERSION,
    carrier_mode: input.carrier_mode ?? "immutable_run_env",
    turn_id: input.turn_id,
    attempt_id: input.attempt_id,
    root_delivery: input.root_delivery,
  };
  const classified = classifyDaemonTaskOfferPayload(candidate);
  if (classified.kind !== "root") {
    throw new Error(classified.kind === "invalid_root" ? classified.reason : "Invalid root task.offer payload");
  }
  return classified.payload;
}

/** Validated builder for root `turn.restart.resume` RPC success replies. */
export function buildDaemonRootRestartResumeReply(input: {
  readonly turn_id: string;
  readonly attempt_id: string;
  readonly handoff_id: string;
  readonly generation: number;
  readonly root_delivery: RootDeliveryEnvelopePayload;
  readonly recovered_questions?: readonly unknown[];
  readonly carrier_mode?: RootCarrierMode;
}): DaemonRootRestartResumeReply {
  const candidate: DaemonRootRestartResumeReply = {
    ok: true,
    delivery_mode: ROOT_DELIVERY_MODE,
    root_delivery_protocol: ROOT_DELIVERY_PROTOCOL_VERSION,
    carrier_mode: input.carrier_mode ?? "immutable_run_env",
    turn_id: input.turn_id,
    attempt_id: input.attempt_id,
    handoff_id: input.handoff_id,
    generation: input.generation,
    root_delivery: input.root_delivery,
    recovered_questions: input.recovered_questions ?? [],
  };
  const classified = classifyDaemonRestartResumeReply(candidate);
  if (classified.kind !== "root") {
    throw new Error(classified.kind === "invalid_root" ? classified.reason : "Invalid root turn.restart.resume reply");
  }
  return classified.payload;
}

export function assertStatusResponseHasNoSecrets(value: Readonly<Record<string, unknown>>): void {
  const scan = scanStructuredValue(value, FORBIDDEN_STATUS_FIELD_SET, false);
  if (!scan.ok) {
    if (scan.kind === "forbidden_field") {
      throw new Error(`RootDeliveryStatusResponse must not expose secret/envelope field "${scan.path}"`);
    }
    throw new Error(`RootDeliveryStatusResponse ${scan.reason}`);
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
