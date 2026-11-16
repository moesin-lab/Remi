import type { MergePolicyUpdate, ProjectMergePolicy, RequiredMergeCheck, ScmReviewInput } from "@multiremi/contracts/merge-policy.js";
import { ScmOperationError } from "./operations.js";
export const defaultMergePolicy = (): ProjectMergePolicy => ({ version: 1, revision: 0, enabled: false,
  target_branches: [], required_checks: [], require_independent_review: true, independent_reviewers: [],
  require_human_approval: false, allowed_merge_methods: ["squash"], credential_enforcement_mode: "platform_only" });
export function invalid(message: string): never { throw new ScmOperationError("scm_invalid_input", message); }
export function strictObject(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Expected a JSON object");
  for (const key of Object.keys(value as object)) if (!keys.includes(key)) invalid(`Unknown field: ${key}`);
}
function strings(value: unknown, name: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== "string" || !v.trim() || v !== v.trim()) || new Set(value).size !== value.length) invalid(`Invalid ${name}`);
}
export function validateRequiredCheck(value: unknown): asserts value is RequiredMergeCheck {
  strictObject(value, ["kind", "app_id", "workflow_path", "job", "context"]);
  if (value.kind === "commit_status") {
    strictObject(value, ["kind", "context"]);
    if (typeof value.context !== "string" || !value.context.trim()) invalid("Status context required");
  } else if (value.kind === "check_run") {
    strictObject(value, ["kind", "app_id", "workflow_path", "job"]);
    if (!Number.isSafeInteger(value.app_id) || Number(value.app_id) < 1
      || typeof value.workflow_path !== "string" || !/^\.github\/workflows\/[^\s]+\.ya?ml$/u.test(value.workflow_path)
      || typeof value.job !== "string" || !value.job.trim()) invalid("Check requires app_id, workflow_path and job identity");
  } else invalid("Unsupported check kind");
}
export function validateMergePolicy(value: unknown): MergePolicyUpdate {
  strictObject(value, ["version", "expected_revision", "enabled", "target_branches", "required_checks", "require_independent_review", "independent_reviewers", "require_human_approval", "allowed_merge_methods", "credential_enforcement_mode"]);
  if (value.version !== 1 || !Number.isSafeInteger(value.expected_revision) || Number(value.expected_revision) < 0) invalid("version=1 and expected_revision required");
  for (const key of ["enabled", "require_independent_review", "require_human_approval"]) if (typeof value[key] !== "boolean") invalid(`${key} must be boolean`);
  strings(value.target_branches, "target_branches"); strings(value.independent_reviewers, "independent_reviewers"); strings(value.allowed_merge_methods, "allowed_merge_methods");
  if (value.target_branches.some(v => /[\s:*?\[\]\\~^]/u.test(v) || v.startsWith("/") || v.includes(".."))) invalid("target_branches must be exact branch names");
  if (value.enabled && !value.target_branches.length) invalid("Enabled policy needs target branches");
  // A disabled default is representable, but saving a review requirement needs explicit reviewers.
  if (value.require_independent_review && !value.independent_reviewers.length) invalid("independent_reviewers must not be empty when review is required");
  if (!value.allowed_merge_methods.length || value.allowed_merge_methods.some(v => !["merge", "squash", "rebase"].includes(v))) invalid("Invalid allowed_merge_methods");
  if (typeof value.credential_enforcement_mode !== "string" || !["strict", "platform_only"].includes(value.credential_enforcement_mode)) invalid("Invalid credential_enforcement_mode");
  if (!Array.isArray(value.required_checks)) invalid("required_checks must be an array");
  value.required_checks.forEach(validateRequiredCheck);
  return value as unknown as MergePolicyUpdate;
}
export function validateReview(value: unknown): ScmReviewInput {
  strictObject(value, ["schema_version", "head_sha", "base_sha", "verdict", "summary", "findings", "evidence"]);
  if (value.schema_version !== 1 || typeof value.verdict !== "string" || !["pass", "block"].includes(value.verdict)
    || typeof value.head_sha !== "string" || !/^[a-f0-9]{40}$/u.test(value.head_sha) || typeof value.base_sha !== "string" || !/^[a-f0-9]{40}$/u.test(value.base_sha)
    || typeof value.summary !== "string" || !value.summary.trim() || !Array.isArray(value.findings)) invalid("Invalid review schema");
  strings(value.evidence, "evidence");
  const ids = new Set();
  for (const f of value.findings) {
    strictObject(f, ["id", "severity", "blocking", "path", "line", "message"]);
    if (typeof f.id !== "string" || !f.id.trim() || ids.has(f.id) || typeof f.severity !== "string" || !["critical", "high", "medium", "low", "info"].includes(f.severity)
      || typeof f.blocking !== "boolean" || !(f.path === null || typeof f.path === "string")
      || !(f.line === null || Number.isSafeInteger(f.line) && Number(f.line) > 0)
      || typeof f.message !== "string" || !f.message.trim()) invalid("Invalid finding");
    ids.add(f.id);
    if (f.blocking && value.verdict === "pass") invalid("A blocking finding cannot have verdict pass");
  }
  return value as unknown as ScmReviewInput;
}
export function checkIdentity(check: RequiredMergeCheck): string {
  return check.kind === "commit_status" ? JSON.stringify([check.kind, check.context]) : JSON.stringify([check.kind, check.app_id, check.workflow_path, check.job]);
}
