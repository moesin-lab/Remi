import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { CodexExternalChats } from "@daemon/external-chats/index.js";
import { connectNative, NativeError, supportedNativeRequest, type NativeConnection, type NativeObject, type NativeRequest } from "@daemon/external-chats/native.js";
import { discoverSources, hash } from "@daemon/external-chats/sources.js";
import type { ExternalChatCatalog, ExternalChatHistory, ExternalChatList, ExternalChatModels, ExternalChatReceipt } from "@multiremi/contracts/external-chats";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

class FakeNative implements NativeConnection {
  connection = "live" as const;
  version = "0.162.1";
  closed = false;
  attached = new Set<string>();
  calls: { method: string; params: NativeObject }[] = [];
  requests: NativeRequest[] = [];
  replies: NativeObject[] = [];
  models: NativeObject[] = [{ model: "source-model", displayName: "Source model", description: "From this home", hidden: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }] }];
  thread: NativeObject = { id: "thread_a", cwd: "/work/app", source: "vscode", model: "source-model", modelProvider: "source-provider", reasoningEffort: "high", historyMode: "paginated", status: { type: "notLoaded" } };
  history: NativeObject[] = [{ id: "turn_old", status: "completed", items: [{ id: "message_old", type: "agentMessage", text: "old" }] }];
  loseAcknowledgement = false;
  unsupportedPaging = false;
  startDelay = 0;
  override?: (method: string, params: NativeObject) => NativeObject | undefined;

  async rpc(method: string, params: NativeObject = {}): Promise<NativeObject> {
    this.calls.push({ method, params });
    const overridden = this.override?.(method, params);
    if (overridden) return overridden;
    if (method === "project/list") return { data: [{ id: "project_a", name: "Native", roots: [{ path: "/work" }] }, { id: "project_b", name: "Overlap", roots: [{ path: "/work/app" }] }], nextCursor: null };
    if (method === "thread/list") return { data: [this.thread], nextCursor: null };
    if (method === "model/list") return { data: this.models, nextCursor: null };
    if (method === "thread/read") {
      if (params.threadId !== this.thread.id) throw new NativeError(-32600, "thread not found");
      return { thread: { ...this.thread, ...(params.includeTurns ? { turns: this.history } : {}) } };
    }
    if (method === "thread/resume") { this.thread.status = { type: "idle" }; return { thread: { ...this.thread, canAcceptDirectInput: true }, model: "source-model" }; }
    if (method === "thread/turns/list") {
      if (this.unsupportedPaging) throw new NativeError(-32601, "method not found");
      return { data: this.history.slice().reverse().slice(0, Number(params.limit)), nextCursor: null };
    }
    if (method === "turn/start") {
      if (this.startDelay) await Bun.sleep(this.startDelay);
      this.history.push({ id: "turn_new", status: "inProgress", items: [{ id: "message_new", type: "userMessage", clientId: params.clientUserMessageId, content: params.input }] });
      if (this.loseAcknowledgement) throw new NativeError("native_connection_closed");
      return { turn: { id: "turn_new" } };
    }
    if (method === "turn/interrupt") return {};
    throw new NativeError(-32601);
  }

  pending(id: string): NativeRequest[] { return this.requests.filter(request => request.params.threadId === id); }
  respond(id: string, result: NativeObject): void { this.replies.push(result); this.requests = this.requests.filter(request => request.id !== id); }
  async close(): Promise<void> { this.closed = true; }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "remi-external-chats-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const user = join(root, "user");
  const home = join(user, ".codex");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.toml"), 'model = "SOURCE_ONLY"\n');
  writeFileSync(join(home, "auth.json"), "PRIVATE_FIXTURE_AUTH_DO_NOT_READ");
  const native = new FakeNative();
  const options = { home: user, baseHome: "", stateDir: join(root, "state"), connectionFactory: async () => native };
  const driver = new CodexExternalChats(options);
  cleanups.push(() => driver.close());
  const source = discoverSources(user, "")[0]!.id;
  return { root, user, home, native, driver, options, source };
}

// This connector requires OS UID ownership and Unix sockets/process groups; Windows does not advertise it.
describe.skipIf(typeof process.getuid !== "function")("external Codex chats", () => {
  it("keeps canonical sources scoped to the OS owner and excludes managed isolated homes", () => {
    const f = fixture();
    symlinkSync(f.home, join(f.user, ".codex-alias"));
    mkdirSync(join(f.user, ".runtime", "home"), { recursive: true });
    expect(discoverSources(f.user, join(f.user, ".runtime", "home"))).toHaveLength(1);
    expect(discoverSources(f.user, "", process.getuid!() + 1)).toEqual([]);
  });

  it("binds source IDs to the directory identity and rejects old IDs after same-path replacement", async () => {
    const f = fixture();
    await f.driver.request({ operation: "list", source_id: f.source });
    const before = f.native.calls.length;
    renameSync(f.home, join(f.root, "old-home"));
    mkdirSync(f.home);
    const replacement = discoverSources(f.user, "")[0]!;
    expect(replacement.id).not.toBe(f.source);
    expect(replacement.home).toBe(realpathSync(f.home));
    expect(await f.driver.request({ operation: "list", source_id: f.source })).toMatchObject({ ok: false, code: "source_not_found" });
    expect(await f.driver.request({ operation: "send", source_id: f.source, thread_id: "thread_a", request_id: "request_a", text: "hello" })).toMatchObject({ ok: false, code: "source_not_found" });
    expect(f.native.calls).toHaveLength(before);
    expect((await f.driver.request({ operation: "list", source_id: replacement.id })).ok).toBe(true);
  });

  it("groups unassigned chats by exact cwd without guessing an overlapping native project", async () => {
    const f = fixture();
    const result = await f.driver.request({ operation: "catalog" });
    expect(result.ok).toBe(true);
    const catalog = (result as { ok: true; data: ExternalChatCatalog }).data;
    expect(catalog.sources[0]!.projects.map(project => project.kind)).toEqual(["native", "native", "directory"]);
    const list = await f.driver.request({ operation: "list", source_id: f.source });
    const chats = (list as { ok: true; data: ExternalChatList }).data.chats;
    expect(chats[0]!.native_project_id).toBeNull();
    expect(chats[0]!.project_id).toStartWith("directory:");
    expect(f.native.calls.filter(call => call.method === "thread/list").every(call => call.params.useStateDbOnly === true && Array.isArray(call.params.modelProviders)
      && call.params.sortKey === "updated_at" && call.params.sortDirection === "desc")).toBe(true);
  });

  it("reads paged history without resuming and bounds text while preserving oldest-first order", async () => {
    const f = fixture();
    f.native.history.push({ id: "turn_second", status: "completed", items: [{ id: "large", type: "agentMessage", text: "x".repeat(100_000) }] });
    const result = await f.driver.request({ operation: "read", source_id: f.source, thread_id: "thread_a" });
    const history = (result as { ok: true; data: ExternalChatHistory }).data;
    expect(history.turns.map(turn => turn.id)).toEqual(["turn_old", "turn_second"]);
    expect(history.turns[1]!.items[0]!.text).toHaveLength(32_000);
    expect(history.turns[1]!.items[0]!.truncated).toBe(true);
    expect(f.native.calls.some(call => call.method === "thread/resume")).toBe(false);
  });

  it("renders structured historical tool output without exposing raw reasoning or image bytes", async () => {
    const f = fixture();
    f.native.history = [{ id: "turn_old", status: "completed", items: [
      { id: "mcp", type: "mcpToolCall", server: "server", tool: "lookup", result: { content: [{ type: "text", text: "tool result" }, { type: "image", data: "PRIVATE_FAKE_IMAGE_BYTES" }] } },
      { id: "function", type: "functionCallOutput", output: [{ type: "input_text", text: "function output" }] },
      { id: "reasoning", type: "reasoning", summary: ["summary"], content: ["RAW_REASONING_DO_NOT_DISPLAY"] },
    ] }];
    const result = await f.driver.request({ operation: "read", source_id: f.source, thread_id: "thread_a" }) as { ok: true; data: ExternalChatHistory };
    expect(result.data.turns[0]!.items.map(item => item.text)).toEqual(["server/lookup\ntool result\n[image]", "function output", "summary"]);
  });

  it("only uses legacy full-read compatibility on a proven 0.154 server", async () => {
    const f = fixture();
    f.native.version = "0.154.0-alpha.6.2";
    f.native.unsupportedPaging = true;
    f.native.thread.historyMode = "legacy";
    const result = await f.driver.request({ operation: "read", source_id: f.source, thread_id: "thread_a" });
    expect(result.ok).toBe(true);
    expect(f.native.calls.some(call => call.method === "thread/read" && call.params.includeTurns === true)).toBe(true);
    f.native.version = "0.162.1";
    expect((await f.driver.request({ operation: "read", source_id: f.source, thread_id: "thread_a" })).ok).toBe(false);
  });

  it("rejects forged source paths, arbitrary thread IDs, and subagent continuation", async () => {
    const f = fixture();
    expect((await f.driver.request({ operation: "list", source_id: "../other" })).ok).toBe(false);
    expect((await f.driver.request({ operation: "read", source_id: "codex_foreign", thread_id: "thread_a" })).ok).toBe(false);
    f.native.thread.source = { subAgent: { threadSpawn: {} } };
    expect((await f.driver.request({ operation: "send", source_id: f.source, thread_id: "thread_a", text: "hello", request_id: "request_a" })).ok).toBe(false);
    expect(f.native.calls.some(call => call.method === "turn/start")).toBe(false);
  });

  it("rejects known busy state without steering or creating a thread", async () => {
    const f = fixture();
    f.native.thread.status = { type: "active" };
    const result = await f.driver.request({ operation: "send", source_id: f.source, thread_id: "thread_a", text: "hello", request_id: "request_a" });
    expect(result).toMatchObject({ ok: false, code: "native_busy" });
    expect(f.native.calls.map(call => call.method)).toEqual(["thread/read"]);
    delete f.native.thread.status;
    expect(await f.driver.request({ operation: "send", source_id: f.source, thread_id: "thread_a", text: "hello", request_id: "request_a" })).toMatchObject({ ok: false, code: "thread_not_writable" });
  });

  it("preserves native model and sandbox configuration, serializes duplicate writes, and persists receipts", async () => {
    const f = fixture();
    f.native.startDelay = 15;
    f.native.override = method => {
      if (method === "turn/start") {
        const directory = join(f.root, "state", "receipts");
        const file = readFileSync(join(directory, readdirSync(directory)[0]!), "utf8");
        expect(JSON.parse(file)).toMatchObject({ request_id: "request_a", thread_id: "thread_a", outcome: "unknown", turn_id: null });
        expect(file.includes("hello")).toBe(false);
      }
      return undefined;
    };
    const operation = { operation: "send" as const, source_id: f.source, thread_id: "thread_a", text: "hello", request_id: "request_a" };
    const results = await Promise.all([f.driver.request(operation), f.driver.request(operation)]);
    expect(results.every(result => result.ok)).toBe(true);
    expect(f.native.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
    expect(f.native.calls.find(call => call.method === "thread/resume")!.params).toEqual({ threadId: "thread_a", excludeTurns: true });
    expect(f.native.calls.find(call => call.method === "turn/start")!.params).toEqual({ threadId: "thread_a", input: [{ type: "text", text: "hello" }], clientUserMessageId: "request_a" });
    expect(f.native.calls.some(call => ["thread/start", "thread/fork"].includes(call.method))).toBe(false);
    const again = new CodexExternalChats(f.options);
    cleanups.push(() => again.close());
    expect((await again.request(operation) as { ok: true; data: ExternalChatReceipt }).data.outcome).toBe("accepted");
    expect((await again.request({ ...operation, text: "changed" })).ok).toBe(false);
    expect(readFileSync(join(f.home, "config.toml"), "utf8")).toBe('model = "SOURCE_ONLY"\n');
    expect(readFileSync(join(f.home, "auth.json"), "utf8")).toBe("PRIVATE_FIXTURE_AUTH_DO_NOT_READ");
  });

  it("never resends an unknown write and uses native clientId to reconcile a lost acknowledgement", async () => {
    const f = fixture();
    f.native.loseAcknowledgement = true;
    const operation = { operation: "send" as const, source_id: f.source, thread_id: "thread_a", text: "hello", request_id: "request_a" };
    expect((await f.driver.request(operation) as { ok: true; data: ExternalChatReceipt }).data.outcome).toBe("unknown");
    const again = new CodexExternalChats(f.options);
    cleanups.push(() => again.close());
    const result = await again.request(operation) as { ok: true; data: ExternalChatReceipt };
    expect(result.data.outcome).toBe("accepted");
    expect(f.native.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
  });

  it("lists the selected source's paged visible models without resuming a thread", async () => {
    const f = fixture();
    f.native.override = (method, params) => method === "model/list" ? { data: [
      { ...f.native.models[0], model: "gateway/model-next", displayName: "Next" },
      { ...f.native.models[0], model: "hidden", hidden: true },
    ], nextCursor: "page_two" } : undefined;
    const result = await f.driver.request({ operation: "models", source_id: f.source, cursor: "page_one", limit: 2 }) as { ok: true; data: ExternalChatModels };
    expect(result).toEqual({ ok: true, data: { source_id: f.source, models: [{ id: "gateway/model-next", name: "Next", description: "From this home" }], next_cursor: "page_two" } });
    expect(f.native.calls).toEqual([{ method: "model/list", params: { limit: 2, includeHidden: false, cursor: "page_one" } }]);
    expect((await f.driver.request({ operation: "models", source_id: "codex_foreign" })).ok).toBe(false);
    expect(f.native.calls).toHaveLength(1);
  });

  it("validates a selected model across native pages and uses its default only for incompatible effort", async () => {
    const f = fixture();
    f.native.override = (method, params) => {
      if (method !== "model/list") return undefined;
      return params.cursor ? { data: [{ ...f.native.models[0], model: "gateway/model-next", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }], nextCursor: null }
        : { data: f.native.models, nextCursor: "next" };
    };
    const operation = { operation: "send" as const, source_id: f.source, thread_id: "thread_a", text: "switch", request_id: "request_switch", model: "gateway/model-next" };
    expect((await f.driver.request(operation)).ok).toBe(true);
    expect(f.native.calls.filter(call => call.method === "model/list").map(call => call.params.cursor)).toEqual([undefined, "next"]);
    expect(f.native.calls.find(call => call.method === "turn/start")!.params).toEqual({ threadId: "thread_a", input: [{ type: "text", text: "switch" }], clientUserMessageId: "request_switch", model: "gateway/model-next", effort: "medium" });
    expect(f.native.calls.find(call => call.method === "thread/resume")!.params).toEqual({ threadId: "thread_a", excludeTurns: true });
    expect(readFileSync(join(f.home, "config.toml"), "utf8")).toBe('model = "SOURCE_ONLY"\n');
    const again = new CodexExternalChats(f.options);
    cleanups.push(() => again.close());
    expect((await again.request(operation)).ok).toBe(true);
    expect(await again.request({ ...operation, model: "source-model" })).toMatchObject({ ok: false, code: "receipt_binding_mismatch" });
    expect(await again.request({ ...operation, model: undefined })).toMatchObject({ ok: false, code: "receipt_binding_mismatch" });
    expect(f.native.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
  });

  it("preserves a known compatible native effort when explicitly selecting a model", async () => {
    const f = fixture();
    expect((await f.driver.request({ operation: "send", source_id: f.source, thread_id: "thread_a", text: "hello", request_id: "request_model", model: "source-model" })).ok).toBe(true);
    expect(f.native.calls.find(call => call.method === "turn/start")!.params.model).toBe("source-model");
    expect(f.native.calls.find(call => call.method === "turn/start")!.params).not.toHaveProperty("effort");
  });

  it("rejects unavailable models, malformed catalogs and cursor loops before resume or native input", async () => {
    const f = fixture();
    const operation = { operation: "send" as const, source_id: f.source, thread_id: "thread_a", text: "hello", request_id: "request_model", model: "foreign-model" };
    expect(await f.driver.request(operation)).toMatchObject({ ok: false, code: "model_not_available" });
    f.native.override = method => method === "model/list" ? { data: [{ ...f.native.models[0], model: "malformed\nmodel" }], nextCursor: null } : undefined;
    expect(await f.driver.request(operation)).toMatchObject({ ok: false, code: "native_model_catalog_invalid" });
    f.native.override = method => method === "model/list" ? { data: [], nextCursor: "loop" } : undefined;
    expect(await f.driver.request(operation)).toMatchObject({ ok: false, code: "native_cursor_invalid" });
    expect(f.native.calls.some(call => ["thread/resume", "turn/start"].includes(call.method))).toBe(false);
  });

  it("binds an unknown acknowledgement to the original model without a second write", async () => {
    const f = fixture();
    f.native.loseAcknowledgement = true;
    const operation = { operation: "send" as const, source_id: f.source, thread_id: "thread_a", text: "hello", request_id: "request_model", model: "source-model" };
    expect(await f.driver.request(operation)).toMatchObject({ ok: true, data: { outcome: "unknown" } });
    expect(await f.driver.request({ ...operation, model: "another-model" })).toMatchObject({ ok: false, code: "receipt_binding_mismatch" });
    expect(await f.driver.request(operation)).toMatchObject({ ok: true, data: { outcome: "accepted" } });
    expect(f.native.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
  });

  it("blocks new requests after ACK until the owned turn is published and terminal even while native status is idle", async () => {
    const f = fixture();
    let started = 0;
    f.native.override = method => method === "turn/start" ? { turn: { id: ++started === 1 ? "turn_pending" : "turn_next", status: "inProgress" } } : undefined;
    const first = { operation: "send" as const, source_id: f.source, thread_id: "thread_a", text: "first", request_id: "request_a" };
    const next = { ...first, text: "next", request_id: "request_b" };
    expect((await f.driver.request(first) as { ok: true; data: ExternalChatReceipt }).data.outcome).toBe("accepted");
    expect(f.native.thread.status).toEqual({ type: "idle" });
    expect(await f.driver.request(next)).toMatchObject({ ok: false, code: "native_busy" });
    expect((await f.driver.request(first) as { ok: true; data: ExternalChatReceipt }).data.outcome).toBe("accepted");
    expect(started).toBe(1);
    f.native.history.push({ id: "turn_pending", status: "inProgress", items: [] });
    expect(await f.driver.request(next)).toMatchObject({ ok: false, code: "native_busy" });
    f.native.history.at(-1)!.status = "completed";
    expect((await f.driver.request({ operation: "read", source_id: f.source, thread_id: "thread_a" })).ok).toBe(true);
    expect((await f.driver.request(next)).ok).toBe(true);
    expect(started).toBe(2);
  });

  it("blocks new requests after an unknown write until native clientId history proves the turn terminal", async () => {
    const f = fixture();
    f.native.override = method => { if (method === "turn/start") throw new NativeError("native_request_timeout"); return undefined; };
    const first = { operation: "send" as const, source_id: f.source, thread_id: "thread_a", text: "first", request_id: "request_a" };
    const next = { ...first, text: "next", request_id: "request_b" };
    expect((await f.driver.request(first) as { ok: true; data: ExternalChatReceipt }).data.outcome).toBe("unknown");
    expect(await f.driver.request(next)).toMatchObject({ ok: false, code: "native_busy" });
    expect((await f.driver.request(first) as { ok: true; data: ExternalChatReceipt }).data.outcome).toBe("unknown");
    expect(f.native.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
    f.native.history.push({ id: "turn_pending", status: "inProgress", items: [{ id: "message", type: "userMessage", clientId: "request_a", content: [{ type: "text", text: "first" }] }] });
    expect((await f.driver.request(first) as { ok: true; data: ExternalChatReceipt }).data.outcome).toBe("accepted");
    expect(await f.driver.request(next)).toMatchObject({ ok: false, code: "native_busy" });
    f.native.history.at(-1)!.status = "failed";
    f.native.override = undefined;
    expect((await f.driver.request(next)).ok).toBe(true);
    expect(f.native.calls.filter(call => call.method === "turn/start")).toHaveLength(2);
  });

  it("fails closed on a linked receipt before any native input can be written", async () => {
    const f = fixture();
    const receipts = join(f.root, "state", "receipts");
    mkdirSync(receipts, { recursive: true });
    symlinkSync(join(f.home, "auth.json"), join(receipts, hash(`${f.source}\0request_a`) + ".json"));
    expect((await f.driver.request({ operation: "send", source_id: f.source, thread_id: "thread_a", text: "hello", request_id: "request_a" })).ok).toBe(false);
    expect(f.native.calls).toEqual([]);
    expect(readFileSync(join(f.home, "auth.json"), "utf8")).toBe("PRIVATE_FIXTURE_AUTH_DO_NOT_READ");
  });

  it("bounds catalog scans at 5000 indexed chats and caches directory discovery", async () => {
    const f = fixture();
    f.native.override = (method, params) => {
      if (method !== "thread/list") return undefined;
      const offset = Number(params.cursor ?? 0);
      return { data: Array.from({ length: 200 }, (_, i) => ({ ...f.native.thread, id: `thread_${offset + i}` })), nextCursor: String(offset + 200) };
    };
    const first = await f.driver.request({ operation: "catalog" }) as { ok: true; data: ExternalChatCatalog };
    expect(first.data.warnings.some(warning => warning.code === "catalog_truncated")).toBe(true);
    expect(f.native.calls.filter(call => call.method === "thread/list")).toHaveLength(25);
    await f.driver.request({ operation: "catalog" });
    expect(f.native.calls.filter(call => call.method === "thread/list")).toHaveLength(25);
  });

  it("does not open another source after shutdown interrupts catalog discovery", async () => {
    const f = fixture();
    mkdirSync(join(f.user, ".codex-second"));
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = f.native.rpc.bind(f.native);
    f.native.rpc = async (method, params) => {
      entered();
      await gate;
      if (f.native.closed) throw new NativeError("native_connection_closed");
      return original(method, params);
    };
    let created = 0;
    const driver = new CodexExternalChats({ ...f.options, connectionFactory: async () => { created++; return f.native; } });
    cleanups.push(() => driver.close());
    const catalog = driver.request({ operation: "catalog" });
    await started;
    const closing = driver.close();
    expect(driver.close()).toBe(closing);
    await closing;
    release();
    expect(await catalog).toMatchObject({ ok: false, code: "source_closed" });
    expect(created).toBe(1);
  });

  it("only answers delivered requests from this connection and bridges question answer schemas", async () => {
    const f = fixture();
    expect((await f.driver.request({ operation: "respond", source_id: f.source, thread_id: "thread_a", request_id: "unknown", decision: "accept" })).ok).toBe(false);
    f.native.requests.push({ id: "native_question", nativeId: 7, method: "item/tool/requestUserInput", params: { threadId: "thread_a", turnId: "turn_a", questions: [{ id: "q", header: "Choice", question: "Continue?" }] } });
    const result = await f.driver.request({ operation: "respond", source_id: f.source, thread_id: "thread_a", request_id: "native_question", answers: { q: ["yes"] } });
    expect(result.ok).toBe(true);
    expect(f.native.replies).toEqual([{ answers: { q: { answers: ["yes"] } } }]);
    expect((await f.driver.request({ operation: "respond", source_id: f.source, thread_id: "thread_a", request_id: "native_question", answers: { q: ["again"] } })).ok).toBe(false);
  });

  it("rejects incomplete approval presentation and oversized question fields before they can be granted", async () => {
    const f = fixture();
    const approval = "item/commandExecution/requestApproval";
    const input = "item/tool/requestUserInput";
    const base = { threadId: "thread_a", turnId: "turn_a" };
    const question = { id: "q", header: "Choice", question: "Continue?", options: [{ label: "yes", description: "Proceed" }] };
    expect(supportedNativeRequest(approval, { ...base, command: "x".repeat(32_001) })).toBe(false);
    expect(supportedNativeRequest("item/permissions/requestApproval", { ...base, permissions: { fileSystem: { write: ["x".repeat(32_001)] } } })).toBe(false);
    for (const questions of [
      Array.from({ length: 21 }, (_, i) => ({ ...question, id: `q_${i}` })),
      [{ ...question, header: "x".repeat(101) }], [{ ...question, question: "x".repeat(4_001) }],
      [{ ...question, options: Array.from({ length: 31 }, () => question.options[0]) }],
      [{ ...question, options: [{ label: "x".repeat(241), description: "Proceed" }] }],
      [{ ...question, options: [{ label: "yes", description: "x".repeat(1_001) }] }],
      [{ ...question, id: "bad\u0000id" }], [{ ...question, id: "bad\u0085id" }], [{ ...question, id: "x".repeat(257) }],
      [{ ...question, id: "constructor" }], [{ ...question, id: "prototype" }], [{ ...question, id: "__proto__" }],
    ]) expect(supportedNativeRequest(input, { ...base, questions })).toBe(false);
    f.native.requests.push({ id: "huge", nativeId: "huge_native", method: approval, params: { ...base, command: "x".repeat(32_001) } });
    expect(await f.driver.request({ operation: "respond", source_id: f.source, thread_id: "thread_a", request_id: "huge", decision: "accept" })).toMatchObject({ ok: false, code: "native_request_unsupported" });
    expect(f.native.replies).toEqual([]);
    const id = "选择 directory";
    f.native.requests = [{ id: "choice_a", nativeId: 10, method: input, params: { ...base, questions: [{ ...question, id }] } }];
    expect(supportedNativeRequest(input, f.native.requests[0]!.params)).toBe(true);
    expect((await f.driver.request({ operation: "respond", source_id: f.source, thread_id: "thread_a", request_id: "choice_a", answers: { [id]: ["yes"] } })).ok).toBe(true);
    expect(f.native.replies).toEqual([{ answers: { [id]: { answers: ["yes"] } } }]);
  });

  it("discloses complete requested permissions and grants only that profile for the current turn", async () => {
    const f = fixture();
    const permissions = { fileSystem: { write: ["/work/app", "/work/another"] }, network: { enabled: true } };
    f.native.requests.push({ id: "permission_a", nativeId: 9, method: "item/permissions/requestApproval", params: { threadId: "thread_a", turnId: "turn_a", permissions, reason: "Write and check", cwd: "/work/app" } });
    const read = await f.driver.request({ operation: "read", source_id: f.source, thread_id: "thread_a" }) as { ok: true; data: ExternalChatHistory };
    expect(JSON.parse(read.data.requests[0]!.text)).toEqual({ reason: "Write and check", cwd: "/work/app", permissions });
    expect((await f.driver.request({ operation: "respond", source_id: f.source, thread_id: "thread_a", request_id: "permission_a", decision: "accept" })).ok).toBe(true);
    expect(f.native.replies).toEqual([{ permissions, scope: "turn" }]);
  });

  it("keeps history readable when a native client must handle a request", async () => {
    const f = fixture();
    f.native.requests.push({ id: "unsupported", nativeId: 8, method: "item/tool/call", params: { threadId: "thread_a", turnId: "turn_a" } });
    expect(await f.driver.request({ operation: "read", source_id: f.source, thread_id: "thread_a" })).toMatchObject({ ok: true, data: { turns: [{ id: "turn_old" }], requests: [] } });
    expect(await f.driver.request({ operation: "respond", source_id: f.source, thread_id: "thread_a", request_id: "unsupported", decision: "accept" })).toMatchObject({ ok: false, code: "native_request_unsupported" });
    expect(f.native.replies).toEqual([]);
  });

  it("requires the explicit currently active turn before interruption", async () => {
    const f = fixture();
    f.native.thread.status = { type: "active" };
    expect((await f.driver.request({ operation: "interrupt", source_id: f.source, thread_id: "thread_a", turn_id: "turn_missing" })).ok).toBe(false);
    expect(f.native.calls.some(call => call.method === "turn/interrupt")).toBe(false);
    f.native.history.push({ id: "turn_running", status: "inProgress", items: [] });
    expect((await f.driver.request({ operation: "interrupt", source_id: f.source, thread_id: "thread_a", turn_id: "turn_running" })).ok).toBe(true);
  });

  it("connects to a fake live Unix WebSocket without launching any native executable", async () => {
    const f = fixture();
    const socket = join(f.home, "app-server-control", "app-server-control.sock");
    mkdirSync(join(f.home, "app-server-control"));
    const server = createServer();
    const wss = new WebSocketServer({ server });
    const calls: NativeObject[] = [];
    const compressionOffers: unknown[] = [];
    server.on("upgrade", request => compressionOffers.push(request.headers["sec-websocket-extensions"]));
    let initializedHome = f.home;
    let userAgent = "Codex Desktop/0.154.0 (Linux Unknown; x86_64)";
    wss.on("connection", ws => ws.on("message", data => {
      const message = JSON.parse(data.toString()) as NativeObject;
      calls.push(message);
      if (message.method === "thread/read") {
        ws.send(JSON.stringify({ id: "tool_native", method: "item/tool/call", params: { threadId: "thread_a", turnId: "turn_a" } }));
        ws.send(JSON.stringify({ id: "auth_native", method: "account/chatgptAuthTokens/refresh", params: {} }));
        ws.send(JSON.stringify({ id: "huge_native", method: "item/commandExecution/requestApproval", params: { threadId: "thread_a", turnId: "turn_a", command: "x".repeat(32_001) } }));
        ws.send(JSON.stringify({ id: "questions_native", method: "item/tool/requestUserInput", params: { threadId: "thread_a", turnId: "turn_a", questions: Array.from({ length: 21 }, (_, i) => ({ id: `q_${i}`, header: "Choice", question: "Continue?" })) } }));
        ws.send(JSON.stringify({ id: "approval_native", method: "item/commandExecution/requestApproval", params: { threadId: "thread_a", turnId: "turn_a" } }));
      }
      if (message.id && message.method) ws.send(JSON.stringify({ id: message.id, result: message.method === "initialize" ? { codexHome: initializedHome, userAgent }
        : message.method === "thread/read" ? { thread: f.native.thread }
        : message.method === "thread/turns/list" ? { data: f.native.history } : { data: [] } }));
    }));
    await new Promise<void>(resolve => server.listen(socket, resolve));
    cleanups.push(() => { for (const client of wss.clients) client.terminate(); wss.close(); server.closeAllConnections(); server.close(); });
    const connection = await connectNative(f.home, { uid: process.getuid!(), codexBinary: "/NEVER_EXECUTE_MISSING_BINARY" });
    cleanups.push(() => connection.close());
    expect(connection.connection).toBe("live");
    expect(connection.version).toBe("0.154.0");
    expect(compressionOffers).toEqual([undefined]);
    await connection.rpc("thread/list", { useStateDbOnly: true });
    expect(calls[0]!.params).toMatchObject({ clientInfo: { name: "codex-backend" }, capabilities: { experimentalApi: true } });
    await connection.rpc("thread/read", { threadId: "thread_a" });
    await Bun.sleep(10);
    // A shared app-server broadcasts requests. An error from this observer would
    // win the response race and prevent the original client from completing it.
    expect(calls.filter(call => call.error || call.result)).toEqual([]);
    expect(connection.pending("thread_a").map(request => request.nativeId)).toEqual(["approval_native"]);
    const driver = new CodexExternalChats({ ...f.options, connectionFactory: async () => connection });
    cleanups.push(() => driver.close());
    expect(await driver.request({ operation: "read", source_id: f.source, thread_id: "thread_a" })).toMatchObject({
      ok: true, data: { turns: [{ id: "turn_old" }], requests: [{ kind: "command_approval" }] },
    });
    expect(calls.filter(call => call.error || call.result)).toEqual([]);
    for (const ws of wss.clients) ws.send(JSON.stringify({ method: "serverRequest/resolved", params: { requestId: "approval_native" } }));
    await connection.rpc("thread/list", { useStateDbOnly: true });
    expect(connection.pending("thread_a")).toEqual([]);
    userAgent = "codex-tui/0.162.1 (Mac OS 15; arm64)";
    const tui = await connectNative(f.home, { uid: process.getuid!(), codexBinary: "/NEVER_EXECUTE_MISSING_BINARY" });
    cleanups.push(() => tui.close());
    expect(tui.version).toBe("0.162.1");
    userAgent = "Unknown Client/0.154.0";
    const unknown = await connectNative(f.home, { uid: process.getuid!(), codexBinary: "/NEVER_EXECUTE_MISSING_BINARY" });
    cleanups.push(() => unknown.close());
    expect(unknown.version).toBe("");
    initializedHome = f.user;
    await expect(connectNative(f.home, { uid: process.getuid!(), codexBinary: "/NEVER_EXECUTE_MISSING_BINARY" })).rejects.toMatchObject({ code: "source_home_mismatch" });
  });

  it("uses fake stdio with the exact command prefix and original home, without provider overrides", async () => {
    const f = fixture();
    const script = join(f.root, "fake-codex.cjs");
    const capture = join(f.root, "capture.jsonl");
    writeFileSync(script, `const fs=require('node:fs');if(process.argv.includes('--version')){console.log('codex-cli 0.162.1');process.exit(0)};fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),home:process.env.CODEX_HOME})+'\\n');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id)console.log(JSON.stringify({id:m.id,result:m.method==='initialize'?{codexHome:process.env.CODEX_HOME,userAgent:'codex_cli_rs/0.162.1'}:{data:[]}}))});`);
    const connection = await connectNative(f.home, { uid: process.getuid!(), codexBinary: process.execPath, codexArgs: [script] });
    cleanups.push(() => connection.close());
    expect(connection.connection).toBe("isolated");
    expect(connection.version).toBe("0.162.1");
    expect(JSON.parse(readFileSync(capture, "utf8").trim())).toEqual({ args: ["app-server", "--listen", "stdio://"], home: realpathSync(f.home) });
  });

  it("rejects unsupported callbacks only on an isolated process without blocking subsequent reads", async () => {
    const f = fixture();
    const script = join(f.root, "fake-private-codex.cjs");
    writeFileSync(script, `
      if (process.argv.includes('--version')) { console.log('codex-cli 0.162.1'); process.exit(0); }
      const replies = [];
      const send = value => console.log(JSON.stringify(value));
      require('node:readline').createInterface({input: process.stdin}).on('line', line => {
        const message = JSON.parse(line);
        if (!message.method) { replies.push(message); return; }
        if (message.method === 'initialized') return;
        if (message.method === 'thread/read') {
          send({id: 'private_tool', method: 'item/tool/call', params: {threadId: 'thread_a', turnId: 'turn_a'}});
          send({id: 'private_auth', method: 'account/chatgptAuthTokens/refresh', params: {}});
        }
        send({id: message.id, result: message.method === 'initialize'
          ? {codexHome: process.env.CODEX_HOME, userAgent: 'codex_cli_rs/0.162.1'}
          : message.method === 'thread/read' ? {thread: ${JSON.stringify(f.native.thread)}}
          : message.method === 'test/replies' ? {replies}
          : {data: ${JSON.stringify(f.native.history)}}});
      });
    `);
    const connection = await connectNative(f.home, { uid: process.getuid!(), codexBinary: process.execPath, codexArgs: [script] });
    cleanups.push(() => connection.close());
    const driver = new CodexExternalChats({ ...f.options, connectionFactory: async () => connection });
    cleanups.push(() => driver.close());
    expect(await driver.request({ operation: "read", source_id: f.source, thread_id: "thread_a" })).toMatchObject({
      ok: true, data: { turns: [{ id: "turn_old" }], requests: [] },
    });
    expect((await connection.rpc("test/replies")).replies).toEqual([
      { id: "private_tool", error: { code: -32601, message: "Remi does not support this native client request" } },
      { id: "private_auth", error: { code: -32601, message: "Remi does not support this native client request" } },
    ]);
  });

  it("closes a malformed fake stdio process even when it ignores EOF and SIGTERM", async () => {
    const f = fixture();
    const script = join(f.root, "fake-stubborn-codex.cjs");
    const pidFile = join(f.root, "child-pid");
    writeFileSync(script, `const fs=require('node:fs');if(process.argv.includes('--version')){console.log('codex-cli 0.162.1');process.exit(0)};fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{codexHome:process.env.CODEX_HOME,userAgent:'codex_cli_rs/0.162.1'}}));else if(m.id)console.log('MALFORMED_FAKE_RESPONSE')});`);
    const connection = await connectNative(f.home, { uid: process.getuid!(), codexBinary: process.execPath, codexArgs: [script] });
    cleanups.push(() => connection.close());
    await expect(connection.rpc("thread/list", { useStateDbOnly: true })).rejects.toMatchObject({ code: "native_protocol_invalid" });
    const closing = connection.close();
    expect(connection.close()).toBe(closing);
    await closing;
    expect(connection.closed).toBe(true);
    expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow();
  }, 10_000);

  it("terminates owned group descendants after the fake app-server leader exits on EOF", async () => {
    const f = fixture();
    const script = join(f.root, "fake-parent-codex.cjs");
    const childScript = join(f.root, "fake-background.cjs");
    const childPid = join(f.root, "background-pid");
    const parentExit = join(f.root, "parent-exit");
    writeFileSync(childScript, `require('node:fs').writeFileSync(${JSON.stringify(childPid)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
    writeFileSync(script, `const fs=require('node:fs');if(process.argv.includes('--version')){console.log('codex-cli 0.162.1');process.exit(0)};require('node:child_process').spawn(process.execPath,[${JSON.stringify(childScript)}],{stdio:'ignore'}).unref();const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize'){const ready=setInterval(()=>{if(fs.existsSync(${JSON.stringify(childPid)})){clearInterval(ready);console.log(JSON.stringify({id:m.id,result:{codexHome:process.env.CODEX_HOME,userAgent:'codex_cli_rs/0.162.1'}}))}},10)}});rl.on('close',()=>{fs.writeFileSync(${JSON.stringify(parentExit)},'EOF');process.exit(0)});`);
    const connection = await connectNative(f.home, { uid: process.getuid!(), codexBinary: process.execPath, codexArgs: [script] });
    cleanups.push(() => connection.close());
    await connection.close();
    expect(readFileSync(parentExit, "utf8")).toBe("EOF");
    expect(() => process.kill(Number(readFileSync(childPid, "utf8")), 0)).toThrow();
  }, 10_000);
});
