import { isRelatedTurnController } from '../../store/turn-controls.js';
import type { Context, Hono } from "hono";
import { unlink } from "node:fs/promises";
import { MESSAGE_KINDS, TURN_STATUSES, type SendMessageInput, type UnifiedMessage } from "@multiremi/contracts/unified-model.js";
import { CHAT_ATTACHMENT_MAX_BYTES, chatAttachmentValidationError, sanitizeChatAttachmentFilename } from "@multiremi/contracts/attachments.js";
import { compatibilityInboxScope, denyAttachmentAccess, denyCurrentUserWorkspaceAccess, canCurrentUserAccessAgent, currentWorkspaceRole, canCurrentUserAccessChatTask, canTaskCoordinateSession, denySessionAccess } from "../helpers/auth-guards.js";
import { resolveRequestWorkspaceId } from "../helpers/workspace-context.js";
import { loadConversation, messageActor, messageResponse, canAccessConversationTask, conversationEntryVisibility } from "../helpers/conversations.js";
import { persistUploadedAttachments, detectContentTypeFromFilename, safeFilename, uploadedAttachmentPath } from "../helpers/uploads.js";
import { currentAccessToken, currentTaskAccessToken, currentRequestUserId } from "../wire/context.js";
import { parseTraceWindow } from "../trace/request.js";
import type { RouterDeps } from "./deps.js";
import { IssueDecisionError } from "@multiremi/store/repos/issues-repo.js";
import { supervisorTaskIdentity } from "../helpers/organizer.js";
import { denySideSessionAgentDispatch, issueCommentCreateInput, issueMutationActor } from "../helpers/issues.js";
import { OrganizerActionError } from "../../organizer/settings.js";
import { ActiveIssueRunError, ChatIssueTaskConflictError, TaskSessionArchivedError } from "@multiremi/store/repos/tasks-repo.js";
import { IssueDependencyError } from "@multiremi/store/repos/issue-dependencies.js";
import { issueDependencyErrorResponse } from "../wire/issues.js";

class InputError extends Error {}
function number(value: unknown, fallback?: number): number | undefined {
  if (value == null) return fallback;
  if (typeof value !== "number" && typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(String(value))) throw new InputError("invalid sequence or limit");
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new InputError("invalid sequence or limit");
  return result;
}
function limit(c: Context) {
  const n = number(c.req.query("limit"), 100)!;
  if (n < 1 || n > 500) throw new InputError("limit must be between 1 and 500");
  return n;
}
function cursor(c: Context): { created_at: string; id: string } | undefined {
  const raw = c.req.query("cursor");
  if (raw == null) return;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString());
    if (typeof parsed.created_at !== "string" || !Number.isFinite(Date.parse(parsed.created_at))
      || typeof parsed.id !== "string" || !parsed.id) throw new Error();
    return { created_at: parsed.created_at, id: parsed.id };
  } catch { throw new InputError("invalid cursor"); }
}
const encodeCursor = (value: { created_at: string; id: string } | null) => value ? Buffer.from(JSON.stringify(value)).toString("base64url") : null;
async function body(c: Context): Promise<Record<string, any>> {
  try {
    const raw = await c.req.text();
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new InputError("invalid JSON body"); }
}
function boolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new InputError("expected boolean");
  return value;
}
async function action(c: Context, run: () => unknown | Promise<unknown>): Promise<Response> {
  try { const result = await run(); return result instanceof Response ? result : c.json(result); }
  catch (error) {
    if (error instanceof ChatIssueTaskConflictError) return c.json({ error: "forbidden" }, 403);
    if (error instanceof ActiveIssueRunError) return c.json({ error: error.message, code: "active_run_exists" }, 409);
    if (error instanceof TaskSessionArchivedError) return c.json({ error: error.message, code: "session_archived" }, 409);
    if (error instanceof InputError) return c.json({ error: error.message }, 400);
    if (error instanceof IssueDecisionError) return c.json({ error: error.message }, error.status);
    if (error instanceof OrganizerActionError) return c.json({ error: error.message, code: error.code }, error.status);
    if (error instanceof IssueDependencyError) return issueDependencyErrorResponse(c, error)!;
    if (error instanceof Error && /consumed|settled|running turn|retry|terminal|cancelled|pending attempt/i.test(error.message)) return c.json({ error: error.message }, 409);
    if (error instanceof Error && /not found|another workspace|recipient|required|within the log|Reply target|Source turn|Decision requires|attachment/i.test(error.message)) return c.json({ error: error.message }, 400);
    throw error;
  }
}

export function registerUnifiedRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;
  const callerTurn = (c: Context) => {
    const token = currentTaskAccessToken(c);
    if (!token?.taskId) return undefined;
    const turn = store.getTurnForAttempt(token.taskId);
    if (!turn || turn.current_attempt_id !== token.taskId) throw new InputError("source attempt is no longer current");
    return turn.id;
  };
  const publicMessages = (messages: UnifiedMessage[]) => {
    const ids = messages.map(m => m.id);
    const attachments = store.listAttachmentsForMessages(ids);
    const reactions = store.listCommentReactionsForComments(ids);
    return messages.map(message => ({ ...messageResponse(message), attachments: attachments.get(message.id) ?? [], reactions: reactions.get(message.id) ?? [] }));
  };
  const publicMessage = (message: UnifiedMessage) => publicMessages([message])[0]!;
  const loadMessage = (c: Context) => {
    const message = store.getMessage(c.req.param("id")!);
    if (!message || message.visibility !== "shown") return c.json({ error: "message not found" }, 404);
    const conversation = loadConversation(c, store, message.session_id);
    if (conversation instanceof Response) return conversation;
    return conversationEntryVisibility(c, store)(message) ? { message, conversation } : c.json({ error: "message not found" }, 404);
  };
  app.get("/api/sessions/:sessionId/messages", async (c, next) => {
    if (c.req.query("from") != null || c.req.query("to") != null) return next();
    const conversation = loadConversation(c, store, c.req.param("sessionId"));
    if (conversation instanceof Response) return conversation;
    return action(c, () => {
      const n = limit(c), rawCursor = c.req.query("cursor"), after = number(rawCursor ?? c.req.query("after_seq"), 0)!;
      if (rawCursor != null && c.req.query("after_seq") != null) throw new InputError("cursor and after_seq are mutually exclusive");
      const kind = c.req.query("message_kind"), unread = c.req.query("unread_by");
      if (kind && !MESSAGE_KINDS.includes(kind as any)) throw new InputError("invalid message_kind");
      if (unread && store.getAgent(unread)?.workspaceId !== conversation.workspaceId) throw new InputError("invalid unread_by");
      const thread = c.req.query("thread");
      if (thread && store.getMessage(thread)?.session_id !== conversation.id) throw new InputError("invalid thread");
      const visible = conversationEntryVisibility(c, store), rows: UnifiedMessage[] = [];
      let from = after;
      for (;;) {
        const page = store.listMessages(conversation.id, { from, limit: n + 1, thread, unread_by: unread, message_kind: kind });
        rows.push(...page.filter(visible));
        if (page.length < n + 1 || rows.length > n) break;
        from = page.at(-1)!.seq;
      }
      return { messages: publicMessages(rows.slice(0, n)), next_cursor: rows.length > n ? String(rows[n - 1]!.seq) : null };
    });
  });
  app.post("/api/sessions/:sessionId/messages", async (c) => {
    const conversation = loadConversation(c, store, c.req.param("sessionId"), { scope: "owner", allowCoordination: true });
    if (conversation instanceof Response) return conversation;
    if ("workSession" in conversation && conversation.workSession?.status === "archived") return c.json({ error: "Session is archived" }, 409);
    if (conversation.chatId && store.getChatSession(conversation.chatId)?.status === "archived") {
      return c.json({error:"Chat session is archived"},409);
    }
    return action(c, async () => {
      let sender: SendMessageInput['sender'];
      let input: Record<string, any>, files: File[] = [];
      if (c.req.header("Content-Type")?.startsWith("multipart/form-data")) {
        try {
          const form = await c.req.formData();
          input = JSON.parse(String(form.get("message")));
          files = form.getAll("file").map(file => { if (!(file instanceof File)) throw new InputError("invalid file field"); return file; });
        } catch { throw new InputError("invalid multipart message"); }
      } else input = await body(c);
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new InputError("invalid message");
      const author = issueCommentCreateInput(c, input, store, conversation.issueId ?? undefined);
      if (author.authorType === "agent" && author.authorId) sender = { type: "agent", id: author.authorId };
      else if (author.authorType === "member" && author.authorId) {
        const member = store.getWorkspaceMember(author.authorId) ?? store.findWorkspaceMemberForUser(author.authorId, conversation.workspaceId);
        if (!member || member.archivedAt || member.workspaceId !== conversation.workspaceId) throw new InputError("active workspace member required");
        sender = { type: "member", id: member.id };
      } else {
        const actor = messageActor(c, store, conversation.workspaceId);
        if (actor instanceof Response) return actor;
        sender = actor;
      }
      const kind = input.message_kind ?? (input.reply_to_id ? "reply" : "request"), wake = input.wake_requested ?? "now";
      if (!MESSAGE_KINDS.includes(kind) || !["now", "next_turn", "inbox_only"].includes(wake)) throw new InputError("invalid kind or wake");
      if (input.body_md != null && typeof input.body_md !== "string") throw new InputError("body_md must be a string");
      for (const key of ["reply_to_id", "dedupe_key"]) if (input[key] != null && (typeof input[key] !== "string" || !input[key].trim())) throw new InputError(`invalid ${key}`);
      const to = input.to ?? { type: "none" };
      if (!to || !["none", "agent", "member", "role"].includes(to.type)
        || to.type !== "none" && (typeof to.ref !== "string" || !to.ref.trim())
        || to.type === "role" && !["leader", "parent_owner", "delegator", "issue_owner", "relay"].includes(to.ref)) throw new InputError("invalid recipient");
      if (to.type === "agent" || to.type === "member") {
        const target = to.type === "agent" ? store.getAgent(to.ref) : store.getWorkspaceMember(to.ref);
        if (!target || target.workspaceId !== conversation.workspaceId) throw new InputError("recipient not found");
      }
      const dispatch = kind === "request" && (to.type === "agent" || to.type === "role");
      const coordinating = "coordinating" in conversation && conversation.coordinating;
      if (coordinating && (!dispatch || input.reply_to_id || input.options || input.attachment_ids?.length || files.length)) {
        return c.json({ error: "Topic coordination does not grant Session content access" }, 403);
      }
      if (currentTaskAccessToken(c) && !("workSession" in conversation) && !conversation.chatId) {
        const content = loadConversation(c, store, conversation.id);
        if (content instanceof Response) return content;
      }
      if (dispatch && "workSession" in conversation && conversation.workSession) {
        const token = currentTaskAccessToken(c);
        const source = token?.taskId ? store.getTask(token.taskId) : null;
        if (source?.chatSessionId && !source.issueSessionId
          && store.getTaskChatExecutionKind(source) === "topic" && !coordinating) {
          return c.json({ error: "Topic coordination is limited to its bound Issue and Chat" }, 403);
        }
      }
      if (dispatch) {
        const dispatchDenied = denySideSessionAgentDispatch(c, store);
        if (dispatchDenied) return dispatchDenied;
      } else {
        const content = loadConversation(c, store, conversation.id);
        if (content instanceof Response) return content;
      }
      const options = input.options;
      if (options != null && (kind !== "decision" || !Array.isArray(options) || options.some((o: any) => !o || typeof o.label !== "string" || !o.label.trim() || typeof o.value !== "string" || !o.value.trim()))) throw new InputError("invalid decision options");
      const selected = input.metadata?.selected_options;
      if (selected != null && (!Array.isArray(selected) || selected.some((s: unknown) => typeof s !== "string"))) throw new InputError("invalid selected_options");
      if (input.response != null && (typeof input.response !== "object" || Array.isArray(input.response))) throw new InputError("invalid decision response");
      const text = input.body_md ?? "";
      if (!text.trim() && !files.length && !selected?.length && !input.response && !input.attachment_ids?.length) throw new InputError("message content is required");
      const reply = input.reply_to_id ? store.getMessage(input.reply_to_id) : null;
      if (input.reply_to_id && (!reply || reply.session_id !== conversation.id || reply.deleted_at)) throw new InputError("invalid reply target");
      if (reply && !conversationEntryVisibility(c, store)(reply)) return c.json({ error: "message not found" }, 404);
      if (input.response != null && (reply?.message_kind !== "decision" || kind !== "reply")) throw new InputError("response requires a decision reply");
      if (selected?.length && (!reply || reply.message_kind !== "decision" || reply.options && selected.some((s: string) => !reply.options!.some(o => o.value === s)))) throw new InputError("invalid selected option");
      if (reply?.message_kind === "decision" && kind === "reply") {
        if (files.length || input.attachment_ids?.length) throw new InputError("decision answers cannot include attachments");
        const result = store.answerMessageDecision(reply.id, { sender, body_md: text || selected?.join("\n") || JSON.stringify(input.response), source_turn_id: callerTurn(c),
          response: input.response ?? (selected?.length ? { selected_options: selected, answer: text || selected.join("\n") } : undefined) });
        return { ...result, message: publicMessage(result.message) };
      }
      const attachmentIds = input.attachment_ids ?? [];
      if (!Array.isArray(attachmentIds) || attachmentIds.some((id: unknown) => typeof id !== "string")) throw new InputError("invalid attachment_ids");
      for (const id of attachmentIds) {
        const attachment = store.getAttachment(id);
        if (!attachment || attachment.workspaceId !== conversation.workspaceId || denyAttachmentAccess(c, store, attachment)) throw new InputError("attachment not found");
      }
      if (files.length + attachmentIds.length > 10) throw new InputError("at most 10 attachments are allowed per message");
      for (const [index, file] of files.entries()) {
        const filename = file.name || `file #${index + 1}`;
        const error = chatAttachmentValidationError(filename, file.size);
        if (error) {
          if (file.size > CHAT_ATTACHMENT_MAX_BYTES) return c.json({ error }, 413);
          throw new InputError(error);
        }
      }
      const sendInput: SendMessageInput = { session_id: conversation.id, sender, to, body_md: text, message_kind: kind, wake_requested: wake,
        reply_to_id: input.reply_to_id, dedupe_key: input.dedupe_key, options, attachment_ids: attachmentIds, source_turn_id: callerTurn(c) };
      const unusedUploads: Array<{ workspaceId: string; id: string; filename: string }> = [];
      const authorizeRecipient = (agent: Parameters<typeof canCurrentUserAccessAgent>[2]) => {
        if (!canCurrentUserAccessAgent(c, store, agent)) throw new IssueDecisionError(403, "you do not have access to this agent");
      };
      let returningToDelegator = false;
      const delegatedReturn = (sessionId: string, targetAgent: NonNullable<ReturnType<typeof store.getAgent>> | null) => {
        const token = currentTaskAccessToken(c);
        if (!token?.taskId || !targetAgent || targetAgent.archivedAt || to.type !== "role" || to.ref !== "delegator"
          || !["reply", "report"].includes(kind) || input.options || input.attachment_ids?.length || files.length) return null;
        const current = store.getTurnForAttempt(token.taskId);
        const sourceTask = store.getTask(token.taskId);
        const trigger = current?.trigger_message_id ? store.getMessage(current.trigger_message_id) : null;
        const origin = trigger?.task_id ? store.getTurn(trigger.task_id) : null;
        if (!current?.delegation_id || current.current_attempt_id !== token.taskId || current.session_id !== conversation.id
          || !["running", "awaiting_human"].includes(current.status)
          || !sourceTask || !["running", "awaiting_human"].includes(sourceTask.status)
          || current.delegated_by_agent_id !== targetAgent.id || current.workspace_id !== conversation.workspaceId
          || !trigger || trigger.deleted_at || trigger.session_id !== current.session_id
          || trigger.sender_type !== "agent" || trigger.sender_id !== targetAgent.id
          || !origin || origin.agent_id !== targetAgent.id || origin.workspace_id !== current.workspace_id
          || origin.session_id !== sessionId || current.delegated_from_issue_session_id !== sessionId
          || input.reply_to_id && input.reply_to_id !== trigger.id) return null;
        const scope = store.getIssueSessionWithOwnerScope(sessionId);
        if (!scope || scope.ownerWorkspaceId !== current.workspace_id || scope.session.workspaceId !== current.workspace_id
          || origin.chat_session_id && scope.session.chatId !== origin.chat_session_id
          || !scope.session.chatId && scope.session.issueId !== origin.issue_id) return null;
        return { id: sessionId, workspaceId: scope.session.workspaceId, issueId: scope.session.issueId,
          chatId: scope.session.chatId, workSession: scope.session };
      };
      const send = (uploads: Parameters<typeof store.sendMessage>[1] = []) => {
        try { return store.sendMessage(sendInput, uploads, authorizeRecipient, (sessionId, targetAgent) => {
          const dispatchAllowed = dispatch && targetAgent != null && !targetAgent.archivedAt;
          const returnTarget = delegatedReturn(sessionId, targetAgent);
          const target = returnTarget ?? loadConversation(c, store, sessionId, { scope: dispatchAllowed ? "owner" : "content", allowCoordination: dispatchAllowed });
          returningToDelegator = returnTarget != null && sessionId !== conversation.id;
          if (!(target instanceof Response) && currentTaskAccessToken(c)
            && !("workSession" in target) && !target.chatId) {
            const content = loadConversation(c, store, sessionId);
            if (content instanceof Response) throw new IssueDecisionError(content.status === 404 ? 404 : 403, "conversation not available");
          }
          if (target instanceof Response) throw new IssueDecisionError(target.status === 404 ? 404 : 403, "conversation not available");
          if ("workSession" in target && target.workSession?.status === "archived"
            || target.chatId && store.getChatSession(target.chatId)?.status === "archived") {
            throw new IssueDecisionError(409, "Session is archived");
          }
          if (coordinating && (!("workSession" in target) || !target.workSession
            || !canTaskCoordinateSession(c, store, target.workSession))) {
            throw new IssueDecisionError(403, "Topic coordination is limited to its bound Issue and Chat");
          }
        }); }
        catch(error){
          if(error instanceof IssueDependencyError || error instanceof IssueDecisionError) throw error;
          throw new InputError(error instanceof Error ? error.message : 'Message write failed');
        }
      };
      const result = files.length ? await persistUploadedAttachments(conversation.workspaceId, files.map(file => ({ filename: conversation.chatId ? sanitizeChatAttachmentFilename(file.name) : safeFilename(file.name),
        bytes: async () => new Uint8Array(await file.arrayBuffer()), contentType: file.type.split(";")[0] || detectContentTypeFromFilename(file.name) })),
        uploads => {
          const sent = send(uploads.map(upload => ({ ...upload, uploaderType: sender.type, uploaderId: sender.id })));
          for (const upload of uploads) if (!store.getAttachment(upload.id!)) unusedUploads.push({ workspaceId: conversation.workspaceId, id: upload.id!, filename: upload.filename });
          return sent;
        }) : send();
      await Promise.all(unusedUploads.map(upload => unlink(uploadedAttachmentPath(upload))));
      return { ...result, message: coordinating || returningToDelegator ? coordinatedMessage(result.message) : publicMessage(result.message) };
    });
  });
  app.get("/api/messages/:id", c => {
    const loaded = loadMessage(c);
    return loaded instanceof Response ? loaded : c.json({ message: publicMessage(loaded.message) });
  });
  for (const method of ["PATCH", "DELETE"] as const) app.on(method, "/api/messages/:id", async c => {
    const loaded = loadMessage(c);
    if (loaded instanceof Response) return loaded;
    const actor = messageActor(c, store, loaded.conversation.workspaceId);
    if (actor instanceof Response) return actor;
    if (actor.type !== loaded.message.sender_type || actor.id !== loaded.message.sender_id) return c.json({ error: "only the sender may edit or delete" }, 403);
    return action(c, async () => {
      if (method === "DELETE") return { message: publicMessage(store.deleteMessage(loaded.message.id)) };
      const input = await body(c);
      if (typeof input.body_md !== "string" || !input.body_md.trim()) throw new InputError("body_md is required");
      return { message: publicMessage(store.editMessage(loaded.message.id, { body_md: input.body_md })) };
    });
  });
  for (const operation of ["resolve", "reactions"] as const) app.post(`/api/messages/:id/${operation}`, async c => {
    const loaded = loadMessage(c);
    if (loaded instanceof Response) return loaded;
    return action(c, async () => {
      const input = await body(c);
      const mutation = issueMutationActor(c, input);
      const actor = { type: mutation.actorType, id: mutation.actorId };
      if (operation === "resolve") return { message: publicMessage(store.resolveMessage(loaded.message.id, actor, boolean(input.resolved, true))) };
      if (typeof input.emoji !== "string" || !input.emoji.trim() || input.emoji.length > 64) throw new InputError("emoji is required");
      store.reactMessage(loaded.message.id, { emoji: input.emoji, actorType: actor.type, actorId: actor.id!, remove: boolean(input.remove, false) });
      return { reactions: store.listCommentReactionsForComments([loaded.message.id]).get(loaded.message.id) ?? [] };
    });
  });

  const inboxScope = (c: Context) => {
    const token = currentTaskAccessToken(c);
    if (!token) { const scope = compatibilityInboxScope(c, store); return scope instanceof Response ? scope : { ...scope, type: "member" as const, readerId: scope.memberId }; }
    const workspaceId = resolveRequestWorkspaceId(c, store);
    if (workspaceId instanceof Response) return workspaceId;
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const actor = messageActor(c, store, workspaceId);
    return actor instanceof Response ? actor : { workspaceId, type: "agent" as const, readerId: actor.id! };
  };
  app.get("/api/inbox", c => {
    const scope = inboxScope(c);
    if (scope instanceof Response) return scope;
    return action(c, () => {
      const role=currentWorkspaceRole(c,store,scope.workspaceId);
      const options = { limit: limit(c), cursor: cursor(c), access: {
        userId: currentRequestUserId(c), admin: role==='owner'||role==='admin',
        attemptId: currentTaskAccessToken(c)?.taskId ?? undefined,
      } };
      const page = store.listReaderMessageInbox(scope.type,scope.readerId,scope.workspaceId,options);
      return { ...page, items: publicMessages(page.items), next_cursor: encodeCursor(page.next_cursor) };
    });
  });
  app.post("/api/inbox/read", async c => {
    const scope = inboxScope(c);
    if (scope instanceof Response) return scope;
    return action(c, async () => {
      const input = await body(c);
      if (boolean(input.all, false)) {
        if (input.session_id != null || input.to_seq != null) throw new InputError("all cannot be combined with session_id or to_seq");
        const visible = (id: string) => !(loadConversation(c, store, id) instanceof Response);
        const visibleMessage = conversationEntryVisibility(c, store);
        return { conversations_read: scope.type === "member" ? store.readAllMessageInbox(scope.readerId, scope.workspaceId, visible, visibleMessage) : store.readAgentMessageInbox(scope.readerId, scope.workspaceId, undefined, undefined, visible, visibleMessage) };
      }
      if (typeof input.session_id !== "string") throw new InputError("session_id is required");
      const conversation = loadConversation(c, store, input.session_id);
      if (conversation instanceof Response) return conversation;
      if (conversation.workspaceId !== scope.workspaceId) throw new InputError("conversation not found");
      const seq = number(input.to_seq);
      const visibleMessage = conversationEntryVisibility(c, store);
      return { session_id: input.session_id, cursor_seq: scope.type === "member" ? store.readMessageInbox(scope.readerId, input.session_id, seq, visibleMessage) : store.readAgentMessageInbox(scope.readerId, scope.workspaceId, input.session_id, seq, undefined, visibleMessage) };
    });
  });

  const coordinatedMessage = (message: UnifiedMessage) => ({
    id: message.id, session_id: message.session_id, seq: message.seq,
    message_kind: message.message_kind, created_at: message.created_at,
  });
  const coordinatedTurn = (c: Context, turn: { session_id: string }) => {
    if (!currentTaskAccessToken(c)) return false;
    const session = store.getIssueSession(turn.session_id);
    return Boolean(session && canTaskCoordinateSession(c, store, session) && denySessionAccess(c, store, session));
  };
  const turnMetadata = (turn: ReturnType<typeof store.getTurn> & {}) => ({
    id: turn.id, session_id: turn.session_id, seq: turn.seq, agent_id: turn.agent_id,
    status: turn.status, current_attempt_id: turn.current_attempt_id,
    issue_id: turn.issue_id, workspace_id: turn.workspace_id,
    created_at: turn.created_at, started_at: turn.started_at, ended_at: turn.ended_at,
  });
  const loadTurn = (c: Context) => {
    const turn = store.getTurn(c.req.param("id")!);
    if (!turn) return c.json({ error: "turn not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, turn.workspace_id);
    if (denied) return denied;
    const task = turn.current_attempt_id ? store.getTask(turn.current_attempt_id) : null;
    const actualSession = store.getIssueSession(turn.session_id);
    const chatOwnerId = actualSession?.chatId ?? turn.chat_session_id ?? task?.chatSessionId;
    if (chatOwnerId && !store.getChatSession(chatOwnerId)) return c.json({ error: "forbidden" }, 403);
    // Historical tasks without an Issue or Chat still have a migrated turn.
    // Their workspace and source task are the read authority.
    const coordinating = coordinatedTurn(c, turn);
    const token = currentTaskAccessToken(c);
    if (chatOwnerId && token && turn.current_attempt_id !== token.taskId && !coordinating) return c.json({ error: "forbidden" }, 403);
    if (actualSession || turn.issue_id || chatOwnerId) {
      const conversation = loadConversation(c, store, turn.session_id, { scope: "owner", allowCoordination: true });
      if (conversation instanceof Response) return conversation;
    }
    if (task && !canCurrentUserAccessChatTask(c, store, task) && !coordinating) return c.json({ error: "forbidden" }, 403);
    // Ordinary Issue turn metadata stays readable. A private decision's turn
    // follows the decision's visibility, including its pending question state.
    if (turn.waiting_on_message_id && !coordinating) {
      const decision = store.getMessage(turn.waiting_on_message_id);
      if (!decision || !conversationEntryVisibility(c, store)(decision)) return c.json({ error: "turn not found" }, 404);
    }
    return turn;
  };
  app.get("/api/turns", c => {
    const workspaceId = resolveRequestWorkspaceId(c, store, c.req.query("workspace_id"));
    if (workspaceId instanceof Response) return workspaceId;
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    return action(c, () => {
      const n = limit(c), status = c.req.query("status"), issueRef = c.req.query("issue"), issue = issueRef ? store.getIssueByRef(issueRef) : null;
      if (issueRef && (!issue || issue.workspaceId !== workspaceId)) throw new InputError("issue not found");
      if (status && !TURN_STATUSES.includes(status as any)) throw new InputError("invalid status");
      const sessionId = c.req.query("session_id") ?? c.req.query("chat");
      if (sessionId && loadConversation(c, store, sessionId, { scope: "owner", allowCoordination: true }) instanceof Response) throw new InputError("conversation not found");
      const coordinatingSessionId = sessionId && coordinatedTurn(c, { session_id: sessionId }) ? sessionId : undefined;
      const role = currentWorkspaceRole(c, store, workspaceId);
      const turns = store.listTurns({ workspace_id: workspaceId, issue_id: issue?.id, session_id: sessionId,
        agent_id: c.req.query("agent"), status, limit: n + 1, cursor: cursor(c), visibility: {
          userId: currentRequestUserId(c), admin: role === "owner" || role === "admin", coordinatingSessionId, attemptId: currentTaskAccessToken(c)?.taskId ?? undefined,
        } });
      return { turns: turns.slice(0, n).map(turn => coordinatingSessionId ? turnMetadata(turn) : turn), next_cursor: turns.length > n ? encodeCursor(turns[n - 1]!) : null };
    });
  });
  app.get("/api/turns/:id", c => {
    const turn = loadTurn(c);
    if (turn instanceof Response) return turn;
    return action(c, () => {
      for (const key of ["input", "attempts"]) if (c.req.query(key) != null && !["true", "false"].includes(c.req.query(key)!)) throw new InputError(`invalid ${key}`);
      const source = turn.current_attempt_id ? store.getTask(turn.current_attempt_id) : null;
      const coordinating = coordinatedTurn(c, turn);
      if (coordinating && (c.req.query("input") === "true" || c.req.query("attempts") === "true")) return c.json({ error: "forbidden" }, 403);
      if (c.req.query("input") === "true") {
        if (!source || !canAccessConversationTask(c, store, source)) return c.json({ error: "forbidden" }, 403);
        // Native tasks without an owner have a persisted orphan conversation,
        // rather than an Issue, Chat or configured autopilot Session.
        const nativeOrphan = turn.session_id.startsWith("auto_orphan_")
          && !turn.session_id.startsWith("auto_orphan_inbox_")
          && !turn.issue_id && !turn.chat_session_id
          && !source.issueId && !source.issueSessionId && !source.chatSessionId
          && source.workspaceId === turn.workspace_id
          && !store.getIssueSession(turn.session_id) && !store.getChatSession(turn.session_id)
          && Boolean(store.getConversationLogHead(turn.session_id));
        if (nativeOrphan) {
          const token = currentTaskAccessToken(c);
          const current = token?.taskId ? store.getTurnForAttempt(token.taskId) : null;
          if (token && current?.session_id !== turn.session_id) return c.json({ error: "forbidden outside current Session" }, 403);
        } else {
          const content = loadConversation(c, store, turn.session_id);
          if (content instanceof Response) return content;
        }
      }
      const input = c.req.query("input") === "true" ? store.getTurnInput(turn.id) : null;
      return { turn: coordinating || !source ? turnMetadata(turn) : turn, ...(input ? { input: { ...input, messages: publicMessages(input.messages.filter(conversationEntryVisibility(c, store))) } } : {}),
        ...(c.req.query("attempts") === "true" ? { attempts: store.listTurnAttempts(turn.id) } : {}) };
    });
  });
  for (const operation of ["cancel", "wrap-up", "retry"] as const) app.post(`/api/turns/:id/${operation}`, async c => {
    const turn = loadTurn(c);
    if (turn instanceof Response) return turn;
    const token = currentTaskAccessToken(c);
    const supervisor = supervisorTaskIdentity(c, store);
    const target = turn.current_attempt_id ? store.getTask(turn.current_attempt_id) : null;
    if (target && !canAccessConversationTask(c,store,target)) return c.json({error:"turn not found"},404);
    const related = !!token?.agentId && !!target && isRelatedTurnController(store, token.agentId, target);
    if (operation === "retry") {
      if (currentAccessToken(c)?.type === "daemon") return c.json({ error: "member or controller task credential required" }, 403);
      if (token && !supervisor && !related) return c.json({ error: "supervisor or related controller task credential required", code: "organizer_supervisor_required" }, 403);
      const controller = supervisor?.task ?? (token?.taskId ? store.getTask(token.taskId) : null);
      const sourceSession = controller?.issueSessionId ? store.getIssueSession(controller.issueSessionId) : null;
      if (sourceSession && sourceSession.inheritMode !== "none") return c.json({ error: "Agent delegation is not allowed from side sessions" }, 403);
    } else if (token && token.agentId !== turn.agent_id && !supervisor && !related) {
      return c.json({ error: "only this turn's agent or its supervisor may control it" }, 403);
    }
    return action(c, async () => {
      const input = await body(c);
      if (operation === "retry") {
        const cold = boolean(input.cold, false);
        if (!turn.current_attempt_id) throw new InputError("attempt not found");
        if (!token) {
          if (Object.keys(input).some(key => !["cold", "reason"].includes(key))) throw new InputError("retry accepts only cold and reason");
          if (input.reason != null && (typeof input.reason !== "string" || input.reason.length > 2_000)) throw new InputError("invalid retry reason");
          return { turn: store.retryTurnAsMember(turn.id, cold, sessionId => {
            const conversation = loadConversation(c, store, sessionId, { scope: "owner" });
            if (conversation instanceof Response) throw new IssueDecisionError(conversation.status === 404 ? 404 : 403, "conversation not available");
            const current = store.getTurn(turn.id);
            const source = current?.current_attempt_id ? store.getTask(current.current_attempt_id) : null;
            if (!source || !canAccessConversationTask(c, store, source)) throw new IssueDecisionError(403, "forbidden");
          }) };
        }
        const result = store.performOrganizerAction({ supervisorTaskId: supervisor?.task.id ?? token!.taskId!, supervisorAgentId: supervisor?.agentId ?? token!.agentId!,
          targetTaskId: turn.current_attempt_id, action: "redispatch", reason: input.reason ?? "Retry requested through turn API", cold });
        return { turn: store.getTurn(turn.id), organizer_action: result.audit, comment_id: result.comment.id };
      }
      return { turn: operation === "cancel" ? store.cancelTurn(turn.id) : store.wrapUpTurn(turn.id) };
    });
  });
  app.get("/api/turns/:id/trace", async c => {
    const turn = loadTurn(c);
    if (turn instanceof Response) return turn;
    const source = turn.current_attempt_id ? store.getTask(turn.current_attempt_id) : null;
    if (source && !canAccessConversationTask(c, store, source)) return c.json({error:"turn not found"},404);
    const window = parseTraceWindow(c);
    if (!window) return c.json({ error: "invalid trace window" }, 400);
    const attemptId = c.req.query("attempt_id") ?? turn.current_attempt_id;
    if (!attemptId || !store.listTurnAttempts(turn.id).some(a => a.id === attemptId)) return c.json({ error: "attempt not found" }, 404);
    const selected = store.getTask(attemptId);
    if (!selected) return c.json({ error: "attempt not found" }, 404);
    const token = currentTaskAccessToken(c);
    // A live private Turn capability also covers its own persisted attempts.
    // It never grants another Turn or a changed owner/agent audit source.
    const ownHistory = Boolean(token && source && turn.current_attempt_id === token.taskId
      && selected.workspaceId === source.workspaceId && selected.agentId === source.agentId
      && selected.issueSessionId === source.issueSessionId && selected.chatSessionId === source.chatSessionId
      && store.getTurnForAttempt(selected.id)?.id === turn.id);
    if (!ownHistory && !canAccessConversationTask(c, store, selected)) return c.json({ error: "turn not found" }, 404);
    return c.json({ turn_id: turn.id, attempt_id: attemptId, ...await deps.traceReader.readTrace(attemptId, window.afterSeq, window.limit) });
  });
}
