import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enAgents from "../../locales/en/agents.json";
import enCommon from "../../locales/en/common.json";
import { AgentRootBadge } from "./agent-root-badge";

const TEST_RESOURCES = { en: { common: enCommon, agents: enAgents } };

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      {children}
    </I18nProvider>
  );
}

describe("AgentRootBadge", () => {
  it("renders nothing when root is absent or not granted", () => {
    const { container } = render(<AgentRootBadge root={undefined} />, { wrapper: Wrapper });
    expect(container.firstChild).toBeNull();
  });

  it("distinguishes effective system root from granted-but-ineffective attempt state", () => {
    const { rerender } = render(
      <AgentRootBadge
        root={{
          granted: true,
          grant_id: "rgr_1",
          generation: 2,
          effective: true,
          reason_code: "active",
          scope: "system",
          expires_at: null,
          revoked_at: null,
        }}
      />,
      { wrapper: Wrapper },
    );
    const effectiveBadge = screen.getByTestId("agent-root-badge");
    expect(effectiveBadge.getAttribute("data-root-effective")).toBe("true");
    expect(effectiveBadge.textContent).toContain("System Root");

    rerender(
      <AgentRootBadge
        root={{
          granted: true,
          grant_id: "rgr_1",
          generation: 2,
          effective: false,
          reason_code: "attempt_not_eligible",
          scope: "system",
          expires_at: null,
          revoked_at: null,
        }}
      />,
    );
    const pendingBadge = screen.getByTestId("agent-root-badge");
    expect(pendingBadge.getAttribute("data-root-effective")).toBe("false");
    expect(pendingBadge.getAttribute("data-root-reason")).toBe("attempt_not_eligible");
    expect(pendingBadge.textContent).toContain("Pending New Attempt");
  });
});
