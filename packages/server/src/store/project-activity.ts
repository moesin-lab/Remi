import { createHash } from "node:crypto";
import type { ProjectActivityItem, ProjectActivityResponse, ProjectActivityStatus, ProjectActivitySummary } from "@multiremi/contracts/types.js";
import type { SqlDatabase } from "./db/postgres.js";

const states: Record<string, ProjectActivityStatus[]> = {
  active: ["queued", "dispatched", "running", "waiting_local_directory", "awaiting_human"],
  history: ["completed", "failed", "cancelled"],
};
export interface ProjectActivityScope { workspaceId: string; projectId: string; taskId: string | null; privateAgentOwner: string | null; identity: string }
export class ProjectActivityQueryError extends Error {}

function timestamp(value: string | undefined) {
  if (!value?.trim()) return null;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) throw new ProjectActivityQueryError("expected UTC timestamp");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,19) !== value.slice(0,19)) throw new ProjectActivityQueryError("invalid timestamp");
  return parsed.toISOString();
}

function summary(status: ProjectActivityStatus, step: number | null, total: number | null, failure: string | null): ProjectActivitySummary | null {
  switch (status) {
    case "failed": return failure === "context_overflow" || failure === "offer_too_large" ? { code: failure } : null;
    case "running": return step !== null && total !== null && Number.isInteger(step) && Number.isInteger(total) && step >= 0 && total >= 1 && step <= total && total <= 1_000_000 ? { code: "step_progress", step, total } : null;
    case "waiting_local_directory": return { code: "needs_directory" };
    case "awaiting_human": return { code: "needs_human" };
    default: return { code: status };
  }
}

export function listProjectActivity(db: SqlDatabase, scope: ProjectActivityScope, params: Record<string,string>): ProjectActivityResponse {
  const view = params.view?.trim() || "active";
  const status = params.status?.trim();
  const limit = Number(params.limit?.trim() || 30);
  const from = timestamp(params.from), to = timestamp(params.to);
  if ((view !== "active" && view !== "history") || (status && !states[view]!.includes(status as ProjectActivityStatus)) || !Number.isInteger(limit) || limit < 1 || limit > 100 || (from && to && from >= to)) throw new ProjectActivityQueryError("invalid activity filters");
  const agent = params.agent_id?.trim() || null, search = params.q?.trim().toLowerCase() || null;
  const binding = createHash("sha256").update(JSON.stringify([scope.workspaceId, scope.projectId, scope.taskId, scope.privateAgentOwner, scope.identity, view, status || null, agent, search, from, to, limit])).digest("base64url");
  const selected = status ? [status] : states[view]!;
  const conditions = [`status IN (${selected.map(() => "?").join(",")})`];
  const args: unknown[] = [scope.workspaceId, scope.projectId, ...selected];
  if (scope.taskId) { conditions.push("attempt_id=?"); args.push(scope.taskId); }
  if (scope.privateAgentOwner !== null) { conditions.push("(visibility <> 'private' OR owner_id=?)"); args.push(scope.privateAgentOwner); }
  if (agent) { conditions.push("agent_id=?"); args.push(agent); }
  if (search) {
    conditions.push("(lower(issue_key) LIKE ? ESCAPE '!' OR lower(issue_title) LIKE ? ESCAPE '!')");
    const pattern = `%${search.replace(/[!%_]/g, "!$&")}%`;
    args.push(pattern, pattern);
  }
  if (from) { conditions.push("created_at >= ?"); args.push(from); }
  if (to) { conditions.push("created_at < ?"); args.push(to); }
  if (params.cursor?.trim()) {
    try {
      if (!/^[A-Za-z0-9_-]{1,2048}$/.test(params.cursor)) throw Error();
      const cursor = JSON.parse(Buffer.from(params.cursor,"base64url").toString());
      if (cursor.binding !== binding || !timestamp(cursor.created) || typeof cursor.id !== "string" || !cursor.id) throw Error();
      conditions.push("(created_at < ? OR (created_at=? AND attempt_id < ?))"); args.push(cursor.created, cursor.created, cursor.id);
    } catch { throw new ProjectActivityQueryError("invalid cursor"); }
  }
  const rows = db.query(`WITH candidates AS (
    SELECT t.id AS turn_id, a.id AS attempt_id, a.attempt_no, a.created_at, a.updated_at, a.started_at, a.ended_at,
      CASE WHEN a.id=t.current_attempt_id AND t.status='awaiting_human' THEN 'awaiting_human' WHEN a.status='offered' THEN 'queued' WHEN a.status='accepted' THEN 'dispatched' WHEN a.status='lost' THEN 'failed' ELSE a.status END AS status,
      a.progress_step, a.progress_total, CASE a.failure_reason WHEN 'agent_error.context_overflow' THEN 'context_overflow' WHEN 'offer_too_large' THEN 'offer_too_large' END AS failure,
      i.id AS issue_id, COALESCE(NULLIF(i.issue_key,''), CASE WHEN i.issue_number>0 THEN 'MUL-' || CAST(i.issue_number AS TEXT) ELSE i.id END) AS issue_key, i.title AS issue_title,
      g.id AS agent_id,g.name,g.visibility,g.owner_id,s.id AS session_id,s.title AS session_title
    FROM multiremi_projects p JOIN multiremi_issues i ON i.project_id=p.id AND i.workspace_id=p.workspace_id
    JOIN multiremi_turns t ON t.issue_id=i.id AND t.workspace_id=i.workspace_id AND t.chat_session_id IS NULL
    JOIN multiremi_turn_attempts a ON a.turn_id=t.id JOIN multiremi_agents g ON g.id=t.agent_id AND g.workspace_id=p.workspace_id
    LEFT JOIN multiremi_issue_sessions s ON s.id=t.session_id AND s.issue_id=i.id AND s.workspace_id=p.workspace_id AND s.chat_id IS NULL
    WHERE p.workspace_id=? AND p.id=? AND (t.issue_session_id IS NULL OR t.issue_session_id=s.id)
      AND NOT EXISTS (SELECT 1 FROM multiremi_chat_sessions chat WHERE chat.id=t.session_id)
      AND (s.id IS NOT NULL OR (t.issue_session_id IS NULL AND t.session_id=('auto_orphan_' || t.workspace_id)))
      AND a.attempt_no BETWEEN 1 AND 9007199254740991)
    SELECT * FROM candidates WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC,attempt_id DESC LIMIT ?`).all(...args,limit+1);
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  const items: ProjectActivityItem[] = rows.map(row => ({ turn_id: row.turn_id, attempt_id: row.attempt_id, attempt_no: row.attempt_no, status: row.status,
    issue: { id: row.issue_id, key: row.issue_key, title: row.issue_title }, agent: { id: row.agent_id, name: row.name },
    issue_session: row.session_id ? { id: row.session_id, title: row.session_title } : null,
    created_at: row.created_at, updated_at: row.updated_at, started_at: row.started_at, ended_at: row.ended_at,
    public_summary: summary(row.status,row.progress_step,row.progress_total,row.failure) }));
  const last = items.at(-1);
  return { items, has_more: hasMore, next_cursor: hasMore && last ? Buffer.from(JSON.stringify({binding, created:last.created_at, id:last.attempt_id})).toString("base64url") : null, as_of: new Date().toISOString() };
}
