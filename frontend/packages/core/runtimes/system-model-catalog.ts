import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { ExecutionEndpoint } from "../api/schemas/execution-endpoints";
import { runtimeKeys } from "./queries";

export type SystemProtocol = "openai-chat-completions" | "anthropic-messages";
const maxAge = 5 * 60 * 1000;

export function useSystemModelCatalog(workspaceId: string, endpoint: ExecutionEndpoint | undefined, protocol: SystemProtocol) {
  const client = useQueryClient();
  const enabled = !!endpoint && endpoint.connection.options?.fetch_models !== false;
  const key = [...runtimeKeys.all(workspaceId), "system-model-catalog", endpoint?.id, endpoint?.revision, protocol];
  const read = async () => {
    const response = await api.getExecutionEndpointCatalog(workspaceId, endpoint!.id);
    return response.catalogs.find(row => row.protocol === protocol && row.revision <= endpoint!.revision) ?? null;
  };
  const options = { staleTime: maxAge, retry: false, retryOnMount: false, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;
  const snapshot = useQuery({ ...options, queryKey: key, queryFn: read, enabled });
  const row = snapshot.data;
  const expired = !row || row.revision !== endpoint?.revision || !(Date.parse(row.last_checked_at) >= Date.now() - maxAge);
  const refresh = useQuery({ ...options, queryKey: [...key, "refresh"], enabled: enabled && snapshot.isSuccess && expired,
    queryFn: async () => {
      const { inspection, persisted } = await api.inspectExecutionEndpoint(workspaceId, { endpoint_id: endpoint!.id, protocol, operation: "models" });
      const result = inspection.results.find(item => item.protocol === protocol && item.operation === "models");
      const current = await read();
      if (current) client.setQueryData(key, current);
      if (result?.state === "error") return { failed: true, code: result.error_code };
      return { failed: !persisted || !result || current?.revision !== endpoint!.revision || current.last_checked_at < inspection.checked_at };
    },
  });
  const failed = snapshot.isError || refresh.isError || refresh.data?.failed || row?.state === "error";
  return {
    models: (enabled ? row?.models : undefined) ?? endpoint?.connection.options?.manual_models ?? [],
    loading: enabled && (snapshot.isFetching || refresh.isFetching),
    failed: enabled && failed,
    code: refresh.data?.code ?? row?.error_code,
    stale: enabled && row?.last_success_at && (expired || failed || row.models_revision !== endpoint?.revision) ? row.last_success_at : null,
    refresh: () => refresh.refetch({ cancelRefetch: false }),
  };
}
