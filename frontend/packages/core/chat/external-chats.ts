import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { api, ApiError } from "../api";
import { ExternalChatErrorSchema } from "../api/schemas/external-chats";
import { EXTERNAL_CHAT_MAX_PAGE_SIZE } from "@multiremi/contracts/external-chats";

export type { ExternalChatProject, ExternalChatSource, ExternalChatSummary, ExternalChatHistory, ExternalChatRequest, ExternalChatQuestion, ExternalChatTurn, ExternalChatReceipt, ExternalChatModel, ExternalChatModels } from "@multiremi/contracts";
export { EXTERNAL_CHAT_MAX_TEXT_CHARS } from "@multiremi/contracts/external-chats";

export const externalChatKeys = {
  catalog: (ws: string, runtime: string) => ["external-chat", ws, runtime, "catalog"] as const,
  threads: (ws: string, runtime: string, source: string, project: string) => ["external-chat", ws, runtime, source, "threads", project] as const,
  models: (ws: string, runtime: string, source: string) => ["external-chat", ws, runtime, source, "models"] as const,
  history: (ws: string, runtime: string, source: string, thread: string) => ["external-chat", ws, runtime, source, "history", thread] as const,
  receipt: (ws: string, runtime: string, source: string, thread: string, request: string) => ["external-chat", ws, runtime, source, "receipt", thread, request] as const,
  lastReceipt: (ws: string, runtime: string, source: string, thread: string) => ["external-chat", ws, runtime, source, "last-receipt", thread] as const,
};

export function externalChatCatalogOptions(ws: string, runtime: string, online: boolean) {
  return queryOptions({ queryKey: externalChatKeys.catalog(ws, runtime), queryFn: () => api.listExternalChatCatalog(runtime), enabled: !!ws && !!runtime && online, retry: false, staleTime: 10_000 });
}

export function externalChatListOptions(ws: string, runtime: string, source: string, project: string, online: boolean) {
  return infiniteQueryOptions({
    queryKey: externalChatKeys.threads(ws, runtime, source, project),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.listExternalChats(runtime, source, { project_id: project || undefined, cursor: pageParam, limit: EXTERNAL_CHAT_MAX_PAGE_SIZE }),
    getNextPageParam: page => page.next_cursor ?? undefined,
    enabled: !!ws && !!runtime && !!source && online, retry: false,
  });
}

export function externalChatModelsOptions(ws: string, runtime: string, source: string, enabled: boolean) {
  return infiniteQueryOptions({
    queryKey: externalChatKeys.models(ws, runtime, source),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.listExternalChatModels(runtime, source, { cursor: pageParam, limit: EXTERNAL_CHAT_MAX_PAGE_SIZE }),
    getNextPageParam: page => page.next_cursor ?? undefined,
    enabled: !!ws && !!runtime && !!source && enabled, retry: false, staleTime: 10_000,
  });
}

export function externalChatHistoryOptions(ws: string, runtime: string, source: string, thread: string, online: boolean) {
  return infiniteQueryOptions({
    queryKey: externalChatKeys.history(ws, runtime, source, thread),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.getExternalChatHistory(runtime, source, thread, { cursor: pageParam, limit: EXTERNAL_CHAT_MAX_PAGE_SIZE }),
    getNextPageParam: page => page.next_cursor ?? undefined,
    enabled: !!ws && !!runtime && !!source && !!thread && online,
    refetchInterval: query => query.state.data?.pages[0]?.chat.status === "active" ? 2_000 : 5_000,
    refetchIntervalInBackground: false, retry: false,
  });
}

/** Transport loss or an invalid acknowledgement cannot prove that a native write was rejected. */
export function externalChatWriteIsUnknown(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  const body = ExternalChatErrorSchema.safeParse(error.body);
  return !body.success || body.data.outcome === "unknown";
}
