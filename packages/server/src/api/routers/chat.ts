import type { Context, Hono } from "hono";
import {
  canCurrentUserAccessAgent,
  canCurrentUserAccessChatSessionAgent,
  currentTaskParentId,
  denyCurrentUserWorkspaceAccess,
  loadChatSessionForCurrentUser,
  normalizeSendChatMessageInput,
  readJson,
  requestedChatWorkspaceId,
  withChatSessionRequestContext,
} from "../helpers.js";
import {
  currentTaskAccessToken,
  authenticatedRequestUserId,
  currentWorkspaceMember,
  chatMessageCompatibilityResponse,
  chatSessionCompatibilityResponse,
  currentRequestUserId,
  issueSessionCompatibilityResponse,
  sessionEventCompatibilityResponse,
  sessionParticipantCompatibilityResponse,
  sessionResultCompatibilityResponse,
  sendChatMessageCompatibilityResponse,
  taskPublicResponse,
} from "../wire/index.js";
import type {
  CreateChatSessionInput,
  AddSessionParticipantInput,
  CreateIssueSessionInput,
  CreateSessionTaskInput,
  PublishSessionResultInput,
  SendChatMessageInput,
  UpdateChatSessionInput,
  UpdateIssueSessionInput,
} from "@multiremi/contracts/types.js";
import type { RouterDeps } from "./deps.js";
import { ChatConflictError, ChatValidationError } from "@multiremi/store/repos/chat-repo.js";
import { AgentIssueUpdateValidationError } from "@multiremi/store/repos/agent-issue-updates-repo.js";

function sessionMutationActor(c: Context): { actorType: "agent" | "member" | "system"; actorId: string | null } {
  const taskAgentId = currentTaskAccessToken(c)?.agentId ?? null;
  if (taskAgentId) return { actorType: "agent", actorId: taskAgentId };
  const userId = authenticatedRequestUserId(c);
  return userId
    ? { actorType: "member", actorId: userId }
    : { actorType: "system", actorId: null };
}

export function registerChatRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  app.get("/api/multiremi/chats", (c) => {
    const workspaceId = requestedChatWorkspaceId(c, store);
    if (workspaceId instanceof Response) return workspaceId;
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const sessions = store.listChatSessions(workspaceId, {
      creatorId: currentRequestUserId(c),
      includeArchived: c.req.query("status") === "all" || c.req.query("status") === "archived",
    }).filter((session) => (c.req.query("status") !== "archived" || session.status === "archived") && canCurrentUserAccessChatSessionAgent(c, store, session));
    return c.json({ sessions, total: sessions.length });
  });
  app.post("/api/multiremi/chats", async (c) => {
    const body = await readJson<CreateChatSessionInput>(c);
    const input = withChatSessionRequestContext(c, store, body);
    if (input instanceof Response) return input;
    return chatMutation(c, () => c.json({ session: store.createChatSession(input) }, 201));
  });
  app.get("/api/multiremi/chats/:id/sessions", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const sessions = store.listChatOwnedSessions(loaded.session.id, c.req.query("include_archived") === "true");
    return c.json({
      sessions: sessions.map((session) => issueSessionCompatibilityResponse(session, store.listSessionParticipants(session.id))),
    });
  });
  app.post("/api/multiremi/chats/:id/sessions", async (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJson<CreateIssueSessionInput>(c);
    return chatMutation(c, () => {
      const taskAgentId = currentTaskAccessToken(c)?.agentId ?? null;
      const userId = authenticatedRequestUserId(c);
      const session = store.createSession(loaded.session.id, {
        ...body,
        chatId: loaded.session.id,
        createdByType: taskAgentId ? "agent" : userId ? "member" : "system",
        createdById: taskAgentId ?? userId,
      });
      return c.json({ session: issueSessionCompatibilityResponse(session, store.listSessionParticipants(session.id)) }, 201);
    });
  });
  app.post("/api/multiremi/chats/:id/sessions/:sessionId/adopt", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    return chatMutation(c, () => {
      const session = store.adoptLegacySession(loaded.session.id, c.req.param("sessionId"));
      return c.json({ session: issueSessionCompatibilityResponse(session, store.listSessionParticipants(session.id)) });
    });
  });
  app.get("/api/multiremi/chats/:id/sessions/:sessionId", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const session = store.getIssueSession(c.req.param("sessionId"));
    if (!session || session.chatId !== loaded.session.id) return c.json({ error: "session not found" }, 404);
    return c.json({ session: issueSessionCompatibilityResponse(session, store.listSessionParticipants(session.id)) });
  });
  app.patch("/api/multiremi/chats/:id/sessions/:sessionId", async (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const session = store.getIssueSession(c.req.param("sessionId"));
    if (!session || session.chatId !== loaded.session.id) return c.json({ error: "session not found" }, 404);
    const body = await readJson<UpdateIssueSessionInput>(c);
    return chatMutation(c, () => c.json({
      session: issueSessionCompatibilityResponse(
        store.updateIssueSession(session.id, body),
        store.listSessionParticipants(session.id),
      ),
    }));
  });
  app.get("/api/multiremi/chats/:id/sessions/:sessionId/events", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const session = store.getIssueSession(c.req.param("sessionId"));
    if (!session || session.chatId !== loaded.session.id) return c.json({ error: "session not found" }, 404);
    const sinceSeq = Number(c.req.query("since_seq") ?? 0);
    return c.json({ events: store.listSessionEvents(session.id, { sinceSeq }).map(sessionEventCompatibilityResponse) });
  });
  app.post("/api/multiremi/chats/:id/sessions/:sessionId/messages", async (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const session = store.getIssueSession(c.req.param("sessionId"));
    if (!session || session.chatId !== loaded.session.id) return c.json({ error: "session not found" }, 404);
    const body = await readJson<{ body?: string; content?: string }>(c);
    const content = (body.body ?? body.content ?? "").trim();
    if (!content) return c.json({ error: "message body is required" }, 400);
    const actor = sessionMutationActor(c);
    return c.json({ event: sessionEventCompatibilityResponse(store.appendSessionEvent(session.id, {
      authorType: actor.actorType,
      authorId: actor.actorId,
      kind: "message",
      body: content,
    })) }, 201);
  });
  app.get("/api/multiremi/chats/:id/sessions/:sessionId/participants", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const session = store.getIssueSession(c.req.param("sessionId"));
    if (!session || session.chatId !== loaded.session.id) return c.json({ error: "session not found" }, 404);
    return c.json({ participants: store.listSessionParticipants(session.id).map(sessionParticipantCompatibilityResponse) });
  });
  app.post("/api/multiremi/chats/:id/sessions/:sessionId/participants", async (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const session = store.getIssueSession(c.req.param("sessionId"));
    if (!session || session.chatId !== loaded.session.id) return c.json({ error: "session not found" }, 404);
    const body = await readJson<AddSessionParticipantInput>(c);
    const participantType = body.participantType ?? body.participant_type;
    const participantId = body.participantId ?? body.participant_id;
    if (participantType === "agent" && participantId) {
      const agent = store.getAgent(participantId);
      if (!agent || !canCurrentUserAccessAgent(c, store, agent)) return c.json({ error: "you do not have access to this agent" }, 403);
    }
    return chatMutation(c, () => c.json({
      participant: sessionParticipantCompatibilityResponse(store.addSessionParticipant(session.id, body)),
    }, 201));
  });
  app.delete("/api/multiremi/chats/:id/sessions/:sessionId/participants/:participantType/:participantId", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const session = store.getIssueSession(c.req.param("sessionId"));
    if (!session || session.chatId !== loaded.session.id) return c.json({ error: "session not found" }, 404);
    store.removeSessionParticipant(session.id, c.req.param("participantType"), c.req.param("participantId"));
    return c.body(null, 204);
  });
  app.get("/api/multiremi/chats/:id/sessions/:sessionId/tasks", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const session = store.getIssueSession(c.req.param("sessionId"));
    if (!session || session.chatId !== loaded.session.id) return c.json({ error: "session not found" }, 404);
    return c.json({ tasks: store.listTasks().filter((task) => task.issueSessionId === session.id).map(taskPublicResponse) });
  });
  app.post("/api/multiremi/chats/:id/sessions/:sessionId/tasks", async (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const session = store.getIssueSession(c.req.param("sessionId"));
    if (!session || session.chatId !== loaded.session.id) return c.json({ error: "session not found" }, 404);
    const body = await readJson<CreateSessionTaskInput>(c);
    const agentId = body.agentId ?? body.agent_id;
    const agent = agentId ? store.getAgent(agentId) : null;
    if (!agent) return c.json({ error: "agent not found" }, 404);
    if (!canCurrentUserAccessAgent(c, store, agent)) return c.json({ error: "you do not have access to this agent" }, 403);
    const actor = sessionMutationActor(c);
    return chatMutation(c, () => c.json({ task: taskPublicResponse(store.createSessionTask(session.id, {
      ...body,
      agentId,
      createdByType: actor.actorType,
      createdById: actor.actorId,
      parentTaskId: currentTaskParentId(c),
    })) }, 201));
  });
  app.get("/api/multiremi/chats/:id/sessions/:sessionId/results", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const session = store.getIssueSession(c.req.param("sessionId"));
    if (!session || session.chatId !== loaded.session.id) return c.json({ error: "session not found" }, 404);
    return c.json({ results: store.listSessionResults(session.id).map(sessionResultCompatibilityResponse) });
  });
  app.post("/api/multiremi/chats/:id/sessions/:sessionId/results", async (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const session = store.getIssueSession(c.req.param("sessionId"));
    if (!session || session.chatId !== loaded.session.id) return c.json({ error: "session not found" }, 404);
    const body = await readJson<PublishSessionResultInput>(c);
    const actor = sessionMutationActor(c);
    return chatMutation(c, () => c.json({ result: sessionResultCompatibilityResponse(store.publishSessionResult(session.id, {
      ...body,
      publishedByType: actor.actorType,
      publishedById: actor.actorId,
      sourceTaskId: currentTaskParentId(c),
    })) }, 201));
  });
  app.get("/api/multiremi/chats/:id", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const { session } = loaded;
    return c.json({ session, messages: store.listChatMessages(session.id) });
  });
  app.patch("/api/multiremi/chats/:id", async (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJson<UpdateChatSessionInput>(c);
    const invalid = invalidChatUpdate(c, body);
    if (invalid) return invalid;
    return chatMutation(c, () => c.json({ session: store.updateChatSession(loaded.session.id, body) }));
  });
  app.get("/api/multiremi/chats/:id/messages", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    return c.json({ messages: store.listChatMessages(loaded.session.id) });
  });
  app.post("/api/multiremi/chats/:id/messages", async (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJson<SendChatMessageInput>(c);
    const message = normalizeSendChatMessageInput(c, body);
    if (message instanceof Response) return message;
    return chatMutation(c, () => {
      const result = store.sendChatMessage(loaded.session.id, {
        ...message,
        parentTaskId: currentTaskAccessToken(c)?.taskId ?? null,
      });
      return c.json({ ...result, supports_queue: true, task: taskPublicResponse(result.task) }, 201);
    });
  });
  app.get("/api/chat/sessions", (c) => {
    const workspaceId = requestedChatWorkspaceId(c, store);
    if (workspaceId instanceof Response) return workspaceId;
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return c.json(store.listChatSessions(workspaceId, {
      creatorId: currentRequestUserId(c),
      includeArchived: c.req.query("status") === "all" || c.req.query("status") === "archived",
    }).filter((session) => (c.req.query("status") !== "archived" || session.status === "archived") && canCurrentUserAccessChatSessionAgent(c, store, session)).map(chatSessionCompatibilityResponse));
  });
  app.post("/api/chat/sessions", async (c) => {
    const body = await readJson<CreateChatSessionInput>(c);
    const input = withChatSessionRequestContext(c, store, body);
    if (input instanceof Response) return input;
    return chatMutation(c, () => c.json(chatSessionCompatibilityResponse(store.createChatSession(input)), 201));
  });
  app.get("/api/chat/sessions/:sessionId", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    return c.json(chatSessionCompatibilityResponse(loaded.session));
  });
  app.patch("/api/chat/sessions/:sessionId", async (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    const body = await readJson<UpdateChatSessionInput>(c);
    const invalid = invalidChatUpdate(c, body);
    if (invalid) return invalid;
    return chatMutation(c, () => c.json(chatSessionCompatibilityResponse(store.updateChatSession(loaded.session.id, body))));
  });
  app.delete("/api/chat/sessions/:sessionId", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"), { requireAgentAccess: false });
    if (loaded instanceof Response) return loaded;
    const deleted = store.deleteChatSession(loaded.session.id);
    if (!deleted) return c.json({ error: "chat session not found" }, 404);
    return c.body(null, 204);
  });
  app.get("/api/chat/sessions/:sessionId/messages", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    const messages = store.listChatMessages(loaded.session.id);
    const attachments = store.listAttachmentsForChatMessages(messages.map((message) => message.id));
    return c.json(messages.map((message) => chatMessageCompatibilityResponse(message, attachments.get(message.id) ?? [])));
  });
  app.get("/api/chat/sessions/:sessionId/messages/page", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    const rawLimit = c.req.query("limit");
    let limit = 50;
    if (rawLimit != null && rawLimit !== "") {
      const parsedLimit = Number(rawLimit);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
        return c.json({ error: "invalid limit" }, 400);
      }
      limit = parsedLimit;
    }
    const beforeCreatedAt = c.req.query("before_created_at");
    const beforeId = c.req.query("before_id");
    if ((!beforeCreatedAt && beforeId) || (beforeCreatedAt && !beforeId)) {
      return c.json({ error: "invalid cursor" }, 400);
    }
    if (beforeCreatedAt && Number.isNaN(Date.parse(beforeCreatedAt))) {
      return c.json({ error: "invalid cursor" }, 400);
    }
    const sessionMessages = store.listChatMessages(loaded.session.id);
    const attachments = store.listAttachmentsForChatMessages(sessionMessages.map((message) => message.id));
    const messages = sessionMessages.map((message) => chatMessageCompatibilityResponse(message, attachments.get(message.id) ?? []));
    const cursorIndex = beforeCreatedAt
      ? messages.findIndex((message) => message.id === beforeId && message.created_at === beforeCreatedAt)
      : messages.length;
    if (cursorIndex < 0) return c.json({ error: "invalid cursor" }, 400);
    const filtered = messages.slice(0, cursorIndex);
    const pageMessages = filtered.slice(Math.max(0, filtered.length - limit));
    const hasMore = filtered.length > pageMessages.length;
    const nextCursor = hasMore && pageMessages[0]
      ? { created_at: pageMessages[0].created_at, id: pageMessages[0].id }
      : null;
    return c.json({
      messages: pageMessages,
      limit,
      has_more: hasMore,
      next_cursor: nextCursor,
    });
  });
  app.post("/api/chat/sessions/:sessionId/messages", async (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    const body = await readJson<SendChatMessageInput>(c);
    const message = normalizeSendChatMessageInput(c, body);
    if (message instanceof Response) return message;
    return chatMutation(c, () => c.json(sendChatMessageCompatibilityResponse(store.sendChatMessage(loaded.session.id, {
      ...message,
      parentTaskId: currentTaskAccessToken(c)?.taskId ?? null,
    })), 201));
  });
  app.get("/api/chat/sessions/:sessionId/pending-task", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    const task = store.getPendingChatTask(loaded.session.id);
    return c.json({
      ...(task ? { task_id: task.id, status: task.status, created_at: task.createdAt } : {}),
      supports_queue: true,
      queued_tasks: store.listQueuedChatTasks(loaded.session.id),
    });
  });
  app.patch("/api/chat/sessions/:sessionId/queue/:taskId", async (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    const body = await readJson<{ content?: unknown }>(c);
    if (typeof body.content !== "string" || !body.content.trim()) return c.json({ error: "content is required" }, 400);
    return chatMutation(c, () => c.json(store.updateQueuedChatTask(loaded.session.id, c.req.param("taskId"), body.content as string)));
  });
  app.delete("/api/chat/sessions/:sessionId/queue/:taskId", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    return chatMutation(c, () => {
      store.removeQueuedChatTasks(loaded.session.id, c.req.param("taskId"));
      return c.body(null, 204);
    });
  });
  app.delete("/api/chat/sessions/:sessionId/queue", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    return chatMutation(c, () => {
      store.removeQueuedChatTasks(loaded.session.id);
      return c.body(null, 204);
    });
  });
  app.post("/api/chat/sessions/:sessionId/queue/:taskId/prioritize", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    return chatMutation(c, () => c.json(store.prioritizeQueuedChatTask(loaded.session.id, c.req.param("taskId"))));
  });
  app.post("/api/chat/sessions/:sessionId/read", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    store.markChatSessionRead(loaded.session.id);
    return c.body(null, 204);
  });
  app.get("/api/chat/sessions/:sessionId/issue-updates", (c) => {
    if (currentTaskAccessToken(c)) {
      return c.json({ error: "forbidden for task token", code: "task_token_hard_denied" }, 403);
    }
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    return c.json({ subscription: agentIssueUpdateSubscriptionResponse(
      store.getAgentIssueUpdateSubscription(loaded.session.id),
    ) });
  });
  app.put("/api/chat/sessions/:sessionId/issue-updates", async (c) => {
    if (currentTaskAccessToken(c)) {
      return c.json({ error: "forbidden for task token", code: "task_token_hard_denied" }, 403);
    }
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("sessionId"));
    if (loaded instanceof Response) return loaded;
    const body = await readJson<{ enabled?: unknown }>(c);
    if (typeof body.enabled !== "boolean") return c.json({ error: "enabled must be a boolean" }, 400);
    try {
      const member = currentWorkspaceMember(c, store, loaded.session.workspaceId);
      const subscription = store.setAgentIssueUpdateSubscription({
        chatSessionId: loaded.session.id,
        enabled: body.enabled,
        memberId: member?.id ?? null,
        createdBy: currentRequestUserId(c),
      });
      return c.json({ subscription: agentIssueUpdateSubscriptionResponse(subscription) });
    } catch (error) {
      if (error instanceof AgentIssueUpdateValidationError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });
  app.get("/api/chat/pending-tasks", (c) => {
    const workspaceId = requestedChatWorkspaceId(c, store);
    if (workspaceId instanceof Response) return workspaceId;
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const tasks = store.listPendingChatTasks(workspaceId, { creatorId: currentRequestUserId(c) })
      .filter((task) => {
        const session = task.chatSessionId ? store.getChatSession(task.chatSessionId) : null;
        return session ? canCurrentUserAccessChatSessionAgent(c, store, session) : false;
      })
      .map((task) => ({ task_id: task.id, status: task.status, chat_session_id: task.chatSessionId }));
    return c.json({ tasks });
  });
}

function agentIssueUpdateSubscriptionResponse(subscription: import("@multiremi/contracts/types.js").MultiremiAgentIssueUpdateSubscription) {
  return {
    chat_session_id: subscription.chatSessionId,
    issue_id: subscription.issueId,
    channel_id: subscription.channelId,
    enabled: subscription.enabled,
    debounce_window_seconds: subscription.debounceWindowSeconds,
  };
}

function chatMutation(c: Context, operation: () => Response): Response {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ChatConflictError) return c.json({ error: error.message }, 409);
    if (error instanceof ChatValidationError) return c.json({ error: error.message }, 400);
    throw error;
  }
}

function invalidChatUpdate(c: Context, input: UpdateChatSessionInput): Response | null {
  if (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim())) return c.json({ error: "title is required" }, 400);
  if (input.status !== undefined && input.status !== "active" && input.status !== "archived") return c.json({ error: "invalid status" }, 400);
  if (input.pinned !== undefined && typeof input.pinned !== "boolean") return c.json({ error: "pinned must be a boolean" }, 400);
  return null;
}
