import type { MultiremiTaskStatus, RepositoryActivityQuery, RepositoryActivityView } from "@multiremi/contracts";

export const activityStatuses = {
  active: ["queued", "dispatched", "running", "waiting_local_directory", "awaiting_human"],
  history: ["completed", "failed", "cancelled"],
} as const satisfies Record<RepositoryActivityView, readonly MultiremiTaskStatus[]>;

export function activityFilters(params: URLSearchParams) {
  const view = params.get("view") === "history" ? "history" : "active";
  const status = activityStatuses[view].find((value) => value === params.get("status"));
  return {
    view, status, agent_id: params.get("agent_id")?.trim() || undefined,
    q: params.get("q")?.trim() || undefined, cursor: params.get("cursor") || undefined,
  } as const satisfies RepositoryActivityQuery;
}

export type ActivityFilters = ReturnType<typeof activityFilters>;
