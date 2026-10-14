/**
 * Opt-in real Codex smoke: temporary native Home + loopback Responses fixture.
 * No user histories, credentials, business repositories or external models.
 * Run: bun run tests/integration/external-codex-chat.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexExternalChats } from "@daemon/external-chats/index.js";
import { connectNative, object, string, type NativeConnection } from "@daemon/external-chats/native.js";
import { startMultiremiServer } from "@multiremi/api/server.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store/store.js";
import { DaemonProtocolClient, type DaemonProtocolLane } from "@multiremi/worker/daemon-protocol-client.js";
import { installedExternalCodexCommand, registerDaemonExternalChats } from "@multiremi/worker/external-chats.js";
import type { ExternalChatCatalog, ExternalChatHistory, ExternalChatList, ExternalChatReceipt } from "@multiremi/contracts/external-chats.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "remi-native-chat-")));
const home = join(root, ".codex"), cwd = join(root, "project");
mkdirSync(home, { mode: 0o700 });
mkdirSync(cwd, { mode: 0o700 });
const command = process.env.REMI_EXTERNAL_CHAT_CODEX_BIN
  ? { codexBinary: process.env.REMI_EXTERNAL_CHAT_CODEX_BIN, codexArgs: [] }
  : installedExternalCodexCommand();
const binary = command.codexBinary, args = command.codexArgs;
let seed: NativeConnection | undefined;
let driver: CodexExternalChats | undefined;
let platform: ReturnType<typeof startMultiremiServer> | undefined;
let protocol: DaemonProtocolClient | undefined;
let handler: ReturnType<typeof registerDaemonExternalChats> | undefined;
let modelRequests = 0;
const database = openSqliteDatabase(join(root, "platform.sqlite"));
const models = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/responses") return new Response("Not found", { status: 404 });
    await request.arrayBuffer();
    const number = ++modelRequests;
    const events = [
      { type: "response.created", response: { id: `fixture_response_${number}` } },
      { type: "response.output_item.done", item: { type: "message", role: "assistant", id: `fixture_message_${number}`,
        content: [{ type: "output_text", text: `native_fixture_reply_${number}` }] } },
      { type: "response.completed", response: { id: `fixture_response_${number}`,
        usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } });
  },
});

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}

try {
  writeFileSync(join(home, "config.toml"), [
    'model = "gpt-5"', 'model_provider = "native_fixture"', 'approval_policy = "never"', 'sandbox_mode = "read-only"',
    '[model_providers.native_fixture]', 'name = "Native fixture"', `base_url = "http://127.0.0.1:${models.port}/v1"`,
    'wire_api = "responses"', 'requires_openai_auth = false', 'supports_websockets = false', "",
  ].join("\n"), { mode: 0o600 });
  writeFileSync(join(home, "AGENTS.md"), "Fixture instructions: return the model response without running tools.\n", { mode: 0o600 });
  const configBefore = readFileSync(join(home, "config.toml"), "utf8");
  const instructionsBefore = readFileSync(join(home, "AGENTS.md"), "utf8");

  // A test-only native client creates the source conversation before Remi sees it.
  seed = await connectNative(home, { codexBinary: binary, codexArgs: args, uid: process.getuid?.() });
  const started = await seed.rpc("thread/start", { cwd });
  const threadId = string(object(started.thread).id);
  assert(threadId);
  const original = await seed.rpc("turn/start", { threadId, input: [{ type: "text", text: "native_fixture_original_input" }] });
  const originalTurnId = string(object(original.turn).id);
  const originalHistory = await until(async () => seed!.rpc("thread/turns/list", { threadId, limit: 5, itemsView: "full", sortDirection: "desc" }),
    page => Array.isArray(page.data) && page.data.some(turn => object(turn).id === originalTurnId && object(turn).status === "completed"), "original native turn");
  assert.equal(modelRequests, 1);
  assert(Array.isArray(originalHistory.data));
  await seed.close();
  seed = undefined;

  const store = new MultiremiStore(database);
  store.ensureLocalWorkspace();
  const runtimeId = "rt_external_native_fixture", daemonId = "dmn_external_native_fixture";
  store.registerRuntime({ id: runtimeId, name: "Codex native fixture", provider: "codex", daemonId,
    workspaceId: "local", metadata: { external_chats: 1 } });
  const resourceCount = () => ["multiremi_projects", "multiremi_chat_sessions"].map(table =>
    database.query(`SELECT COUNT(*) AS count FROM ${table}`).get());
  const before = resourceCount();
  platform = startMultiremiServer({ store, authToken: "external-native-fixture", scheduler: null,
    backgroundJobs: false, apiRole: "all", hostname: "127.0.0.1", port: 0 });
  const url = `http://127.0.0.1:${platform.port}`;
  driver = new CodexExternalChats({ home: root, baseHome: home, codexBinary: binary, codexArgs: args, stateDir: join(root, "receipts") });
  protocol = new DaemonProtocolClient({ serverUrl: url, token: "external-native-fixture", daemonId,
    cliVersion: "0.2.90", log: { warn() {} } });
  handler = registerDaemonExternalChats(protocol, () => runtimeId, () => driver!);
  const lane: DaemonProtocolLane = {
    runtime: () => ({ runtime_id: runtimeId, provider: "codex", max_concurrency: 1, active_task_ids: [], capabilities: { external_chats: 1 } }),
    heartbeat: () => ({ active_task_count: 0, outbox: { pending: 0, unacked: 0 } }),
    onHeartbeatAck: async () => {},
    probeUpgrade: async () => {},
    onTerminal: async () => {},
  };
  protocol.addLane(lane);
  protocol.startLane(lane);
  await until(async () => protocol!.connectionState(), state => state === "connected", "daemon handshake");
  const request = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(url + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer external-native-fixture", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    assert(response.ok, `HTTP ${response.status}: ${JSON.stringify(data)}`);
    return data as T;
  };
  const base = `/api/runtimes/${runtimeId}/external-chats`;
  const catalog = await request<ExternalChatCatalog>(base);
  assert.equal(catalog.warnings.length, 0);
  const source = catalog.sources.find(source => source.home === home);
  assert(source);
  const list = await request<ExternalChatList>(`${base}/${source.id}/threads`);
  assert.equal(list.chats.length, 1);
  assert.equal(list.chats[0]!.id, threadId);
  assert.equal(list.chats[0]!.cwd, cwd);
  // Stored summaries legitimately omit model until the native thread is loaded.
  assert(list.chats[0]!.model === null || list.chats[0]!.model === "gpt-5");
  assert.equal(list.chats[0]!.model_provider, "native_fixture");
  const path = `${base}/${source.id}/threads/${threadId}`;
  const initial = await request<ExternalChatHistory>(path);
  assert(initial.turns.some(turn => turn.items.some(item => item.text === "native_fixture_reply_1")));
  const requestId = randomUUID();
  const input = { text: "native_fixture_continue_in_remi", request_id: requestId };
  const receipt = await request<ExternalChatReceipt>(`${path}/messages`, input);
  assert.equal(receipt.outcome, "accepted");
  assert.equal(receipt.thread_id, threadId);
  assert(receipt.turn_id);
  const completed = await until(() => request<ExternalChatHistory>(path),
    history => history.turns.some(turn => turn.id === receipt.turn_id && turn.status === "completed"), "Remi native continuation");
  assert(completed.turns.some(turn => turn.items.some(item => item.text === "native_fixture_reply_2")));
  assert.equal(completed.chat.model, "gpt-5");
  assert.equal(completed.chat.model_provider, "native_fixture");
  assert.equal(completed.chat.cwd, cwd);
  assert(completed.turns.some(turn => turn.items.some(item => item.text === input.text)));
  assert.deepEqual(await request<ExternalChatReceipt>(`${path}/messages`, input), receipt);
  assert.deepEqual(await request<ExternalChatReceipt>(`${path}/receipts/${requestId}`), receipt);
  assert.equal(modelRequests, 2, "Repeated send must not execute another native turn");
  assert.equal((await request<ExternalChatList>(`${base}/${source.id}/threads`)).chats.length, 1, "No hidden thread/start or fork");
  assert.deepEqual(resourceCount(), before, "No mutable Remi Project or Chat created");
  assert.equal(readFileSync(join(home, "config.toml"), "utf8"), configBefore);
  assert.equal(readFileSync(join(home, "AGENTS.md"), "utf8"), instructionsBefore);
  console.log(JSON.stringify({ ok: true, native_thread_unchanged: true, source_config_unchanged: true,
    model_requests: modelRequests, repeated_send_deduplicated: true, remi_resources_unchanged: true }));
} finally {
  protocol?.close();
  await handler?.close();
  await driver?.close();
  await seed?.close();
  platform?.stop(true);
  models.stop(true);
  database.close();
  rmSync(root, { recursive: true, force: true });
}
