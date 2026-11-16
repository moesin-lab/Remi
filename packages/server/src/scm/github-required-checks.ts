import type { RequiredMergeCheck } from "@multiremi/contracts/merge-policy.js";
import { ScmOperationError } from "./operations.js";
export interface RepositoryCheckRule { context: string; appId: number | null }
export interface RepositoryRules { checks: RepositoryCheckRule[] }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ScmOperationError("repository_rules_incomplete", "Incomplete repository rule response");
  return value as Record<string, unknown>;
}
/** Branch protection + effective branch rules (including inherited rulesets).
 * Unknown semantics must never be silently treated as an empty requirement. */
export async function readGitHubRequiredChecks(
  request: (path: string) => Promise<unknown>, pages: (path: string) => Promise<Record<string, unknown>[]>, target: string,
): Promise<RepositoryRules> {
  const branch = encodeURIComponent(target);
  const info = object(await request(`/branches/${branch}`));
  if (info.name !== target || typeof info.protected !== "boolean") throw new ScmOperationError("repository_rules_incomplete", "Provider omitted target branch protection identity");
  const rules = await pages(`/rules/branches/${branch}`);
  const checks: RepositoryCheckRule[] = [];
  function add(value: unknown, appKey: string) {
    const check = object(value);
    const app = check[appKey];
    if (typeof check.context !== "string" || !check.context.trim() || !(app === null || Number.isSafeInteger(app) && Number(app) > 0)) {
      throw new ScmOperationError("repository_rules_unsupported", "Required check lacks a supported context/app binding");
    }
    checks.push({ context: check.context, appId: app as number | null });
  }
  if (info.protected) {
    // A 404 is ambiguous (missing permission vs ruleset-only protection): fail closed.
    const protection = object(await request(`/branches/${branch}/protection`));
    for (const [key, value] of Object.entries(protection)) {
      if (["url", "required_status_checks", "enforce_admins", "allow_deletions", "allow_force_pushes", "block_creations", "lock_branch", "required_conversation_resolution"].includes(key)) {
        if (["lock_branch", "required_conversation_resolution"].includes(key) && object(value).enabled !== false) throw new ScmOperationError("repository_rules_unsupported", `Unsupported branch protection: ${key}`);
        continue;
      }
      if (value !== null && value !== false && !(typeof value === "object" && !Array.isArray(value) && object(value).enabled === false)) throw new ScmOperationError("repository_rules_unsupported", `Unsupported branch protection: ${key}`);
    }
    if (!("required_status_checks" in protection)) throw new ScmOperationError("repository_rules_incomplete", "Provider omitted required_status_checks");
    if (protection.required_status_checks !== null) {
      const required = object(protection.required_status_checks);
      if (!Array.isArray(required.checks) || !Array.isArray(required.contexts) || typeof required.strict !== "boolean") throw new ScmOperationError("repository_rules_incomplete", "Provider omitted required check bindings");
      // Up-to-date branch semantics require execution-time ancestry validation; B1 cannot claim support.
      if (required.strict) throw new ScmOperationError("repository_rules_unsupported", "Strict up-to-date branch checks are not yet verified");
      required.checks.forEach(c => add(c, "app_id"));
      if (required.contexts.some(c => !checks.some(check => check.context === c))) throw new ScmOperationError("repository_rules_incomplete", "Legacy contexts lack identity bindings");
    }
  }
  for (const raw of rules) {
    const rule = object(raw);
    if (rule.type !== "required_status_checks") throw new ScmOperationError("repository_rules_unsupported", `Unsupported effective rule: ${String(rule.type)}`);
    const params = object(rule.parameters);
    if (Object.keys(params).some(k => !["required_status_checks", "strict_required_status_checks_policy", "do_not_enforce_on_create"].includes(k))) throw new ScmOperationError("repository_rules_unsupported", "Unknown required-check rule parameters");
    if (!Array.isArray(params.required_status_checks) || typeof params.strict_required_status_checks_policy !== "boolean") throw new ScmOperationError("repository_rules_incomplete", "Incomplete effective check rule");
    if (params.strict_required_status_checks_policy) throw new ScmOperationError("repository_rules_unsupported", "Strict up-to-date branch checks are not yet verified");
    params.required_status_checks.forEach(c => add(c, "integration_id"));
  }
  return { checks };
}
/** Repository rules do not carry workflow paths. An app-bound rule needs an
 * explicit project binding to establish that missing identity; never guess by name. */
export function resolveRepositoryChecks(rules: RepositoryRules, project: RequiredMergeCheck[]): RequiredMergeCheck[] {
  return rules.checks.map(rule => {
    if (rule.appId === null) return { kind: "commit_status" as const, context: rule.context };
    const matches = project.filter((c): c is Extract<RequiredMergeCheck, { kind: "check_run" }> => c.kind === "check_run" && c.app_id === rule.appId && c.job === rule.context);
    if (!matches.length) throw new ScmOperationError("repository_check_identity_missing", `Repository required check ${rule.context} needs app/workflow/job identity in project policy`);
    // More than one workflow with the same protected context must all pass.
    return matches;
  }).flat();
}
