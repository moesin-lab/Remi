import { describe, expect, it } from "vitest";
import { BOT_REFRESH_INTERVAL_MS, botDetailOptions, botKeys, botListOptions, botSendersOptions, botSessionsOptions } from "./queries";

describe("Bot query scope", () => {
  it("isolates all Bot data by workspace and nested resource", () => {
    expect(botKeys.list("ws-1")).not.toEqual(botKeys.list("ws-2"));
    expect(botKeys.detail("ws-1", "bot-1")).not.toEqual(botKeys.detail("ws-2", "bot-1"));
    expect(botKeys.senders("ws-1", "bot-1")).not.toEqual(botKeys.senders("ws-1", "bot-2"));
    expect(botKeys.sessions("ws-1", "bot-1")).not.toEqual(botKeys.sessions("ws-2", "bot-1"));
  });

  it("does not request an unresolved workspace or Bot", () => {
    expect(botListOptions("").enabled).toBe(false);
    expect(botDetailOptions("ws-1", "").enabled).toBe(false);
    expect(botSendersOptions("", "bot-1").enabled).toBe(false);
    expect(botSessionsOptions("ws-1", "bot-1", false).enabled).toBe(false);
  });

  it("refreshes newly discovered accounts and remote edits while the page is visible", () => {
    for (const options of [botListOptions("ws-1"), botDetailOptions("ws-1", "bot-1"), botSendersOptions("ws-1", "bot-1"), botSessionsOptions("ws-1", "bot-1")]) {
      expect(options).toMatchObject({ staleTime: 5_000, refetchInterval: BOT_REFRESH_INTERVAL_MS, refetchIntervalInBackground: false });
    }
  });
});
