/**
 * MUL-1 public contracts for system root authority, grants, Runtime trust,
 * credential-family revocation, audit projections, and public error envelopes.
 *
 * Security boundary (§10.1):
 * - This module defines ONLY public HTTP/CLI/UI/shared DTOs.
 * - Internal kernel types (`SecurityTx`, `VerifiedProof`, raw bearer tokens,
 *   compact-token digests, password hashes, JWE plaintext) MUST NEVER be added
 *   or exported here.
 * - System root is orthogonal to `MultiremiAgentRole` (`normal | maintainer | supervisor`);
 *   no fourth business role is introduced.
 */

export const ROOT_SCOPE = "system" as const;
export type RootScope = typeof ROOT_SCOPE;

export const ROOT_SUBJECT_TYPES = ["user", "agent"] as const;
export type RootSubjectType = (typeof ROOT_SUBJECT_TYPES)[number];

export interface RootSubjectRef {
  readonly type: RootSubjectType;
  readonly id: string;
}

export type RootActorRef =
  | RootSubjectRef
  | { readonly type: "deployment" | "system"; readonly id: string };

export const ROOT_GRANT_STATUSES = ["active", "revoked", "expired"] as const;
export type RootGrantStatus = (typeof ROOT_GRANT_STATUSES)[number];

export const ROOT_RUNTIME_TRUST_STATUSES = ["active", "revoked", "expired"] as const;
export type RootRuntimeTrustStatus = (typeof ROOT_RUNTIME_TRUST_STATUSES)[number];

export const ROOT_ATTEMPT_ELIGIBILITIES = ["none", "root"] as const;
export type RootAttemptEligibility = (typeof ROOT_ATTEMPT_ELIGIBILITIES)[number];

export const ROOT_TRANSPORT_IDENTITIES = [
  "human",
  "task",
  "daemon",
  "share",
  "master",
  "open_local",
] as const;
export type RootTransportIdentity = (typeof ROOT_TRANSPORT_IDENTITIES)[number];

export const ROOT_EFFECTIVE_REASON_CODES = [
  "active",
  "no_grant",
  "grant_revoked",
  "grant_expired",
  "ancestor_revoked",
  "attempt_not_eligible",
  "attempt_terminal",
  "runtime_untrusted",
  "trust_revoked",
  "config_epoch_mismatch",
  "input_unapproved",
  "feature_disabled",
  "unverified_human_auth",
  "unknown",
] as const;
export type RootEffectiveReasonCode = (typeof ROOT_EFFECTIVE_REASON_CODES)[number];

/** Frozen lifecycle / security event reason enum (§5.4). */
export const ROOT_SECURITY_EVENT_REASONS = [
  "execution_terminal",
  "expired",
  "rotated",
  "purpose_consumed",
  "security_compromised",
  "operator_security_revoke",
  "ancestor_revoked",
  "trust_revoked",
  "grant_revoked",
  "family_ceiling_reached",
] as const;
export type RootSecurityEventReasonCode = (typeof ROOT_SECURITY_EVENT_REASONS)[number];

/** Subset of reasons that revoke durable security provenance and descendants (§5.4). */
export const ROOT_SECURITY_REVOKE_REASONS = [
  "security_compromised",
  "operator_security_revoke",
  "ancestor_revoked",
  "trust_revoked",
  "grant_revoked",
  "family_ceiling_reached",
] as const satisfies readonly RootSecurityEventReasonCode[];
export type RootSecurityRevokeReasonCode = (typeof ROOT_SECURITY_REVOKE_REASONS)[number];

/** Canonical §10.1 public error codes for root authority & delivery conflicts. */
export const ROOT_PUBLIC_ERROR_CODES = [
  "root_required",
  "root_attempt_not_eligible",
  "root_authority_revoked",
  "root_runtime_untrusted",
  "root_invoker_untrusted",
  "root_input_unapproved",
  "root_execution_protected",
  "authority_revision_conflict",
  "credential_version_conflict",
  "receipt_conflict",
  "authority_depth_exceeded",
  "security_state_unavailable",
] as const;
export type RootPublicErrorCode = (typeof ROOT_PUBLIC_ERROR_CODES)[number];

export const ROOT_PUBLIC_ERROR_HTTP_STATUS: Readonly<Record<RootPublicErrorCode, 401 | 403 | 409 | 503>> = {
  root_required: 403,
  root_attempt_not_eligible: 403,
  root_authority_revoked: 401,
  root_runtime_untrusted: 403,
  root_invoker_untrusted: 403,
  root_input_unapproved: 403,
  root_execution_protected: 403,
  authority_revision_conflict: 409,
  credential_version_conflict: 409,
  receipt_conflict: 409,
  authority_depth_exceeded: 403,
  security_state_unavailable: 503,
};

export const ROOT_PUBLIC_ERROR_RETRYABLE: Readonly<Record<RootPublicErrorCode, boolean>> = {
  root_required: false,
  root_attempt_not_eligible: false,
  root_authority_revoked: false,
  root_runtime_untrusted: false,
  root_invoker_untrusted: false,
  root_input_unapproved: false,
  root_execution_protected: false,
  authority_revision_conflict: true,
  credential_version_conflict: true,
  receipt_conflict: true,
  authority_depth_exceeded: false,
  security_state_unavailable: true,
};

const ROOT_PUBLIC_ERROR_CODE_SET: ReadonlySet<string> = new Set(ROOT_PUBLIC_ERROR_CODES);

export function isRootPublicErrorCode(value: unknown): value is RootPublicErrorCode {
  return typeof value === "string" && ROOT_PUBLIC_ERROR_CODE_SET.has(value);
}

/** Common public error envelope frozen in §10.1. Never includes secrets or internal tx state. */
export interface PublicErrorDetail {
  readonly code: RootPublicErrorCode | string;
  readonly message: string;
  readonly retryable: boolean;
  readonly requestId: string;
  readonly currentRevision?: number;
}

export interface PublicErrorEnvelope {
  readonly error: PublicErrorDetail;
}

export function createPublicErrorEnvelope(input: {
  code: RootPublicErrorCode | string;
  message: string;
  requestId: string;
  retryable?: boolean;
  currentRevision?: number;
}): PublicErrorEnvelope {
  const retryable = input.retryable ?? (isRootPublicErrorCode(input.code) ? ROOT_PUBLIC_ERROR_RETRYABLE[input.code] : false);
  return {
    error: {
      code: input.code,
      message: input.message,
      retryable,
      requestId: input.requestId,
      ...(input.currentRevision === undefined ? {} : { currentRevision: input.currentRevision }),
    },
  };
}

export function parsePublicErrorEnvelope(value: unknown): PublicErrorEnvelope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rawError = (value as Record<string, unknown>).error;
  if (!rawError || typeof rawError !== "object" || Array.isArray(rawError)) return null;
  const err = rawError as Record<string, unknown>;
  if (typeof err.code !== "string" || !err.code.trim()) return null;
  if (typeof err.message !== "string") return null;
  const retryable = typeof err.retryable === "boolean"
    ? err.retryable
    : isRootPublicErrorCode(err.code)
      ? ROOT_PUBLIC_ERROR_RETRYABLE[err.code]
      : false;
  const requestId = typeof err.requestId === "string" ? err.requestId : "";
  const currentRevision = typeof err.currentRevision === "number" && Number.isSafeInteger(err.currentRevision)
    ? err.currentRevision
    : undefined;
  return {
    error: {
      code: err.code,
      message: err.message,
      retryable,
      requestId,
      ...(currentRevision === undefined ? {} : { currentRevision }),
    },
  };
}

/**
 * Read-only fields that MUST NOT be accepted as writable Agent/Runtime inputs
 * on create, update, template, default, clone, or import paths (§8.2, §10.1).
 */
export const ROOT_READONLY_WRITE_FIELDS = [
  "root",
  "root_grant",
  "rootGrant",
  "root_trust",
  "rootTrust",
  "attempt_authority",
  "attemptAuthority",
  "provenance",
  "authority_node_id",
  "authorityNodeId",
  "grant_generation",
  "grantGeneration",
  "effective_root",
  "effectiveRoot",
] as const;

export function stripRootReadonlyFields<T extends Record<string, unknown>>(payload: T): Record<string, unknown> {
  const blocked = new Set<string>(ROOT_READONLY_WRITE_FIELDS);
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !blocked.has(key)));
}

export function findRootReadonlyFields(payload: Readonly<Record<string, unknown>>): string[] {
  const blocked = new Set<string>(ROOT_READONLY_WRITE_FIELDS);
  return Object.keys(payload).filter((key) => blocked.has(key));
}

/** Read-only root projection attached to Agent / User / Context responses (§3). */
export interface RootSubjectProjection {
  readonly granted: boolean;
  readonly grant_id: string | null;
  readonly generation: number | null;
  readonly effective: boolean;
  readonly reason_code: RootEffectiveReasonCode | string;
  readonly scope: RootScope | null;
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
}

/** Compact read-only trust summary embedded on Runtime responses. */
export interface RootRuntimeTrustSummary {
  readonly trusted: boolean;
  readonly trust_id: string | null;
  readonly generation: number | null;
  readonly status: RootRuntimeTrustStatus | "untrusted";
  readonly incarnation: string | null;
  readonly recipient_key_id: string | null;
  readonly expires_at: string | null;
}

/** Public notice that external long-lived secrets were previously read and cannot be pulled back by revoke (§5.2, E10). */
export interface RootExposedSecretNotice {
  readonly target_type: string;
  readonly target_id: string;
  readonly secret_version: string | null;
  readonly accessed_at: string;
  readonly rotation_required: true;
  readonly note: string;
}

export interface RootCapabilitiesSummary {
  readonly can_manage_root: boolean;
  readonly can_edit_root_execution: boolean;
  readonly can_manage_runtime_trust: boolean;
  readonly can_revoke_credential_family: boolean;
  readonly can_read_root_audit: boolean;
}

/** `GET /api/root/context` public DTO (§8.1, §8.2, §10.1). */
export interface RootContextResponse {
  readonly security_revision: number;
  readonly feature_activation: boolean;
  readonly bootstrap_completed: boolean;
  readonly transport_identity: RootTransportIdentity;
  readonly authenticated_subject: RootSubjectRef | null;
  readonly beneficiary_user_id: string | null;
  readonly is_agent_origin: boolean;
  readonly credential_id: string | null;
  readonly family_id: string | null;
  readonly origin_attempt_id: string | null;
  readonly current_attempt_id: string | null;
  readonly agent_granted_root: boolean;
  readonly current_attempt_effective_root: boolean;
  readonly effective_root: boolean;
  readonly effective_reason_code: RootEffectiveReasonCode | string;
  readonly grant_id: string | null;
  readonly grant_generation: number | null;
  readonly capabilities: RootCapabilitiesSummary;
  readonly allowed_operations: readonly string[];
}

export interface RootGrantRecord {
  readonly id: string;
  readonly subject: RootSubjectRef;
  readonly generation: number;
  readonly scope: RootScope;
  readonly status: RootGrantStatus;
  readonly effective: boolean;
  readonly effective_reason_code: RootEffectiveReasonCode | string;
  readonly authority_node_id: string;
  readonly issuer: RootActorRef;
  readonly origin_attempt_id: string | null;
  readonly origin_family_id: string | null;
  readonly reason: string;
  readonly revocation_reason: string | null;
  readonly expires_at: string | null;
  readonly created_at: string;
  readonly revoked_at: string | null;
  readonly revision: number;
  readonly runtime_trust_ids?: readonly string[];
}

export interface ListRootGrantsResponse {
  readonly grants: readonly RootGrantRecord[];
  readonly security_revision: number;
  readonly next_cursor: string | null;
}

export interface CreateRootGrantRequest {
  readonly subject: RootSubjectRef;
  readonly reason: string;
  readonly expected_revision: number;
  readonly idempotency_key: string;
  readonly expires_at?: string | null;
  readonly runtime_trust_ids?: readonly string[];
  readonly accepted_dependency_digest?: string | null;
}

export interface CreateRootGrantResponse {
  readonly grant: RootGrantRecord;
  readonly security_revision: number;
  readonly replayed?: boolean;
}

export interface RevokeRootGrantRequest {
  readonly reason: string;
  readonly reason_code?: RootSecurityRevokeReasonCode;
  readonly expected_revision: number;
  readonly idempotency_key: string;
}

export interface RevokeRootGrantResponse {
  readonly grant: RootGrantRecord;
  readonly security_revision: number;
  readonly affected_authority_count: number;
  readonly cleanup_batch_id: string | null;
  readonly exposed_external_secrets_requiring_rotation?: readonly RootExposedSecretNotice[];
  readonly last_root_revoked?: boolean;
  readonly replayed?: boolean;
}

export interface RootRuntimeTrustRecord {
  readonly id: string;
  readonly generation: number;
  readonly runtime_id: string;
  readonly daemon_id: string;
  readonly incarnation: string;
  readonly workspace_id: string | null;
  readonly recipient_key_id: string;
  readonly recipient_key_fingerprint: string;
  readonly recipient_key_expires_at: string | null;
  readonly immutable_env_carrier_verified: boolean;
  readonly isolation_note: string | null;
  readonly status: RootRuntimeTrustStatus;
  readonly effective: boolean;
  readonly effective_reason_code: RootEffectiveReasonCode | string;
  readonly issuer: RootActorRef;
  readonly reason: string;
  readonly revocation_reason: string | null;
  readonly expires_at: string | null;
  readonly created_at: string;
  readonly revoked_at: string | null;
  readonly revision: number;
}

export interface ListRootRuntimeTrustResponse {
  readonly trusts: readonly RootRuntimeTrustRecord[];
  readonly security_revision: number;
  readonly next_cursor: string | null;
}

export interface GetRootRuntimeTrustResponse {
  readonly runtime_id: string;
  readonly active_trust: RootRuntimeTrustRecord | null;
  readonly history: readonly RootRuntimeTrustRecord[];
  readonly security_revision: number;
}

export interface GrantRootRuntimeTrustRequest {
  readonly runtime_id: string;
  readonly daemon_id: string;
  readonly incarnation: string;
  readonly recipient_key_id: string;
  readonly recipient_key_fingerprint: string;
  readonly recipient_key_expires_at?: string | null;
  readonly challenge_id?: string;
  readonly challenge_response?: string;
  readonly isolation_note?: string | null;
  readonly reason: string;
  readonly expected_revision: number;
  readonly idempotency_key: string;
  readonly expires_at?: string | null;
}

export interface GrantRootRuntimeTrustResponse {
  readonly trust: RootRuntimeTrustRecord;
  readonly security_revision: number;
  readonly replayed?: boolean;
}

export interface RevokeRootRuntimeTrustRequest {
  readonly reason: string;
  readonly reason_code?: RootSecurityRevokeReasonCode;
  readonly expected_revision: number;
  readonly idempotency_key: string;
}

export interface RevokeRootRuntimeTrustResponse {
  readonly trust: RootRuntimeTrustRecord;
  readonly security_revision: number;
  readonly affected_authority_count: number;
  readonly cleanup_batch_id: string | null;
  readonly replayed?: boolean;
}

export interface RevokeCredentialFamilyRequest {
  readonly expected_revision: number;
  readonly reason_code: RootSecurityRevokeReasonCode;
  readonly reason: string;
  readonly idempotency_key: string;
}

export interface RevokeCredentialFamilyResponse {
  readonly family_id: string;
  readonly status: "revoked";
  readonly security_revision: number;
  readonly affected_authority_count: number;
  readonly cleanup_batch_id: string | null;
  readonly exposed_external_secrets_requiring_rotation?: readonly RootExposedSecretNotice[];
  readonly replayed?: boolean;
}

export interface RootAuditEntry {
  readonly id: string;
  readonly action: string;
  readonly actor: RootActorRef;
  readonly credential_id: string | null;
  readonly family_id: string | null;
  readonly origin_attempt_id: string | null;
  readonly grant_id: string | null;
  readonly grant_generation: number | null;
  readonly target_type: string;
  readonly target_id: string;
  readonly scope: string | null;
  readonly before_revision: number | null;
  readonly after_revision: number | null;
  readonly reason_code: string | null;
  readonly reason: string | null;
  readonly outcome: "allowed" | "denied" | "conflict" | "error";
  readonly cleanup_batch_id: string | null;
  readonly created_at: string;
}

export interface ListRootAuditResponse {
  readonly entries: readonly RootAuditEntry[];
  readonly security_revision: number;
  readonly next_cursor: string | null;
}

/** Canonical system-level HTTP endpoints for root control plane (§5.4, §8.1). */
export const ROOT_API_PATHS = {
  context: "/api/root/context",
  grants: "/api/root/grants",
  grantRevoke: (grantId: string) => `/api/root/grants/${encodeURIComponent(grantId)}/revoke`,
  runtimeTrustList: "/api/root/runtime-trust",
  runtimeTrustGet: (runtimeId: string) => `/api/root/runtime-trust/${encodeURIComponent(runtimeId)}`,
  runtimeTrustGrant: "/api/root/runtime-trust",
  runtimeTrustRevoke: (trustId: string) => `/api/root/runtime-trust/${encodeURIComponent(trustId)}/revoke`,
  credentialFamilyRevoke: (familyId: string) => `/api/root/credential-families/${encodeURIComponent(familyId)}/revoke`,
  audit: "/api/root/audit",
} as const;
