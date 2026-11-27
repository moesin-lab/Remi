import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { ApiError } from "@multiremi/core/api";
import enCommon from "../../locales/en/common.json";
import enSettings from "../../locales/en/settings.json";

const mockApi = vi.hoisted(() => ({
  getRootContext: vi.fn(),
  listRootGrants: vi.fn(),
  createRootGrant: vi.fn(),
  revokeRootGrant: vi.fn(),
  listRootRuntimeTrusts: vi.fn(),
  grantRootRuntimeTrust: vi.fn(),
  revokeRootRuntimeTrust: vi.fn(),
  revokeCredentialFamily: vi.fn(),
  listRootAudit: vi.fn(),
}));

vi.mock("@multiremi/core/api", async () => {
  const actual = await vi.importActual<typeof import("@multiremi/core/api")>("@multiremi/core/api");
  return { ...actual, api: mockApi };
});

import { RootTab } from "./root-tab";

const TEST_RESOURCES = { en: { common: enCommon, settings: enSettings } };

function renderRootTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <I18nProvider locale="en" resources={TEST_RESOURCES}>
          {children}
        </I18nProvider>
      </QueryClientProvider>
    );
  }
  return render(<RootTab />, { wrapper: Wrapper });
}

describe("RootTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getRootContext.mockResolvedValue({
      security_revision: 5,
      feature_activation: true,
      bootstrap_completed: true,
      transport_identity: "human",
      authenticated_subject: { type: "agent", id: "agt_root_1" },
      beneficiary_user_id: null,
      is_agent_origin: true,
      credential_id: "tok_1",
      family_id: "fam_1",
      origin_attempt_id: "att_1",
      current_attempt_id: null,
      agent_granted_root: true,
      current_attempt_effective_root: false,
      effective_root: false,
      effective_reason_code: "attempt_not_eligible",
      grant_id: "rgr_1",
      grant_generation: 1,
      capabilities: {
        can_manage_root: true,
        can_edit_root_execution: true,
        can_manage_runtime_trust: true,
        can_revoke_credential_family: true,
        can_read_root_audit: true,
      },
      allowed_operations: ["root.grant.create"],
    });
    mockApi.listRootGrants.mockResolvedValue({
      grants: [
        {
          id: "rgr_1",
          subject: { type: "agent", id: "agt_root_1" },
          generation: 1,
          scope: "system",
          status: "active",
          effective: true,
          effective_reason_code: "active",
          authority_node_id: "anode_1",
          issuer: { type: "user", id: "usr_root_1" },
          origin_attempt_id: null,
          origin_family_id: "fam_human",
          reason: "Fixture grant",
          revocation_reason: null,
          expires_at: null,
          created_at: "2026-11-24T12:00:00Z",
          revoked_at: null,
          revision: 5,
        },
      ],
      security_revision: 5,
      next_cursor: null,
    });
    mockApi.listRootRuntimeTrusts.mockResolvedValue({
      trusts: [],
      security_revision: 5,
      next_cursor: null,
    });
    mockApi.listRootAudit.mockResolvedValue({
      entries: [],
      security_revision: 5,
      next_cursor: null,
    });
  });

  it("shows granted vs effective difference, labels agent-origin identity, and surfaces 409 conflict refresh", async () => {
    mockApi.createRootGrant.mockRejectedValueOnce(
      new ApiError("Security revision changed", 409, "Conflict", {
        error: {
          code: "authority_revision_conflict",
          message: "Security revision changed",
          retryable: true,
          requestId: "req_409",
          currentRevision: 8,
        },
      }),
    );

    renderRootTab();

    await waitFor(() => {
      expect(screen.getByTestId("root-authenticated-subject").textContent).toBe("agent:agt_root_1");
    });
    expect(screen.getByTestId("root-agent-origin-badge").textContent).toContain("Agent-origin");
    expect(screen.getByTestId("root-granted-vs-effective").textContent).toContain("attempt_not_eligible");

    fireEvent.change(screen.getByPlaceholderText("agt_..."), { target: { value: "agt_target_2" } });
    fireEvent.change(
      screen.getByPlaceholderText("Why this subject requires explicit system root authority"),
      { target: { value: "Isolated test grant" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Grant system root" }));

    await waitFor(() => {
      expect(screen.getByTestId("root-revision-conflict-banner").textContent).toContain("8");
    });
  });

  it("shows exposed external secrets rotation notice and last-root warning after revoke", async () => {
    mockApi.revokeRootGrant.mockResolvedValueOnce({
      grant: {
        id: "rgr_1",
        subject: { type: "agent", id: "agt_root_1" },
        generation: 1,
        scope: "system",
        status: "revoked",
        effective: false,
        effective_reason_code: "grant_revoked",
        authority_node_id: "anode_1",
        issuer: { type: "user", id: "usr_root_1" },
        origin_attempt_id: null,
        origin_family_id: "fam_human",
        reason: "Fixture grant",
        revocation_reason: "Rotate test",
        expires_at: null,
        created_at: "2026-11-24T12:00:00Z",
        revoked_at: "2026-11-24T12:10:00Z",
        revision: 6,
      },
      security_revision: 6,
      affected_authority_count: 2,
      cleanup_batch_id: "cln_1",
      last_root_revoked: true,
      exposed_external_secrets_requiring_rotation: [
        {
          target_type: "execution_endpoint",
          target_id: "ep_1",
          secret_version: "sv_1",
          accessed_at: "2026-11-24T12:05:00Z",
          rotation_required: true,
          note: "Rotate externally",
        },
      ],
    });

    renderRootTab();

    await waitFor(() => {
      expect(screen.getByText("Fixture grant · issuer user:usr_root_1")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    fireEvent.change(
      screen.getByPlaceholderText("Non-secret audit reason for revocation"),
      { target: { value: "Rotate test" } },
    );
    const revokeButtons = screen.getAllByRole("button", { name: "Revoke" });
    fireEvent.click(revokeButtons[revokeButtons.length - 1]!);

    await waitFor(() => {
      expect(screen.getByTestId("root-last-revoked-warning")).toBeTruthy();
      expect(screen.getByTestId("root-exposed-secrets-notice").textContent).toContain("execution_endpoint:ep_1");
    });
  });
});
