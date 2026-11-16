import { readLiveMergeGate } from "@multiremi/scm/live-merge-gate.js";
import type { Context, Hono } from "hono";
import type { ScmActor } from "@multiremi/contracts/merge-policy.js";
import { GitHubScmOperations, ScmOperationError } from "@multiremi/scm/operations.js";
import { evaluateMergeGate, independentActor, pullIdentity } from "@multiremi/scm/merge-gate.js";
import { validateReview } from "@multiremi/scm/merge-policy.js";
import { currentAccessToken, currentWorkspaceMember, isHumanOperatorRequest } from "../wire/index.js";
import { denyCurrentUserWorkspaceAccess, isJsonApiError, readJsonStrict } from "../helpers.js";
import type { RouterDeps } from "./deps.js";
export function scmRequestActor(c: Context, deps: RouterDeps, workspaceId: string): ScmActor | null {
  const token = currentAccessToken(c);
  if (token?.type === "task") {
    const task = token.taskId ? deps.store.getTask(token.taskId) : null;
    if (!task || !token.agentId || task.agentId !== token.agentId || task.workspaceId !== workspaceId) return null;
    return { kind: "agent", id: token.agentId, turn_id: task.id };
  }
  if (!isHumanOperatorRequest(c)) return null;
  const member = currentWorkspaceMember(c, deps.store, workspaceId);
  return member ? { kind: "member", id: member.id, turn_id: null } : null;
}
function errorResponse(c: Context, error: unknown): Response {
  if (error instanceof ScmOperationError) return c.json({ code: error.code, error: error.message }, /conflict|changed/u.test(error.code) ? 409 : /forbidden/u.test(error.code) ? 403 : 400);
  return c.json({ code: "scm_provider_error", error: "Unable to verify live SCM evidence" }, 502);
}
export function registerMergePolicyRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;
  function project(c: Context) {
    const row = store.getProject(c.req.param("id") ?? "");
    if (!row) return c.json({ error: "project not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, row.workspaceId);
    return denied ?? row;
  }
  app.get("/api/projects/:id/merge-policy", c => {
    const row = project(c); if (row instanceof Response) return row;
    return c.json({ policy: store.mergePolicies.get(row.id) });
  });
  app.put("/api/projects/:id/merge-policy", async c => {
    const row = project(c); if (row instanceof Response) return row;
    const actor = scmRequestActor(c, deps, row.workspaceId);
    if (actor?.kind !== "member") return c.json({ error: "Only members may write merge policy", code: "merge_policy_member_required" }, 403);
    const body = await readJsonStrict<unknown>(c); if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try { return c.json({ policy: store.mergePolicies.put(row.id, body, actor.id) }); }
    catch (error) { return errorResponse(c, error); }
  });
  function load(c: Context) {
    const row = project(c); if (row instanceof Response) return row;
    const cr = store.getScmChangeRequest(c.req.param("changeRequestId") ?? "");
    if (!cr || cr.workspaceId !== row.workspaceId || !store.mergePolicies.belongsToProject(row.id, cr.id)) return c.json({ error: "CR must be linked to an Issue in this project" }, 404);
    return { project: row, cr };
  }
  function operations(cr: NonNullable<ReturnType<typeof store.getScmChangeRequest>>, signal: AbortSignal) {
    const binding = store.listScmRepositoryBindings({ workspaceId: cr.workspaceId, enabled: true }).find(b => b.connectionId === cr.connectionId && b.repositoryId === cr.repositoryId);
    const connection = store.getScmConnection(cr.connectionId);
    const credential = store.getScmConnectionCredential(cr.connectionId);
    if (!binding || !connection || !credential) throw new ScmOperationError("scm_binding_unavailable", "SCM binding or credentials unavailable");
    return new GitHubScmOperations({ binding, connection, credential, signal });
  }
  const root = "/api/projects/:id/change-requests/:changeRequestId";
  app.get(`${root}/reviews`, c => {
    const loaded = load(c); if (loaded instanceof Response) return loaded;
    return c.json({ reviews: store.mergePolicies.list(loaded.project.id, loaded.cr.id) });
  });
  app.post(`${root}/reviews`, async c => {
    const loaded = load(c); if (loaded instanceof Response) return loaded;
    const actor = scmRequestActor(c, deps, loaded.project.workspaceId);
    if (!actor) return c.json({ error: "Authenticated reviewer required", code: "reviewer_forbidden" }, 403);
    const body = await readJsonStrict<unknown>(c); if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const review = validateReview(body);
      const policy = store.mergePolicies.get(loaded.project.id);
      if (!independentActor(actor, policy, store.mergePolicies.actors(loaded.cr.id))) throw new ScmOperationError("reviewer_forbidden", "Reviewer is not independent/allowlisted or CR ownership is unknown");
      const live = await operations(loaded.cr, c.req.raw.signal).get(loaded.cr.number!);
      const identity = pullIdentity(live.payload);
      if (live.externalId !== loaded.cr.externalId || !identity || review.head_sha !== identity.head_sha || review.base_sha !== identity.base_sha) throw new ScmOperationError("scm_pull_request_changed", "Review must reference current head/base and PR identity");
      return c.json({ review: store.mergePolicies.append({ ...review, ...identity, project_id: loaded.project.id, change_request_id: loaded.cr.id,
        policy_revision: policy.revision, reviewer: actor }) }, 201);
    } catch (error) { return errorResponse(c, error); }
  });
  app.get(`${root}/merge-gate`, async c => {
    const loaded = load(c); if (loaded instanceof Response) return loaded;
    const policy = store.mergePolicies.get(loaded.project.id);
    if (!policy.enabled) return c.json(evaluateMergeGate({ policy, pull: { head_sha: "", base_sha: "", target_branch: "", base_repository_full_name: "" }, checks: [], required: [], reviews: [], actors: [] }));
    try {
      const op = operations(loaded.cr, c.req.raw.signal);
      return c.json((await readLiveMergeGate(store, loaded.project.id, loaded.cr, op, policy)).gate);
    } catch (error) {
      return c.json({ allowed: false, reasons: [{ code: "scm_evidence_unavailable", message: error instanceof ScmOperationError ? error.message : "Cannot verify live PR" }], preflight_only: true, execution_authorized: false, credential_boundary: "平台入口受控、直推未封闭", policy, review_evidence: [], ref_write_rules: [] });
    }
  });
}
