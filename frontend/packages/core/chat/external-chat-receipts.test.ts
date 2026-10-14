import { describe, expect, it } from "vitest";
import type { ExternalChatReceipt } from "@multiremi/contracts";
import type { StorageAdapter } from "../types/storage";
import { externalChatReceiptStorageKey, readExternalChatReceipt, writeExternalChatReceipt } from "./external-chat-receipts";

const receipt: ExternalChatReceipt = { request_id: "a6896089-358a-4144-9de0-39cb3918308f", thread_id: "thread", turn_id: null, outcome: "unknown" };
function memoryStorage(): StorageAdapter {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
}

describe("external native acknowledgement persistence", () => {
  it("isolates the pointer by workspace, Runtime, source and thread, including ambiguous separators", () => {
    const key = externalChatReceiptStorageKey("ws", "rt", "source", "thread");
    for (const scope of [["other", "rt", "source", "thread"], ["ws", "other", "source", "thread"], ["ws", "rt", "other", "thread"], ["ws", "rt", "source", "other"]]) {
      expect(key).not.toEqual(externalChatReceiptStorageKey(scope[0]!, scope[1]!, scope[2]!, scope[3]!));
    }
    expect(externalChatReceiptStorageKey("ws:rt", "source", "a", "thread"))
      .not.toEqual(externalChatReceiptStorageKey("ws", "rt:source", "a", "thread"));
  });

  it("round-trips unknown and accepted receipts while excluding message and configuration fields, then clears a rejection", () => {
    const storage = memoryStorage();
    const pointer = { ...receipt, text: "private body", api_key: "private configuration" };
    expect(writeExternalChatReceipt(storage, "key", pointer)).toBe(true);
    expect(JSON.parse(storage.getItem("key")!)).toEqual(receipt);
    expect(readExternalChatReceipt(storage, "key", "thread")).toEqual({ receipt, available: true });
    const accepted = { ...receipt, outcome: "accepted" as const, turn_id: "native-turn" };
    expect(writeExternalChatReceipt(storage, "key", accepted)).toBe(true);
    expect(readExternalChatReceipt(storage, "key", "thread")).toEqual({ receipt: accepted, available: true });
    expect(writeExternalChatReceipt(storage, "key", null)).toBe(true);
    expect(readExternalChatReceipt(storage, "key", "thread")).toEqual({ receipt: null, available: true });
  });

  it("does not restore malformed, cross-thread, or non-UUID native acknowledgements", () => {
    const storage = memoryStorage();
    for (const record of ["not json", JSON.stringify({ ...receipt, request_id: "invalid" }), JSON.stringify({ ...receipt, thread_id: "other" })]) {
      storage.setItem("key", record);
      expect(readExternalChatReceipt(storage, "key", "thread")).toEqual({ receipt: null, available: false });
    }
  });

  it("reports storage denial for reads, writes and clears", () => {
    const denied = () => { throw new Error("Storage denied"); };
    const storage = { getItem: denied, setItem: denied, removeItem: denied };
    expect(readExternalChatReceipt(storage, "key", "thread")).toEqual({ receipt: null, available: false });
    expect(writeExternalChatReceipt(storage, "key", receipt)).toBe(false);
    expect(writeExternalChatReceipt(storage, "key", null)).toBe(false);
  });
});
