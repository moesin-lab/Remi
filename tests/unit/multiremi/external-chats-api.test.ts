import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import { SocketExternalChatClient } from "@multiremi/api/external-chats/socket-client.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
import { EXTERNAL_CHAT_RPC_MAX_BYTES, type ExternalChatClient, type ExternalChatOperation, type ExternalChatRpcResult } from "@multiremi/contracts/external-chats.js";
import { createLocalSnapshotStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const threadId = "019b0000-0000-7000-8000-000000000001";
const requestId = "019b0000-0000-7000-8000-000000000002";
const turnId = "019b0000-0000-7000-8000-000000000003";
const project = { id: "dir_project", kind: "directory" as const, name: "Fixture", roots: ["/home/fixture/dev"], readonly: true as const };
const chat = { id: threadId, source_id: "codex_local", project_id: project.id, native_project_id: null, title: "External fixture",
  cwd: "/home/fixture/dev", created_at: 1, updated_at: 2, status: "idle" as const, model: "fixture", model_provider: "fixture",
  reasoning_effort: null, readonly: true as const };
const catalog = { sources: [{ id: "codex_local", name: "Codex", home: "/home/fixture/.codex", provider: "codex" as const,
  connection: "live" as const, projects: [project] }], warnings: [] };

function dataFor(operation: ExternalChatOperation): ExternalChatRpcResult {
  switch (operation.operation) {
    case "catalog": return { ok: true, data: catalog };
    case "list": return { ok: true, data: { chats: [chat], projects: [project], next_cursor: null } };
    case "read": return { ok: true, data: { chat, turns: [], next_cursor: null, requests: [] } };
    case "send":
    case "receipt": return { ok: true, data: { thread_id: operation.thread_id, request_id: operation.request_id, turn_id: turnId, outcome: "accepted" } };
    default: return { ok: true, data: { accepted: true } };
  }
}

function fixture() {
  const store = createLocalSnapshotStore();
  const runtime = store.registerRuntime({ id: "rt_external", name: "External Codex", provider: "codex", workspaceId: "local",
    ownerId: "alice", visibility: "private", daemonId: "daemon_external", metadata: { external_chats: 1, codex_profiles: 1 } });
  const calls: Array<{ runtimeId: string; operation: ExternalChatOperation }> = [];
  const client: ExternalChatClient = { request: async (runtimeId, operation) => { calls.push({ runtimeId, operation }); return dataFor(operation); } };
  const app = createMultiremiApp({ store, authToken: "external-test-master", externalChatClient: client });
  const base = `/api/runtimes/${runtime.id}/external-chats`;
  const threads = `${base}/codex_local/threads`;
  const path = `${threads}/${threadId}`;
  const request = (target: string, input?: unknown, token = "external-test-master", headers: Record<string, string> = {}) => app.request(target, {
    method: input === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  return { store, runtime, client, calls, app, base, threads, path, request };
}

describe("external Chat HTTP contract and authorization", () => {
  it("implements all seven routes as native projections without creating Remi resources", async () => {
    const f = fixture();
    const resourceTables = ["multiremi_projects", "multiremi_chat_sessions"];
    const before = resourceTables.map(table => db!.query(`SELECT COUNT(*) AS count FROM ${table}`).get());
    const tasksBefore = f.store.listTasks();
    const cases: Array<[string, unknown, ExternalChatOperation, number]> = [
      [f.base, undefined, { operation: "catalog" }, 200],
      [`${f.threads}?project_id=dir_project&cursor=opaque:next&limit=5`, undefined,
        { operation: "list", source_id: "codex_local", project_id: "dir_project", cursor: "opaque:next", limit: 5 }, 200],
      [`${f.path}?cursor=turn:cursor&limit=2`, undefined,
        { operation: "read", source_id: "codex_local", thread_id: threadId, cursor: "turn:cursor", limit: 2 }, 200],
      [`${f.path}/messages`, { text: "  Continue unchanged  ", request_id: requestId },
        { operation: "send", source_id: "codex_local", thread_id: threadId, text: "  Continue unchanged  ", request_id: requestId }, 202],
      [`${f.path}/receipts/${requestId}`, undefined,
        { operation: "receipt", source_id: "codex_local", thread_id: threadId, request_id: requestId }, 200],
      [`${f.path}/interrupt`, { turn_id: turnId }, { operation: "interrupt", source_id: "codex_local", thread_id: threadId, turn_id: turnId }, 200],
      [`${f.path}/requests/17`, { decision: "accept" },
        { operation: "respond", source_id: "codex_local", thread_id: threadId, request_id: "17", decision: "accept" }, 200],
    ];
    for (const [target, input, operation, status] of cases) {
      const response = await f.request(target, input);
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual((dataFor(operation) as Extract<ExternalChatRpcResult, { ok: true }>).data);
      expect(f.calls.at(-1)).toEqual({ runtimeId: f.runtime.id, operation });
    }
    expect(resourceTables.map(table => db!.query(`SELECT COUNT(*) AS count FROM ${table}`).get())).toEqual(before);
    expect(f.store.listTasks()).toEqual(tasksBefore);
  });

  it("shares private Runtime content with another authenticated human in the workspace", async () => {
    const f = fixture();
    const bob = f.store.getOrCreateUser({ email: "bob@example.test", name: "Bob" });
    const token = await f.store.createAccessToken({ name: "Bob session", type: "pat", purpose: "session", userId: bob.id, workspaceId: "local" });
    expect((await f.request(f.base, undefined, token.token)).status).toBe(200);
    expect(f.calls).toHaveLength(1);
  });

  it("denies task and daemon credentials on every external route before any native RPC", async () => {
    const f = fixture();
    const agent = f.store.createAgent({ name: "Fixture agent", provider: "codex" });
    const task = f.store.createTask({ agentId: agent.id, prompt: "Fixture task" });
    const taskToken = await f.store.createAccessToken({ name: "Fixture task", type: "task", purpose: "task", taskId: task.id, agentId: agent.id, workspaceId: "local" });
    const daemonToken = await f.store.createAccessToken({ name: "Fixture daemon", type: "daemon", userId: "alice", daemonId: "daemon_external", workspaceId: "local" });
    for (const token of [taskToken, daemonToken]) {
      for (const [target, input] of [[f.base], [f.threads], [f.path], [`${f.path}/messages`, { text: "x", request_id: requestId }],
        [`${f.path}/receipts/${requestId}`], [`${f.path}/interrupt`, { turn_id: turnId }], [`${f.path}/requests/17`, { decision: "accept" }]] as const) {
        expect((await f.request(target, input, token.token)).status).toBe(403);
      }
    }
    expect(f.calls).toHaveLength(0);
  });

  it("rejects foreign or unknown workspace selections and preserves selected non-local resource scope", async () => {
    const f = fixture();
    const user = f.store.getOrCreateUser({ email: "workspace@example.test", name: "Fixture owner" });
    const workspace = f.store.createWorkspace({ name: "Team", slug: "external-team" }, user.id);
    const token = await f.store.createAccessToken({ name: "Human session", type: "pat", purpose: "session", userId: user.id, workspaceId: "local" });
    expect((await f.request(f.base, undefined, token.token, { "X-Workspace-ID": workspace.id })).status).toBe(404);
    expect((await f.request(f.base, undefined, token.token, { "X-Workspace-Slug": "missing" })).status).toBe(404);
    expect(f.calls).toHaveLength(0);
    const teamRuntime = f.store.registerRuntime({ id: "rt_team", name: "Team Codex", provider: "codex", workspaceId: workspace.id,
      ownerId: "alice", metadata: { external_chats: 1 } });
    const teamPath = `/api/runtimes/${teamRuntime.id}/external-chats`;
    expect((await f.request(teamPath, undefined, token.token, { "X-Workspace-Slug": workspace.slug })).status).toBe(200);
    expect((await f.request(teamPath, undefined, token.token, { "X-Workspace-ID": "local" })).status).toBe(404);
    expect(f.calls).toHaveLength(1);
  });

  it("keeps machine PAT workspace scope and invalid bearer authentication", async () => {
    const f = fixture();
    const user = f.store.getOrCreateUser({ email: "scope@example.test", name: "Fixture" });
    const workspace = f.store.createWorkspace({ name: "Other", slug: "external-other" }, user.id);
    const token = await f.store.createAccessToken({ name: "Scoped PAT", type: "pat", workspaceId: workspace.id });
    expect((await f.request(f.base, undefined, token.token)).status).toBe(404);
    expect((await f.request(f.base, undefined, "invalid-token")).status).toBe(401);
    expect(f.calls).toHaveLength(0);
  });

  it("returns actionable 503 for an older Runtime, another provider or missing transport", async () => {
    const f = fixture();
    f.store.updateRuntime(f.runtime.id, { metadata: {} });
    expect(await (await f.request(f.base)).json()).toMatchObject({ code: "external_chats_unsupported" });
    const claude = f.store.registerRuntime({ id: "rt_other_provider", name: "Claude", provider: "claude", metadata: { external_chats: 1 } });
    expect((await f.request(`/api/runtimes/${claude.id}/external-chats`)).status).toBe(503);
    f.store.updateRuntime(f.runtime.id, { metadata: { external_chats: 1 } });
    const app = createMultiremiApp({ store: f.store });
    const response = await app.request(f.base);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "external_chats_unavailable" });
    expect(f.calls).toHaveLength(0);
  });

  it("rejects paths, configuration overrides, malformed IDs, unknown and repeated queries", async () => {
    const f = fixture();
    const invalid: Array<[string, unknown?]> = [
      [`${f.base}?home=/tmp/native`], [`${f.threads}?socket=/tmp/native.sock`], [`${f.threads}?project_id=../private`],
      [`${f.threads}?limit=51`], [`${f.threads}?limit=1&limit=2`], [`${f.path}?cursor=%00`],
      [`${f.base}/%2Ftmp%2Fhome/threads`], [`${f.base}/..%5Cprivate/threads`],
      [`${f.threads}/not-a-uuid`], [`${f.path}/receipts/17`],
      [`${f.path}/messages`, { text: "x", request_id: "17" }],
      [`${f.path}/messages`, { text: "x", request_id: requestId, home: "/tmp/other" }],
      [`${f.path}/messages`, { text: "x", request_id: requestId, native_method: "thread/start" }],
      [`${f.path}/messages`, { text: "x", request_id: requestId, config: { model: "override" } }],
      [`${f.path}/messages`, { text: "\0", request_id: requestId }],
      [`${f.path}/messages`, { text: "x".repeat(32_001), request_id: requestId }],
      [`${f.path}/interrupt`, { turn_id: "not-a-uuid" }],
      [`${f.path}/requests/17`, { decision: "accept", answers: {} }],
      [`${f.path}/requests/17`, { decision: "approve-anything" }],
    ];
    for (const [target, input] of invalid) expect((await f.request(target, input)).status).toBe(400);
    expect(f.calls).toHaveLength(0);
  });

  it("preserves textual native question IDs while rejecting oversized, control and prototype keys", async () => {
    const f = fixture();
    const answers = { "choose directory": ["Continue"], "选择目录": ["继续"], ["界".repeat(256)]: ["Bounded"] };
    expect((await f.request(`${f.path}/requests/17`, { answers })).status).toBe(200);
    expect(f.calls[0]!.operation).toMatchObject({ operation: "respond", request_id: "17", answers });

    for (const key of ["", "界".repeat(257), "__proto__", "constructor", "prototype", "question\nname", "question\0name", "\x7f", "\x85"]) {
      // Object.fromEntries makes __proto__ an own JSON key, so the test covers
      // the actual wire payload rather than object-literal prototype syntax.
      const invalid = { answers: Object.fromEntries([[key, ["Reply"]]]) };
      expect((await f.request(`${f.path}/requests/17`, invalid)).status).toBe(400);
    }
    expect(f.calls).toHaveLength(1);
  });

  it("bounds actual body bytes even with multibyte JSON and accepts native user-input replies", async () => {
    const f = fixture();
    const oversized = { answers: { q: Array(20).fill("界".repeat(32_000)) } };
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(EXTERNAL_CHAT_RPC_MAX_BYTES);
    const response = await f.request(`${f.path}/requests/17`, oversized);
    expect(response.status).toBe(413);
    expect(f.calls).toHaveLength(0);
    expect((await f.request(`${f.path}/requests/17`, { answers: { choice: ["Continue"] } })).status).toBe(200);
    expect(f.calls[0]!.operation).toMatchObject({ operation: "respond", request_id: "17", answers: { choice: ["Continue"] } });
  });

  it("returns unknown write outcomes without resending and maps typed native failures", async () => {
    const f = fixture();
    f.client.request = async (runtimeId, operation) => {
      f.calls.push({ runtimeId, operation });
      return { ok: false, code: "daemon_timeout", message: "No confirmation", outcome: "unknown" };
    };
    const response = await f.request(`${f.path}/messages`, { text: "Continue", request_id: requestId });
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "No confirmation", code: "daemon_timeout", outcome: "unknown" });
    expect(f.calls).toHaveLength(1);
    f.client.request = async () => { throw new Error("fixture-native-details-not-for-user"); };
    expect(await (await f.request(`${f.path}/interrupt`, { turn_id: turnId })).json()).toMatchObject({ code: "daemon_unreachable", outcome: "unknown" });
    for (const [code, status] of [["thread_not_found", 404], ["thread_locked", 409], ["invalid_request", 400]] as const) {
      f.client.request = async () => ({ ok: false, code, message: "Fixture error" });
      expect((await f.request(f.path)).status).toBe(status);
    }
  });
});

it("records external capability through real hello and heartbeat without modifying Runtime execution configuration", async () => {
  const f = fixture();
  f.store.setRuntimeCodexProfile(f.runtime.id, { name: "fixture_profile", base_url: "https://fixture.example/v1", model: "fixture",
    env_key: "REMI_CODEX_EXTERNAL_TEST_KEY", auth_mode: "env" });
  f.store.updateRuntime(f.runtime.id, { metadata: { kept: "fixture", external_chats: 0, codex_profiles: 1 } });
  const before = f.store.getRuntime(f.runtime.id)!;
  const profileBefore = f.store.getRuntimeCodexProfile(f.runtime.id);
  const tables = ["multiremi_execution_group_members", "multiremi_execution_profiles", "multiremi_runtime_codex_profiles"];
  const configs = tables.map(table => db!.query(`SELECT * FROM ${table}`).all());
  const layer = new DaemonProtocolLayer({ store: f.store });
  const frames: Array<Record<string, any>> = [];
  const session = layer.openSession({ send: encoded => { frames.push(JSON.parse(encoded)); return Buffer.byteLength(encoded); }, close: () => {} },
    { masterToken: true, accessToken: null });
  try {
    await session.handleMessage(JSON.stringify({ v: 2, t: "hello", p: { protocol: 2, cli_version: DAEMON_MIN_CLI_VERSION,
      daemon_id: "daemon_external", runtimes: [{ runtime_id: f.runtime.id, provider: "codex", max_concurrency: 1,
        active_task_ids: [], capabilities: { external_chats: 1, codex_profiles: 1 } }] } }));
    expect(frames.some(frame => frame.t === "welcome")).toBe(true);
    expect(f.store.getRuntime(f.runtime.id)?.metadata).toMatchObject({ kept: "fixture", external_chats: 1 });

    await session.handleMessage(JSON.stringify({ v: 2, t: "hb", p: { runtimes: [{ runtime_id: f.runtime.id, capabilities: { codex_profiles: 1 } }] } }));
    const after = f.store.getRuntime(f.runtime.id)!;
    expect(after.metadata).toMatchObject({ kept: "fixture", external_chats: 0 });
    for (const key of ["executionGroupId", "workspaceId", "ownerId", "visibility", "models"] as const) {
      expect(after[key]).toEqual(before[key]);
    }
    expect(f.store.getRuntimeCodexProfile(f.runtime.id)).toEqual(profileBefore);
    expect(tables.map(table => db!.query(`SELECT * FROM ${table}`).all())).toEqual(configs);
  } finally { session.handleSocketClose(); layer.stop(); }
});

it("proxies HTTP through an actual daemon session and associates the native receipt without creating a Task", async () => {
  const f = fixture();
  const layer = new DaemonProtocolLayer({ store: f.store });
  const client = new SocketExternalChatClient(layer);
  const app = createMultiremiApp({ store: f.store, externalChatClient: client });
  const frames: Array<Record<string, any>> = [];
  const session = layer.openSession({ send: encoded => { frames.push(JSON.parse(encoded)); return Buffer.byteLength(encoded); }, close: () => {} },
    { masterToken: true, accessToken: null });
  try {
    await session.handleMessage(JSON.stringify({ v: 2, t: "hello", p: { protocol: 2, cli_version: DAEMON_MIN_CLI_VERSION,
      daemon_id: "daemon_external", runtimes: [{ runtime_id: f.runtime.id, provider: "codex", max_concurrency: 1,
        active_task_ids: [], capabilities: { external_chats: 1 } }] } }));
    const response = app.request(`${f.path}/messages`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Continue native session", request_id: requestId }) });
    await Bun.sleep(0);
    const outbound = frames.find(frame => frame.t === "external_chat.request");
    expect(outbound).toMatchObject({ rt: f.runtime.id, p: { operation: "send", thread_id: threadId, request_id: requestId } });
    await session.handleMessage(JSON.stringify({ v: 2, t: "res", re: outbound!.id, rt: f.runtime.id,
      p: dataFor(outbound!.p as ExternalChatOperation) }));
    const result = await response;
    expect(result.status).toBe(202);
    expect(await result.json()).toEqual({ thread_id: threadId, request_id: requestId, turn_id: turnId, outcome: "accepted" });
    expect(f.store.listTasks()).toHaveLength(0);
  } finally { session.handleSocketClose(); layer.stop(); }
});
