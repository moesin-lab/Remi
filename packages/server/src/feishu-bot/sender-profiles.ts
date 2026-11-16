import type { MultiremiStore } from "../store/store.js";
import { feishuBotApiBase } from "./verify.js";

const REFRESH_INTERVAL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 4_000;

/** Use names attached to messages the bot already received. Contact lookup can
 * require broader address-book permissions, including for external users. */
export class FeishuBotSenderProfiles {
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  refresh(store: MultiremiStore, workspaceId: string, botId = "default"): Promise<void> {
    const key = `${workspaceId}:${botId}`;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const refresh = this.refreshOnce(store, workspaceId, botId).finally(() => this.pending.delete(key));
    this.pending.set(key, refresh);
    return refresh;
  }

  private async refreshOnce(store: MultiremiStore, workspaceId: string, botId: string): Promise<void> {
    const bot = store.feishuBotFor(botId);
    const checkedAt = new Date().toISOString();
    const sources = bot.listSenderProfileSources(workspaceId,
      new Date(Date.now() - REFRESH_INTERVAL_MS).toISOString());
    if (!sources.length) return;
    const profiles = new Map<string, SenderProfile>();
    try {
      const credentials = bot.revealSecrets(workspaceId);
      if (!credentials) return;
      const base = feishuBotApiBase(credentials.domain);
      // One deadline covers token exchange and the batch; no network I/O occurs
      // inside a database transaction or on the task ingestion path.
      const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const authResponse = await this.fetchImpl(`${base}/auth/v3/tenant_access_token/internal`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: credentials.appId, app_secret: credentials.appSecret }), signal,
      });
      const auth = await authResponse.json() as Record<string, unknown>;
      if (!authResponse.ok || auth.code !== 0 || typeof auth.tenant_access_token !== "string") return;
      const headers = { Authorization: `Bearer ${auth.tenant_access_token}` };
      const withMessage = sources.filter(source => source.messageId);
      if (withMessage.length) {
        await this.collectMessageSenderNames(base, headers, signal, withMessage, profiles).catch(() => undefined);
      }
      // Message sender names are often absent (and blocked senders have no
      // delivered message), so fall back to the basic contact profile.
      const unresolved = sources.filter(source => !profiles.has(source.id));
      if (unresolved.length) await this.collectContactNames(base, headers, signal, unresolved, profiles);
    } catch {
      // An unavailable/deleted message or missing read permission must not hide
      // the allowlist, leak upstream credentials, or erase a previously known name.
    } finally {
      for (const source of sources) {
        bot.updateSenderProfile(workspaceId, source.appId, source.id,
          profiles.get(source.id) ?? null, checkedAt);
      }
    }
  }

  private async collectMessageSenderNames(base: string, headers: Record<string, string>, signal: AbortSignal,
    sources: SenderProfileSource[], profiles: Map<string, SenderProfile>): Promise<void> {
    const query = new URLSearchParams({ with_sender_name: "true", user_id_type: "open_id" });
    for (const source of sources) query.append("message_ids", source.messageId!);
    const response = await this.fetchImpl(`${base}/im/v1/messages/mget?${query}`, { headers, signal });
    const body = await response.json() as { code?: number; data?: { items?: unknown[] } };
    if (!response.ok || body.code !== 0 || !Array.isArray(body.data?.items)) return;
    for (const item of body.data.items) {
      if (!isRecord(item) || !isRecord(item.sender)) continue;
      const sender = item.sender;
      // Match both the delivered message and its app-scoped sender. Never
      // use response order, display names or a different user's profile as identity.
      const source = sources.find(source => source.messageId === item.message_id
        && source.openId === sender.id && sender.id_type === "open_id" && sender.sender_type === "user");
      if (!source) continue;
      const i18n = isRecord(sender.sender_i18n_names) ? sender.sender_i18n_names : {};
      const name = profileText(sender.sender_name) ?? profileText(i18n.zh_cn)
        ?? profileText(i18n.en_us) ?? profileText(i18n.ja_jp);
      if (name) profiles.set(source.id, { name, nameEn: profileText(i18n.en_us) });
    }
  }

  private async collectContactNames(base: string, headers: Record<string, string>, signal: AbortSignal,
    sources: SenderProfileSource[], profiles: Map<string, SenderProfile>): Promise<void> {
    const response = await this.fetchImpl(`${base}/contact/v3/users/basic_batch?user_id_type=open_id`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, signal,
      body: JSON.stringify({ user_ids: sources.map(source => source.openId) }),
    });
    const body = await response.json() as { code?: number; data?: { users?: unknown[] } };
    if (!response.ok || body.code !== 0 || !Array.isArray(body.data?.users)) return;
    for (const user of body.data.users) {
      if (!isRecord(user)) continue;
      const source = sources.find(source => source.openId === user.user_id);
      if (!source) continue;
      const i18n = isRecord(user.i18n_name) ? user.i18n_name : {};
      const name = profileText(user.name) ?? profileText(i18n.zh_cn)
        ?? profileText(i18n.en_us) ?? profileText(i18n.ja_jp);
      if (name) profiles.set(source.id, { name, nameEn: profileText(i18n.en_us) });
    }
  }
}

type SenderProfile = { name: string; nameEn: string | null };
type SenderProfileSource = { id: string; appId: string; openId: string; messageId: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function profileText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= 512 && !/^feishu user$/i.test(text) ? text : null;
}
