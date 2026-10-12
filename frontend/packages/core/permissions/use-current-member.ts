"use client";

import { useWorkspaceOperator } from "../workspace/operator";
import type { MemberRole, MemberWithUser } from "../types";

/**
 * Resolves the shared workspace operator. The authenticated account is only
 * the platform access credential; it does not select an in-workspace actor.
 *
 * `wsId` is explicit (not via `useWorkspaceId()` Context) so this hook stays
 * usable in components that may render before workspace context is wired,
 * matching the repo rule for workspace-aware hooks.
 */
export function useCurrentMember(wsId: string): {
  userId: string | null;
  role: MemberRole | null;
  member: MemberWithUser | null;
  isLoading: boolean;
} {
  const { userId, operator: member, isLoading } = useWorkspaceOperator(wsId);
  return {
    userId,
    role: member?.role ?? null,
    member,
    isLoading,
  };
}
