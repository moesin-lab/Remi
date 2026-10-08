import { expect } from "bun:test";
import type { MultiremiTask } from "@multiremi/contracts/types.js";
import type { MultiremiStore } from "@multiremi/store.js";

export function inboxReportEntry(store: MultiremiStore, task: MultiremiTask, sourceTaskId: string) {
  const entries = store.listConversationLogEntries(task.issueSessionId!)
    .filter(entry => entry.author_type === "system" && entry.metadata.envelope?.source.taskId === sourceTaskId);
  expect(entries).toHaveLength(1);
  const comment = store.getIssueComment(entries[0]!.id);
  if (store.getIssueSession(task.issueSessionId!)?.chatId) expect(comment).toBeNull();
  else expect(comment?.body).toBe(entries[0]!.body_md);
  return entries[0]!;
}

/** Assert reports are durable envelopes on the recipient session's log. */
export function inboxReportBody(store: MultiremiStore, task: MultiremiTask, sourceTaskId?: string): string {
  const envelopes = store.listConversationLogEntries(task.issueSessionId!).filter(entry => {
    const envelope = entry.metadata.envelope;
    return envelope && (sourceTaskId === undefined || envelope.source.taskId === sourceTaskId);
  });
  expect(envelopes.length).toBeGreaterThan(0);
  return envelopes.map(entry => {
    expect(entry.author_type).toBe("system");
    const comment = store.getIssueComment(entry.id);
    if (store.getIssueSession(task.issueSessionId!)?.chatId) expect(comment).toBeNull();
    else {
      if (!comment) throw new Error("Public Issue envelope comment was not persisted");
      expect(entry.body_md).toBe(comment.body);
    }
    return entry.body_md;
  }).join("\n\n");
}
