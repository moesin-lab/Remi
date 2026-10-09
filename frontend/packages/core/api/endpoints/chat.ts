import { MessagesEndpoints } from "./messages";
import { InboxEndpoints } from "./inbox";
import { turnToTask } from "../turn-task";
import { TurnDetailSchema } from "../schemas/messages";
import type {
  CreateSessionRequest,
  CreateSessionTaskRequest,
  Session,
  SessionTask,
  CreateChatSessionInput,
  ChatPendingTask,
  ChatSession,
  PendingChatTasksResponse,
  SendChatMessageResponse,
  UpdateChatSessionInput,
} from "../../types";
import { z } from "zod";
import type { HttpClient } from "../http";
import { ApiContractError, parseStrictResponse } from "../schema";
import {
  ChatSessionSchema, ChatSessionListSchema, ChatSessionUpdateResponseSchema, ChatNoContentSchema,
} from "../schemas/chat";
import { IssueSessionSchema } from "../schemas/comments";

const WorkSessionResponseSchema = z.object({ session: IssueSessionSchema });
const WorkSessionsResponseSchema = z.object({ sessions: z.array(IssueSessionSchema) });

export class ChatEndpoints {
  constructor(readonly http: HttpClient) {}

  async listChatWorkSessions(chatId: string): Promise<Session[]> {
    const raw = await this.http.fetch<unknown>(`/api/multiremi/chats/${encodeURIComponent(chatId)}/sessions?include_archived=true`);
    const { sessions } = parseStrictResponse<{ sessions: Session[] }>(raw, WorkSessionsResponseSchema, {
      endpoint: "GET /api/multiremi/chats/:id/sessions",
    });
    if (sessions.some(session => session.owner_type !== "chat" || session.owner_id !== chatId || session.chat_id !== chatId)) {
      throw new ApiContractError("GET /api/multiremi/chats/:id/sessions", "Session owner did not match the requested Chat");
    }
    return sessions;
  }

  async createChatWorkSession(chatId: string, input: CreateSessionRequest): Promise<Session> {
    const raw = await this.http.fetch<unknown>(`/api/multiremi/chats/${encodeURIComponent(chatId)}/sessions`, {
      method: "POST", body: JSON.stringify(input),
    });
    const { session } = parseStrictResponse<{ session: Session }>(raw, WorkSessionResponseSchema, {
      endpoint: "POST /api/multiremi/chats/:id/sessions",
    });
    if (!session.id || session.owner_type !== "chat" || session.owner_id !== chatId || session.chat_id !== chatId
      || session.title !== input.title.trim() || session.parent_session_id !== (input.parent_session_id ?? null)
      || (input.holds_workspace !== undefined && session.holds_workspace !== input.holds_workspace)) {
      throw new ApiContractError("POST /api/multiremi/chats/:id/sessions", "Server did not retain the requested Session owner");
    }
    return session;
  }

  async listChatWorkSessionTasks(chatId: string, sessionId: string): Promise<SessionTask[]> {
    const messages = new MessagesEndpoints(this.http);
    const tasks: SessionTask[] = [];
    let cursor: string | undefined;

    do {
      const page = await messages.listTurns({ session_id: sessionId, cursor, limit: 100 });
      if (page.turns.some(turn => turn.session_id !== sessionId
        || turn.chat_session_id !== undefined && turn.chat_session_id !== chatId)) {
        throw new ApiContractError("GET /api/turns", "Turn destination did not match the requested Session");
      }
      tasks.push(...page.turns.map(turn => ({
        ...turnToTask(turn),
        chat_session_id: chatId,
        issue_id: typeof turn.issue_id === "string" ? turn.issue_id : null,
        issue_session_id: sessionId,
      })));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);

    return tasks;
  }

  async createChatWorkSessionTask(_chatId: string, sessionId: string, input: CreateSessionTaskRequest) {
    // A committed message remains successful even when dispatch is deferred.
    // The scoped turn query supplies the current attempt after reconciliation.
    const result = await new MessagesEndpoints(this.http).sendMessage(sessionId, {
      body_md: input.prompt,
      message_kind: "request",
      to: { type: "agent", ref: input.agent_id },
      wake_requested: "now",
    });
    if (result.message.session_id !== sessionId || result.message.to_agent_id !== input.agent_id) {
      throw new ApiContractError("POST /api/sessions/:id/messages", "Server did not retain the requested Session or agent");
    }
    return result;
  }

  // Chat Sessions
  async listChatSessions(params?: { status?: string }): Promise<ChatSession[]> {
    const query = params?.status ? `?status=${params.status}` : "";
    const raw = await this.http.fetch<unknown>(`/api/chat/sessions${query}`);
    return parseStrictResponse<ChatSession[]>(raw, ChatSessionListSchema, { endpoint: "GET /api/chat/sessions" });
  }

  async getChatSession(id: string): Promise<ChatSession> {
    const raw = await this.http.fetch<unknown>(`/api/chat/sessions/${id}`);
    return parseStrictResponse<ChatSession>(raw, ChatSessionSchema, { endpoint: "GET /api/chat/sessions/:id" });
  }

  async createChatSession(data: CreateChatSessionInput): Promise<ChatSession> {
    const raw = await this.http.fetch<unknown>("/api/chat/sessions", {
      method: "POST",
      body: JSON.stringify(data),
    });
    const session = parseStrictResponse<ChatSession>(raw, ChatSessionSchema, { endpoint: "POST /api/chat/sessions" });
    if (data.runtime_workspace_id && session.runtime_workspace_id !== data.runtime_workspace_id) {
      throw new ApiContractError("POST /api/chat/sessions", "Server did not retain the selected runtime workspace");
    }
    if (data.project_id && session.project_id !== data.project_id) {
      throw new ApiContractError("POST /api/chat/sessions", "Server did not retain the selected project");
    }
    return session;
  }

  async deleteChatSession(id: string): Promise<void> {
    const raw = await this.http.fetch<unknown>(`/api/chat/sessions/${id}`, { method: "DELETE" });
    parseStrictResponse<z.infer<typeof ChatNoContentSchema>>(raw, ChatNoContentSchema, { endpoint: "DELETE /api/chat/sessions/:id" });
  }

  async updateChatSession(id: string, data: UpdateChatSessionInput): Promise<ChatSession> {
    const raw = await this.http.fetch<unknown>(`/api/chat/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
    const session = parseStrictResponse<ChatSession>(raw, ChatSessionUpdateResponseSchema, { endpoint: "PATCH /api/chat/sessions/:id" });
    if (session.id !== id || Object.entries(data).some(([field, value]) =>
      value !== undefined && session[field as keyof UpdateChatSessionInput] !== value)) {
      throw new ApiContractError("PATCH /api/chat/sessions/:id", "Server did not retain the requested session changes");
    }
    return session;
  }

  async sendChatMessage(sessionId: string, content: string, attachmentIds?: string[], clientId?: string): Promise<SendChatMessageResponse> {
    const session = await this.getChatSession(sessionId);
    const result = await new MessagesEndpoints(this.http).sendMessage(sessionId, {
      body_md: content, message_kind: "request", to: { type: "agent", ref: session.agent_id },
      attachment_ids: attachmentIds?.length ? attachmentIds : undefined, dedupe_key: clientId,
    });
    // The message is committed. A supplemental read must not turn it into a failed send.
    // Pending-turn polling reconciles the optimistic identity if this read is unavailable.
    const detail = result.turn_id ? await new MessagesEndpoints(this.http).getTurn(result.turn_id).catch(() => null) : null;
    return { message_id: result.message.id, task_id: detail?.turn.current_attempt_id ?? result.turn_id ?? "",
      turn_id: result.turn_id, created_at: detail?.turn.created_at ?? result.message.created_at,
      supports_queue: true, queued: detail?.turn.status === "running" || detail?.turn.status === "awaiting_human" };
  }

  private async activeTurns(sessionId?: string) {
    const messages = new MessagesEndpoints(this.http);
    const pages = await Promise.all(["pending", "running", "awaiting_human"].map(async status => {
      const turns = [];
      let cursor: string | undefined;
      do { const page = await messages.listTurns({ session_id: sessionId, status, cursor, limit: 100 }); turns.push(...page.turns); cursor = page.next_cursor ?? undefined; } while (cursor);
      return turns;
    }));
    return pages.flat().sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  async getPendingChatTask(sessionId: string): Promise<ChatPendingTask> {
    const turn = (await this.activeTurns(sessionId))[0];
    return turn ? { task_id: turn.current_attempt_id ?? turn.id, turn_id: turn.id,
      status: turn.status === "pending" ? "queued" : turn.status, created_at: turn.created_at, supports_queue: true }
      : { supports_queue: true };
  }
  async listPendingChatTasks(): Promise<PendingChatTasksResponse> {
    return { tasks: (await this.activeTurns()).filter(turn => turn.session_id.startsWith("chat_"))
      .map(turn => ({ task_id: turn.current_attempt_id ?? turn.id, status: turn.status === "pending" ? "queued" : turn.status, chat_session_id: turn.session_id })) };
  }

  async markChatSessionRead(sessionId: string): Promise<void> {
    await new InboxEndpoints(this.http).markInboxRead({ session_id: sessionId });
  }

  async cancelTaskById(turnId: string): Promise<void> {
    const path = `/api/turns/${encodeURIComponent(turnId)}/cancel`;
    const response = parseStrictResponse<z.infer<typeof TurnDetailSchema>>(await this.http.fetch<unknown>(path, { method: "POST", body: "{}" }), TurnDetailSchema, { endpoint: path });
    if (response.turn.id !== turnId) throw new ApiContractError(path, "Server returned a different turn");
  }
}
