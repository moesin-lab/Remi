import { applyInitialBatch, verifyInitialOwnership } from './scm-ownership-classification.js';
import { auditScmRollback, checkInitialInventory, ownershipPhase } from "./scm-rollback-audit.js";
import type { SqlDatabase } from "./db/postgres.js";

type ScmIssueOwnershipAttribution = "manual" | "branch" | "title" | "body";

export function persistedOwnership(row: Record<string, unknown>): ScmIssueOwnershipAttribution[] {
  if (row.link_source === "manual") return ["manual"];
  return row.attribution ? JSON.parse(String(row.attribution)) : [];
}

export function scmOwnershipReady(db: SqlDatabase): boolean {
  return Boolean(db.query("SELECT singleton FROM multiremi_scm_ownership_cutover WHERE singleton = 1 AND complete = 1 AND EXISTS (SELECT 1 FROM multiremi_scm_audit_state WHERE phase='ready') AND NOT EXISTS (SELECT 1 FROM multiremi_scm_rollback_review)").get());
}

export function assertScmOwnershipReady(db: SqlDatabase): void {
  if (!scmOwnershipReady(db)) {
    throw new Error("SCM ownership cutover incomplete. Stop writers and run remi db classify-scm-links offline.");
  }
}

export function deleteScmIssueLinks(db: SqlDatabase, scope: string, params: string[]): void {
  db.run(`DELETE FROM multiremi_scm_link_ownership WHERE link_id IN (SELECT id FROM multiremi_scm_issue_links WHERE ${scope})`, params);
  db.run(`DELETE FROM multiremi_scm_issue_links WHERE ${scope}`, params);
}

export function classifyScmLinkBatch(db: SqlDatabase, limit = 250): boolean {
  if (ownershipPhase(db)?.phase !== 'initial') throw new Error('Initial classification requires a trusted first cutover');
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid classification batch size");
  checkInitialInventory(db);
  return applyInitialBatch(db, limit);
}

export function classifyScmLinks(db: SqlDatabase) {
  const state = ownershipPhase(db);
  if (state?.phase === 'held') return auditScmRollback(db);
  if (state?.phase === 'ready' && scmOwnershipReady(db)) return { complete: true };
  if (state?.phase !== 'initial') throw new Error('Trusted pre-rollback baseline unavailable. Keep writers isolated; provide a verified pre-cutover inventory.');
  checkInitialInventory(db);
  while (!applyInitialBatch(db, 250)) continue;
  return db.transaction(() => {
    checkInitialInventory(db);
    verifyInitialOwnership(db);
    db.run("UPDATE multiremi_scm_ownership_cutover SET complete=1 WHERE singleton=1");
    db.run("UPDATE multiremi_scm_audit_state SET phase='ready' WHERE singleton=1");
    return { complete: true };
  })();
}
