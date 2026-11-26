import { afterAll, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeishuBotCommandRequest } from "@multiremi/contracts/types.js";
import type { FeishuSenderAuthorizer } from "@connectors/feishu/config.js";
import { FeishuInboundRecovery, feishuHistoryEvent } from "@connectors/feishu/inbound-recovery.js";
import { createFeishuInboundDelivery } from "@connectors/feishu/receive.js";

const root = mkdtempSync(join(tmpdir(), "feishu-command-stages-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fixture() {
  const path = join(root, crypto.randomUUID());
  const calls: FeishuBotCommandRequest[] = [], uuids: string[] = [], payloads: string[] = [];
  let now = Date.now(), receipts = 0, tasks = 0;
  const knobs = { allowed: true, failReceipt: false, words: ["助手"], revision: 2, botId: "bot", appId: "app", domain: "feishu" as FeishuBotCommandRequest["semantic"]["domain"],
    execute: async (_request: FeishuBotCommandRequest): Promise<string | null> => "result",
    send: async () => ({ code: 0, data: { message_id: "om_card" } }) };
  const send = async ({ data }: { data: { uuid: string; content: string } }) => { uuids.push(data.uuid); payloads.push(data.content); return knobs.send(); };
  const client = { im: { message: { create: send, reply: send } }, request: async () => {
    receipts++;
    return { code: knobs.failReceipt ? 99991672 : 0, data: { items: [] } };
  } } as any;
  const open = (disk = true) => {
    const journal = new FeishuInboundRecovery(disk ? path : null, () => now);
    const authorize: FeishuSenderAuthorizer = async () => knobs.allowed;
    authorize.commands = { botId: knobs.botId, revision: knobs.revision, execute: async request => {
      calls.push(request);
      const value = await knobs.execute(request);
      return value === null ? null : { name: "status", snapshot: { chatSessionId: value, task: null } };
    }, render: result => ({ text: result.name === "status" ? result.snapshot.chatSessionId! : "", displayName: "Remi" }) };
    const deliver = createFeishuInboundDelivery({ recovery: disk ? journal : null, client, appId: knobs.appId, domain: knobs.domain,
      wakeWords: knobs.words, authorizeSender: authorize, botIdentity: { botOpenId: "ou_bot", botOpenIdReady: Promise.resolve() }, onMessage: async () => { tasks++; } });
    return { accept: (input: ReturnType<typeof event>) => disk ? journal.accept(input, deliver) : deliver(input), replay: () => journal.replay(deliver), close: () => journal.close() };
  };
  function event(text: string, history = false, thread = "thread", sender = "ou_user") {
    const input = feishuHistoryEvent({ message_id: "om_same", create_time: String(now - 1), root_id: thread, msg_type: "text",
      sender: { sender_type: "user", id_type: "open_id", id: sender }, body: { content: JSON.stringify({ text }) } }, "oc_chat", "group")!;
    if (!history) delete input.recovery_source;
    return input;
  }
  return { path, knobs, calls, uuids, payloads, open, event, advance: (ms: number) => { now += ms; }, counts: () => ({ receipts, tasks }), state: () => JSON.parse(readFileSync(path, "utf8")) };
}

for (const change of ["prefix", "target", "session", "sender", "args", "no-admission"]) it(`binds history before live changes ${change}`, async () => {
  const test = fixture();
  const history = test.open();
  const text = change === "prefix" ? "助手 /status /new" : "助手 /stop MUL-1";
  await history.accept(test.event(text, true));
  history.close();
  if (change === "prefix") test.knobs.words = ["助手 /status"];
  if (change === "no-admission") test.knobs.words = [];
  const live = test.open();
  await live.accept(test.event(change === "target" ? "助手 /stop MUL-2" : change === "args" ? "助手 /stop  MUL-1" : text, false,
    change === "session" ? "different" : "thread", change === "sender" ? "ou_other" : "ou_user"));
  test.knobs.words = ["助手"];
  await test.open().accept(test.event(text));
  expect([test.calls.length, test.uuids.length, test.counts().tasks, test.counts().receipts]).toEqual([0, 0, 0, 0]);
});

it("retains a status 503 across restart and the terminal retention period", async () => {
  const test = fixture(), first = test.open();
  test.knobs.execute = async () => { throw new Error("503"); };
  await expect(first.accept(test.event("助手 /status"))).rejects.toThrow("503");
  first.close(); test.advance(2 * 3600_000);
  test.knobs.execute = async () => "cached status";
  const next = test.open();
  await Promise.all([next.replay(), next.accept(test.event("助手 /status"))]);
  expect(test.calls.map(call => call.semantic.name)).toEqual(["status", "status"]);
  expect(test.uuids).toHaveLength(1);
  expect(test.state().pending).toEqual({});
});

for (const outcome of ["retry", "expired", "revoked", "switch-bot"]) it(`reuses saved result after lost card response: ${outcome}`, async () => {
  const test = fixture(), first = test.open();
  test.knobs.send = async () => { throw new Error("response lost"); };
  await expect(first.accept(test.event("助手 /status"))).rejects.toThrow();
  expect(test.state().progress.om_same.reply).toMatchObject({ card: { schema: "2.0" }, uncertain: true });
  first.close();
  test.knobs.send = async () => ({ code: 0, data: { message_id: "om_received" } });
  if (outcome === "expired") test.advance(60 * 60_000);
  if (outcome === "revoked") test.knobs.allowed = false;
  if (outcome === "switch-bot") test.knobs.botId = "other";
  await test.open().replay();
  expect(test.calls).toHaveLength(1);
  expect(test.uuids).toHaveLength(outcome === "retry" ? 2 : 1);
  expect(new Set(test.uuids).size).toBe(1);
  expect(new Set(test.payloads).size).toBe(1);
  if (outcome === "expired") expect(test.state().skipped.at(-1).reason).toBe("command_reply_delivery_unknown");
  expect(test.state().pending).toEqual({});
});

for (const change of ["same", "revision", "different-operation"]) it(`recovers uncertain write after ${change}`, async () => {
  const test = fixture(), first = test.open();
  test.knobs.execute = async () => { throw new Error("lost after commit"); };
  await expect(first.accept(test.event("助手 /stop /new"))).rejects.toThrow("lost after commit");
  first.close();
  if (change === "revision") test.knobs.revision++;
  if (change === "different-operation") test.knobs.words = ["助手 /stop"];
  test.knobs.execute = async () => "original result";
  await test.open().replay();
  expect(test.calls.map(call => [call.mode, call.semantic.name])).toEqual([["execute", "stop"], [change === "same" ? "execute" : "lookup_only", "stop"]]);
  expect(test.calls[0].digest).toBe(test.calls[1].digest);
  expect(test.uuids).toHaveLength(change === "different-operation" ? 0 : 1);
});

for (const allowed of [true, false]) it(`isolates per-domain and per-app effects without a file when allowed=${allowed}`, async () => {
  const test = fixture(); test.knobs.allowed = allowed;
  for (const [appId, domain] of [["app", "feishu"], ["other", "feishu"], ["app", "lark"]] as const) {
    test.knobs.appId = appId; test.knobs.domain = domain;
    const instance = test.open(false), input = test.event("助手 /status");
    await Promise.all([instance.accept(input), instance.accept(input)]);
  }
  expect(test.calls).toHaveLength(allowed ? 3 : 0);
  expect(test.uuids).toHaveLength(3);
  expect(new Set(test.uuids).size).toBe(3);
});

it("closes a legacy write with unknown outcome and keeps the legacy history command silent", async () => {
  const test = fixture(), input = test.event("助手 /new");
  writeFileSync(test.path, JSON.stringify({ version: 1, initializedAt: Date.now() - 60_000, chats: { oc_chat: { type: "group", through: 10, scannedThrough: 5 } },
    pending: { om_same: input }, acknowledged: { legacy: { at: Date.now(), liveOnly: "command" } }, skipped: [] }));
  const instance = test.open(); await instance.replay();
  input.message.message_id = "legacy"; await instance.accept(input);
  expect(test.state().skipped[0].reason).toBe("upgrade_write_outcome_unknown_resend_new_message");
  expect([test.calls.length, test.uuids.length]).toEqual([0, 0]);
});

it("fences a late command response after close", async () => {
  const test = fixture(), first = test.open();
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<string>();
  test.knobs.execute = async () => { started.resolve(); return release.promise; };
  const old = first.accept(test.event("助手 /status")); await started.promise; first.close();
  test.knobs.execute = async () => "current"; await test.open().replay();
  const saved = readFileSync(test.path, "utf8"); release.resolve("old"); await expect(old).rejects.toThrow();
  expect(test.uuids).toHaveLength(1); expect(readFileSync(test.path, "utf8")).toBe(saved);
});

it("keeps a completed command terminal when its reaction fails", async () => {
  const test = fixture(); test.knobs.failReceipt = true;
  const first = test.open(), input = test.event("助手 /status");
  await first.accept(input); first.close(); await test.open().accept(input);
  expect(test.counts().receipts).toBeGreaterThan(0);
  expect([test.calls.length, test.uuids.length]).toEqual([1, 1]);
});

for (const allowed of [true, false]) it(`limits v1 history denial to notification when allowed=${allowed}`, async () => {
  const test = fixture(); test.knobs.allowed = allowed;
  writeFileSync(test.path, JSON.stringify({ version: 1, initializedAt: Date.now() - 60_000, chats: {}, pending: {},
    acknowledged: { om_same: { at: Date.now(), liveOnly: "denial" } }, skipped: [] }));
  const instance = test.open(), input = test.event("助手 /new");
  await instance.accept(input); await instance.accept(input);
  expect([test.calls.length, test.counts().tasks, test.uuids.length]).toEqual([0, 0, allowed ? 0 : 1]);
});
