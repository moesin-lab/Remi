import { expect, it } from 'bun:test';
import { evaluateProtection, type ProtectionEvidence } from '@multiremi/scm/protection-proof.js';
function rulesetEvidence(): ProtectionEvidence {
  const pair = (id: number, mergerBypass: string) => ({ merger: { id, target: 'branch', enforcement: 'active', current_user_can_bypass: mergerBypass,
    bypass_actors: mergerBypass === 'never' ? [] : [{ actor_type: 'RepositoryRole', actor_id: 5, bypass_mode: 'always' }] },
    task: { id, enforcement: 'active', current_user_can_bypass: 'never' } });
  return { task: { id: 1, login: 'task' }, merger: { id: 2, login: 'merger' }, taskPermission: { permission: 'write', role_name: 'write' }, branches: [{
    target: 'main', classic: null, restrictions: null, rules: [
      { type: 'update', ruleset_id: 10, parameters: { update_allows_fetch_and_merge: false } },
      { type: 'required_status_checks', ruleset_id: 20, parameters: { required_status_checks: [{ context: 'ci' }] } },
      { type: 'non_fast_forward', ruleset_id: 20 }, { type: 'deletion', ruleset_id: 20 },
    ], rulesets: [pair(10,'always'), pair(20,'never')],
  }] };
}
it('proves split rulesets only when update alone is bypassable by merger', () => {
  const result = evaluateProtection(rulesetEvidence(),['main']); expect(result.proven).toBe(true); expect(result.reasons).toEqual([]);
});
for (const condition of ['checks_bypass','unreadable','update_fetch','task_bypass','unknown_rule','unknown_actor','missing_target','custom_role'] as const) it(`fails closed: ${condition}`, () => {
  const e = rulesetEvidence(), branch = e.branches[0]!;
  if (condition === 'checks_bypass') branch.rulesets[1]!.merger.current_user_can_bypass = 'always';
  if (condition === 'unreadable') delete branch.rulesets[1]!.merger.bypass_actors;
  if (condition === 'update_fetch') branch.rules[0]!.parameters = { update_allows_fetch_and_merge: true };
  if (condition === 'task_bypass') branch.rulesets[0]!.task.current_user_can_bypass = 'pull_requests_only';
  if (condition === 'unknown_rule') branch.rules.push({ type: 'new_security_rule' });
  if (condition === 'unknown_actor') branch.rulesets[0]!.merger.bypass_actors = [{ actor_type: 'new_actor', actor_id: 9, bypass_mode: 'always' }];
  if (condition === 'custom_role') e.taskPermission.role_name = 'custom-admin-capabilities';
  expect(evaluateProtection(e,condition === 'missing_target' ? ['main','release'] : ['main']).proven).toBe(false);
});
