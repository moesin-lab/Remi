import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export const botKeys = {
  all: (workspaceId: string) => ["bots", workspaceId] as const,
  list: (workspaceId: string) => [...botKeys.all(workspaceId), "list"] as const,
  bot: (workspaceId: string, botId: string) => [...botKeys.all(workspaceId), botId] as const,
  detail: (workspaceId: string, botId: string) => [...botKeys.bot(workspaceId, botId), "detail"] as const,
  senders: (workspaceId: string, botId: string) => [...botKeys.bot(workspaceId, botId), "senders"] as const,
  sessions: (workspaceId: string, botId: string) => [...botKeys.bot(workspaceId, botId), "sessions"] as const,
};

// Incoming accounts and connection state can change without this page writing.
// Refresh visible pages until the Bot domain publishes realtime events.
export const BOT_REFRESH_INTERVAL_MS = 10_000;

export function botListOptions(workspaceId: string, enabled = true) {
  return queryOptions({
    queryKey: botKeys.list(workspaceId),
    queryFn: () => api.listBots(workspaceId),
    select: (data) => data.bots,
    enabled: enabled && workspaceId.length > 0,
    retry: false,
    staleTime: 5_000,
    refetchInterval: BOT_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });
}

export function botDetailOptions(workspaceId: string, botId: string, enabled = true) {
  return queryOptions({
    queryKey: botKeys.detail(workspaceId, botId),
    queryFn: () => api.getBot(workspaceId, botId),
    enabled: enabled && workspaceId.length > 0 && botId.length > 0,
    retry: false,
    staleTime: 5_000,
    refetchInterval: BOT_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });
}

export function botSendersOptions(workspaceId: string, botId: string, enabled = true) {
  return queryOptions({
    queryKey: botKeys.senders(workspaceId, botId),
    queryFn: () => api.listBotSenders(workspaceId, botId),
    select: (data) => data.senders,
    enabled: enabled && workspaceId.length > 0 && botId.length > 0,
    retry: false,
    staleTime: 5_000,
    refetchInterval: BOT_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });
}

export function botSessionsOptions(workspaceId: string, botId: string, enabled = true) {
  return queryOptions({
    queryKey: botKeys.sessions(workspaceId, botId),
    queryFn: () => api.listBotSessions(workspaceId, botId),
    select: (data) => data.sessions,
    enabled: enabled && workspaceId.length > 0 && botId.length > 0,
    retry: false,
    staleTime: 5_000,
    refetchInterval: BOT_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });
}
