import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { api } from "../api";
import type { ExecutionEndpoint } from "../api/schemas/execution-endpoints";
import { runtimeKeys } from "./queries";

export type SystemProtocol = "openai-chat-completions" | "anthropic-messages";
const maxAge = 5 * 60 * 1000;

function delayUntilRefresh(lastCheckedAt: number) {
  return Math.min(maxAge, Math.max(0, lastCheckedAt + maxAge - Date.now()));
}

export function useSystemModelCatalog(workspaceId: string, endpoint: ExecutionEndpoint | undefined, protocol: SystemProtocol) {
  const client = useQueryClient();
  const enabled = !!endpoint && endpoint.connection.options?.fetch_models !== false;
  const key = useMemo(() => [...runtimeKeys.all(workspaceId), "system-model-catalog", endpoint?.id, endpoint?.revision, protocol],
    [workspaceId, endpoint?.id, endpoint?.revision, protocol]);
  const read = async () => {
    const response = await api.getExecutionEndpointCatalog(workspaceId, endpoint!.id);
    return response.catalogs.find(row => row.protocol === protocol && row.revision <= endpoint!.revision) ?? null;
  };
  const options = { staleTime: maxAge, retry: false, retryOnMount: false, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;
  const snapshot = useQuery({ ...options, queryKey: key, queryFn: read, enabled });
  const row = snapshot.data;
  const { isError: readFailed, errorUpdatedAt: readFailedAt, isFetching: reading, refetch: reread } = snapshot;
  useEffect(() => {
    if (!enabled || !readFailed || reading) return;
    const timer = setTimeout(() => {
      const latest = client.getQueryState(key);
      if (latest?.status === "error" && latest.fetchStatus === "idle" && latest.errorUpdatedAt === readFailedAt) {
        void reread({ cancelRefetch: false });
      }
    }, delayUntilRefresh(readFailedAt));
    return () => clearTimeout(timer);
  }, [enabled, readFailed, reading, readFailedAt, client, key, reread]);
  const checkedAt = row && row.revision === endpoint?.revision
    ? Math.min(Date.parse(row.last_checked_at) || 0, snapshot.dataUpdatedAt) : 0;
  const expired = checkedAt + maxAge <= Date.now();
  const refresh = useQuery({ ...options, queryKey: [...key, "refresh"], enabled: false,
    queryFn: async () => {
      const startedAt = Date.now();
      const { inspection, persisted } = await api.inspectExecutionEndpoint(workspaceId, { endpoint_id: endpoint!.id, protocol, operation: "models" });
      const result = inspection.results.find(item => item.protocol === protocol && item.operation === "models");
      const current = await read();
      if (current) client.setQueryData(key, current);
      const confirmed = persisted && current?.revision === endpoint!.revision && current.last_checked_at >= inspection.checked_at;
      return { failed: !confirmed || !result || result.state === "error", code: result?.error_code,
        checkedAt: confirmed ? Math.min(Date.now(), Math.max(startedAt, Date.parse(current.last_checked_at))) : 0 };
    },
  });
  const { refetch, dataUpdatedAt, errorUpdatedAt, isFetching } = refresh;
  const confirmedAt = refresh.data?.checkedAt ?? 0;
  const lastAttempt = confirmedAt > dataUpdatedAt - maxAge ? confirmedAt : dataUpdatedAt;
  useEffect(() => {
    if (!enabled || !snapshot.isSuccess || isFetching) return;
    const run = () => {
      const latest = client.getQueryState([...key, "refresh"]);
      if (latest?.fetchStatus !== "idle" || latest.dataUpdatedAt !== dataUpdatedAt || latest.errorUpdatedAt !== errorUpdatedAt) return;
      void refetch({ cancelRefetch: false });
    };
    const timer = setTimeout(run, delayUntilRefresh(Math.max(checkedAt, lastAttempt, errorUpdatedAt)));
    return () => clearTimeout(timer);
  }, [enabled, snapshot.isSuccess, isFetching, checkedAt, lastAttempt, dataUpdatedAt, errorUpdatedAt, client, key, refetch]);
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
