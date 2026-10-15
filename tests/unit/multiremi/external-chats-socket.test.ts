import { describe, expect, it } from "bun:test";
import { EXTERNAL_CHAT_RPC_MAX_BYTES, type ExternalChatOperation, type ExternalChatRpcResult } from "@multiremi/contracts/external-chats.js";
import { SocketExternalChatClient, type SocketExternalChatClientOptions } from "@multiremi/api/external-chats/socket-client.js";
import type { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import type { DaemonProtocolSession } from "@multiremi/api/daemon-protocol/session.js";
import type { DaemonParsedFrame } from "@multiremi/api/daemon-protocol/frames.js";

const threadId = "019b0000-0000-7000-8000-000000000001";
const requestId = "019b0000-0000-7000-8000-000000000002";
const send: ExternalChatOperation = { operation: "send", source_id: "local", thread_id: threadId, request_id: requestId, text: "Continue here" };
const catalog = { ok: true, data: { sources: [], warnings: [] } } satisfies ExternalChatRpcResult;
const receipt = { ok: true, data: { thread_id: threadId, request_id: requestId, turn_id: null, outcome: "accepted" } } satisfies ExternalChatRpcResult;
const chat = { id: threadId, source_id: "local", project_id: null, native_project_id: null, title: "Fixture", cwd: "/fixture",
  created_at: 1, updated_at: 2, status: "idle", model: "fixture", model_provider: "fixture", reasoning_effort: null, readonly: true };

function fixture(options: SocketExternalChatClientOptions = {}) {
  const sent: Array<{ id: string; frame: { t: string; rt: string; p: ExternalChatOperation } }> = [];
  const pending = new Set<string>();
  const session = {
    isClosed: false,
    request(id: string, frame: typeof sent[number]["frame"]) { sent.push({ id, frame }); pending.add(id); return id; },
    settleRequest: (id: string) => pending.delete(id),
  };
  let live = true;
  let reply!: (frame: DaemonParsedFrame, session: DaemonProtocolSession) => void;
  let close!: (session: DaemonProtocolSession) => void;
  const layer = {
    registry: { sessionForRuntime: () => live ? session : null },
    onReply: (listener: typeof reply) => { reply = listener; },
    onClose: (listener: typeof close) => { close = listener; },
  };
  const client = new SocketExternalChatClient(layer as unknown as DaemonProtocolLayer, options);
  return {
    client, sent, pending,
    reply: (id: string, payload: unknown, rt?: string, otherSession = false) => reply(
      { re: id, payload, ...(rt ? { rt } : {}) } as DaemonParsedFrame,
      (otherSession ? {} : session) as unknown as DaemonProtocolSession,
    ),
    refuse: () => { session.request = () => null as unknown as string; },
    close: () => { live = false; session.isClosed = true; close(session as unknown as DaemonProtocolSession); },
  };
}

describe("external Chat reverse RPC", () => {
  it("bounds each socket to four active and 32 queued and admits waiters in order", async () => {
    const f = fixture();
    const jobs = Array.from({ length: 36 }, (_, i) => f.client.request(`rt_${i}`, { operation: "catalog" }));
    expect(f.sent).toHaveLength(4);
    expect(f.pending.size).toBe(4);
    expect(await f.client.request("overflow", { operation: "catalog" })).toMatchObject({ ok: false, code: "daemon_busy" });

    f.reply(f.sent[0]!.id, catalog, "rt_0");
    expect(await jobs[0]).toEqual(catalog);
    expect(f.sent[4]!.frame).toEqual({ t: "external_chat.request", rt: "rt_4", p: { operation: "catalog" } });
    f.close();
    expect((await Promise.all(jobs.slice(1))).every(result => !result.ok && result.code === "daemon_unreachable")).toBe(true);
    expect(f.pending.size).toBe(0);
  });

  it("correlates replies with the exact connection, request and runtime", async () => {
    const f = fixture();
    const job = f.client.request("rt_own", send);
    const id = f.sent[0]!.id;
    f.reply(id, receipt, "rt_other");
    f.reply(id, receipt, "rt_own", true);
    f.reply("unrelated-id", receipt, "rt_own");
    expect(f.pending.has(id)).toBe(true);

    f.reply(id, receipt, "rt_own");
    expect(await job).toEqual(receipt);
    expect(f.pending.size).toBe(0);
    f.close();
  });

  it("disconnect marks dispatched writes unknown and leaves queued writes unsent", async () => {
    const f = fixture({ maxInFlight: 1 });
    const active = f.client.request("rt", send);
    const queued = f.client.request("rt", { ...send, request_id: "019b0000-0000-7000-8000-000000000003" });
    f.close();
    expect(await active).toMatchObject({ ok: false, code: "daemon_unreachable", outcome: "unknown" });
    expect(await queued).toEqual({ ok: false, code: "daemon_unreachable", message: "The owning Runtime disconnected" });
    expect(f.sent).toHaveLength(1);
    expect(f.pending.size).toBe(0);
    expect(await f.client.request("rt", send)).not.toHaveProperty("outcome");
  });

  it("expired queued writes are never dispatched when an active request times out", async () => {
    const f = fixture({ timeoutMs: 5, maxInFlight: 1 });
    const active = f.client.request("rt", send);
    const queued = f.client.request("rt", send);
    // Stall timer processing so both absolute deadlines expire before the first
    // timeout releases the slot. A queued timeout callback has not run yet.
    const until = Date.now() + 15;
    while (Date.now() < until) {}
    expect(await active).toMatchObject({ ok: false, code: "daemon_timeout", outcome: "unknown" });
    expect(await queued).toMatchObject({ ok: false, code: "daemon_timeout" });
    expect(await queued).not.toHaveProperty("outcome");
    expect(f.sent).toHaveLength(1);
    expect(f.pending.size).toBe(0);
    f.close();
  });

  it("a timed out send is not retried and a receipt read is a distinct request", async () => {
    const f = fixture({ timeoutMs: 5 });
    expect(await f.client.request("rt", send)).toMatchObject({ ok: false, code: "daemon_timeout", outcome: "unknown" });
    f.reply(f.sent[0]!.id, receipt, "rt");
    const lookup = f.client.request("rt", { operation: "receipt", source_id: "local", thread_id: threadId, request_id: requestId });
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]!.frame.p.operation).toBe("receipt");
    f.reply(f.sent[1]!.id, receipt, "rt");
    expect(await lookup).toEqual(receipt);
    f.close();
  });

  it("write transport refusal settles without retry or claiming a safe outcome", async () => {
    const f = fixture();
    f.refuse();
    expect(await f.client.request("rt", send)).toMatchObject({ ok: false, code: "daemon_unreachable", outcome: "unknown" });
    expect(f.pending.size).toBe(0);
    f.close();
  });

  it("enforces aggregate request bytes and releases the budget after completion", async () => {
    const bytes = Buffer.byteLength(JSON.stringify({ operation: "catalog" }));
    const f = fixture({ maxPendingBytes: bytes });
    const first = f.client.request("rt", { operation: "catalog" });
    expect(await f.client.request("rt", { operation: "catalog" })).toMatchObject({ ok: false, code: "daemon_busy" });
    f.reply(f.sent[0]!.id, catalog);
    await first;
    const next = f.client.request("rt", { operation: "catalog" });
    f.reply(f.sent[1]!.id, catalog);
    expect(await next).toEqual(catalog);
    expect(await f.client.request("rt", { ...send, text: "a".repeat(EXTERNAL_CHAT_RPC_MAX_BYTES) })).toMatchObject({ ok: false, code: "request_too_large" });
    expect(f.sent).toHaveLength(2);
    f.close();
  });

  it("malformed or oversized replies fail closed, including write outcome", async () => {
    const f = fixture();
    for (const payload of [{ ok: true, data: { ...receipt.data, thread_id: "foreign" } },
      { ok: true, data: { ...receipt.data, extra: "a".repeat(EXTERNAL_CHAT_RPC_MAX_BYTES) } },
      { ok: false, code: "failure", message: { nativeConfig: "private" } }]) {
      const job = f.client.request("rt", send);
      f.reply(f.sent.at(-1)!.id, payload);
      expect(await job).toMatchObject({ ok: false, code: "invalid_external_chat_response", outcome: "unknown" });
    }
    f.close();
  });

  it("projects frozen DTO fields and drops native config or credentials", async () => {
    const f = fixture();
    const job = f.client.request("rt", { operation: "catalog" });
    const source = { id: "local", name: "Local Codex", home: "/home/test/.codex", provider: "codex" as const, connection: "live" as const, projects: [] };
    f.reply(f.sent[0]!.id, { ok: true, data: { sources: [{ ...source, auth: "fixture-private", config: {} }], warnings: [], env: {} } });
    expect(await job).toEqual({ ok: true, data: { sources: [source], warnings: [] } });
    f.close();
  });

  it("projects source-scoped model pages while preserving native IDs, descriptions and cursors", async () => {
    const f = fixture();
    const models = [{ id: "provider/model", name: "Native model", description: "Catalog entry" }];
    for (const next_cursor of ["next:+/=", "x".repeat(4096), null]) {
      const job = f.client.request("rt", { operation: "models", source_id: "local", cursor: "cursor", limit: 1 });
      expect(f.sent.at(-1)!.frame.p).toEqual({ operation: "models", source_id: "local", cursor: "cursor", limit: 1 });
      f.reply(f.sent.at(-1)!.id, { ok: true, data: { source_id: "local", models: models.map(model => ({ ...model, config: {} })), next_cursor, auth: "fixture" } });
      expect(await job).toEqual({ ok: true, data: { source_id: "local", models, next_cursor } });
    }
    f.close();
  });

  it("rejects foreign model catalogs, malformed entries and unusable pagination", async () => {
    const f = fixture();
    const model = { id: "provider/model", name: "Model", description: "Native model" };
    const page = { source_id: "local", models: [model], next_cursor: null };
    for (const data of [
      { ...page, source_id: "foreign" }, { ...page, models: {} }, { ...page, models: [{ ...model, description: null }] },
      { ...page, models: [{ ...model, name: ["Model"] }] }, { ...page, models: [{ ...model, id: "" }] },
      { ...page, models: [{ ...model, id: "x".repeat(257) }] }, { ...page, models: [{ ...model, id: "provider/\nmodel" }] },
      { ...page, next_cursor: 2 }, { ...page, next_cursor: "" }, { ...page, next_cursor: "x".repeat(4097) },
      { ...page, next_cursor: "next\0cursor" }, { ...page, models: [model, model] },
    ]) {
      const job = f.client.request("rt", { operation: "models", source_id: "local", limit: 1 });
      f.reply(f.sent.at(-1)!.id, { ok: true, data });
      expect(await job).toMatchObject({ ok: false, code: "invalid_external_chat_response" });
    }
    f.close();
  });

  it("rejects history from a different source or thread despite a matching RPC envelope", async () => {
    const f = fixture();
    for (const changed of [{ ...chat, source_id: "foreign" }, { ...chat, id: requestId }]) {
      const job = f.client.request("rt", { operation: "read", source_id: "local", thread_id: threadId });
      f.reply(f.sent.at(-1)!.id, { ok: true, data: { chat: changed, turns: [], next_cursor: null, requests: [] } });
      expect(await job).toMatchObject({ ok: false, code: "invalid_external_chat_response" });
    }
    f.close();
  });

  it("rejects enum-shaped arrays instead of coercing malformed native results", async () => {
    const f = fixture();
    const item = { id: "item", type: "userMessage", role: ["user"], text: "Fixture" };
    const request = { id: "17", thread_id: threadId, turn_id: requestId, kind: ["user_input"], text: "Choose" };
    for (const data of [
      { chat: { ...chat, status: ["idle"] }, turns: [], next_cursor: null, requests: [] },
      { chat, turns: [{ id: requestId, status: "completed", items: [item] }], next_cursor: null, requests: [] },
      { chat, turns: [], next_cursor: null, requests: [request] },
    ]) {
      const job = f.client.request("rt", { operation: "read", source_id: "local", thread_id: threadId });
      f.reply(f.sent.at(-1)!.id, { ok: true, data });
      expect(await job).toMatchObject({ ok: false, code: "invalid_external_chat_response" });
    }
    f.close();
  });
});
