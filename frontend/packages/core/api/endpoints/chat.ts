import type {
  ChatMessage,
  ChatMessagesPage,
  ChatPendingTask,
  ChatSession,
  PendingChatTasksResponse,
  SendChatMessageResponse,
} from "../../types";
import { type HttpClient, ApiError } from "../http";
import { ApiContractError, parseStrictResponse } from "../schema";
import { ChatSessionSchema, ChatSessionListSchema } from "../schemas/chat";

export class ChatEndpoints {
  constructor(readonly http: HttpClient) {}

  // Chat Sessions
  async listChatSessions(params?: { status?: string }): Promise<ChatSession[]> {
    const query = params?.status ? `?status=${params.status}` : "";
    const raw = await this.http.fetch<unknown>(`/api/chat/sessions${query}`);
    return parseStrictResponse(raw, ChatSessionListSchema, { endpoint: "GET /api/chat/sessions" });
  }

  async getChatSession(id: string): Promise<ChatSession> {
    const raw = await this.http.fetch<unknown>(`/api/chat/sessions/${id}`);
    return parseStrictResponse(raw, ChatSessionSchema, { endpoint: "GET /api/chat/sessions/:id" });
  }

  async createChatSession(data: { agent_id: string; title?: string; project_id?: string | null; runtime_workspace_id?: string | null }): Promise<ChatSession> {
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
    await this.http.fetch(`/api/chat/sessions/${id}`, { method: "DELETE" });
  }

  async updateChatSession(id: string, data: { title: string }): Promise<ChatSession> {
    return this.http.fetch(`/api/chat/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  async listChatMessages(sessionId: string): Promise<ChatMessage[]> {
    return this.http.fetch(`/api/chat/sessions/${sessionId}/messages`);
  }

  async listChatMessagesPage(
    sessionId: string,
    params: { before?: { created_at: string; id: string } | null; limit?: number } = {},
  ): Promise<ChatMessagesPage> {
    const limit = params.limit ?? 50;
    const query = new URLSearchParams({ limit: String(limit) });
    if (params.before) {
      query.set("before_created_at", params.before.created_at);
      query.set("before_id", params.before.id);
    }
    try {
      return await this.http.fetch(
        `/api/chat/sessions/${sessionId}/messages/page?${query.toString()}`,
      );
    } catch (err) {
      // Deployment-order compatibility: a backend deployed before this endpoint
      // existed returns 404 for the unknown route. Fall back to the legacy
      // full-list endpoint so chat never white-screens regardless of whether
      // the server or the client deploys first. Only the initial (cursorless)
      // page falls back — the legacy endpoint returns every message at once, so
      // the fallback page reports has_more: false and there is no follow-up
      // request to translate. A 404 on a cursor request is an unexpected state
      // and propagates instead of duplicating the whole list.
      if (err instanceof ApiError && err.status === 404 && !params.before) {
        const messages = await this.listChatMessages(sessionId);
        return { messages, limit, has_more: false, next_cursor: null };
      }
      throw err;
    }
  }

  async sendChatMessage(
    sessionId: string,
    content: string,
    attachmentIds?: string[],
  ): Promise<SendChatMessageResponse> {
    const body: { content: string; attachment_ids?: string[] } = { content };
    if (attachmentIds && attachmentIds.length > 0) {
      body.attachment_ids = attachmentIds;
    }
    return this.http.fetch(`/api/chat/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async getPendingChatTask(sessionId: string): Promise<ChatPendingTask> {
    return this.http.fetch(`/api/chat/sessions/${sessionId}/pending-task`);
  }

  async listPendingChatTasks(): Promise<PendingChatTasksResponse> {
    return this.http.fetch(`/api/chat/pending-tasks`);
  }

  async markChatSessionRead(sessionId: string): Promise<void> {
    await this.http.fetch(`/api/chat/sessions/${sessionId}/read`, { method: "POST" });
  }

  async cancelTaskById(taskId: string): Promise<void> {
    await this.http.fetch(`/api/tasks/${taskId}/cancel`, { method: "POST" });
  }
}
