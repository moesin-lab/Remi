import { afterEach, describe, expect, it } from "bun:test";
import { MultiremiDaemonClient } from "@multiremi/worker/client.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("Bot daemon protocol", () => {
  it("scopes messages, controls, file bytes and reply receipts to the exact platform binding", async () => {
    const requests: Array<{ path: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      requests.push({ path, init: init! });
      if (path.endsWith("/attachments")) return Response.json({ attachment_id: "attachment" });
      return Response.json({ chat_session_id: "chat", reset: true, cancelled: true, task_id: "task" });
    }) as unknown as typeof globalThis.fetch;
    const client = new MultiremiDaemonClient("https://remi.example", "daemon-token");
    const scope = ["runtime", "bot", "binding"] as const;
    await client.submitBotMessage(...scope, {
      revision: 2, externalSessionKey: "external", externalMessageId: "incoming", text: "/deploy", chatType: "group", command: "/deploy", attachmentIds: ["attachment"],
    });
    await client.cancelBotSessionTask(...scope, { revision: 2, externalSessionKey: "external", replyToMessageId: "reply", chatSessionId: "chat" });
    await client.uploadBotAttachment(...scope, new File(["file bytes"], "sample.txt", { type: "text/plain" }));
    await client.recordBotReply(...scope, "task", "reply");
    expect(requests.map((request) => request.path)).toEqual([
      "/api/daemon/runtimes/runtime/bots/bot/platforms/binding/messages",
      "/api/daemon/runtimes/runtime/bots/bot/platforms/binding/session/cancel",
      "/api/daemon/runtimes/runtime/bots/bot/platforms/binding/attachments",
      "/api/daemon/runtimes/runtime/bots/bot/platforms/binding/tasks/task/replies",
    ]);
    expect(JSON.parse(requests[0]!.init.body as string)).toMatchObject({ command: "/deploy", attachment_ids: ["attachment"] });
    expect(JSON.parse(requests[1]!.init.body as string)).toMatchObject({ reply_to_message_id: "reply", chat_session_id: "chat" });
    const upload = requests[2]!.init;
    expect(new Headers(upload.headers).get("authorization")).toBe("Bearer daemon-token");
    expect(new Headers(upload.headers).has("content-type")).toBe(false);
    expect(await ((upload.body as FormData).get("file") as File).text()).toBe("file bytes");
  });

  it("accepts a missing Bot route on an older server while surfacing a deleted runtime", async () => {
    const client = new MultiremiDaemonClient("https://remi.example", "token");
    globalThis.fetch = (async () => new Response("404 Not Found", { status: 404 })) as unknown as typeof globalThis.fetch;
    expect(await client.getBotDirectives("runtime")).toEqual([]);
    globalThis.fetch = (async () => Response.json({ error: "runtime not found", code: "runtime_not_found" }, { status: 404 })) as unknown as typeof globalThis.fetch;
    await expect(client.getBotDirectives("runtime")).rejects.toMatchObject({ code: "runtime_not_found" });
  });

  it("keeps assignment credentials separate from directives and exposes retry replacement", async () => {
    const client = new MultiremiDaemonClient("https://remi.example", "token");
    globalThis.fetch = (async () => Response.json({ task_id: "old", status: "failed", replacement_task_id: "retry" })) as unknown as typeof globalThis.fetch;
    expect(await client.getFeishuBotTaskSnapshot("old")).toMatchObject({ taskId: "old", replacementTaskId: "retry" });
  });
});
