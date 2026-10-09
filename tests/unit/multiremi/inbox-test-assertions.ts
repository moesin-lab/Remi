import { expect } from "bun:test";
import type { MultiremiTask } from "@multiremi/contracts/types.js";
import type { MultiremiStore } from "@multiremi/store.js";

function reportEntries(store: MultiremiStore, task: MultiremiTask, sourceTaskId?: string) {
  return store.listConversationLogEntries(task.issueSessionId!).filter(entry => {
    const source = entry.metadata.message_source as { taskId?: string } | undefined;
    return entry.author_type === "system" && source
      && (sourceTaskId === undefined || source.taskId === sourceTaskId);
  });
}

function assertCommentProjection(store: MultiremiStore, task: MultiremiTask, entry: ReturnType<typeof reportEntries>[number]) {
  const comment = store.getIssueComment(entry.id);
  if (store.getIssueSession(task.issueSessionId!)?.chatId) expect(comment).toBeNull();
  else expect(comment?.body).toBe(entry.body_md);
}

export function inboxReportEntry(store: MultiremiStore, task: MultiremiTask, sourceTaskId: string) {
  const entries = reportEntries(store, task, sourceTaskId);
  expect(entries).toHaveLength(1);
  assertCommentProjection(store, task, entries[0]!);
  return entries[0]!;
}

/** Assert reports are durable canonical messages on the recipient session's log. */
export function inboxReportBody(store: MultiremiStore, task: MultiremiTask, sourceTaskId?: string): string {
  const entries = reportEntries(store, task, sourceTaskId);
  expect(entries.length).toBeGreaterThan(0);
  return entries.map(entry => {
    assertCommentProjection(store, task, entry);
    return entry.body_md;
  }).join("\n\n");
}
