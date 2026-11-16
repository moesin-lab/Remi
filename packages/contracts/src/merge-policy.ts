/** Merge gate preflight is evidence, never execution authorization. */
export type RequiredMergeCheck =
  | { kind: "check_run"; app_id: number; workflow_path: string; job: string }
  | { kind: "commit_status"; context: string };
export interface ProjectMergePolicy {
  version: 1;
  revision: number;
  enabled: boolean;
  target_branches: string[];
  required_checks: RequiredMergeCheck[];
  require_independent_review: boolean;
  independent_reviewers: string[];
  require_human_approval: boolean;
  allowed_merge_methods: Array<"merge" | "squash" | "rebase">;
  credential_enforcement_mode: "platform_only" | "strict";
}
export type MergePolicyUpdate = Omit<ProjectMergePolicy, "revision"> & { expected_revision: number };
export interface ScmActor { kind: "agent" | "member"; id: string; turn_id: string | null }
export interface ScmReviewInput {
  schema_version: 1;
  head_sha: string;
  base_sha: string;
  verdict: "pass" | "block";
  summary: string;
  findings: Array<{ id: string; severity: "critical" | "high" | "medium" | "low" | "info"; blocking: boolean; path: string | null; line: number | null; message: string }>;
  evidence: string[];
}
export interface ScmStructuredReview extends ScmReviewInput {
  id: string;
  project_id: string;
  change_request_id: string;
  reviewer: ScmActor;
  submitted_at: string;
  policy_revision: number;
  target_branch: string;
  base_repository_full_name: string;
  /** Monotone database order, independent of wall clock precision. */
  sequence: number;
}
export interface MergeGateReason { code: string; message: string; evidence?: unknown }
export interface MergeGateResult {
  allowed: boolean;
  reasons: MergeGateReason[];
  preflight_only: true;
  execution_authorized: false;
  credential_boundary: "平台入口受控、直推未封闭";
  policy: ProjectMergePolicy;
}
