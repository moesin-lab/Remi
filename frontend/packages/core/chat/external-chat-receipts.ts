import type { ExternalChatReceipt } from "@multiremi/contracts";
import type { StorageAdapter } from "../types/storage";
import { ExternalChatReceiptSchema } from "../api/schemas/external-chats";
import { externalChatKeys } from "./external-chats";

export const externalChatReceiptStorageKey = (ws: string, runtime: string, source: string, thread: string) =>
  JSON.stringify(externalChatKeys.lastReceipt(ws, runtime, source, thread));

export function readExternalChatReceipt(storage: StorageAdapter, key: string, thread: string): {
  receipt: ExternalChatReceipt | null; available: boolean;
} {
  try {
    const stored = storage.getItem(key);
    if (stored === null) return { receipt: null, available: true };

    const result = ExternalChatReceiptSchema.safeParse(JSON.parse(stored));
    if (!result.success || result.data.thread_id !== thread) return { receipt: null, available: false };

    return { receipt: result.data, available: true };
  } catch {
    return { receipt: null, available: false };
  }
}

/** Persist only the native acknowledgement pointer, never the message or source configuration. */
export function writeExternalChatReceipt(storage: StorageAdapter, key: string, receipt: ExternalChatReceipt | null): boolean {
  try {
    if (receipt) storage.setItem(key, JSON.stringify(ExternalChatReceiptSchema.parse(receipt)));
    else storage.removeItem(key);

    return true;
  } catch {
    return false;
  }
}
