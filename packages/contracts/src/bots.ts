import type { FeishuBotDomain, FeishuBotSecretOp, FeishuBotSessionSnapshot, MultiremiFeishuBotDaemonPayload, MultiremiFeishuBotOutboundDelivery, ReportFeishuBotRuntimeStatusInput, SubmitFeishuBotMessageInput, SubmitFeishuBotMessageResult } from "./types.js";

/** Bot is the only managed resource. Platforms, routes and access are its configuration. */
export interface BotTarget {
  kind: "agent";
  agent_id: string;
  runtime_id?: string | null;
  project_id?: string | null;
  runtime_workspace_id?: string | null;
}
export interface BotRoute {
  id: string;
  name: string;
  match: {
    platform_binding_ids?: string[];
    chat_types?: ("p2p" | "group")[];
    chat_ids?: string[];
    commands?: string[];
  };
  target: BotTarget;
}
export interface BotPlatformBinding {
  id: string;
  platform: "feishu";
  app_id: string;
  domain: FeishuBotDomain;
  host_runtime_id: string;
  enabled: boolean;
  app_secret_configured: boolean;
  app_secret_hint: string | null;
  status: "stopped" | "starting" | "online" | "failed" | "offline";
  last_error: string | null;
  last_seen_at: string | null;
}
export interface BotPlatformBindingInput {
  id?: string;
  platform: "feishu";
  app_id: string;
  domain?: FeishuBotDomain;
  host_runtime_id: string;
  enabled?: boolean;
  app_secret_op?: FeishuBotSecretOp;
  app_secret?: string;
}
export interface BotIssueNotifications {
  platform_binding_id: string;
  chat_id: string;
  project_ids?: string[];
  target?: BotTarget;
}
export interface Bot {
  id: string;
  workspace_id: string;
  name: string;
  enabled: boolean;
  revision: number;
  platform_bindings: BotPlatformBinding[];
  default_target: BotTarget;
  routes: BotRoute[];
  allowlist_enabled: boolean;
  issue_notifications: BotIssueNotifications | null;
  created_at: string;
  updated_at: string;
}
/** PUT replaces configuration; omitted platform secrets are retained by stable binding id. */
export interface SaveBotInput {
  workspace_id: string;
  name: string;
  enabled?: boolean;
  platform_bindings: BotPlatformBindingInput[];
  default_target: BotTarget;
  routes?: BotRoute[];
  allowlist_enabled?: boolean;
  issue_notifications?: BotIssueNotifications | null;
}
export interface BotSender {
  id: string;
  bot_id: string;
  platform_binding_id: string;
  external_id: string;
  display_name: string | null;
  allowed: boolean;
  first_seen_at: string;
  last_seen_at: string;
}
export interface BotSession {
  id: string;
  bot_id: string;
  platform_binding_id: string;
  external_session_key: string;
  target: BotTarget;
  chat_session_id: string;
  chat_id: string | null;
  thread_id: string | null;
  reply_to_message_id: string | null;
  created_at: string;
  updated_at: string;
}
export interface BotDirective {
  bot_id: string;
  platform_binding_id: string;
  revision: number;
  desired_state: "running" | "stopped";
  config_available: boolean;
}
export interface BotDaemonAssignment extends MultiremiFeishuBotDaemonPayload {
  bot_id: string;
  bot_name?: string;
  platform_binding_id: string;
  platform: "feishu";
}
export interface SubmitBotMessageInput extends SubmitFeishuBotMessageInput {
  chatType?: "p2p" | "group";
  command?: string | null;
  parentMessageId?: string | null;
  target?: BotTarget;
  attachmentIds?: string[];
}
export type SubmitBotMessageResult = Omit<SubmitFeishuBotMessageResult, "senderMembership"> & {
  botSessionId: string;
  senderAllowed: boolean;
};
export interface BotSessionControlInput {
  revision: number;
  externalSessionKey: string;
  chatSessionId?: string;
  replyToMessageId?: string;
}
export type BotSessionSnapshot = FeishuBotSessionSnapshot;
export type BotOutboundDelivery = MultiremiFeishuBotOutboundDelivery & { botId: string; platformBindingId: string; updateMessageId?: string | null };
export type ReportBotStatusInput = ReportFeishuBotRuntimeStatusInput;
