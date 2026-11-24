import { describe, expect, it } from "bun:test";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DAEMON_CAPABILITY_REGISTRY,
  daemonCapabilityName,
  hasDaemonCapability,
} from "../../../packages/contracts/src/daemon-compatibility.js";
import {
  DAEMON_PROTOCOL_CAPS,
  DAEMON_PROTOCOL_ERROR_CODES,
  DAEMON_RETRYABLE_ERROR_CODES,
  DAEMON_UPLINK_RPC_FRAMES,
} from "../../../packages/contracts/src/daemon-protocol.js";
import {
  createPublicErrorEnvelope,
  findRootReadonlyFields,
  isRootPublicErrorCode,
  parsePublicErrorEnvelope,
  ROOT_PUBLIC_ERROR_CODES,
  ROOT_PUBLIC_ERROR_HTTP_STATUS,
  ROOT_PUBLIC_ERROR_RETRYABLE,
  ROOT_SECURITY_EVENT_REASONS,
  stripRootReadonlyFields,
} from "../../../packages/contracts/src/root-authority.js";
import {
  assertStatusResponseHasNoSecrets,
  buildDaemonRootRestartResumeReply,
  buildDaemonRootTaskOfferPayload,
  classifyDaemonRestartResumeReply,
  classifyDaemonRestartResumeRequest,
  classifyDaemonTaskOfferPayload,
  evaluateRootDeliveryNegotiation,
  isMonotonicReceiverTransition,
  ROOT_DELIVERY_CAPABILITY,
  ROOT_DELIVERY_JWE_ALG,
  ROOT_DELIVERY_JWE_ENC,
  ROOT_DELIVERY_MIN_RSA_BITS,
  ROOT_DELIVERY_MODE,
  ROOT_DELIVERY_PROTOCOL_VERSION,
} from "../../../packages/contracts/src/root-delivery.js";
import { normalizeDaemonTurnOffer } from "../../../packages/server/src/worker/daemon-offers.js";
import {
  assertOrdinaryTaskContextOnly,
  buildRootImmutableRunEnv,
  resolveTaskContext,
  ROOT_CARRIER_IMMUTABLE_ENV,
  ROOT_CARRIER_MODE_ENV,
  ROOT_DELIVERY_VERSION_ENV,
  ROOT_RECEIPT_ID_ENV,
  ROOT_RUN_GENERATION_ENV,
  TASK_CONTEXT_FILE_ENV,
} from "../../../packages/shared/src/task-context-file.js";
import {
  compileExampleRouteOfferFrame,
  compileExampleRouteResumeReply,
  fixtureAgentOriginPatContext,
  fixtureDeliveryActivationResponse,
  fixtureDeliveryJournalEntry,
  fixtureDeliveryReplayResponse,
  fixtureDeliveryStatusResponse,
  fixtureEffectiveRootTaskContext,
  fixtureGrantedButIneffectiveTaskContext,
  fixtureInitialRootDeliveryEnvelopePayload,
  fixturePublicErrorEnvelopes,
  fixtureResumeRootDeliveryEnvelopePayload,
  fixtureRootDeliveryNegotiationInput,
  fixtureRootHumanContext,
  fixtureRootRestartResumeReply,
  fixtureRootRestartResumeRequest,
  fixtureRootTaskOfferPayload,
} from "../../fixtures/root-authority.js";

describe("MUL-1 §10.1 public contracts and fixtures", () => {
  it("freezes all required public error codes, HTTP statuses, and retryable semantics", () => {
    const requiredCodes = [
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

    for (const code of requiredCodes) {
      expect(ROOT_PUBLIC_ERROR_CODES).toContain(code);
      expect(isRootPublicErrorCode(code)).toBe(true);
      expect([401, 403, 409, 503]).toContain(ROOT_PUBLIC_ERROR_HTTP_STATUS[code]);
      expect(typeof ROOT_PUBLIC_ERROR_RETRYABLE[code]).toBe("boolean");
    }

    expect(ROOT_PUBLIC_ERROR_HTTP_STATUS.root_authority_revoked).toBe(401);
    expect(ROOT_PUBLIC_ERROR_HTTP_STATUS.root_required).toBe(403);
    expect(ROOT_PUBLIC_ERROR_HTTP_STATUS.authority_revision_conflict).toBe(409);
    expect(ROOT_PUBLIC_ERROR_HTTP_STATUS.security_state_unavailable).toBe(503);
    expect(ROOT_PUBLIC_ERROR_RETRYABLE.authority_revision_conflict).toBe(true);
    expect(ROOT_PUBLIC_ERROR_RETRYABLE.security_state_unavailable).toBe(true);
    expect(ROOT_PUBLIC_ERROR_RETRYABLE.root_required).toBe(false);

    const parsed = parsePublicErrorEnvelope(fixturePublicErrorEnvelopes.revisionConflict);
    expect(parsed).toEqual({
      error: {
        code: "authority_revision_conflict",
        message: "Security revision changed; refresh and retry.",
        retryable: true,
        requestId: "req_fixture_409",
        currentRevision: 6,
      },
    });
    expect(parsePublicErrorEnvelope(createPublicErrorEnvelope({
      code: "root_attempt_not_eligible",
      message: "Start a new attempt",
      requestId: "req_1",
    }))?.error.retryable).toBe(false);
    expect(parsePublicErrorEnvelope({ error: "legacy string" })).toBeNull();
  });

  it("freezes §5.4 security event reasons and strips/detects read-only root write fields", () => {
    expect(ROOT_SECURITY_EVENT_REASONS).toEqual([
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
    ]);

    const dirty = {
      name: "Agent A",
      role: "supervisor",
      root: { granted: true },
      provenance: { node: "fake" },
      grant_generation: 99,
    };
    expect(findRootReadonlyFields(dirty)).toEqual(["root", "provenance", "grant_generation"]);
    expect(stripRootReadonlyFields(dirty)).toEqual({ name: "Agent A", role: "supervisor" });
  });

  it("distinguishes agent_granted_root from current_attempt_effective_root and preserves agent-origin PAT identity", () => {
    expect(fixtureGrantedButIneffectiveTaskContext.agent_granted_root).toBe(true);
    expect(fixtureGrantedButIneffectiveTaskContext.current_attempt_effective_root).toBe(false);
    expect(fixtureGrantedButIneffectiveTaskContext.effective_root).toBe(false);
    expect(fixtureGrantedButIneffectiveTaskContext.effective_reason_code).toBe("attempt_not_eligible");

    expect(fixtureEffectiveRootTaskContext.agent_granted_root).toBe(true);
    expect(fixtureEffectiveRootTaskContext.current_attempt_effective_root).toBe(true);
    expect(fixtureEffectiveRootTaskContext.effective_root).toBe(true);

    expect(fixtureRootHumanContext.authenticated_subject).toEqual({ type: "user", id: "usr_root_fixture_1" });
    expect(fixtureRootHumanContext.is_agent_origin).toBe(false);

    expect(fixtureAgentOriginPatContext.is_agent_origin).toBe(true);
    expect(fixtureAgentOriginPatContext.authenticated_subject).toEqual({ type: "agent", id: "agt_root_fixture_1" });
    expect(fixtureAgentOriginPatContext.beneficiary_user_id).toBe("usr_target_fixture_2");
  });

  it("enforces A2 JWE wire parameters, identical replay invariants, secret-free status, and monotonic receiver states", () => {
    expect(ROOT_DELIVERY_JWE_ALG).toBe("RSA-OAEP-256");
    expect(ROOT_DELIVERY_JWE_ENC).toBe("A256GCM");
    expect(ROOT_DELIVERY_MIN_RSA_BITS).toBe(3072);

    expect(DAEMON_UPLINK_RPC_FRAMES).toContain("delivery.receipt.status");
    expect(DAEMON_UPLINK_RPC_FRAMES).toContain("delivery.receipt.replay");
    expect(DAEMON_UPLINK_RPC_FRAMES).toContain("delivery.receipt.install_ack");
    expect(DAEMON_PROTOCOL_CAPS).toContain("root.delivery");
    expect(DAEMON_PROTOCOL_ERROR_CODES).toContain("receipt_conflict");
    expect(DAEMON_PROTOCOL_ERROR_CODES).toContain("security_state_unavailable");
    expect(DAEMON_RETRYABLE_ERROR_CODES).toContain("security_state_unavailable");

    // Same-receipt replay preserves identical envelope, digest, expiry, and delivery/material versions.
    expect(fixtureDeliveryReplayResponse.envelope).toBe(fixtureDeliveryActivationResponse.envelope);
    expect(fixtureDeliveryReplayResponse.envelope_digest).toBe(fixtureDeliveryActivationResponse.envelope_digest);
    expect(fixtureDeliveryReplayResponse.tuple).toEqual(fixtureDeliveryActivationResponse.tuple);

    // Status and journal responses never expose raw or envelope fields.
    expect(() => assertStatusResponseHasNoSecrets(fixtureDeliveryStatusResponse)).not.toThrow();
    expect(() => assertStatusResponseHasNoSecrets(fixtureDeliveryJournalEntry)).not.toThrow();
    expect(() => assertStatusResponseHasNoSecrets({
      ...fixtureDeliveryStatusResponse,
      envelope: "leaked.jwe",
    })).toThrow(/envelope/);
    expect(() => assertStatusResponseHasNoSecrets({
      ...fixtureDeliveryStatusResponse,
      raw: "mul_secret",
    })).toThrow(/raw/);

    // Receiver state transitions are monotonic and cannot regress.
    expect(isMonotonicReceiverTransition(null, "received")).toBe(true);
    expect(isMonotonicReceiverTransition(null, "installed")).toBe(false);
    expect(isMonotonicReceiverTransition("received", "installed")).toBe(true);
    expect(isMonotonicReceiverTransition("installed", "confirmed")).toBe(true);
    expect(isMonotonicReceiverTransition("confirmed", "started")).toBe(true);
    expect(isMonotonicReceiverTransition("started", "installed")).toBe(false);
  });

  it("resolves root immutable env carrier strictly without legacy task-context file fallback", () => {
    const dir = mkdtempSync(join(tmpdir(), "remi-root-carrier-"));
    try {
      const filePath = join(dir, "task-context.json");
      writeFileSync(filePath, JSON.stringify({
        token: "legacy-file-token",
        turn_id: "trn_legacy",
        attempt_id: "att_legacy",
        written_at: "2026-11-24T12:00:00.000Z",
      }));

      // Ordinary non-root task preserves file -> env behavior.
      const legacy = resolveTaskContext({
        [TASK_CONTEXT_FILE_ENV]: filePath,
        MULTIREMI_TOKEN: "env-token",
      });
      expect(legacy.source).toBe("file");
      expect(legacy.token).toBe("legacy-file-token");

      // Root immutable env carrier succeeds when legacy file env is absent.
      const validRoot = resolveTaskContext({
        [ROOT_CARRIER_MODE_ENV]: ROOT_CARRIER_IMMUTABLE_ENV,
        [ROOT_RECEIPT_ID_ENV]: "rcpt_fixture_1",
        [ROOT_DELIVERY_VERSION_ENV]: "1",
        [ROOT_RUN_GENERATION_ENV]: "1",
        MULTIREMI_TOKEN: "root-run-env-token",
        MULTIREMI_TURN_ID: "trn_root",
        MULTIREMI_ATTEMPT_ID: "att_root",
      });
      expect(validRoot).toEqual({
        token: "root-run-env-token",
        turnId: "trn_root",
        attemptId: "att_root",
        source: "root_immutable_env",
        parked: false,
        rootCarrier: {
          mode: "immutable_run_env",
          receiptId: "rcpt_fixture_1",
          deliveryVersion: 1,
          runGeneration: 1,
          violation: null,
        },
      });

      // Root immutable env carrier fails closed if legacy MULTIREMI_TASK_CONTEXT_FILE leaked into env.
      const poisonedRoot = resolveTaskContext({
        [ROOT_CARRIER_MODE_ENV]: ROOT_CARRIER_IMMUTABLE_ENV,
        [TASK_CONTEXT_FILE_ENV]: filePath,
        MULTIREMI_TOKEN: "root-run-env-token",
      });
      expect(poisonedRoot.source).toBe("root_immutable_env");
      expect(poisonedRoot.token).toBeNull();
      expect(poisonedRoot.rootCarrier?.violation).toBe("root_context_file_forbidden");

      // Root immutable env carrier fails closed if token is missing (never silently falls back).
      const missingTokenRoot = resolveTaskContext({
        [ROOT_CARRIER_MODE_ENV]: ROOT_CARRIER_IMMUTABLE_ENV,
      });
      expect(missingTokenRoot.token).toBeNull();
      expect(missingTokenRoot.rootCarrier?.violation).toBe("root_immutable_env_missing");

      // buildRootImmutableRunEnv strips inherited MULTIREMI_TASK_CONTEXT_FILE and passes resolveTaskContext.
      const builtEnv = buildRootImmutableRunEnv({
        token: "root-built-token",
        turnId: "trn_built",
        attemptId: "att_built",
        receiptId: "rcpt_built",
        deliveryVersion: 1,
        runGeneration: 1,
        baseEnv: {
          PATH: "/usr/bin",
          [TASK_CONTEXT_FILE_ENV]: filePath,
        },
      });
      expect(TASK_CONTEXT_FILE_ENV in builtEnv).toBe(false);
      expect(resolveTaskContext(builtEnv)).toEqual({
        token: "root-built-token",
        turnId: "trn_built",
        attemptId: "att_built",
        source: "root_immutable_env",
        parked: false,
        rootCarrier: {
          mode: "immutable_run_env",
          receiptId: "rcpt_built",
          deliveryVersion: 1,
          runGeneration: 1,
          violation: null,
        },
      });
      expect(() => assertOrdinaryTaskContextOnly(builtEnv)).toThrow(/MULTIREMI_TASK_CONTEXT_FILE/);
      expect(() => assertOrdinaryTaskContextOnly({ MULTIREMI_TOKEN: "ordinary" })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers root.delivery capability and enforces fail-closed negotiation without downgrade", () => {
    expect(DAEMON_CAPABILITY_REGISTRY[ROOT_DELIVERY_CAPABILITY]).toEqual({
      aliases: [],
      introduced: "0.2.96",
      contract: null,
    });
    expect(daemonCapabilityName(ROOT_DELIVERY_CAPABILITY)).toBe(ROOT_DELIVERY_CAPABILITY);
    expect(hasDaemonCapability([ROOT_DELIVERY_CAPABILITY], ROOT_DELIVERY_CAPABILITY)).toBe(true);
    expect(DAEMON_PROTOCOL_ERROR_CODES).toContain("root_delivery_unsupported");
    expect(DAEMON_PROTOCOL_ERROR_CODES).toContain("root_delivery_invalid");
    expect(DAEMON_RETRYABLE_ERROR_CODES).not.toContain("root_delivery_unsupported" as never);
    expect(DAEMON_RETRYABLE_ERROR_CODES).not.toContain("root_delivery_invalid" as never);

    expect(evaluateRootDeliveryNegotiation(fixtureRootDeliveryNegotiationInput)).toEqual({
      eligible: true,
      delivery_mode: ROOT_DELIVERY_MODE,
      root_delivery_protocol: ROOT_DELIVERY_PROTOCOL_VERSION,
      carrier_mode: "immutable_run_env",
    });

    const missingHelloCap = evaluateRootDeliveryNegotiation({
      ...fixtureRootDeliveryNegotiationInput,
      hello_caps: ["offer", "turn.message", "turn.restart"],
    });
    expect(missingHelloCap).toMatchObject({
      eligible: false,
      code: "root_delivery_unsupported",
      downgrade_allowed: false,
    });

    const missingWelcomeCap = evaluateRootDeliveryNegotiation({
      ...fixtureRootDeliveryNegotiationInput,
      welcome_caps: ["turn.restart"],
    });
    expect(missingWelcomeCap).toMatchObject({
      eligible: false,
      code: "root_delivery_unsupported",
      downgrade_allowed: false,
    });

    const wrongProtocol = evaluateRootDeliveryNegotiation({
      ...fixtureRootDeliveryNegotiationInput,
      runtime_capabilities: { root_delivery_protocol: 2, root_carrier_modes: ["immutable_run_env"] },
    });
    expect(wrongProtocol).toMatchObject({
      eligible: false,
      code: "root_delivery_unsupported",
      downgrade_allowed: false,
    });

    const missingCarrier = evaluateRootDeliveryNegotiation({
      ...fixtureRootDeliveryNegotiationInput,
      runtime_capabilities: { root_delivery_protocol: 1, root_carrier_modes: [] },
    });
    expect(missingCarrier).toMatchObject({
      eligible: false,
      code: "root_delivery_unsupported",
      downgrade_allowed: false,
    });

    const untrustedRuntime = evaluateRootDeliveryNegotiation({
      ...fixtureRootDeliveryNegotiationInput,
      runtime_trusted: false,
    });
    expect(untrustedRuntime).toMatchObject({
      eligible: false,
      code: "root_runtime_untrusted",
      downgrade_allowed: false,
    });

    const untrustedConsumer = evaluateRootDeliveryNegotiation({
      ...fixtureRootDeliveryNegotiationInput,
      consumer_trusted: false,
    });
    expect(untrustedConsumer).toMatchObject({
      eligible: false,
      code: "root_runtime_untrusted",
      downgrade_allowed: false,
    });
  });

  it("discriminates initial root task.offer and blocks downgrade into normalizeDaemonTurnOffer / handleTask", () => {
    const classified = classifyDaemonTaskOfferPayload(fixtureRootTaskOfferPayload);
    expect(classified.kind).toBe("root");
    if (classified.kind === "root") {
      expect(classified.payload.delivery_mode).toBe("root_envelope");
      expect(classified.payload.root_delivery_protocol).toBe(1);
      expect(classified.payload.carrier_mode).toBe("immutable_run_env");
      expect(classified.payload.root_delivery).toEqual(fixtureInitialRootDeliveryEnvelopePayload);
      expect("auth_token" in classified.payload).toBe(false);
      expect("input_messages" in classified.payload).toBe(false);
    }

    // Even if a root task.offer accidentally reached the legacy ordinary parser, it fails closed.
    expect(() => normalizeDaemonTurnOffer(fixtureRootTaskOfferPayload as unknown as Record<string, unknown>)).toThrow(
      /invalid turn offer payload/,
    );

    // Ordinary offer without root indicators classifies as standard.
    expect(classifyDaemonTaskOfferPayload({
      turn_id: "trn_plain_1",
      attempt_id: "att_plain_1",
      input_from_seq: 0,
      input_to_seq: 1,
      input_messages: [],
    })).toEqual({ kind: "standard" });

    // Compilable reference router routes root offers to protected receiver and rejects untrusted/incapable consumers.
    expect(compileExampleRouteOfferFrame(fixtureRootTaskOfferPayload, fixtureRootDeliveryNegotiationInput)).toEqual({
      branch: "protected_root_receiver",
      payload: fixtureRootTaskOfferPayload,
    });
    expect(compileExampleRouteOfferFrame(fixtureRootTaskOfferPayload, {
      ...fixtureRootDeliveryNegotiationInput,
      hello_caps: ["offer"],
    })).toMatchObject({ branch: "reject", code: "root_delivery_unsupported" });
    expect(compileExampleRouteOfferFrame(fixtureRootTaskOfferPayload, {
      ...fixtureRootDeliveryNegotiationInput,
      runtime_trusted: false,
    })).toMatchObject({ branch: "reject", code: "root_runtime_untrusted" });

    // Malformed, plaintext-leaking, hybrid, or version-mismatched root offers fail closed (never "standard").
    expect(classifyDaemonTaskOfferPayload({
      ...fixtureRootTaskOfferPayload,
      auth_token: "leaked_raw_secret",
    })).toMatchObject({ kind: "invalid_root", code: "root_delivery_invalid" });

    expect(classifyDaemonTaskOfferPayload({
      ...fixtureRootTaskOfferPayload,
      input_messages: [],
    })).toMatchObject({ kind: "invalid_root", code: "root_delivery_invalid" });

    expect(classifyDaemonTaskOfferPayload({
      ...fixtureRootTaskOfferPayload,
      root_delivery: {
        ...fixtureInitialRootDeliveryEnvelopePayload,
        frozen_business_payload: { raw: "leaked" },
      },
    })).toMatchObject({ kind: "invalid_root", code: "root_delivery_invalid" });

    expect(classifyDaemonTaskOfferPayload({
      ...fixtureRootTaskOfferPayload,
      root_delivery_protocol: 99,
    })).toMatchObject({ kind: "invalid_root", code: "root_delivery_unsupported" });

    expect(() => buildDaemonRootTaskOfferPayload({
      turn_id: "trn_mismatched",
      attempt_id: fixtureInitialRootDeliveryEnvelopePayload.tuple.attempt_id,
      root_delivery: fixtureInitialRootDeliveryEnvelopePayload,
    })).toThrow(/turn_id/);

    expect(() => buildDaemonRootTaskOfferPayload({
      turn_id: "trn_root_fixture_1",
      attempt_id: "att_mismatched",
      root_delivery: fixtureInitialRootDeliveryEnvelopePayload,
    })).toThrow(/attempt_id/);

    expect(() => buildDaemonRootTaskOfferPayload({
      turn_id: "trn_root_fixture_1",
      attempt_id: fixtureResumeRootDeliveryEnvelopePayload.tuple.attempt_id,
      root_delivery: fixtureResumeRootDeliveryEnvelopePayload,
    })).toThrow(/handoff_id/);
  });

  it("discriminates root turn.restart.resume requests and replies aligned with receipt replay", () => {
    const reqClassified = classifyDaemonRestartResumeRequest(fixtureRootRestartResumeRequest);
    expect(reqClassified).toEqual({
      kind: "root",
      payload: fixtureRootRestartResumeRequest,
    });

    expect(classifyDaemonRestartResumeRequest({
      turn_id: "trn_plain_1",
      attempt_id: "att_plain_1",
      handoff_id: "hoff_plain_1",
      generation: 1,
      consumer_id: "cons_plain_consumer_1234",
    })).toEqual({ kind: "standard" });

    expect(classifyDaemonRestartResumeRequest({
      ...fixtureRootRestartResumeRequest,
      machine_proof: {
        ...fixtureRootRestartResumeRequest.machine_proof,
        consumer_id: "cons_other_consumer_9999",
      },
    })).toMatchObject({ kind: "invalid_root", code: "root_delivery_invalid" });

    const replyClassified = classifyDaemonRestartResumeReply(fixtureRootRestartResumeReply);
    expect(replyClassified.kind).toBe("root");
    if (replyClassified.kind === "root") {
      // Exact parity with receipt replay immutable RootDeliveryEnvelopePayload.
      expect(replyClassified.payload.root_delivery.tuple).toEqual(fixtureDeliveryReplayResponse.tuple);
      expect(replyClassified.payload.root_delivery.envelope).toBe(fixtureDeliveryReplayResponse.envelope);
      expect(replyClassified.payload.root_delivery.envelope_digest).toBe(fixtureDeliveryReplayResponse.envelope_digest);
      expect(replyClassified.payload.root_delivery.frozen_business_payload).toEqual(
        fixtureDeliveryReplayResponse.frozen_business_payload,
      );
      expect("task" in replyClassified.payload).toBe(false);
    }

    expect(compileExampleRouteResumeReply(fixtureRootRestartResumeReply, fixtureRootDeliveryNegotiationInput)).toEqual({
      branch: "protected_root_receiver",
      reply: fixtureRootRestartResumeReply,
    });
    expect(compileExampleRouteResumeReply(fixtureRootRestartResumeReply, {
      ...fixtureRootDeliveryNegotiationInput,
      runtime_trusted: false,
    })).toMatchObject({ branch: "reject", code: "root_runtime_untrusted" });

    // Hybrid reply with `task` or plaintext `raw` fails closed (never "standard").
    expect(classifyDaemonRestartResumeReply({
      ...fixtureRootRestartResumeReply,
      task: { auth_token: "leaked" },
    })).toMatchObject({ kind: "invalid_root", code: "root_delivery_invalid" });

    expect(() => buildDaemonRootRestartResumeReply({
      turn_id: "trn_root_fixture_1",
      attempt_id: fixtureResumeRootDeliveryEnvelopePayload.tuple.attempt_id,
      handoff_id: "hoff_wrong",
      generation: 1,
      root_delivery: fixtureResumeRootDeliveryEnvelopePayload,
    })).toThrow(/handoff_id/);
  });
});
