import type { MergeGateReason, MergeGateResult, ProjectMergePolicy, RequiredMergeCheck, ScmActor, ScmStructuredReview } from "@multiremi/contracts/merge-policy.js";
import type { ScmCheckObservation } from "@multiremi/contracts/scm-operations.js";
import { checkIdentity } from "./merge-policy.js";
export interface PullIdentity { head_sha: string; base_sha: string; target_branch: string; base_repository_full_name: string }
export function pullIdentity(payload: Record<string, unknown>): PullIdentity | null {
  const { head_sha, base_sha, target_branch, base_repository_full_name } = payload;
  if (typeof head_sha !== "string" || !/^[a-f0-9]{40}$/u.test(head_sha) || typeof base_sha !== "string" || !/^[a-f0-9]{40}$/u.test(base_sha)
    || typeof target_branch !== "string" || !target_branch || typeof base_repository_full_name !== "string" || !base_repository_full_name) return null;
  return { head_sha, base_sha, target_branch, base_repository_full_name: base_repository_full_name.toLowerCase() };
}
export function samePull(a: PullIdentity, b: PullIdentity): boolean {
  return a.head_sha === b.head_sha && a.base_sha === b.base_sha && a.target_branch === b.target_branch && a.base_repository_full_name === b.base_repository_full_name;
}
export function independentActor(actor: ScmActor, policy: ProjectMergePolicy, actors: Array<{ action: string; actor: ScmActor }>): boolean {
  if (!actors.some(a => a.action === "create")) return false;
  if (actor.kind === "member") return true; // Member attestation: shared operator, no creator/updater exclusion. Agents alone require independence.
  return policy.independent_reviewers.includes(actor.id) && !actors.some(a => a.actor.kind === "agent" && a.actor.id === actor.id);
}
export function evaluateMergeGate(input: {
  policy: ProjectMergePolicy; pull: PullIdentity; required: RequiredMergeCheck[];
  checks: ScmCheckObservation[]; reviews: ScmStructuredReview[]; actors: Array<{ action: string; actor: ScmActor }>;
  /** Internal execution evidence; HTTP preflight never supplies this. */
  operationApprovalValid?: boolean;
  protectionProof?: MergeGateResult["protection_proof"];
  reasons?: MergeGateReason[]; ref_write_rules?: MergeGateResult["ref_write_rules"];
}): MergeGateResult {
  const { policy, pull } = input;
  const review_evidence: MergeGateResult["review_evidence"] = [];
  const reasons: MergeGateReason[] = [...(input.reasons ?? [])];
  const add = (code: string, message: string, evidence?: unknown) => reasons.push({ code, message, ...(evidence === undefined ? {} : { evidence }) });
  if (!policy.enabled) add("policy_disabled", "Project merge policy is disabled");
  else {
    if (!policy.target_branches.includes(pull.target_branch)) add("target_branch_not_allowed", "Target branch is outside project merge policy", pull.target_branch);
    const unique = new Map(input.required.map(c => [checkIdentity(c), c]));
    if (!unique.size) add("required_checks_empty", "Repository and project required-check union is empty");
    for (const required of unique.values()) {
      const matches = input.checks.filter(c => c.headSha === pull.head_sha && (required.kind === "commit_status"
        ? c.kind === "commit_status" && c.name === required.context
        : c.kind === "check_run" && c.appId === required.app_id && c.workflowPath === required.workflow_path && c.name === required.job));
      // The adapter returns latest attempts. Multiple surviving observations are ambiguous;
      // require every one to succeed rather than selecting an arbitrary old green result.
      if (!matches.length) add("required_check_missing", "Required check missing; release-build-check.yml paths filtering can omit build for documentation-only PRs. Missing always blocks.", required);
      else for (const check of matches) {
        if (check.status !== "completed" || check.conclusion !== "success") add("required_check_not_success", "Required check is not completed/success", { required, check });
      }
    }
    if (!input.actors.some(a => a.action === "create")) add("cr_ownership_unknown", "CR was not created through the platform; creator ownership cannot be established");
    {
      const latest = new Map<string, ScmStructuredReview>();
      for (const review of input.reviews) {
        if (review.policy_revision !== policy.revision || !samePull(review, pull) || !independentActor(review.reviewer, policy, input.actors)) continue;
        const key = `${review.reviewer.kind}:${review.reviewer.id}`;
        if ((latest.get(key)?.sequence ?? -1) < review.sequence) latest.set(key, review);
      }
      review_evidence.push(...[...latest.values()].map(r => ({ review_id: r.id, attestation: r.reviewer.kind === "member" ? "member_attested" as const : "agent_independent" as const })));
      if ([...latest.values()].some(r => r.verdict === "block")) add("review_blocked", "A current eligible reviewer blocks this revision", [...latest.values()].filter(r => r.verdict === "block").map(r => r.id));
      if (policy.require_independent_review && ![...latest.values()].some(r => r.verdict === "pass")) add("independent_review_missing", "At least one current Agent-independent or member-attested pass review is required");
    }
    if (policy.require_human_approval && !input.operationApprovalValid) add("human_approval_required", "An operation-bound member approval is required; preflight cannot grant approval");
    if (policy.credential_enforcement_mode === "strict") {
      if (!input.protectionProof) add("credential_enforcement_unavailable", "Live credential protection proof is required");
      else reasons.push(...input.protectionProof.reasons);
      if (input.protectionProof && !input.protectionProof.proven && !input.protectionProof.reasons.length) add("credential_enforcement_unavailable", "Protection is unproven");
    }
  }
  return { allowed: reasons.length === 0, reasons, preflight_only: true, execution_authorized: false,
    credential_boundary: policy.enabled && policy.credential_enforcement_mode === "strict" && input.protectionProof?.proven ? "平台入口受控、直推已由仓库保护封闭（实时证明）" : "平台入口受控、直推未封闭",
    ...(input.protectionProof ? { protection_proof: input.protectionProof } : {}), policy, review_evidence, ref_write_rules: input.ref_write_rules ?? [] };
}
