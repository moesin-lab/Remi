import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { runtimeKeys } from "./queries";
import { runtimeModelsKeys } from "./models";
export type { ExecutionProfile, ExecutionProfileInput, ExecutionGroupInput } from "../api/schemas/execution-profiles";
export type { ExecutionGroupList } from "../api/schemas/runtimes";
export type { ExecutionEndpoint, ExecutionEndpointInput } from "../api/schemas/execution-endpoints";
export type { EndpointInspectionResponse, EndpointCatalogs } from "../api/schemas/execution-endpoints";
export function executionEndpointListOptions(wsId: string) {
  return queryOptions({ queryKey: [...runtimeKeys.all(wsId), "endpoints"], queryFn: () => api.listExecutionEndpoints(wsId), enabled: !!wsId });
}

export function executionProfileListOptions(wsId: string) {
  return queryOptions({ queryKey: [...runtimeKeys.all(wsId), "profiles"], queryFn: () => api.listExecutionProfiles(wsId), enabled: !!wsId });
}

export function useExecutionConfigMutation(wsId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (command: () => Promise<unknown>) => command(),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: runtimeKeys.all(wsId) }),
        client.invalidateQueries({ queryKey: runtimeModelsKeys.fleet(wsId) }),
      ]);
    },
  });
}
