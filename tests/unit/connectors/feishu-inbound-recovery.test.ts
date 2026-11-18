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

it("skips replayed commands, advances past an offline stop, and preserves ordinary slash requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "feishu-commands-")), path = join(root, "journal.json"), now = Date.now();
  const client = { request: async () => ({ data: { users: [{ name: "Member" }] } }) } as any;
  let newCount = 0, stopCount = 0;
  const submitted = new Set<string>();
  const item = (id: string, text: string, at: number) => feishuHistoryEvent({ message_id: id, create_time: String(at),
    msg_type: "text", sender: { id_type: "open_id", id: "ou_member", sender_type: "user" }, body: { content: JSON.stringify({ text }) } }, "oc_private", "p2p")!;
  try {
    const journal = new FeishuInboundRecovery(path, () => now);
    const deliver = createFeishuInboundDelivery({ client, recovery: journal, appId: "cli_test", authorizeSender: async () => true,
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
    const ordinary = item("om_ordinary", "/data00/home/x 看下", now - 2000);
    const help = item("om_help_request", "/help 怎么用", now - 1000);
    for (let overlap = 0; overlap < 2; overlap++) {
      for (const event of [previousNew, offlineStop, ordinary, help]) await journal.accept(event, deliver);
    }
    expect(newCount).toBe(1);
    expect(stopCount).toBe(0);
    expect([...submitted]).toEqual(["om_ordinary", "om_help_request"]);
    const state = JSON.parse(readFileSync(path, "utf8"));
    expect(state.pending).toEqual({});
    expect(state.skipped).toContainEqual(expect.objectContaining({ status: "skipped", messageId: "om_offline_stop", command: "stop" }));
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
