import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../client";
import { extractRootApiError, isAuthorityRevisionConflict } from "../../root";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("RootEndpoints and root-safe client boundaries", () => {
  it("parses root context with fallback and parses strict grant/revoke responses", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/api/root/context")) {
        return jsonResponse({
          security_revision: 5,
          feature_activation: true,
          bootstrap_completed: true,
          transport_identity: "human",
          authenticated_subject: { type: "user", id: "usr_root_1" },
          beneficiary_user_id: null,
          is_agent_origin: false,
          agent_granted_root: false,
          current_attempt_effective_root: false,
          effective_root: true,
          effective_reason_code: "active",
          capabilities: {
            can_manage_root: true,
            can_edit_root_execution: true,
            can_manage_runtime_trust: true,
            can_revoke_credential_family: true,
            can_read_root_audit: true,
          },
          allowed_operations: ["root.grant.create"],
        });
      }
      if (url.endsWith("/api/root/grants") && init?.method === "POST") {
        expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("idem_1");
        return jsonResponse({
          grant: {
            id: "rgr_1",
            subject: { type: "agent", id: "agt_1" },
            generation: 1,
            scope: "system",
            status: "active",
            effective: true,
            effective_reason_code: "active",
            authority_node_id: "anode_1",
            issuer: { type: "user", id: "usr_root_1" },
            reason: "fixture",
            created_at: "2026-11-24T12:00:00Z",
            revision: 6,
          },
          security_revision: 6,
        }, 201);
      }
      if (url.endsWith("/api/root/credential-families/fam_1/revoke")) {
        return jsonResponse({
          family_id: "fam_1",
          status: "revoked",
          security_revision: 7,
          affected_authority_count: 2,
          cleanup_batch_id: "cln_1",
        });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const client = new ApiClient("http://api.test");
      const ctx = await client.getRootContext();
      expect(ctx.effective_root).toBe(true);
      expect(ctx.capabilities.can_manage_root).toBe(true);

      const created = await client.createRootGrant({
        subject: { type: "agent", id: "agt_1" },
        reason: "fixture",
        expected_revision: 5,
        idempotency_key: "idem_1",
      });
      expect(created.security_revision).toBe(6);
      expect(created.grant.id).toBe("rgr_1");

      const fam = await client.revokeCredentialFamily("fam_1", {
        expected_revision: 6,
        reason_code: "operator_security_revoke",
        reason: "compromised",
        idempotency_key: "idem_fam",
      });
      expect(fam.affected_authority_count).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("extracts §10.1 structured error envelopes and detects 409 revision conflicts", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            code: "authority_revision_conflict",
            message: "Security revision changed",
            retryable: true,
            requestId: "req_409",
            currentRevision: 9,
          },
        },
        409,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const client = new ApiClient("http://api.test");
      await expect(
        client.createRootGrant({
          subject: { type: "agent", id: "agt_1" },
          reason: "stale",
          expected_revision: 4,
          idempotency_key: "idem_stale",
        }),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).message).toBe("Security revision changed");
        expect(isAuthorityRevisionConflict(err)).toBe(true);
        expect(extractRootApiError(err)).toEqual({
          code: "authority_revision_conflict",
          message: "Security revision changed",
          retryable: true,
          requestId: "req_409",
          currentRevision: 9,
        });
        return true;
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("strips read-only root fields before sending agent create/update payloads", async () => {
    let sentBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return jsonResponse({ id: "agt_1", name: "Clean" });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const client = new ApiClient("http://api.test");
      await client.createAgent({
        name: "Clean",
        provider: "codex",
        ...({ root: { granted: true }, provenance: { fake: true } } as Record<string, unknown>),
      } as Parameters<typeof client.createAgent>[0]);
      expect(sentBody).toEqual({ name: "Clean", provider: "codex" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves agent-origin provenance on PersonalAccessToken responses", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse([
        {
          id: "tok_1",
          name: "Agent PAT",
          token_prefix: "mul_abc",
          expires_at: "2026-12-24T00:00:00Z",
          last_used_at: null,
          created_at: "2026-11-24T00:00:00Z",
          family_id: "fam_agent_1",
          authenticated_subject: { type: "agent", id: "agt_root_1" },
          beneficiary_user_id: "usr_target_1",
          is_agent_origin: true,
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const client = new ApiClient("http://api.test");
      const list = await client.listPersonalAccessTokens();
      expect(list).toHaveLength(1);
      expect(list[0]?.is_agent_origin).toBe(true);
      expect(list[0]?.authenticated_subject).toEqual({ type: "agent", id: "agt_root_1" });
      expect(list[0]?.family_id).toBe("fam_agent_1");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
