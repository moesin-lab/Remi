import type { MultiremiStore } from "@multiremi/store/store.js";
import type { DaemonDownlinkEntity } from "./downlinks.js";
import type { DaemonTurnBridge } from "./turn-bridge.js";
import type { DaemonProtocolSession } from "./session.js";

export function taskInputSnapshot(store: MultiremiStore, runtimeId: string, daemonId: string, activeTaskIds: ReadonlySet<string>,
  forget: (taskId: string) => void, turns: DaemonTurnBridge = store.getDaemonTurnBridge()): DaemonDownlinkEntity[] {
  const ids = new Set(activeTaskIds);
  for (const task of store.listTaskRefs({ runtimeId,
    statuses: ["dispatched", "running", "waiting_local_directory", "awaiting_human"] })) ids.add(task.id);
  const host = store.getRuntimeLite(runtimeId);
  const entities: DaemonDownlinkEntity[] = [];
  const tasks = new Map(store.getTaskIdentities([...ids]).map(task => [task.id, task]));
  const running = new Set<string>();
  const restarts = store.plannedRestarts().pendingForRuntime(runtimeId);
  for (const id of ids) {
    const task = tasks.get(id);
    if (!task || task.runtimeId !== runtimeId) { forget(id); continue; }
    if (["completed", "failed", "cancelled"].includes(task.status)) {
      entities.push({ key: `cancel:${id}:${task.status}`, type: "task.cancelled",
        payload: { task_id: id, status: task.status }, claimed: () => forget(id), discard: () => forget(id) });
      continue;
    }
    const restart = restarts.get(id);
    if (restart?.state === "requested") entities.push({
      key: `turn.restart:${restart.handoff_id}`, type: "turn.restart",
      payload: { turn_id: restart.turn_id, attempt_id: id, handoff_id: restart.handoff_id, generation: restart.generation },
    });
    if (restart?.state === "suspended" || restart?.state === "resuming") continue;
    running.add(id);
  }
  if (host) {
    const snapshot = turns.snapshot({ runtimeId, daemonId, workspaceId: host.workspaceId ?? "local" }, running);
    const messageIds=snapshot.messages.map(input=>input.message.id);
    const attachments = store.listAttachmentsForComments(messageIds);
    const chatAttachments=store.listAttachmentsForChatMessages(messageIds);
    for (const input of snapshot.messages) entities.push({
      key: `turn.message:${input.attempt_id}:${input.message.id}`, type: "turn.message",
      payload: { ...input, attachments: [...(attachments.get(input.message.id) ?? []),...(chatAttachments.get(input.message.id) ?? [])] },
    });
    for (const control of snapshot.wrapUps) entities.push({
      key: `turn.wrap_up:${control.attempt_id}:${control.requested_at}`, type: "turn.wrap_up", payload: { ...control },
    });
  }
  return entities;
}

/**
 * PR 6 §5.3, §6.1: the background-task downlinks, derived from the registry
 * on every run and only for a socket that negotiated `lane.background`. A
 * stop is keyed by lane, task and request time (a new request is a new key);
 * a release by lane, provider session and reason. Both are resent at `hello`,
 * when the delivered set starts empty.
 */
export function backgroundTaskSnapshot(store: MultiremiStore, runtimeId: string,
  session: Pick<DaemonProtocolSession, "supportsLaneBackground">): DaemonDownlinkEntity[] {
  if (!session.supportsLaneBackground) return [];
  const { stops, releases } = store.backgroundTaskDownlinks(runtimeId);
  return [
    ...releases.map((payload): DaemonDownlinkEntity => ({
      key: `lane.background_release:${JSON.stringify([payload.session_id, payload.agent_id, payload.execution_scope,
        payload.provider_session_id, payload.reason])}`,
      type: "lane.background_release", payload: { ...payload },
    })),
    ...stops.map((payload): DaemonDownlinkEntity => ({
      key: `lane.background_stop:${JSON.stringify([payload.session_id, payload.agent_id, payload.execution_scope,
        payload.task_id, payload.requested_at])}`,
      type: "lane.background_stop", payload: { ...payload },
    })),
  ];
}
