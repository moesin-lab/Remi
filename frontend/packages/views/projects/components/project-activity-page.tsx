"use client";

import { memo, useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { activityFilters, activityStatuses, projectActivityOptions, projectDetailOptions, type ActivityPage } from "@multiremi/core/projects";
import { agentListOptions } from "@multiremi/core/workspace/queries";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { AppLink, useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { TranscriptButton } from "../../common/task-transcript";
import { ProjectContentTabs } from "./wiki/project-content-tabs";
import { ProjectActivityRelations } from "./project-activity-relations";

type Attempt = ActivityPage["items"][number];
const statuses = [...activityStatuses.active, ...activityStatuses.history];
const link = "text-primary hover:underline";
const field = "grid gap-1 text-xs text-muted-foreground";
const select = "rounded-md border bg-background px-2 py-1.5 text-sm text-foreground";

function useActivityClock(active: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    function sync() {
      clearInterval(timer);
      if (!document.hidden) {
        setNow(Date.now());
        timer = setInterval(() => setNow(Date.now()), 30_000);
      }
    }
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", sync); };
  }, [active]);
  return now;
}

function span(start: string | null, end: number, locale: string) {
  const seconds = start ? Math.floor((end - Date.parse(start)) / 1000) : NaN;
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const unit = seconds < 60 ? "second" : seconds < 3600 ? "minute" : "hour";
  const divisor = unit === "second" ? 1 : unit === "minute" ? 60 : 3600;
  return new Intl.NumberFormat(locale, { style: "unit", unit, maximumFractionDigits: unit === "hour" ? 1 : 0 }).format(seconds / divisor);
}

const AttemptRow = memo(function AttemptRow({ row, workspace, now }: { row: Attempt; workspace: string; now: number }) {
  const { t, i18n } = useT("projects");
  const { t: agents } = useT("agents");
  const paths = useWorkspacePaths();
  const [expanded, setExpanded] = useState(false);
  const status = statuses.find((value) => value === row.status);
  const active = activityStatuses.active.some((value) => value === status);
  let end = row.ended_at ? Date.parse(row.ended_at) : NaN;
  if (active && row.ended_at === null) {
    const start = Date.parse(row.started_at ?? row.created_at ?? "");
    end = start > now ? Date.now() : now;
  }
  const queued = ["queued", "dispatched", "waiting_local_directory"].includes(row.status);
  const queueEnd = row.started_at ? Date.parse(row.started_at) : queued ? end : NaN;
  const updated = Date.parse(row.updated_at ?? "");
  const summary = row.public_summary;
  return <li className="space-y-2 border-b py-3 text-sm">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <strong className={status === "failed" ? "text-destructive" : undefined}>{status ? agents(($) => $.transcript[`status_${status}`]) : t(($) => $.activity.unknown)}</strong>
      <AppLink href={paths.issueDetail(row.issue.id)} className={link}>{row.issue.key} · {row.issue.title}</AppLink>
      {row.issue_session && <AppLink href={paths.issueSession(row.issue.id, row.issue_session.id)} className={link}>
        {t(($) => $.activity.session)} · {row.issue_session.title || row.issue_session.id}
      </AppLink>}
      <span>{row.agent.name || row.agent.id}</span>
      <TranscriptButton task={{ id: row.attempt_id, turn_id: row.turn_id, status: row.status, agent_id: row.agent.id,
        started_at: row.started_at, completed_at: row.ended_at, created_at: row.created_at ?? undefined }}
        agentName={row.agent.name || row.agent.id} title={t(($) => $.activity.trace)} />
    </div>
    {summary && <p>{summary.code === "step_progress" ? t(($) => $.activity.summary.step_progress, { step: summary.step, total: summary.total }) : t(($) => $.activity.summary[summary.code])}</p>}
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span>{t(($) => $.activity.attempt, { number: row.attempt_no })} · {row.attempt_id}</span>
      <span>Turn · {row.turn_id}</span>
      <span>{t(($) => $.activity.queueTime)} · {span(row.created_at, queueEnd, i18n.language)}</span>
      <span>{t(($) => $.activity.runTime)} · {span(row.started_at, end, i18n.language)}</span>
      <span>{t(($) => $.activity.updated)} · {Number.isFinite(updated) ? new Date(updated).toLocaleString(i18n.language) : "—"}</span>
    </div>
    <button type="button" aria-expanded={expanded} className="text-xs text-primary hover:underline" onClick={() => setExpanded(!expanded)}>
      {t(($) => $.activity.relations)}
    </button>
    {expanded && <ProjectActivityRelations issueId={row.issue.id} workspaceId={workspace} />}
  </li>;
});

function ActivityPanel({ projectId, workspace }: { projectId: string; workspace: string }) {
  const { t } = useT("projects");
  const { t: agentText } = useT("agents");
  const paths = useWorkspacePaths();
  const navigation = useNavigation();
  const filters = activityFilters(navigation.searchParams);
  const history = filters.view === "history";
  const query = useQuery(projectActivityOptions(workspace, projectId, filters));
  const agents = useQuery(agentListOptions(workspace, { enabled: Boolean(workspace) }));
  const previous = useRef(new Map<string, string>());
  const now = useActivityClock(!history);
  const cursor = filters.cursor;
  const next = query.data?.next_cursor;

  function navigate(changes: Record<string, string>) {
    const params = new URLSearchParams(navigation.searchParams);
    for (const [name, value] of Object.entries(changes)) {
      if (value) params.set(name, value); else params.delete(name);
    }
    navigation.push(`${paths.projectActivity(projectId)}?${params}`);
  }
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const text = (name: string) => String(values.get(name) ?? "").trim();
    const utc = (name: string) => text(name) ? new Date(`${text(name)}Z`).toISOString() : "";
    navigate({ status: text("status"), agent_id: text("agent_id"), q: text("q"), from: utc("from"), to: utc("to"), cursor: "" });
  }

  return <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
    <div className="my-3 flex gap-1">
      {(["active", "failed", "history"] as const).map((mode) => {
        const selected = mode === (history ? filters.status === "failed" ? "failed" : "history" : "active");
        return <Button key={mode} aria-pressed={selected} variant={selected ? "secondary" : "ghost"}
          onClick={() => navigate({ view: mode === "active" ? "active" : "history", status: mode === "failed" ? "failed" : "", cursor: "" })}>
          {t(($) => $.activity[mode])}
        </Button>;
      })}
    </div>
    <p className="text-xs text-muted-foreground">{t(($) => $.activity.current)}</p>
    <form key={JSON.stringify(filters)} onSubmit={apply} className="flex flex-wrap items-end gap-3 border-b py-3">
      <label className={field}>{t(($) => $.activity.status)}
        <select className={select} name="status" defaultValue={filters.status || ""}>
          <option value="">{t(($) => $.activity.all)}</option>
          {activityStatuses[history ? "history" : "active"].map((value) => <option key={value} value={value}>{agentText(($) => $.transcript[`status_${value}`])}</option>)}
        </select>
      </label>
      <label className={field}>{t(($) => $.activity.agent)}
        <select className={select} name="agent_id" defaultValue={filters.agent_id || ""}>
          <option value="">{t(($) => $.activity.all)}</option>
          {filters.agent_id && !agents.data?.some((agent) => agent.id === filters.agent_id) && <option value={filters.agent_id}>{filters.agent_id}</option>}
          {agents.data?.map((agent) => <option key={agent.id} value={agent.id}>{agent.name || agent.id}</option>)}
        </select>
      </label>
      <label className={field}>{t(($) => $.activity.issue)}<Input name="q" defaultValue={filters.q} /></label>
      {(["from", "to"] as const).map((name) => <label key={name} className={field}>{t(($) => $.activity[name])}
        <Input name={name} type="datetime-local" step="any" defaultValue={filters[name]?.replace(/Z$/, "")} />
      </label>)}
      <Button variant="outline" type="submit">{t(($) => $.activity.apply)}</Button>
    </form>
    {query.isPending && <p role="status">{t(($) => $.activity.loading)}</p>}
    {query.isError && <div role="alert">{t(($) => $.activity.loadError)}
      <Button variant="ghost" onClick={() => void query.refetch()}>{t(($) => $.activity.retry)}</Button>
      <AppLink className={link} href={paths.projectActivity(projectId)}>{t(($) => $.activity.reset)}</AppLink>
    </div>}
    {query.data?.items.length === 0 && <p className="py-4 text-muted-foreground">{t(($) => $.activity.empty)}</p>}
    <ul>{query.data?.items.map((row) => <AttemptRow key={row.attempt_id} row={row} workspace={workspace} now={history ? 0 : now} />)}</ul>
    <div className="mt-3 flex gap-2">
      {cursor && <Button variant="outline" onClick={() => navigate({ cursor: previous.current.get(cursor) ?? "" })}>
        {previous.current.has(cursor) ? t(($) => $.activity.previous) : t(($) => $.activity.first)}
      </Button>}
      {next && <Button variant="outline" onClick={() => { previous.current.set(next, cursor ?? ""); navigate({ cursor: next }); }}>{t(($) => $.activity.next)}</Button>}
    </div>
  </div>;
}

export function ProjectActivityPage({ projectId }: { projectId: string }) {
  const workspace = useWorkspaceId();
  const { t } = useT("projects");
  const paths = useWorkspacePaths();
  const detail = useQuery({ ...projectDetailOptions(workspace, projectId), enabled: Boolean(workspace) });
  return <main className="flex h-full min-h-0 flex-col">
    <header className="flex items-baseline gap-3 border-b px-4 py-3">
      <AppLink className={link} href={paths.projects()}>{t(($) => $.page.title)}</AppLink>
      <h1 className="truncate font-semibold">{detail.data?.title || projectId}</h1>
    </header>
    <ProjectContentTabs contentTab="activity" projectId={projectId} activity={<ActivityPanel projectId={projectId} workspace={workspace} />} />
  </main>;
}
