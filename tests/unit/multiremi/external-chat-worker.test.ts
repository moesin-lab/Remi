import { describe, expect, test } from "bun:test";
import { registerDaemonExternalChats, type NativeExternalChatDriver } from "@multiremi/worker/external-chats.js";
import type { DaemonProtocolClient } from "@multiremi/worker/daemon-protocol-client.js";
import type { DaemonParsedFrame } from "@multiremi/api/daemon-protocol/frames.js";

function fixture(driver: NativeExternalChatDriver) {
  let listener: ((frame: DaemonParsedFrame) => void | Promise<void>) | null = null;
  let creates = 0;
  const sent: unknown[] = [];
  const protocol = {
    onFrame(callback: typeof listener) { listener = callback; return () => { listener = null; }; },
    send(frame: unknown) { sent.push(frame); },
  } as unknown as DaemonProtocolClient;
  const handler = registerDaemonExternalChats(protocol, () => "rt_codex", () => { creates++; return driver; });
  const dispatch = async (rt?: string, operation = "catalog") => {
    await listener?.({ type: "external_chat.request", id: "request", rt,
      payload: { operation } } as unknown as DaemonParsedFrame);
  };
  return { handler, sent, dispatch, creates: () => creates };
}

describe("native external Chat worker routing", () => {
  test("only its registered Codex lane lazily opens native access", async () => {
    let closes = 0;
    const f = fixture({ request: async () => ({ ok: true, data: { sources: [], warnings: [] } }),
      close: async () => { closes++; } });
    await f.dispatch();
    await f.dispatch("rt_claude");
    expect(f.creates()).toBe(0);
    expect(f.sent).toEqual([]);

    await f.dispatch("rt_codex");
    await f.dispatch("rt_codex");
    expect(f.creates()).toBe(1);
    expect(f.sent).toHaveLength(2);
    expect(f.sent[0]).toEqual({ t: "res", re: "request", rt: "rt_codex",
      p: { ok: true, data: { sources: [], warnings: [] } } });
    await f.handler.close();
    await f.dispatch("rt_codex");
    expect(closes).toBe(1);
    expect(f.sent).toHaveLength(2);
  });

  test("unexpected native write errors are uncertain and never expose config or resend", async () => {
    let writes = 0;
    const f = fixture({ request: async () => { writes++; throw new Error("private credential and input"); },
      close: async () => {} });
    await f.dispatch("rt_codex", "send");
    expect(writes).toBe(1);
    expect(f.sent).toEqual([{ t: "res", re: "request", rt: "rt_codex", p: {
      ok: false, code: "external_chat_failed", message: "Native Codex request failed", outcome: "unknown",
    } }]);
    await f.handler.close();
  });

  test("the worker rejects a native page larger than the protocol budget", async () => {
    const f = fixture({ request: async () => ({ ok: true, data: { sources: [],
      warnings: [{ source_id: "source", code: "large", message: "x".repeat(900_000) }] } }),
      close: async () => {} });
    await f.dispatch("rt_codex");
    expect(JSON.stringify(f.sent)).toContain("external_chat_response_too_large");
    expect(JSON.stringify(f.sent).length).toBeLessThan(500);
    await f.handler.close();
  });
});
