/**
 * Shared compilable §10.1 fixtures for MUL-1 public DTOs, error envelopes,
 * and A2 delivery receipt wire structures.
 *
 * Owned by D; consumed by A (kernel/DTO alignment), B (delivery/issuer/repo tests),
 * C (HTTP/WS/context tests), and D (CLI/UI/contract tests).
 *
 * All values are synthetic non-secret fixture identifiers — never real tokens,
 * keys, or production IDs.
 */
import {
  buildDaemonRootRestartResumeReply,
  buildDaemonRootTaskOfferPayload,
  classifyDaemonRestartResumeReply,
  classifyDaemonTaskOfferPayload,
  evaluateRootDeliveryNegotiation,
  ROOT_DELIVERY_CAPABILITY,
  ROOT_DELIVERY_JWE_ALG,
  ROOT_DELIVERY_JWE_ENC,
  ROOT_DELIVERY_MODE,
  ROOT_DELIVERY_PROTOCOL_VERSION,
  type DaemonRootRestartResumeReply,
  type DaemonRootRestartResumeRequest,
  type DaemonRootTaskOfferPayload,
  type RootDeliveryActivationResponse,
  type RootDeliveryEnvelopePayload,
  type RootDeliveryInstallAckRequest,
  type RootDeliveryInstallAckResponse,
  type RootDeliveryJournalEntry,
  type RootDeliveryJweProtectedHeader,
  type RootDeliveryMachineProof,
  type RootDeliveryNegotiationInput,
  type RootDeliveryReplayRequest,
  type RootDeliveryReplayResponse,
  type RootDeliveryStatusRequest,
  type RootDeliveryStatusResponse,
  type RootDeliveryTuple,
  type RootExecutionLocator,
} from "../../packages/contracts/src/root-delivery.js";
import {
  createPublicErrorEnvelope,
  ROOT_SCOPE,
  type CreateRootGrantRequest,
  type CreateRootGrantResponse,
  type GrantRootRuntimeTrustRequest,
  type GrantRootRuntimeTrustResponse,
  type ListRootAuditResponse,
  type PublicErrorEnvelope,
  type RevokeCredentialFamilyRequest,
  type RevokeCredentialFamilyResponse,
  type RevokeRootGrantRequest,
  type RevokeRootGrantResponse,
  type RootContextResponse,
  type RootGrantRecord,
  type RootRuntimeTrustRecord,
  type RootSubjectProjection,
} from "../../packages/contracts/src/root-authority.js";

export const fixtureRootHumanContext = {
  security_revision: 4,
  feature_activation: true,
  bootstrap_completed: true,
  transport_identity: "human",
  authenticated_subject: { type: "user", id: "usr_root_fixture_1" },
  beneficiary_user_id: null,
  is_agent_origin: false,
  credential_id: "tok_human_session_fixture_1",
  family_id: "fam_human_fixture_1",
  origin_attempt_id: null,
  current_attempt_id: null,
  agent_granted_root: false,
  current_attempt_effective_root: false,
  effective_root: true,
  effective_reason_code: "active",
  grant_id: "rgr_human_fixture_1",
  grant_generation: 1,
  capabilities: {
    can_manage_root: true,
    can_edit_root_execution: true,
    can_manage_runtime_trust: true,
    can_revoke_credential_family: true,
    can_read_root_audit: true,
  },
  allowed_operations: [
    "context.read",
    "root.context.read",
    "root.grant.list",
    "root.grant.create",
    "root.grant.revoke",
    "root.runtime-trust.get",
    "root.runtime-trust.grant",
    "root.runtime-trust.revoke",
    "root.credential-family.revoke",
    "root.audit.list",
    "agent.role.set",
    "agent.supervisor.set",
  ],
} as const satisfies RootContextResponse;

/** Agent has an active root grant, but this older attempt was created before the grant. */
export const fixtureGrantedButIneffectiveTaskContext = {
  security_revision: 5,
  feature_activation: true,
  bootstrap_completed: true,
  transport_identity: "task",
  authenticated_subject: { type: "agent", id: "agt_root_fixture_1" },
  beneficiary_user_id: null,
  is_agent_origin: true,
  credential_id: "tok_task_old_attempt_fixture",
  family_id: "fam_task_old_attempt_fixture",
  origin_attempt_id: "att_old_before_grant",
  current_attempt_id: "att_old_before_grant",
  agent_granted_root: true,
  current_attempt_effective_root: false,
  effective_root: false,
  effective_reason_code: "attempt_not_eligible",
  grant_id: "rgr_agent_fixture_1",
  grant_generation: 1,
  capabilities: {
    can_manage_root: false,
    can_edit_root_execution: false,
    can_manage_runtime_trust: false,
    can_revoke_credential_family: false,
    can_read_root_audit: false,
  },
  allowed_operations: ["context.read", "root.context.read"],
} as const satisfies RootContextResponse;

/** Eligible new attempt created after G1 on a trusted Runtime. */
export const fixtureEffectiveRootTaskContext = {
  security_revision: 5,
  feature_activation: true,
  bootstrap_completed: true,
  transport_identity: "task",
  authenticated_subject: { type: "agent", id: "agt_root_fixture_1" },
  beneficiary_user_id: null,
  is_agent_origin: true,
  credential_id: "tok_task_new_attempt_fixture",
  family_id: "fam_task_new_attempt_fixture",
  origin_attempt_id: "att_new_after_grant",
  current_attempt_id: "att_new_after_grant",
  agent_granted_root: true,
  current_attempt_effective_root: true,
  effective_root: true,
  effective_reason_code: "active",
  grant_id: "rgr_agent_fixture_1",
  grant_generation: 1,
  capabilities: {
    can_manage_root: true,
    can_edit_root_execution: true,
    can_manage_runtime_trust: true,
    can_revoke_credential_family: true,
    can_read_root_audit: true,
  },
  allowed_operations: [
    "context.read",
    "root.context.read",
    "root.grant.list",
    "root.grant.create",
    "root.grant.revoke",
    "root.runtime-trust.get",
    "root.runtime-trust.grant",
    "root.runtime-trust.revoke",
    "root.credential-family.revoke",
    "root.audit.list",
    "agent.role.set",
    "agent.supervisor.set",
  ],
} as const satisfies RootContextResponse;

/** Agent-origin PAT must remain agent-origin and never display as a real human. */
export const fixtureAgentOriginPatContext = {
  security_revision: 5,
  feature_activation: true,
  bootstrap_completed: true,
  transport_identity: "human",
  authenticated_subject: { type: "agent", id: "agt_root_fixture_1" },
  beneficiary_user_id: "usr_target_fixture_2",
  is_agent_origin: true,
  credential_id: "tok_agent_pat_fixture_1",
  family_id: "fam_agent_pat_fixture_1",
  origin_attempt_id: "att_new_after_grant",
  current_attempt_id: null,
  agent_granted_root: true,
  current_attempt_effective_root: false,
  effective_root: true,
  effective_reason_code: "active",
  grant_id: "rgr_agent_fixture_1",
  grant_generation: 1,
  capabilities: {
    can_manage_root: true,
    can_edit_root_execution: true,
    can_manage_runtime_trust: true,
    can_revoke_credential_family: true,
    can_read_root_audit: true,
  },
  allowed_operations: ["context.read", "root.context.read", "agent.role.set"],
} as const satisfies RootContextResponse;

export const fixtureRootSubjectProjection = {
  granted: true,
  grant_id: "rgr_agent_fixture_1",
  generation: 1,
  effective: true,
  reason_code: "active",
  scope: ROOT_SCOPE,
  expires_at: null,
  revoked_at: null,
} as const satisfies RootSubjectProjection;

export const fixtureRootGrantRecord = {
  id: "rgr_agent_fixture_1",
  subject: { type: "agent", id: "agt_root_fixture_1" },
  generation: 1,
  scope: ROOT_SCOPE,
  status: "active",
  effective: true,
  effective_reason_code: "active",
  authority_node_id: "anode_fixture_2",
  issuer: { type: "user", id: "usr_root_fixture_1" },
  origin_attempt_id: null,
  origin_family_id: "fam_human_fixture_1",
  reason: "Fixture isolated grant for contract testing",
  revocation_reason: null,
  expires_at: null,
  created_at: "2026-11-24T12:00:00.000Z",
  revoked_at: null,
  revision: 5,
  runtime_trust_ids: ["rtr_fixture_1"],
} as const satisfies RootGrantRecord;

export const fixtureCreateRootGrantRequest = {
  subject: { type: "agent", id: "agt_root_fixture_1" },
  reason: "Fixture isolated grant for contract testing",
  expected_revision: 4,
  idempotency_key: "idem_grant_fixture_1",
  expires_at: null,
  runtime_trust_ids: ["rtr_fixture_1"],
} as const satisfies CreateRootGrantRequest;

export const fixtureCreateRootGrantResponse = {
  grant: fixtureRootGrantRecord,
  security_revision: 5,
  replayed: false,
} as const satisfies CreateRootGrantResponse;

export const fixtureRevokeRootGrantRequest = {
  reason: "Fixture revoke",
  reason_code: "grant_revoked",
  expected_revision: 5,
  idempotency_key: "idem_revoke_fixture_1",
} as const satisfies RevokeRootGrantRequest;

export const fixtureRevokeRootGrantResponse = {
  grant: {
    ...fixtureRootGrantRecord,
    status: "revoked",
    effective: false,
    effective_reason_code: "grant_revoked",
    revocation_reason: "Fixture revoke",
    revoked_at: "2026-11-24T12:10:00.000Z",
    revision: 6,
  },
  security_revision: 6,
  affected_authority_count: 3,
  cleanup_batch_id: "cln_fixture_1",
  exposed_external_secrets_requiring_rotation: [
    {
      target_type: "execution_endpoint",
      target_id: "ep_fixture_1",
      secret_version: "sv_1",
      accessed_at: "2026-11-24T12:05:00.000Z",
      rotation_required: true,
      note: "External secret was read prior to revocation and must be rotated out of band.",
    },
  ],
  last_root_revoked: false,
  replayed: false,
} as const satisfies RevokeRootGrantResponse;

export const fixtureRootRuntimeTrustRecord = {
  id: "rtr_fixture_1",
  generation: 1,
  runtime_id: "rt_fixture_1",
  daemon_id: "dmn_fixture_1",
  incarnation: "inc_fixture_1",
  workspace_id: "local",
  recipient_key_id: "rkey_fixture_1",
  recipient_key_fingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000001",
  recipient_key_expires_at: "2027-01-01T00:00:00.000Z",
  immutable_env_carrier_verified: true,
  isolation_note: "Dedicated isolated test fixture host",
  status: "active",
  effective: true,
  effective_reason_code: "active",
  issuer: { type: "user", id: "usr_root_fixture_1" },
  reason: "Fixture runtime trust",
  revocation_reason: null,
  expires_at: "2027-01-01T00:00:00.000Z",
  created_at: "2026-11-24T11:50:00.000Z",
  revoked_at: null,
  revision: 4,
} as const satisfies RootRuntimeTrustRecord;

export const fixtureGrantRuntimeTrustRequest = {
  runtime_id: "rt_fixture_1",
  daemon_id: "dmn_fixture_1",
  incarnation: "inc_fixture_1",
  recipient_key_id: "rkey_fixture_1",
  recipient_key_fingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000001",
  recipient_key_expires_at: "2027-01-01T00:00:00.000Z",
  isolation_note: "Dedicated isolated test fixture host",
  reason: "Fixture runtime trust",
  expected_revision: 3,
  idempotency_key: "idem_trust_fixture_1",
  expires_at: "2027-01-01T00:00:00.000Z",
} as const satisfies GrantRootRuntimeTrustRequest;

export const fixtureGrantRuntimeTrustResponse = {
  trust: fixtureRootRuntimeTrustRecord,
  security_revision: 4,
  replayed: false,
} as const satisfies GrantRootRuntimeTrustResponse;

export const fixtureRevokeCredentialFamilyRequest = {
  expected_revision: 6,
  reason_code: "operator_security_revoke",
  reason: "Fixture credential family revocation",
  idempotency_key: "idem_family_revoke_1",
} as const satisfies RevokeCredentialFamilyRequest;

export const fixtureRevokeCredentialFamilyResponse = {
  family_id: "fam_agent_pat_fixture_1",
  status: "revoked",
  security_revision: 7,
  affected_authority_count: 2,
  cleanup_batch_id: "cln_fixture_2",
  replayed: false,
} as const satisfies RevokeCredentialFamilyResponse;

export const fixtureRootAuditResponse = {
  entries: [
    {
      id: "raud_fixture_1",
      action: "root.grant.create",
      actor: { type: "user", id: "usr_root_fixture_1" },
      credential_id: "tok_human_session_fixture_1",
      family_id: "fam_human_fixture_1",
      origin_attempt_id: null,
      grant_id: "rgr_agent_fixture_1",
      grant_generation: 1,
      target_type: "agent",
      target_id: "agt_root_fixture_1",
      scope: ROOT_SCOPE,
      before_revision: 4,
      after_revision: 5,
      reason_code: null,
      reason: "Fixture isolated grant for contract testing",
      outcome: "allowed",
      cleanup_batch_id: null,
      created_at: "2026-11-24T12:00:00.000Z",
    },
  ],
  security_revision: 5,
  next_cursor: null,
} as const satisfies ListRootAuditResponse;

export const fixturePublicErrorEnvelopes: Readonly<Record<string, PublicErrorEnvelope>> = {
  rootRequired: createPublicErrorEnvelope({
    code: "root_required",
    message: "System root authority is required for this operation.",
    requestId: "req_fixture_403",
  }),
  attemptNotEligible: createPublicErrorEnvelope({
    code: "root_attempt_not_eligible",
    message: "Agent has a root grant, but this attempt was created before authorization; start a new eligible attempt.",
    requestId: "req_fixture_attempt",
  }),
  revisionConflict: createPublicErrorEnvelope({
    code: "authority_revision_conflict",
    message: "Security revision changed; refresh and retry.",
    requestId: "req_fixture_409",
    currentRevision: 6,
  }),
  unavailable: createPublicErrorEnvelope({
    code: "security_state_unavailable",
    message: "Security state is temporarily unavailable.",
    requestId: "req_fixture_503",
  }),
};

// ── A2 Delivery Receipt Wire Fixtures ───────────────────────────────────────

export const fixtureDeliveryTuple = {
  receipt_id: "rcpt_fixture_1",
  receipt_version: 1,
  delivery_version: 1,
  material_version: 1,
  attempt_id: "att_new_after_grant",
  handoff_id: "hoff_fixture_1",
  handoff_generation: 1,
  run_generation: 1,
  consumer_id: "cons_fixture_1",
  runtime_id: "rt_fixture_1",
  daemon_id: "dmn_fixture_1",
  incarnation: "inc_fixture_1",
  recipient_key_id: "rkey_fixture_1",
  recipient_key_fingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000001",
  execution_config_epoch: 2,
  execution_digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  input_revision: 3,
  input_digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  checkpoint_digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
  grant_id: "rgr_agent_fixture_1",
  grant_generation: 1,
  material_expires_at: "2026-11-25T12:00:00.000Z",
  business_payload_digest: "sha256:4444444444444444444444444444444444444444444444444444444444444444",
} as const satisfies RootDeliveryTuple;

export const fixtureDeliveryProtectedHeader = {
  alg: ROOT_DELIVERY_JWE_ALG,
  enc: ROOT_DELIVERY_JWE_ENC,
  v: ROOT_DELIVERY_PROTOCOL_VERSION,
  kid: fixtureDeliveryTuple.recipient_key_id,
  receipt_id: fixtureDeliveryTuple.receipt_id,
  receipt_version: fixtureDeliveryTuple.receipt_version,
  delivery_version: fixtureDeliveryTuple.delivery_version,
  material_version: fixtureDeliveryTuple.material_version,
  attempt_id: fixtureDeliveryTuple.attempt_id,
  handoff_id: fixtureDeliveryTuple.handoff_id,
  handoff_generation: fixtureDeliveryTuple.handoff_generation,
  run_generation: fixtureDeliveryTuple.run_generation,
  consumer_id: fixtureDeliveryTuple.consumer_id,
  runtime_id: fixtureDeliveryTuple.runtime_id,
  daemon_id: fixtureDeliveryTuple.daemon_id,
  incarnation: fixtureDeliveryTuple.incarnation,
  recipient_key_fingerprint: fixtureDeliveryTuple.recipient_key_fingerprint,
  execution_config_epoch: fixtureDeliveryTuple.execution_config_epoch,
  execution_digest: fixtureDeliveryTuple.execution_digest,
  input_revision: fixtureDeliveryTuple.input_revision,
  input_digest: fixtureDeliveryTuple.input_digest,
  checkpoint_digest: fixtureDeliveryTuple.checkpoint_digest,
  grant_id: fixtureDeliveryTuple.grant_id,
  grant_generation: fixtureDeliveryTuple.grant_generation,
  material_expires_at: fixtureDeliveryTuple.material_expires_at,
  business_payload_digest: fixtureDeliveryTuple.business_payload_digest,
} as const satisfies RootDeliveryJweProtectedHeader;

export const fixtureMachineProof = {
  consumer_id: "cons_fixture_1",
  runtime_id: "rt_fixture_1",
  daemon_id: "dmn_fixture_1",
  incarnation: "inc_fixture_1",
  recipient_key_id: "rkey_fixture_1",
  recipient_key_fingerprint: fixtureDeliveryTuple.recipient_key_fingerprint,
  nonce: "nonce_fixture_1",
  signature: "sig_fixture_placeholder_not_real",
  signed_at: "2026-11-24T12:01:00.000Z",
} as const satisfies RootDeliveryMachineProof;

export const fixtureDeliveryStatusRequest = {
  execution_key: {
    attempt_id: fixtureDeliveryTuple.attempt_id,
    handoff_id: fixtureDeliveryTuple.handoff_id,
    receipt_id: fixtureDeliveryTuple.receipt_id,
  },
  machine_proof: fixtureMachineProof,
} as const satisfies RootDeliveryStatusRequest;

export const fixtureDeliveryStatusResponse = {
  ok: true,
  committed: true,
  tuple: fixtureDeliveryTuple,
  envelope_digest: "sha256:5555555555555555555555555555555555555555555555555555555555555555",
  run_state: "pending_start",
  ack_state: "pending",
  start_deadline: "2026-11-24T12:05:00.000Z",
  lease_id: "lease_fixture_1",
  fence_term: "term_fixture_1",
  allowed_recovery_action: "replay_envelope",
  security_revision: 5,
} as const satisfies RootDeliveryStatusResponse;

export const fixtureDeliveryActivationResponse = {
  ok: true,
  activation: "committed",
  tuple: fixtureDeliveryTuple,
  envelope: "fixture.jwe.compact.placeholder.tag",
  envelope_digest: fixtureDeliveryStatusResponse.envelope_digest,
  frozen_business_payload: {
    turn_id: "trn_root_fixture_1",
    attempt_id: fixtureDeliveryTuple.attempt_id,
    input_revision: fixtureDeliveryTuple.input_revision,
  },
  start_deadline: fixtureDeliveryStatusResponse.start_deadline,
  lease_id: fixtureDeliveryStatusResponse.lease_id,
  fence_term: fixtureDeliveryStatusResponse.fence_term,
  run_state: "pending_start",
} as const satisfies RootDeliveryActivationResponse;

export const fixtureDeliveryReplayRequest = {
  receipt_id: fixtureDeliveryTuple.receipt_id,
  expected_receipt_version: 1,
  expected_delivery_version: 1,
  run_lease_id: "lease_fixture_1",
  fence_term: "term_fixture_1",
  machine_proof: fixtureMachineProof,
} as const satisfies RootDeliveryReplayRequest;

export const fixtureDeliveryReplayResponse = {
  ok: true,
  replay: true,
  tuple: fixtureDeliveryTuple,
  envelope: fixtureDeliveryActivationResponse.envelope,
  envelope_digest: fixtureDeliveryActivationResponse.envelope_digest,
  frozen_business_payload: fixtureDeliveryActivationResponse.frozen_business_payload,
  start_deadline: fixtureDeliveryActivationResponse.start_deadline,
  lease_id: fixtureDeliveryActivationResponse.lease_id,
  fence_term: fixtureDeliveryActivationResponse.fence_term,
  run_state: "pending_start",
} as const satisfies RootDeliveryReplayResponse;

export const fixtureExecutionLocator = {
  execution_id: "exec_fixture_1",
  launch_identity: "launch_fixture_1",
  carrier_mode: "immutable_run_env",
  runtime_id: fixtureDeliveryTuple.runtime_id,
  daemon_id: fixtureDeliveryTuple.daemon_id,
  incarnation: fixtureDeliveryTuple.incarnation,
  birth_token_id: "tok_task_new_attempt_fixture",
  started_at: null,
} as const satisfies RootExecutionLocator;

export const fixtureDeliveryInstallAckRequest = {
  tuple: {
    receipt_id: fixtureDeliveryTuple.receipt_id,
    receipt_version: fixtureDeliveryTuple.receipt_version,
    delivery_version: fixtureDeliveryTuple.delivery_version,
    material_version: fixtureDeliveryTuple.material_version,
    attempt_id: fixtureDeliveryTuple.attempt_id,
    handoff_id: fixtureDeliveryTuple.handoff_id,
    run_generation: fixtureDeliveryTuple.run_generation,
    consumer_id: fixtureDeliveryTuple.consumer_id,
    runtime_id: fixtureDeliveryTuple.runtime_id,
    daemon_id: fixtureDeliveryTuple.daemon_id,
    incarnation: fixtureDeliveryTuple.incarnation,
    recipient_key_id: fixtureDeliveryTuple.recipient_key_id,
    recipient_key_fingerprint: fixtureDeliveryTuple.recipient_key_fingerprint,
  },
  envelope_digest: fixtureDeliveryStatusResponse.envelope_digest,
  execution_locator: fixtureExecutionLocator,
  installed_at: "2026-11-24T12:01:10.000Z",
  machine_proof: fixtureMachineProof,
} as const satisfies RootDeliveryInstallAckRequest;

export const fixtureDeliveryInstallAckResponse = {
  ok: true,
  ack_state: "confirmed",
  run_state: "pending_start",
  start_deadline: fixtureDeliveryStatusResponse.start_deadline,
  lease_id: fixtureDeliveryStatusResponse.lease_id,
  fence_term: fixtureDeliveryStatusResponse.fence_term,
  idempotent_replay: false,
} as const satisfies RootDeliveryInstallAckResponse;

export const fixtureDeliveryJournalEntry = {
  tuple: fixtureDeliveryTuple,
  envelope_digest: fixtureDeliveryStatusResponse.envelope_digest,
  state: "confirmed",
  launch_identity: fixtureExecutionLocator.launch_identity,
  execution_locator: fixtureExecutionLocator,
  lease_id: fixtureDeliveryStatusResponse.lease_id,
  fence_term: fixtureDeliveryStatusResponse.fence_term,
  start_deadline: fixtureDeliveryStatusResponse.start_deadline,
  updated_at: "2026-11-24T12:01:12.000Z",
} as const satisfies RootDeliveryJournalEntry;

// ── A2 Initial `task.offer` & `turn.restart.resume` Typed Root Carrier Fixtures ──

export const fixtureRootDeliveryNegotiationInput = {
  hello_caps: ["offer", "turn.message", "turn.restart", ROOT_DELIVERY_CAPABILITY],
  welcome_caps: ["turn.restart", ROOT_DELIVERY_CAPABILITY],
  runtime_capabilities: {
    root_delivery_protocol: ROOT_DELIVERY_PROTOCOL_VERSION,
    root_carrier_modes: ["immutable_run_env"],
  },
  runtime_trusted: true,
  consumer_trusted: true,
} as const satisfies RootDeliveryNegotiationInput;

/** Initial `task.offer` tuple has `handoff_id: null` and `handoff_generation: 0`. */
export const fixtureInitialRootDeliveryTuple = {
  ...fixtureDeliveryTuple,
  receipt_id: "rcpt_initial_fixture_1",
  handoff_id: null,
  handoff_generation: 0,
  checkpoint_digest: null,
} as const satisfies RootDeliveryTuple;

export const fixtureInitialRootDeliveryEnvelopePayload = {
  tuple: fixtureInitialRootDeliveryTuple,
  envelope: "fixture.initial.jwe.compact.placeholder.tag",
  envelope_digest: "sha256:6666666666666666666666666666666666666666666666666666666666666666",
  frozen_business_payload: {
    turn_id: "trn_root_fixture_1",
    attempt_id: fixtureInitialRootDeliveryTuple.attempt_id,
    input_revision: fixtureInitialRootDeliveryTuple.input_revision,
  },
  start_deadline: fixtureDeliveryStatusResponse.start_deadline,
  lease_id: fixtureDeliveryStatusResponse.lease_id,
  fence_term: fixtureDeliveryStatusResponse.fence_term,
  run_state: "pending_start",
} as const satisfies RootDeliveryEnvelopePayload;

export const fixtureRootTaskOfferPayload: DaemonRootTaskOfferPayload = buildDaemonRootTaskOfferPayload({
  turn_id: "trn_root_fixture_1",
  attempt_id: fixtureInitialRootDeliveryTuple.attempt_id,
  root_delivery: fixtureInitialRootDeliveryEnvelopePayload,
});

export const fixtureRootRestartResumeRequest = {
  delivery_mode: ROOT_DELIVERY_MODE,
  root_delivery_protocol: ROOT_DELIVERY_PROTOCOL_VERSION,
  carrier_mode: "immutable_run_env",
  turn_id: "trn_root_fixture_1",
  attempt_id: fixtureDeliveryTuple.attempt_id,
  handoff_id: fixtureDeliveryTuple.handoff_id,
  generation: fixtureDeliveryTuple.handoff_generation,
  consumer_id: "cons_fixture_root_resume_1",
  machine_proof: {
    ...fixtureMachineProof,
    consumer_id: "cons_fixture_root_resume_1",
  },
} as const satisfies DaemonRootRestartResumeRequest;

export const fixtureResumeRootDeliveryEnvelopePayload = {
  tuple: fixtureDeliveryTuple,
  envelope: fixtureDeliveryActivationResponse.envelope,
  envelope_digest: fixtureDeliveryActivationResponse.envelope_digest,
  frozen_business_payload: fixtureDeliveryActivationResponse.frozen_business_payload,
  start_deadline: fixtureDeliveryActivationResponse.start_deadline,
  lease_id: fixtureDeliveryActivationResponse.lease_id,
  fence_term: fixtureDeliveryActivationResponse.fence_term,
  run_state: "pending_start",
} as const satisfies RootDeliveryEnvelopePayload;

export const fixtureRootRestartResumeReply: DaemonRootRestartResumeReply = buildDaemonRootRestartResumeReply({
  turn_id: "trn_root_fixture_1",
  attempt_id: fixtureDeliveryTuple.attempt_id,
  handoff_id: fixtureDeliveryTuple.handoff_id,
  generation: fixtureDeliveryTuple.handoff_generation,
  root_delivery: fixtureResumeRootDeliveryEnvelopePayload,
  recovered_questions: [],
});

/**
 * Compilable reference discriminator for B/C showing fail-closed branching on
 * `task.offer` BEFORE `normalizeDaemonTurnOffer` / `handleTask`.
 * Production handlers live in B/C's modules; this helper is fixture/contract evidence only.
 */
export function compileExampleRouteOfferFrame(
  rawPayload: unknown,
  negotiation: RootDeliveryNegotiationInput,
):
  | { readonly branch: "ordinary_handle_task" }
  | { readonly branch: "protected_root_receiver"; readonly payload: DaemonRootTaskOfferPayload }
  | { readonly branch: "reject"; readonly code: string; readonly reason: string } {
  const classified = classifyDaemonTaskOfferPayload(rawPayload);
  if (classified.kind === "standard") {
    return { branch: "ordinary_handle_task" };
  }
  if (classified.kind === "invalid_root") {
    return { branch: "reject", code: classified.code, reason: classified.reason };
  }
  const negotiated = evaluateRootDeliveryNegotiation(negotiation);
  if (!negotiated.eligible) {
    return { branch: "reject", code: negotiated.code, reason: negotiated.reason };
  }
  return { branch: "protected_root_receiver", payload: classified.payload };
}

/**
 * Compilable reference discriminator for B/C showing fail-closed branching on
 * `turn.restart.resume` replies BEFORE reading `result.task`.
 */
export function compileExampleRouteResumeReply(
  rawReply: unknown,
  negotiation: RootDeliveryNegotiationInput,
):
  | { readonly branch: "ordinary_resume" }
  | { readonly branch: "protected_root_receiver"; readonly reply: DaemonRootRestartResumeReply }
  | { readonly branch: "reject"; readonly code: string; readonly reason: string } {
  const classified = classifyDaemonRestartResumeReply(rawReply);
  if (classified.kind === "standard") {
    return { branch: "ordinary_resume" };
  }
  if (classified.kind === "invalid_root") {
    return { branch: "reject", code: classified.code, reason: classified.reason };
  }
  const negotiated = evaluateRootDeliveryNegotiation(negotiation);
  if (!negotiated.eligible) {
    return { branch: "reject", code: negotiated.code, reason: negotiated.reason };
  }
  return { branch: "protected_root_receiver", reply: classified.payload };
}
