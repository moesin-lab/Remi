import type { SqlDatabase } from "./db/postgres.js";

type ScmIssueOwnershipAttribution = "manual" | "branch" | "title" | "body";

interface ScmIssueOwnershipCandidate {
  issueKey: string;
  title: string;
  body: string | null;
  sourceBranch: string | null;
}

export function persistedOwnership(row: Record<string, unknown>): ScmIssueOwnershipAttribution[] {
  if (row.link_source === "manual") return ["manual"];
  return row.attribution ? JSON.parse(String(row.attribution)) : [];
}

export function assertScmOwnershipReady(db: SqlDatabase): void {
  if (!db.query("SELECT singleton FROM multiremi_scm_ownership_cutover WHERE singleton = 1 AND complete = 1").get()) {
    throw new Error("SCM ownership cutover incomplete. Stop writers and run remi db classify-scm-links offline.");
  }
}

export function deleteScmIssueLinks(db: SqlDatabase, scope: string, params: string[]): void {
  db.run(`DELETE FROM multiremi_scm_link_ownership WHERE link_id IN (SELECT id FROM multiremi_scm_issue_links WHERE ${scope})`, params);
  db.run(`DELETE FROM multiremi_scm_issue_links WHERE ${scope}`, params);
}

export function classifyScmLinkBatch(db: SqlDatabase, limit = 250): boolean {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid classification batch size");
  return db.transaction(() => {
    db.run("INSERT INTO multiremi_scm_ownership_cutover (singleton, cursor_id, complete) VALUES (1, '', 0) ON CONFLICT(singleton) DO NOTHING");
    const state = db.query("SELECT cursor_id, complete FROM multiremi_scm_ownership_cutover WHERE singleton = 1").get()!;
    if (state.complete === 1) return true;
    const rows = db.query(`SELECT l.id, i.id AS issue_id, i.issue_key, i.issue_number, cr.title, cr.body, cr.source_branch
      FROM multiremi_scm_issue_links l
      JOIN multiremi_scm_change_requests cr ON cr.id = l.change_request_id
      JOIN multiremi_issues i ON i.id = l.issue_id
      WHERE l.id > ? AND l.source IN ('auto','legacy') ORDER BY l.id LIMIT ?`).all(state.cursor_id, limit);
    for (const row of rows) {
      const attribution = scmIssueOwnershipAttribution({
        issueKey: String(row.issue_key || (Number(row.issue_number) > 0 ? `MUL-${row.issue_number}` : row.issue_id)),
        title: String(row.title), body: String(row.body ?? ""), sourceBranch: String(row.source_branch ?? ""),
      });
      if (attribution.length) {
        db.run("INSERT INTO multiremi_scm_link_ownership (link_id, attribution) VALUES (?, ?)", [row.id, JSON.stringify(attribution)]);
      }
    }
    const complete = rows.length < limit;
    db.run("UPDATE multiremi_scm_ownership_cutover SET cursor_id = ?, complete = ? WHERE singleton = 1",
      [rows.at(-1)?.id ?? state.cursor_id, complete ? 1 : 0]);
    return complete;
  })();
}

export function classifyScmLinks(db: SqlDatabase): void {
  while (!classifyScmLinkBatch(db)) continue;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function scmIssueOwnershipAttribution(
  candidate: ScmIssueOwnershipCandidate,
): ScmIssueOwnershipAttribution[] {
  const issueKey = escapeRegExp(candidate.issueKey);
  const keyPattern = new RegExp(`\\b${issueKey}\\b`, "i");
  const bodyDeclarationPattern = new RegExp(
    `^[\\s\\-*>]*(fix(e[sd])?|close[sd]?|resolve[sd]?|issues?)\\s*[:：-]?\\s*${issueKey}\\b`,
    "im",
  );
  const attribution: ScmIssueOwnershipAttribution[] = [];
  if (keyPattern.test(candidate.sourceBranch ?? "")) attribution.push("branch");
  if (keyPattern.test(candidate.title)) attribution.push("title");
  if (bodyDeclarationPattern.test(candidate.body ?? "")) attribution.push("body");
  return attribution;
}
