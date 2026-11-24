import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { multiremiStateDir } from "@shared/home-paths.js";
import type { FeishuMessageEvent } from "./types.js";
import type { FeishuCommandSemantic } from "@multiremi/contracts/types.js";

type ChatType = "p2p" | "group";
type LiveFollowup = "denial" | "command";
export interface CommandReply {
  botId?: string;
  card: Record<string, unknown>;
  denied: boolean;
  uuid: string;
  chatId: string;
  replyTo?: string;
  firstSendAt?: number;
  uncertain?: boolean;
  messageId?: string;
}

export interface CommandProgress {
  digest?: string;
  botId?: string;
  legacyPending?: boolean;
  write?: { semantic: FeishuCommandSemantic; revision: number; botId: string; lookupOnly?: boolean };
  reply?: CommandReply;
}
export type FeishuInboundDelivery = (event: FeishuMessageEvent, liveOnly?: LiveFollowup, journal?: FeishuInboundRecovery) => Promise<void | LiveFollowup>;
const HISTORY_WINDOW_MS = 10 * 60_000;
const ACK_RETENTION_MS = 30 * 60_000;
export class FeishuAdmissionUnavailable extends Error {}

function supplementSender(original: FeishuMessageEvent, copy: FeishuMessageEvent): FeishuMessageEvent | undefined {
  const message = original.message, incoming = copy.message;
  const mentions = (value: typeof message) => (value.mentions ?? []).map(mention =>
    [mention.key, mention.name, mention.id.open_id, mention.id.user_id, mention.id.union_id, mention.tenant_key]);
  if (message.message_id !== incoming.message_id || message.content !== incoming.content || message.message_type !== incoming.message_type
      || message.chat_id !== incoming.chat_id || message.chat_type !== incoming.chat_type
      || (message.root_id || "") !== (incoming.root_id || "") || (message.parent_id || "") !== (incoming.parent_id || "")
      || (message.thread_id || "") !== (incoming.thread_id || "") || !isDeepStrictEqual(mentions(message), mentions(incoming))) return;
  const sender = original.sender, candidate = copy.sender;
  if ((sender.sender_type || "user") !== (candidate.sender_type || "user")
      || (sender.tenant_key && candidate.tenant_key && sender.tenant_key !== candidate.tenant_key)) return;
  const ids = { ...sender.sender_id };
  for (const field of ["open_id", "user_id", "union_id"] as const) {
    const known = ids[field], offered = candidate.sender_id?.[field];
    if (known && offered && known !== offered) return;
    if (!known && offered) ids[field] = offered;
  }
  const tenant = sender.tenant_key || candidate.tenant_key;
  if (tenant === sender.tenant_key && isDeepStrictEqual(ids, sender.sender_id ?? {})) return original;
  return { ...original, sender: { ...sender, sender_id: ids, tenant_key: tenant } };
}
interface InboundState {
  version: 2;
  initializedAt: number;
  chats: Record<string, { type: ChatType; through: number; scannedThrough: number }>;
  pending: Record<string, FeishuMessageEvent>;
  acknowledged: Record<string, { at: number; liveOnly?: LiveFollowup; digest?: string; botId?: string; replyId?: string }>;
  progress: Record<string, CommandProgress>;
  liveCopies: Record<string, FeishuMessageEvent>;
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

  constructor(private readonly path: string | null, readonly now = Date.now) {
    if (path && existsSync(path)) {
      // Fail closed on an unreadable journal. Silently resetting it would lose pending input.
      const state = JSON.parse(readFileSync(path, "utf8")) as Omit<InboundState, "version"> & {version: number};
      if (![1, 2].includes(state.version) || !Number.isFinite(state.initializedAt)
          || !state.chats || !state.pending || !Array.isArray(state.skipped)) throw new Error("Invalid Feishu inbound journal");
      if (state.version === 2 && (!state.progress || !state.acknowledged || !state.liveCopies)) throw new Error("Incomplete Feishu inbound journal");
      this.state = { ...state, version: 2, progress: state.progress ?? {}, liveCopies: state.liveCopies ?? {}, acknowledged: state.acknowledged ?? {} };
      if (state.version === 1) {
        for (const id of Object.keys(state.pending)) this.state.progress[id] = { legacyPending: true };
        for (const receipt of Object.values(this.state.acknowledged)) if (receipt.liveOnly === "command") delete receipt.liveOnly;
        this.save();
      }
    } else {
      this.state = { version: 2, initializedAt: now() - HISTORY_WINDOW_MS, chats: {}, pending: {}, acknowledged: {}, progress: {}, liveCopies: {}, skipped: [] };
      this.save();
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Feishu inbound journal closed");
  }

  private save(): void {
    this.ensureOpen();
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  close(): void {
    this.closed = true;
  }

  progress(id: string): Readonly<CommandProgress> {
    this.ensureOpen();
    const receipt = this.state.acknowledged[id];
    return this.state.progress[id] ?? { digest: receipt?.digest, botId: receipt?.botId };
  }

  checkpoint(id: string, change: Partial<CommandProgress>): void {
    if (this.closed || !this.state.pending[id]) throw new Error("Feishu input no longer pending");
    this.state.progress[id] = { ...this.progress(id), ...change };
    this.save();
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
    const awaitingIdentity = new Map<string, number>();
    const cutoff = this.now() - HISTORY_WINDOW_MS;
    for (const [id, event] of Object.entries(this.state.pending)) {
      if (this.progress(id).digest) continue;
      const timestamp = Number(event.message.create_time) || cutoff;
      if (timestamp < cutoff) continue;
      const chat = event.message.chat_id;
      awaitingIdentity.set(chat, Math.min(timestamp, awaitingIdentity.get(chat) ?? Infinity));
    }
    return Object.entries(this.state.chats).map(([id, chat]) => ({ id, type: chat.type,
      // Delayed history visibility and equal timestamps need an overlap.
      // A newer live message must not move past an unscanned restart gap.
      since: Math.max(this.state.initializedAt, Math.min(chat.through, chat.scannedThrough, awaitingIdentity.get(id) ?? Infinity) - 60_000) }));
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
    this.ensureOpen();
    const id = event.message.message_id;
    this.pruneAcknowledgements();
    if (event.recovery_source === "history" && Number(event.message.create_time) < this.now() - HISTORY_WINDOW_MS) return Promise.resolve();
    const receipt = this.state.acknowledged[id];
    if (receipt && (!receipt.liveOnly || event.recovery_source === "history")) return Promise.resolve();
    // This synchronous write happens before any await, even behind another callback.
    const pending = this.state.pending[id];
    if (!pending) {
      this.rememberChat(event.message.chat_id, event.message.chat_type);
      this.state.pending[id] = event;
    } else {
      const progress = this.progress(id);
      const unbound = !receipt && !progress.digest && !progress.write && !progress.reply && !progress.legacyPending;
      const supplemented = unbound ? supplementSender(pending, event) : pending;
      if (!supplemented || (event.recovery_source === "history" && supplemented === pending)) return Promise.resolve();
      this.state.pending[id] = supplemented;
      if (event.recovery_source !== "history") {
        if (pending.recovery_source === "history") this.state.liveCopies[id] ??= event;
        else if (progress.digest) {
          this.rememberChat(event.message.chat_id, event.message.chat_type);
          this.state.pending[id] = event;
        }
      }
      const live = this.state.liveCopies[id];
      if (unbound && live) this.state.liveCopies[id] = supplementSender(live, supplemented) ?? live;
    }
    this.save();
    return this.serialized(() => this.deliver(id, deliver));
  }

  private async deliver(id: string, callback: FeishuInboundDelivery): Promise<void> {
    const event = this.state.pending[id];
    if (!event) return;
    const receipt = this.state.acknowledged[id];
    if (!receipt || (receipt.liveOnly && event.recovery_source !== "history")) {
      const liveOnly = await callback(event, receipt?.liveOnly, this);
      const progress = this.progress(id);
      this.state.acknowledged[id] = { at: this.now(), ...(liveOnly ? { liveOnly, digest: progress.digest, botId: progress.botId } : {}), replyId: progress.reply?.messageId };
    }
    const timestamp = Number(event.message.create_time);
    if (Number.isFinite(timestamp) && timestamp > 0 && timestamp <= this.now()) {
      const chat = this.state.chats[event.message.chat_id]!;
      chat.through = Math.max(chat.through, timestamp);
    }
    const next = this.state.acknowledged[id].liveOnly && this.state.liveCopies[id];
    delete this.state.progress[id];
    delete this.state.liveCopies[id];
    delete this.state.pending[id];
    if (next) this.state.pending[id] = next;
    this.save();
    if (next) await this.deliver(id, callback);
  }

  replay(callback: FeishuInboundDelivery, warn?: (chatId: string, reason: string) => void): Promise<void> {
    return this.serialized(async () => {
      this.ensureOpen();
      let deferred: FeishuAdmissionUnavailable | undefined;
      for (const [id, event] of Object.entries(this.state.pending)) {
        try { await this.deliver(id, callback); }
        catch (error) {
          if (!(error instanceof FeishuAdmissionUnavailable)) throw error;
          this.ensureOpen();
          warn?.(event.message.chat_id, error.message);
          deferred ??= error;
        }
      }
      if (deferred && !warn) throw deferred;
    });
  }

  skipped(chatId: string, reason: string, messageId?: string, command?: string): void {
    this.state.skipped.push({ chatId, reason, at: this.now(), status: "skipped", ...(messageId ? { messageId } : {}), ...(command ? { command } : {}) });
    this.state.skipped = this.state.skipped.slice(-100);
    this.save();
  }

  scanned(chatId: string, before: number, firstGap = Infinity): void {
    this.pruneAcknowledgements();
    const chat = this.state.chats[chatId]!;
    chat.scannedThrough = Math.min(firstGap, Math.max(chat.scannedThrough, Math.min(chat.through, before)));
    this.save();
  }

}

export interface FeishuHistoryMessage {
  message_id?: string; chat_id?: string; msg_type?: string; create_time?: string;
  root_id?: string; thread_id?: string; parent_id?: string; deleted?: boolean;
  sender?: { id?: string; id_type?: string; sender_type?: string; tenant_key?: string };
  body?: { content?: string };
  mentions?: Array<{ key?: string; id?: string; id_type?: string; name?: string; tenant_key?: string }>;
}

/** History API uses a different sender/mention representation from WS events. */
export function feishuHistoryEvent(item: FeishuHistoryMessage, chatId: string, chatType: ChatType): FeishuMessageEvent | null {
  if (item.deleted || !item.message_id || !item.msg_type || !item.body?.content) return null;
  if (item.chat_id && item.chat_id !== chatId) throw new Error("Feishu history message chat does not match list container");
  if (!item.sender?.sender_type) throw new FeishuAdmissionUnavailable("Feishu history sender identity unavailable");
  if (item.sender.sender_type !== "user") return null;
  if (item.sender.id_type !== "open_id" || !item.sender.id) throw new FeishuAdmissionUnavailable("Feishu history sender identity unavailable");
  return { recovery_source: "history", sender: { sender_type: "user", sender_id: { open_id: item.sender.id }, tenant_key: item.sender.tenant_key },
    message: { message_id: item.message_id, chat_id: chatId, chat_type: chatType,
      message_type: item.msg_type, content: item.body.content, create_time: item.create_time,
      root_id: item.root_id, thread_id: item.thread_id, parent_id: item.parent_id,
      mentions: item.mentions?.map(mention => {
        if (mention.id_type !== "open_id" || !mention.id || !mention.key) throw new FeishuAdmissionUnavailable("Feishu history mention identity unavailable");
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
  await journal.replay(deliver, options.warn);
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
    let firstGap = Infinity;
    for (const item of items) {
      const timestamp = Number(item.create_time);
      if (!Number.isFinite(timestamp) || timestamp < since || timestamp > now) {
        skipped(chat.id, "history_message_outside_window"); continue;
      }
      let event: FeishuMessageEvent | null = null;
      try {
        event = feishuHistoryEvent(item, chat.id, chat.type);
        if (event) await journal.accept(event, deliver);
      } catch (error) {
        if (!(error instanceof FeishuAdmissionUnavailable)) throw error;
        options.warn(chat.id, error.message);
        if (!event) firstGap = Math.min(firstGap, timestamp);
      }
    }
    journal.scanned(chat.id, now, firstGap);
  }
}
