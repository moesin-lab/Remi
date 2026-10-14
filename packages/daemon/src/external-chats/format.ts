import { basename } from "node:path";
import type { ExternalChatItem, ExternalChatProject, ExternalChatRequest, ExternalChatSummary, ExternalChatTurn } from "@multiremi/contracts/external-chats";
import { EXTERNAL_CHAT_MAX_TEXT_CHARS } from "@multiremi/contracts/external-chats";
import { array, object, string, nativeRequestText, supportedNativeRequest, type NativeObject, type NativeRequest } from "./native.js";
import { hash } from "./sources.js";

export function directoryProject(cwd: string): ExternalChatProject {
  return { id: `directory:${hash(cwd).slice(0, 24)}`, kind: "directory", name: basename(cwd) || cwd, roots: [cwd], readonly: true };
}

export function nativeProject(value: NativeObject): ExternalChatProject {
  return { id: `native:${string(value.id)}`, kind: "native", name: string(value.name).slice(0, 240),
    roots: array(value.roots).map(root => string(root.path)), readonly: true };
}

export function summary(thread: NativeObject, sourceId: string): ExternalChatSummary {
  const project = string(thread.projectId) || null;
  const cwd = string(thread.cwd);
  const state = string(object(thread.status).type);
  return {
    id: string(thread.id), source_id: sourceId, project_id: project ? `native:${project}` : cwd ? directoryProject(cwd).id : null,
    native_project_id: project, title: (string(thread.name) || string(thread.preview) || "Codex chat").slice(0, 240), cwd,
    created_at: Number(thread.createdAt) || 0, updated_at: Number(thread.updatedAt) || 0,
    status: ["idle", "active", "systemError"].includes(state) ? state as "idle" | "active" | "systemError" : "notLoaded",
    model: string(thread.model) || null, model_provider: string(thread.modelProvider), reasoning_effort: string(thread.reasoningEffort) || null,
    readonly: true,
  };
}

function itemText(item: NativeObject): string {
  switch (item.type) {
    case "userMessage": return array(item.content).map(content => string(content.text) || string(content.path) || string(content.url)).filter(Boolean).join("\n");
    case "agentMessage": case "plan": return string(item.text);
    case "reasoning": return Array.isArray(item.summary) ? item.summary.filter(x => typeof x === "string").join("\n") : "";
    case "commandExecution": return [string(item.command), string(item.aggregatedOutput)].filter(Boolean).join("\n");
    case "fileChange": return array(item.changes).map(change => `${string(change.path)}\n${string(change.diff)}`).join("\n");
    case "functionCallOutput": return string(item.output) || array(item.output).map(contentText).join("\n");
    case "mcpToolCall": {
      const result = object(item.result);
      return [string(item.server) + "/" + string(item.tool), array(result.content).map(contentText).join("\n"),
        result.structuredContent === undefined ? "" : JSON.stringify(result.structuredContent), string(object(item.error).message)].filter(Boolean).join("\n");
    }
    case "dynamicToolCall": return [string(item.tool), array(item.contentItems).map(contentText).join("\n")].filter(Boolean).join("\n");
    default: return string(item.text) || string(item.output) || string(item.result);
  }
}

function contentText(content: NativeObject): string {
  return string(content.text) || string(content.path) || string(content.url) || string(object(content.resource).text)
    || string(object(content.resource).uri) || `[${string(content.type) || "content"}]`;
}

/** Bound both text and item count; omitted content is represented by an explicit marker. */
export function turns(values: NativeObject[]): ExternalChatTurn[] {
  let remaining = 100_000;
  let count = 0;
  return values.map(turn => {
    const items: ExternalChatItem[] = [];
    for (const item of array(turn.items)) {
      if (++count > 400 || remaining <= 0) {
        items.push({ id: `truncated_${string(turn.id)}`, type: "truncated", role: "tool", text: "本页内容超过显示上限，已截断。", truncated: true });
        break;
      }
      const text = itemText(item);
      const limit = Math.min(EXTERNAL_CHAT_MAX_TEXT_CHARS, remaining);
      remaining -= Math.min(text.length, limit);
      const type = string(item.type).slice(0, 80);
      items.push({ id: string(item.id).slice(0, 160), type, role: type === "userMessage" ? "user" : ["agentMessage", "reasoning", "plan"].includes(type) ? "assistant" : "tool",
        text: text.slice(0, limit), ...(text.length > limit || type === "truncated" ? { truncated: true } : {}) });
    }
    const error = string(object(turn.error).message);
    return { id: string(turn.id), status: string(turn.status), items, ...(error ? { error: error.slice(0, 1_000) } : {}) };
  });
}

export function nativeRequest(request: NativeRequest): ExternalChatRequest | null {
  const params = request.params;
  if (!supportedNativeRequest(request.method, params)) return null;
  const base = { id: request.id, thread_id: string(params.threadId), turn_id: string(params.turnId) };
  const text = nativeRequestText(request.method, params);
  if (request.method === "item/commandExecution/requestApproval") return { ...base, kind: "command_approval", text };
  if (request.method === "item/fileChange/requestApproval") return { ...base, kind: "file_approval", text };
  if (request.method === "item/permissions/requestApproval") return { ...base, kind: "permissions_approval", text };
  if (request.method === "item/tool/requestUserInput") return {
    ...base, kind: "user_input", text: "Codex 请求你的答复", questions: array(params.questions).map(question => ({
      id: string(question.id), header: string(question.header), question: string(question.question),
      ...(question.isSecret ? { is_secret: true } : {}),
      ...(Array.isArray(question.options) ? { options: array(question.options).map(option => ({ label: string(option.label), description: string(option.description) })) } : {}),
    })),
  };
  return null;
}
