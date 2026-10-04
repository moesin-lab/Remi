import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@multiremi/core/auth";
import { memberListOptions } from "@multiremi/core/workspace/queries";

export function useImWorkspaceAccess(workspaceId: string) {
  const user = useAuthStore(state => state.user);
  const query = useQuery(memberListOptions(workspaceId));
  const role = query.data?.find(member => member.user_id === user?.id)?.role;
  return { ...query, canManage: role === "owner" || role === "admin" };
}
