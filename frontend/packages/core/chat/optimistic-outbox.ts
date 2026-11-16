import { create } from "zustand";
import type { Attachment } from "../types";
import { useContinuityStore } from "../platform-lifecycle/continuity";

export interface OptimisticChatRow {
  clientId: string;
  sessionId: string;
  content: string;
  attachmentIds?: string[];
  attachments?: Attachment[];
  createdAt: string;
  localSeq: number;
  /**
   * `sent` once the server accepted the message (its answer, or its row in the
   * log); `unconfirmed` when the send got no answer and the log has not shown
   * it yet; `failed` when the server refused it.
   */
  status: "sending" | "sent" | "unconfirmed" | "failed" | "hidden";
  /** When the log first held the server's row; only that row renders after it. */
  confirmedAt?: number;
}

/** Own message bodies and dedupe keys beyond any ChatWindow's lifetime. */
export const useOptimisticChatOutbox = create<{ rows: OptimisticChatRow[] }>(() => ({ rows: [] }));
export function setOptimisticChatRows(update: (rows: OptimisticChatRow[]) => OptimisticChatRow[]) {
  useOptimisticChatOutbox.setState(state => ({ rows: update(state.rows) }));
}
// Ownership ends on confirmation/refusal, never on component unmount.
useOptimisticChatOutbox.subscribe(state => {
  useContinuityStore.setState({ heldSends: state.rows.filter(row =>
    row.status === "sending" || row.status === "unconfirmed").length });
});
