// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import { ApiError } from "../api";
import { externalChatKeys, externalChatHistoryOptions, externalChatListOptions, externalChatWriteIsUnknown } from "./external-chats";

const read = vi.hoisted(() => vi.fn());
vi.mock("../api", async original => ({ ...await original<typeof import("../api")>(), api: { getExternalChatHistory: read } }));
afterEach(() => vi.useRealTimers());

describe("external chat query isolation and acknowledgement", () => {
  it("separates identical native IDs across workspace, Runtime, source and Project", () => {
    const key = externalChatKeys.history("ws", "rt", "native", "thread");
    expect(key).not.toEqual(externalChatKeys.history("other", "rt", "native", "thread"));
    expect(key).not.toEqual(externalChatKeys.history("ws", "other", "native", "thread"));
    expect(key).not.toEqual(externalChatKeys.history("ws", "rt", "other", "thread"));
    expect(externalChatListOptions("ws", "rt", "source", "project-a", true).queryKey).not.toEqual(externalChatListOptions("ws", "rt", "source", "project-b", true).queryKey);
    expect(externalChatHistoryOptions("ws", "rt", "source", "thread", false).enabled).toBe(false);
    expect(externalChatHistoryOptions("ws", "rt", "source", "thread", true).refetchIntervalInBackground).toBe(false);
  });

  it("never treats a missing or invalid acknowledgement as an explicit rejection", () => {
    expect(externalChatWriteIsUnknown(new TypeError("network failed"))).toBe(true);
    expect(externalChatWriteIsUnknown(new ApiError("proxy timeout", 504, "Timeout"))).toBe(true);
    expect(externalChatWriteIsUnknown(new ApiError("invalid acknowledgement", 502, "Bad Gateway", { error: "invalid" }))).toBe(true);
    expect(externalChatWriteIsUnknown(new ApiError("lost", 504, "Timeout", { error: "lost", code: "TIMEOUT", outcome: "unknown" }))).toBe(true);
    expect(externalChatWriteIsUnknown(new ApiError("busy", 409, "Conflict", { error: "busy", code: "BUSY" }))).toBe(false);
  });

  it("polls native history every 5 seconds idle, 2 seconds active, and stops when the page consumer leaves", async () => {
    vi.useFakeTimers();
    read.mockReset().mockResolvedValue({ chat: { status: "idle" }, turns: [], requests: [], next_cursor: null });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observer = new InfiniteQueryObserver(client, externalChatHistoryOptions("ws", "rt", "source", "thread", true));
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await vi.advanceTimersByTimeAsync(4_999);
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(read).toHaveBeenCalledTimes(2);
      read.mockResolvedValue({ chat: { status: "active" }, turns: [], requests: [], next_cursor: null });
      await client.invalidateQueries({ queryKey: externalChatKeys.history("ws", "rt", "source", "thread") });
      expect(read).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(read).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(read).toHaveBeenCalledTimes(4);
      unsubscribe();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(read).toHaveBeenCalledTimes(4);
    } finally {
      unsubscribe();
      client.clear();
    }
  });
});
