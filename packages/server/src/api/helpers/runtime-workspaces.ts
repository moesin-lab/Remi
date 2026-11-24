import type { Context } from "hono";
import type { MultiremiStore } from "@multiremi/store/store.js";
import type { MultiremiRuntime, MultiremiRuntimeWorkspace } from "@multiremi/contracts/types.js";
import { RuntimeWorkspaceError } from "@multiremi/store/repos/runtime-workspaces-repo.js";
import { currentRequestUserId, currentTaskAccessToken, isHumanOperatorRequest } from "../wire/index.js";

interface RuntimeWorkspaceReadFacts {
  runtimes: MultiremiRuntime[];
  workspaceExists: boolean;
  taskWorkspaceId: string | null | undefined;
}

/** Facts live only for this response; subsequent requests re-read liveness and access. */
export function runtimeWorkspaceListResponse(c: Context, store: MultiremiStore, workspaceId: string, items: MultiremiRuntimeWorkspace[]) {
  if (!items.length) return [];
  const token = currentTaskAccessToken(c);
  const facts: RuntimeWorkspaceReadFacts = {
    runtimes: store.listRuntimesLiteForWorkspace(workspaceId),
    workspaceExists: isHumanOperatorRequest(c) ? store.getWorkspace(workspaceId) !== null : false,
    taskWorkspaceId: token ? store.getTask(token.taskId ?? "")?.runtimeWorkspaceId : undefined,
  };
  return items.filter(item => item.workspaceId === workspaceId && canUseRuntimeWorkspace(c, store, item, facts))
    .map(item => runtimeWorkspaceResponse(store, item, facts.runtimes));
}

export function canUseRuntimeWorkspace(c: Context, store: MultiremiStore, item: MultiremiRuntimeWorkspace, facts?: RuntimeWorkspaceReadFacts): boolean {
  const token = currentTaskAccessToken(c);
  if (token) return (facts ? facts.taskWorkspaceId : store.getTask(token.taskId ?? "")?.runtimeWorkspaceId) === item.id;
  if (isHumanOperatorRequest(c)) return facts ? facts.workspaceExists : store.getWorkspace(item.workspaceId) !== null;
  return item.ownerId === currentRequestUserId(c) || (facts?.runtimes ?? store.listRuntimesLiteForWorkspace(item.workspaceId)).some(r =>
    r.workspaceId === item.workspaceId && r.daemonId === item.daemonId && r.visibility === "public");
}

export function assertRuntimeWorkspaceAccess(c: Context, store: MultiremiStore, id: unknown, workspaceId: string): void {
  if (id == null) return;
  if (typeof id !== "string" || !id.trim()) throw new RuntimeWorkspaceError("runtime_workspace_id must be a non-empty string or null");
  const item = store.runtimeWorkspaces.require(id, workspaceId);
  if (!canUseRuntimeWorkspace(c, store, item)) throw new RuntimeWorkspaceError("Runtime workspace access denied", 403);
}

export function runtimeWorkspaceResponse(store: MultiremiStore, item: MultiremiRuntimeWorkspace, runtimeFacts?: MultiremiRuntime[]) {
  const runtimes = (runtimeFacts ?? store.listRuntimesLiteForWorkspace(item.workspaceId)).filter(r => r.workspaceId === item.workspaceId && r.daemonId === item.daemonId);
  return {
    id: item.id, workspace_id: item.workspaceId, daemon_id: item.daemonId, owner_id: item.ownerId,
    name: item.name, root_path: item.rootPath, cwd: item.cwd, context_paths: item.contextPaths,
    env_file: item.envFile, project_id: item.projectId, archived_at: item.archivedAt,
    status: item.archivedAt ? "archived" : runtimes.some(r => r.status === "online" && r.metadata.runtime_workspaces === 1) ? "available" : "unavailable",
    runtime_ids: runtimes.map(r => r.id), created_at: item.createdAt, updated_at: item.updatedAt,
  };
}
