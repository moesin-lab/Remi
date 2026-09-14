import type { Bot, BotSender, BotSession, SaveBotInput } from "../../bots/types";
import type { HttpClient } from "../http";
import { ApiContractError, parseStrictResponse } from "../schema";
import {
  BotListSchema,
  BotSchema,
  BotSenderSchema,
  BotSendersSchema,
  BotSessionsSchema,
  DeleteBotResponseSchema,
} from "../schemas/bots";

const encode = encodeURIComponent;

function botPath(workspaceId: string, botId: string, suffix = ""): string {
  return `/api/bots/${encode(botId)}${suffix}?workspace_id=${encode(workspaceId)}`;
}

function assertBotIdentity(bot: Bot, workspaceId: string, endpoint: string, botId?: string): Bot {
  if (bot.workspace_id !== workspaceId || (botId !== undefined && bot.id !== botId)) {
    throw new ApiContractError(endpoint, "Bot response did not match the requested resource");
  }
  return bot;
}

export class BotsEndpoints {
  constructor(readonly http: HttpClient) {}

  async listBots(workspaceId: string): Promise<{ bots: Bot[] }> {
    const endpoint = "GET /api/bots";
    const raw = await this.http.fetch<unknown>(`/api/bots?workspace_id=${encode(workspaceId)}`);
    const result = parseStrictResponse<{ bots: Bot[] }>(raw, BotListSchema, { endpoint });
    result.bots.forEach((bot) => assertBotIdentity(bot, workspaceId, endpoint));
    return result;
  }

  async getBot(workspaceId: string, botId: string): Promise<Bot> {
    const endpoint = "GET /api/bots/:id";
    const raw = await this.http.fetch<unknown>(botPath(workspaceId, botId));
    const bot = parseStrictResponse<Bot>(raw, BotSchema, { endpoint });
    return assertBotIdentity(bot, workspaceId, endpoint, botId);
  }

  async createBot(input: SaveBotInput): Promise<Bot> {
    const endpoint = "POST /api/bots";
    const raw = await this.http.fetch<unknown>("/api/bots", {
      method: "POST",
      body: JSON.stringify(input),
    });
    const bot = parseStrictResponse<Bot>(raw, BotSchema, { endpoint });
    return assertBotIdentity(bot, input.workspace_id, endpoint);
  }

  async updateBot(botId: string, input: SaveBotInput): Promise<Bot> {
    const endpoint = "PUT /api/bots/:id";
    const raw = await this.http.fetch<unknown>(botPath(input.workspace_id, botId), {
      method: "PUT",
      body: JSON.stringify(input),
    });
    const bot = parseStrictResponse<Bot>(raw, BotSchema, { endpoint });
    return assertBotIdentity(bot, input.workspace_id, endpoint, botId);
  }

  async deleteBot(workspaceId: string, botId: string): Promise<{ deleted: true }> {
    const raw = await this.http.fetch<unknown>(botPath(workspaceId, botId), { method: "DELETE" });
    return parseStrictResponse(raw, DeleteBotResponseSchema, { endpoint: "DELETE /api/bots/:id" });
  }

  async listBotSenders(workspaceId: string, botId: string): Promise<{ senders: BotSender[] }> {
    const endpoint = "GET /api/bots/:id/senders";
    const raw = await this.http.fetch<unknown>(botPath(workspaceId, botId, "/senders"));
    const result = parseStrictResponse<{ senders: BotSender[] }>(raw, BotSendersSchema, { endpoint });
    if (result.senders.some((sender) => sender.bot_id !== botId)) {
      throw new ApiContractError(endpoint, "Sender response did not match the requested Bot");
    }
    return result;
  }

  async updateBotSender(
    workspaceId: string,
    botId: string,
    senderId: string,
    allowed: boolean,
  ): Promise<BotSender> {
    const endpoint = "PUT /api/bots/:id/senders/:senderId";
    const raw = await this.http.fetch<unknown>(botPath(workspaceId, botId, `/senders/${encode(senderId)}`), {
      method: "PUT",
      body: JSON.stringify({ allowed }),
    });
    const sender = parseStrictResponse<BotSender>(raw, BotSenderSchema, { endpoint });
    if (sender.bot_id !== botId || sender.id !== senderId || sender.allowed !== allowed) {
      throw new ApiContractError(endpoint, "Sender response did not match the requested change");
    }
    return sender;
  }

  async listBotSessions(workspaceId: string, botId: string): Promise<{ sessions: BotSession[] }> {
    const endpoint = "GET /api/bots/:id/sessions";
    const raw = await this.http.fetch<unknown>(botPath(workspaceId, botId, "/sessions"));
    const result = parseStrictResponse<{ sessions: BotSession[] }>(raw, BotSessionsSchema, { endpoint });
    if (result.sessions.some((session) => session.bot_id !== botId)) {
      throw new ApiContractError(endpoint, "Session response did not match the requested Bot");
    }
    return result;
  }
}
