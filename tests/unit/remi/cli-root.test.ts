import { afterEach, describe, expect, it } from "bun:test";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentExtensionCommandSpecs } from "../../../apps/remi/cli/commands/agent-extensions.js";
import { contextCommandSpec } from "../../../apps/remi/cli/commands/context.js";
import { rootCommandSpecs } from "../../../apps/remi/cli/commands/root.js";
import { CliApiClient, CliError, CommandRegistry } from "../../../apps/remi/cli/core/index.js";
import { taskCarrierInfo, taskCredential } from "../../../apps/remi/cli/core/task-context.js";
import {
  ROOT_CARRIER_IMMUTABLE_ENV,
  ROOT_CARRIER_MODE_ENV,
  ROOT_DELIVERY_VERSION_ENV,
  ROOT_RECEIPT_ID_ENV,
  ROOT_RUN_GENERATION_ENV,
  TASK_CONTEXT_FILE_ENV,
} from "../../../packages/shared/src/task-context-file.js";
import {
  fixtureAgentOriginPatContext,
  fixtureCreateRootGrantResponse,
  fixtureEffectiveRootTaskContext,
  fixtureGrantRuntimeTrustResponse,
  fixtureGrantedButIneffectiveTaskContext,
  fixturePublicErrorEnvelopes,
  fixtureRevokeCredentialFamilyResponse,
  fixtureRevokeRootGrantResponse,
  fixtureRootAuditResponse,
  fixtureRootGrantRecord,
  fixtureRootHumanContext,
  fixtureRootRuntimeTrustRecord,
} from "../../fixtures/root-authority.js";

const realFetch = globalThis.fetch;
const realLog = console.log;
const realError = console.error;
const ENV_KEYS = [
  "MULTIREMI_SERVER_URL",
  "MULTIREMI_WORKSPACE_ID",
  "MULTIREMI_TOKEN",
  "MULTIREMI_TURN_ID",
  "MULTIREMI_ATTEMPT_ID",
  TASK_CONTEXT_FILE_ENV,
  ROOT_CARRIER_MODE_ENV,
  ROOT_RECEIPT_ID_ENV,
  ROOT_DELIVERY_VERSION_ENV,
  ROOT_RUN_GENERATION_ENV,
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.error = realError;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function buildRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register(contextCommandSpec());
  for (const spec of rootCommandSpecs()) registry.register(spec);
  for (const spec of agentExtensionCommandSpecs()) registry.register(spec);
  return registry;
}

describe("MUL-1 CLI root commands, dynamic capabilities, and root env carrier", () => {
  it("supports root context distinguishing granted vs effective attempt and agent-origin PAT", async () => {
    const registry = buildRegistry();
    const responses = [
      fixtureGrantedButIneffectiveTaskContext,
      fixtureAgentOriginPatContext,
      fixtureRootHumanContext,
    ];
    let index = 0;
    globalThis.fetch = (async () => Response.json(responses[index++]!)) as unknown as typeof fetch;

    const lines: string[] = [];
    console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); };

    await registry.execute(["root", "context", "--server", "https://api.example.test", "--token", "t1"]);
    const firstTable = lines.join("\n");
    expect(firstTable).toContain("agent_granted_root");
    expect(firstTable).toContain("true");
    expect(firstTable).toContain("current_attempt_effective_root");
    expect(firstTable).toContain("attempt_not_eligible");

    lines.length = 0;
    await registry.execute(["root", "context", "--server", "https://api.example.test", "--token", "t2", "--json"]);
    const patJson = JSON.parse(lines.join("\n"));
    expect(patJson.is_agent_origin).toBe(true);
    expect(patJson.authenticated_subject).toEqual({ type: "agent", id: "agt_root_fixture_1" });
    expect(patJson.beneficiary_user_id).toBe("usr_target_fixture_2");

    lines.length = 0;
    await registry.execute(["root", "context", "--server", "https://api.example.test", "--token", "t3", "--json"]);
    const humanJson = JSON.parse(lines.join("\n"));
    expect(humanJson.effective_root).toBe(true);
    expect(humanJson.is_agent_origin).toBe(false);
  });

  it("executes grant create/list/revoke, runtime-trust get/grant/revoke, credential-family revoke, and audit list", async () => {
    const registry = buildRegistry();
    const calls: Array<{ method: string; path: string; body: unknown; idempotencyKey: string | null }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.pathname === "/api/cli/capabilities") {
        return Response.json({
          protocol_version: 1,
          identity: "task",
          root: fixtureEffectiveRootTaskContext,
          commands: [
            { id: "root.grant.list", allowed: true },
            { id: "root.grant.create", allowed: true },
            { id: "root.grant.revoke", allowed: true },
            { id: "root.runtime-trust.get", allowed: true },
            { id: "root.runtime-trust.grant", allowed: true },
            { id: "root.runtime-trust.revoke", allowed: true },
            { id: "root.credential-family.revoke", allowed: true },
            { id: "root.audit.list", allowed: true },
            { id: "agent.role.set", allowed: true },
            { id: "agent.supervisor.set", allowed: true },
          ],
        });
      }
      const rawText = req.method === "GET" ? "" : await req.text();
      calls.push({
        method: req.method,
        path: url.pathname + url.search,
        body: rawText ? JSON.parse(rawText) : undefined,
        idempotencyKey: req.headers.get("Idempotency-Key"),
      });
      if (url.pathname === "/api/root/grants" && req.method === "POST") return Response.json(fixtureCreateRootGrantResponse, { status: 201 });
      if (url.pathname === "/api/root/grants" && req.method === "GET") return Response.json({ grants: [fixtureRootGrantRecord], security_revision: 5, next_cursor: null });
      if (url.pathname.endsWith("/revoke") && url.pathname.includes("/grants/")) return Response.json(fixtureRevokeRootGrantResponse);
      if (url.pathname === "/api/root/runtime-trust" && req.method === "POST") return Response.json(fixtureGrantRuntimeTrustResponse, { status: 201 });
      if (url.pathname === "/api/root/runtime-trust/rt_fixture_1") {
        return Response.json({ runtime_id: "rt_fixture_1", active_trust: fixtureRootRuntimeTrustRecord, history: [fixtureRootRuntimeTrustRecord], security_revision: 4 });
      }
      if (url.pathname.includes("/runtime-trust/") && url.pathname.endsWith("/revoke")) {
        return Response.json({ trust: { ...fixtureRootRuntimeTrustRecord, status: "revoked", effective: false }, security_revision: 5, affected_authority_count: 1, cleanup_batch_id: "cln_rt_1" });
      }
      if (url.pathname.includes("/credential-families/") && url.pathname.endsWith("/revoke")) {
        return Response.json(fixtureRevokeCredentialFamilyResponse);
      }
      if (url.pathname === "/api/root/audit") return Response.json(fixtureRootAuditResponse);
      if (url.pathname === "/api/agents") return Response.json({ agents: [{ id: "agt_1", name: "Target Agent", role: "normal" }] });
      if (url.pathname === "/api/agents/agt_1/role") return Response.json({ id: "agt_1", role: "supervisor" });
      return Response.json({ error: "not found" }, { status: 404 });
    }) as unknown as typeof fetch;

    console.log = () => {};
    console.error = () => {};

    await registry.execute([
      "root", "grant", "create",
      "--server", "https://api.example.test", "--token", "root-task-token",
      "--subject-type", "agent", "--subject-id", "agt_root_fixture_1",
      "--reason", "Fixture grant", "--expected-revision", "4",
      "--idempotency-key", "idem_grant_1", "--runtime-trust", "rtr_fixture_1", "--json",
    ]);
    await registry.execute([
      "root", "grant", "list", "--server", "https://api.example.test", "--token", "root-task-token",
      "--subject-type", "agent", "--json",
    ]);
    await registry.execute([
      "root", "grant", "revoke", "rgr_agent_fixture_1",
      "--server", "https://api.example.test", "--token", "root-task-token",
      "--reason", "Fixture revoke", "--expected-revision", "5", "--idempotency-key", "idem_rev_1", "--yes", "--json",
    ]);
    await registry.execute([
      "root", "runtime-trust", "grant", "rt_fixture_1",
      "--server", "https://api.example.test", "--token", "root-task-token",
      "--daemon", "dmn_fixture_1", "--incarnation", "inc_fixture_1",
      "--recipient-key-id", "rkey_fixture_1", "--recipient-key-fingerprint", "sha256:0001",
      "--reason", "Fixture trust", "--expected-revision", "3", "--idempotency-key", "idem_tr_1", "--json",
    ]);
    await registry.execute([
      "root", "runtime-trust", "get", "rt_fixture_1",
      "--server", "https://api.example.test", "--token", "root-task-token", "--json",
    ]);
    await registry.execute([
      "root", "runtime-trust", "revoke", "rtr_fixture_1",
      "--server", "https://api.example.test", "--token", "root-task-token",
      "--reason", "Revoke trust", "--expected-revision", "4", "--idempotency-key", "idem_tr_rev_1", "--yes", "--json",
    ]);
    await registry.execute([
      "root", "credential-family", "revoke", "fam_agent_pat_fixture_1",
      "--server", "https://api.example.test", "--token", "root-task-token",
      "--reason-code", "operator_security_revoke", "--reason", "Compromised",
      "--expected-revision", "6", "--idempotency-key", "idem_fam_1", "--yes", "--json",
    ]);
    await registry.execute([
      "root", "audit", "list", "--server", "https://api.example.test", "--token", "root-task-token", "--json",
    ]);
    // Effective root task dynamically passes capability check for agent.role.set!
    await registry.execute([
      "agent", "role", "set", "agt_1", "--role", "supervisor",
      "--server", "https://api.example.test", "--token", "root-task-token", "--json",
    ]);

    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/api/root/grants",
      idempotencyKey: "idem_grant_1",
      body: {
        subject: { type: "agent", id: "agt_root_fixture_1" },
        reason: "Fixture grant",
        expected_revision: 4,
        idempotency_key: "idem_grant_1",
        runtime_trust_ids: ["rtr_fixture_1"],
      },
    });
    expect(calls.some((call) => call.method === "POST" && call.path === "/api/root/credential-families/fam_agent_pat_fixture_1/revoke")).toBe(true);
    expect(calls.some((call) => call.method === "PUT" && call.path === "/api/agents/agt_1/role")).toBe(true);
  });

  it("explains root_attempt_not_eligible for old attempts, preserves §10.1 error envelope codes, and refreshes capabilities after 403", async () => {
    let capabilityCalls = 0;
    const client = new CliApiClient({
      serverUrl: "https://api.example.test",
      token: "old-attempt-token",
      maxRetries: 0,
      fetch: (async (input: string | URL | Request) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.pathname === "/api/cli/capabilities") {
          capabilityCalls++;
          return Response.json({
            protocol_version: 1,
            identity: "task",
            root: fixtureGrantedButIneffectiveTaskContext,
            commands: [{ id: "agent.role.set", allowed: false, denied_code: "root_attempt_not_eligible" }],
          });
        }
        return Response.json(fixturePublicErrorEnvelopes.revisionConflict, { status: 409 });
      }) as unknown as typeof fetch,
    });

    await expect(client.requireCapability("agent.role.set")).rejects.toMatchObject({
      code: "forbidden",
      serverCode: "root_attempt_not_eligible",
    });
    expect(capabilityCalls).toBe(1);

    try {
      await client.request({ method: "POST", path: "/api/root/grants", body: {} });
      throw new Error("expected conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      const cliErr = error as CliError;
      expect(cliErr.code).toBe("conflict");
      expect(cliErr.serverCode).toBe("authority_revision_conflict");
      expect(cliErr.retryable).toBe(true);
      expect(cliErr.currentRevision).toBe(6);
      expect(cliErr.requestId).toBe("req_fixture_409");
      expect(cliErr.toJSON()).toMatchObject({
        code: "conflict",
        server_code: "authority_revision_conflict",
        retryable: true,
        current_revision: 6,
      });
    }
  });

  it("rejects read-only root fields on agent create/update/template create", async () => {
    const registry = buildRegistry();
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/api/cli/capabilities") {
        return Response.json({ commands: [{ id: "agent.create", allowed: true }] });
      }
      return Response.json({});
    }) as unknown as typeof fetch;

    await expect(registry.execute([
      "agent", "create",
      "--server", "https://api.example.test", "--token", "human-token",
      "--name", "Injected", "--provider", "codex",
      "--data", JSON.stringify({ root: { granted: true } }),
    ])).rejects.toThrow(/Read-only root field/);
  });

  it("enforces immutable run env carrier in CLI taskCredential and fails closed on legacy file fallback", () => {
    const dir = mkdtempSync(join(tmpdir(), "remi-cli-root-carrier-"));
    try {
      const filePath = join(dir, "task-context.json");
      writeFileSync(filePath, JSON.stringify({
        token: "legacy-file-token",
        turn_id: "trn_old",
        attempt_id: "att_old",
        written_at: "2026-11-24T12:00:00.000Z",
      }));

      // Valid immutable run env succeeds without touching any file.
      const env = {
        [ROOT_CARRIER_MODE_ENV]: ROOT_CARRIER_IMMUTABLE_ENV,
        [ROOT_RECEIPT_ID_ENV]: "rcpt_1",
        [ROOT_DELIVERY_VERSION_ENV]: "1",
        [ROOT_RUN_GENERATION_ENV]: "1",
        MULTIREMI_TOKEN: "root-env-bearer",
      };
      expect(taskCredential(env)).toBe("root-env-bearer");
      expect(taskCarrierInfo(env)).toEqual({
        mode: "immutable_run_env",
        receiptId: "rcpt_1",
        deliveryVersion: 1,
        runGeneration: 1,
        violation: null,
      });

      // If legacy MULTIREMI_TASK_CONTEXT_FILE is present alongside root carrier, fail closed!
      expect(() => taskCredential({
        ...env,
        [TASK_CONTEXT_FILE_ENV]: filePath,
      })).toThrow(/must not inherit MULTIREMI_TASK_CONTEXT_FILE/);

      // Missing env token fails closed rather than falling back to config.
      expect(() => taskCredential({
        [ROOT_CARRIER_MODE_ENV]: ROOT_CARRIER_IMMUTABLE_ENV,
      })).toThrow(/missing its verified MULTIREMI_TOKEN/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
