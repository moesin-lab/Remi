import { resolveProjectRepositories } from "./tasks-repo.js";
import { canonicalGitRemoteKey, normalizeWorkspaceRepositories } from "../../api/helpers/repositories.js";
import type { ProjectMergePolicy, ScmActor, ScmStructuredReview } from "@multiremi/contracts/merge-policy.js";
import { createId, nowIso } from "@multiremi/ids.js";
import type { StoreContext } from "../context.js";
import { defaultMergePolicy, validateMergePolicy } from "../../scm/merge-policy.js";
import { ScmOperationError } from "../../scm/operations.js";
export class MergePolicyRepo {
  constructor(private readonly ctx: StoreContext) {}
  get(projectId: string): ProjectMergePolicy {
    const row = this.ctx.db.query("SELECT policy FROM multiremi_project_merge_policies WHERE project_id=?").get(projectId);
    return row ? JSON.parse(String(row.policy)) : defaultMergePolicy();
  }
  put(projectId: string, value: unknown, memberId: string): ProjectMergePolicy {
    const input = validateMergePolicy(value);
    for (const id of input.independent_reviewers) {
      const agent = this.ctx.agents().getAgent(id);
      const project = this.ctx.projects().getProject(projectId);
      if (!agent || agent.workspaceId !== project?.workspaceId || agent.archivedAt) throw new ScmOperationError("scm_invalid_input", "Reviewer must be an active Agent in this workspace");
    }
    const { expected_revision, ...fields } = input;
    const policy: ProjectMergePolicy = { ...fields, revision: expected_revision + 1 };
    return this.ctx.db.transaction(() => {
      const project = this.ctx.projects().getProject(projectId)!;
      this.ctx.lockWorkspaceRepositoryTopology(project.workspaceId);
      // Serialize coverage changes, policy updates and review submission on PG.
      this.ctx.db.query("UPDATE multiremi_projects SET id=id WHERE id=?").run(projectId);
      // Atomic compare-and-swap also serializes concurrent first writes across processes.
      const changed = expected_revision === 0
        ? this.ctx.db.query(`INSERT INTO multiremi_project_merge_policies(project_id, revision, policy, updated_by, updated_at)
            VALUES(?,?,?,?,?) ON CONFLICT(project_id) DO NOTHING`).run(projectId, policy.revision, JSON.stringify(policy), memberId, nowIso())
        : this.ctx.db.query(`UPDATE multiremi_project_merge_policies SET revision=?, policy=?, updated_by=?, updated_at=? WHERE project_id=? AND revision=?`)
            .run(policy.revision, JSON.stringify(policy), memberId, nowIso(), projectId, expected_revision);
      if (!changed.changes) throw new ScmOperationError("scm_policy_conflict", "Merge policy revision changed");
      const coverage = this.deriveCoverage(project.workspaceId, projectId);
      if (policy.enabled && policy.credential_enforcement_mode === "strict" && !coverage.size) throw new ScmOperationError("merge_policy_strict_coverage_empty", "Strict policy requires an explicitly bound repository");
      // Only the member-authorized policy PUT may shrink persisted coverage.
      this.ctx.db.query("DELETE FROM multiremi_scm_strict_coverage WHERE project_id=?").run(projectId);
      if (policy.enabled && policy.credential_enforcement_mode === "strict") this.persistCoverage(project.workspaceId, projectId, policy.revision, coverage);
      return policy;
    })();
  }

  private deriveCoverage(workspaceId: string, projectId: string): Map<string, string> {
    const repositories = new Map<string, string>();
    const imported = normalizeWorkspaceRepositories(this.ctx.workspaces().getWorkspace(workspaceId)?.repos ?? []);
    for (const repo of resolveProjectRepositories(this.ctx, workspaceId, this.ctx.projects().listProjectResources(projectId))) {
      const match = imported.find(candidate => canonicalGitRemoteKey(candidate.url) === canonicalGitRemoteKey(repo.url));
      if (match) repositories.set(match.id, "project_resource");
    }
    for (const cr of this.ctx.db.query(`SELECT DISTINCT cr.repository_id FROM multiremi_scm_issue_links l JOIN multiremi_issues i ON i.id=l.issue_id
      JOIN multiremi_scm_change_requests cr ON cr.id=l.change_request_id
      WHERE i.project_id=? AND l.active=1 AND cr.workspace_id=?`).all(projectId, workspaceId)) repositories.set(String(cr.repository_id), "cr_link");
    return repositories;
  }
  private persistCoverage(workspaceId: string, projectId: string, revision: number, repositories: Map<string, string>): void {
    for (const [id, source] of repositories) this.ctx.db.query(`INSERT INTO multiremi_scm_strict_coverage
      (workspace_id,repository_id,project_id,policy_revision,source,created_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(workspace_id,repository_id,project_id) DO NOTHING`).run(workspaceId, id, projectId, revision, source, nowIso());
  }
  /** In a transaction, take the topology lock and include project_ref dependents. */
  appendStrictCoverage(workspaceId: string): void {
    this.ctx.lockWorkspaceRepositoryTopology(workspaceId);
    for (const project of this.ctx.projects().listProjects(workspaceId).sort((a,b) => a.id.localeCompare(b.id))) {
      const policy = this.get(project.id);
      if (policy.enabled && policy.credential_enforcement_mode === "strict") this.persistCoverage(workspaceId, project.id, policy.revision, this.deriveCoverage(workspaceId, project.id));
    }
  }
  strictForRepository(workspaceId: string, repositoryId: string) {
    return this.ctx.db.transaction(() => {
      this.appendStrictCoverage(workspaceId);
      return this.ctx.db.query(`SELECT project_id FROM multiremi_scm_strict_coverage WHERE workspace_id=? AND repository_id=? ORDER BY project_id`).all(workspaceId, repositoryId)
        .map(row => ({ project_id: String(row.project_id), policy: this.get(String(row.project_id)),
          coverage: this.ctx.db.query("SELECT repository_id,policy_revision,source FROM multiremi_scm_strict_coverage WHERE workspace_id=? AND project_id=? ORDER BY repository_id").all(workspaceId, String(row.project_id)) }))
        .filter(entry => entry.policy.enabled && entry.policy.credential_enforcement_mode === "strict");
    })();
  }

  findChangeRequest(connectionId: string, repositoryId: string, externalId: string): { id: string } | null {
    return this.ctx.db.query("SELECT id FROM multiremi_scm_change_requests WHERE connection_id=? AND repository_id=? AND external_id=?").get(connectionId, repositoryId, externalId) ?? null;
  }
  recordActor(changeRequestId: string, action: "create" | "update", actor: ScmActor): void {
    this.ctx.db.query("INSERT INTO multiremi_scm_cr_actors(id,change_request_id,action,actor,created_at) VALUES(?,?,?,?,?)")
      .run(createId("sca"), changeRequestId, action, JSON.stringify(actor), nowIso());
  }
  actors(changeRequestId: string): Array<{ action: string; actor: ScmActor }> {
    return this.ctx.db.query("SELECT action,actor FROM multiremi_scm_cr_actors WHERE change_request_id=?").all(changeRequestId)
      .map(row => ({ action: String(row.action), actor: JSON.parse(String(row.actor)) }));
  }
  belongsToProject(projectId: string, changeRequestId: string): boolean {
    return Boolean(this.ctx.db.query(`SELECT 1 FROM multiremi_scm_issue_links l JOIN multiremi_issues i ON i.id=l.issue_id
      WHERE l.change_request_id=? AND l.active=1 AND i.project_id=? LIMIT 1`).get(changeRequestId, projectId));
  }
  approvalIssue(projectId: string, crId: string): string | null {
    const row = this.ctx.db.query(`SELECT i.id FROM multiremi_scm_issue_links l JOIN multiremi_issues i ON i.id=l.issue_id
      WHERE l.change_request_id=? AND l.active=1 AND i.project_id=? ORDER BY i.id LIMIT 1`).get(crId, projectId);
    return row ? String(row.id) : null;
  }
  list(projectId: string, crId: string): ScmStructuredReview[] {
    return this.ctx.db.query("SELECT review FROM multiremi_scm_reviews WHERE project_id=? AND change_request_id=? ORDER BY sequence ASC")
      .all(projectId, crId).map(row => JSON.parse(String(row.review)));
  }
  append(input: Omit<ScmStructuredReview, "id" | "sequence" | "submitted_at">): ScmStructuredReview {
    return this.ctx.db.transaction(() => {
      // Project row lock serializes sequence allocation and policy updates in PostgreSQL.
      this.ctx.db.query("UPDATE multiremi_projects SET id=id WHERE id=?").run(input.project_id);
      if (this.get(input.project_id).revision !== input.policy_revision) throw new ScmOperationError("scm_policy_conflict", "Merge policy revision changed");
      const sequence = Number(this.ctx.db.query("SELECT COALESCE(MAX(sequence),0) AS n FROM multiremi_scm_reviews WHERE project_id=? AND change_request_id=?").get(input.project_id, input.change_request_id).n) + 1;
      const review: ScmStructuredReview = { ...input, id: createId("scr"), sequence, submitted_at: nowIso() };
      this.ctx.db.query("INSERT INTO multiremi_scm_reviews(id,project_id,change_request_id,sequence,review) VALUES(?,?,?,?,?)")
        .run(review.id, input.project_id, input.change_request_id, sequence, JSON.stringify(review));
      return review;
    })();
  }
}
