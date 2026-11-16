import type { MergeGateReason } from '@multiremi/contracts/merge-policy.js';
export interface ProtectionProof {
  proven: boolean;
  checked_at: string;
  reasons: MergeGateReason[];
  evidence: unknown;
}
export interface BranchProtectionEvidence {
  target: string;
  classic: Record<string, unknown> | null;
  restrictions: { users: Record<string, unknown>[]; teams: Record<string, unknown>[]; apps: Record<string, unknown>[] } | null;
  rules: Record<string, unknown>[];
  rulesets: Array<{ merger: Record<string, unknown>; task: Record<string, unknown> }>;
}
export interface ProtectionEvidence {
  task: { id: number; login: string };
  merger: { id: number; login: string };
  taskPermission: { permission: string; role_name: string };
  branches: BranchProtectionEvidence[];
}
const row = (x: unknown): Record<string, unknown> => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {};
/** Pure evaluator: never accepts client input; the reader supplies complete live API evidence.
 * Unknown fields with security semantics are rejected, not inferred from token text. */
export function evaluateProtection(evidence: ProtectionEvidence, targets: string[], checked_at = new Date().toISOString()): ProtectionProof {
  const reasons: MergeGateReason[] = [];
  const add = (code: string, message: string, target?: string) => reasons.push({ code, message, ...(target ? { evidence: { target } } : {}) });
  if (evidence.task.id === evidence.merger.id) add('credential_identity_not_separated', 'Task and merger resolve to the same provider identity');
  // Custom repository roles may contain protection administration capabilities. C1 does not guess them.
  if (evidence.taskPermission.permission === 'admin') add('task_identity_admin', 'Task identity has repository admin permissions');
  else if (!['none','read','write'].includes(evidence.taskPermission.permission) || !['none','read','triage','write','maintain'].includes(evidence.taskPermission.role_name)) add('protection_permissions_unsupported', 'Cannot prove task identity lacks protection administration capabilities');
  if (!targets.length) add('protection_evidence_incomplete', 'No target branches');
  for (const target of targets) {
    const b = evidence.branches.find(b => b.target === target);
    if (!b) { add('protection_evidence_incomplete', 'Missing target branch evidence', target); continue; }
    const p = b.classic;
    let checks = false, taskBlocked = false, noForce = false, noDelete = false;
    if (p) {
      const admin = row(p.enforce_admins).enabled === true;
      const required = row(p.required_status_checks);
      const entries = required.checks;
      if (Array.isArray(entries) && entries.length && admin) checks = true;
      if (Array.isArray(entries) && entries.length && !admin) add('protection_required_checks_bypassable', 'Classic required checks must enforce admins', target);
      const r = b.restrictions;
      if (r && admin) {
        // Teams/apps require additional membership/installation proofs; C1 token supports explicit users only.
        if (r.teams.length || r.apps.length || r.users.some(u => !Number.isSafeInteger(u.id))) add('protection_restrictions_unsupported', 'Classic restrictions require complete explicit-user bindings; teams/apps are not proven in C1', target);
        else taskBlocked = !r.users.some(u => u.id === evidence.task.id) && r.users.some(u => u.id === evidence.merger.id);
      }
      noForce = admin && row(p.allow_force_pushes).enabled === false;
      noDelete = admin && row(p.allow_deletions).enabled === false;
    }
    for (const rule of b.rules) {
      if (!['required_status_checks','creation','update','deletion','non_fast_forward'].includes(String(rule.type))) {
        add('protection_rules_unsupported', `Unsupported effective rule: ${String(rule.type)}`, target); continue;
      }
      const pair = b.rulesets.find(s => s.merger.id === rule.ruleset_id);
      if (!pair || !Array.isArray(pair.merger.bypass_actors) || pair.merger.enforcement !== 'active' || pair.task.enforcement !== 'active'
        || pair.task.id !== pair.merger.id || pair.merger.target !== 'branch') {
        add('protection_bypass_unreadable', 'Active ruleset and full bypass list must be readable', target); continue;
      }
      if (pair.merger.bypass_actors.some(actor => {
        const a = row(actor);
        return !["OrganizationAdmin","RepositoryRole","Team","Integration","DeployKey"].includes(String(a.actor_type))
          || !["always","pull_request","exempt"].includes(String(a.bypass_mode))
          || !(a.actor_id === null || Number.isSafeInteger(a.actor_id) && Number(a.actor_id) > 0);
      })) { add("protection_rules_unsupported", "Unknown bypass actor semantics", target); continue; }
      if (["creation","deletion","non_fast_forward"].includes(String(rule.type)) && rule.parameters != null && Object.keys(row(rule.parameters)).length) {
        add("protection_rules_unsupported", "Unexpected ref rule parameters", target); continue;
      }
      const taskBypass = pair.task.current_user_can_bypass, mergerBypass = pair.merger.current_user_can_bypass;
      if (!['never','always','pull_requests_only','exempt'].includes(String(taskBypass)) || !['never','always','pull_requests_only','exempt'].includes(String(mergerBypass))) {
        add('protection_bypass_unreadable', 'Provider omitted current identity bypass capabilities', target); continue;
      }
      // Provider computes effective membership/roles. Inspect both identities and retain full bypass actors.
      const enforced = taskBypass === 'never' && mergerBypass === 'never';
      if (rule.type === 'required_status_checks') {
        const params = row(rule.parameters);
        if (enforced && Array.isArray(params.required_status_checks) && params.required_status_checks.length) checks = true;
        else add('protection_required_checks_bypassable', 'Required-check ruleset must not be bypassable by either identity', target);
      }
      if (rule.type === 'update') {
        const params = row(rule.parameters);
        if (Object.keys(params).some(k => k !== 'update_allows_fetch_and_merge') || params.update_allows_fetch_and_merge !== false) add('protection_rules_unsupported', 'Update rule must explicitly disable fetch-and-merge', target);
        else if (taskBypass === 'never' && ['always','pull_requests_only'].includes(String(mergerBypass))) taskBlocked = true;
        else add('protection_task_can_update_target', 'Update restriction must deny task bypass and permit merger', target);
      }
      if (rule.type === 'non_fast_forward' && enforced) noForce = true;
      if (rule.type === 'deletion' && enforced) noDelete = true;
    }
    if (!checks) add('protection_required_checks_bypassable', 'No non-bypassable provider-required checks proven', target);
    if (!taskBlocked) add('protection_task_can_update_target', 'No ref update restriction excluding the task identity proven', target);
    if (!noForce) add('protection_force_push_allowed', 'Force-push prohibition not proven for both identities', target);
    if (!noDelete) add('protection_deletion_allowed', 'Branch deletion prohibition not proven for both identities', target);
  }
  return { proven: reasons.length === 0, checked_at, reasons, evidence };
}
