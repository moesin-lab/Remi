import { describe, expect, it } from "bun:test";
import { controlPlaneBotHost } from "../../../apps/remi/cli/bot-host.js";
import type { bootFeishuChannel, FeishuChannelHandle } from "../../../apps/remi/cli/agent.js";
import type { TaskStreamingHandler, TaskStreamMeta } from "@connectors/base.js";
import type { MultiremiDaemon } from "@multiremi/worker/daemon.js";
import type { MultiremiFeishuBotAssignment } from "@multiremi/worker/client.js";

const assignment = {
  config: { revision: 2, app_id: "app", app_secret: "secret", domain: "feishu" },
  agent: { id: "agent", name: "Agent" },
} as MultiremiFeishuBotAssignment;

async function setup(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  let options!: Parameters<typeof bootFeishuChannel>[1];
  let failure!: (reason: unknown) => void;
  const start = new Promise<void>((_, reject) => { failure = reject; });
  const handle: FeishuChannelHandle = {
    uploadImage: async () => ({ imageKey: "image" }),
    streamProactiveTask: async () => ({ messageId: "reply" }),
    resolveProactiveMention: async () => null,
    start, stop: async () => { calls.push({ name: "stop", args: [] }); },
    publishBotMenu: async () => ({ dryRun: true, defaultPublished: false, userMenuCount: 0 }),
    sendProactiveThreadReply: async (...args) => { calls.push({ name: "send", args }); return { messageId: "reply" }; },
  };
  const daemon = {
    localPort: () => 1234,
    submitBotMessage: async (...args: unknown[]) => { calls.push({ name: "submit", args }); return { taskId: "task", duplicate: false, steered: false }; },
    uploadBotAttachment: async (...args: unknown[]) => { calls.push({ name: "upload", args }); return "attachment"; },
    getFeishuBotHumanRequest: async (...args: unknown[]) => { calls.push({ name: "request", args }); return null; },
    cancelBotSessionTask: async (...args: unknown[]) => { calls.push({ name: "cancel", args }); return { cancelled: true }; },
    resetBotSession: async (...args: unknown[]) => { calls.push({ name: "reset", args }); return true; },
    inspectBotSession: async (...args: unknown[]) => { calls.push({ name: "inspect", args }); return { chatSessionId: "chat", task: null }; },
    respondFeishuBotHumanRequest: async (...args: unknown[]) => { calls.push({ name: "respond", args }); return {}; },
    reportBotConciergeFailure: async (...args: unknown[]) => { calls.push({ name: "failure", args }); },
    ...overrides,
  } as unknown as MultiremiDaemon;
  const host = controlPlaneBotHost({
    daemon: () => daemon, workspacesRoot: () => "/host/workspaces", botId: "bot", bindingId: "binding",
    boot: async (authorize, input) => { expect(await authorize("unknown-sender")).toBe(true); options = input; return handle; },
  });
  await host.start(assignment);
  const responses: string[] = [];
  const consumer: Parameters<TaskStreamingHandler>[2] = async (stream) => {
    for await (const event of stream) if (event.kind === "message") responses.push(event.message.content ?? "");
  };
  return { host, handler: options.taskHandler, options, calls, consumer, responses, failure };
}

describe("Bot foreground host", () => {
  it("submits attachments and route context through the Bot API and reserves final delivery for the outbox", async () => {
    const test = await setup();
    let meta!: TaskStreamMeta;
    await test.handler({
      chatId: "group", text: "Alice: /deploy payload\n<media:document>",
      media: [{ buffer: Buffer.from("file contents"), fileName: "config.txt", contentType: "text/plain", mediaType: "file" }],
      metadata: { messageId: "incoming", rawContent: "/deploy payload", parentId: "quoted-reply", chatType: "group", senderOpenId: "sender" },
    }, "group", async (_stream, value) => { meta = value; });
    expect(test.options).toMatchObject({ controlPlaneRouting: true, eventScope: "binding" });
    expect(test.calls[0]?.name).toBe("upload");
    expect(await (test.calls[0]!.args[2] as File).text()).toBe("file contents");
    expect(test.calls[1]).toMatchObject({ name: "submit", args: ["bot", "binding", {
      externalMessageId: "incoming", replyToMessageId: "incoming", parentMessageId: "quoted-reply", command: "/deploy", chatType: "group", attachmentIds: ["attachment"],
    }] });
    expect(meta.finalDelivery).toBe("outbox");
    expect(meta.onReplyCreated).toBeUndefined();
    expect(meta.signal?.aborted).toBe(false);
    await test.host.stop();
  });

  it("uses the raw group command and quoted reply to cancel the correct target", async () => {
    const test = await setup();
    await test.handler({ chatId: "group", text: "[Replying to: reply]\nAlice: /cancel", metadata: {
      rawContent: "/cancel", parentId: "original-card",
    } }, "group", test.consumer);
    expect(test.calls[0]).toEqual({ name: "cancel", args: ["bot", "binding", {
      revision: 2, externalSessionKey: "group", replyToMessageId: "original-card", chatSessionId: undefined,
    }] });
    expect(test.responses).toEqual(["Task cancelled."]);
    await test.host.stop();
  });

  it("keeps a retry on the same stream and directs human responses to the replacement Task", async () => {
    const snapshots: string[] = [];
    const test = await setup({
      listFeishuBotTaskMessages: async () => [],
      getFeishuBotTaskSnapshot: async (taskId: string) => {
        snapshots.push(taskId);
        return taskId === "task" ? { taskId, status: "failed", replacementTaskId: "retry-task" } : { taskId, status: "completed", result: "done" };
      },
    });
    const streamed: string[] = [];
    await test.handler({ chatId: "group", text: "do work", metadata: { messageId: "incoming" } }, "group", async (stream, meta) => {
      for await (const event of stream) if (event.kind === "snapshot") streamed.push(event.snapshot.taskId);
      await meta.getHumanRequest!("request");
      await meta.respondHumanRequest("request", { accepted: true });
    });
    expect(snapshots).toEqual(["task", "retry-task"]);
    expect(streamed).toEqual(["retry-task"]);
    expect(test.calls.at(-2)).toEqual({ name: "request", args: ["retry-task", "request"] });
    expect(test.calls.at(-1)).toEqual({ name: "respond", args: ["retry-task", "request", { accepted: true }] });
    await test.host.stop();
  });

  it("explains ambiguous targets without cancelling or submitting to another Agent", async () => {
    const test = await setup({ cancelBotSessionTask: async () => { throw { code: "ambiguous_session" }; } });
    await test.handler({ chatId: "group", text: "/new" }, "group", test.consumer);
    expect(test.responses[0]).toContain("Reply to the relevant bot message");
    expect(test.calls).toEqual([]);
    await test.host.stop();
  });

  it("preserves an explicit Chat target for commands", async () => {
    const test = await setup();
    await test.handler({ chatId: "group", text: "/status chat-other" }, "group", test.consumer);
    expect(test.calls[0]).toMatchObject({ name: "inspect", args: ["bot", "binding", { chatSessionId: "chat-other" }] });
    await test.host.stop();
  });

  it("reports a dead transport by binding identity and ignores callbacks after stop", async () => {
    const test = await setup();
    test.failure(new Error("disconnected"));
    await Promise.resolve();
    expect(test.calls[0]).toMatchObject({ name: "failure", args: ["binding", expect.any(Error)] });
    await test.host.stop();
    await test.handler({ text: "message after stop", chatId: "group" }, "group", test.consumer);
    expect(test.calls.map((call) => call.name)).toEqual(["failure", "stop"]);
  });
});
