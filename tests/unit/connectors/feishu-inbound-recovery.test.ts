import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeishuInboundRecovery, feishuHistoryEvent, recoverFeishuHistory } from "@connectors/feishu/inbound-recovery.js";
import { createFeishuInboundDelivery, flushDedupCacheSync, setDedupCachePathForTesting } from "@connectors/feishu/receive.js";
import { resolveFeishuCommand } from "@shared/feishu-commands.js";

const dedupTestRoot = mkdtempSync(join(tmpdir(), "feishu-recovery-dedup-"));
beforeAll(() => setDedupCachePathForTesting(join(dedupTestRoot, "dedup-cache.json")));
afterAll(() => {
  flushDedupCacheSync();
  rmSync(dedupTestRoot, { recursive: true, force: true });
});

for (const overlap of ["queued", "delivering", "acknowledged"] as const) it(`keeps live denial notification when history overlaps ${overlap} input`, async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-overlap-denied-")), now = Date.now();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let cards = 0, callbacks = 0, admissions = 0;
  const client = { im: { message: { reply: async () => {
    cards++; return { code: 0, data: { message_id: "om_denial_card" } };
  } } } } as any;
  const history = feishuHistoryEvent({ message_id: `om_overlap_${crypto.randomUUID()}`, create_time: String(now - 1000),
    msg_type: "text", sender: { id_type: "open_id", id: "ou_nonmember", sender_type: "user" }, body: { content: '{"text":"hello"}' } }, "oc_private", "p2p")!;
  const live = { ...history, recovery_source: undefined };
  try {
    const journal = new FeishuInboundRecovery(join(root, "journal.json"), () => now);
    const deliver = createFeishuInboundDelivery({ client, recovery: journal, appId: "cli_test",
      authorizeSender: async () => {
        if (++admissions === 1 && overlap === "delivering") { entered.resolve(); await release.promise; }
        return false;
      }, botIdentity: { botOpenId: "ou_bot", botOpenIdReady: Promise.resolve() },
      onMessage: async () => { callbacks++; } });
    const first = overlap === "queued"
      ? journal.accept({ ...history, message: { ...history.message, message_id: "om_blocker" } }, async () => {
        entered.resolve(); await release.promise;
      })
      : journal.accept(history, deliver);
    if (overlap === "acknowledged") await first;
    else await entered.promise;
    const arrivingLive = journal.accept(live, deliver);
    const arrivingHistory = overlap === "queued" ? journal.accept(history, deliver) : Promise.resolve();
    release.resolve();
    await Promise.all([first, arrivingLive, arrivingHistory]);
    expect(cards).toBe(1);
    expect(callbacks).toBe(0);
    expect(admissions).toBe(overlap === "queued" ? 1 : 2);
    expect(JSON.parse(readFileSync(join(root, "journal.json"), "utf8")).pending).toEqual({});
  } finally { release.resolve(); rmSync(root, { recursive: true, force: true }); }
});

it("denies overlapping history without repeated cards while retaining live denial notifications", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-history-denied-"));
  let now = Date.now(), deniedCards = 0, callbacks = 0, admissions = 0;
  const client = { im: { message: { reply: async () => {
    deniedCards++;
    return { code: 0, data: { message_id: "om_denial_card" } };
  } } } } as any;
  try {
    const journal = new FeishuInboundRecovery(join(root, "journal.json"), () => now);
    journal.rememberChat("oc_private", "p2p");
    const deliver = createFeishuInboundDelivery({ client, recovery: journal, appId: "cli_test",
      authorizeSender: async () => { admissions++; return false; },
      botIdentity: { botOpenId: "ou_bot", botOpenIdReady: Promise.resolve() },
      onMessage: async () => { callbacks++; } });
    const items = ["ordinary input", "/stop"].map((text, i) => ({ message_id: `om_denied_${i}`,
      create_time: String(now - 1000 + i), msg_type: "text", sender: { id_type: "open_id", id: "ou_nonmember", sender_type: "user" },
      body: { content: JSON.stringify({ text }) } }));
    for (let scan = 0; scan < 2; scan++) {
      await recoverFeishuHistory({ journal, now, deliver, warn: () => {},
        list: async () => ({ code: 0, data: { items } }) });
      now += 30_000;
    }
    expect(admissions).toBe(4);
    expect(callbacks).toBe(0);
    expect(deniedCards).toBe(0);
    const live = feishuHistoryEvent(items[0]!, "oc_private", "p2p")!;
    await journal.accept({ ...live, recovery_source: undefined }, deliver);
    await journal.accept({ ...live, recovery_source: undefined }, deliver);
    expect(admissions).toBe(6);
    expect(callbacks).toBe(0);
    expect(deniedCards).toBe(1);
    expect(JSON.parse(readFileSync(join(root, "journal.json"), "utf8")).pending).toEqual({});
    const legacy = createFeishuInboundDelivery({ client, recovery: null, appId: "cli_test",
      authorizeSender: async () => false,
      botIdentity: { botOpenId: "ou_bot", botOpenIdReady: Promise.resolve() },
      onMessage: async () => { callbacks++; } });
    const legacyEvent = { ...live, recovery_source: undefined,
      message: { ...live.message, message_id: `om_legacy_denied_${crypto.randomUUID()}` } };
    await legacy(legacyEvent);
    await legacy(legacyEvent);
    expect(deniedCards).toBe(2);
    expect(callbacks).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("keeps a live wake-word command durable through a temporary authorization failure", async () => {
  const path = join(dedupTestRoot, "retry-auth.json");
  const journal = new FeishuInboundRecovery(path);
  const event = feishuHistoryEvent({ message_id: crypto.randomUUID(), msg_type: "text", sender: { id_type: "open_id", id: "ou_retry", sender_type: "user" },
    body: { content: JSON.stringify({ text: "助手 /stop" }) } }, "oc_group", "group")!;
  delete event.recovery_source;
  let available = false;
  const commands: string[] = [];
  const deliver = createFeishuInboundDelivery({ client: { request: async () => ({}) } as any, recovery: journal, appId: "cli_test",
    wakeWords: ["助手"], botIdentity: { botOpenId: "ou_bot", botOpenIdReady: Promise.resolve() },
    authorizeSender: async () => { if (!available) throw new Error("offline"); return true; }, onMessage: async message => { commands.push(message.rawContent); } });
  await expect(journal.accept(event, deliver)).rejects.toThrow("temporarily unavailable");
  expect(commands).toEqual([]);
  expect(Object.keys(JSON.parse(readFileSync(path, "utf8")).pending)).toEqual([event.message.message_id]);
  available = true;
  await journal.replay(deliver);
  await journal.accept(event, deliver);
  expect(commands).toEqual(["/stop"]);
  expect(JSON.parse(readFileSync(path, "utf8")).pending).toEqual({});
});

it("skips replayed commands, advances past an offline stop, and preserves ordinary slash requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-commands-")), path = join(root, "journal.json"), now = Date.now();
  const client = { request: async () => ({ data: { users: [{ name: "Member" }] } }) } as any;
  let newCount = 0, stopCount = 0;
  const submitted = new Set<string>();
  const item = (id: string, text: string, at: number) => feishuHistoryEvent({ message_id: id, create_time: String(at),
    msg_type: "text", sender: { id_type: "open_id", id: "ou_member", sender_type: "user" }, body: { content: JSON.stringify({ text }) } }, "oc_private", "p2p")!;
  try {
    const journal = new FeishuInboundRecovery(path, () => now);
    const deliver = createFeishuInboundDelivery({ client, recovery: journal, appId: "cli_test", wakeWords: ["助手"], authorizeSender: async () => true,
      botIdentity: { botOpenId: "ou_bot", botOpenIdReady: Promise.resolve() },
      onMessage: async message => {
        const command = resolveFeishuCommand(message.rawContent);
        if (command?.name === "new") newCount++;
        else if (command?.name === "stop") stopCount++;
        else submitted.add(message.messageId); // Production Task dedup is covered with a real Store in task-bridge.test.
      } });
    const previousNew = item(`om_new_${crypto.randomUUID()}`, "/NEW", now - 4000);
    await journal.accept({ ...previousNew, recovery_source: undefined }, deliver);
    expect(newCount).toBe(1);
    const offlineStop = item("om_offline_stop", "/stop", now - 3000);
    const groupStop = item("om_group_stop", "助手 /stop", now - 3000);
    Object.assign(groupStop.message, { chat_type: "group", chat_id: "oc_group" });
    const ordinary = item("om_ordinary", "/data00/home/x 看下", now - 2000);
    const help = item("om_help_request", "/help 怎么用", now - 1000);
    for (let overlap = 0; overlap < 2; overlap++) {
      for (const event of [previousNew, offlineStop, groupStop, ordinary, help]) await journal.accept(event, deliver);
    }
    expect(newCount).toBe(1);
    expect(stopCount).toBe(0);
    expect([...submitted]).toEqual(["om_ordinary", "om_help_request"]);
    const state = JSON.parse(readFileSync(path, "utf8"));
    expect(state.pending).toEqual({});
    expect(state.skipped).toContainEqual(expect.objectContaining({ status: "skipped", messageId: "om_offline_stop", command: "stop" }));
    expect(state.skipped).toContainEqual(expect.objectContaining({ messageId: "om_group_stop", command: "stop" }));
    expect(state.chats.oc_private.through).toBe(now - 1000);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("does not advance over an unscanned gap when live input is newer", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-cursor-")), path = join(root, "journal.json"), now = Date.now();
  try {
    let journal = new FeishuInboundRecovery(path, () => now - 5 * 60_000);
    journal.rememberChat("oc_private", "p2p");
    journal = new FeishuInboundRecovery(path, () => now);
    const live = feishuHistoryEvent({ message_id: "om_live", create_time: String(now - 100), msg_type: "text",
      sender: { id: "ou_member", id_type: "open_id", sender_type: "user" }, body: { content: '{"text":"new"}' } }, "oc_private", "p2p")!;
    await journal.accept(live, async () => {});
    const starts: number[] = [];
    await recoverFeishuHistory({ journal, now, deliver: async () => {}, warn: () => {}, list: async params => {
      starts.push(Number(params.start_time) * 1000); return { code: 0, data: { items: [] } };
    } });
    expect(starts[0]).toBeLessThanOrEqual(now - 5 * 60_000);
    writeFileSync(path, "corrupt");
    expect(() => new FeishuInboundRecovery(path)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
