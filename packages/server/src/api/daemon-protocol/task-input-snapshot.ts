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
  const liveIds = new Set<string>();
  for (const id of ids) {
    const task = store.getTaskIdentity(id);
    if (!task || task.runtimeId !== runtimeId) { forget(id); continue; }
    if (["completed", "failed", "cancelled"].includes(task.status)) {
      entities.push({ key: `cancel:${id}:${task.status}`, type: "task.cancelled",
        payload: { task_id: id, status: task.status }, claimed: () => forget(id), discard: () => forget(id) });
      continue;
    }
    liveIds.add(id);
  }
  // Terminal attempts already have their cancellation downlink. They cannot
  // contribute unread input, and must not be authorized again as live turns.
  if (host && liveIds.size) {
    const snapshot = turns.snapshot({ runtimeId, daemonId, workspaceId: host.workspaceId ?? "local" }, liveIds);
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
