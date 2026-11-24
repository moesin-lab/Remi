// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import { ApiError } from "../api";
import { externalChatKeys, externalChatHistoryOptions, externalChatListOptions, externalChatModelsOptions, externalChatWriteIsUnknown } from "./external-chats";

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

  it("shares model catalogs only within one source and disables unsupported or offline source queries", () => {
    const key = externalChatModelsOptions("ws", "rt", "source", true).queryKey;
    expect(key).toEqual(externalChatKeys.models("ws", "rt", "source"));
    expect(key).not.toEqual(externalChatKeys.models("other", "rt", "source"));
    expect(key).not.toEqual(externalChatKeys.models("ws", "other", "source"));
    expect(key).not.toEqual(externalChatKeys.models("ws", "rt", "other"));
    expect(externalChatModelsOptions("ws", "rt", "source", false).enabled).toBe(false);
    expect(externalChatModelsOptions("", "rt", "source", true).enabled).toBe(false);
    expect(externalChatModelsOptions("ws", "rt", "", true).enabled).toBe(false);
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

  it("reuses settled older pages during polling, but refreshes changed cursors and expired history", async () => {
    vi.useFakeTimers();
    let headCursor = "older";
    read.mockReset().mockImplementation((_runtime, _source, _thread, params) => Promise.resolve({
      chat: { status: "idle" }, turns: [{ id: params.cursor ?? "newest", status: "completed", items: [] }],
      requests: [], next_cursor: params.cursor ? null : headCursor,
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observer = new InfiniteQueryObserver(client, externalChatHistoryOptions("ws", "rt", "source", "thread", true));
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await vi.advanceTimersByTimeAsync(0);
      await observer.fetchNextPage();
      read.mockClear();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(read.mock.calls.map(call => call[3].cursor ?? "HEAD")).toEqual(["HEAD"]);
      expect(observer.getCurrentResult().data?.pages[1]?.turns[0]?.id).toBe("older");

      headCursor = "shifted";
      read.mockClear();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(read.mock.calls.map(call => call[3].cursor ?? "HEAD")).toEqual(["HEAD", "shifted"]);
      expect(observer.getCurrentResult().data?.pageParams).toEqual([undefined, "shifted"]);

      read.mockClear();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(read.mock.calls.filter(call => call[3].cursor === "shifted")).toHaveLength(1);

      read.mockClear();
      await client.invalidateQueries({ queryKey: externalChatKeys.history("ws", "rt", "source", "thread") });
      expect(read.mock.calls.map(call => call[3].cursor ?? "HEAD")).toEqual(["HEAD", "shifted"]);
    } finally {
      unsubscribe();
      client.clear();
    }
  });

  it("keeps polling an unsettled older turn and isolates cached pages by native identity", async () => {
    vi.useFakeTimers();
    read.mockReset().mockImplementation((_runtime, _source, _thread, params) => Promise.resolve({
      chat: { status: "active" }, turns: [{ id: params.cursor ?? "newest", status: "inProgress", items: [] }],
      requests: [], next_cursor: params.cursor ? null : "older",
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observer = new InfiniteQueryObserver(client, externalChatHistoryOptions("ws", "rt", "source", "thread", true));
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await vi.advanceTimersByTimeAsync(0);
      await observer.fetchNextPage();
      read.mockClear();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(read.mock.calls.map(call => call[3].cursor ?? "HEAD")).toEqual(["HEAD", "older"]);

      const other = new InfiniteQueryObserver(client, externalChatHistoryOptions("ws", "rt", "other-source", "thread", true));
      const stopOther = other.subscribe(() => undefined);
      try {
        await vi.advanceTimersByTimeAsync(0);
        read.mockClear();
        await other.fetchNextPage();
        expect(read).toHaveBeenCalledWith("rt", "other-source", "thread", expect.objectContaining({ cursor: "older" }));
      } finally { stopOther(); }
    } finally {
      unsubscribe();
      client.clear();
    }
  });
});
