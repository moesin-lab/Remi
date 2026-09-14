import type { MultiremiDaemon } from "@multiremi/worker/daemon.js";
import type { FeishuBotSessionSnapshot } from "@multiremi/contracts/types.js";
import type { TaskStreamEvent } from "@connectors/base.js";
import { sleep } from "./multiremi/daemon-health.js";

export function renderFeishuSessionCommand(command: string, snapshot: FeishuBotSessionSnapshot): string {
  if (!snapshot.chatSessionId) return "No conversation has been started yet.";
  const task = snapshot.task;
  if (command === "/sessions") {
    return [
      `Conversation: ${snapshot.chatSessionId}`,
      task ? `Latest task: ${task.taskId} (${task.status})` : "Latest task: none",
    ].join("\n");
  }
  if (command === "/context") {
    if (!task) return `Conversation: ${snapshot.chatSessionId}\nContext usage: no task usage yet.`;
    const input = task.usage.reduce((sum, entry) => sum + entry.inputTokens, 0);
    const output = task.usage.reduce((sum, entry) => sum + entry.outputTokens, 0);
    const total = task.usage.reduce(
      (sum, entry) => sum + (
        entry.totalTokens && entry.totalTokens > 0
          ? entry.totalTokens
          : entry.inputTokens + entry.outputTokens
      ),
      0,
    );
    return `Context usage: ${total} tokens (${input} input, ${output} output)`;
  }
  return [
    `Conversation: ${snapshot.chatSessionId}`,
    task ? `Task: ${task.taskId}` : "Task: none",
    task ? `Status: ${task.status}` : "Status: idle",
    task?.workDir ? `Working directory: ${task.workDir}` : "Working directory: not created yet",
  ].join("\n");
}

export async function* pollFeishuTask(
  daemon: MultiremiDaemon,
  taskId: string,
  signal?: AbortSignal,
  onTaskReplaced?: (taskId: string) => void,
): AsyncGenerator<TaskStreamEvent> {
  let sinceSeq = 0;
  for (;;) {
    signal?.throwIfAborted();
    const messages = await daemon.listFeishuBotTaskMessages(taskId, sinceSeq);
    for (const message of messages) {
      signal?.throwIfAborted();
      sinceSeq = Math.max(sinceSeq, message.seq);
      yield { kind: "message", message };
    }
    const snapshot = await daemon.getFeishuBotTaskSnapshot(taskId);
    if (onTaskReplaced && snapshot.replacementTaskId && snapshot.replacementTaskId !== taskId) {
      taskId = snapshot.replacementTaskId;
      sinceSeq = 0;
      onTaskReplaced(taskId);
      continue;
    }
    if (snapshot.status === "completed" || snapshot.status === "failed" || snapshot.status === "cancelled") {
      // Completion and Task messages commit together, but they are read over
      // separate HTTP calls. Drain once more so a completion that landed
      // between the first list and this snapshot cannot hide the final tool,
      // thinking, or text events.
      const finalMessages = await daemon.listFeishuBotTaskMessages(taskId, sinceSeq);
      for (const message of finalMessages) {
        sinceSeq = Math.max(sinceSeq, message.seq);
        yield { kind: "message", message };
      }
      yield { kind: "snapshot", snapshot };
      return;
    }
    await sleep(400);
  }
}

export async function* singleMessageStream(text: string): AsyncGenerator<TaskStreamEvent> {
  yield {
    kind: "message",
    message: {
      id: "feishu-command-message",
      taskId: "feishu-command",
      seq: 1,
      type: "text",
      tool: null,
      content: text,
      input: null,
      output: null,
      toolCallId: null,
      status: null,
      meta: null,
      createdAt: new Date().toISOString(),
    },
  };
  yield {
    kind: "snapshot",
    snapshot: {
      taskId: "feishu-command",
      status: "completed",
      result: text,
      error: null,
      sessionId: null,
      workDir: null,
      usage: [],
    },
  };
}
