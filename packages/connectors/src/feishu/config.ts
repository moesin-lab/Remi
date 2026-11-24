import type { FeishuBotCommandRequest, FeishuBotCommandResult, FeishuBotSessionSnapshot, FeishuCommandSemantic } from "@multiremi/contracts/types.js";

export type FeishuDomainName = "feishu" | "lark" | "bytedance";

export interface FeishuChannelConfig {
  wakeWords?: readonly string[];
  recoveryChats?: Array<{ chat_id: string; chat_type: "p2p" | "group" }>;
  appId: string;
  appSecret: string;
  domain?: FeishuDomainName;
  connectionMode?: "ws" | "webhook";
  encryptKey?: string;
  verificationToken?: string;
}

export type {
  BotMenuBehavior,
  BotMenuConfig,
  BotMenuIcon,
  BotMenuItemConfig,
  BotMenuUserConfig,
  ResolvedBotMenuConfig,
  ResolvedBotMenuUserConfig,
} from "@multiremi/contracts/types.js";

/** Group policy interface — injected by remi, not read from config directly. */
export interface GroupPolicy {
  getByChatId(chatId: string): {
    replyMode?: string;
    listenMode?: string;
    monitor?: boolean;
    allowedUserIds?: string[];
    botOpenId?: string;
    projectId?: string | null;
  } | null;
}

export type FeishuCommandOutcome = FeishuBotCommandResult | { name: "status"; snapshot: FeishuBotSessionSnapshot } | { name: "unknown" };

export interface FeishuCommandRuntime {
  revision: number;
  botId: string;
  execute(request: FeishuBotCommandRequest): Promise<FeishuCommandOutcome | null>;
  render(result: FeishuCommandOutcome, semantic: FeishuCommandSemantic): { text: string; displayName: string };
}

export type FeishuSenderAuthorizer = ((senderOpenId: string, context: import("./types.js").FeishuMessageContext) => Promise<boolean>) & { commands?: FeishuCommandRuntime };
