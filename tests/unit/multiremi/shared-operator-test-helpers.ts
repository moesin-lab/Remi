import type { MultiremiStore } from "@multiremi/store.js";

/** Seed an already-delivered historical notification independently of current self-notification policy. */
export function seedHistoricalCommentNotification(store: MultiremiStore, issueId: string, memberId: string, body: string) {
  return store.sendMessage({
    session_id: store.getOrCreateDefaultIssueSession(issueId).id,
    sender: { type: "platform", id: null },
    to: { type: "member", ref: memberId },
    message_kind: "status", wake_requested: "inbox_only", body_md: body,
    metadata: { inbox_item: { type: "comment_created", severity: "info", title: body } },
  }).message;
}
