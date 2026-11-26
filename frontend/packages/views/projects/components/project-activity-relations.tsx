"use client";

import { useQuery } from "@tanstack/react-query";
import { issueWorkspaceOptions } from "@multiremi/core/issues/queries";
import { issueChangeRequestsOptions } from "@multiremi/core/scm/queries";
import { useT } from "../../i18n";

export function ProjectActivityRelations({ workspaceId, issueId }: { workspaceId: string; issueId: string }) {
  const { t } = useT("projects");
  const { t: issues } = useT("issues");
  const changes = useQuery(issueChangeRequestsOptions(issueId));
  const worktree = useQuery(issueWorkspaceOptions(issueId));
  const requests = changes.data?.changeRequests.filter((request) => request.workspaceId === workspaceId) ?? [];
  const tree = worktree.data;
  const repos = tree?.workspace_id === workspaceId && tree.issue_id === issueId && tree.status !== "cleaned" && !tree.cleaned_at ? tree.repos : [];
  return <section className="mt-2 space-y-1 rounded border p-2 text-sm">
    {changes.isPending || worktree.isPending ? <p role="status">{t(($) => $.activity.loading)}</p> : null}
    {(changes.isError || worktree.isError) && <p role="alert">{t(($) => $.activity.loadError)} <button className="text-primary underline" onClick={() => {
      if (changes.isError) void changes.refetch();
      if (worktree.isError) void worktree.refetch();
    }}>{t(($) => $.activity.retry)}</button></p>}
    {requests.map((request) => {
      const state = issues(($) => $.detail[`change_request_state_${request.state}`]);
      const label = `${request.repositoryName || request.repositoryId} · PR ${request.number == null ? request.externalId : `#${request.number}`} · ${state}`;
      return <div key={request.id}>{request.url && /^https?:\/\//i.test(request.url)
        ? <a className="text-primary hover:underline" href={request.url} target="_blank" rel="noreferrer">{label}</a> : label}</div>;
    })}
    {changes.isSuccess && !requests.length && <p>{t(($) => $.activity.noPR)}</p>}
    {repos.map((repo) => <div key={repo.repo_url}>{repo.repo_name} · {repo.branch_name || "—"} · {issues(($) => $.detail.workspace_status[repo.status])}</div>)}
    {worktree.isSuccess && !repos.length && <p>{t(($) => $.activity.noBranch)}</p>}
  </section>;
}
