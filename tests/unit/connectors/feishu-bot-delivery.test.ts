import { describe, expect, it, spyOn } from "bun:test";
import { FeishuConnector } from "@connectors/feishu/index.js";
import { FeishuChannel } from "@connectors/feishu/channel.js";
import { FeishuStreamingSession } from "@connectors/feishu/streaming.js";
import { createFeishuClient, probeFeishu } from "@connectors/feishu/client.js";
import type { TaskStreamEvent } from "@connectors/base.js";
import { FeishuTaskPresentation } from "@connectors/feishu/task-presentation.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completed, nativeHarness, taskEvent } from "./feishu-native-harness.js";


describe("Bot platform delivery", () => {
  it("persists the created card identity before consuming Task events", async () => {
    const events: string[] = [];
    const channel = new FeishuChannel({ appId: "receipt-test", appSecret: "secret" });
    const stream = {
      start: async () => { events.push("start"); },
      getMessageId: () => "platform-card",
      getElapsed: () => 1,
      close: async () => { events.push("close"); },
      isActive: () => true,
      detach: () => {},
    } as unknown as FeishuStreamingSession;
    const mock = spyOn(channel, "createStream").mockReturnValue(stream);
    try {
      await channel.handleTaskStream("chat", "session", (async function* (): AsyncGenerator<TaskStreamEvent> { events.push("consume"); })(), {
        taskId: "task",
        onReplyCreated: async (id) => { expect(id).toBe("platform-card"); events.push("receipt"); },
        respondHumanRequest: async () => { throw new Error("unexpected"); },
      }, { durable: { idempotencyKey: "delivery", messageId: "platform-card" } });
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
        .rejects.toThrow("Feishu code 400");
      expect(patches[0]).toMatchObject({ path: { message_id: "original-card" } });
      expect(create).not.toHaveBeenCalled();
      expect(reply).not.toHaveBeenCalled();
    } finally { patch.mockRestore(); create.mockRestore(); reply.mockRestore(); }
  });

  it("never uploads a Bot agent's host-local path while preserving platform image keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bot-host-image-"));
    const filePath = join(directory, "private.png");
    await writeFile(filePath, Buffer.from("private host image"));
    const credentials = { appId: "bot-images", appSecret: "secret" };
    const connector = new FeishuConnector(credentials as ConstructorParameters<typeof FeishuConnector>[0]);
    const client = createFeishuClient(credentials);
    const connect = spyOn(FeishuChannel.prototype, "connect").mockResolvedValue();
    const upload = spyOn(client.im.image, "create");
    const reply = spyOn(client.im.message, "reply").mockResolvedValue({ code: 0, data: { message_id: "sent" } });
    try {
      await connector.startTask(async () => {}, { controlPlaneRouting: true });
      await connector.sendProactiveThreadReply({ chatId: "chat", replyToMessageId: "root", idempotencyKey: "delivery", bodyOrigin: "agent",
        body: `![private](${filePath})\n![shared](feishu-image:img_existing)` });
      expect(upload).not.toHaveBeenCalled();
      const card = reply.mock.calls[0]![0]!.data!.content;
      expect(card).not.toContain(filePath);
      expect(card).toContain("img_existing");
    } finally {
      connect.mockRestore(); upload.mockRestore(); reply.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not send an error card when a Bot host stops an active stream", async () => {
    const connector = new FeishuConnector({ appId: "stop-bot", appSecret: "secret" } as ConstructorParameters<typeof FeishuConnector>[0]);
    const connect = spyOn(FeishuChannel.prototype, "connect").mockResolvedValue();
    let incoming!: Parameters<FeishuChannel["on"]>[1];
    const on = spyOn(FeishuChannel.prototype, "on").mockImplementation((_event, handler) => { incoming = handler; return () => {}; });
    const controller = new AbortController();
    const stream = spyOn(FeishuChannel.prototype, "handleTaskStream").mockImplementation(async () => {
      controller.abort(new Error("host stopped"));
      throw controller.signal.reason;
    });
    const reaction = spyOn(FeishuChannel.prototype, "addReaction").mockResolvedValue(undefined as any);
    const send = spyOn(FeishuChannel.prototype, "sendText");
    try {
      await connector.startTask(async (_message, _key, consumer) => {
        await consumer((async function* () {})(), { taskId: "task", signal: controller.signal, finalDelivery: "outbox",
          respondHumanRequest: async () => { throw new Error("unexpected"); } });
      }, { controlPlaneRouting: true });
      await incoming({ messageId: "incoming", chatId: "chat", chatType: "p2p", senderOpenId: "sender", senderUserId: "", senderUnionId: "", senderTenantKey: "", mentionedBot: false, monitored: false, text: "hello", rawContent: "hello", media: [] });
      expect(stream).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
    } finally { connect.mockRestore(); on.mockRestore(); stream.mockRestore(); reaction.mockRestore(); send.mockRestore(); }
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

  it("can bypass a valid bot probe cache when refreshing bot identity", async () => {
    const credentials = { appId: "refresh-test", appSecret: "secret" };
    const client = createFeishuClient(credentials);
    const probe = spyOn(client, "request").mockResolvedValue({ code: 0, bot: { open_id: "bot-current", bot_name: "Bot" } });
    try {
      await probeFeishu(credentials);
      await probeFeishu(credentials);
      expect(probe).toHaveBeenCalledTimes(1);
      await probeFeishu(credentials, { skipCache: true });
      expect(probe).toHaveBeenCalledTimes(2);
    } finally { probe.mockRestore(); }
  });

  it("keeps retry process IDs distinct and reads interactions from the replacement Task", async () => {
    const h = nativeHarness();
    const presentation = new FeishuTaskPresentation(h.client as any, "oc_chat", {
      taskId: "tsk_test", finalDelivery: "outbox",
      getHumanRequest: async () => ({ id: "request", taskId: "tsk_retry", kind: "question", status: "responded",
        payload: {}, response: {}, respondedBy: "user", createdAt: new Date().toISOString(), respondedAt: new Date().toISOString() }),
      respondHumanRequest: async () => { throw new Error("unexpected"); },
    }, { appId: "cli_test", idempotencyKey: "delivery", save: h.save });
    async function* stream(): AsyncGenerator<TaskStreamEvent> {
      yield taskEvent(1, "thinking", { content: "First attempt" });
      yield taskEvent(1, "thinking", { taskId: "tsk_retry", content: "Retry attempt" });
      yield taskEvent(2, "question_request", { taskId: "tsk_retry", input: { request_id: "request" } });
      yield { kind: "snapshot", snapshot: { ...(completed as Extract<TaskStreamEvent, { kind: "snapshot" }>).snapshot, taskId: "tsk_retry" } };
    }
    await presentation.consume(stream());
    const starts = h.events().filter(e => e.event_type === "REASONING_MESSAGE_START").map(e => JSON.parse(e.content).messageId);
    expect(starts).toHaveLength(2);
    expect(new Set(starts).size).toBe(2);
    expect(h.cards()).toHaveLength(0);
  });

  for (const status of ["completed", "failed", "cancelled"] as const) {
    it(`leaves the ${status} final reply to the outbox while completing native CoT`, async () => {
      const h = nativeHarness();
      const presentation = new FeishuTaskPresentation(h.client as any, "oc_chat", {
        taskId: "tsk_test", finalDelivery: "outbox",
        onReplyCreated: async () => { throw new Error("CoT must not become an outbox update target"); },
        respondHumanRequest: async () => { throw new Error("unexpected"); },
      }, { appId: "cli_test", idempotencyKey: "delivery", save: h.save });
      async function* stream(): AsyncGenerator<TaskStreamEvent> {
        yield taskEvent(1, "thinking", { content: "Checking" });
        yield taskEvent(2, "text", { content: "Final answer", meta: { phase: "final" } });
        yield { kind: "snapshot", snapshot: { ...(completed as Extract<TaskStreamEvent, { kind: "snapshot" }>).snapshot, status } };
      }
      await presentation.consume(stream());
      expect(h.cards()).toHaveLength(0);
      expect(h.checkpoint?.cot?.status).toBe("finished");
      expect(h.events().at(-1)?.event_type).toBe(status === "failed" ? "RUN_ERROR" : "RUN_FINISHED");
    });
  }
});
