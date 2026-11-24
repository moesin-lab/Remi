/**
 * Feishu message receiving — WebSocket listener + message parsing.
 * Extracted from OpenClaw bot.ts + monitor.ts, stripped of OpenClaw dependencies.
 */

import * as Lark from "@larksuiteoapi/node-sdk";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { FeishuChannelConfig, FeishuSenderAuthorizer, GroupPolicy } from "./config.js";
import { hashIdentifier, redactFeishuError } from "./log-redaction.js";
import { createHash } from "node:crypto";
import { describeFeishuCommand, feishuCommandDigest } from "@shared/feishu-command-semantic.js";
import { FeishuDeliveryError } from "@shared/feishu-delivery-error.js";
import type { FeishuCommandSemantic } from "@multiremi/contracts/types.js";
import { feishuSessionKey } from "./types.js";
import { setFeishuMessageReceipt } from "./message-receipt.js";
import { foldFeishuWakeWord } from "@shared/feishu-wake-words.js";
import { createLogger } from "@shared/logger.js";

const log = createLogger("feishu");
import type { FeishuMessageEvent, FeishuMessageContext, FeishuMediaInfo } from "./types.js";
import {
  createEventDispatcher,
  createFeishuClient,
  createFeishuWSClient,
  probeFeishu,
  waitForFeishuWSReady,
} from "./client.js";

function stripWakeWord(content: string, authoredPrefix: string, words: readonly string[]): string | null {
  if (!words.length) return null;
  const text = content.trim();
  const prefix = foldFeishuWakeWord(authoredPrefix.trimStart());
  let longest = 0;
  for (const word of words) {
    if (word.length <= longest || !prefix.startsWith(foldFeishuWakeWord(word))) continue;
    if (/[A-Za-z0-9_]$/.test(word) && /^[A-Za-z0-9_]/.test(text.slice(word.length))) continue;
    longest = word.length;
  }
  return longest ? text.slice(longest).trimStart() : null;
}

type GroupMessageDropReason =
  | "duplicate"
  | "membership_gate_unconfigured"
  | "membership_unavailable"
  | "not_member"
  | "bot_open_id_unresolved"
  | "directed_at_others"
  | "not_mentioned"
  | "bot_message"
  | "connector_stopped"
  | "processing_error";

function logDroppedGroupMessage(
  event: FeishuMessageEvent,
  reason: GroupMessageDropReason,
  level: "info" | "warn" | "error" = "info",
): void {
  if (event.message.chat_type !== "group") return;
  log[level](
    `dropped group message message_id=${event.message.message_id} chat_hash=${hashIdentifier(event.message.chat_id)} reason=${reason}`,
  );
}
import { downloadMessageResourceFeishu, FeishuAttachmentTooLargeError } from "./media.js";
import { extractMentionTargets, extractMessageBody } from "./mention.js";
import { buildMarkdownCard, getMessageFeishu, sendCardFeishu } from "./send.js";
import { handleFormSubmission, handleButtonClick, hasPendingAction } from "./card-actions.js";
import { handleIssueDecisionInteractionEvent, handleTaskInteractionEvent } from "./task-interaction.js";

import { FeishuAdmissionUnavailable, FeishuInboundRecovery, feishuRecoveryPath, recoverFeishuHistory, type FeishuInboundDelivery, type CommandReply } from "./inbound-recovery.js";

// ── Dedup (persisted across restarts) ────────────────────────
const DEDUP_TTL_MS = 30 * 60 * 1000;
const DEDUP_MAX_SIZE = 1_000;
const DEDUP_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
let dedupCachePath = join(homedir(), ".remi", "dedup-cache.json");
const processedMessageIds = new Map<string, number>();
let lastCleanupTime = Date.now();
let dedupDirty = false;
let dedupLoaded = false;
let dedupFlushTimer: ReturnType<typeof setTimeout> | null = null;

/** Load persisted dedup cache from disk (best-effort). */
function loadDedupCache(): void {
  if (dedupLoaded) return;
  dedupLoaded = true;
  try {
    if (!existsSync(dedupCachePath)) return;
    const raw = readFileSync(dedupCachePath, "utf-8");
    const entries: [string, number][] = JSON.parse(raw);
    const now = Date.now();
    for (const [id, ts] of entries) {
      if (now - ts < DEDUP_TTL_MS) {
        processedMessageIds.set(id, ts);
      }
    }
    log.info(`loaded ${processedMessageIds.size} dedup entries from cache`);
  } catch {
    // Corrupt or missing — start fresh
  }
}

/** Flush dedup cache to disk (debounced, best-effort). */
function scheduleDedupFlush(): void {
  if (dedupFlushTimer) return; // already scheduled
  dedupFlushTimer = setTimeout(() => {
    dedupFlushTimer = null;
    if (!dedupDirty) return;
    flushDedupCacheSync();
  }, 2000);
}

/** Synchronously flush dedup cache to disk. Called on connector stop to prevent
 *  message re-delivery after restart (the 2s debounce may not fire before exit). */
export function flushDedupCacheSync(): void {
  if (!dedupDirty) return;
  try {
    const dir = dirname(dedupCachePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(dedupCachePath, JSON.stringify([...processedMessageIds]));
    dedupDirty = false;
  } catch {
    // Non-critical
  }
}

/** Isolate the persisted dedup cache in tests without changing production defaults. */
export function setDedupCachePathForTesting(path: string): void {
  if (dedupFlushTimer) {
    clearTimeout(dedupFlushTimer);
    dedupFlushTimer = null;
  }
  dedupCachePath = path;
  processedMessageIds.clear();
  lastCleanupTime = Date.now();
  dedupDirty = false;
  dedupLoaded = false;
}

function tryRecordMessage(messageId: string): boolean {
  loadDedupCache();
  const now = Date.now();
  if (now - lastCleanupTime > DEDUP_CLEANUP_INTERVAL_MS) {
    for (const [id, ts] of processedMessageIds) {
      if (now - ts > DEDUP_TTL_MS) processedMessageIds.delete(id);
    }
    lastCleanupTime = now;
  }
  if (processedMessageIds.has(messageId)) return false;
  if (processedMessageIds.size >= DEDUP_MAX_SIZE) {
    const first = processedMessageIds.keys().next().value!;
    processedMessageIds.delete(first);
  }
  processedMessageIds.set(messageId, now);
  dedupDirty = true;
  scheduleDedupFlush();
  return true;
}

// ── Sender name resolution ───────────────────────────────────
const SENDER_NAME_TTL_MS = 10 * 60 * 1000;
const senderNameCache = new Map<string, { name: string; expireAt: number }>();

async function resolveSenderName(
  client: Lark.Client,
  senderOpenId: string,
): Promise<string | undefined> {
  if (!senderOpenId) return undefined;

  const cached = senderNameCache.get(senderOpenId);
  const now = Date.now();
  if (cached && cached.expireAt > now) return cached.name || undefined;

  try {
    const response = await client.request<{
      data?: {
        users?: Array<{
          name?: string;
          i18n_name?: { en_us?: string; zh_cn?: string; ja_jp?: string };
        }>;
      };
    }>({
      method: "POST",
      url: "/open-apis/contact/v3/users/basic_batch",
      params: { user_id_type: "open_id" },
      data: { user_ids: [senderOpenId] },
    });
    const user = response?.data?.users?.[0];
    const name: string | undefined = user?.name
      || user?.i18n_name?.en_us
      || user?.i18n_name?.zh_cn
      || user?.i18n_name?.ja_jp;
    if (name && typeof name === "string") {
      senderNameCache.set(senderOpenId, { name, expireAt: now + SENDER_NAME_TTL_MS });
      return name;
    }
  } catch {
    // Older/private deployments may not expose basic_batch; use the regular
    // contact endpoint for users inside the app's address-book scope.
  }

  try {
    const res: any = await client.contact.user.get({
      path: { user_id: senderOpenId },
      params: { user_id_type: "open_id" },
    });
    const name: string | undefined =
      res?.data?.user?.name ||
      res?.data?.user?.display_name ||
      res?.data?.user?.nickname ||
      res?.data?.user?.en_name;
    if (name && typeof name === "string") {
      senderNameCache.set(senderOpenId, { name, expireAt: now + SENDER_NAME_TTL_MS });
      return name;
    }
  } catch (err) {
    log.info(`resolveSenderName failed: ${redactFeishuError(err)}`);
    // Negative cache: avoid repeated failed API calls for the same open_id
    senderNameCache.set(senderOpenId, { name: "", expireAt: now + SENDER_NAME_TTL_MS });
  }
  return undefined;
}

// ── Message content parsing ──────────────────────────────────

function parseTextContent(content: string, messageType: string): string {
  try {
    const parsed = JSON.parse(content);
    if (messageType === "text") return parsed.text || "";
    if (messageType === "post") return parsePostContent(content).textContent;
    return content;
  } catch {
    return content;
  }
}

function callbackValueText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(callbackValueText).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.value === "string") return obj.value;
    if (typeof obj.label === "string") return obj.label;
    if (typeof obj.content === "string") return obj.content;
    if (obj.text && typeof obj.text === "object") return callbackValueText((obj.text as Record<string, unknown>).content);
  }
  return String(value);
}

/** Strip simple HTML tags (e.g. <p>, <br>, <b>) from text, preserving inner content. */
function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]+>/g, "").trim();
}

export function parsePostContent(content: string, authoredPrefixOnly = false): { textContent: string; imageKeys: string[] } {
  try {
    const parsed = JSON.parse(content);
    // Post messages may be wrapped in a locale key (zh_cn, en_us, ja_jp, etc.)
    const localeKey = Object.keys(parsed).find((k) => typeof parsed[k] === "object" && parsed[k]?.content);
    const body = localeKey ? parsed[localeKey] : parsed;
    const title = body.title || "";
    const contentBlocks = body.content || [];
    let textContent = title ? `${title}\n\n` : "";
    const imageKeys: string[] = [];

    for (const paragraph of contentBlocks) {
      if (Array.isArray(paragraph)) {
        for (const element of paragraph) {
          if (authoredPrefixOnly && element.tag !== "text" && element.tag !== "img") {
            return { textContent: stripHtmlTags(textContent), imageKeys };
          }
          if (element.tag === "text") textContent += element.text || "";
          else if (element.tag === "a") textContent += `[${element.text || ""}](${element.href || ""})`;
          else if (element.tag === "at") textContent += `@${element.user_name || element.user_id || ""}`;
          else if (element.tag === "img" && element.image_key) imageKeys.push(element.image_key);
          else if (element.tag === "code_block") textContent += `\`\`\`${element.language || ""}\n${element.text || ""}\`\`\`\n`;
          else if (element.tag === "emotion") textContent += element.emoji_type ? `[${element.emoji_type}]` : "";
          else if (element.text) textContent += element.text; // fallback for unknown tags with text
        }
        textContent += "\n";
      }
    }

    return { textContent: stripHtmlTags(textContent.trim()) || (authoredPrefixOnly ? "" : "[富文本消息]"), imageKeys };
  } catch {
    return { textContent: authoredPrefixOnly ? "" : "[富文本消息]", imageKeys: [] };
  }
}

function parseMediaKeys(
  content: string,
  messageType: string,
): { imageKey?: string; fileKey?: string; fileName?: string } {
  try {
    const parsed = JSON.parse(content);
    switch (messageType) {
      case "image":
        return { imageKey: parsed.image_key };
      case "file":
        return { fileKey: parsed.file_key, fileName: parsed.file_name };
      case "audio":
        return { fileKey: parsed.file_key, fileName: parsed.file_name };
      case "media":
        return { fileKey: parsed.file_key, imageKey: parsed.image_key, fileName: parsed.file_name };
      case "sticker":
        return { fileKey: parsed.file_key };
      default:
        return {};
    }
  } catch {
    return {};
  }
}

/** Resolve merge_forward message: fetch sub-messages and concatenate their text. */
async function resolveMergeForward(client: Lark.Client, messageId: string): Promise<string | null> {
  const response = (await client.im.message.get({
    path: { message_id: messageId },
  })) as {
    code?: number;
    data?: {
      items?: Array<{
        message_id?: string;
        msg_type?: string;
        body?: { content?: string };
        upper_message_id?: string;
        sender?: { id?: string; sender_type?: string };
      }>;
    };
  };

  if (response.code !== 0) return null;
  const items = response.data?.items;
  if (!items || items.length <= 1) return null;

  // Skip the first item (the merge_forward wrapper itself), process sub-messages
  const parts: string[] = [];
  const anonymousMap = new Map<string, number>(); // open_id → user number
  for (const item of items) {
    if (item.message_id === messageId) continue; // skip parent
    const content = item.body?.content ?? "";
    let text = "";
    try {
      if (item.msg_type === "text") {
        const parsed = JSON.parse(content);
        text = stripHtmlTags(parsed.text || content);
      } else if (item.msg_type === "post") {
        text = parsePostContent(content).textContent;
      } else if (item.msg_type === "image") {
        // Note: cannot download images from merge_forward sub-messages (bot lacks access to cross-context message_ids)
        text = "[图片]";
      } else if (item.msg_type === "file") {
        text = "[文件]";
      } else if (item.msg_type === "sticker") {
        text = "[表情包]";
      } else if (item.msg_type === "merge_forward") {
        text = "[嵌套合并转发]";
      } else {
        text = content || `[${item.msg_type}]`;
      }
    } catch {
      text = content || `[${item.msg_type}]`;
    }

    // Prefix sender identity (name or numbered fallback)
    const senderOpenId = item.sender?.id;
    if (senderOpenId && text) {
      const name = await resolveSenderName(client, senderOpenId);
      if (name) {
        text = `${name}: ${text}`;
      } else {
        if (!anonymousMap.has(senderOpenId)) {
          anonymousMap.set(senderOpenId, anonymousMap.size + 1);
        }
        text = `用户${anonymousMap.get(senderOpenId)}: ${text}`;
      }
    }

    if (text) parts.push(text);
  }

  // Log an anonymized mapping for traceability without exposing open_id values.
  if (anonymousMap.size > 0) {
    const mapping = [...anonymousMap.entries()]
      .map(([id, n]) => `用户${n}=${hashIdentifier(id)}`)
      .join(", ");
    log.info(`merge_forward sender mapping: ${mapping}`);
  }

  if (parts.length === 0) return null;
  return `[合并转发消息，共${parts.length}条]\n\n${parts.join("\n\n---\n\n")}`;
}

function inferPlaceholder(messageType: string): string {
  switch (messageType) {
    case "image": return "<media:image>";
    case "file": return "<media:document>";
    case "audio": return "<media:audio>";
    case "media": return "<media:video>";
    case "sticker": return "<media:sticker>";
    default: return "<media:document>";
  }
}

function checkBotMentioned(event: FeishuMessageEvent, botOpenId?: string): boolean {
  const mentions = event.message.mentions ?? [];
  if (mentions.length === 0 || !botOpenId) return false;
  return mentions.some((m) => m.id.open_id === botOpenId);
}

function stripBotMention(text: string, mentions?: FeishuMessageEvent["message"]["mentions"]): string {
  if (!mentions || mentions.length === 0) return text;
  let result = text;
  for (const mention of mentions) {
    if (mention.key) result = result.replaceAll(mention.key, "").trim();
    if (mention.name) result = result.replaceAll(`@${mention.name}`, "").trim();
  }
  return result;
}

// ── Public API ───────────────────────────────────────────────

/** Parse a raw Feishu message event into a FeishuMessageContext. */
export function parseFeishuMessageEvent(
  event: FeishuMessageEvent,
  botOpenId?: string,
): FeishuMessageContext {
  const rawContent = parseTextContent(event.message.content, event.message.message_type);
  const mentionedBot = checkBotMentioned(event, botOpenId);
  const content = stripBotMention(rawContent, event.message.mentions);
  const senderIds = event.sender.sender_id ?? {};

  return {
    chatId: event.message.chat_id,
    messageId: event.message.message_id,
    senderId: senderIds.user_id || senderIds.open_id || "",
    senderOpenId: senderIds.open_id || "",
    senderUserId: senderIds.user_id || "",
    senderUnionId: senderIds.union_id || "",
    senderTenantKey: event.sender.tenant_key || "",
    chatType: event.message.chat_type,
    mentionedBot,
    rootId: event.message.root_id || undefined,
    parentId: event.message.parent_id || undefined,
    content,
    contentType: event.message.message_type,
  };
}

/** Resolve media from a message, downloading into buffers. */
export async function resolveFeishuMedia(
  client: Lark.Client,
  messageId: string,
  messageType: string,
  content: string,
): Promise<FeishuMediaInfo[]> {
  const mediaTypes = ["image", "file", "audio", "media", "sticker", "post"];
  if (!mediaTypes.includes(messageType)) return [];

  if (messageType === "sticker") return [{ buffer: Buffer.alloc(0), placeholder: "<media:sticker>" }];

  const out: FeishuMediaInfo[] = [];

  // Handle embedded images in rich text posts
  if (messageType === "post") {
    const { imageKeys } = parsePostContent(content);
    for (const imageKey of imageKeys) {
      try {
        const result = await downloadMessageResourceFeishu(client, messageId, imageKey, "image");
        out.push({
          buffer: result.buffer,
          contentType: result.contentType,
          placeholder: "<media:image>",
          imageKey,
        });
      } catch (error) {
        out.push({ buffer: Buffer.alloc(0), placeholder: "<media:image>", imageKey,
          rejectedReason: error instanceof FeishuAttachmentTooLargeError ? "too_large" : "download_failed" });
      }
    }
    return out;
  }

  // Handle other media types
  const mediaKeys = parseMediaKeys(content, messageType);
  const fileKey = messageType === "image" ? mediaKeys.imageKey : mediaKeys.fileKey;
  if (!fileKey) return [{ buffer: Buffer.alloc(0), placeholder: inferPlaceholder(messageType),
    fileName: mediaKeys.fileName, rejectedReason: "download_failed" }];

  try {
    const resourceType = messageType === "image" ? "image" : "file";
    const result = await downloadMessageResourceFeishu(client, messageId, fileKey, resourceType);
    out.push({
      buffer: result.buffer,
      contentType: result.contentType,
      fileName: result.fileName || mediaKeys.fileName,
      placeholder: inferPlaceholder(messageType),
      imageKey: mediaKeys.imageKey,
    });
  } catch (error) {
    out.push({ buffer: Buffer.alloc(0), placeholder: inferPlaceholder(messageType),
      fileName: mediaKeys.fileName, imageKey: mediaKeys.imageKey,
      rejectedReason: error instanceof FeishuAttachmentTooLargeError ? "too_large" : "download_failed" });
  }

  return out;
}

// ── Parsed message for connector ─────────────────────────────

export type ParsedFeishuMessage = {
  fromHistory?: boolean;
  text: string;
  /** Raw content without speaker prefix or quote wrapper (for command detection). */
  rawContent: string;
  chatId: string;
  senderOpenId: string;
  senderUserId: string;
  senderUnionId: string;
  senderTenantKey: string;
  senderName?: string;
  messageId: string;
  chatType: "p2p" | "group";
  mentionedBot: boolean;
  /** True if this message was admitted via monitor mode (not @mention). */
  monitored: boolean;
  media: FeishuMediaInfo[];
  quotedContent?: string;
  rootId?: string;
};

export type FeishuAdmissionDenialReason = "not_member" | "unavailable";

export interface FeishuMessageAdmissionOptions {
  classify?: (context: FeishuMessageContext, monitored: boolean) => boolean;
  onAllowed?: (context: FeishuMessageContext) => boolean;
  onExplicitHistoryDenial?: () => void;
  denialOnly?: boolean;
  groupPolicy?: GroupPolicy;
  wakeWords?: readonly string[];
  /** Durable Task intake uses the server's external_message_id dedup. */
  durableIntake?: boolean;
  authorizeSender: FeishuSenderAuthorizer;
  onDenied: (
    context: FeishuMessageContext,
    reason: FeishuAdmissionDenialReason,
  ) => Promise<void>;
}

export function feishuAdmissionDenialMessage(reason: FeishuAdmissionDenialReason): string {
  return reason === "not_member"
    ? "你还没有使用此机器人的权限。请联系空间管理员在「IM 平台 → 飞书 → 访问控制」中将你加入白名单。"
    : "暂时无法验证机器人使用权限，请稍后再试。";
}

async function denyFeishuMessage(
  options: FeishuMessageAdmissionOptions,
  context: FeishuMessageContext,
  reason: FeishuAdmissionDenialReason,
): Promise<null> {
  try {
    await options.onDenied(context, reason);
  } catch {
    log.error("failed to send Feishu sender access denial");
  }
  return null;
}

/** Full message processing pipeline: dedup → parse → authorize → resolve sender/media/quote. */
export async function processFeishuMessageEvent(
  client: Lark.Client,
  event: FeishuMessageEvent,
  botOpenId?: string,
  admission?: FeishuMessageAdmissionOptions,
): Promise<ParsedFeishuMessage | null> {
  const messageId = event.message.message_id;

  if ((event.sender as { sender_type?: string }).sender_type === "app"
      || (event.sender as { sender_type?: string }).sender_type === "bot"
      || (botOpenId && event.sender.sender_id?.open_id === botOpenId)) {
    logDroppedGroupMessage(event, "bot_message");
    return null;
  }
  if (admission?.durableIntake && event.message.chat_type === "group"
      && event.message.mentions?.length && !botOpenId) {
    throw new FeishuAdmissionUnavailable("Feishu bot identity unavailable for durable group admission");
  }

  // Dedup
  if (!admission?.durableIntake && !tryRecordMessage(messageId)) {
    logDroppedGroupMessage(event, "duplicate");
    return null;
  }

  // Parse
  const ctx = parseFeishuMessageEvent(event, botOpenId);

  if (!admission) {
    log.error("Feishu sender authorizer is not configured");
    logDroppedGroupMessage(event, "membership_gate_unconfigured", "error");
    return null;
  }

  let monitored = false;
  if (ctx.chatType === "group" && !ctx.mentionedBot) {
    if (event.message.mentions?.length) {
      logDroppedGroupMessage(event, botOpenId ? "directed_at_others" : "bot_open_id_unresolved");
      return null;
    }
    monitored = admission.groupPolicy?.getByChatId(ctx.chatId)?.monitor === true;
    if (!monitored) {
      const words = admission.wakeWords ?? [];
      const type = event.message.message_type;
      const prefix = words.length && type === "post" ? parsePostContent(event.message.content, true).textContent : ctx.content;
      const body = (type === "text" || type === "post") && stripWakeWord(ctx.content, prefix, words);
      if (!body) {
        logDroppedGroupMessage(event, "not_mentioned");
        return null;
      }
      ctx.content = body;
    }
  }
  if (admission.classify && !admission.classify(ctx, monitored)) return null;
  const shouldNotifyAdmissionDenial = !monitored && event.recovery_source !== "history";
  if (admission.durableIntake && !ctx.senderOpenId && !ctx.senderUserId && !ctx.senderUnionId) {
    throw new FeishuAdmissionUnavailable("Feishu sender identity temporarily unavailable");
  }
  let admitted = false;
  try {
    admitted = Boolean(ctx.senderOpenId || ctx.senderUnionId || ctx.senderUserId)
      && await admission.authorizeSender(ctx.senderOpenId, ctx);
  } catch {
    if (admission.durableIntake) throw new FeishuAdmissionUnavailable("Feishu sender admission temporarily unavailable");
    log.error("Feishu sender authorization unavailable");
    logDroppedGroupMessage(event, "membership_unavailable", "warn");
    return shouldNotifyAdmissionDenial
      ? denyFeishuMessage(admission, ctx, "unavailable")
      : null;
  }
  if (!admitted) {
    if (!monitored && event.recovery_source === "history") admission.onExplicitHistoryDenial?.();
    log.warn("Feishu sender access denied");
    logDroppedGroupMessage(event, "not_member", "warn");
    return shouldNotifyAdmissionDenial
      ? denyFeishuMessage(admission, ctx, "not_member")
      : null;
  }
  log.info("Feishu sender access allowed");
  if (admission.denialOnly || admission.onAllowed?.(ctx)) return null;

  // Resolve sender name (best-effort)
  const senderName = await resolveSenderName(client, ctx.senderOpenId);

  // Resolve media
  const media = await resolveFeishuMedia(
    client,
    ctx.messageId,
    event.message.message_type,
    event.message.content,
  );

  // Resolve quoted message
  let quotedContent: string | undefined;
  if (ctx.parentId) {
    try {
      const quoted = await getMessageFeishu(client, ctx.parentId);
      if (quoted) quotedContent = quoted.content;
    } catch {
      // Skip
    }
  }

  // Resolve merge_forward sub-messages
  if (event.message.message_type === "merge_forward") {
    try {
      const mergedText = await resolveMergeForward(client, ctx.messageId);
      if (mergedText) ctx.content = mergedText;
    } catch {
      // Keep original content on failure
    }
  }

  // Build text
  let text = ctx.content;
  if (quotedContent) {
    text = `[Replying to: "${quotedContent}"]\n\n${text}`;
  }

  // Add speaker label for group context
  const speaker = senderName ?? ctx.senderOpenId;
  if (ctx.chatType === "group") {
    text = `${speaker}: ${text}`;
  }

  // Append media placeholders
  for (const m of media) {
    text += `\n${m.placeholder}`;
  }

  return {
    text,
    rawContent: ctx.content,
    fromHistory: event.recovery_source === "history",
    chatId: ctx.chatId,
    senderOpenId: ctx.senderOpenId,
    senderUserId: ctx.senderUserId,
    senderUnionId: ctx.senderUnionId,
    senderTenantKey: ctx.senderTenantKey,
    senderName,
    messageId: ctx.messageId,
    chatType: ctx.chatType,
    mentionedBot: ctx.mentionedBot,
    monitored,
    media,
    quotedContent,
    rootId: ctx.rootId,
  };
}

// ── WebSocket listener ───────────────────────────────────────

export type FeishuMessageCallback = (msg: ParsedFeishuMessage) => Promise<void>;

export type FeishuWSHandle = {
  ready: Promise<void>;
  botOpenIdReady: Promise<void>;
  stop(): void;
};

export interface FeishuBotIdentityState {
  botOpenId?: string;
  botOpenIdReady: Promise<void>;
}

export interface FeishuBotIdentityOptions {
  backoffMs?: readonly number[];
  probe?: typeof probeFeishu;
  sleep?: (delayMs: number) => Promise<void>;
}

const DEFAULT_BOT_OPEN_ID_BACKOFF_MS = [1_000, 2_000, 4_000] as const;
const BOT_OPEN_ID_WAIT_TIMEOUT_MS = 10_000;

export function createFeishuBotIdentityState(
  creds: Parameters<typeof probeFeishu>[0],
  options: FeishuBotIdentityOptions = {},
): FeishuBotIdentityState {
  const backoffMs = options.backoffMs ?? DEFAULT_BOT_OPEN_ID_BACKOFF_MS;
  const probe = options.probe ?? probeFeishu;
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  }));
  const state: FeishuBotIdentityState = {
    botOpenIdReady: Promise.resolve(),
  };

  state.botOpenIdReady = (async () => {
    for (let attempt = 0; attempt <= backoffMs.length; attempt += 1) {
      if (attempt > 0) await sleep(backoffMs[attempt - 1]!);

      try {
        const result = await probe(creds, { skipCache: attempt > 0 });
        if (result.ok && result.botOpenId) {
          state.botOpenId = result.botOpenId;
          log.info(`bot identity resolved attempt=${attempt + 1}`);
          return;
        }
      } catch {
        // Retry below. The final error intentionally omits provider payloads.
      }
    }

    log.error(
      `bot identity unresolved after attempts=${backoffMs.length + 1}; group @mention detection is degraded`,
    );
  })();

  return state;
}

async function waitForBotOpenIdReady(
  botOpenIdReady: Promise<void>,
  timeoutMs = BOT_OPEN_ID_WAIT_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      botOpenIdReady,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function processFeishuMessageEventWithBotIdentity(
  client: Lark.Client,
  event: FeishuMessageEvent,
  botIdentity: FeishuBotIdentityState,
  admission: FeishuMessageAdmissionOptions,
  timeoutMs = BOT_OPEN_ID_WAIT_TIMEOUT_MS,
): Promise<ParsedFeishuMessage | null> {
  await waitForBotOpenIdReady(botIdentity.botOpenIdReady, timeoutMs);
  return processFeishuMessageEvent(client, event, botIdentity.botOpenId, admission);
}

function terminalCommandError(error: unknown): error is { code: string } {
  return !!error && typeof error === "object" && "code" in error && ["command_conflict", "invalid_command", "command_endpoint_unsupported", "sender_not_allowed"].includes(String(error.code));
}

async function sendJournaledReply(client: Lark.Client, active: FeishuInboundRecovery, id: string, reply: CommandReply): Promise<boolean> {
  if (reply.uncertain && active.now() - reply.firstSendAt! >= 55 * 60_000) {
    active.skipped(reply.chatId, "command_reply_delivery_unknown", id);
    return false;
  }
  const attempt = { ...reply, firstSendAt: reply.firstSendAt ?? active.now(), uncertain: true };
  active.checkpoint(id, { reply: attempt });
  try {
    const sent = await sendCardFeishu(client, reply.chatId, reply.card, { replyToMessageId: reply.replyTo, idempotencyKey: reply.uuid });
    active.checkpoint(id, { reply: { ...attempt, messageId: sent.messageId, uncertain: false } });
  } catch (error) {
    if (error instanceof FeishuDeliveryError && !error.ambiguous) {
      active.checkpoint(id, { reply: { ...attempt, uncertain: !!reply.uncertain } });
      if (!error.retryable) { active.skipped(reply.chatId, reply.uncertain ? "command_reply_delivery_unknown" : "command_reply_failed", id); return false; }
    }
    throw error;
  }
  return true;
}

/** Shared live/history intake; exported for transport-independent recovery verification. */
export function createFeishuInboundDelivery(options: {
  wakeWords?: readonly string[];
  groupPolicy?: GroupPolicy;
  client: Lark.Client;
  botIdentity: FeishuBotIdentityState;
  authorizeSender: FeishuSenderAuthorizer;
  onMessage: FeishuMessageCallback;
  recovery: FeishuInboundRecovery | null;
  appId: string;
  domain?: FeishuCommandSemantic["domain"];
  isStopped?: () => boolean;
}): FeishuInboundDelivery {
  const { client, botIdentity, authorizeSender, onMessage, appId } = options;
  const domain = options.domain ?? "feishu";
  const runtime = authorizeSender.commands;
  const journal = options.recovery ?? new FeishuInboundRecovery(null);
  const handle: FeishuInboundDelivery = async (event, liveOnly, active = journal) => {
    const checkActive = () => {
      if (options.isStopped?.()) throw new Error("Feishu connector stopped before acknowledgement");
    };
    checkActive();
    const id = event.message.message_id;
    const previous = active.progress(id);
    let classified: { semantic: FeishuCommandSemantic; context: FeishuMessageContext; monitored: boolean } | undefined;
    let allowed = false, denied = false, historyDenied = false;
    const msg = await processFeishuMessageEventWithBotIdentity(client, event, botIdentity, {
      authorizeSender, denialOnly: liveOnly === "denial", durableIntake: true,
      groupPolicy: options.groupPolicy, wakeWords: options.wakeWords,
      classify(context, monitored) {
        const semantic = describeFeishuCommand({ domain, app_id: appId, external_message_id: id,
          sender_open_id: context.senderOpenId, external_session_key: feishuSessionKey(context),
          chat_id: context.chatId, raw_content: context.content });
        if (!context.senderOpenId) throw new FeishuAdmissionUnavailable("Feishu sender identity temporarily unavailable");
        const digest = feishuCommandDigest(semantic);
        if ((previous.digest && digest !== previous.digest) || (previous.botId && previous.botId !== runtime?.botId)) return false;
        if (previous.legacyPending && event.recovery_source !== "history" && ["stop", "new"].includes(semantic.name)) {
          active.skipped(context.chatId, "upgrade_write_outcome_unknown_resend_new_message", id);
          return false;
        }
        if (!previous.digest) active.checkpoint(id, { digest, botId: runtime?.botId });
        classified = { semantic, context, monitored };
        return true;
      },
      onAllowed: () => { allowed = true; return classified?.semantic.kind !== "message" && (!!runtime || event.recovery_source === "history"); },
      onExplicitHistoryDenial: () => { historyDenied = true; },
      onDenied: async () => { denied = true; },
    });
    checkActive();
    const write = previous.write;
    const lookupOnly = write && (write.lookupOnly || !classified || runtime?.botId !== write.botId || runtime.revision !== write.revision);
    let rendered: { text: string; displayName: string } | undefined;
    if (lookupOnly && runtime && !previous.reply) {
      active.checkpoint(id, { write: { ...write, lookupOnly: true } });
      try {
        const result = await runtime.execute({ revision: runtime.revision, bot_id: runtime.botId, mode: "lookup_only", semantic: write.semantic, digest: previous.digest! });
        if (result) rendered = runtime.render(result, write.semantic);
      } catch (error) {
        if (!terminalCommandError(error)) throw error;
      }
      if (!classified || !allowed || !rendered || runtime.botId !== write.botId) {
        active.skipped(event.message.chat_id, "command_assignment_or_semantics_changed", id);
        return;
      }
    }
    if (!classified) return;
    const { semantic, context, monitored } = classified;
    const history = event.recovery_source === "history";
    if (historyDenied) return "denial";
    if (history && semantic.kind !== "message" && allowed) {
      active.skipped(context.chatId, "history_operational_command", id, semantic.name);
      return "command";
    }
    if (previous.reply && (previous.reply.botId !== runtime?.botId || previous.reply.denied !== denied || previous.reply.messageId)) return;
    if (liveOnly === "denial" && !denied) return;
    if (liveOnly === "command" && semantic.kind === "message") return;
    let reply = previous.reply;
    if (!reply) {
      let text = rendered?.text;
      if (denied) text = feishuAdmissionDenialMessage("not_member");
      else if (!rendered && runtime && allowed && semantic.kind !== "message") {
        const request = { revision: runtime.revision, bot_id: runtime.botId, mode: "execute" as const, semantic, digest: active.progress(id).digest! };
        if (semantic.name === "new" || semantic.name === "stop") active.checkpoint(id, { write: { semantic, revision: runtime.revision, botId: runtime.botId } });
        try {
          const result = await runtime.execute(request);
          if (result) { rendered = runtime.render(result, semantic); text = rendered.text; }
        }
        catch (error) {
          if (!terminalCommandError(error)) throw error;
          if (error.code !== "sender_not_allowed" || monitored) {
            active.skipped(context.chatId, error.code, id);
            return;
          }
          denied = true;
          text = feishuAdmissionDenialMessage("not_member");
        }
      } else if (msg) {
        try { await onMessage(msg); return; }
        catch (error) {
          if (!terminalCommandError(error) || error.code !== "sender_not_allowed") throw error;
          if (history) return monitored ? undefined : "denial";
          if (monitored) return;
          denied = true;
          text = feishuAdmissionDenialMessage("not_member");
        }
      }
      if (text === undefined) return;
      const uuid = createHash("sha256").update(JSON.stringify([1, domain, appId, id, denied ? "denial" : "command-result"])).digest("hex").slice(0, 32);
      const mention = !denied && context.chatType === "group" && /^ou_[A-Za-z0-9_-]+$/.test(context.senderOpenId)
        ? `<at id=${context.senderOpenId}></at> ` : "";
      const policy = options.groupPolicy?.getByChatId(context.chatId);
      const inThread = context.chatType === "group" && (!policy || policy.replyMode === "thread");
      reply = { uuid, botId: runtime?.botId, card: buildMarkdownCard(mention + text.slice(0, 12000), rendered?.displayName),
        denied, chatId: context.chatId, replyTo: denied || inThread ? id : undefined };
      active.checkpoint(id, { reply });
    }
    if (!reply.denied) {
      const authorized = await authorizeSender(context.senderOpenId, context).catch(() => {
        throw new FeishuAdmissionUnavailable("Feishu sender admission temporarily unavailable");
      });
      if (!authorized) return;
    }
    checkActive();
    const sent = await sendJournaledReply(client, active, id, reply);
    if (sent && !reply.denied && runtime) await setFeishuMessageReceipt(client, JSON.stringify([domain, appId]), id, "completed").catch(() => {});
  };
  return (event, liveOnly, active) => active ? handle(event, liveOnly, active) : journal.accept(event, handle);
}

/** Start WebSocket listener. Returns a handle to stop it. */
export function startWebSocketListener(
  config: FeishuChannelConfig,
  onMessage: FeishuMessageCallback,
  authorizeSender: FeishuSenderAuthorizer,
  groupPolicy?: GroupPolicy,
): FeishuWSHandle {
  const creds = {
    appId: config.appId,
    appSecret: config.appSecret,
    domain: (config as any).domain as string | undefined,
  };

  const client = createFeishuClient(creds);
  const botIdentity = createFeishuBotIdentityState(creds);
  let stopped = false;
  const recovery = config.recoveryChats ? new FeishuInboundRecovery(feishuRecoveryPath(creds.appId, creds.domain)) : null;
  for (const chat of config.recoveryChats ?? []) recovery!.rememberChat(chat.chat_id, chat.chat_type);
  const deliver = createFeishuInboundDelivery({ client, botIdentity, authorizeSender, onMessage,
    recovery, groupPolicy, wakeWords: config.wakeWords, appId: creds.appId, domain: config.domain, isStopped: () => stopped });
  let recovering: Promise<void> | null = null;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  const catchUp = (): Promise<void> => {
    if (!recovery || stopped) return Promise.resolve();
    if (recovering) return recovering;
    recovering = recoverFeishuHistory({ journal: recovery, deliver,
      list: params => client.im.message.list({ params }),
      warn: (id, reason) => log.warn(`Feishu recovery chat_hash=${hashIdentifier(id)} reason=${reason}`),
    }).catch(error => {
      log.warn(`Feishu inbound recovery pending: ${redactFeishuError(error, [creds.appId, creds.appSecret])}`);
    }).finally(() => {
      recovering = null;
      // Poll also catches a transparent SDK reconnect, which has no public hook.
      if (!stopped) recoveryTimer = setTimeout(() => { void catchUp(); }, 30_000);
    });
    return recovering;
  };

  // Create event dispatcher + WS client
  const eventDispatcher = createEventDispatcher({
    encryptKey: config.encryptKey,
    verificationToken: config.verificationToken,
  });



  eventDispatcher.register({
    "im.message.receive_v1": async (data) => {
      const event = data as unknown as FeishuMessageEvent;
      if (stopped) {
        logDroppedGroupMessage(event, "connector_stopped");
        return;
      }
      try {
        if (recovery) await recovery.accept(event, deliver);
        else await deliver(event);
      } catch (err) {
        log.error(`error handling message: ${redactFeishuError(err, [creds.appId, creds.appSecret])}`);
        logDroppedGroupMessage(event, "processing_error", "error");
      }
    },
    "im.message.message_read_v1": async () => {
      // Ignore read receipts
    },
    "im.chat.member.bot.added_v1": async (data) => {
      const event = data as unknown as { chat_id: string };
      log.info(`bot added to chat chat_hash=${hashIdentifier(event.chat_id)}`);
    },
    "im.chat.member.bot.deleted_v1": async (data) => {
      const event = data as unknown as { chat_id: string };
      log.info(`bot removed from chat chat_hash=${hashIdentifier(event.chat_id)}`);
    },
    // Card action callback — handles form submissions and button clicks
    // Must return a toast response within 3s for Feishu to acknowledge the interaction
    "card.action.trigger": async (data: any) => {
      if (stopped) return { toast: { type: "info", content: "Remi is stopped" } };
      try {
        const taskResponse = await handleTaskInteractionEvent(creds.appId, data);
        if (taskResponse) return taskResponse;
        // E4 decision cards (MUL-412) carry their own callback prefix and a
        // different identity (Issue + decision), so they get their own handler.
        const issueDecisionResponse = await handleIssueDecisionInteractionEvent(creds.appId, data);
        if (issueDecisionResponse) return issueDecisionResponse;
        const event = data as unknown as {
          operator?: { open_id?: string };
          action?: {
            value?: Record<string, unknown>;
            tag?: string;
            form_value?: Record<string, unknown>;
            name?: string;
          };
          card?: { card_id?: string };
        };
        const action = event.action;
        if (!action) return { toast: { type: "info", content: "No action" } };

        log.info(`card action: tag=${action.tag} name=${action.name ?? ""} has_form_value=${!!action.form_value} has_value=${!!action.value}`);
        if (action.form_value) {
          log.info(`form_value keys=[${Object.keys(action.form_value).join(",")}] raw=${JSON.stringify(action.form_value)}`);
        }

        let handled = false;
        let missingSelection = false;

        if (action.form_value) {
          // Form submission via WS: action.name is the button name, not form name.
          // Try _action_id in form_value, then action.name, then first pending action.
          const isPlanForm = Object.prototype.hasOwnProperty.call(action.form_value, "feedback_text");
          const decision = callbackValueText(action.form_value.decision).trim();
          if (isPlanForm && !decision) {
            missingSelection = true;
            log.warn(`card action missing plan decision: tag=${action.tag} name=${action.name}`);
          } else {
            const formActionId = String(action.form_value._action_id || "");
            handled = handleFormSubmission(formActionId || action.name || "", action.form_value);
          }
        } else if (action.tag === "button" && action.value) {
          // Button click — route to pending action handler
          log.info(`button value: ${typeof action.value === "string" ? action.value : JSON.stringify(action.value)}`);
          const valueStr = typeof action.value === "string"
            ? action.value
            : JSON.stringify(action.value);
          handled = handleButtonClick(valueStr);
        } else if (action.tag === "button" && action.name && hasPendingAction(action.name)) {
          missingSelection = true;
          log.warn(`card action missing selection: tag=${action.tag} name=${action.name}`);
        } else {
          log.warn(`card action not handled: tag=${action.tag} name=${action.name}`);
        }

        if (handled) return { toast: { type: "success", content: "已提交，处理中..." } };
        if (missingSelection) return { toast: { type: "error", content: "请选择审批选项后再提交" } };
        return { toast: { type: "error", content: "操作已过期或无法识别" } };
      } catch (err) {
        log.error(`error handling card action: ${String(err)}`);
        return { toast: { type: "error", content: "处理失败" } };
      }
    },
  });

  const wsClient = createFeishuWSClient(creds);
  const ready = wsClient.start({ eventDispatcher })
    .then(() => waitForFeishuWSReady(wsClient))
    .then(() => { log.info("WebSocket client connected"); void catchUp(); });
  log.info("WebSocket client starting");

  return {
    ready,
    botOpenIdReady: botIdentity.botOpenIdReady,
    stop() {
      stopped = true;
      recovery?.close();
      clearTimeout(recoveryTimer);
      wsClient.close({ force: true });
    },
  };
}
