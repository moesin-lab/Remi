import { createHash } from "node:crypto";
import type { MultiremiIssueWorkspaceRepo, RepositoryActivityItem, RepositoryActivityResponse } from "@multiremi/contracts/types.js";
import { canonicalGitRemoteKey, normalizeWorkspaceRepositories } from "../api/helpers/repositories.js";
import { PostgresSyncDatabase, type SqlDatabase } from "./db/postgres.js";
import { parseJson } from "./helpers.js";
import { redactRuntimeCommandText } from "../runtime-command-safety.js";

const statuses = {
  active: ["queued", "dispatched", "running", "waiting_local_directory", "awaiting_human"],
  history: ["completed", "failed", "cancelled"],
};

export class ActivityQueryError extends Error {}

const issueKey = "COALESCE(NULLIF(i.issue_key,''), CASE WHEN i.issue_number>0 THEN 'MUL-' || CAST(i.issue_number AS TEXT) ELSE i.id END)";

export interface ActivityScope {
  workspaceId: string;
  repository: { id: string; url: string };
  taskId: string | null;
  privateAgentOwner?: string | null;
}

function placeholders(values: unknown[]): string {
  return values.map(() => "?").join(",");
}

function directRepositorySql(db: SqlDatabase): string {
  const target = db instanceof PostgresSyncDatabase ? "CAST(r.schedule_target AS JSON)" : "r.schedule_target";
  return `COALESCE((SELECT COALESCE(CASE WHEN (${target} ->> 'kind')='repository' THEN (${target} ->> 'id') END,r.repository_id)
    FROM multiremi_autopilot_runs r JOIN multiremi_autopilots ap ON ap.id=r.autopilot_id AND ap.workspace_id=t.workspace_id
    WHERE r.task_id=t.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1), e.repository_id)`;
}

export type ActivitySubject = "task" | "issue" | "session" | "agent" | "project";

export function hasActivityForChange(db: SqlDatabase, workspaceId: string, repositoryId: string, issueIds: string[]): boolean {
  if (!issueIds.length) return false;
  return Boolean(db.query(`SELECT 1 FROM multiremi_tasks t
    LEFT JOIN multiremi_scm_events e ON e.id=t.assignment_source_event_id AND e.workspace_id=t.workspace_id
    WHERE t.workspace_id=? AND t.chat_session_id IS NULL AND t.issue_id IN (${placeholders(issueIds)})
    AND COALESCE(${directRepositorySql(db)},?)=? LIMIT 1`).get(workspaceId, ...issueIds, repositoryId, repositoryId));
}

export function hasProjectActivity(db: SqlDatabase, workspaceId: string, projectId: string): boolean {
  return Boolean(db.query(`SELECT 1 FROM multiremi_tasks t JOIN multiremi_issues i ON i.id=t.issue_id AND i.workspace_id=t.workspace_id
    LEFT JOIN multiremi_scm_events e ON e.id=t.assignment_source_event_id AND e.workspace_id=t.workspace_id
    WHERE i.project_id=? AND t.workspace_id=? AND t.chat_session_id IS NULL AND ${directRepositorySql(db)} IS NULL LIMIT 1`).get(projectId, workspaceId));
}

export function activityRepositories(db: SqlDatabase, workspaceId: string, subject: ActivitySubject, id: string): string[] {
  const column = { task: "t.id", issue: "i.id", session: "t.issue_session_id", agent: "t.agent_id", project: "i.project_id" }[subject];
  const rows = db.query(`WITH subjects AS (SELECT DISTINCT ${directRepositorySql(db)} AS direct_id,i.id AS issue_id,i.project_id
    FROM multiremi_tasks t LEFT JOIN multiremi_issues i ON i.id=t.issue_id AND i.workspace_id=t.workspace_id
    LEFT JOIN multiremi_scm_events e ON e.id=t.assignment_source_event_id AND e.workspace_id=t.workspace_id
    WHERE t.workspace_id=? AND t.chat_session_id IS NULL AND ${column}=?)
    SELECT direct_id AS repo_id,NULL AS resource_ref FROM subjects WHERE direct_id IS NOT NULL
    UNION SELECT pr.repository_id,NULL FROM subjects sub JOIN multiremi_scm_issue_links l ON l.issue_id=sub.issue_id
      JOIN multiremi_scm_change_requests pr ON pr.id=l.change_request_id AND pr.workspace_id=l.workspace_id
      WHERE sub.direct_id IS NULL AND l.workspace_id=? AND l.active=1
    UNION SELECT NULL,r.resource_ref FROM subjects sub JOIN multiremi_project_resources r ON r.project_id=sub.project_id
      WHERE sub.direct_id IS NULL AND r.workspace_id=? AND r.resource_type='github_repo'`).all(workspaceId,id,workspaceId,workspaceId);
  if (!rows.length) return [];
  const workspace = db.query("SELECT repos FROM multiremi_workspaces WHERE id=?").get(workspaceId);
  const repos = normalizeWorkspaceRepositories(parseJson(workspace?.repos, []));
  const ids = new Set(rows.map(row => row.repo_id));
  const urls = new Set(rows.flatMap(row => {
    const url = parseJson<{url?: string}>(row.resource_ref, {}).url;
    return typeof url === "string" ? [canonicalGitRemoteKey(url)] : [];
  }));
  return repos.filter(repo => ids.has(repo.id) || urls.has(canonicalGitRemoteKey(repo.url))).map(repo => repo.id);
}

function readFilters(scope: ActivityScope, params: Record<string, string>) {
  const view = params.view ?? "active";
  const status = params.status?.trim() || undefined;
  const agent = params.agent_id?.trim() || undefined;
  const search = params.q?.trim().toLowerCase() || undefined;
  const limit = Number(params.limit ?? 30);
  if ((view !== "active" && view !== "history") || (status && !statuses[view].includes(status))
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ActivityQueryError("invalid activity filters");
  const binding = createHash("sha256").update(JSON.stringify([scope.workspaceId, scope.repository.id, scope.taskId, view, status, agent, search, limit])).digest("base64url");
  let after: { created: string; id: string } | null = null;
  if (params.cursor !== undefined) {
    try {
      if (!/^[A-Za-z0-9_-]{1,2048}$/.test(params.cursor)) throw new Error();
      const cursor = JSON.parse(Buffer.from(params.cursor, "base64url").toString());
      if (cursor.binding !== binding || typeof cursor.id !== "string" || !cursor.id || typeof cursor.created !== "string" || !Number.isFinite(Date.parse(cursor.created))) throw new Error();
      after = { created: cursor.created, id: cursor.id };
    } catch { throw new ActivityQueryError("invalid activity cursor"); }
  }
  return { states: status ? [status] : statuses[view], agent, search, limit, binding, after };
}

export function readRepositoryActivity(db: SqlDatabase, scope: ActivityScope, params: Record<string, string>): RepositoryActivityResponse {
  const { workspaceId, repository } = scope;
  const filters = readFilters(scope, params);
  const remote = canonicalGitRemoteKey(repository.url);
  const projects = db.query(`SELECT r.project_id, r.resource_ref FROM multiremi_project_resources r
    JOIN multiremi_projects p ON p.id=r.project_id AND p.workspace_id=r.workspace_id
    WHERE r.workspace_id=? AND r.resource_type='github_repo'`).all(workspaceId).flatMap(row => {
    const url = parseJson<{url?: string}>(row.resource_ref, {}).url;
    return typeof url === "string" && canonicalGitRemoteKey(url) === remote ? [row.project_id] : [];
  });
  const projectMatch = projects.length ? `i.project_id IN (${placeholders(projects)})` : "1=0";
  const conditions = [`t.workspace_id=?`, `t.chat_session_id IS NULL`, `(t.issue_id IS NULL OR i.id IS NOT NULL)`,
    `(t.issue_session_id IS NULL OR s.id IS NOT NULL)`, `t.status IN (${placeholders(filters.states)})`];
  const args: unknown[] = [workspaceId, ...filters.states];
  if (scope.taskId) { conditions.push("t.id=?"); args.push(scope.taskId); }
  if (scope.privateAgentOwner) { conditions.push("(a.visibility <> 'private' OR a.owner_id=?)"); args.push(scope.privateAgentOwner); }
  if (filters.agent) { conditions.push("t.agent_id=?"); args.push(filters.agent); }
  if (filters.search) {
    conditions.push(`(lower(${issueKey}) LIKE ? ESCAPE '!' OR lower(i.title) LIKE ? ESCAPE '!')`);
    const pattern = `%${filters.search.replace(/[!%_]/g, "!$&")}%`;
    args.push(pattern, pattern);
  }
  if (filters.after) {
    conditions.push("(t.created_at < ? OR (t.created_at=? AND t.id < ?))");
    args.push(filters.after.created, filters.after.created, filters.after.id);
  }
  const rows = db.query(`WITH candidates AS (
    SELECT t.id, t.status, t.created_at, t.started_at, t.attempt, t.progress_summary, t.wait_reason, t.failure_reason,
      CASE WHEN t.status='failed' THEN substr(t.error,1,1024) END AS error_excerpt,
      CASE t.status WHEN 'completed' THEN t.completed_at WHEN 'cancelled' THEN t.cancelled_at WHEN 'failed' THEN t.failed_at END AS ended_at,
      a.id AS agent_id, a.name AS agent_name, i.id AS issue_id, ${issueKey} AS issue_key, i.title, s.id AS session_id, s.title AS session_title,
      ${directRepositorySql(db)} AS direct_id,
      CASE WHEN EXISTS (SELECT 1 FROM multiremi_scm_issue_links l JOIN multiremi_scm_change_requests pr
        ON pr.id=l.change_request_id AND pr.workspace_id=l.workspace_id WHERE l.issue_id=i.id AND l.workspace_id=t.workspace_id
        AND l.active=1 AND pr.repository_id=?) THEN 'issue_pr' WHEN ${projectMatch} THEN 'project_context' END AS indirect
    FROM multiremi_tasks t JOIN multiremi_agents a ON a.id=t.agent_id AND a.workspace_id=t.workspace_id
    LEFT JOIN multiremi_issues i ON i.id=t.issue_id AND i.workspace_id=t.workspace_id
    LEFT JOIN multiremi_issue_sessions s ON s.id=t.issue_session_id AND s.issue_id=i.id AND s.workspace_id=t.workspace_id
    LEFT JOIN multiremi_scm_events e ON e.id=t.assignment_source_event_id AND e.workspace_id=t.workspace_id
    WHERE ${conditions.join(" AND ")}) SELECT * FROM candidates WHERE direct_id=? OR (direct_id IS NULL AND indirect IS NOT NULL)
    ORDER BY created_at DESC,id DESC LIMIT ?`).all(repository.id, ...projects, ...args, repository.id, filters.limit + 1);
  const hasMore = rows.length > filters.limit;
  if (hasMore) rows.pop();
  const issueIds = [...new Set(rows.map(row => row.issue_id).filter(Boolean))];
  const trees = new Map<string, RepositoryActivityItem["worktree"]>();
  const changes = new Map<string, RepositoryActivityItem["change_requests"]>();
  const counts = new Map<string, number>();
  if (issueIds.length) {
    const ids = placeholders(issueIds);
    for (const row of db.query(`SELECT issue_id,repos FROM multiremi_issue_workspaces WHERE workspace_id=? AND issue_id IN (${ids})`).all(workspaceId, ...issueIds)) {
      const tree = parseJson<MultiremiIssueWorkspaceRepo[]>(row.repos, []).find(repo => repo.repoUrl && canonicalGitRemoteKey(repo.repoUrl) === remote);
      if (tree) trees.set(row.issue_id, { branch: tree.branchName || null, status: tree.status });
    }
    const prs = db.query(`SELECT * FROM (SELECT l.issue_id, pr.id, pr.number, pr.state, pr.url,
      COUNT(*) OVER (PARTITION BY l.issue_id) AS total, ROW_NUMBER() OVER (PARTITION BY l.issue_id ORDER BY pr.updated_at DESC,pr.id DESC) AS pos
      FROM multiremi_scm_issue_links l JOIN multiremi_scm_change_requests pr ON pr.id=l.change_request_id AND pr.workspace_id=l.workspace_id
      WHERE l.workspace_id=? AND pr.repository_id=? AND l.active=1 AND l.issue_id IN (${ids})) ranked WHERE pos<=3 ORDER BY issue_id,pos`).all(workspaceId, repository.id, ...issueIds);
    for (const pr of prs) {
      const list = changes.get(pr.issue_id) ?? [];
      list.push({ id: pr.id, number: pr.number, state: pr.state, url: pr.url });
      changes.set(pr.issue_id, list);
      counts.set(pr.issue_id, Number(pr.total));
    }
  }
  const items: RepositoryActivityItem[] = rows.map(row => ({
    task_id: row.id, status: row.status, relation: row.direct_id ? "direct" : row.indirect,
    agent: row.agent_id ? { id: row.agent_id, name: row.agent_name ?? null } : null,
    issue: row.issue_id ? { id: row.issue_id, key: row.issue_key || row.issue_id, title: row.title } : null,
    issue_session: row.session_id ? { id: row.session_id, title: row.session_title } : null,
    attempt: Math.max(1, row.attempt ?? 1), created_at: row.created_at, started_at: row.started_at, ended_at: row.ended_at,
    progress_summary: summary(row.progress_summary), wait_reason: summary(row.wait_reason), failure_reason: summary(row.failure_reason), error_summary: summary(row.error_excerpt),
    worktree: trees.get(row.issue_id) ?? null, change_requests: changes.get(row.issue_id) ?? [], change_request_count: counts.get(row.issue_id) ?? 0,
  }));
  const last = items.at(-1);
  const cursor = hasMore && last ? Buffer.from(JSON.stringify({binding: filters.binding, created: last.created_at, id: last.task_id})).toString("base64url") : null;
  return { items, has_more: hasMore, next_cursor: cursor, as_of: new Date().toISOString() };
}

function summary(value: string | null): string | null {
  if (!value) return null;
  return redactRuntimeCommandText(value).split(/[\r\n]/, 1)[0]!.replace(/(?:\/[\w.@{}+-]+){2,}/g, "[path]")
    .replace(/\b(?:Bearer\s+|(?:api[_-]?key|secret|token|password)\s*[:=]\s*)[^\s,;]+/gi, "[redacted]").slice(0, 180) || null;
}
