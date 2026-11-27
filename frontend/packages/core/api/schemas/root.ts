import { z } from "zod";
import type {
  CreateRootGrantResponse,
  GetRootRuntimeTrustResponse,
  GrantRootRuntimeTrustResponse,
  ListRootAuditResponse,
  ListRootGrantsResponse,
  ListRootRuntimeTrustResponse,
  RevokeCredentialFamilyResponse,
  RevokeRootGrantResponse,
  RevokeRootRuntimeTrustResponse,
  RootContextResponse,
} from "@multiremi/contracts/root-authority";

const RootSubjectRefSchema = z.object({
  type: z.enum(["user", "agent"]),
  id: z.string(),
}).loose();

const RootActorRefSchema = z.object({
  type: z.enum(["user", "agent", "deployment", "system"]),
  id: z.string(),
}).loose();

export const RootSubjectProjectionSchema = z.object({
  granted: z.boolean().default(false),
  grant_id: z.string().nullable().default(null),
  generation: z.number().nullable().default(null),
  effective: z.boolean().default(false),
  reason_code: z.string().default("unknown"),
  scope: z.literal("system").nullable().default(null),
  expires_at: z.string().nullable().default(null),
  revoked_at: z.string().nullable().default(null),
}).loose();

export const RootExposedSecretNoticeSchema = z.object({
  target_type: z.string(),
  target_id: z.string(),
  secret_version: z.string().nullable().default(null),
  accessed_at: z.string(),
  rotation_required: z.literal(true).default(true),
  note: z.string().default(""),
}).loose();

export const RootCapabilitiesSummarySchema = z.object({
  can_manage_root: z.boolean().default(false),
  can_edit_root_execution: z.boolean().default(false),
  can_manage_runtime_trust: z.boolean().default(false),
  can_revoke_credential_family: z.boolean().default(false),
  can_read_root_audit: z.boolean().default(false),
}).loose();

export const RootContextResponseSchema = z.object({
  security_revision: z.number().int().nonnegative().default(0),
  feature_activation: z.boolean().default(false),
  bootstrap_completed: z.boolean().default(false),
  transport_identity: z.string().default("human"),
  authenticated_subject: RootSubjectRefSchema.nullable().default(null),
  beneficiary_user_id: z.string().nullable().default(null),
  is_agent_origin: z.boolean().default(false),
  credential_id: z.string().nullable().default(null),
  family_id: z.string().nullable().default(null),
  origin_attempt_id: z.string().nullable().default(null),
  current_attempt_id: z.string().nullable().default(null),
  agent_granted_root: z.boolean().default(false),
  current_attempt_effective_root: z.boolean().default(false),
  effective_root: z.boolean().default(false),
  effective_reason_code: z.string().default("no_grant"),
  grant_id: z.string().nullable().default(null),
  grant_generation: z.number().nullable().default(null),
  capabilities: RootCapabilitiesSummarySchema.default({
    can_manage_root: false,
    can_edit_root_execution: false,
    can_manage_runtime_trust: false,
    can_revoke_credential_family: false,
    can_read_root_audit: false,
  }),
  allowed_operations: z.array(z.string()).default([]),
}).loose();

export const EMPTY_ROOT_CONTEXT: RootContextResponse = {
  security_revision: 0,
  feature_activation: false,
  bootstrap_completed: false,
  transport_identity: "human",
  authenticated_subject: null,
  beneficiary_user_id: null,
  is_agent_origin: false,
  credential_id: null,
  family_id: null,
  origin_attempt_id: null,
  current_attempt_id: null,
  agent_granted_root: false,
  current_attempt_effective_root: false,
  effective_root: false,
  effective_reason_code: "no_grant",
  grant_id: null,
  grant_generation: null,
  capabilities: {
    can_manage_root: false,
    can_edit_root_execution: false,
    can_manage_runtime_trust: false,
    can_revoke_credential_family: false,
    can_read_root_audit: false,
  },
  allowed_operations: [],
};

export const RootGrantRecordSchema = z.object({
  id: z.string(),
  subject: RootSubjectRefSchema,
  generation: z.number(),
  scope: z.literal("system").default("system"),
  status: z.string(),
  effective: z.boolean(),
  effective_reason_code: z.string().default("unknown"),
  authority_node_id: z.string(),
  issuer: RootActorRefSchema,
  origin_attempt_id: z.string().nullable().default(null),
  origin_family_id: z.string().nullable().default(null),
  reason: z.string().default(""),
  revocation_reason: z.string().nullable().default(null),
  expires_at: z.string().nullable().default(null),
  created_at: z.string(),
  revoked_at: z.string().nullable().default(null),
  revision: z.number(),
  runtime_trust_ids: z.array(z.string()).optional(),
}).loose();

export const ListRootGrantsResponseSchema = z.object({
  grants: z.array(RootGrantRecordSchema).default([]),
  security_revision: z.number().int().nonnegative().default(0),
  next_cursor: z.string().nullable().default(null),
}).loose();

export const EMPTY_ROOT_GRANTS_RESPONSE: ListRootGrantsResponse = {
  grants: [],
  security_revision: 0,
  next_cursor: null,
};

export const CreateRootGrantResponseSchema = z.object({
  grant: RootGrantRecordSchema,
  security_revision: z.number().int().nonnegative(),
  replayed: z.boolean().optional(),
}).loose();

export const RevokeRootGrantResponseSchema = z.object({
  grant: RootGrantRecordSchema,
  security_revision: z.number().int().nonnegative(),
  affected_authority_count: z.number().int().nonnegative().default(0),
  cleanup_batch_id: z.string().nullable().default(null),
  exposed_external_secrets_requiring_rotation: z.array(RootExposedSecretNoticeSchema).optional(),
  last_root_revoked: z.boolean().optional(),
  replayed: z.boolean().optional(),
}).loose();

export const RootRuntimeTrustRecordSchema = z.object({
  id: z.string(),
  generation: z.number(),
  runtime_id: z.string(),
  daemon_id: z.string(),
  incarnation: z.string(),
  workspace_id: z.string().nullable().default(null),
  recipient_key_id: z.string(),
  recipient_key_fingerprint: z.string(),
  recipient_key_expires_at: z.string().nullable().default(null),
  immutable_env_carrier_verified: z.boolean().default(false),
  isolation_note: z.string().nullable().default(null),
  status: z.string(),
  effective: z.boolean(),
  effective_reason_code: z.string().default("unknown"),
  issuer: RootActorRefSchema,
  reason: z.string().default(""),
  revocation_reason: z.string().nullable().default(null),
  expires_at: z.string().nullable().default(null),
  created_at: z.string(),
  revoked_at: z.string().nullable().default(null),
  revision: z.number(),
}).loose();

export const ListRootRuntimeTrustResponseSchema = z.object({
  trusts: z.array(RootRuntimeTrustRecordSchema).default([]),
  security_revision: z.number().int().nonnegative().default(0),
  next_cursor: z.string().nullable().default(null),
}).loose();

export const EMPTY_ROOT_RUNTIME_TRUST_LIST: ListRootRuntimeTrustResponse = {
  trusts: [],
  security_revision: 0,
  next_cursor: null,
};

export const GetRootRuntimeTrustResponseSchema = z.object({
  runtime_id: z.string(),
  active_trust: RootRuntimeTrustRecordSchema.nullable().default(null),
  history: z.array(RootRuntimeTrustRecordSchema).default([]),
  security_revision: z.number().int().nonnegative().default(0),
}).loose();

export const EMPTY_ROOT_RUNTIME_TRUST_DETAIL: GetRootRuntimeTrustResponse = {
  runtime_id: "",
  active_trust: null,
  history: [],
  security_revision: 0,
};

export const GrantRootRuntimeTrustResponseSchema = z.object({
  trust: RootRuntimeTrustRecordSchema,
  security_revision: z.number().int().nonnegative(),
  replayed: z.boolean().optional(),
}).loose();

export const RevokeRootRuntimeTrustResponseSchema = z.object({
  trust: RootRuntimeTrustRecordSchema,
  security_revision: z.number().int().nonnegative(),
  affected_authority_count: z.number().int().nonnegative().default(0),
  cleanup_batch_id: z.string().nullable().default(null),
  replayed: z.boolean().optional(),
}).loose();

export const RevokeCredentialFamilyResponseSchema = z.object({
  family_id: z.string(),
  status: z.literal("revoked"),
  security_revision: z.number().int().nonnegative(),
  affected_authority_count: z.number().int().nonnegative().default(0),
  cleanup_batch_id: z.string().nullable().default(null),
  exposed_external_secrets_requiring_rotation: z.array(RootExposedSecretNoticeSchema).optional(),
  replayed: z.boolean().optional(),
}).loose();

export const RootAuditEntrySchema = z.object({
  id: z.string(),
  action: z.string(),
  actor: RootActorRefSchema,
  credential_id: z.string().nullable().default(null),
  family_id: z.string().nullable().default(null),
  origin_attempt_id: z.string().nullable().default(null),
  grant_id: z.string().nullable().default(null),
  grant_generation: z.number().nullable().default(null),
  target_type: z.string(),
  target_id: z.string(),
  scope: z.string().nullable().default(null),
  before_revision: z.number().nullable().default(null),
  after_revision: z.number().nullable().default(null),
  reason_code: z.string().nullable().default(null),
  reason: z.string().nullable().default(null),
  outcome: z.string().default("allowed"),
  cleanup_batch_id: z.string().nullable().default(null),
  created_at: z.string(),
}).loose();

export const ListRootAuditResponseSchema = z.object({
  entries: z.array(RootAuditEntrySchema).default([]),
  security_revision: z.number().int().nonnegative().default(0),
  next_cursor: z.string().nullable().default(null),
}).loose();

export const EMPTY_ROOT_AUDIT_RESPONSE: ListRootAuditResponse = {
  entries: [],
  security_revision: 0,
  next_cursor: null,
};

// Compile-time assertions that strict mutation responses stay aligned with contracts.
export type _CheckCreateGrant = CreateRootGrantResponse;
export type _CheckRevokeGrant = RevokeRootGrantResponse;
export type _CheckGrantTrust = GrantRootRuntimeTrustResponse;
export type _CheckRevokeTrust = RevokeRootRuntimeTrustResponse;
export type _CheckRevokeFamily = RevokeCredentialFamilyResponse;
