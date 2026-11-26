import { queryOptions } from "@tanstack/react-query";
import type { ProjectActivityQuery, ProjectActivityStatus, ProjectActivityView } from "@multiremi/contracts";
import { api } from "../api";

export const activityStatuses = {
  active: ["queued", "dispatched", "running", "waiting_local_directory", "awaiting_human"], history: ["failed", "completed", "cancelled"],
} as const satisfies Record<ProjectActivityView, readonly ProjectActivityStatus[]>;

export function activityFilters(params: URLSearchParams) {
  const value = (name: string) => params.get(name)?.trim() || undefined;
  const date = (name: string) => {
    const raw = value(name);
    if (!raw || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(raw) || !Number.isFinite(Date.parse(raw))) return raw;
    const canonical = new Date(raw).toISOString();
    return canonical.slice(0, 19) === raw.slice(0, 19) ? canonical : raw;
  };
  return { view: value("view") ?? "active", status: value("status"), agent_id: value("agent_id"), q: value("q"),
    from: date("from"), to: date("to"), cursor: value("cursor"), limit: Number(value("limit") ?? 30) };
}

export function projectActivityOptions(workspace: string, project: string, filters: ReturnType<typeof activityFilters>) {
  return queryOptions({
    queryKey: ["project-activity", workspace, project, { ...filters, q: filters.q?.replace(/[A-Z]/g, (letter) => letter.toLowerCase()) }] as const,
    queryFn: ({ signal }) => {
      const { view } = filters;
      if (view !== "active" && view !== "history") throw new Error("Invalid activity view");
      const status = activityStatuses[view].find((candidate) => candidate === filters.status);
      if (filters.status && !status) throw new Error("Invalid activity status");
      return api.listProjectActivity(project, { ...filters, view, status } satisfies ProjectActivityQuery, signal);
    },
    enabled: Boolean(workspace && project), staleTime: 0, refetchOnWindowFocus: true,
    refetchInterval: 30_000, refetchIntervalInBackground: false,
  });
}
