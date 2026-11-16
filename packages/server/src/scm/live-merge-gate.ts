import { mergerOperations, readProtectionProof } from "./credential-boundary.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import type { ProjectMergePolicy } from "@multiremi/contracts/merge-policy.js";
import { GitHubScmOperations, ScmOperationError } from "./operations.js";
import { evaluateMergeGate, pullIdentity, samePull, type PullIdentity } from "./merge-gate.js";
import { resolveRepositoryChecks } from "./github-required-checks.js";
export async function readLiveMergeGate(store: MultiremiStore, projectId: string, cr: NonNullable<ReturnType<MultiremiStore["getScmChangeRequest"]>>, op: GitHubScmOperations, policy: ProjectMergePolicy, operationApprovalValid: false | ((identity: PullIdentity) => boolean) = false) {
  const before = await op.get(cr.number!);
  const identity = pullIdentity(before.payload);
  if (!identity || before.externalId !== cr.externalId) throw new ScmOperationError("scm_evidence_mismatch", "Provider omitted or mismatched PR identity");
  const binding = store.listScmRepositoryBindings({ workspaceId: cr.workspaceId, enabled: true }).find(b => b.connectionId === cr.connectionId && b.repositoryId === cr.repositoryId);
  if (!binding) throw new ScmOperationError("scm_binding_unavailable", "SCM binding unavailable");
  const coverage = store.mergePolicies.strictForRepository(cr.workspaceId, cr.repositoryId);
  const protectionProof = policy.credential_enforcement_mode === "strict" ? await readProtectionProof(store, binding, policy) : undefined;
  const reasons = [];
  let required = policy.required_checks;
  let ref_write_rules: Awaited<ReturnType<typeof op.requiredChecks>>["ref_write_rules"] = [];
  try {
    const rules = await mergerOperations(store, binding).requiredChecks(identity.target_branch);
    ref_write_rules = rules.ref_write_rules;
    required = [...required, ...resolveRepositoryChecks(rules, required)];
  } catch (error) {
    reasons.push({ code: error instanceof ScmOperationError ? ["scm_evidence_incomplete", "scm_invalid_response"].includes(error.code) ? "repository_rules_incomplete" : error.code : "repository_rules_unavailable", message: "Could not completely verify effective repository rules", evidence: error instanceof ScmOperationError ? error.message : undefined });
  }
  let checks: Awaited<ReturnType<typeof op.checks>>["checks"] = [];
  try { checks = await op.gateChecks(identity.head_sha); }
  catch { reasons.push({ code: "checks_unavailable", message: "Could not completely verify live checks" }); }
  const after = await op.get(cr.number!);
  const finalIdentity = pullIdentity(after.payload);
  if (!finalIdentity || after.externalId !== cr.externalId || !samePull(identity, finalIdentity)) reasons.push({ code: "pull_request_changed", message: "PR changed while evaluating gate" });
  if (JSON.stringify(coverage) !== JSON.stringify(store.mergePolicies.strictForRepository(cr.workspaceId, cr.repositoryId))) reasons.push({ code: "protection_coverage_changed", message: "Strict coverage changed while evaluating gate" });
  if (policy.revision !== store.mergePolicies.get(projectId).revision) reasons.push({ code: "policy_changed", message: "Policy changed while evaluating gate" });
  if (after.payload.state !== "open" || after.payload.draft === true) reasons.push({ code: "pull_request_not_mergeable", message: "PR must be open and ready for review" });
  const gate = evaluateMergeGate({ policy, pull: identity, required, checks,
    reviews: store.mergePolicies.list(projectId, cr.id), actors: store.mergePolicies.actors(cr.id), reasons, protectionProof, ref_write_rules, operationApprovalValid: operationApprovalValid ? operationApprovalValid(identity) : false });
  return { gate, identity, observation: after };
}
