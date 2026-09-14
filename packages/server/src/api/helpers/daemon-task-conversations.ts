import type { Context } from "hono";
import type { MultiremiStore } from "@multiremi/store/store.js";
import { currentAccessToken } from "../wire/index.js";
import { denyDaemonTokenTaskRuntimeIdentity } from "./auth-guards.js";

export function isDaemonTaskConversationRequest(c: Context): boolean {
  const path = new URL(c.req.url).pathname;
  return (c.req.method === "GET" && /^\/api\/daemon\/tasks\/[^/]+\/(?:messages|status|human-requests\/[^/]+)$/.test(path))
    || (c.req.method === "POST" && /^\/api\/daemon\/tasks\/[^/]+\/human-requests\/[^/]+\/respond$/.test(path));
}

/** A Bot host observes and answers its own tasks even when another Runtime
 * executes them. Execution mutations retain the normal Runtime owner guard. */
export function denyDaemonTaskConversationAccess(c: Context, store: MultiremiStore, taskId: string): Response | null {
  const denied = denyDaemonTokenTaskRuntimeIdentity(c, store, taskId);
  if (!denied) return null;
  const token = currentAccessToken(c);
  const task = store.getTask(taskId);
  if (token?.type !== "daemon" || !token.daemonId || !task || task.workspaceId !== token.workspaceId) return denied;
  const hostsTask = store.listRuntimes().some((runtime) =>
    runtime.workspaceId === token.workspaceId && runtime.daemonId === token.daemonId
    && store.isBotHostForTask(runtime.id, taskId));
  return hostsTask ? null : denied;
}
