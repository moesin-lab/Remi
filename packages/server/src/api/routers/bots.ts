import type { Context, Hono } from "hono";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BotSessionControlInput, SaveBotInput, SubmitBotMessageInput } from "@multiremi/contracts/bots.js";
import { BotError } from "@multiremi/bots/errors.js";
import { FeishuBotEncryptionError } from "@multiremi/feishu-bot/credentials.js";
import { normalizeFeishuBotErrorCode, redactFeishuBotError } from "@multiremi/feishu-bot/diagnostics.js";
import {
  MAX_UPLOAD_SIZE,
  createUploadAttachmentId,
  denyCurrentUserWorkspaceAccess,
  denyDaemonTokenRuntimeIdentity,
  detectContentTypeFromFilename,
  isJsonApiError,
  readJsonStrict,
  requireHumanWorkspaceAdmin,
  safeFilename,
  uploadAbsolutePath,
  uploadRelativePath,
} from "../helpers.js";
import { cleanString, currentAccessToken } from "../wire/index.js";
import { daemonBotAgentResponse } from "../wire/agents.js";
import type { RouterDeps } from "./deps.js";

type JsonBody = Record<string, unknown>;

async function readBody(c: Context): Promise<JsonBody> {
  const body = await readJsonStrict<unknown>(c);
  if (isJsonApiError(body)) throw new BotError(body.apiError, body.statusCode, "invalid_body");
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BotError("request body must be an object", 400, "invalid_body");
  }
  return body as JsonBody;
}

function botHandler(handler: (c: Context) => Response | Promise<Response>) {
  return async (c: Context): Promise<Response> => {
    c.header("Cache-Control", "no-store");
    try {
      return await handler(c);
    } catch (error) {
      if (error instanceof BotError) {
        return c.json({ error: error.message, code: error.code }, error.status as 400 | 403 | 404 | 409 | 503);
      }
      if (error instanceof FeishuBotEncryptionError) {
        return c.json({ error: error.message, code: error.code }, 503);
      }
      throw error;
    }
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? cleanString(value) : null;
}

function revisionValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new BotError("revision must be a non-negative integer", 400, "invalid_revision");
  }
  return value;
}

function sessionControlInput(body: JsonBody): BotSessionControlInput {
  const externalSessionKey = stringValue(body.external_session_key);
  if (!externalSessionKey) throw new BotError("external_session_key is required", 400, "invalid_session");
  return {
    revision: revisionValue(body.revision),
    externalSessionKey,
    chatSessionId: stringValue(body.chat_session_id) ?? undefined,
    replyToMessageId: stringValue(body.reply_to_message_id) ?? undefined,
  };
}

/** Bot owns its platforms, routes and senders; the legacy integration stays separate. */
export function registerBotRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;

  function workspaceAccess(c: Context, workspaceId: string | null, write = false): Response | null {
    if (!workspaceId) return c.json({ error: "workspace_id is required", code: "workspace_required" }, 400);
    // A share URL is an Issue-specific credential, never a Bot management credential.
    if (c.req.header("X-Remi-Share")) return c.json({ error: "forbidden for share credential" }, 403);
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    if (!store.getWorkspace(workspaceId)) return c.json({ error: "workspace not found" }, 404);
    return write ? requireHumanWorkspaceAdmin(c, store, workspaceId) : null;
  }

  function loadBot(c: Context, workspaceId: string | null, write = false) {
    const bot = store.getBot(c.req.param("id")!);
    if (!bot || (workspaceId !== null && bot.workspace_id !== workspaceId)) return c.json({ error: "bot not found", code: "bot_not_found" }, 404);
    const denied = workspaceAccess(c, bot.workspace_id, write);
    if (denied) return denied;
    return bot;
  }

  function daemonAccess(c: Context): Response | null {
    if (currentAccessToken(c)?.type !== "daemon") {
      return c.json({ error: "daemon token required", code: "daemon_token_required" }, 403);
    }
    return denyDaemonTokenRuntimeIdentity(c, store, c.req.param("runtimeId")!);
  }

  app.get("/api/bots", botHandler((c) => {
    const workspaceId = stringValue(c.req.query("workspace_id"));
    const denied = workspaceAccess(c, workspaceId);
    if (denied) return denied;
    return c.json({ bots: store.listBots(workspaceId!) });
  }));

  app.post("/api/bots", botHandler(async (c) => {
    const body = await readBody(c);
    const denied = workspaceAccess(c, stringValue(body.workspace_id), true);
    if (denied) return denied;
    return c.json(store.createBot(body as unknown as SaveBotInput), 201);
  }));

  app.get("/api/bots/:id", botHandler((c) => {
    const bot = loadBot(c, stringValue(c.req.query("workspace_id")));
    return bot instanceof Response ? bot : c.json(bot);
  }));

  app.put("/api/bots/:id", botHandler(async (c) => {
    const body = await readBody(c);
    if (!stringValue(body.workspace_id)) return c.json({ error: "workspace_id is required", code: "workspace_required" }, 400);
    const bot = loadBot(c, stringValue(body.workspace_id), true);
    if (bot instanceof Response) return bot;
    return c.json(store.updateBot(bot.id, body as unknown as SaveBotInput));
  }));

  app.delete("/api/bots/:id", botHandler((c) => {
    const bot = loadBot(c, stringValue(c.req.query("workspace_id")), true);
    if (bot instanceof Response) return bot;
    store.deleteBot(bot.id);
    return c.json({ deleted: true });
  }));

  app.get("/api/bots/:id/senders", botHandler((c) => {
    const bot = loadBot(c, stringValue(c.req.query("workspace_id")));
    return bot instanceof Response ? bot : c.json({ senders: store.listBotSenders(bot.id) });
  }));

  app.put("/api/bots/:id/senders/:senderId", botHandler(async (c) => {
    const bot = loadBot(c, stringValue(c.req.query("workspace_id")), true);
    if (bot instanceof Response) return bot;
    const body = await readBody(c);
    if (typeof body.allowed !== "boolean" || Object.keys(body).some((key) => key !== "allowed")) {
      return c.json({ error: "allowed must be a boolean", code: "invalid_body" }, 400);
    }
    return c.json(store.setBotSenderAllowed(bot.id, c.req.param("senderId")!, body.allowed));
  }));

  app.get("/api/bots/:id/sessions", botHandler((c) => {
    const bot = loadBot(c, stringValue(c.req.query("workspace_id")));
    return bot instanceof Response ? bot : c.json({ sessions: store.listBotSessions(bot.id) });
  }));

  app.get("/api/daemon/runtimes/:runtimeId/bots", botHandler((c) => {
    const denied = daemonAccess(c);
    if (denied) return denied;
    return c.json({ directives: store.botDirectivesForRuntime(c.req.param("runtimeId")!) });
  }));

  app.get("/api/daemon/runtimes/:runtimeId/bots/:botId/platforms/:bindingId", botHandler((c) => {
    const denied = daemonAccess(c);
    if (denied) return denied;
    const assignment = store.getBotDaemonAssignment(c.req.param("botId")!, c.req.param("bindingId")!, c.req.param("runtimeId")!);
    if (!assignment) return c.json({ error: "bot platform is not assigned to this runtime", code: "binding_not_found" }, 404);
    const agent = store.getAgent(assignment.agent_id);
    if (!agent || agent.workspaceId !== assignment.workspace_id || agent.archivedAt) {
      return c.json({ error: "bot agent is unavailable", code: "agent_unavailable" }, 409);
    }
    return c.json({ ...assignment, bot_agent: daemonBotAgentResponse(agent), bot_name: store.getBot(assignment.bot_id)?.name });
  }));

  app.post("/api/daemon/runtimes/:runtimeId/bots/:botId/platforms/:bindingId/status", botHandler(async (c) => {
    const denied = daemonAccess(c);
    if (denied) return denied;
    const body = await readBody(c);
    const state = body.state;
    if (state !== "stopped" && state !== "starting" && state !== "online" && state !== "failed") {
      return c.json({ error: "invalid bot runtime state", code: "invalid_state" }, 400);
    }
    const botId = c.req.param("botId")!;
    const bindingId = c.req.param("bindingId")!;
    const runtimeId = c.req.param("runtimeId")!;
    store.reportBotRuntimeStatus(botId, bindingId, runtimeId, {
      appliedRevision: revisionValue(body.applied_revision), state,
      botName: stringValue(body.bot_name),
      botOpenId: stringValue(body.bot_open_id),
      errorCode: normalizeFeishuBotErrorCode(body.error_code),
      errorMessage: typeof body.error_message === "string" ? redactFeishuBotError(body.error_message) : null,
    });
    return c.json({ status: "ok", directive: store.botDirectivesForRuntime(runtimeId)
      .find((directive) => directive.bot_id === botId && directive.platform_binding_id === bindingId) ?? null });
  }));

  app.post("/api/daemon/runtimes/:runtimeId/bots/:botId/platforms/:bindingId/messages", botHandler(async (c) => {
    const denied = daemonAccess(c);
    if (denied) return denied;
    const body = await readBody(c);
    if (body.chat_type !== undefined && body.chat_type !== "p2p" && body.chat_type !== "group") {
      return c.json({ error: "invalid chat_type", code: "invalid_body" }, 400);
    }
    if (body.attachment_ids !== undefined && (!Array.isArray(body.attachment_ids)
      || body.attachment_ids.some((id) => !stringValue(id)))) {
      return c.json({ error: "attachment_ids must be an array of non-empty strings", code: "invalid_body" }, 400);
    }
    const input: SubmitBotMessageInput = {
      revision: revisionValue(body.revision),
      externalSessionKey: stringValue(body.external_session_key) ?? "",
      externalMessageId: stringValue(body.external_message_id) ?? "",
      replyToMessageId: stringValue(body.reply_to_message_id),
      parentMessageId: stringValue(body.parent_message_id),
      senderOpenId: stringValue(body.sender_open_id),
      senderUserId: stringValue(body.sender_user_id),
      senderUnionId: stringValue(body.sender_union_id),
      senderTenantKey: stringValue(body.sender_tenant_key),
      senderName: stringValue(body.sender_name),
      chatId: stringValue(body.chat_id),
      threadId: stringValue(body.thread_id),
      text: typeof body.text === "string" ? body.text : "",
      chatType: body.chat_type as SubmitBotMessageInput["chatType"],
      command: stringValue(body.command),
      target: body.target as SubmitBotMessageInput["target"],
      attachmentIds: body.attachment_ids as string[] | undefined,
    };
    return c.json(store.submitBotMessage(c.req.param("botId")!, c.req.param("bindingId")!, c.req.param("runtimeId")!, input), 202);
  }));

  app.post("/api/daemon/runtimes/:runtimeId/bots/:botId/platforms/:bindingId/attachments", botHandler(async (c) => {
    const denied = daemonAccess(c);
    if (denied) return denied;
    const botId = c.req.param("botId")!;
    const assignment = store.getBotDaemonAssignment(botId, c.req.param("bindingId")!, c.req.param("runtimeId")!);
    if (!assignment) return c.json({ error: "bot platform is not assigned to this runtime", code: "binding_not_found" }, 404);
    let form: FormData;
    try { form = await c.req.formData(); }
    catch { return c.json({ error: "invalid multipart body", code: "invalid_body" }, 400); }
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "missing file field", code: "invalid_body" }, 400);
    if (file.size > MAX_UPLOAD_SIZE) return c.json({ error: "file too large" }, 413);
    const attachmentId = createUploadAttachmentId();
    const filename = safeFilename(file.name || "upload.bin");
    const absolutePath = uploadAbsolutePath(uploadRelativePath(assignment.workspace_id, attachmentId, filename));
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, new Uint8Array(await file.arrayBuffer()));
    try {
      store.createAttachment({
        id: attachmentId, workspaceId: assignment.workspace_id,
        uploaderType: "bot", uploaderId: botId,
        filename, url: `/api/attachments/${attachmentId}/content`,
        contentType: file.type || detectContentTypeFromFilename(filename), sizeBytes: file.size,
      });
    } catch (error) {
      await unlink(absolutePath).catch(() => undefined);
      throw error;
    }
    return c.json({ attachment_id: attachmentId }, 201);
  }));

  app.post("/api/daemon/runtimes/:runtimeId/bots/:botId/platforms/:bindingId/tasks/:taskId/replies", botHandler(async (c) => {
    const denied = daemonAccess(c);
    if (denied) return denied;
    const body = await readBody(c);
    const externalMessageId = stringValue(body.external_message_id);
    if (!externalMessageId) return c.json({ error: "external_message_id is required", code: "invalid_body" }, 400);
    store.recordBotReply(c.req.param("botId")!, c.req.param("bindingId")!, c.req.param("runtimeId")!, c.req.param("taskId")!, externalMessageId);
    return c.json({ recorded: true });
  }));

  app.post("/api/daemon/runtimes/:runtimeId/bots/:botId/platforms/:bindingId/session/reset", botHandler(async (c) => {
    const denied = daemonAccess(c);
    if (denied) return denied;
    const input = sessionControlInput(await readBody(c));
    return c.json({ reset: store.resetBotSession(c.req.param("botId")!, c.req.param("bindingId")!, c.req.param("runtimeId")!, input) });
  }));

  app.post("/api/daemon/runtimes/:runtimeId/bots/:botId/platforms/:bindingId/session/cancel", botHandler(async (c) => {
    const denied = daemonAccess(c);
    if (denied) return denied;
    const input = sessionControlInput(await readBody(c));
    const taskId = store.cancelBotSessionTask(c.req.param("botId")!, c.req.param("bindingId")!, c.req.param("runtimeId")!, input);
    return c.json({ cancelled: Boolean(taskId), task_id: taskId });
  }));

  app.post("/api/daemon/runtimes/:runtimeId/bots/:botId/platforms/:bindingId/session/inspect", botHandler(async (c) => {
    const denied = daemonAccess(c);
    if (denied) return denied;
    const input = sessionControlInput(await readBody(c));
    const snapshot = store.inspectBotSession(c.req.param("botId")!, c.req.param("bindingId")!, c.req.param("runtimeId")!, input);
    return c.json({
      chat_session_id: snapshot.chatSessionId,
      task: snapshot.task ? {
        task_id: snapshot.task.taskId, status: snapshot.task.status, result: snapshot.task.result,
        error: snapshot.task.error, session_id: snapshot.task.sessionId,
        work_dir: snapshot.task.workDir, usage: snapshot.task.usage,
      } : null,
    });
  }));

  app.post("/api/daemon/runtimes/:runtimeId/bots/:botId/platforms/:bindingId/outbound/claim", botHandler((c) => {
    const denied = daemonAccess(c);
    if (denied) return denied;
    return c.json({ delivery: store.claimBotOutbound(c.req.param("botId")!, c.req.param("bindingId")!, c.req.param("runtimeId")!) });
  }));

  app.post("/api/daemon/runtimes/:runtimeId/bots/:botId/platforms/:bindingId/outbound/:deliveryId/result", botHandler(async (c) => {
    const denied = daemonAccess(c);
    if (denied) return denied;
    const body = await readBody(c);
    const claimToken = stringValue(body.claim_token);
    const status = body.status === "sent" || body.status === "failed" ? body.status : null;
    if (!claimToken || !status) return c.json({ error: "claim_token and a valid status are required", code: "invalid_body" }, 400);
    const accepted = store.reportBotOutbound(c.req.param("botId")!, c.req.param("bindingId")!, c.req.param("runtimeId")!, c.req.param("deliveryId")!, {
      claimToken, status, externalMessageId: stringValue(body.external_message_id),
      error: typeof body.error === "string" ? redactFeishuBotError(body.error) : null,
    });
    if (!accepted) return c.json({ error: "outbound delivery lease is stale", code: "stale_lease" }, 409);
    return c.json({ status: "ok" });
  }));
}
