/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { setApiInstance } from "../api";
import type { ApiClient } from "../api/client";
import { botFixture, botInputFixture, botSenderFixture } from "./test-fixtures";
import { botKeys } from "./queries";
import { useCreateBot, useDeleteBot, useUpdateBot, useUpdateBotSender } from "./mutations";

describe("Bot mutations", () => {
  let queryClient: QueryClient;
  const createBot = vi.fn();
  const updateBot = vi.fn();
  const deleteBot = vi.fn();
  const updateBotSender = vi.fn();

  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
    createBot.mockResolvedValue(botFixture());
    updateBot.mockResolvedValue(botFixture({ revision: 2 }));
    deleteBot.mockResolvedValue({ deleted: true });
    updateBotSender.mockResolvedValue(botSenderFixture({ allowed: true }));
    setApiInstance({ createBot, updateBot, deleteBot, updateBotSender } as unknown as ApiClient);
  });

  afterEach(() => {
    queryClient.clear();
    vi.resetAllMocks();
  });

  it("fixes the create workspace and caches only the server's redacted configuration", async () => {
    const { result } = renderHook(() => useCreateBot("ws-1"), { wrapper: Wrapper });
    const input = botInputFixture({ workspace_id: "ws-other" });
    input.platform_bindings[0]!.app_secret_op = "set";
    input.platform_bindings[0]!.app_secret = "new-secret";
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await act(async () => { await result.current.mutateAsync(input); });
    expect(createBot).toHaveBeenCalledWith({ ...input, workspace_id: "ws-1" });
    expect(queryClient.getQueryData(botKeys.detail("ws-1", "bot-1"))).toEqual(botFixture());
    expect(JSON.stringify(queryClient.getQueryData(botKeys.detail("ws-1", "bot-1")))).not.toContain("new-secret");
    expect(queryClient.getQueryData(botKeys.detail("ws-other", "bot-1"))).toBeUndefined();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: botKeys.list("ws-1") });
  });

  it("retains the submitting workspace when navigation changes while a save is pending", async () => {
    let resolveSave!: (value: ReturnType<typeof botFixture>) => void;
    updateBot.mockImplementation(() => new Promise((resolve) => { resolveSave = resolve; }));
    const previous = botFixture();
    queryClient.setQueryData(botKeys.detail("ws-1", "bot-1"), previous);
    queryClient.setQueryData(botKeys.detail("ws-2", "bot-1"), botFixture({ workspace_id: "ws-2" }));
    const { result, rerender } = renderHook(({ wsId }) => useUpdateBot(wsId, "bot-1"), {
      wrapper: Wrapper, initialProps: { wsId: "ws-1" },
    });
    let request!: Promise<unknown>;
    await act(async () => {
      request = result.current.mutateAsync(botInputFixture());
      await Promise.resolve();
    });
    rerender({ wsId: "ws-2" });
    await act(async () => {
      resolveSave(botFixture({ revision: 2 }));
      await request;
    });
    expect(updateBot).toHaveBeenCalledWith("bot-1", expect.objectContaining({ workspace_id: "ws-1" }));
    expect(queryClient.getQueryData(botKeys.detail("ws-1", "bot-1"))).toMatchObject({ revision: 2 });
    expect(queryClient.getQueryData(botKeys.detail("ws-2", "bot-1"))).toMatchObject({ workspace_id: "ws-2", revision: 1 });
  });

  it("preserves cached detail on failed save", async () => {
    const previous = botFixture();
    queryClient.setQueryData(botKeys.detail("ws-1", "bot-1"), previous);
    updateBot.mockRejectedValue(new Error("save failed"));
    const { result } = renderHook(() => useUpdateBot("ws-1", "bot-1"), { wrapper: Wrapper });
    await act(async () => { await expect(result.current.mutateAsync(botInputFixture())).rejects.toThrow("save failed"); });
    expect(queryClient.getQueryData(botKeys.detail("ws-1", "bot-1"))).toEqual(previous);
  });

  it("clears only the deleted Bot's data after successful deletion", async () => {
    const detailKey = botKeys.detail("ws-1", "bot-1");
    const sendersKey = botKeys.senders("ws-1", "bot-1");
    const otherKey = botKeys.detail("ws-2", "bot-1");
    queryClient.setQueryData(detailKey, botFixture());
    queryClient.setQueryData(sendersKey, { senders: [botSenderFixture()] });
    queryClient.setQueryData(otherKey, botFixture({ workspace_id: "ws-2" }));
    queryClient.setQueryData(["chat", "chat-1"], { id: "chat-1" });
    const { result } = renderHook(() => useDeleteBot("ws-1"), { wrapper: Wrapper });
    deleteBot.mockRejectedValueOnce(new Error("delete failed"));
    await act(async () => { await expect(result.current.mutateAsync("bot-1")).rejects.toThrow("delete failed"); });
    expect(queryClient.getQueryData(detailKey)).toBeDefined();
    await act(async () => { await result.current.mutateAsync("bot-1"); });
    expect(queryClient.getQueryData(detailKey)).toBeUndefined();
    expect(queryClient.getQueryData(sendersKey)).toBeUndefined();
    expect(queryClient.getQueryData(otherKey)).toBeDefined();
    expect(queryClient.getQueryData(["chat", "chat-1"])).toEqual({ id: "chat-1" });
  });

  it("refreshes the exact Bot sender list after allow/revoke", async () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useUpdateBotSender("ws-1", "bot-1"), { wrapper: Wrapper });
    await act(async () => { await result.current.mutateAsync({ senderId: "sender-1", allowed: true }); });
    expect(updateBotSender).toHaveBeenCalledWith("ws-1", "bot-1", "sender-1", true);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: botKeys.senders("ws-1", "bot-1") });
  });
});
