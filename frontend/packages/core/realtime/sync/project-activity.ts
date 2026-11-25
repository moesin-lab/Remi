import { z } from "zod";
import type { ProjectActivityChangedPayload } from "@multiremi/contracts";
import { getCurrentWsId } from "../../platform/workspace-storage";
import type { SyncRegistrar } from "./types";

const changed = z.object({ workspace_id: z.string(), project_ids: z.array(z.string()) }) satisfies z.ZodType<ProjectActivityChangedPayload>;

export const createProjectActivityHandlers: SyncRegistrar = ({ qc }) => {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const waiting = new Set<string>();
  let disposed = false;

  function schedule(workspace: string, project: string) {
    const key = ["project-activity", workspace, project];
    const queries = qc.getQueryCache().findAll({ queryKey: key, type: "active" });
    for (const query of queries) {
      const id = query.queryHash;
      if (timers.has(id) || waiting.has(id)) continue;
      const visible = () => !disposed && getCurrentWsId() === workspace && query.isActive()
        && (typeof document === "undefined" || document.visibilityState !== "hidden");
      const refresh = () => {
        if (visible()) void qc.refetchQueries({ queryKey: query.queryKey, exact: true }, { cancelRefetch: false });
      };
      timers.set(id, setTimeout(async () => {
        timers.delete(id);
        if (!visible()) return;
        const inflight = query.state.fetchStatus === "fetching" ? query.promise : undefined;
        if (inflight) {
          waiting.add(id);
          await inflight.catch(() => undefined);
          waiting.delete(id);
        }
        refresh();
      }, 250));
    }
  }

  return {
    handlers: {
      "project:activity_changed": (raw) => {
        const event = changed.safeParse(raw);
        if (!event.success || event.data.workspace_id !== getCurrentWsId()) return;
        for (const project of new Set(event.data.project_ids)) schedule(event.data.workspace_id, project);
      },
    },
    dispose() {
      disposed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      waiting.clear();
    },
  };
};
