import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type * as Lark from "@larksuiteoapi/node-sdk";
import { FeishuConnector } from "@connectors/feishu/index.js";
import { FeishuChannel } from "@connectors/feishu/channel.js";
import { FeishuStreamingSession } from "@connectors/feishu/streaming.js";
import { createFeishuClient, probeFeishu } from "@connectors/feishu/client.js";
import type { TaskStreamEvent } from "@connectors/base.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("Bot platform delivery", () => {
  it("persists the created card identity before consuming Task events", async () => {
    const events: string[] = [];
    const channel = new FeishuChannel({ appId: "receipt-test", appSecret: "secret" });
    const stream = {
      start: async () => { events.push("start"); },
      getMessageId: () => "platform-card",
      close: async () => { events.push("close"); },
      isActive: () => true,
    } as unknown as FeishuStreamingSession;
    const mock = spyOn(channel, "createStream").mockReturnValue(stream);
    try {
      await channel.handleTaskStream("chat", "session", (async function* (): AsyncGenerator<TaskStreamEvent> { events.push("consume"); })(), {
        taskId: "task",
        onReplyCreated: async (id) => { expect(id).toBe("platform-card"); events.push("receipt"); },
        respondHumanRequest: async () => { throw new Error("unexpected"); },
      });
      expect(events).toEqual(["start", "receipt", "consume", "close"]);
    } finally { mock.mockRestore(); }
  });

  it("updates the original card and never sends a replacement when the platform rejects the update", async () => {
    const credentials = { appId: "update-test", appSecret: "secret" };
    const connector = new FeishuConnector(credentials as ConstructorParameters<typeof FeishuConnector>[0]);
    const client = createFeishuClient(credentials);
    const patches: unknown[] = [];
    const patch = spyOn(client.im.message, "patch").mockImplementation(async (input) => {
      patches.push(input);
      return { code: 400, msg: "streaming card is still open" };
    });
    const create = spyOn(client.im.message, "create");
    const reply = spyOn(client.im.message, "reply");
    try {
      await expect(connector.sendProactiveThreadReply({ chatId: "oc_chat", body: "completed", idempotencyKey: "delivery", updateMessageId: "original-card" }))
        .rejects.toThrow("streaming card is still open");
      expect(patches[0]).toMatchObject({ path: { message_id: "original-card" } });
      expect(create).not.toHaveBeenCalled();
      expect(reply).not.toHaveBeenCalled();
    } finally { patch.mockRestore(); create.mockRestore(); reply.mockRestore(); }
  });

  it("recreates the SDK client and bot probe when an account rotates its secret", async () => {
    const original = { appId: "rotation-test", appSecret: "first" };
    const rotated = { ...original, appSecret: "second" };
    const first = createFeishuClient(original);
    expect(createFeishuClient(original)).toBe(first);
    const firstProbe = spyOn(first, "request").mockResolvedValue({ code: 0, bot: { open_id: "bot-first", bot_name: "Bot" } });
    try { await probeFeishu(original); } finally { firstProbe.mockRestore(); }
    const second = createFeishuClient(rotated);
    expect(second).not.toBe(first);
    const secondProbe = spyOn(second, "request").mockResolvedValue({ code: 0, bot: { open_id: "bot-second", bot_name: "Bot" } });
    try {
      expect(await probeFeishu(rotated)).toMatchObject({ botOpenId: "bot-second" });
      expect(secondProbe).toHaveBeenCalledTimes(1);
    } finally { secondProbe.mockRestore(); }
  });

  it("requests a new streaming token after secret rotation", async () => {
    const secrets: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("tenant_access_token")) {
        secrets.push(JSON.parse(init?.body as string).app_secret);
        return Response.json({ code: 0, tenant_access_token: `token-${secrets.length}`, expire: 7200 });
      }
      // Stop before a real card is created; the public start path has already
      // exercised authentication, without leaving streaming timers behind.
      return Response.json({ code: 1, msg: "fixture stops card creation" });
    }) as unknown as typeof globalThis.fetch;
    for (const appSecret of ["first", "first", "second"]) {
      const session = new FeishuStreamingSession({} as Lark.Client, { appId: "stream-rotation", appSecret });
      await expect(session.start("oc_chat")).rejects.toThrow("fixture stops card creation");
    }
    expect(secrets).toEqual(["first", "second"]);
  });
});
