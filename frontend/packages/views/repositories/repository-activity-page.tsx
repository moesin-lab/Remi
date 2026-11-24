"use client";

import { memo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { activityFilters, activityStatuses, repositoryActivityOptions, repositoryListOptions, type ActivityPage } from "@multiremi/core/repositories";
import { agentListOptions } from "@multiremi/core/workspace/queries";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import { TranscriptButton } from "../common/task-transcript";
import { useT } from "../i18n";
import { AppLink, useNavigation } from "../navigation";

type Item = ActivityPage["items"][number];
const statuses = [...activityStatuses.active, ...activityStatuses.history];
const linkStyle = "text-primary hover:underline";

function duration(item: Item, asOf: string | null, locale: string) {
  const end = item.ended_at ?? (activityStatuses.active.some((status) => status === item.status) ? asOf : null);
  if (!item.started_at || !end) return "—";
  const seconds = Math.floor((Date.parse(end) - Date.parse(item.started_at)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const unit = seconds < 60 ? "second" : seconds < 3600 ? "minute" : "hour";
  const amount = unit === "second" ? seconds : unit === "minute" ? seconds / 60 : seconds / 3600;
  return new Intl.NumberFormat(locale, { style: "unit", unit, maximumFractionDigits: unit === "hour" ? 1 : 0 }).format(amount);
}

const ActivityRow = memo(function ActivityRow({ item, asOf }: { item: Item; asOf: string | null }) {
  const { t, i18n } = useT("repositories");
  const { t: agentText } = useT("agents");
  const paths = useWorkspacePaths();
  const status = statuses.find((value) => value === item.status);
  const relation = (["direct", "issue_pr", "project_context"] as const).find((value) => value === item.relation);
  const agent = item.agent?.name || item.agent?.id || "—";
  const summaries = new Set([item.progress_summary, item.wait_reason, item.failure_reason, item.error_summary].filter(Boolean));
  const created = item.created_at && new Date(item.created_at);
  return <li className="space-y-2 border-b py-3 text-sm">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <strong className={item.status === "failed" ? "text-destructive" : undefined}>{status ? agentText(($) => $.transcript[`status_${status}`]) : item.status}</strong>
      <span>{agent}</span>
      {created && Number.isFinite(created.getTime()) && <time className="text-muted-foreground" dateTime={item.created_at!}>
        {created.toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" })}
      </time>}
      <span className="text-muted-foreground">{t(($) => $.activity.elapsed)} {duration(item, asOf, i18n.language)}</span>
      {item.attempt > 1 && <span>{t(($) => $.activity.attempt, { count: item.attempt })}</span>}
      <TranscriptButton
        task={{
          id: item.task_id, turn_id: item.turn_id, status: item.status, agent_id: item.agent?.id,
          started_at: item.started_at, completed_at: item.ended_at, created_at: item.created_at ?? undefined,
        }}
        agentName={agent}
        title={t(($) => $.activity.transcript)}
        isLive={item.status === "running"}
      />
    </div>
    <div className="flex flex-wrap items-baseline gap-x-3">
      {item.issue ? <AppLink className={linkStyle} href={paths.issueDetail(item.issue.id)}>{[item.issue.key, item.issue.title].filter(Boolean).join(" · ") || item.issue.id}</AppLink> : t(($) => $.activity.noIssue)}
      {item.issue && item.issue_session && <AppLink className={linkStyle} href={paths.issueSession(item.issue.id, item.issue_session.id)}>{t(($) => $.activity.session)} · {item.issue_session.title || item.issue_session.id}</AppLink>}
      <span className="rounded bg-muted px-1.5 text-xs">{relation ? t(($) => $.activity[relation]) : item.relation}</span>
      {relation === "project_context" && <span className="text-xs text-muted-foreground">{t(($) => $.activity.contextHelp)}</span>}
    </div>
    {Array.from(summaries, (summary) => <p key={summary} className="break-words">{summary}</p>)}
    <details>
      <summary className="cursor-pointer text-xs text-muted-foreground">{item.task_id} · PR ({item.change_request_count}) · {t(($) => $.activity.worktree)}</summary>
      <div className="mt-2 flex flex-wrap gap-3 text-xs">
        {item.change_requests.length === 0 && t(($) => $.activity.noPR)}
        {item.change_requests.map((pr) => {
          const label = `PR ${pr.number == null ? pr.id : `#${pr.number}`} · ${pr.state}`;
          return pr.url && /^https?:\/\//i.test(pr.url) ? <a key={pr.id} href={pr.url} target="_blank" rel="noreferrer" className={linkStyle}>{label}</a> : <span key={pr.id}>{label}</span>;
        })}
        <span>{item.worktree ? [item.worktree.branch || t(($) => $.activity.noBranch), item.worktree.status].filter(Boolean).join(" · ") : t(($) => $.activity.noWorktree)}</span>
      </div>
    </details>
  </li>;
});

export function RepositoryActivityPage({ repositoryId }: { repositoryId: string }) {
  const workspace = useWorkspaceId();
  const paths = useWorkspacePaths();
  const navigation = useNavigation();
  const { t } = useT("repositories");
  const { t: agentText } = useT("agents");
  const filters = activityFilters(navigation.searchParams);
  const query = useQuery(repositoryActivityOptions(workspace, repositoryId, filters));
  const repositories = useQuery({ ...repositoryListOptions(workspace), enabled: false });
  const agents = useQuery(agentListOptions(workspace));
  const previous = useRef(new Map<string, string>());
  const cursor = filters.cursor;
  const nextCursor = query.data?.next_cursor;
  const name = repositories.data?.repositories.find((repo) => repo.id === repositoryId)?.name ?? repositoryId;
  function navigate(changes: Record<string, string>) {
    const params = new URLSearchParams(navigation.searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value) params.set(key, value); else params.delete(key);
    }
    navigation.push(`${paths.repositoryActivity(repositoryId)}?${params}`);
  }
  const selectStyle = "rounded-md border bg-background px-2 py-1.5 text-sm";
  return <main className="h-full overflow-y-auto p-5">
    <AppLink className={linkStyle} href={paths.repositories()}>{t(($) => $.page.title)}</AppLink>
    <h1 className="my-3 text-xl font-semibold">{name} · {t(($) => $.activity.tasks)}</h1>
    <div className="flex gap-2">
      {(["active", "history"] as const).map((view) => <Button
        key={view} aria-pressed={view === filters.view}
        variant={view === filters.view ? "secondary" : "ghost"}
        onClick={() => navigate({ view, status: "", cursor: "" })}
      >{t(($) => $.activity[view])}</Button>)}
    </div>
    {filters.view === "history" && <p className="mt-2 text-sm text-muted-foreground">{t(($) => $.activity.current)}</p>}
    <form key={JSON.stringify(filters)} className="my-4 flex flex-wrap items-end gap-3 border-b pb-4" onSubmit={(event) => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      navigate({ status: String(values.get("status") || ""), agent_id: String(values.get("agent_id") || ""), q: String(values.get("q") || "").trim(), cursor: "" });
    }}>
      <label className="grid gap-1 text-xs">{t(($) => $.activity.status)}
        <select className={selectStyle} name="status" defaultValue={filters.status || ""}>
          <option value="">{t(($) => $.activity.all)}</option>
          {activityStatuses[filters.view].map((status) => <option key={status} value={status}>
            {agentText(($) => $.transcript[`status_${status}`])}
          </option>)}
        </select>
      </label>
      <label className="grid gap-1 text-xs">{t(($) => $.activity.agent)}
        <select className={selectStyle} name="agent_id" defaultValue={filters.agent_id || ""}>
          <option value="">{t(($) => $.activity.all)}</option>
          {filters.agent_id && !agents.data?.some((agent) => agent.id === filters.agent_id) && <option value={filters.agent_id}>{filters.agent_id}</option>}
          {agents.data?.map((agent) => <option key={agent.id} value={agent.id}>{agent.name || agent.id}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-xs">{t(($) => $.activity.issueSearch)}<Input name="q" defaultValue={filters.q} /></label>
      <Button type="submit" variant="outline">{t(($) => $.activity.apply)}</Button>
    </form>
    {query.isPending && <p role="status">{t(($) => $.activity.loading)}</p>}
    {query.isError && <div role="alert">{t(($) => $.activity.error)} <Button variant="outline" onClick={() => void query.refetch()}>{t(($) => $.activity.retry)}</Button></div>}
    {query.data && <>
      {!query.data.items.length && <p>{t(($) => $.activity.empty)}</p>}
      <ul>{query.data.items.map((item) => <ActivityRow key={item.task_id} item={item} asOf={filters.view === "active" ? query.data.as_of : null} />)}</ul>
    </>}
    <div className="mt-4 flex gap-2">
      {cursor && <Button variant="outline" onClick={() => navigate({ cursor: previous.current.get(cursor) || "" })}>
        {previous.current.has(cursor) ? t(($) => $.activity.previous) : t(($) => $.activity.first)}
      </Button>}
      {nextCursor && <Button variant="outline" onClick={() => {
        previous.current.set(nextCursor, cursor || "");
        navigate({ cursor: nextCursor });
      }}>{t(($) => $.activity.next)}</Button>}
    </div>
  </main>;
}
