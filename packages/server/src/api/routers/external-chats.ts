import type { Context, Hono } from "hono";
import { EXTERNAL_CHAT_MAX_MODEL_CHARS, EXTERNAL_CHAT_MAX_PAGE_SIZE, EXTERNAL_CHAT_MAX_TEXT_CHARS, EXTERNAL_CHAT_RPC_MAX_BYTES,
  type ExternalChatOperation, type ExternalChatRpcResult } from "@multiremi/contracts/external-chats.js";
import { currentAccessToken, isHumanOperatorRequest } from "../wire/context.js";
import { denyCurrentUserWorkspaceAccess } from "../helpers/auth-guards.js";
import { loadRuntimeForCurrentUser } from "../helpers/runtimes.js";
import { resolveRequestWorkspaceId } from "../helpers/workspace-context.js";
import { externalChatFailure, isExternalChatWrite } from "../external-chats/result.js";
import type { RouterDeps } from "./deps.js";

class ExternalChatInputError extends Error {
  constructor(message: string, readonly status: 400 | 413 = 400) { super(message); }
}

function opaqueId(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(value)) {
    throw new ExternalChatInputError(`${name} must be a bounded identifier, not a filesystem path`);
  }
  return value;
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) {
    throw new ExternalChatInputError(`${name} must be a UUID`);
  }
  return value;
}

function query(c: Context, allowed: readonly string[], maxValueChars = 2048): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of new URL(c.req.url).searchParams) {
    if (!allowed.includes(key) || Object.hasOwn(values, key)) throw new ExternalChatInputError("Unsupported or repeated query parameter");
    if (!value || value.length > maxValueChars || /[\x00-\x1f\x7f]/.test(value)) throw new ExternalChatInputError(`Invalid ${key}`);
    values[key] = value;
  }
  return values;
}

function pageParams(values: Record<string, string>) {
  let limit: number | undefined;
  if (values.limit !== undefined) {
    if (!/^[1-9]\d*$/.test(values.limit) || Number(values.limit) > EXTERNAL_CHAT_MAX_PAGE_SIZE) {
      throw new ExternalChatInputError(`limit must be between 1 and ${EXTERNAL_CHAT_MAX_PAGE_SIZE}`);
    }
    limit = Number(values.limit);
  }
  return { ...(values.cursor === undefined ? {} : { cursor: values.cursor }), ...(limit === undefined ? {} : { limit }) };
}

async function body(c: Context, allowed: readonly string[]): Promise<Record<string, unknown>> {
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new ExternalChatInputError("A JSON object is required");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > EXTERNAL_CHAT_RPC_MAX_BYTES) {
        await reader.cancel();
        throw new ExternalChatInputError("External Chat request body is too large", 413);
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new ExternalChatInputError("A valid JSON object is required"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new ExternalChatInputError("Unsupported external Chat request fields");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > EXTERNAL_CHAT_MAX_TEXT_CHARS || value.includes("\0")) {
    throw new ExternalChatInputError(`text must contain between 1 and ${EXTERNAL_CHAT_MAX_TEXT_CHARS} characters`);
  }
  return value;
}

function answerKey(value: string): void {
  if (!value || value.length > 256 || /[\x00-\x1f\x7f-\x9f]/.test(value)
    || ["__proto__", "constructor", "prototype"].includes(value)) {
    throw new ExternalChatInputError("Invalid question id");
  }
}

function model(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > EXTERNAL_CHAT_MAX_MODEL_CHARS || /[\x00-\x1f\x7f-\x9f]/.test(value)) {
    throw new ExternalChatInputError(`model must contain between 1 and ${EXTERNAL_CHAT_MAX_MODEL_CHARS} characters without controls`);
  }
  return value;
}

function responseInput(value: Record<string, unknown>): Pick<Extract<ExternalChatOperation, { operation: "respond" }>, "decision" | "answers"> {
  if ((value.decision === undefined) === (value.answers === undefined)) throw new ExternalChatInputError("Send either decision or answers");
  if (value.decision !== undefined) {
    if (value.decision !== "accept" && value.decision !== "decline" && value.decision !== "cancel") throw new ExternalChatInputError("Invalid decision");
    return { decision: value.decision };
  }
  const answers = value.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers) || Object.keys(answers).length > 20) throw new ExternalChatInputError("Invalid answers");
  const result: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(answers)) {
    answerKey(key);
    if (!Array.isArray(values) || values.length > 20
      || values.some(value => typeof value !== "string" || value.length > EXTERNAL_CHAT_MAX_TEXT_CHARS || value.includes("\0"))) {
      throw new ExternalChatInputError("Invalid answers");
    }
    result[key] = values;
  }
  return { answers: result };
}

function resultResponse(c: Context, result: ExternalChatRpcResult, operation: ExternalChatOperation): Response {
  if (result.ok) return c.json(result.data, operation.operation === "send" ? 202 : 200);
  const status = result.code === "daemon_timeout" ? 504
    : result.code === "invalid_external_chat_response" ? 502
    : result.code === "request_too_large" ? 413
    : /(?:not_found|unknown_source)/.test(result.code) ? 404
    : result.code === "model_not_available" ? 409
    : /(?:busy|conflict|locked)/.test(result.code) ? 409
    : /(?:invalid_request|invalid_input)/.test(result.code) ? 400 : 503;
  return c.json({ error: result.message, code: result.code, ...(result.outcome ? { outcome: result.outcome } : {}) }, status);
}

/** External catalogs share human workspace access; machine/task credentials never enter native content. */
export function registerExternalChatRoutes(app: Hono, deps: RouterDeps): void {
  const base = "/api/runtimes/:id/external-chats";
  const threads = `${base}/:sourceId/threads`;
  const run = async (c: Context, build: () => Promise<ExternalChatOperation> | ExternalChatOperation) => {
    const token = currentAccessToken(c);
    if (!isHumanOperatorRequest(c) || token?.type === "task" || token?.type === "daemon") {
      return c.json({ error: "External Chats require a human operator", code: "human_operator_required" }, 403);
    }
    const loaded = loadRuntimeForCurrentUser(c, deps.store, c.req.param("id") ?? "");
    if (loaded instanceof Response) return loaded;
    const workspaceId = loaded.runtime.workspaceId ?? "local";
    const denied = denyCurrentUserWorkspaceAccess(c, deps.store, workspaceId);
    if (denied) return denied;
    if (c.req.header("X-Workspace-ID") || c.req.header("X-Workspace-Slug")) {
      const selected = resolveRequestWorkspaceId(c, deps.store);
      if (selected instanceof Response) return selected;
      if (selected !== workspaceId) return c.json({ error: "Runtime not found in the selected workspace" }, 404);
    }
    c.header("Cache-Control", "no-store");
    try {
      opaqueId(loaded.runtime.id, "runtime id");
      const operation = await build();
      if (loaded.runtime.provider !== "codex" || loaded.runtime.metadata.external_chats !== 1) {
        return c.json({ error: "Upgrade the owning Codex Runtime to enable External Chats", code: "external_chats_unsupported" }, 503);
      }
      if ((operation.operation === "models" || (operation.operation === "send" && operation.model !== undefined))
        && loaded.runtime.metadata.external_chat_models !== 1) {
        return c.json({ error: "Upgrade the owning Codex Runtime to list or select external Chat models", code: "external_chat_models_unsupported" }, 503);
      }
      if (!deps.externalChatClient) return c.json({ error: "External Chat transport is unavailable", code: "external_chats_unavailable" }, 503);
      try { return resultResponse(c, await deps.externalChatClient.request(loaded.runtime.id, operation), operation); }
      catch { return resultResponse(c, externalChatFailure("daemon_unreachable", "The owning Runtime did not acknowledge the request", isExternalChatWrite(operation)), operation); }
    } catch (error) {
      if (error instanceof ExternalChatInputError) return c.json({ error: error.message, code: "invalid_external_chat_request" }, error.status);
      throw error;
    }
  };
  const source = (c: Context) => opaqueId(c.req.param("sourceId"), "source id");
  const thread = (c: Context) => uuid(c.req.param("threadId"), "thread id");

  app.get(base, c => run(c, () => { query(c, []); return { operation: "catalog" }; }));
  app.get(`${base}/:sourceId/models`, c => run(c, () => ({ operation: "models", source_id: source(c),
    ...pageParams(query(c, ["cursor", "limit"], 4096)) })));
  app.get(threads, c => run(c, () => {
    const values = query(c, ["project_id", "cursor", "limit"]);
    return { operation: "list", source_id: source(c), ...pageParams(values),
      ...(values.project_id === undefined ? {} : { project_id: opaqueId(values.project_id, "project id") }) };
  }));
  app.get(`${threads}/:threadId`, c => run(c, () => ({ operation: "read", source_id: source(c), thread_id: thread(c),
    ...pageParams(query(c, ["cursor", "limit"])) })));
  app.post(`${threads}/:threadId/messages`, c => run(c, async () => {
    query(c, []);
    const input = await body(c, ["text", "request_id", "model"]);
    return { operation: "send", source_id: source(c), thread_id: thread(c), text: text(input.text), request_id: uuid(input.request_id, "request id"),
      ...(input.model === undefined ? {} : { model: model(input.model) }) };
  }));
  app.get(`${threads}/:threadId/receipts/:requestId`, c => run(c, () => {
    query(c, []);
    return { operation: "receipt", source_id: source(c), thread_id: thread(c), request_id: uuid(c.req.param("requestId"), "request id") };
  }));
  app.post(`${threads}/:threadId/interrupt`, c => run(c, async () => {
    query(c, []);
    const input = await body(c, ["turn_id"]);
    return { operation: "interrupt", source_id: source(c), thread_id: thread(c), turn_id: uuid(input.turn_id, "turn id") };
  }));
  app.post(`${threads}/:threadId/requests/:requestId`, c => run(c, async () => {
    query(c, []);
    const input = await body(c, ["decision", "answers"]);
    return { operation: "respond", source_id: source(c), thread_id: thread(c),
      request_id: opaqueId(c.req.param("requestId"), "native request id"), ...responseInput(input) };
  }));
}
