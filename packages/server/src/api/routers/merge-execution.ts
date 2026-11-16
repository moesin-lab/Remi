import type { Hono, Context } from 'hono';
import type { RouterDeps } from './deps.js';
import { scmRequestActor } from './merge-policy.js';
import { MergeExecutionService } from '@multiremi/scm/merge-execution.js';
import { ScmOperationError } from '@multiremi/scm/operations.js';
import { denyCurrentUserWorkspaceAccess, isJsonApiError, readJsonStrict } from '../helpers.js';
export function registerMergeExecutionRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps, service = new MergeExecutionService(store);
  function error(c: Context, e: unknown) {
    if (e instanceof ScmOperationError) return c.json({ code: e.code, error: e.message }, /conflict|in_progress|disabled|unroutable/.test(e.code) ? 409 : 400);
    return c.json({ code: 'scm_evidence_unavailable', error: 'Cannot verify SCM evidence' }, 502);
  }
  app.post('/api/projects/:id/change-requests/:changeRequestId/merge', async c => {
    const project = store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'project not found' }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, project.workspaceId); if (denied) return denied;
    const actor = scmRequestActor(c, deps, project.workspaceId);
    if (!actor) return c.json({ code: 'merge_actor_required', error: 'Member or Task authentication required' }, 403);
    const cr = store.getScmChangeRequest(c.req.param('changeRequestId'));
    if (!cr || cr.workspaceId !== project.workspaceId || !store.mergePolicies.belongsToProject(project.id, cr.id)) return c.json({ error: 'CR must be linked to this project' }, 404);
    const body = await readJsonStrict<unknown>(c); if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const operation = await service.request(project.id, cr.id, actor, body);
      const code = operation.state === 'blocked' ? operation.reasons.some(r => r.code === 'merge_approval_unroutable') ? 'merge_approval_unroutable' : 'merge_gate_blocked' : undefined;
      return c.json({ operation, operation_id: operation.id, approval_message_id: operation.approval_message_id, credential_boundary: operation.credential_boundary,
        ...(code ? { code, reasons: operation.reasons } : {}) }, code ? 409 : ['awaiting_human','requested','approved','executing','unknown'].includes(operation.state) ? 202 : 200);
    } catch (e) { return error(c, e); }
  });
  app.get('/api/scm/merge-operations/:id', c => {
    const operation = store.mergeOperations.get(c.req.param('id'));
    if (!operation) return c.json({ error: 'merge operation not found' }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, operation.workspace_id); if (denied) return denied;
    if (!scmRequestActor(c, deps, operation.workspace_id)) return c.json({ error: 'Member or Task authentication required' }, 403);
    return c.json({ operation });
  });
}
