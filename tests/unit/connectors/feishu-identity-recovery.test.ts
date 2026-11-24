import { afterAll, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeishuSenderAuthorizer } from "@connectors/feishu/config.js";
import { FeishuInboundRecovery, feishuHistoryEvent, recoverFeishuHistory, type FeishuHistoryMessage } from "@connectors/feishu/inbound-recovery.js";
import { createFeishuInboundDelivery } from "@connectors/feishu/receive.js";

const directory = mkdtempSync(join(tmpdir(), "feishu-identity-"));
afterAll(() => rmSync(directory, { force: true, recursive: true }));

function fixture() {
  const path = join(directory, crypto.randomUUID()), now = Date.now();
  const calls = { authorized: [] as string[], inspected: [] as string[], cards: 0, tasks: [] as string[], listed: [] as string[], warnings: [] as string[] };
  const unavailable = new Set<string>();
  const history = (id: string, text = "/status", chat = "oc_one"): FeishuHistoryMessage => ({ message_id: id, chat_id: chat, msg_type: "text",
    create_time: String(now - 5000), sender: { id: "ou_fixed", id_type: "open_id", sender_type: "user" }, body: { content: JSON.stringify({ text }) } });
  const live = (item: FeishuHistoryMessage) => {
    const event = feishuHistoryEvent(item, item.chat_id!, "p2p")!;
    delete event.recovery_source;
    return event;
  };
  const open = (botOpenId: string | undefined = "ou_bot") => {
    const journal = new FeishuInboundRecovery(path, () => now);
    const authorize: FeishuSenderAuthorizer = async (sender, context) => {
      calls.authorized.push(sender);
      if (unavailable.has(context.messageId)) throw new Error("offline");
      return true;
    };
    authorize.commands = { revision: 1, botId: "bot", execute: async request => {
      calls.inspected.push(request.semantic.external_message_id);
      return { name: "status", snapshot: { chatSessionId: "session", task: null } };
    }, render: () => ({ text: "status", displayName: "Remi" }) };
    const deliver = createFeishuInboundDelivery({ appId: "cli_fixture", recovery: journal, authorizeSender: authorize,
      botIdentity: { botOpenId, botOpenIdReady: Promise.resolve() }, onMessage: async message => { calls.tasks.push(message.messageId); },
      client: { request: async () => ({ code: 0, data: { items: [] } }), im: { message: { create: async () => {
        calls.cards++; return { code: 0, data: { message_id: "om_card" } };
      } } } } as any });
    return { journal, accept: (event: ReturnType<typeof live>) => journal.accept(event, deliver), scan: (items: FeishuHistoryMessage[]) =>
      recoverFeishuHistory({ journal, now, deliver, warn: (chat, reason) => calls.warnings.push(`${chat}:${reason}`), list: async params => {
        calls.listed.push(params.container_id);
        const matching = items.filter(item => item.chat_id === params.container_id), index = Number(params.page_token ?? 0);
        return { code: 0, data: { items: matching.slice(index, index + 1), has_more: index + 1 < matching.length, page_token: String(index + 1) } };
      } }) };
  };
  return { path, open, calls, live, history, unavailable, state: () => JSON.parse(readFileSync(path, "utf8")) };
}

it("repairs the review sequence: incomplete live, complete live, reopen and history overlap", async () => {
  const test = fixture(), first = test.open(), item = test.history("om_review"), incomplete = test.live(item);
  incomplete.sender.sender_id = {};
  await expect(first.accept(incomplete)).rejects.toThrow("identity");
  const live = await Promise.allSettled([first.accept(test.live(item))]);
  first.journal.close();
  const recovered = await Promise.allSettled([test.open().scan([item])]);
  expect({ live: live[0].status, recovery: recovered[0].status, storedIdentity: test.state().pending.om_review?.sender.sender_id,
    authorize: test.calls.authorized.length, inspect: test.calls.inspected.length, cards: test.calls.cards, lists: test.calls.listed.length }).toEqual({
    live: "fulfilled", recovery: "fulfilled", storedIdentity: undefined, authorize: 2, inspect: 1, cards: 1, lists: 1,
  });
});

for (const source of ["live", "history"]) it(`repairs the original live status from a complete ${source} copy after reopen`, async () => {
  const test = fixture(), first = test.open(), item = test.history("om_missing"), incomplete = test.live(item);
  incomplete.sender.sender_id = {};
  await expect(first.accept(incomplete)).rejects.toThrow("identity temporarily unavailable");
  expect(test.state().pending.om_missing.sender.sender_id).toEqual({});
  expect(test.calls.authorized).toEqual([]);
  first.journal.close();
  const second = test.open();
  if (source === "live") await second.accept(test.live(item));
  else await second.scan([item, test.history("om_history_only")]);
  await second.accept(test.live(item)); await second.scan([item]);
  expect(test.calls.authorized.filter(sender => sender === "ou_fixed").length).toBe(source === "live" ? 2 : 3);
  expect(test.calls.inspected).toEqual(["om_missing"]);
  expect(test.calls.cards).toBe(1); expect(test.state().pending).toEqual({});
});

it("keeps a blocked ID pending while replaying its neighbour and scanning another chat", async () => {
  const test = fixture(), first = test.open();
  const bad = test.live(test.history("bad")); bad.sender.sender_id = {};
  await expect(first.accept(bad)).rejects.toThrow("identity");
  test.unavailable.add("offline");
  await expect(first.accept(test.live(test.history("offline", "ordinary")))).rejects.toThrow("admission");
  test.unavailable.add("later");
  await expect(first.accept(test.live(test.history("later", "ordinary")))).rejects.toThrow("admission");
  first.journal.rememberChat("oc_two", "p2p"); first.journal.close(); test.unavailable.delete("later");
  const second = test.open();
  await second.scan([test.history("offline", "ordinary"), test.history("other", "ordinary", "oc_two"), test.history("page2", "ordinary", "oc_two")]);
  expect(test.calls.listed).toEqual(["oc_one", "oc_two", "oc_two"]);
  expect(test.calls.tasks).toEqual(["later", "other", "page2"]);
  expect(test.calls.warnings.length).toBeGreaterThan(0);
  expect(Object.keys(test.state().pending)).toEqual(["bad", "offline"]);
});

for (const conflict of ["user", "union", "tenant", "actor", "text", "type", "chat", "chat-type", "root", "thread", "parent", "mention"]) {
  it(`ignores an unbound conflicting ${conflict} without consuming or rewriting the original`, async () => {
    const test = fixture(), instance = test.open(), original = test.live(test.history("bad"));
    original.sender.sender_id = { user_id: "user", union_id: "union" }; original.sender.tenant_key = "tenant";
    await expect(instance.accept(original)).rejects.toThrow("identity");
    const prior = test.state().pending.bad, copy = structuredClone(original);
    copy.sender.sender_id.open_id = "ou_fixed";
    switch (conflict) {
      case "user": copy.sender.sender_id.user_id = "other"; break;
      case "union": copy.sender.sender_id.union_id = "other"; break;
      case "tenant": copy.sender.tenant_key = "other"; break;
      case "actor": copy.sender.sender_type = "app"; break;
      case "text": copy.message.content = '{"text":"/new"}'; break;
      case "type": copy.message.message_type = "post"; break;
      case "chat": copy.message.chat_id = "other"; break;
      case "chat-type": copy.message.chat_type = "group"; break;
      case "root": copy.message.root_id = "root"; break;
      case "thread": copy.message.thread_id = "thread"; break;
      case "parent": copy.message.parent_id = "parent"; break;
      case "mention": copy.message.mentions = [{ id: { open_id: "other" }, name: "other", key: "@id" }]; break;
    }
    await instance.accept(copy);
    expect(test.state().pending.bad).toEqual(prior);
    expect(test.calls.authorized).toEqual([]); expect(test.calls.inspected).toEqual([]); expect(test.calls.cards).toBe(0);
    expect(test.calls.tasks).toEqual([]);
    await instance.accept(test.live(test.history("bad")));
    expect(test.calls.inspected).toEqual(["bad"]); expect(test.calls.cards).toBe(1);
  });
}

it("holds the scan watermark for an unjournaled history identity gap and finishes the remaining pages", async () => {
  const test = fixture(), first = test.open(), missing = test.history("missing", "first");
  const later = test.history("later", "next"); later.create_time = String(Number(missing.create_time) + 2000);
  const broken = { ...missing, sender: { sender_type: "user" } };
  first.journal.rememberChat("oc_one", "p2p");
  await first.scan([later, broken]);
  expect(test.state().chats.oc_one.scannedThrough).toBe(Number(missing.create_time));
  expect(test.calls.tasks).toEqual(["later"]);
  await first.scan([later, missing]);
  expect(test.calls.tasks).toEqual(["later", "missing"]);
  expect(test.state().chats.oc_one.scannedThrough).toBe(Number(later.create_time));
});

it("retains known identity fields during a partial supplement and an authorization outage", async () => {
  const test = fixture(), first = test.open(), original = test.live(test.history("partial"));
  original.sender.sender_id = { user_id: "user", union_id: "union" }; original.sender.tenant_key = "tenant";
  await expect(first.accept(original)).rejects.toThrow("identity");
  test.unavailable.add("partial");
  await first.scan([test.history("partial")]);
  expect(test.state().pending.partial.sender).toEqual({ sender_type: "user", sender_id: { open_id: "ou_fixed", user_id: "user", union_id: "union" }, tenant_key: "tenant" });
  expect(test.calls.cards).toBe(0); expect(test.calls.tasks).toEqual([]);
  first.journal.close(); test.unavailable.clear(); await test.open().scan([]);
  expect(test.calls.inspected).toEqual(["partial"]); expect(test.calls.cards).toBe(1);
});

it("rejects an open_id conflict while bot identity is still unresolved", async () => {
  const test = fixture(), first = test.open(""), original = test.live(test.history("partial", "@bot /status"));
  original.message.chat_type = "group"; original.message.mentions = [{ key: "@bot", name: "Remi", id: { open_id: "ou_bot" } }];
  await expect(first.accept(original)).rejects.toThrow("bot identity");
  const conflict = structuredClone(original); conflict.sender.sender_id = { open_id: "ou_other", union_id: "on_other" };
  await first.accept(conflict);
  expect(test.state().pending.partial.sender.sender_id).toEqual({ open_id: "ou_fixed" });
  expect(test.calls.authorized).toEqual([]);
});

it("propagates journal write and closure failures from recovery", async () => {
  const test = fixture(), instance = test.open(); instance.journal.rememberChat("oc_one", "p2p");
  mkdirSync(`${test.path}.tmp`);
  await expect(instance.scan([test.history("disk-error")])).rejects.toThrow("EISDIR");
  expect(test.state().acknowledged).toEqual({}); expect(test.calls.authorized).toEqual([]);
  instance.journal.close(); await expect(instance.scan([])).rejects.toThrow("journal closed");
});
