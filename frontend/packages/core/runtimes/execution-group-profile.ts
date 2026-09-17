import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { RuntimeClaudeProfileInput } from "@multiremi/contracts/claude-profile";
import { api } from "../api";
import { runtimeModelsKeys } from "./models";
import { runtimeKeys } from "./queries";
export type { RuntimeClaudeProfile } from "@multiremi/contracts/claude-profile";

export function executionGroupProfileOptions(wsId: string, groupId: string) {
  return queryOptions({
    queryKey: [...runtimeKeys.all(wsId), "execution-group-profile", groupId],
    queryFn: () => api.getExecutionGroupProfile(wsId, groupId),
    enabled: Boolean(wsId && groupId),
    staleTime: 10_000,
  });
}

export function useSetExecutionGroupProfile(wsId: string, groupId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RuntimeClaudeProfileInput) => api.setExecutionGroupProfile(wsId, groupId, input),
    onSuccess: async result => {
      qc.setQueryData(executionGroupProfileOptions(wsId, groupId).queryKey, result);
      await qc.invalidateQueries({ queryKey: runtimeKeys.all(wsId) });
      await qc.invalidateQueries({ queryKey: runtimeModelsKeys.all() });
    },
  });
}
