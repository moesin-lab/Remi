import { randomUUID } from "node:crypto";
import {
  ROOT_API_PATHS,
  ROOT_SECURITY_REVOKE_REASONS,
  ROOT_SUBJECT_TYPES,
  type RootSecurityRevokeReasonCode,
  type RootSubjectType,
} from "@multiremi/contracts/root-authority.js";
import {
  CliError,
  CliRenderer,
  type CliIdentity,
  type CliMutation,
  type CliOptionSpec,
  type CommandInvocation,
  type CommandSpec,
} from "../core/index.js";
import { taskCarrierInfo } from "../core/task-context.js";
import {
  INPUT_OPTIONS,
  PAGE_OPTIONS,
  YES_OPTION,
  clientFor,
  commandOptions,
  extractRecords,
  integerOption,
  isRecord,
  outputMode,
  positional,
  queryOptions,
  renderResource,
  requestBody,
  requireConfirmation,
  stringOption,
  stringOptions,
} from "./resource-common.js";

const ALL_AUTH: readonly CliIdentity[] = ["human", "task", "daemon", "share"];
const ROOT_AUTH: readonly CliIdentity[] = ["human", "task"];

export function rootCommandSpecs(): CommandSpec[] {
  return [
    group("root", "Inspect and manage system root authority, Runtime trust, and credential families"),
    spec(
      "root.context",
      ["root", "context"],
      "Show current transport identity, real subject, granted root, and effective attempt root",
      "read",
      ALL_AUTH,
      false,
      [],
      [],
      async (invocation) => {
        const client = await clientFor(invocation, { skipCapability: true });
        const response = await client.request<Record<string, unknown>>({
          method: "GET",
          path: ROOT_API_PATHS.context,
        });
        const carrier = taskCarrierInfo();
        const payload = carrier
          ? {
              ...response.data,
              local_carrier: {
                mode: carrier.mode,
                receipt_id: carrier.receiptId,
                delivery_version: carrier.deliveryVersion,
                run_generation: carrier.runGeneration,
              },
            }
          : response.data;
        renderRootContext(invocation, payload);
      },
    ),
    spec(
      "root.grant.list",
      ["root", "grant", "list"],
      "List system root grants",
      "read",
      ROOT_AUTH,
      true,
      [],
      [
        { name: "subject-type", type: "string", valueName: "user|agent", description: "Filter by subject type" },
        { name: "subject-id", type: "string", valueName: "id", description: "Filter by subject ID" },
        { name: "status", type: "string", valueName: "active|revoked|expired", description: "Filter by grant status" },
      ],
      async (invocation) => {
        const client = await clientFor(invocation);
        const subjectType = optionalSubjectType(invocation);
        const response = await client.request<Record<string, unknown>>({
          method: "GET",
          path: ROOT_API_PATHS.grants,
          query: queryOptions(invocation, {
            subject_type: subjectType,
            subject_id: stringOption(invocation, "subject-id"),
            status: stringOption(invocation, "status"),
          }),
        });
        renderGrants(invocation, response.data);
      },
    ),
    spec(
      "root.grant.preview", ["root", "grant", "preview"], "Preview an Agent grant's current dependencies",
      "read", ROOT_AUTH, true, [], [
        { name: "agent-id", type: "string", required: true, description: "Target Agent ID" },
        { name: "runtime-trust", type: "string", repeatable: true, description: "Runtime trust ID" },
      ], async invocation => {
        const client = await clientFor(invocation);
        const agentId = requireStringField(stringOption(invocation, "agent-id"), "--agent-id");
        const response = await client.request<Record<string, unknown>>({ method: "GET", path: ROOT_API_PATHS.agentGrantPreview(agentId),
          query: { runtime_trust_id: stringOptions(invocation, "runtime-trust") } });
        renderRootDocument(invocation, response.data);
      },
    ),
    spec(
      "root.agent-configuration.approve", ["root", "agent-configuration", "approve"], "Approve versioned Agent execution dependencies",
      "write", ROOT_AUTH, true, [], [...INPUT_OPTIONS,
        { name: "agent-id", type: "string", required: true, description: "Target Agent ID" },
      ], async invocation => {
        const client = await clientFor(invocation);
        const agentId = requireStringField(stringOption(invocation, "agent-id"), "--agent-id");
        const response = await client.request<Record<string, unknown>>({ method: "POST", path: ROOT_API_PATHS.agentConfigurationApprove(agentId),
          body: await requestBody(invocation) });
        renderRootDocument(invocation, response.data);
      },
    ),
    spec(
      "root.agent-pat.create", ["root", "agent-pat", "create"], "Issue a persistent PAT for the authenticated running Agent",
      "write", ["task"], true, [], [
        { name: "expires-at", type: "string", required: true, description: "ISO-8601 expiry" },
        { name: "idempotency-key", type: "string", description: "Idempotency key" },
      ], async invocation => {
        const client = await clientFor(invocation);
        const idempotencyKey = stringOption(invocation, "idempotency-key") ?? randomUUID();
        const response = await client.request<Record<string, unknown>>({ method: "POST", path: ROOT_API_PATHS.agentPatCreate,
          idempotencyKey, body: { idempotency_key: idempotencyKey, expires_at: stringOption(invocation, "expires-at") } });
        renderRootDocument(invocation, response.data);
      },
    ),
    spec(
      "root.delegation.revoke", ["root", "delegation", "revoke"], "Revoke a durable Agent delegation and its descendants",
      "destructive", ROOT_AUTH, true, [], [...INPUT_OPTIONS, YES_OPTION,
        { name: "origin-id", type: "string", required: true, description: "Durable origin node ID" },
      ], async invocation => {
        const originId = requireStringField(stringOption(invocation, "origin-id"), "--origin-id");
        const client = await clientFor(invocation);
        const input = await requestBody(invocation);
        const idempotencyKey = stringField(input.idempotency_key) ?? randomUUID();
        requireConfirmation(invocation);
        const response = await client.request<Record<string, unknown>>({ method: "POST", path: ROOT_API_PATHS.delegationRevoke(originId),
          idempotencyKey, body: { ...input, idempotency_key: idempotencyKey } });
        renderRootDocument(invocation, response.data);
      },
    ),
    spec(
      "root.grant.create",
      ["root", "grant", "create"],
      "Explicitly grant system root authority to a real user or agent subject",
      "write",
      ROOT_AUTH,
      true,
      [],
      [
        ...INPUT_OPTIONS,
        { name: "subject-type", type: "string", valueName: "user|agent", description: "Target subject type", required: false },
        { name: "subject-id", type: "string", valueName: "id", description: "Target real user or agent ID", required: false },
        { name: "reason", type: "string", valueName: "text", description: "Audit reason for granting root" },
        { name: "expected-revision", type: "integer", valueName: "n", description: "Expected security revision" },
        { name: "idempotency-key", type: "string", valueName: "key", description: "Idempotency key (auto-generated when omitted)" },
        { name: "expires-at", type: "string", valueName: "iso", description: "Optional ISO-8601 expiry timestamp" },
        { name: "runtime-trust", type: "string", valueName: "trust-id", repeatable: true, description: "Trusted Runtime ID(s) bound to an agent grant" },
        { name: "accepted-dependency-digest", type: "string", valueName: "digest", description: "Reviewed dependency digest for agent grant" },
      ],
      async (invocation) => {
        const client = await clientFor(invocation);
        const base = await requestBody(invocation);
        const subject = resolveSubjectInput(invocation, base);
        const reason = requireStringField(stringOption(invocation, "reason") ?? stringField(base.reason), "--reason");
        const expectedRevision = requireRevision(integerOption(invocation, "expected-revision") ?? numberField(base.expected_revision));
        const idempotencyKey = stringOption(invocation, "idempotency-key") ?? stringField(base.idempotency_key) ?? randomUUID();
        const runtimeTrustIds = stringOptions(invocation, "runtime-trust");
        const body: Record<string, unknown> = {
          subject,
          reason,
          expected_revision: expectedRevision,
          idempotency_key: idempotencyKey,
          ...(stringOption(invocation, "expires-at") !== null
            ? { expires_at: stringOption(invocation, "expires-at") }
            : "expires_at" in base
              ? { expires_at: base.expires_at }
              : {}),
          ...(runtimeTrustIds.length > 0
            ? { runtime_trust_ids: runtimeTrustIds }
            : Array.isArray(base.runtime_trust_ids)
              ? { runtime_trust_ids: base.runtime_trust_ids }
              : {}),
          ...(stringOption(invocation, "accepted-dependency-digest") !== null
            ? { accepted_dependency_digest: stringOption(invocation, "accepted-dependency-digest") }
            : "accepted_dependency_digest" in base
              ? { accepted_dependency_digest: base.accepted_dependency_digest }
              : {}),
        };
        const response = await client.request<Record<string, unknown>>({
          method: "POST",
          path: ROOT_API_PATHS.grants,
          body,
          idempotencyKey,
        });
        renderGrants(invocation, response.data);
      },
    ),
    spec(
      "root.grant.revoke",
      ["root", "grant", "revoke"],
      "Revoke a system root grant and cascade its durable authority descendants",
      "destructive",
      ROOT_AUTH,
      true,
      [ref("grant")],
      [
        ...INPUT_OPTIONS,
        { name: "reason", type: "string", valueName: "text", description: "Audit reason for revoking root" },
        { name: "reason-code", type: "string", valueName: "code", description: "Structured revocation reason code" },
        { name: "expected-revision", type: "integer", valueName: "n", description: "Expected security revision" },
        { name: "idempotency-key", type: "string", valueName: "key", description: "Idempotency key (auto-generated when omitted)" },
        YES_OPTION,
      ],
      async (invocation) => {
        requireConfirmation(invocation);
        const client = await clientFor(invocation);
        const grantId = positional(invocation, 0, "grant");
        const base = await requestBody(invocation);
        const reason = requireStringField(stringOption(invocation, "reason") ?? stringField(base.reason), "--reason");
        const expectedRevision = requireRevision(integerOption(invocation, "expected-revision") ?? numberField(base.expected_revision));
        const reasonCode = optionalRevokeReasonCode(stringOption(invocation, "reason-code") ?? stringField(base.reason_code)) ?? "grant_revoked";
        const idempotencyKey = stringOption(invocation, "idempotency-key") ?? stringField(base.idempotency_key) ?? randomUUID();
        const response = await client.request<Record<string, unknown>>({
          method: "POST",
          path: ROOT_API_PATHS.grantRevoke(grantId),
          body: {
            reason,
            reason_code: reasonCode,
            expected_revision: expectedRevision,
            idempotency_key: idempotencyKey,
          },
          idempotencyKey,
        });
        if (response.data.last_root_revoked === true) {
          console.error("Warning: last active system root grant revoked; restoring root requires the controlled deployment recovery command.");
        }
        renderGrants(invocation, response.data);
      },
    ),
    spec(
      "root.runtime-trust.list",
      ["root", "runtime-trust", "list"],
      "List explicit Runtime root trust records",
      "read",
      ROOT_AUTH,
      true,
      [],
      [
        { name: "runtime", type: "string", valueName: "runtime-id", description: "Filter by Runtime ID" },
        { name: "status", type: "string", valueName: "active|revoked|expired", description: "Filter by trust status" },
      ],
      async (invocation) => {
        const client = await clientFor(invocation);
        const response = await client.request<Record<string, unknown>>({
          method: "GET",
          path: ROOT_API_PATHS.runtimeTrustList,
          query: queryOptions(invocation, {
            runtime_id: stringOption(invocation, "runtime"),
            status: stringOption(invocation, "status"),
          }),
        });
        renderRuntimeTrusts(invocation, response.data);
      },
    ),
    spec(
      "root.runtime-trust.get",
      ["root", "runtime-trust", "get"],
      "Inspect Runtime root trust state and history for a specific Runtime",
      "read",
      ROOT_AUTH,
      true,
      [ref("runtime")],
      [],
      async (invocation) => {
        const client = await clientFor(invocation);
        const runtimeId = positional(invocation, 0, "runtime");
        const response = await client.request<Record<string, unknown>>({
          method: "GET",
          path: ROOT_API_PATHS.runtimeTrustGet(runtimeId),
        });
        renderRuntimeTrusts(invocation, response.data);
      },
    ),
    spec(
      "root.runtime-trust.grant",
      ["root", "runtime-trust", "grant"],
      "Explicitly grant root Runtime trust bound to a daemon incarnation and recipient key",
      "write",
      ROOT_AUTH,
      true,
      [ref("runtime")],
      [
        ...INPUT_OPTIONS,
        { name: "daemon", type: "string", valueName: "daemon-id", description: "Bound daemon ID" },
        { name: "incarnation", type: "string", valueName: "incarnation", description: "Daemon registration incarnation" },
        { name: "recipient-key-id", type: "string", valueName: "key-id", description: "Verified JWE recipient key ID" },
        { name: "recipient-key-fingerprint", type: "string", valueName: "fingerprint", description: "Verified recipient key SHA-256 fingerprint" },
        { name: "recipient-key-expires-at", type: "string", valueName: "iso", description: "Recipient key ISO-8601 expiry" },
        { name: "challenge-id", type: "string", valueName: "id", description: "Key-possession challenge ID" },
        { name: "challenge-response", type: "string", valueName: "response", description: "Signed key-possession challenge response" },
        { name: "isolation-note", type: "string", valueName: "text", description: "Host/process isolation attestation note" },
        { name: "reason", type: "string", valueName: "text", description: "Audit reason for granting Runtime trust" },
        { name: "expected-revision", type: "integer", valueName: "n", description: "Expected security revision" },
        { name: "expires-at", type: "string", valueName: "iso", description: "Optional trust ISO-8601 expiry" },
        { name: "idempotency-key", type: "string", valueName: "key", description: "Idempotency key (auto-generated when omitted)" },
      ],
      async (invocation) => {
        const client = await clientFor(invocation);
        const runtimeId = positional(invocation, 0, "runtime");
        const base = await requestBody(invocation);
        const daemonId = requireStringField(stringOption(invocation, "daemon") ?? stringField(base.daemon_id), "--daemon");
        const incarnation = requireStringField(stringOption(invocation, "incarnation") ?? stringField(base.incarnation), "--incarnation");
        const recipientKeyId = requireStringField(stringOption(invocation, "recipient-key-id") ?? stringField(base.recipient_key_id), "--recipient-key-id");
        const recipientKeyFingerprint = requireStringField(
          stringOption(invocation, "recipient-key-fingerprint") ?? stringField(base.recipient_key_fingerprint),
          "--recipient-key-fingerprint",
        );
        const reason = requireStringField(stringOption(invocation, "reason") ?? stringField(base.reason), "--reason");
        const expectedRevision = requireRevision(integerOption(invocation, "expected-revision") ?? numberField(base.expected_revision));
        const idempotencyKey = stringOption(invocation, "idempotency-key") ?? stringField(base.idempotency_key) ?? randomUUID();
        const body: Record<string, unknown> = {
          runtime_id: runtimeId,
          daemon_id: daemonId,
          incarnation,
          recipient_key_id: recipientKeyId,
          recipient_key_fingerprint: recipientKeyFingerprint,
          reason,
          expected_revision: expectedRevision,
          idempotency_key: idempotencyKey,
          ...(stringOption(invocation, "recipient-key-expires-at") !== null
            ? { recipient_key_expires_at: stringOption(invocation, "recipient-key-expires-at") }
            : "recipient_key_expires_at" in base
              ? { recipient_key_expires_at: base.recipient_key_expires_at }
              : {}),
          ...(stringOption(invocation, "challenge-id") !== null
            ? { challenge_id: stringOption(invocation, "challenge-id") }
            : "challenge_id" in base
              ? { challenge_id: base.challenge_id }
              : {}),
          ...(stringOption(invocation, "challenge-response") !== null
            ? { challenge_response: stringOption(invocation, "challenge-response") }
            : "challenge_response" in base
              ? { challenge_response: base.challenge_response }
              : {}),
          ...(stringOption(invocation, "isolation-note") !== null
            ? { isolation_note: stringOption(invocation, "isolation-note") }
            : "isolation_note" in base
              ? { isolation_note: base.isolation_note }
              : {}),
          ...(stringOption(invocation, "expires-at") !== null
            ? { expires_at: stringOption(invocation, "expires-at") }
            : "expires_at" in base
              ? { expires_at: base.expires_at }
              : {}),
        };
        const response = await client.request<Record<string, unknown>>({
          method: "POST",
          path: ROOT_API_PATHS.runtimeTrustGrant,
          body,
          idempotencyKey,
        });
        renderRuntimeTrusts(invocation, response.data);
      },
    ),
    spec(
      "root.runtime-trust.revoke",
      ["root", "runtime-trust", "revoke"],
      "Revoke a Runtime root trust record and invalidate its dependent execution origins",
      "destructive",
      ROOT_AUTH,
      true,
      [ref("trust")],
      [
        ...INPUT_OPTIONS,
        { name: "reason", type: "string", valueName: "text", description: "Audit reason for revoking Runtime trust" },
        { name: "reason-code", type: "string", valueName: "code", description: "Structured revocation reason code" },
        { name: "expected-revision", type: "integer", valueName: "n", description: "Expected security revision" },
        { name: "idempotency-key", type: "string", valueName: "key", description: "Idempotency key (auto-generated when omitted)" },
        YES_OPTION,
      ],
      async (invocation) => {
        requireConfirmation(invocation);
        const client = await clientFor(invocation);
        const trustId = positional(invocation, 0, "trust");
        const base = await requestBody(invocation);
        const reason = requireStringField(stringOption(invocation, "reason") ?? stringField(base.reason), "--reason");
        const expectedRevision = requireRevision(integerOption(invocation, "expected-revision") ?? numberField(base.expected_revision));
        const reasonCode = optionalRevokeReasonCode(stringOption(invocation, "reason-code") ?? stringField(base.reason_code)) ?? "trust_revoked";
        const idempotencyKey = stringOption(invocation, "idempotency-key") ?? stringField(base.idempotency_key) ?? randomUUID();
        const response = await client.request<Record<string, unknown>>({
          method: "POST",
          path: ROOT_API_PATHS.runtimeTrustRevoke(trustId),
          body: {
            reason,
            reason_code: reasonCode,
            expected_revision: expectedRevision,
            idempotency_key: idempotencyKey,
          },
          idempotencyKey,
        });
        renderRuntimeTrusts(invocation, response.data);
      },
    ),
    spec(
      "root.credential-family.revoke",
      ["root", "credential-family", "revoke"],
      "Monotonically revoke a credential family and cascade all derived authorities",
      "destructive",
      ROOT_AUTH,
      true,
      [ref("family")],
      [
        ...INPUT_OPTIONS,
        {
          name: "reason-code",
          type: "string",
          valueName: "code",
          description: `Security revocation reason code (${ROOT_SECURITY_REVOKE_REASONS.join("|")})`,
        },
        { name: "reason", type: "string", valueName: "text", description: "Non-secret audit reason for revoking the family" },
        { name: "expected-revision", type: "integer", valueName: "n", description: "Expected security revision" },
        { name: "idempotency-key", type: "string", valueName: "key", description: "Idempotency key (auto-generated when omitted)" },
        YES_OPTION,
      ],
      async (invocation) => {
        requireConfirmation(invocation);
        const client = await clientFor(invocation);
        const familyId = positional(invocation, 0, "family");
        const base = await requestBody(invocation);
        const rawCode = requireStringField(stringOption(invocation, "reason-code") ?? stringField(base.reason_code), "--reason-code");
        const reasonCode = requireRevokeReasonCode(rawCode);
        const reason = requireStringField(stringOption(invocation, "reason") ?? stringField(base.reason), "--reason");
        const expectedRevision = requireRevision(integerOption(invocation, "expected-revision") ?? numberField(base.expected_revision));
        const idempotencyKey = stringOption(invocation, "idempotency-key") ?? stringField(base.idempotency_key) ?? randomUUID();
        const response = await client.request<Record<string, unknown>>({
          method: "POST",
          path: ROOT_API_PATHS.credentialFamilyRevoke(familyId),
          body: {
            reason_code: reasonCode,
            reason,
            expected_revision: expectedRevision,
            idempotency_key: idempotencyKey,
          },
          idempotencyKey,
        });
        renderResource(invocation, response.data);
      },
    ),
    spec(
      "root.audit.list",
      ["root", "audit", "list"],
      "List root authority and sensitive access audit entries",
      "read",
      ROOT_AUTH,
      true,
      [],
      [
        { name: "action", type: "string", valueName: "action", description: "Filter by audit action" },
        { name: "target-type", type: "string", valueName: "type", description: "Filter by target type" },
        { name: "target-id", type: "string", valueName: "id", description: "Filter by target ID" },
        { name: "actor-id", type: "string", valueName: "id", description: "Filter by actor ID" },
      ],
      async (invocation) => {
        const client = await clientFor(invocation);
        const response = await client.request<Record<string, unknown>>({
          method: "GET",
          path: ROOT_API_PATHS.audit,
          query: queryOptions(invocation, {
            action: stringOption(invocation, "action"),
            target_type: stringOption(invocation, "target-type"),
            target_id: stringOption(invocation, "target-id"),
            actor_id: stringOption(invocation, "actor-id"),
          }),
        });
        renderAudit(invocation, response.data);
      },
    ),
  ];
}

function renderRootDocument(invocation: CommandInvocation, value: Record<string, unknown>): void {
  if (outputMode(invocation) === "table") {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  renderResource(invocation, value);
}

function spec(
  id: string,
  path: string[],
  description: string,
  mutation: CliMutation,
  auth: readonly CliIdentity[],
  rootConditional: boolean,
  positionals: CommandSpec["positionals"],
  options: readonly CliOptionSpec[],
  run: CommandSpec["run"],
): CommandSpec {
  return {
    id,
    path,
    description,
    capability: id,
    auth,
    rootConditional,
    mutation,
    outputs: ["table", "json", "jsonl"],
    positionals,
    options: commandOptions(options, mutation === "read" ? PAGE_OPTIONS : []),
    run,
  };
}

function group(id: string, description: string): CommandSpec {
  return {
    id,
    path: [id],
    description,
    parse: "passthrough",
    run: async () => {
      throw new CliError("usage", `usage: remi ${id} <command>`);
    },
  };
}

function ref(name: string) {
  return { name, required: true } as const;
}

function optionalSubjectType(invocation: CommandInvocation): RootSubjectType | null {
  const value = stringOption(invocation, "subject-type");
  if (value === null) return null;
  if (!(ROOT_SUBJECT_TYPES as readonly string[]).includes(value)) {
    throw new CliError("usage", `--subject-type must be one of: ${ROOT_SUBJECT_TYPES.join(", ")}`);
  }
  return value as RootSubjectType;
}

function resolveSubjectInput(
  invocation: CommandInvocation,
  base: Record<string, unknown>,
): { type: RootSubjectType; id: string } {
  const rawSubject = isRecord(base.subject) ? base.subject : null;
  const typeValue = stringOption(invocation, "subject-type") ?? stringField(rawSubject?.type);
  const idValue = stringOption(invocation, "subject-id") ?? stringField(rawSubject?.id);
  if (!typeValue || !(ROOT_SUBJECT_TYPES as readonly string[]).includes(typeValue)) {
    throw new CliError("usage", `--subject-type must be one of: ${ROOT_SUBJECT_TYPES.join(", ")}`);
  }
  if (!idValue) throw new CliError("usage", "--subject-id is required");
  return { type: typeValue as RootSubjectType, id: idValue };
}

function optionalRevokeReasonCode(value: string | null): RootSecurityRevokeReasonCode | null {
  if (value === null) return null;
  return requireRevokeReasonCode(value);
}

function requireRevokeReasonCode(value: string): RootSecurityRevokeReasonCode {
  if (!(ROOT_SECURITY_REVOKE_REASONS as readonly string[]).includes(value)) {
    throw new CliError("usage", `--reason-code must be one of: ${ROOT_SECURITY_REVOKE_REASONS.join(", ")}`);
  }
  return value as RootSecurityRevokeReasonCode;
}

function requireStringField(value: string | null, label: string): string {
  if (!value) throw new CliError("usage", `${label} is required`);
  return value;
}

function requireRevision(value: number | null): number {
  if (value === null || !Number.isSafeInteger(value) || value < 0) {
    throw new CliError("usage", "--expected-revision must be a non-negative integer");
  }
  return value;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function renderRootContext(invocation: CommandInvocation, data: Record<string, unknown>): void {
  const mode = outputMode(invocation);
  new CliRenderer().render(data, {
    mode,
    rows: (value) => {
      if (!isRecord(value)) return [];
      const subject = isRecord(value.authenticated_subject)
        ? `${stringField(value.authenticated_subject.type) ?? "?"}:${stringField(value.authenticated_subject.id) ?? "?"}`
        : "none";
      const rows: Array<{ field: string; value: string }> = [
        { field: "transport_identity", value: String(value.transport_identity ?? "-") },
        { field: "authenticated_subject", value: subject },
        { field: "is_agent_origin", value: String(Boolean(value.is_agent_origin)) },
        ...(stringField(value.beneficiary_user_id) ? [{ field: "beneficiary_user_id", value: String(value.beneficiary_user_id) }] : []),
        { field: "agent_granted_root", value: String(Boolean(value.agent_granted_root)) },
        { field: "current_attempt_effective_root", value: String(Boolean(value.current_attempt_effective_root)) },
        { field: "effective_root", value: String(Boolean(value.effective_root)) },
        { field: "effective_reason_code", value: String(value.effective_reason_code ?? "-") },
        { field: "grant_id", value: String(value.grant_id ?? "-") },
        { field: "grant_generation", value: value.grant_generation == null ? "-" : String(value.grant_generation) },
        { field: "family_id", value: String(value.family_id ?? "-") },
        { field: "origin_attempt_id", value: String(value.origin_attempt_id ?? "-") },
        { field: "security_revision", value: String(value.security_revision ?? "-") },
      ];
      if (isRecord(value.local_carrier)) {
        rows.push({
          field: "local_carrier",
          value: `${String(value.local_carrier.mode ?? "-")} (receipt=${String(value.local_carrier.receipt_id ?? "-")})`,
        });
      }
      return rows;
    },
    columns: [
      { header: "FIELD", value: (row) => String(row.field) },
      { header: "VALUE", value: (row) => String(row.value) },
    ],
  });
}

function renderGrants(invocation: CommandInvocation, data: Record<string, unknown>): void {
  const mode = outputMode(invocation);
  new CliRenderer().render(data, {
    mode,
    rows: (value) => {
      if (isRecord(value) && isRecord(value.grant)) return [value.grant];
      return extractRecords(value, ["grants"]);
    },
    columns: [
      { header: "ID", value: (row) => String(row.id ?? "-"), maxWidth: 28 },
      {
        header: "SUBJECT",
        value: (row) => isRecord(row.subject) ? `${String(row.subject.type)}:${String(row.subject.id)}` : "-",
        maxWidth: 36,
      },
      { header: "GEN", value: (row) => row.generation == null ? "-" : String(row.generation) },
      { header: "STATUS", value: (row) => String(row.status ?? "-") },
      { header: "EFFECTIVE", value: (row) => `${String(Boolean(row.effective))} (${String(row.effective_reason_code ?? "-")})`, maxWidth: 32 },
      { header: "REV", value: (row) => row.revision == null ? "-" : String(row.revision) },
    ],
  });
}

function renderRuntimeTrusts(invocation: CommandInvocation, data: Record<string, unknown>): void {
  const mode = outputMode(invocation);
  new CliRenderer().render(data, {
    mode,
    rows: (value) => {
      if (isRecord(value) && isRecord(value.trust)) return [value.trust];
      if (isRecord(value) && isRecord(value.active_trust)) return [value.active_trust];
      return extractRecords(value, ["trusts", "history"]);
    },
    columns: [
      { header: "ID", value: (row) => String(row.id ?? "-"), maxWidth: 28 },
      { header: "RUNTIME", value: (row) => String(row.runtime_id ?? "-"), maxWidth: 28 },
      { header: "INCARNATION", value: (row) => String(row.incarnation ?? "-"), maxWidth: 24 },
      { header: "KEY", value: (row) => String(row.recipient_key_id ?? "-"), maxWidth: 24 },
      { header: "STATUS", value: (row) => `${String(row.status ?? "-")} (${String(Boolean(row.effective))})`, maxWidth: 24 },
    ],
  });
}

function renderAudit(invocation: CommandInvocation, data: Record<string, unknown>): void {
  const mode = outputMode(invocation);
  new CliRenderer().render(data, {
    mode,
    rows: (value) => extractRecords(value, ["entries"]),
    columns: [
      { header: "ID", value: (row) => String(row.id ?? "-"), maxWidth: 24 },
      { header: "ACTION", value: (row) => String(row.action ?? "-"), maxWidth: 30 },
      {
        header: "ACTOR",
        value: (row) => isRecord(row.actor) ? `${String(row.actor.type)}:${String(row.actor.id)}` : "-",
        maxWidth: 32,
      },
      { header: "TARGET", value: (row) => `${String(row.target_type ?? "-")}:${String(row.target_id ?? "-")}`, maxWidth: 32 },
      { header: "OUTCOME", value: (row) => String(row.outcome ?? "-") },
    ],
  });
}
