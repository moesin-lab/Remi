import { useWorkspaceOperator } from "@multiremi/core/workspace/operator";

export function useImWorkspaceAccess(workspaceId: string) {
  return useWorkspaceOperator(workspaceId);
}
