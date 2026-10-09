import type { Context, Hono } from "hono";
import {
  canCurrentUserAccessAgent,
  canCurrentUserAccessAgentChecker,
  canCurrentUserAccessChatSessionAgent,
  canTaskCoordinateSession,
  currentTaskParentId,
  denyCurrentUserWorkspaceAccess,
  denySessionAccess,
  denySideSessionAgentDispatch,
  denyTaskChatContentAccess,
  loadChatSessionForCurrentUser,
  normalizeSendChatMessageInput,
  readJson,
  requestedChatWorkspaceId,
  withChatSessionRequestContext,
} from "../helpers.js";
import {
  authenticatedRequestUserId,
  currentTaskAccessToken,
  chatMessageCompatibilityResponse,
  chatSessionCompatibilityResponse,
  currentRequestUserId,
  issueSessionCompatibilityResponse,
  sessionEventCompatibilityResponse,
  sessionParticipantCompatibilityResponse,
  sessionResultCompatibilityResponse,
  sessionTaskMetadataResponse,
  sendChatMessageCompatibilityResponse,
  taskPublicResponse,
} from "../wire/index.js";
import type {
  AddSessionParticipantInput,
  CreateChatSessionInput,
  CreateIssueSessionInput,
  CreateSessionTaskInput,
  MultiremiChatSession,
  MultiremiIssueSession,
  PublishSessionResultInput,
  SendChatMessageInput,
  UpdateChatSessionInput,
  UpdateIssueSessionInput,
} from "@multiremi/contracts/types.js";
import type { RouterDeps } from "./deps.js";
import { ChatConflictError, ChatValidationError } from "@multiremi/store/repos/chat-repo.js";
import { stripServerOwnedSessionTaskFields } from "../wire/issues.js";

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
  const loadWorkSession = (c: Context, allowCoordination = false): MultiremiIssueSession | Response => {
    const session = store.getIssueSession(c.req.param("sessionId") ?? "");
    if (!session || session.chatId !== c.req.param("id")) return c.json({ error: "session not found" }, 404);
    return allowCoordination && canTaskCoordinateSession(c, store, session)
      ? session : denySessionAccess(c, store, session) ?? session;
  };
  // Feishu conversations share transport storage with Chat, but belong to
  // Feishu — an Issue topic to the Issue discussion surface, a private Feishu
  // thread to Feishu itself — never to the user's Web conversation list.
  const listedSessions = (c: Context, workspaceId: string): MultiremiChatSession[] => {
    const sessions = store.listChatSessions(workspaceId, {
      creatorId: currentRequestUserId(c),
      includeArchived: c.req.query("status") === "all" || c.req.query("status") === "archived",
      excludeTransportSessions: true,
    });
    const agentsById = new Map(store.listAgentsLiteByIds(sessions.map(session => session.agentId))
      .map(agent => [agent.id, agent]));
    const canAccess = canCurrentUserAccessAgentChecker(c, store);
    return sessions.filter(session => {
      const agent = agentsById.get(session.agentId);
      return (c.req.query("status") !== "archived" || session.status === "archived")
        && Boolean(agent && agent.workspaceId === session.workspaceId && canAccess(agent));
    });
  };

  app.get("/api/multiremi/chats", (c) => {
    const workspaceId = requestedChatWorkspaceId(c, store);
    if (workspaceId instanceof Response) return workspaceId;
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const taskToken = currentTaskAccessToken(c);
    const task = taskToken?.taskId ? store.getTask(taskToken.taskId) : null;
    if (taskToken && !task?.chatSessionId) return c.json({ sessions: [], total: 0 });
    const contentDenied = denyTaskChatContentAccess(c, store, task?.chatSessionId ?? "");
    if (contentDenied) return contentDenied;
    const sessions = listedSessions(c, workspaceId).filter((session) => !task || session.id === task.chatSessionId);
    return c.json({ sessions, total: sessions.length });
  });
  app.post("/api/multiremi/chats", async (c) => {
    const body = await readJson<CreateChatSessionInput>(c);
    const input = withChatSessionRequestContext(c, store, body);
    if (input instanceof Response) return input;
    return chatMutation(c, () => c.json({ session: store.createChatSession(input) }, 201));
  });
  app.get("/api/multiremi/chats/:id/sessions", (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"), { scope: "owner" });
    if (loaded instanceof Response) return loaded;
    const sessions = store.listChatOwnedSessions(loaded.session.id, c.req.query("include_archived") === "true");
    return c.json({
      sessions: sessions.map((session) => issueSessionCompatibilityResponse(session, store.listSessionParticipants(session.id))),
    });
  });
  app.post("/api/multiremi/chats/:id/sessions", async (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"), { scope: "owner" });
    if (loaded instanceof Response) return loaded;
    const body = await readJson<CreateIssueSessionInput>(c);
    if (body.id && store.getIssueSession(body.id)) return c.json({ error: "Session id already exists" }, 409);
    return sessionMutation(c, () => {
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
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"), { scope: "owner" });
    if (loaded instanceof Response) return loaded;
    return sessionMutation(c, () => {
      const session = store.adoptLegacySession(loaded.session.id, c.req.param("sessionId"));
      return c.json({ session: issueSessionCompatibilityResponse(session, store.listSessionParticipants(session.id)) });
    });
  });
  app.get("/api/multiremi/chats/:id/sessions/:sessionId", (c) => {
    const session = loadWorkSession(c, true);
    if (session instanceof Response) return session;
    return c.json({ session: issueSessionCompatibilityResponse(session, store.listSessionParticipants(session.id)) });
  });
  app.patch("/api/multiremi/chats/:id/sessions/:sessionId", async (c) => {
    const session = loadWorkSession(c);
    if (session instanceof Response) return session;
    const body = await readJson<UpdateIssueSessionInput>(c);
    return sessionMutation(c, () => c.json({
      session: issueSessionCompatibilityResponse(
        store.updateIssueSession(session.id, body),
        store.listSessionParticipants(session.id),
      ),
    }));
  });


  app.get("/api/multiremi/chats/:id/sessions/:sessionId/participants", (c) => {
    const session = loadWorkSession(c);
    if (session instanceof Response) return session;
    return c.json({ participants: store.listSessionParticipants(session.id).map(sessionParticipantCompatibilityResponse) });
  });
  app.post("/api/multiremi/chats/:id/sessions/:sessionId/participants", async (c) => {
    const session = loadWorkSession(c);
    if (session instanceof Response) return session;
    const body = await readJson<AddSessionParticipantInput>(c);
    const participantType = body.participantType ?? body.participant_type;
    const participantId = body.participantId ?? body.participant_id;
    if (participantType === "agent" && participantId) {
      const agent = store.getAgent(participantId);
      if (!agent || !canCurrentUserAccessAgent(c, store, agent)) return c.json({ error: "you do not have access to this agent" }, 403);
    }
    return sessionMutation(c, () => c.json({
      participant: sessionParticipantCompatibilityResponse(store.addSessionParticipant(session.id, body)),
    }, 201));
  });
  app.delete("/api/multiremi/chats/:id/sessions/:sessionId/participants/:participantType/:participantId", (c) => {
    const session = loadWorkSession(c);
    if (session instanceof Response) return session;
    store.removeSessionParticipant(session.id, c.req.param("participantType"), c.req.param("participantId"));
    return c.body(null, 204);
  });


  app.get("/api/multiremi/chats/:id/sessions/:sessionId/results", (c) => {
    const session = loadWorkSession(c);
    if (session instanceof Response) return session;
    return c.json({ results: store.listSessionResults(session.id).map(sessionResultCompatibilityResponse) });
  });
  app.post("/api/multiremi/chats/:id/sessions/:sessionId/results", async (c) => {
    const session = loadWorkSession(c);
    if (session instanceof Response) return session;
    const body = await readJson<PublishSessionResultInput>(c);
    const actor = sessionMutationActor(c);
    return sessionMutation(c, () => c.json({ result: sessionResultCompatibilityResponse(store.publishSessionResult(session.id, {
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
    return c.json({ session, messages: store.listChatMessagesFromLog(session.id) });
  });
  app.patch("/api/multiremi/chats/:id", async (c) => {
    const loaded = loadChatSessionForCurrentUser(c, store, c.req.param("id"));
    if (loaded instanceof Response) return loaded;
    const body = await readJson<UpdateChatSessionInput>(c);
    const invalid = invalidChatUpdate(c, body);
    if (invalid) return invalid;
    return chatMutation(c, () => c.json({ session: store.updateChatSession(loaded.session.id, body) }));
  });
  app.get("/api/chat/sessions", (c) => {
    const workspaceId = requestedChatWorkspaceId(c, store);
    if (workspaceId instanceof Response) return workspaceId;
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const taskToken = currentTaskAccessToken(c);
    const task = taskToken?.taskId ? store.getTask(taskToken.taskId) : null;
    if (taskToken && !task?.chatSessionId) return c.json([]);
    const contentDenied = denyTaskChatContentAccess(c, store, task?.chatSessionId ?? "");
    if (contentDenied) return contentDenied;
    return c.json(listedSessions(c, workspaceId).filter((session) => !task || session.id === task.chatSessionId)
      .map(chatSessionCompatibilityResponse));
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
}

function sessionMutation(c: Context, operation: () => Response): Response {
  try {
    return chatMutation(c, operation);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
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
  if ("projectId" in input || "project_id" in input) return c.json({ error: "A Chat Project can only be selected when creating the session" }, 400);
  if ("issueId" in input || "issue_id" in input) return c.json({ error: "Chat sessions do not support Issue binding" }, 400);
  if (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim())) return c.json({ error: "title is required" }, 400);
  if (input.status !== undefined && input.status !== "active" && input.status !== "archived") return c.json({ error: "invalid status" }, 400);
  if (input.pinned !== undefined && typeof input.pinned !== "boolean") return c.json({ error: "pinned must be a boolean" }, 400);
  return null;
}
