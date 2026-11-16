import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient, ApiError } from "./http";
import { withChatSendTimeout, ChatSendTimeoutError } from "../chat/send";
import { MAINTENANCE_RETRY_LIMIT_MS, retryAfterMs, useContinuityStore } from "../platform-lifecycle/continuity";
const maintenance = () => Response.json({ code: "platform_update_in_progress" }, { status: 503, headers: { "Retry-After": "5" } });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); useContinuityStore.setState({ switching: false, pendingWrites: 0 }); });
describe("maintenance continuity", () => {
  it("keeps sending beyond 20s using the identical body and dedupe key", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn();
    for (let i = 0; i < 6; i++) fetch.mockResolvedValueOnce(maintenance());
    fetch.mockResolvedValueOnce(Response.json({ ok: true })); vi.stubGlobal("fetch", fetch);
    const body = JSON.stringify({ dedupe_key: "same-key", body_md: "hello" });
    const result = withChatSendTimeout(signal => new HttpClient("").fetch("/send", { method: "POST", body, retrySafe: true, signal }));
    const answer = expect(result).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(useContinuityStore.getState()).toMatchObject({ switching: true, pendingWrites: 1 });
    await vi.advanceTimersByTimeAsync(5_000); await answer;
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(fetch.mock.calls.every(([, init]) => init.body === body)).toBe(true);
    expect(useContinuityStore.getState().pendingWrites).toBe(0);
  });
  it.each([502, 503, 504, "network"])("replays safe sends after %s", async status => {
    vi.useFakeTimers(); const fetch = vi.fn();
    if (status === "network") fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    else fetch.mockResolvedValueOnce(new Response("", { status: Number(status) }));
    fetch.mockResolvedValueOnce(Response.json({ ok: true })); vi.stubGlobal("fetch", fetch);
    const answer = expect(new HttpClient("").fetch("/send", { method: "POST", body: "{}", retrySafe: true })).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(2_000); await answer;
  });
  it("recognizes Next proxy connection refusal without retrying application JSON 500s", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }))
      .mockResolvedValueOnce(Response.json({ ok: true })).mockResolvedValueOnce(Response.json({ error: "application failed" }, { status: 500 }));
    vi.stubGlobal("fetch", fetch);
    const client = new HttpClient("");
    const answer = expect(client.fetch("/safe", { method: "POST", retrySafe: true })).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(2_000); await answer;
    await expect(client.fetch("/safe", { method: "POST", retrySafe: true })).rejects.toMatchObject({ status: 500 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("does not replay ordinary writes; abort cancels backoff", async () => {
    vi.useFakeTimers(); const fetch = vi.fn().mockImplementation(maintenance); vi.stubGlobal("fetch", fetch);
    const client = new HttpClient("");
    await expect(client.fetch("/ordinary", { method: "POST" })).rejects.toBeInstanceOf(ApiError);
    expect(fetch).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    const answer = expect(client.fetch("/safe", { method: "POST", retrySafe: true, signal: controller.signal })).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(10); controller.abort(new Error("cancelled")); await answer;
    await vi.advanceTimersByTimeAsync(10_000); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("bounds maintenance waiting and preserves normal active-request timeout", async () => {
    vi.useFakeTimers(); vi.stubGlobal("fetch", vi.fn().mockImplementation(maintenance));
    const answer = expect(withChatSendTimeout(signal => new HttpClient("").fetch("/safe", { method: "POST", retrySafe: true, signal }))).rejects.toBeInstanceOf(ApiError);
    await vi.advanceTimersByTimeAsync(MAINTENANCE_RETRY_LIMIT_MS); await answer;
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const timeout = expect(withChatSendTimeout(signal => new HttpClient("").fetch("/safe", { retrySafe: true, signal }))).rejects.toBeInstanceOf(ChatSendTimeoutError);
    await vi.advanceTimersByTimeAsync(20_000); await timeout;
  });
  it("shares the ten-minute backoff budget between session lookup and message POST", async () => {
    vi.useFakeTimers();
    let phase = 0;
    const fetch = vi.fn().mockImplementation(() => {
      if (phase++ < 118) return Promise.resolve(maintenance());
      if (phase === 119) return Promise.resolve(Response.json({ session: true }));
      return Promise.resolve(maintenance());
    });
    vi.stubGlobal("fetch", fetch);
    const client = new HttpClient("");
    const answer = expect(withChatSendTimeout(async signal => {
      await client.fetch("/session", { retrySafe: true, signal });
      return client.fetch("/send", { method: "POST", retrySafe: true, signal });
    })).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(MAINTENANCE_RETRY_LIMIT_MS);
    await answer;
    expect(fetch.mock.calls.length).toBeLessThan(125);
  });
  it("retries maintenance reads and parses Retry-After dates", async () => {
    vi.useFakeTimers(); vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(maintenance()).mockResolvedValueOnce(Response.json({ ok: true })));
    const answer = expect(new HttpClient("").fetch("/read")).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(5_000); await answer;
    expect(retryAfterMs("Thu, 01 Jan 1970 00:00:05 GMT", 1000)).toBe(4000);
    expect(retryAfterMs("bad")).toBeNull();
  });
});
