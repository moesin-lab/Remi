import type { SqlDatabase } from './db/postgres.js';

type ScmIssueOwnershipAttribution = "manual" | "branch" | "title" | "body";

interface ScmIssueOwnershipCandidate {
  issueKey: string;
  title: string;
  body: string | null;
  sourceBranch: string | null;
}

export function applyInitialBatch(db: SqlDatabase, limit: number): boolean {
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
      const attribution = initialAttribution(row);
      db.run("INSERT INTO multiremi_scm_link_ownership (link_id, attribution) VALUES (?, ?)", [row.id, JSON.stringify(attribution)]);
    }
    const complete = rows.length < limit;
    db.run("UPDATE multiremi_scm_ownership_cutover SET cursor_id = ? WHERE singleton = 1",
      [rows.at(-1)?.id ?? state.cursor_id]);
    return complete;
  })();
}

function initialAttribution(row: Record<string, unknown>) {
  return scmIssueOwnershipAttribution({
        issueKey: String(row.issue_key || (Number(row.issue_number) > 0 ? `MUL-${row.issue_number}` : row.issue_id)),
        title: String(row.title), body: String(row.body ?? ""), sourceBranch: String(row.source_branch ?? ""),
      });
}

export function verifyInitialOwnership(db: SqlDatabase) {
  let cursor='';
  for (;;) {
    const rows=db.query(`SELECT l.id,i.id AS issue_id,i.issue_key,i.issue_number,cr.title,cr.body,cr.source_branch,e.attribution
      FROM multiremi_scm_issue_links l LEFT JOIN multiremi_scm_change_requests cr ON cr.id=l.change_request_id
      LEFT JOIN multiremi_issues i ON i.id=l.issue_id LEFT JOIN multiremi_scm_link_ownership e ON e.link_id=l.id
      WHERE l.id>? AND l.source IN ('auto','legacy') ORDER BY l.id LIMIT 250`).all(cursor);
    if (rows.some(row => row.issue_id == null || row.attribution !== JSON.stringify(initialAttribution(row)))) throw new Error('Initial ownership evidence changed; keep writers isolated');
    if (rows.length<250) return;
    cursor=rows.at(-1).id;
  }
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
