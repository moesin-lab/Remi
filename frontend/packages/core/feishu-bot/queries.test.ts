import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import { feishuBotKeys, feishuBotSendersOptions } from "./queries";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Feishu bot sender queries", () => {
  it("keeps two bots in the same workspace in separate cache entries", async () => {
    const listFeishuBotSenders = vi.fn(async (_workspaceId: string, botId: string) => ({ senders: [{ id: botId }] }));
    setApiInstance({ listFeishuBotSenders } as unknown as ApiClient);
    const client = new QueryClient();
    try {
      await client.fetchQuery(feishuBotSendersOptions("ws-a", true, "bot-one"));
      await client.fetchQuery(feishuBotSendersOptions("ws-a", true, "bot-two"));
      expect(client.getQueryData(feishuBotKeys.senders("ws-a", "bot-one"))).toEqual({ senders: [{ id: "bot-one" }] });
      expect(client.getQueryData(feishuBotKeys.senders("ws-a", "bot-two"))).toEqual({ senders: [{ id: "bot-two" }] });
      expect(listFeishuBotSenders).toHaveBeenCalledTimes(2);
    } finally { client.clear(); }
  });
  it("keeps sender data isolated by workspace", async () => {
    const listFeishuBotSenders = vi.fn()
      .mockResolvedValueOnce({ senders: [{ id: "sender-a" }] })
      .mockResolvedValueOnce({ senders: [{ id: "sender-b" }] });
    setApiInstance({ listFeishuBotSenders } as unknown as ApiClient);
    const queryClient = new QueryClient();
    try {
      await queryClient.fetchQuery(feishuBotSendersOptions("ws-a"));
      await queryClient.fetchQuery(feishuBotSendersOptions("ws-b"));

      expect(feishuBotKeys.senders("ws-a")).toEqual(["feishu-bot", "ws-a", "senders"]);
      expect(listFeishuBotSenders.mock.calls).toEqual([["ws-a", "default"], ["ws-b", "default"]]);
      expect(queryClient.getQueryData(feishuBotKeys.senders("ws-a")))
        .toEqual({ senders: [{ id: "sender-a" }] });
      expect(queryClient.getQueryData(feishuBotKeys.senders("ws-b")))
        .toEqual({ senders: [{ id: "sender-b" }] });
    } finally {
      queryClient.clear();
    }
  });

  it("polls for incoming senders only when the workspace query is enabled", () => {
    expect(feishuBotSendersOptions("ws-a")).toMatchObject({
      queryKey: feishuBotKeys.senders("ws-a"),
      enabled: true,
      retry: false,
      refetchInterval: 10_000,
      staleTime: 5_000,
    });
    expect(feishuBotSendersOptions("ws-a", false)).toMatchObject({
      enabled: false,
      refetchInterval: false,
    });
    expect(feishuBotSendersOptions("")).toMatchObject({
      enabled: false,
      refetchInterval: false,
    });
  });
});
