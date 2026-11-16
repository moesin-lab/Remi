import { readGitHubRequiredChecks } from "./github-required-checks.js";
import type { MultiremiStore } from '@multiremi/store/store.js';
import type { MultiremiScmRepositoryBinding } from '@multiremi/contracts/types.js';
import type { ProjectMergePolicy } from '@multiremi/contracts/merge-policy.js';
import { GitHubScmOperations, ScmOperationError } from './operations.js';
import { scmRequestJson, hasNextLink, ScmHttpError } from './http.js';
import { evaluateProtection, type ProtectionEvidence, type ProtectionProof } from './protection-proof.js';
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ScmOperationError('protection_evidence_incomplete', 'Invalid provider protection evidence');
  return value as Record<string, unknown>;
};
/** The only non-worker reader of the merger slot. No raw secret is returned to API callers.
 * C2 replaces token selection here with server-merger App issuance. */
export function mergerOperations(store: MultiremiStore, binding: MultiremiScmRepositoryBinding, signal?: AbortSignal): GitHubScmOperations {
  const connection = store.getScmConnection(binding.connectionId), task = store.getScmConnectionCredential(binding.connectionId);
  if (!connection?.enabled || !task) throw new ScmOperationError('scm_binding_unavailable', 'SCM connection unavailable');
  const merge = store.getScmMergeCredential(connection.id);
  return new GitHubScmOperations({ connection, binding, credential: { accessToken: merge ?? task.accessToken, webhookSecret: null }, signal });
}
/** No cache: every credential handout, preflight and worker execution re-proves all targets.
 * Credential and policy changes therefore invalidate evidence immediately. */
export async function readProtectionProof(store: MultiremiStore, binding: MultiremiScmRepositoryBinding, policy: ProjectMergePolicy): Promise<ProtectionProof> {
  const checked_at = new Date().toISOString();
  const credentialVersion = store.getScmCredentialVersion(binding.connectionId);
  const failure = (code: string, message: string): ProtectionProof => ({ proven: false, checked_at, reasons: [{ code, message }], evidence: { repository: binding.repositoryId, targets: policy.target_branches, policy_revision: policy.revision } });
  try {
    const connection = store.getScmConnection(binding.connectionId);
    if (connection?.provider !== 'github') return failure('scm_capability_unavailable', 'Strict credential proof is supported only for GitHub token identities');
    const merge = store.getScmMergeCredential(binding.connectionId);
    if (!merge) return failure('merge_credential_missing', 'Strict mode requires a server-merger credential');
    const task = store.getScmConnectionCredential(binding.connectionId)?.accessToken;
    if (!connection.enabled || !binding.enabled || !task || !binding.owner) return failure('protection_evidence_incomplete', 'Task credential or repository binding unavailable');
    const root = `/repos/${encodeURIComponent(binding.owner)}/${encodeURIComponent(binding.name)}`;
    const request = async (path: string, token: string) => scmRequestJson<unknown>(`${connection.apiBaseUrl.replace(/\/$/, '')}${path}`, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'multiremi-scm', Authorization: `Bearer ${token}` },
    });
    const get = async (path: string, token = merge) => object((await request(path, token)).data);
    const pages = async (path: string): Promise<Record<string, unknown>[]> => {
      const rows: Record<string, unknown>[] = [];
      for (let page = 1; page <= 100; page++) {
        const res = await request(`${root}${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, merge);
        if (!Array.isArray(res.data)) throw new ScmOperationError('protection_evidence_incomplete', 'Invalid protection page');
        rows.push(...res.data.map(object));
        if (!hasNextLink(res.headers.get('link'))) return rows;
      }
      throw new ScmOperationError('protection_pagination_incomplete', 'Protection pagination limit exceeded');
    };
    const identity = async (token: string) => {
      const user = await get('/user', token);
      if (!Number.isSafeInteger(user.id) || Number(user.id) <= 0 || typeof user.login !== 'string' || !user.login) throw new ScmOperationError('protection_identity_unavailable', 'Provider omitted token user identity');
      return { id: Number(user.id), login: user.login };
    };
    const taskIdentity = await identity(task), merger = await identity(merge);
    const permission = await get(`${root}/collaborators/${encodeURIComponent(taskIdentity.login)}/permission`);
    if (typeof permission.permission !== 'string' || typeof permission.role_name !== 'string' || object(permission.user).id !== taskIdentity.id) throw new ScmOperationError('protection_evidence_incomplete', 'Provider omitted task repository permission identity');
    const evidence: ProtectionEvidence = { task: taskIdentity, merger, taskPermission: { permission: permission.permission, role_name: permission.role_name }, branches: [] };
    for (const target of policy.target_branches) {
      const branch = encodeURIComponent(target);
      const info = await get(`${root}/branches/${branch}`);
      if (info.name !== target || info.protected !== true) throw new ScmOperationError('protection_evidence_incomplete', 'Target branch is not protected');
      let classic: Record<string, unknown> | null;
      try { classic = await get(`${root}/branches/${branch}/protection`); }
      catch (error) {
        // ruleset-only legacy 404 remains ambiguous: B1 still blocks it; never infer absence here.
        if (error instanceof ScmHttpError && error.status === 404) throw new ScmOperationError('protection_classic_unreadable', 'Classic protection absent or unreadable; ruleset-only protection is unsupported in C1');
        throw error;
      }
      await readGitHubRequiredChecks(path => get(`${root}${path}`), path => pages(path), target);
      const rules = await pages(`/rules/branches/${branch}`);
      let restrictions: ProtectionEvidence['branches'][number]['restrictions'] = null;
      if (classic.restrictions != null) restrictions = {
        users: await pages(`/branches/${branch}/protection/restrictions/users`),
        teams: await pages(`/branches/${branch}/protection/restrictions/teams`),
        apps: await pages(`/branches/${branch}/protection/restrictions/apps`),
      };
      const rulesets = [];
      for (const id of new Set(rules.map(r => r.ruleset_id))) {
        if (!Number.isSafeInteger(id) || Number(id) <= 0) throw new ScmOperationError('protection_evidence_incomplete', 'Effective rule omitted ruleset identity');
        const path = `${root}/rulesets/${id}?includes_parents=true`;
        let mergerRule, taskRule;
        try { mergerRule = await get(path); taskRule = await get(path, task); }
        catch { throw new ScmOperationError('protection_bypass_unreadable', 'Cannot read both identities ruleset bypass evidence'); }
        rulesets.push({ merger: mergerRule, task: taskRule });
      }
      evidence.branches.push({ target, classic, restrictions, rules, rulesets });
    }
    if (credentialVersion !== store.getScmCredentialVersion(binding.connectionId)) return failure("protection_credentials_changed", "Credentials changed during proof");
    return evaluateProtection(evidence, policy.target_branches, checked_at);
  } catch (error) {
    return failure(error instanceof ScmOperationError ? error.code : 'protection_read_failed', 'Cannot completely prove live repository protection');
  }
}
