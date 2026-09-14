import type { TaskStreamingHandler } from "@connectors/base.js";
import type { MultiremiDaemon } from "@multiremi/worker/daemon.js";
import type { BotOutboundDelivery } from "@multiremi/contracts/bots.js";
import { FeishuConciergeError, type FeishuConciergeHost } from "@multiremi/worker/feishu-concierge.js";
import { bootFeishuChannel, type FeishuChannelHandle } from "./agent.js";
import { pollFeishuTask, renderFeishuSessionCommand, singleMessageStream } from "./control-plane-task-stream.js";

/** One account transport. Agent choice, working directory and task execution are server-owned. */
export function controlPlaneBotHost(deps: {
  daemon: () => MultiremiDaemon | undefined;
  workspacesRoot: () => string | undefined;
  botId: string;
  bindingId: string;
  boot?: typeof bootFeishuChannel;
}): FeishuConciergeHost {
  let current: FeishuChannelHandle | null = null;
  let abort: AbortController | null = null;
  return {
    async start({ config, agent, botName }) {
      const daemon = deps.daemon();
      const workspacesRoot = deps.workspacesRoot();
      if (!daemon || !workspacesRoot) throw new FeishuConciergeError("the Bot control-plane bridge is unavailable", "runtime_unavailable");
      abort = new AbortController();
      const handle = await (deps.boot ?? bootFeishuChannel)(async () => true, {
        daemonPort: daemon.localPort(),
        workspacesRoot,
        credentials: { appId: config.app_id, appSecret: config.app_secret, domain: config.domain },
        controlPlaneRouting: true,
        eventScope: deps.bindingId,
        taskHandler: createBotTaskHandler(daemon, deps.botId, deps.bindingId, config.revision, botName ?? agent.name, abort.signal),
      });
      current = handle;
      void handle.start.catch((error: unknown) => {
        if (current !== handle) return;
        abort?.abort();
        void daemon.reportBotConciergeFailure(deps.bindingId, error);
      });
      return { botName: botName ?? agent.name };
    },
    async stop() {
      const handle = current;
      current = null;
      abort?.abort();
      abort = null;
      if (handle) await handle.stop();
    },
    async sendOutbound(delivery) {
      if (!current) throw new Error("Bot platform connection is not running");
      return current.sendProactiveThreadReply({
        chatId: delivery.chatId,
        replyToMessageId: delivery.replyToMessageId ?? undefined,
        body: delivery.body,
        bodyOrigin: delivery.bodyOrigin,
        idempotencyKey: delivery.idempotencyKey,
        updateMessageId: (delivery as BotOutboundDelivery).updateMessageId ?? undefined,
      });
    },
  };
}

function createBotTaskHandler(
  daemon: MultiremiDaemon,
  botId: string,
  bindingId: string,
  revision: number,
  displayName: string,
  signal: AbortSignal,
): TaskStreamingHandler {
  return async (message, sessionKey, consumer) => {
    if (signal.aborted) return;
    const [first = "", explicitChat] = String(message.metadata?.rawContent ?? message.text).trim().split(/\s+/);
    const command = first.toLowerCase();
    const replyToMessageId = String(message.metadata?.parentId ?? "").trim() || undefined;
    const control = { revision, externalSessionKey: sessionKey, replyToMessageId, chatSessionId: explicitChat };
    const respond = (text: string) => consumer(singleMessageStream(text), {
      taskId: `bot-command-${command.slice(1)}`,
      displayName,
      respondHumanRequest: async () => { throw new Error("command has no human request"); },
    });
    try {
      if (command === "/new") {
        await daemon.cancelBotSessionTask(botId, bindingId, control);
        const reset = await daemon.resetBotSession(botId, bindingId, control);
        await respond(reset ? "New conversation started." : "Conversation is already new.");
        return;
      }
      if (command === "/esc" || command === "/cancel") {
        const result = await daemon.cancelBotSessionTask(botId, bindingId, control);
        await respond(result.cancelled ? "Task cancelled." : "No running task.");
        return;
      }
      if (command === "/status" || command === "/sessions" || command === "/context") {
        await respond(renderFeishuSessionCommand(command, await daemon.inspectBotSession(botId, bindingId, control)));
        return;
      }
    } catch (error) {
      if ((error as { code?: unknown })?.code !== "ambiguous_session") throw error;
      await respond("This conversation has several Agent targets. Reply to the relevant bot message, or append its Chat ID to the command.");
      return;
    }
    const externalMessageId = String(message.metadata?.messageId ?? "").trim();
    if (!externalMessageId) throw new Error("Bot platform message id is missing");
    const attachmentIds: string[] = [];
    for (const attachment of message.media ?? []) {
      attachmentIds.push(await daemon.uploadBotAttachment(botId, bindingId, new File(
        [new Uint8Array(attachment.buffer)], attachment.fileName ?? "attachment.bin",
        { type: attachment.contentType ?? "application/octet-stream" },
      )));
    }
    if (signal.aborted) return;
    const submitted = await daemon.submitBotMessage(botId, bindingId, {
      revision,
      externalSessionKey: sessionKey,
      externalMessageId,
      replyToMessageId: externalMessageId,
      parentMessageId: replyToMessageId,
      senderOpenId: String(message.metadata?.senderOpenId ?? "").trim() || null,
      senderUserId: String(message.metadata?.senderUserId ?? "").trim() || null,
      senderUnionId: String(message.metadata?.senderUnionId ?? "").trim() || null,
      senderTenantKey: String(message.metadata?.senderTenantKey ?? "").trim() || null,
      senderName: String(message.metadata?.senderName ?? "").trim() || null,
      chatId: message.chatId,
      chatType: message.metadata?.chatType === "p2p" ? "p2p" : "group",
      threadId: String(message.metadata?.rootId ?? "").trim() || null,
      command: command.startsWith("/") ? command : null,
      text: message.text,
      attachmentIds,
    });
    if (submitted.duplicate || submitted.steered) return;
    let currentTaskId = submitted.taskId;
    await consumer(pollFeishuTask(daemon, submitted.taskId, signal, (taskId) => { currentTaskId = taskId; }), {
      taskId: submitted.taskId,
      displayName,
      signal,
      finalDelivery: "outbox",
      getHumanRequest: (requestId) => daemon.getFeishuBotHumanRequest(currentTaskId, requestId),
      respondHumanRequest: (requestId, response) => daemon.respondFeishuBotHumanRequest(currentTaskId, requestId, response),
    });
  };
}
