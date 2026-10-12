import { describe, expect, it } from "vitest";
import type { MemberWithUser } from "../types";
import { resolveWorkspaceOperator, WORKSPACE_OPERATOR_USER_ID } from "./operator";

const member = (userId: string, id: string): MemberWithUser => ({
  id, user_id: userId, workspace_id: "workspace", role: "owner",
  name: "Operator", avatar_url: null, created_at: "2026-10-13T00:00:00Z",
});

describe("shared workspace operator", () => {
  it("uses the canonical actor independently of historical login accounts", () => {
    const shared = member(WORKSPACE_OPERATOR_USER_ID, "shared-member");
    expect(resolveWorkspaceOperator([member("account-a", "historical-a"), shared])).toBe(shared);
  });
  it("does not infer an operator from historical owners or missing data", () => {
    expect(resolveWorkspaceOperator([member("account-a", "historical-a")])).toBeNull();
    expect(resolveWorkspaceOperator(undefined)).toBeNull();
  });
});
