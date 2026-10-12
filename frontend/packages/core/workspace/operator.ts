"use client";

import { useQuery } from "@tanstack/react-query";
import type { MemberWithUser } from "../types";
import { memberListOptions } from "./queries";

/** Workspace actions share this identity; login accounts remain separate. */
export const WORKSPACE_OPERATOR_USER_ID = "local";

export function resolveWorkspaceOperator(members: readonly MemberWithUser[] | undefined) {
  return members?.find(member => member.user_id === WORKSPACE_OPERATOR_USER_ID) ?? null;
}

export const workspaceOperatorUser = Object.freeze({ id: WORKSPACE_OPERATOR_USER_ID });

export function useWorkspaceOperator(workspaceId: string) {
  const query = useQuery(memberListOptions(workspaceId));
  const operator = resolveWorkspaceOperator(query.data);
  return { ...query, operator, userId: operator?.user_id ?? null,
    memberId: operator?.id ?? null, canManage: operator?.role === "owner" || operator?.role === "admin" };
}
