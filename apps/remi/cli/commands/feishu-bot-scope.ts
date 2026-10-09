import type { CliOptionSpec, CommandInvocation } from "../core/index.js";
import { stringOption } from "./resource-common.js";

export const FEISHU_BOT_OPTION: CliOptionSpec = {
  name: "bot", type: "string", valueName: "bot-id", description: "Bot ID from workspace feishu-bot list; omitted selects the original default bot",
};

export function feishuBotPath(path: string, invocation: CommandInvocation): string {
  const bot = stringOption(invocation, "bot");
  return bot && /\/feishu-bot(?:\/|$|\?)/.test(path)
    ? `${path}${path.includes("?") ? "&" : "?"}bot_id=${encodeURIComponent(bot)}` : path;
}
