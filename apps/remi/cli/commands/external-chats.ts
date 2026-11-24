import { randomUUID } from "node:crypto";
import {
  EXTERNAL_CHAT_MAX_MODEL_CHARS,
  EXTERNAL_CHAT_MAX_PAGE_SIZE,
  EXTERNAL_CHAT_MAX_TEXT_CHARS,
  type ExternalChatCatalog,
  type ExternalChatHistory,
  type ExternalChatList,
  type ExternalChatModels,
  type ExternalChatReceipt,
} from "@multiremi/contracts/external-chats.js";
import { CliError, CliRenderer, type CliOptionSpec, type CommandInvocation, type CommandSpec } from "../core/index.js";
import { clientFor, commandOptions, encodePath, integerOption, isRecord, outputMode, positional, renderResource, stringOption } from "./resource-common.js";

const RUNTIME: CliOptionSpec = { name: "runtime", type: "string", required: true, valueName: "id", description: "Registered Runtime ID" };
const SOURCE: CliOptionSpec = { name: "source", type: "string", required: true, valueName: "id", description: "Native source ID from chat external sources" };
const REQUEST_ID: CliOptionSpec = { name: "request-id", type: "string", required: true, valueName: "id", description: "Send receipt UUID or pending native request ID" };
const PAGE: readonly CliOptionSpec[] = [
  { name: "cursor", type: "string", valueName: "cursor", description: "Native page cursor" },
  { name: "limit", type: "integer", valueName: `1..${EXTERNAL_CHAT_MAX_PAGE_SIZE}`, description: "Maximum results in this page" },
];
const THREAD = [{ name: "thread", required: true, description: "Original native thread ID" }] as const;

export function externalChatCommandSpecs(): CommandSpec[] {
  return [
    {
      id: "chat.external", path: ["chat", "external"], description: "Read and continue native Codex Chats on a Runtime (human only)",
      parse: "passthrough", run: async () => { throw new CliError("usage", "usage: remi chat external <command>"); },
    },
    spec("sources", "List native Codex sources and their Projects", "read", [RUNTIME], async invocation => {
      const path = catalogPath(invocation);
      const response = await (await clientFor(invocation)).request<ExternalChatCatalog>({ method: "GET", path });
      renderSources(invocation, response.data);
    }, false),
    spec("models", "List one page of native models available from this source", "read", [RUNTIME, SOURCE, ...PAGE], async invocation => {
      const path = `${catalogPath(invocation)}/${encodePath(requiredOption(invocation, "source"))}/models`, query = pageQuery(invocation);
      const response = await (await clientFor(invocation)).request<ExternalChatModels>({ method: "GET", path, query });
      renderModels(invocation, response.data);
    }, false),
    spec("list", "List one page of native Chats", "read", [RUNTIME, SOURCE, ...PAGE,
      { name: "project", type: "string", valueName: "id", description: "Native or directory Project ID from the source catalog" },
    ], async invocation => {
      const path = threadsPath(invocation);
      const query = { ...pageQuery(invocation), project_id: stringOption(invocation, "project") };
      const response = await (await clientFor(invocation)).request<ExternalChatList>({ method: "GET", path, query });
      renderChats(invocation, response.data);
    }, false),
    spec("get", "Read one page of original native Chat history and pending requests", "read", [RUNTIME, SOURCE, ...PAGE], async invocation => {
      const path = threadPath(invocation), query = pageQuery(invocation);
      const response = await (await clientFor(invocation)).request<ExternalChatHistory>({ method: "GET", path, query });
      renderHistory(invocation, response.data);
    }),
    spec("send", "Send once to the same native thread; reconcile unknown acknowledgements with receipt", "write", [RUNTIME, SOURCE,
      { name: "text", type: "string", required: true, valueName: "text", description: "Message text" },
      { name: "model", type: "string", valueName: "id", description: "Native model ID for this turn (omit to preserve the native model)" },
      { ...REQUEST_ID, required: false, valueName: "uuid", description: "Send UUID (default: a new UUID); never automatically resent" },
    ], send),
    spec("receipt", "Reconcile a native send by its original request UUID", "read", [RUNTIME, SOURCE, { ...REQUEST_ID, valueName: "uuid" }], async invocation => {
      const path = `${threadPath(invocation)}/receipts/${encodePath(requestUuid(invocation))}`;
      const response = await (await clientFor(invocation)).request<ExternalChatReceipt>({ method: "GET", path });
      renderReceipt(invocation, response.data);
    }),
    spec("interrupt", "Interrupt the specified native turn once", "write", [RUNTIME, SOURCE,
      { name: "turn", type: "string", required: true, valueName: "id", description: "Exact native turn ID" },
    ], async invocation => {
      const path = `${threadPath(invocation)}/interrupt`, body = { turn_id: requiredOption(invocation, "turn") };
      renderResource(invocation, await writeOnce(invocation, path, body));
    }),
    spec("respond", "Answer a pending request delivered to this native connection once", "write", [RUNTIME, SOURCE, REQUEST_ID,
      { name: "decision", type: "string", valueName: "accept|decline|cancel", description: "Approval decision", conflictsWith: ["answers-json"] },
      { name: "answers-json", type: "string", valueName: "json", description: "Question ID to string-array answers", conflictsWith: ["decision"] },
    ], async invocation => {
      const path = `${threadPath(invocation)}/requests/${encodePath(requiredOption(invocation, "request-id"))}`;
      const body = responseBody(invocation);
      renderResource(invocation, await writeOnce(invocation, path, body));
    }),
  ];
}

function spec(action: string, description: string, mutation: "read" | "write", options: readonly CliOptionSpec[], run: CommandSpec["run"], thread = true): CommandSpec {
  const id = `chat.external.${action}`;
  return { id, path: ["chat", "external", action], description, capability: id, auth: ["human"], mutation,
    outputs: ["table", "json", "jsonl"], positionals: thread ? THREAD : [], options: commandOptions(options),
    run: async invocation => { outputMode(invocation); await run(invocation); } };
}

function requiredOption(invocation: CommandInvocation, name: string): string {
  const value = stringOption(invocation, name);
  if (!value) throw new CliError("usage", `--${name} is required`);
  return value;
}

function catalogPath(invocation: CommandInvocation): string {
  return `/api/runtimes/${encodePath(requiredOption(invocation, "runtime"))}/external-chats`;
}

function threadsPath(invocation: CommandInvocation): string {
  return `${catalogPath(invocation)}/${encodePath(requiredOption(invocation, "source"))}/threads`;
}

function threadPath(invocation: CommandInvocation): string {
  return `${threadsPath(invocation)}/${encodePath(positional(invocation, 0, "thread"))}`;
}

function pageQuery(invocation: CommandInvocation): { cursor: string | null; limit: number | null } {
  const limit = integerOption(invocation, "limit");
  if (limit !== null && (limit < 1 || limit > EXTERNAL_CHAT_MAX_PAGE_SIZE)) {
    throw new CliError("usage", `--limit must be 1..${EXTERNAL_CHAT_MAX_PAGE_SIZE}`);
  }
  return { cursor: stringOption(invocation, "cursor"), limit };
}

function requestUuid(invocation: CommandInvocation, generate = false): string {
  const id = invocation.options["request-id"] === undefined && generate ? randomUUID() : requiredOption(invocation, "request-id");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new CliError("usage", "--request-id must be a UUID for send and receipt");
  }
  return id;
}

async function send(invocation: CommandInvocation): Promise<void> {
  const path = `${threadPath(invocation)}/messages`, threadId = positional(invocation, 0, "thread");
  const text = invocation.options.text;
  if (typeof text !== "string" || !text.trim() || text.length > EXTERNAL_CHAT_MAX_TEXT_CHARS) {
    throw new CliError("usage", `--text must contain 1..${EXTERNAL_CHAT_MAX_TEXT_CHARS} characters`);
  }
  const model = invocation.options.model;
  if (model !== undefined && (typeof model !== "string" || !model.trim() || model.length > EXTERNAL_CHAT_MAX_MODEL_CHARS || /[\x00-\x1f\x7f-\x9f]/.test(model))) {
    throw new CliError("usage", `--model must contain 1..${EXTERNAL_CHAT_MAX_MODEL_CHARS} characters without controls`);
  }
  const requestId = requestUuid(invocation, true);
  const client = await clientFor(invocation);
  const unknown: ExternalChatReceipt = { request_id: requestId, thread_id: threadId, turn_id: null, outcome: "unknown" };
  const hint = `Reconcile with remi chat external receipt ${threadId} --runtime ${requiredOption(invocation, "runtime")} --source ${requiredOption(invocation, "source")} --request-id ${requestId}. Do not resend.`;
  try {
    const response = await client.request<ExternalChatReceipt>({ method: "POST", path,
      body: { text, request_id: requestId, ...(model === undefined ? {} : { model }) }, retries: false });
    const receipt = response.data;
    if (!receipt || receipt.request_id !== requestId || receipt.thread_id !== threadId
      || !["accepted", "unknown"].includes(receipt.outcome)
      || (receipt.turn_id !== null && typeof receipt.turn_id !== "string")) {
      throw new CliError("server", `Native send acknowledgement is unknown (request_id ${requestId})`, { details: { receipt: unknown }, hint });
    }
    renderReceipt(invocation, receipt);
  } catch (error) {
    if (error instanceof CliError && isRecord(error.details) && typeof error.details.code === "string"
      && ["external_chat_models_unsupported", "model_catalog_too_large", "native_model_catalog_invalid", "native_cursor_invalid"].includes(error.details.code)
      && error.details.outcome !== "unknown") {
      throw new CliError(error.code, error.message, { status: error.status, retryable: false, details: error.details, cause: error });
    }
    if (error instanceof CliError && (error.code === "network" || error.code === "timeout" || (error.status !== undefined && error.status >= 500)
      || (isRecord(error.details) && error.details.outcome === "unknown"))) {
      throw new CliError(error.code, `Native send acknowledgement is unknown (request_id ${requestId})`, {
        status: error.status, retryable: false, details: { receipt: unknown }, hint, cause: error,
      });
    }
    throw error;
  }
}

async function writeOnce(invocation: CommandInvocation, path: string, body: unknown): Promise<unknown> {
  const client = await clientFor(invocation);
  try {
    return (await client.request({ method: "POST", path, body, retries: false })).data;
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    throw new CliError(error.code, error.message, {
      status: error.status, retryable: false, details: error.details,
      hint: "Do not automatically replay a native interrupt or request response.", cause: error,
    });
  }
}

function responseBody(invocation: CommandInvocation): { decision?: "accept" | "decline" | "cancel"; answers?: Record<string, string[]> } {
  const decision = stringOption(invocation, "decision"), raw = stringOption(invocation, "answers-json");
  if (decision) {
    if (!["accept", "decline", "cancel"].includes(decision)) throw new CliError("usage", "--decision must be accept, decline, or cancel");
    return { decision: decision as "accept" | "decline" | "cancel" };
  }
  if (!raw) throw new CliError("usage", "respond requires --decision or --answers-json");
  let answers: unknown;
  try { answers = JSON.parse(raw); } catch { throw new CliError("usage", "--answers-json must be a JSON object of string arrays"); }
  if (!isRecord(answers) || !Object.values(answers).every(value => Array.isArray(value) && value.every(answer => typeof answer === "string"))) {
    throw new CliError("usage", "--answers-json must be a JSON object of string arrays");
  }
  return { answers: answers as Record<string, string[]> };
}

function renderReceipt(invocation: CommandInvocation, receipt: ExternalChatReceipt): void {
  new CliRenderer().render(receipt, { mode: outputMode(invocation), columns: [
    { header: "REQUEST ID", value: (row: ExternalChatReceipt) => row.request_id },
    { header: "THREAD", value: row => row.thread_id },
    { header: "TURN", value: row => row.turn_id },
    { header: "OUTCOME", value: row => row.outcome },
  ] });
}

function renderSources(invocation: CommandInvocation, catalog: ExternalChatCatalog): void {
  new CliRenderer().render(catalog, { mode: outputMode(invocation), rows: () => catalog.sources, columns: [
    { header: "ID", value: row => row.id },
    { header: "NAME", value: row => row.name },
    { header: "HOME", value: row => row.home },
    { header: "CONNECTION", value: row => row.connection },
  ] });
}

function renderChats(invocation: CommandInvocation, list: ExternalChatList): void {
  const renderer = new CliRenderer(), mode = outputMode(invocation);
  renderer.render(list, { mode, rows: () => list.chats, columns: [
    { header: "ID", value: row => row.id },
    { header: "TITLE", value: row => row.title },
    { header: "PROJECT", value: row => row.project_id },
    { header: "CWD", value: row => row.cwd },
    { header: "STATE", value: row => row.status },
    { header: "MODEL", value: row => row.model },
  ] });
  if (mode === "table" && list.next_cursor) renderer.diagnostic(`next_cursor: ${list.next_cursor}`);
}

function renderModels(invocation: CommandInvocation, list: ExternalChatModels): void {
  const renderer = new CliRenderer(), mode = outputMode(invocation);
  renderer.render(list, { mode, rows: () => list.models, columns: [
    { header: "ID", value: row => row.id },
    { header: "NAME", value: row => row.name },
    { header: "DESCRIPTION", value: row => row.description },
  ] });
  if (mode === "table" && list.next_cursor) renderer.diagnostic(`next_cursor: ${list.next_cursor}`);
}

function renderHistory(invocation: CommandInvocation, history: ExternalChatHistory): void {
  const renderer = new CliRenderer(), mode = outputMode(invocation);
  renderer.render(history, { mode, rows: () => [
    ...history.turns.flatMap(turn => turn.items.map(item => ({ turn: turn.id, role: item.role, text: item.text, truncated: item.truncated === true }))),
    ...history.requests.map(request => ({ turn: request.turn_id, role: request.kind, text: `${request.id}: ${request.text}`, truncated: false })),
  ], columns: [{ header: "TURN", value: row => row.turn }, { header: "ROLE", value: row => row.role },
    { header: "TEXT", value: row => row.text }, { header: "TRUNCATED", value: row => row.truncated ? "yes" : "-" }] });
  if (mode === "table" && history.next_cursor) renderer.diagnostic(`next_cursor: ${history.next_cursor}`);
}
