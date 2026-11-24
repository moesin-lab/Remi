import { homedir } from "node:os";
import { join } from "node:path";
import type { ExternalChatCatalog, ExternalChatModels, ExternalChatOperation, ExternalChatProject, ExternalChatReceipt, ExternalChatResult, ExternalChatRpcResult } from "@multiremi/contracts/external-chats";
import { EXTERNAL_CHAT_MAX_MODEL_CHARS, EXTERNAL_CHAT_MAX_PAGE_SIZE, EXTERNAL_CHAT_MAX_TEXT_CHARS, EXTERNAL_CHAT_RPC_MAX_BYTES } from "@multiremi/contracts/external-chats";
import { connectNative, NativeError, array, object, string, type NativeConnection, type NativeConnectionFactory, type NativeObject } from "./native.js";
import { assertSourceOwned, discoverSources, hash, type LocalSource } from "./sources.js";
import { directoryProject, nativeProject, nativeRequest, summary, turns } from "./format.js";
import { Receipts, type SavedReceipt } from "./receipts.js";

export interface CodexExternalChatsOptions {
  home?: string;
  baseHome?: string;
  codexBinary?: string;
  codexArgs?: string[];
  stateDir?: string;
  uid?: number;
  now?: () => number;
  requestTimeoutMs?: number;
  connectionFactory?: NativeConnectionFactory;
}

class ChatError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

interface SourceIndex { projects: ExternalChatProject[]; threads: NativeObject[]; truncated: boolean; refreshed: number }
interface OwnedInput { requestId: string; turnId: string | null }
const SOURCES = ["cli", "vscode", "appServer", "exec"];
const TERMINAL_TURNS = new Set(["completed", "interrupted", "failed"]);

export class CodexExternalChats {
  private readonly home: string;
  private readonly uid: number | undefined;
  private readonly now: () => number;
  private readonly receipts: Receipts;
  private readonly connections = new Map<string, Promise<NativeConnection>>();
  private readonly indexes = new Map<string, Promise<SourceIndex>>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly ownedInputs = new Map<string, OwnedInput>();
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(private readonly options: CodexExternalChatsOptions = {}) {
    this.home = options.home ?? homedir();
    this.uid = options.uid ?? process.getuid?.();
    this.now = options.now ?? Date.now;
    this.receipts = new Receipts(join(options.stateDir ?? join(this.home, ".multiremi", "external-chats"), "receipts"), this.uid);
  }

  async request(operation: ExternalChatOperation): Promise<ExternalChatRpcResult> {
    try {
      if (this.closed) throw new ChatError("source_closed", "外部会话连接已关闭。");
      if (this.uid === undefined) throw new ChatError("native_platform_unsupported", "此系统缺少原生来源归属校验能力。");
      this.validate(operation);
      const data = operation.operation === "catalog" ? await this.catalog() : await this.execute(operation);
      const result: ExternalChatRpcResult = { ok: true, data };
      if (Buffer.byteLength(JSON.stringify(result)) > EXTERNAL_CHAT_RPC_MAX_BYTES) throw new ChatError("response_too_large", "本页内容过大，请缩小分页。");
      return result;
    } catch (error) {
      if (error instanceof ChatError) return { ok: false, code: error.code, message: error.message };
      if (error instanceof NativeError) {
        if (/active writer|closing|conflict/i.test(error.detail)) return { ok: false, code: "native_busy", message: "原生会话仍被其他客户端占用，请在原客户端结束后重试。" };
        return { ok: false, code: typeof error.code === "string" ? error.code : "native_request_failed", message: "无法完成原生 Codex 请求，请检查原客户端状态。" };
      }
      return { ok: false, code: "native_state_unavailable", message: "无法安全读取本机原生会话或发送回执。" };
    }
  }

  private validate(operation: ExternalChatOperation): void {
    if (!operation || typeof operation !== "object") throw new ChatError("invalid_operation", "无效的外部会话操作。");
    if (!["catalog", "models", "list", "read", "send", "receipt", "interrupt", "respond"].includes(operation.operation)) throw new ChatError("invalid_operation", "不支持此外部会话操作。");
    const required = operation.operation === "catalog" ? [] : ["list", "models"].includes(operation.operation) ? ["source_id"]
      : ["source_id", "thread_id", ...(["send", "receipt", "respond"].includes(operation.operation) ? ["request_id"] : []), ...(operation.operation === "interrupt" ? ["turn_id"] : [])];
    if (required.some(field => !(field in operation))) throw new ChatError("invalid_reference", "缺少原生会话标识。");
    for (const field of ["source_id", "thread_id", "request_id", "turn_id"] as const) {
      const value = object(operation)[field];
      if (field in operation && (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(value))) throw new ChatError("invalid_reference", "无效的原生会话标识。");
    }
    if (operation.operation === "send" && (typeof operation.text !== "string" || !operation.text.trim() || operation.text.length > EXTERNAL_CHAT_MAX_TEXT_CHARS)) throw new ChatError("invalid_text", "消息为空或超过长度上限。");
    if (operation.operation === "send" && operation.model !== undefined && !this.validModel(operation.model)) throw new ChatError("invalid_model", "模型标识无效。");
    if ("cursor" in operation && operation.cursor !== undefined && (typeof operation.cursor !== "string" || operation.cursor.length > 4_096)) throw new ChatError("invalid_cursor", "分页游标无效。");
    if ("limit" in operation && operation.limit !== undefined && (!Number.isInteger(operation.limit) || operation.limit < 1 || operation.limit > EXTERNAL_CHAT_MAX_PAGE_SIZE)) throw new ChatError("invalid_limit", "分页数量无效。");
  }

  private sources(): LocalSource[] { return discoverSources(this.home, this.options.baseHome ?? process.env.CODEX_HOME, this.uid); }

  private source(id: string): LocalSource {
    const source = this.sources().find(source => source.id === id);
    if (!source) throw new ChatError("source_not_found", "该原生来源不属于当前 Runtime 用户。");
    assertSourceOwned(source, this.uid);
    return source;
  }

  private async connection(source: LocalSource): Promise<NativeConnection> {
    if (this.closed) throw new ChatError("source_closed", "外部会话连接已关闭。");
    let connection = this.connections.get(source.id);
    if (connection && (await connection).closed) {
      await (await connection).close();
      this.connections.delete(source.id);
      this.indexes.delete(source.id);
      connection = undefined;
    }
    if (!connection) {
      if (this.closed) throw new ChatError("source_closed", "外部会话连接已关闭。");
      connection = (this.options.connectionFactory ?? connectNative)(source.home, { ...this.options, uid: this.uid });
      this.connections.set(source.id, connection);
      void connection.catch(() => { if (this.connections.get(source.id) === connection) this.connections.delete(source.id); });
    }
    return connection;
  }

  private async index(source: LocalSource, connection: NativeConnection): Promise<SourceIndex> {
    const existing = this.indexes.get(source.id);
    if (existing && this.now() - (await existing).refreshed < 30_000) return existing;
    const loading = (async () => {
      const projects: ExternalChatProject[] = [];
      let cursor: string | undefined;
      const seenProjects = new Set<string>();
      do {
        const page = await connection.rpc("project/list", { limit: 200, ...(cursor ? { cursor } : {}) });
        projects.push(...array(page.data).map(nativeProject));
        cursor = string(page.nextCursor) || undefined;
        if (cursor && seenProjects.has(cursor)) throw new NativeError("native_cursor_invalid");
        if (cursor) seenProjects.add(cursor);
      } while (cursor && projects.length < 5_000);
      const projectsTruncated = Boolean(cursor);
      const threads: NativeObject[] = [];
      const seen = new Set<string>();
      cursor = undefined;
      do {
        const page = await connection.rpc("thread/list", { limit: 200, modelProviders: [], sourceKinds: SOURCES, useStateDbOnly: true, sortKey: "updated_at", sortDirection: "desc", ...(cursor ? { cursor } : {}) });
        threads.push(...array(page.data).slice(0, 5_000 - threads.length));
        cursor = string(page.nextCursor) || undefined;
        if (cursor && seen.has(cursor)) throw new NativeError("native_cursor_invalid");
        if (cursor) seen.add(cursor);
      } while (cursor && threads.length < 5_000);
      const directories = new Map<string, ExternalChatProject>();
      for (const thread of threads) {
        const cwd = string(thread.cwd);
        if (!thread.projectId && cwd) directories.set(cwd, directoryProject(cwd));
      }
      return { projects: [...projects, ...directories.values()], threads, truncated: projectsTruncated || Boolean(cursor), refreshed: this.now() };
    })();
    this.indexes.set(source.id, loading);
    try { return await loading; } catch (error) { this.indexes.delete(source.id); throw error; }
  }

  private async catalog(): Promise<ExternalChatCatalog> {
    const catalog: ExternalChatCatalog = { sources: [], warnings: [] };
    for (const source of this.sources()) {
      if (this.closed) throw new ChatError("source_closed", "外部会话连接已关闭。");
      try {
        assertSourceOwned(source, this.uid);
        const connection = await this.connection(source);
        const index = await this.index(source, connection);
        const entry = { ...source, provider: "codex" as const, connection: connection.connection, projects: [] as ExternalChatProject[] };
        catalog.sources.push(entry);
        for (const project of index.projects) {
          entry.projects.push(project);
          if (Buffer.byteLength(JSON.stringify(catalog)) > EXTERNAL_CHAT_RPC_MAX_BYTES - 8_192) {
            entry.projects.pop();
            catalog.warnings.push({ source_id: source.id, code: "catalog_truncated", message: "目录分组超过返回上限，已截断。" });
            break;
          }
        }
        if (index.truncated) catalog.warnings.push({ source_id: source.id, code: "catalog_truncated", message: "只扫描前 5000 个已索引会话或项目。" });
      } catch {
        catalog.warnings.push({ source_id: source.id, code: "source_unavailable", message: "此原生来源不可读取；未切换到另一来源。" });
      }
    }
    return catalog;
  }

  private async execute(operation: Exclude<ExternalChatOperation, { operation: "catalog" }>): Promise<ExternalChatResult> {
    const source = this.source(operation.source_id);
    if (operation.operation === "receipt") {
      const receipt = this.receipts.read(source.id, operation.request_id);
      if (!receipt || receipt.thread_id !== operation.thread_id) throw new ChatError("receipt_not_found", "该回执不属于此会话。");
      if (receipt.outcome === "accepted") return this.publicReceipt(receipt);
      try { return await this.reconcile(receipt, await this.connection(source)); }
      catch { return this.publicReceipt(receipt); }
    }
    const connection = await this.connection(source);
    if (operation.operation === "models") {
      const page = await this.modelPage(connection, operation.cursor, operation.limit);
      return { source_id: source.id, models: page.models.map(model => ({ id: string(model.model), name: string(model.displayName) || string(model.model), description: string(model.description) })), next_cursor: page.nextCursor } satisfies ExternalChatModels;
    }
    if (operation.operation === "list") {
      const index = await this.index(source, connection);
      const project = operation.project_id && index.projects.find(project => project.id === operation.project_id);
      if (operation.project_id && !project) throw new ChatError("project_not_found", "此项目分组不属于所选原生来源。");
      const page = await connection.rpc("thread/list", {
        limit: operation.limit ?? 20, modelProviders: [], sourceKinds: SOURCES, useStateDbOnly: true, sortKey: "updated_at", sortDirection: "desc",
        ...(operation.cursor ? { cursor: operation.cursor } : {}),
        ...(project ? project.kind === "native" ? { projectId: project.id.slice(7) } : { projectId: null, cwd: project.roots[0] } : {}),
      });
      const chats = array(page.data).map(thread => summary(thread, source.id));
      const projectIds = new Set(chats.map(chat => chat.project_id));
      return { chats, projects: index.projects.filter(item => project ? item.id === project.id : projectIds.has(item.id)), next_cursor: string(page.nextCursor) || null };
    }
    if (operation.operation === "read") return this.read(source, connection, operation);
    return this.serial(`${source.id}:${operation.thread_id}`, async () => {
      if (operation.operation === "send") return this.send(source, connection, operation);
      if (operation.operation === "respond") return this.respond(connection, operation);
      const thread = await this.thread(connection, operation.thread_id);
      const page = await connection.rpc("thread/turns/list", { threadId: operation.thread_id, limit: 1, itemsView: "summary", sortDirection: "desc" });
      if (summary(thread, source.id).status !== "active" || array(page.data)[0]?.id !== operation.turn_id) throw new ChatError("turn_not_active", "指定轮次已不再运行。");
      await connection.rpc("turn/interrupt", { threadId: operation.thread_id, turnId: operation.turn_id });
      return { accepted: true };
    });
  }

  private async thread(connection: NativeConnection, id: string): Promise<NativeObject> {
    const thread = object((await connection.rpc("thread/read", { threadId: id, includeTurns: false })).thread);
    if (thread.id !== id || !SOURCES.includes(string(thread.source))) throw new ChatError("thread_not_found", "此会话不属于可接续的原生来源。");
    return thread;
  }

  private validModel(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= EXTERNAL_CHAT_MAX_MODEL_CHARS
      && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
  }

  private async modelPage(connection: NativeConnection, cursor?: string, limit = EXTERNAL_CHAT_MAX_PAGE_SIZE): Promise<{ models: NativeObject[]; nextCursor: string | null }> {
    const page = await connection.rpc("model/list", { limit, includeHidden: false, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page.data) || page.data.length > limit || page.nextCursor !== null && page.nextCursor !== undefined && (typeof page.nextCursor !== "string" || page.nextCursor.length > 4_096)) {
      throw new NativeError("native_model_catalog_invalid");
    }
    const models = array(page.data).filter(model => model.hidden !== true);
    if (models.some(model => !this.validModel(model.model) || typeof model.displayName !== "string" || model.displayName.length > 240
      || typeof model.description !== "string" || model.description.length > 4_000)) throw new NativeError("native_model_catalog_invalid");
    return { models, nextCursor: string(page.nextCursor) || null };
  }

  private async findModel(connection: NativeConnection, id: string): Promise<NativeObject> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    // Bound native work even if a broken catalog keeps producing fresh cursors.
    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      const page = await this.modelPage(connection, cursor);
      const model = page.models.find(model => model.model === id);
      if (model) {
        const defaultEffort = model.defaultReasoningEffort;
        if (typeof defaultEffort !== "string" || !defaultEffort || defaultEffort.length > 80
          || !Array.isArray(model.supportedReasoningEfforts) || !array(model.supportedReasoningEfforts).some(effort => effort.reasoningEffort === defaultEffort)) throw new NativeError("native_model_catalog_invalid");
        return model;
      }
      if (!page.nextCursor) throw new ChatError("model_not_available", "所选模型不在此原生来源的可见模型目录中，请刷新模型选项。");
      if (seen.has(page.nextCursor)) throw new NativeError("native_cursor_invalid");
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new ChatError("model_catalog_too_large", "模型目录超过校验上限，未发送消息。");
  }

  private async read(source: LocalSource, connection: NativeConnection, operation: Extract<ExternalChatOperation, { operation: "read" }>): Promise<ExternalChatResult> {
    const thread = await this.thread(connection, operation.thread_id);
    let page: NativeObject;
    try {
      page = await connection.rpc("thread/turns/list", { threadId: operation.thread_id, limit: Math.min(operation.limit ?? 20, 20), itemsView: "full", sortDirection: "desc", ...(operation.cursor ? { cursor: operation.cursor } : {}) });
    } catch (error) {
      if (!(error instanceof NativeError) || error.code !== -32601 || !connection.version.startsWith("0.154.") || thread.historyMode === "paginated" || operation.cursor) throw error;
      const legacy = object((await connection.rpc("thread/read", { threadId: operation.thread_id, includeTurns: true })).thread);
      const history = array(legacy.turns);
      const selected = history.slice(-Math.min(operation.limit ?? 20, 20)).reverse();
      if (selected.length && history.length > selected.length) {
        const oldest = selected[selected.length - 1]!;
        oldest.items = [...array(oldest.items), { id: "legacy_truncated", type: "truncated", text: "旧客户端历史超过本页上限，已截断。" }];
      }
      page = { data: selected, nextCursor: null };
    }
    this.observeOwnedInput(source.id, operation.thread_id, array(page.data));
    const requests = connection.pending(operation.thread_id).map(nativeRequest);
    return { chat: summary(thread, source.id), turns: turns(array(page.data).reverse()), next_cursor: string(page.nextCursor) || null, requests: requests.filter(request => request !== null) };
  }

  private async send(source: LocalSource, connection: NativeConnection, operation: Extract<ExternalChatOperation, { operation: "send" }>): Promise<ExternalChatReceipt> {
    const binding = hash(operation.text);
    const previous = this.receipts.read(source.id, operation.request_id);
    if (previous) {
      if (previous.thread_id !== operation.thread_id || previous.payload_hash !== binding || previous.model !== operation.model) throw new ChatError("receipt_binding_mismatch", "此请求 ID 已绑定另一会话、消息或模型。");
      if (previous.outcome === "accepted") return this.publicReceipt(previous);
      try { return await this.reconcile(previous, connection); }
      catch { return this.publicReceipt(previous); }
    }
    await this.requireOwnedInputFinished(source.id, operation.thread_id, connection);
    const thread = await this.thread(connection, operation.thread_id);
    this.requireIdle(thread);
    const selectedModel = operation.model === undefined ? undefined : await this.findModel(connection, operation.model);
    const currentEffort = string(thread.reasoningEffort);
    const supportedEfforts = array(selectedModel?.supportedReasoningEfforts).map(effort => string(effort.reasoningEffort));
    const effort = selectedModel && !supportedEfforts.includes(currentEffort) ? string(selectedModel.defaultReasoningEffort) : undefined;
    if (!connection.attached.has(operation.thread_id)) {
      const resumed = await connection.rpc("thread/resume", { threadId: operation.thread_id, excludeTurns: true });
      const resumedThread = object(resumed.thread);
      if (resumedThread.id !== operation.thread_id || resumedThread.canAcceptDirectInput === false) throw new ChatError("thread_not_writable", "原生客户端不允许直接向此会话发送消息。");
      connection.attached.add(operation.thread_id);
    }
    // This catches observed busy state. Codex's API does not provide an atomic idle precondition across clients.
    this.requireIdle(await this.thread(connection, operation.thread_id));
    const receipt: SavedReceipt = { source_id: source.id, request_id: operation.request_id, thread_id: operation.thread_id, turn_id: null, outcome: "unknown", payload_hash: binding, ...(operation.model === undefined ? {} : { model: operation.model }) };
    if (!this.receipts.create(receipt)) return this.send(source, connection, operation);
    const key = `${source.id}:${operation.thread_id}`;
    this.ownedInputs.set(key, { requestId: operation.request_id, turnId: null });
    try {
      const result = await connection.rpc("turn/start", { threadId: operation.thread_id, input: [{ type: "text", text: operation.text }], clientUserMessageId: operation.request_id,
        ...(operation.model === undefined ? {} : { model: operation.model }), ...(effort ? { effort } : {}) });
      const turnId = string(object(result.turn).id);
      if (turnId) {
        const owned = this.ownedInputs.get(key);
        if (owned?.requestId === operation.request_id) owned.turnId = turnId;
        receipt.outcome = "accepted"; receipt.turn_id = turnId; this.receipts.update(receipt);
      }
    } catch {
      receipt.outcome = "unknown";
      receipt.turn_id = null;
      // The persisted unknown receipt forbids retrying a potentially accepted native input.
    }
    return this.publicReceipt(receipt);
  }

  private async requireOwnedInputFinished(source: string, thread: string, connection: NativeConnection): Promise<void> {
    const key = `${source}:${thread}`;
    const owned = this.ownedInputs.get(key);
    if (!owned) return;
    // ACK can precede native status/history publication. Absence is not proof that the input finished.
    const page = await connection.rpc("thread/turns/list", { threadId: thread, limit: 20, itemsView: owned.turnId ? "summary" : "full", sortDirection: "desc" });
    this.observeOwnedInput(source, thread, array(page.data));
    if (this.ownedInputs.has(key)) throw new ChatError("native_busy", "上一条消息尚未确认结束，请等待该轮次完成后再发送。");
  }

  private observeOwnedInput(source: string, thread: string, values: NativeObject[]): void {
    const key = `${source}:${thread}`;
    const owned = this.ownedInputs.get(key);
    if (!owned) return;
    const turn = values.find(turn => owned.turnId ? turn.id === owned.turnId
      : array(turn.items).some(item => item.type === "userMessage" && item.clientId === owned.requestId));
    if (!turn || !string(turn.id)) return;
    owned.turnId = string(turn.id);
    if (TERMINAL_TURNS.has(string(turn.status))) this.ownedInputs.delete(key);
  }

  private requireIdle(thread: NativeObject): void {
    const state = object(thread.status).type;
    if (state === "active") throw new ChatError("native_busy", "此会话正在原客户端运行，请结束后再发送。");
    if (state !== "idle" && state !== "notLoaded") throw new ChatError("thread_not_writable", "无法确认原生会话处于可发送状态。");
  }

  private async reconcile(receipt: SavedReceipt, connection: NativeConnection): Promise<ExternalChatReceipt> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let pageNumber = 0; pageNumber < 25; pageNumber++) {
      const page = await connection.rpc("thread/turns/list", { threadId: receipt.thread_id, limit: 20, itemsView: "full", sortDirection: "desc", ...(cursor ? { cursor } : {}) });
      this.observeOwnedInput(receipt.source_id, receipt.thread_id, array(page.data));
      for (const turn of array(page.data)) {
        if (array(turn.items).some(item => item.type === "userMessage" && item.clientId === receipt.request_id)) {
          receipt.outcome = "accepted"; receipt.turn_id = string(turn.id); this.receipts.update(receipt); return this.publicReceipt(receipt);
        }
      }
      cursor = string(page.nextCursor) || undefined;
      if (!cursor || seen.has(cursor)) break;
      seen.add(cursor);
    }
    return this.publicReceipt(receipt);
  }

  private async respond(connection: NativeConnection, operation: Extract<ExternalChatOperation, { operation: "respond" }>): Promise<{ accepted: true }> {
    const request = connection.pending(operation.thread_id).find(request => request.id === operation.request_id);
    if (!request) throw new ChatError("native_request_unknown", "此请求不属于当前连接，或已被其他客户端处理。");
    const normalized = nativeRequest(request);
    if (!normalized) throw new ChatError("native_request_unsupported", "不支持此原生请求。");
    if (normalized.kind === "user_input") {
      const answers = operation.answers;
      const questions = array(request.params.questions);
      if (!answers || questions.some(question => !Array.isArray(answers[string(question.id)]) || answers[string(question.id)].length === 0)
        || Object.entries(answers).some(([key, values]) => !questions.some(question => question.id === key) || !Array.isArray(values) || values.some(value => typeof value !== "string" || value.length > EXTERNAL_CHAT_MAX_TEXT_CHARS))) throw new ChatError("invalid_answers", "请填写原生请求中的全部问题。");
      connection.respond(request.id, { answers: Object.fromEntries(Object.entries(answers).map(([key, values]) => [key, { answers: values }])) });
    } else {
      const decision = operation.decision;
      if (!decision || !["accept", "decline", "cancel"].includes(decision)) throw new ChatError("invalid_decision", "请选择明确的审批结果。");
      if (normalized.kind === "permissions_approval") {
        connection.respond(request.id, { permissions: decision === "accept" ? object(request.params.permissions) : {}, scope: "turn" });
        if (decision === "cancel") await connection.rpc("turn/interrupt", { threadId: normalized.thread_id, turnId: normalized.turn_id });
      } else {
        if (Array.isArray(request.params.availableDecisions) && !request.params.availableDecisions.includes(decision)) throw new ChatError("invalid_decision", "原生客户端未提供这个审批选项。");
        connection.respond(request.id, { decision });
      }
    }
    return { accepted: true };
  }

  private publicReceipt(receipt: SavedReceipt): ExternalChatReceipt {
    return { request_id: receipt.request_id, thread_id: receipt.thread_id, turn_id: receipt.turn_id, outcome: receipt.outcome };
  }

  private async serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const preceding = this.locks.get(key) ?? Promise.resolve();
    const current = preceding.catch(() => {}).then(run);
    this.locks.set(key, current);
    try { return await current; } finally { if (this.locks.get(key) === current) this.locks.delete(key); }
  }

  close(): Promise<void> {
    this.closed = true;
    if (!this.closePromise) {
      this.closePromise = Promise.allSettled([...this.connections.values()].map(async connection => (await connection).close()))
        .then(() => { this.connections.clear(); });
    }
    return this.closePromise;
  }
}
