"use client";

import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@multiremi/core/api";
import { issueKeys } from "@multiremi/core/issues/queries";
import { agentTaskSnapshotKeys } from "@multiremi/core/agents/queries";
import { useActorName } from "@multiremi/core/workspace/hooks";
import type { AgentTask } from "@multiremi/core/types";
import { Button } from "@multiremi/ui/components/ui/button";
import { TaskTraceDialog } from "../../common/task-transcript/task-trace-dialog";
import { useT } from "../../i18n";

const terminal = new Set(["failed", "cancelled", "completed"]);

/** The selected issue's execution state and recovery, visible above its history. */
export function WorkbenchRunPanel({ issueId, wsId }: { issueId: string; wsId: string }) {
  const { t } = useT("workbench");
  const qc = useQueryClient();
  const { getAgentName } = useActorName({ agentsEnabled: true, squadsEnabled: false });
  const query = useQuery({ queryKey: issueKeys.tasks(issueId), queryFn: () => api.listTasksByIssue(issueId), staleTime: 30_000 });
  const [retrying, setRetrying] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [inspectedTask, setInspectedTask] = useState<AgentTask | null>(null);
  const tasks = [...(query.data ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  const active = tasks.filter((task) => !terminal.has(task.status));
  const task = active[0] ?? tasks[0];

  const retry = async () => {
    if (!task || lock.current) return;
    lock.current = true;
    setRetrying(true);
    setError(null);
    try {
      const next = await api.rerunIssue(issueId, task.id);
      qc.setQueryData<AgentTask[]>(issueKeys.tasks(issueId), (current = []) => [next, ...current.filter((item) => item.id !== next.id)]);
      void qc.invalidateQueries({ queryKey: issueKeys.all(wsId) });
      void qc.invalidateQueries({ queryKey: issueKeys.tasks(issueId) });
      void qc.invalidateQueries({ queryKey: agentTaskSnapshotKeys.all(wsId) });
    } catch (e) {
      const code = e instanceof ApiError && e.body && typeof e.body === "object" && "code" in e.body ? e.body.code : null;
      setError(code === "dependencies_unmet" ? t(($) => $.run.dependencies_unmet)
        : code === "active_run_exists" ? t(($) => $.run.active_run_exists)
        : t(($) => $.run.retry_failed));
      void query.refetch();
    } finally {
      lock.current = false;
      setRetrying(false);
    }
  };

  if (query.isPending) return <div role="status" className="shrink-0 border-b px-4 py-3 text-sm text-muted-foreground">{t(($) => $.run.loading)}</div>;
  if (query.isError) return <div role="alert" className="shrink-0 border-b px-4 py-3 text-sm">
    {t(($) => $.run.load_failed)} <Button size="sm" variant="outline" onClick={() => void query.refetch()}>{t(($) => $.run.refresh)}</Button>
  </div>;
  if (!task) return null;

  let status = t(($) => $.run.unknown);
  switch (task.status) {
    case "queued": case "dispatched": status = t(($) => $.run.queued); break;
    case "waiting_local_directory": status = t(($) => $.run.waiting_directory); break;
    case "running": status = t(($) => $.run.running); break;
    case "awaiting_human": status = t(($) => $.run.awaiting_human); break;
    case "failed": status = t(($) => $.run.failed); break;
    case "cancelled": status = t(($) => $.run.cancelled); break;
    case "completed": status = t(($) => $.run.completed); break;
  }
  const canRetry = active.length === 0 && (task.status === "failed" || task.status === "cancelled");
  return <section aria-label={t(($) => $.run.label)} className="shrink-0 border-b bg-muted/30 px-4 py-3">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0 flex-1" role="status">
        <p className="text-sm font-medium">{status}</p>
        {active.length > 1 && <p className="text-xs text-muted-foreground">{t(($) => $.run.active_count, { count: active.length })}</p>}
        {(task.error || task.progress_summary || task.wait_reason) && <p className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">{task.error || task.progress_summary || task.wait_reason}</p>}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setInspectedTask(task)}>{t(($) => $.run.view)}</Button>
        {canRetry && <Button size="sm" disabled={retrying} onClick={() => void retry()}>{retrying ? t(($) => $.run.retrying) : t(($) => $.run.retry)}</Button>}
      </div>
    </div>
    {canRetry && <p className="mt-2 text-xs text-muted-foreground">{t(($) => $.run.retry_hint)}</p>}
    {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    {inspectedTask && <TaskTraceDialog task={tasks.find((item) => item.id === inspectedTask.id) ?? inspectedTask} agentName={getAgentName(inspectedTask.agent_id)} onOpenChange={(open) => { if (!open) setInspectedTask(null); }} />}
  </section>;
}
