import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { multiremiStateDir } from "@shared/home-paths.js";
import type { FeishuMessageEvent } from "./types.js";

type ChatType = "p2p" | "group";
type LiveFollowup = "denial" | "command";
export type FeishuInboundDelivery = (event: FeishuMessageEvent, liveOnly?: LiveFollowup) => Promise<void | LiveFollowup>;
const HISTORY_WINDOW_MS = 10 * 60_000;
const ACK_RETENTION_MS = 30 * 60_000;
interface InboundState {
  version: 1;
  initializedAt: number;
  chats: Record<string, { type: ChatType; through: number; scannedThrough: number }>;
  pending: Record<string, FeishuMessageEvent>;
  acknowledged: Record<string, { at: number; liveOnly?: LiveFollowup }>;
  skipped: Array<{ chatId: string; reason: string; at: number; status: "skipped"; messageId?: string; command?: string }>;
}

/** App and API domain are both part of the local identity. Never persist secrets. */
export function feishuRecoveryPath(appId: string, domain = "feishu"): string {
  const identity = createHash("sha256").update(JSON.stringify([domain, appId])).digest("hex");
  return join(multiremiStateDir(), "feishu-inbound", `${identity}.json`);
}

/** Write ahead of the business callback; only a successful callback acknowledges it.
 * Consumption receipts and Task dedup stay server-owned. Cursors retain an overlap.
 */
export class FeishuInboundRecovery {
  private readonly state: InboundState;
  private queue: Promise<void> = Promise.resolve();
  private nextPruneAt = 0;
  private closed = false;

  constructor(private readonly path: string, private readonly now = Date.now) {
    if (existsSync(path)) {
      // Fail closed on an unreadable journal. Silently resetting it would lose pending input.
      const state = JSON.parse(readFileSync(path, "utf8")) as InboundState;
      if (state.version !== 1 || !Number.isFinite(state.initializedAt)
          || !state.chats || !state.pending || !Array.isArray(state.skipped)) throw new Error("Invalid Feishu inbound journal");
      this.state = state;
      this.state.acknowledged ??= {};
    } else {
      this.state = { version: 1, initializedAt: now() - HISTORY_WINDOW_MS, chats: {}, pending: {}, acknowledged: {}, skipped: [] };
      this.save();
    }
  }

  private save(): void {
    if (this.closed) throw new Error("Feishu inbound journal closed");
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  close(): void {
    this.closed = true;
  }

  private serialized(action: () => Promise<void>): Promise<void> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }

  rememberChat(id: string, type: ChatType): void {
    if (Object.hasOwn(this.state.chats, id)) return;
    this.state.chats[id] = { type, through: this.state.initializedAt, scannedThrough: this.state.initializedAt };
    this.save();
  }

  chats(): Array<{ id: string; type: ChatType; since: number }> {
    return Object.entries(this.state.chats).map(([id, chat]) => ({ id, type: chat.type,
      // Delayed history visibility and equal timestamps need an overlap.
      // A newer live message must not move past an unscanned restart gap.
      since: Math.max(this.state.initializedAt, Math.min(chat.through, chat.scannedThrough) - 60_000) }));
  }

  private pruneAcknowledgements(): void {
    const now = this.now();
    if (now < this.nextPruneAt) return;
    for (const [id, receipt] of Object.entries(this.state.acknowledged)) {
      if (receipt.at < now - ACK_RETENTION_MS && !Object.hasOwn(this.state.pending, id)) delete this.state.acknowledged[id];
    }
    this.nextPruneAt = now + 60_000;
  }

  accept(event: FeishuMessageEvent, deliver: FeishuInboundDelivery): Promise<void> {
    const id = event.message.message_id;
    this.pruneAcknowledgements();
    if (event.recovery_source === "history" && Number(event.message.create_time) < this.now() - HISTORY_WINDOW_MS) return Promise.resolve();
    const receipt = this.state.acknowledged[id];
    if (receipt && (!receipt.liveOnly || event.recovery_source === "history")) return Promise.resolve();
    this.rememberChat(event.message.chat_id, event.message.chat_type);
    // This synchronous write happens before any await, even behind another callback.
    const pending = this.state.pending[id];
    // A history overlap must not erase a live notification obligation already
    // journaled for this ID. A later live copy can replace a history copy.
    this.state.pending[id] = pending && pending.recovery_source !== "history" && event.recovery_source === "history"
      ? pending : event;
    this.save();
    return this.serialized(() => this.deliver(id, deliver));
  }

  private async deliver(id: string, callback: FeishuInboundDelivery): Promise<void> {
    const event = this.state.pending[id];
    if (!event) return;
    const receipt = this.state.acknowledged[id];
    if (!receipt || (receipt.liveOnly && event.recovery_source !== "history")) {
      const liveOnly = await callback(event, receipt?.liveOnly);
      this.state.acknowledged[id] = { at: this.now(), ...(liveOnly ? { liveOnly } : {}) };
    }
    const timestamp = Number(event.message.create_time);
    if (Number.isFinite(timestamp) && timestamp > 0 && timestamp <= this.now()) {
      const chat = this.state.chats[event.message.chat_id]!;
      chat.through = Math.max(chat.through, timestamp);
    }
    const pending = this.state.pending[id];
    if (pending === event || pending?.recovery_source === "history" || !this.state.acknowledged[id].liveOnly) {
      delete this.state.pending[id];
    }
    this.save();
  }

  replay(callback: FeishuInboundDelivery): Promise<void> {
    return this.serialized(async () => {
      for (const id of Object.keys(this.state.pending)) await this.deliver(id, callback);
    });
  }

  skipped(chatId: string, reason: string, messageId?: string, command?: string): void {
    this.state.skipped.push({ chatId, reason, at: this.now(), status: "skipped", ...(messageId ? { messageId } : {}), ...(command ? { command } : {}) });
    this.state.skipped = this.state.skipped.slice(-100);
    this.save();
  }

  scanned(chatId: string, before: number): void {
    this.pruneAcknowledgements();
    const chat = this.state.chats[chatId]!;
    chat.scannedThrough = Math.max(chat.scannedThrough, Math.min(chat.through, before));
    this.save();
  }

}

export interface FeishuHistoryMessage {
  message_id?: string; chat_id?: string; msg_type?: string; create_time?: string;
  root_id?: string; parent_id?: string; deleted?: boolean;
  sender?: { id?: string; id_type?: string; sender_type?: string; tenant_key?: string };
  body?: { content?: string };
  mentions?: Array<{ key?: string; id?: string; id_type?: string; name?: string; tenant_key?: string }>;
}

/** History API uses a different sender/mention representation from WS events. */
export function feishuHistoryEvent(item: FeishuHistoryMessage, chatId: string, chatType: ChatType): FeishuMessageEvent | null {
  if (item.deleted || !item.message_id || !item.msg_type || !item.body?.content) return null;
  if (item.sender?.sender_type !== "user") return null;
  if (item.sender.id_type !== "open_id" || !item.sender.id) throw new Error("Feishu history sender identity unavailable");
  return { recovery_source: "history", sender: { sender_type: "user", sender_id: { open_id: item.sender.id }, tenant_key: item.sender.tenant_key },
    message: { message_id: item.message_id, chat_id: chatId, chat_type: chatType,
      message_type: item.msg_type, content: item.body.content, create_time: item.create_time,
      root_id: item.root_id, parent_id: item.parent_id,
      mentions: item.mentions?.map(mention => {
        if (mention.id_type !== "open_id" || !mention.id || !mention.key) throw new Error("Feishu history mention identity unavailable");
        return { key: mention.key, id: { open_id: mention.id }, name: mention.name ?? "", tenant_key: mention.tenant_key };
      }) } };
}

export interface FeishuHistoryPage { code?: number; data?: { items?: FeishuHistoryMessage[]; has_more?: boolean; page_token?: string } }

/** Bounded, newest-first fetch, followed by oldest-first business delivery. */
export async function recoverFeishuHistory(options: {
  journal: FeishuInboundRecovery;
  list: (params: { container_id_type: string; container_id: string; start_time: string; end_time: string;
    sort_type: "ByCreateTimeDesc"; page_size: number; page_token?: string }) => Promise<FeishuHistoryPage>;
  deliver: FeishuInboundDelivery;
  warn: (chatId: string, reason: string) => void;
  now?: number;
  maxPages?: number;
  windowMs?: number;
}): Promise<void> {
  const { journal, deliver } = options;
  await journal.replay(deliver);
  const now = options.now ?? Date.now(), cutoff = now - Math.min(options.windowMs ?? HISTORY_WINDOW_MS, HISTORY_WINDOW_MS);
  const skipped = (chatId: string, reason: string) => { journal.skipped(chatId, reason); options.warn(chatId, reason); };
  for (const chat of journal.chats()) {
    if (chat.since < cutoff) skipped(chat.id, "history_time_window");
    const since = Math.max(chat.since, cutoff);
    let token: string | undefined;
    const tokens = new Set<string>(), items: FeishuHistoryMessage[] = [];
    for (let page = 0; page < (options.maxPages ?? 5); page++) {
      const response = await options.list({ container_id_type: "chat", container_id: chat.id,
        start_time: String(Math.floor(since / 1000)), end_time: String(Math.ceil(now / 1000)),
        sort_type: "ByCreateTimeDesc", page_size: 50, ...(token ? { page_token: token } : {}) });
      if (response.code !== 0 || !response.data) throw new Error("Feishu history listing failed");
      items.push(...response.data.items ?? []);
      if (!response.data.has_more) break;
      token = response.data.page_token;
      if (!token || tokens.has(token)) throw new Error("Feishu history pagination did not advance");
      tokens.add(token);
      if (page === (options.maxPages ?? 5) - 1) skipped(chat.id, "history_page_limit");
    }
    items.sort((a, b) => Number(a.create_time) - Number(b.create_time) || String(a.message_id).localeCompare(String(b.message_id)));
    for (const item of items) {
      const timestamp = Number(item.create_time);
      if (!Number.isFinite(timestamp) || timestamp < since || timestamp > now) {
        skipped(chat.id, "history_message_outside_window"); continue;
      }
      const event = feishuHistoryEvent(item, chat.id, chat.type);
      if (!event) continue;
      await journal.accept(event, deliver);
    }
    journal.scanned(chat.id, now);
  }
}
