import type { PeerWorkspaceEvent } from "@multiremi/contracts/peer-events.js";
import type { DaemonDownlinks } from "./downlinks.js";
import type { DaemonTaskOffers } from "./task-offers.js";

/** Store and peer events use the same scope, independently of which API owns the socket. */
export function wakeDaemonWorkspaceEvent(event: PeerWorkspaceEvent, options: {
  downlinks: DaemonDownlinks;
  offers: DaemonTaskOffers;
  runtimeWorkspace(runtimeId: string): string | null;
  pendingRuntimeIds?(workspaceId: string): readonly string[];
}): void {
  // These notify browsers; neither changes a daemon's desired input or eligibility.
  // PR 6: the background-task registry's realtime event, like PR 5's
  // `task:subagents`, is the browser's; the change that caused it already woke
  // the runtime it concerns. Queue invalidation only refreshes the browser;
  // releasing a queued row uses the normal message/enqueued-task notifications.
  if (event.type === "daemon:heartbeat" || event.type === "activity:created" || event.type === "chat:background_tasks" || event.type === "chat:queue_updated"
    || event.type === "issue:worktree_changed" || event.type === "project:activity_changed") return;
  const runtime = event.type.startsWith("runtime:") ? event.payload.runtime : undefined;
  const state = event.type.startsWith("agent_plugin:runtime_") ? event.payload.state : undefined;
  const nested = runtime ?? state;
  const object = typeof nested === "object" && nested !== null ? nested as Record<string, unknown> : {};
  const id = event.payload.runtime_id ?? (runtime ? object.id : object.runtime_id);
  const runtimeId = typeof id === "string" && id.length ? id : null;
  const workspace = runtimeId ? options.runtimeWorkspace(runtimeId) : null;
  if (workspace !== null && workspace !== event.workspaceId) return;
  const downlink = (mode: "full" | "pending" = "full") => {
    if (runtimeId) options.downlinks.kick(runtimeId, mode);
    else if (mode === "pending" && options.pendingRuntimeIds) {
      for (const id of options.pendingRuntimeIds(event.workspaceId)) options.downlinks.kick(id, mode);
    } else options.downlinks.kickWorkspace(event.workspaceId, rt => options.runtimeWorkspace(rt) ?? "local", mode);
  };
  const offer = () => runtimeId
    ? options.offers.kick(runtimeId)
    : options.offers.kickWorkspace(event.workspaceId);

  switch (event.type) {
    case "daemon:task_input":
      if (runtimeId && event.payload.runtime_only === true) { downlink("pending"); return; }
      // Human-request settlement is consumed by both the task runtime and its bot host.
      // They can be different machines; retain the workspace scope for this multi-recipient input.
      options.downlinks.kickWorkspace(event.workspaceId, rt => options.runtimeWorkspace(rt) ?? "local", "pending");
      return;
    case "inbox:new":
    case "comment:created":
    case "comment:updated":
    case "comment:deleted":
    case "message:created":
    case "message:updated":
    case "decision:created":
    case "decision:updated":
      downlink("pending");
      return;
    case "issue:updated":
      downlink("pending");
      offer();
      return;
    case "daemon:pending_changed":
    case "daemon:feishu_changed":
      if (event.payload.pending_only === true) { downlink("pending"); return; }
    case "daemon:ssh_mesh_changed":
      // Pending commands, bot delivery and mesh configuration do not create task capacity.
      downlink();
      return;
    case "daemon:models_updated":
    case "daemon:dispatch_conditions_changed":
      if (event.payload.dispatch_only === true) { offer(); return; }
    case "agent_plugin:runtime_state":
    case "agent_plugin:runtime_capability":
      downlink();
      offer();
      return;
    default:
      // Keep workspace-wide business/configuration changes and maintenance recovery reliable.
      // Runtime-bearing events can use their known target; unscoped mutations retain fanout.
      downlink();
      if (/^(agent:|agent_plugin:|runtime:|project:|execution_group:|daemon:|issue:)/.test(event.type)) offer();
  }
}
