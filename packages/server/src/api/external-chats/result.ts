import type { ExternalChatOperation, ExternalChatRpcResult, ExternalChatResult } from "@multiremi/contracts/external-chats.js";

export function isExternalChatWrite(operation: ExternalChatOperation): boolean {
  return operation.operation === "send" || operation.operation === "interrupt" || operation.operation === "respond";
}

export function externalChatFailure(code: string, message: string, unknown = false): ExternalChatRpcResult {
  return { ok: false, code, message, ...(unknown ? { outcome: "unknown" as const } : {}) };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid external Chat result");
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid external Chat string");
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null ? null : string(value);
}

function array<T>(value: unknown, map: (value: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error("Invalid external Chat list");
  return value.map(map);
}

function project(value: unknown) {
  const row = object(value);
  if (row.readonly !== true || (row.kind !== "native" && row.kind !== "directory")) throw new Error("Invalid external Project");
  return { id: string(row.id), kind: row.kind, name: string(row.name), roots: array(row.roots, string), readonly: true as const };
}

function summary(value: unknown, operation: ExternalChatOperation) {
  const row = object(value);
  if (row.readonly !== true || !["notLoaded", "idle", "active", "systemError"].includes(string(row.status))
    || typeof row.created_at !== "number" || !Number.isFinite(row.created_at)
    || typeof row.updated_at !== "number" || !Number.isFinite(row.updated_at)) throw new Error("Invalid external Chat summary");
  if ("source_id" in operation && row.source_id !== operation.source_id) throw new Error("Foreign external Chat source");
  if ("thread_id" in operation && row.id !== operation.thread_id) throw new Error("Foreign external Chat thread");
  return { id: string(row.id), source_id: string(row.source_id), project_id: nullableString(row.project_id),
    native_project_id: nullableString(row.native_project_id), title: string(row.title), cwd: string(row.cwd),
    created_at: row.created_at, updated_at: row.updated_at, status: row.status,
    model: nullableString(row.model), model_provider: string(row.model_provider),
    reasoning_effort: nullableString(row.reasoning_effort), readonly: true as const };
}

/** Project only the frozen DTO: native configuration and credentials are never API fields. */
export function externalChatResult(value: unknown, operation: ExternalChatOperation): ExternalChatRpcResult {
  try {
    const result = object(value);
    if (result.ok === false) {
      const code = string(result.code);
      const message = string(result.message);
      if (!/^[a-z][a-z0-9_\.]{0,100}$/.test(code) || message.length > 1000
        || (result.outcome !== undefined && result.outcome !== "unknown")) throw new Error("Invalid external Chat error");
      return externalChatFailure(code, message, result.outcome === "unknown");
    }
    if (result.ok !== true) throw new Error("Invalid external Chat response");
    const row = object(result.data);
    let data: unknown;
    switch (operation.operation) {
      case "catalog":
        data = { sources: array(row.sources, value => {
          const source = object(value);
          if (source.provider !== "codex" || (source.connection !== "live" && source.connection !== "isolated")) throw new Error("Invalid external source");
          return { id: string(source.id), name: string(source.name), home: string(source.home), provider: "codex",
            connection: source.connection, projects: array(source.projects, project) };
        }), warnings: array(row.warnings, value => {
          const warning = object(value);
          return { source_id: string(warning.source_id), code: string(warning.code), message: string(warning.message) };
        }) };
        break;
      case "list":
        data = { chats: array(row.chats, value => summary(value, operation)), projects: array(row.projects, project),
          next_cursor: nullableString(row.next_cursor) };
        break;
      case "read":
        data = { chat: summary(row.chat, operation), next_cursor: nullableString(row.next_cursor),
          turns: array(row.turns, value => {
            const turn = object(value);
            return { id: string(turn.id), status: string(turn.status), ...(turn.error === undefined ? {} : { error: string(turn.error) }),
              items: array(turn.items, value => {
                const item = object(value);
                if (!["user", "assistant", "tool"].includes(string(item.role))
                  || (item.truncated !== undefined && typeof item.truncated !== "boolean")) throw new Error("Invalid external Chat item");
                return { id: string(item.id), type: string(item.type), role: item.role, text: string(item.text),
                  ...(item.truncated === undefined ? {} : { truncated: item.truncated }) };
              }) };
          }), requests: array(row.requests, value => {
            const request = object(value);
            if (request.thread_id !== operation.thread_id
              || !["command_approval", "file_approval", "permissions_approval", "user_input"].includes(string(request.kind))) throw new Error("Invalid external Chat request");
            return { id: string(request.id), thread_id: operation.thread_id, turn_id: string(request.turn_id),
              kind: request.kind, text: string(request.text), ...(request.questions === undefined ? {} : {
                questions: array(request.questions, value => {
                  const question = object(value);
                  if (question.is_secret !== undefined && typeof question.is_secret !== "boolean") throw new Error("Invalid external question");
                  return { id: string(question.id), header: string(question.header), question: string(question.question),
                    ...(question.is_secret === undefined ? {} : { is_secret: question.is_secret }),
                    ...(question.options === undefined ? {} : { options: array(question.options, value => {
                      const option = object(value);
                      return { label: string(option.label), description: string(option.description) };
                    }) }) };
                }) }) };
          }) };
        break;
      case "send":
      case "receipt":
        if (row.thread_id !== operation.thread_id || row.request_id !== operation.request_id
          || (row.outcome !== "accepted" && row.outcome !== "unknown")) throw new Error("Foreign external Chat receipt");
        data = { thread_id: operation.thread_id, request_id: operation.request_id,
          turn_id: nullableString(row.turn_id), outcome: row.outcome };
        break;
      case "interrupt":
      case "respond":
        if (row.accepted !== true) throw new Error("Invalid external Chat acknowledgement");
        data = { accepted: true };
    }
    return { ok: true, data: data as ExternalChatResult };
  } catch {
    return externalChatFailure("invalid_external_chat_response", "The Runtime returned an invalid external Chat response", isExternalChatWrite(operation));
  }
}
