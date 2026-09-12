import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { RuntimeCodexProfileInput } from "@multiremi/contracts/codex-profile";
import { runtimeModelsKeys } from "./models";
import { api } from "../api";
import { runtimeKeys } from "./queries";
export type { RuntimeCodexProfile, RuntimeCodexProfileConfig } from "@multiremi/contracts/codex-profile";

export function runtimeCodexProfileOptions(wsId: string, runtimeId: string) {
  return queryOptions({
    queryKey: [...runtimeKeys.all(wsId), runtimeId, "codex-profile"],
    queryFn: () => api.getRuntimeCodexProfile(runtimeId), enabled: Boolean(wsId && runtimeId), staleTime: 10_000,
  });
}

export function useSetRuntimeCodexProfile(wsId: string, runtimeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RuntimeCodexProfileInput) => api.setRuntimeCodexProfile(runtimeId, input),
    onSuccess: async result => {
      qc.setQueryData(runtimeCodexProfileOptions(wsId, runtimeId).queryKey, result);
      await qc.invalidateQueries({ queryKey: runtimeKeys.all(wsId) });
      await qc.invalidateQueries({ queryKey: runtimeModelsKeys.fleet(wsId) });
      await qc.invalidateQueries({ queryKey: runtimeModelsKeys.forRuntime(runtimeId) });
    },
  });
}
