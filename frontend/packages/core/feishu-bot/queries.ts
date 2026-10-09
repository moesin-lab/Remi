import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

/**
 * Query keys for the workspace Feishu concierge (MUL-206).
 *
 * Everything is keyed on `workspaceId` so switching workspaces swaps the whole
 * subtree rather than showing one workspace's bot under another's settings.
 */
export const feishuBotKeys = {
  all: (workspaceId: string) => ["feishu-bot", workspaceId] as const,
  config: (workspaceId: string, botId = "default") => scopedBotKey(["feishu-bot", workspaceId, "config"], botId),
  status: (workspaceId: string, botId = "default") => scopedBotKey(["feishu-bot", workspaceId, "status"], botId),
  candidates: (workspaceId: string) => ["feishu-bot", workspaceId, "candidates"] as const,
  routes: (workspaceId: string, botId = "default") => scopedBotKey(["feishu-bot", workspaceId, "routes"], botId),
  chats: (workspaceId: string, botId = "default") => scopedBotKey(["feishu-bot", workspaceId, "chats"], botId),
  senders: (workspaceId: string, botId = "default") => scopedBotKey(["feishu-bot", workspaceId, "senders"], botId),
  audit: (workspaceId: string, limit: number, botId = "default") => scopedBotKey(["feishu-bot", workspaceId, "audit", limit], botId),
  registration: (workspaceId: string, sessionId: string) =>
    ["feishu-bot", workspaceId, "registration", sessionId] as const,
  issueTopics: (workspaceId: string) => ["feishu-bot", workspaceId, "issue-topics"] as const,
};

export function feishuBotOptions(workspaceId: string, enabled = true, botId = "default") {
  return queryOptions({
    queryKey: feishuBotKeys.config(workspaceId, botId),
    queryFn: () => api.getFeishuBot(workspaceId, botId),
    enabled: enabled && workspaceId.length > 0,
    // A 403 here is a role answer, not a transient failure — retrying it just
    // burns requests on a permission the user will not gain mid-session.
    retry: false,
  });
}

export function issueTopicConfigOptions(workspaceId: string, enabled = true) {
  return queryOptions({
    queryKey: feishuBotKeys.issueTopics(workspaceId),
    queryFn: () => api.getIssueTopicConfig(workspaceId),
    enabled: enabled && workspaceId.length > 0,
    retry: false,
  });
}

/**
 * The daemon picks up a directive on its next heartbeat, so `deploying` becomes `online` seconds
 * later with no user action. Polling is what makes the badge tell the truth;
 * configuration changes remain event-driven.
 */
export function feishuBotStatusOptions(workspaceId: string, enabled = true, botId = "default") {
  return queryOptions({
    queryKey: feishuBotKeys.status(workspaceId, botId),
    queryFn: () => api.getFeishuBotStatus(workspaceId, botId),
    enabled: enabled && workspaceId.length > 0,
    retry: false,
    refetchInterval: enabled ? 10_000 : false,
    staleTime: 5_000,
  });
}

export function feishuBotCandidatesOptions(workspaceId: string, enabled = true) {
  return queryOptions({
    queryKey: feishuBotKeys.candidates(workspaceId),
    queryFn: () => api.getFeishuBotCandidates(workspaceId),
    enabled: enabled && workspaceId.length > 0,
    retry: false,
    staleTime: 15_000,
  });
}

export function feishuBotRoutesOptions(workspaceId: string, enabled = true, botId = "default") {
  return queryOptions({
    queryKey: feishuBotKeys.routes(workspaceId, botId),
    queryFn: () => api.getFeishuBotRoutes(workspaceId, botId),
    enabled: enabled && workspaceId.length > 0,
    retry: false,
  });
}

export function feishuBotChatsOptions(workspaceId: string, enabled = true, botId = "default") {
  return queryOptions({
    queryKey: feishuBotKeys.chats(workspaceId, botId),
    queryFn: () => api.getFeishuBotChats(workspaceId, botId),
    enabled: enabled && workspaceId.length > 0,
    retry: false,
  });
}

export function feishuBotAuditOptions(workspaceId: string, limit = 20, enabled = true, botId = "default") {
  return queryOptions({
    queryKey: feishuBotKeys.audit(workspaceId, limit, botId),
    queryFn: () => api.listFeishuBotAudit(workspaceId, limit, botId),
    enabled: enabled && workspaceId.length > 0,
    retry: false,
  });
}

export function feishuBotSendersOptions(workspaceId: string, enabled = true, botId = "default") {
  const queryEnabled = enabled && workspaceId.length > 0;
  return queryOptions({
    queryKey: feishuBotKeys.senders(workspaceId, botId),
    queryFn: () => api.listFeishuBotSenders(workspaceId, botId),
    enabled: queryEnabled,
    retry: false,
    refetchInterval: queryEnabled ? 10_000 : false,
    staleTime: 5_000,
  });
}

function scopedBotKey(parts: readonly (string | number)[], botId: string) {
  return botId === "default" ? parts : [...parts, "bot", botId];
}

export function feishuBotsOptions(workspaceId: string, enabled = true) {
  return queryOptions({ queryKey: [...feishuBotKeys.all(workspaceId), "list"],
    queryFn: () => api.listFeishuBots(workspaceId), enabled: enabled && !!workspaceId,
    retry: false, refetchInterval: enabled ? 10_000 : false });
}
