import { isHumanOperatorRequest } from "../wire/index.js";
import { registerMergeExecutionRoutes } from "./merge-execution.js";
import { registerMergePolicyRoutes, scmRequestActor } from "./merge-policy.js";
import type { Context, Hono } from "hono";
import type {
  CreateScmConnectionInput,
  MultiremiScmCanonicalEventType,
  MultiremiScmChangeRequestWithRepository,
  UpdateScmConnectionInput,
} from "@multiremi/contracts/types.js";
import { ScmCredentialEncryptionError } from "@multiremi/scm/credentials.js";
import type { CreateScmPullRequestInput, UpdateScmPullRequestInput } from "@multiremi/contracts/scm-operations.js";
import { GitHubScmOperations, ScmOperationError } from "@multiremi/scm/operations.js";
import { ScmHttpError } from "@multiremi/scm/http.js";
import { reconcileObservation } from "@multiremi/scm/reconcile.js";
import { scmIngestionStore } from "@multiremi/scm/store.js";
import type { ScmEntityObservation } from "@multiremi/scm/types.js";
import {
  denyCurrentUserWorkspaceAccess,
  isJsonApiError,
  publishWorkspaceEvent,
  readJsonStrict,
  readJsonStrictAllowEmpty,
  requireWorkspaceAdmin,
} from "../helpers.js";
import { listWorkspaceRepositories } from "../helpers/repositories.js";
import type { RouterDeps } from "./deps.js";

export function registerScmRoutes(app: Hono, deps: RouterDeps): void {
  const { store } = deps;
  registerMergePolicyRoutes(app, deps);
  registerMergeExecutionRoutes(app, deps);
  const activeRoot = "/api/workspaces/:workspaceId/scm/repositories/:repositoryId/change-requests";

  app.post(activeRoot, async (c) => {
    const loaded = loadOperations(c, deps);
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<CreateScmPullRequestInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const result = await loaded.operations.create(body);
      loaded.record(result.observation);
      if (!result.reused) loaded.recordActor(result.observation, "create");
      return c.json({ pullRequest: result.observation.payload, reused: result.reused }, result.reused ? 200 : 201);
    } catch (error) { return scmErrorResponse(c, error); }
  });

  app.get(`${activeRoot}/:number`, async (c) => {
    const loaded = loadOperations(c, deps);
    if (loaded instanceof Response) return loaded;
    try {
      const observation = await loaded.operations.get(Number(c.req.param("number")));
      loaded.record(observation);
      return c.json({ pullRequest: observation.payload });
    } catch (error) { return scmErrorResponse(c, error); }
  });

  app.patch(`${activeRoot}/:number`, async (c) => {
    const loaded = loadOperations(c, deps);
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrict<UpdateScmPullRequestInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const observation = await loaded.operations.update(Number(c.req.param("number")), body);
      loaded.record(observation);
      loaded.recordActor(observation, "update");
      return c.json({ pullRequest: observation.payload });
    } catch (error) { return scmErrorResponse(c, error); }
  });

  app.get(`${activeRoot}/:number/checks`, async (c) => {
    const loaded = loadOperations(c, deps);
    if (loaded instanceof Response) return loaded;
    try {
      const number = Number(c.req.param("number"));
      const before = await loaded.operations.get(number);
      const summary = await loaded.operations.checks(String(before.payload.head_sha));
      const after = await loaded.operations.get(number);
      if (before.payload.head_sha !== after.payload.head_sha || before.payload.base_sha !== after.payload.base_sha
        || before.payload.target_branch !== after.payload.target_branch
        || before.payload.base_repository_full_name !== after.payload.base_repository_full_name) {
        return c.json({ error: "Pull request changed while reading checks", code: "scm_head_changed" }, 409);
      }
      return c.json({ summary });
    } catch (error) { return scmErrorResponse(c, error); }
  });

  app.get("/api/issues/:id/change-requests", (c) => {
    const issue = store.getIssue(c.req.param("id"));
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    const bindings = new Map(
      store.listScmRepositoryBindings({ workspaceId: issue.workspaceId })
        .map((binding) => [binding.repositoryId, binding] as const),
    );
    const changeRequests: MultiremiScmChangeRequestWithRepository[] =
      (store.listScmChangeRequestsForIssue(issue.id) ?? []).map((changeRequest) => {
        const binding = bindings.get(changeRequest.repositoryId);
        return {
          ...changeRequest,
          repositoryName: binding?.name ?? null,
          repositoryOwner: binding?.owner ?? null,
          repositoryUrl: binding?.repositoryUrl ?? null,
        };
      });
    return c.json({ changeRequests, total: changeRequests.length });
  });

  app.put("/api/issues/:issueId/change-requests/:changeRequestId", (c) => {
    const issue = store.getIssue(c.req.param("issueId"));
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    try {
      return c.json(store.linkScmChangeRequestToIssue(issue.id, c.req.param("changeRequestId")));
    } catch (error) {
      return scmErrorResponse(c, error);
    }
  });

  app.delete("/api/issues/:issueId/change-requests/:changeRequestId", (c) => {
    const issue = store.getIssue(c.req.param("issueId"));
    if (!issue) return c.json({ error: "issue not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, issue.workspaceId);
    if (denied) return denied;
    if (!store.unlinkScmChangeRequestFromIssue(issue.id, c.req.param("changeRequestId"))) {
      return c.json({ error: "SCM change request link not found" }, 404);
    }
    return c.body(null, 204);
  });

  app.get("/api/workspaces/:workspaceId/scm/connections", (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const connections = store.listScmConnectionsWithRepositories({ workspaceId });
    return c.json({ connections, total: connections.length });
  });

  app.post("/api/workspaces/:workspaceId/scm/connections", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId)
      ?? requireWorkspaceAdmin(c, store, workspaceId);
    if (denied) return denied;
    const body = await readJsonStrict<CreateScmConnectionInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      if (workspaceId === "local") store.ensureLocalWorkspace();
      const connection = store.createScmConnection({ ...body, workspaceId });
      publishWorkspaceEvent(c, store, "scm:connection_created", workspaceId, { connection });
      return c.json({ connection }, 201);
    } catch (error) {
      return scmErrorResponse(c, error);
    }
  });

  app.get("/api/workspaces/:workspaceId/scm/connections/:connectionId", (c) => {
    const loaded = loadConnection(c, deps);
    if (loaded instanceof Response) return loaded;
    return c.json({ connection: loaded.connection });
  });

  app.patch("/api/workspaces/:workspaceId/scm/connections/:connectionId", async (c) => {
    const loaded = loadConnection(c, deps, true);
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrictAllowEmpty<UpdateScmConnectionInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      if (["mergeCredential", "clearMergeCredential", "mergeCredentialKind"].some(key => key in body) && !isHumanOperatorRequest(c)) return c.json({ code: "merge_credential_member_required", error: "Only members may write merge credentials" }, 403);
      const connection = store.updateScmConnection(loaded.connection.id, body);
      publishWorkspaceEvent(c, store, "scm:connection_updated", loaded.connection.workspaceId, { connection });
      return c.json({ connection });
    } catch (error) {
      return scmErrorResponse(c, error);
    }
  });

  app.delete("/api/workspaces/:workspaceId/scm/connections/:connectionId", (c) => {
    const loaded = loadConnection(c, deps, true);
    if (loaded instanceof Response) return loaded;
    try {
      if (!store.deleteScmConnection(loaded.connection.id)) return c.json({ error: "SCM connection not found" }, 404);
      publishWorkspaceEvent(c, store, "scm:connection_deleted", loaded.connection.workspaceId, {
        connectionId: loaded.connection.id,
      });
      return c.body(null, 204);
    } catch (error) {
      return scmErrorResponse(c, error);
    }
  });

  app.post("/api/workspaces/:workspaceId/scm/connections/:connectionId/verify", async (c) => {
    const loaded = loadConnection(c, deps, true);
    if (loaded instanceof Response) return loaded;
    try {
      const started = store.markScmConnectionVerificationStarted(loaded.connection.id);
      const credential = store.getScmConnectionCredential(loaded.connection.id);
      if (!credential) return c.json({ error: "SCM connection not found" }, 404);
      const bindings = store.listScmRepositoryBindings({ connectionId: loaded.connection.id, enabled: true });
      let result;
      try {
        result = await deps.verifyScmConnection({
          connection: started.connection,
          credential,
          bindings,
        });
      } catch {
        result = {
          status: "unreachable" as const,
          verifiedAt: new Date().toISOString(),
          identity: null,
          repositoryCount: 0,
          repositoryTotal: bindings.length,
          errorCode: "verification_failed",
          error: "验证请求失败，请稍后重试",
        };
      }
      const connection = store.recordScmConnectionVerification(
        loaded.connection.id,
        result,
        started.runId,
      );
      publishWorkspaceEvent(c, store, "scm:connection_verified", loaded.connection.workspaceId, { connection });
      return c.json({ connection });
    } catch (error) {
      return scmErrorResponse(c, error);
    }
  });

  app.put("/api/workspaces/:workspaceId/scm/connections/:connectionId/repositories/:repositoryId", async (c) => {
    const loaded = loadConnection(c, deps, true);
    if (loaded instanceof Response) return loaded;
    const body = await readJsonStrictAllowEmpty<{
      externalId?: string | null;
      external_id?: string | null;
      owner?: string | null;
      enabled?: boolean;
      transfer?: boolean;
    }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try {
      const repository = listWorkspaceRepositories(store, loaded.connection.workspaceId)
        .find((candidate) => candidate.id === c.req.param("repositoryId"));
      if (!repository) return c.json({ error: "repository not found" }, 404);
      const binding = store.upsertScmRepositoryBinding({
        workspaceId: loaded.connection.workspaceId,
        connectionId: loaded.connection.id,
        repositoryId: repository.id,
        repositoryUrl: repository.url,
        repositorySource: repository.source,
        name: repository.name,
        defaultBranch: repository.default_branch,
        externalId: body.externalId ?? body.external_id,
        owner: body.owner,
        enabled: body.enabled,
        assignmentOrigin: "explicit",
        transfer: body.transfer,
      });
      publishWorkspaceEvent(c, store, "scm:repository_bound", loaded.connection.workspaceId, { binding });
      return c.json({ connection: store.getScmConnectionWithRepositories(loaded.connection.id) });
    } catch (error) {
      return scmErrorResponse(c, error);
    }
  });

  app.delete("/api/workspaces/:workspaceId/scm/connections/:connectionId/repositories/:repositoryId", (c) => {
    const loaded = loadConnection(c, deps, true);
    if (loaded instanceof Response) return loaded;
    const deleted = store.deleteScmRepositoryBinding(loaded.connection.id, c.req.param("repositoryId"));
    if (!deleted) return c.json({ error: "repository binding not found" }, 404);
    publishWorkspaceEvent(c, store, "scm:repository_unbound", loaded.connection.workspaceId, {
      connectionId: loaded.connection.id,
      repositoryId: c.req.param("repositoryId"),
    });
    return c.body(null, 204);
  });

  app.get("/api/workspaces/:workspaceId/scm/events", (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const type = cleanQuery(c.req.query("type")) as MultiremiScmCanonicalEventType | null;
    const limit = eventPageLimit(c.req.query("limit"));
    try {
      const rows = store.listScmCanonicalEvents({
        workspaceId,
        connectionId: cleanQuery(c.req.query("connectionId") ?? c.req.query("connection_id")),
        repositoryId: cleanQuery(c.req.query("repositoryId") ?? c.req.query("repository_id")),
        type,
        after: cleanQuery(c.req.query("after")),
        limit: limit + 1,
      });
      const hasMore = rows.length > limit;
      const events = hasMore ? rows.slice(0, limit) : rows;
      return c.json({
        events,
        total: events.length,
        nextAfter: hasMore ? events.at(-1)?.id ?? null : null,
      });
    } catch (error) {
      return scmErrorResponse(c, error);
    }
  });

  app.get("/api/workspaces/:workspaceId/scm/events/:eventId", (c) => {
    const workspaceId = c.req.param("workspaceId");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const event = store.getScmCanonicalEvent(c.req.param("eventId"));
    if (!event || event.workspaceId !== workspaceId) return c.json({ error: "SCM event not found" }, 404);
    return c.json({ event, evidence: store.listScmEventEvidence(event.id) });
  });
}

function loadOperations(c: Context, deps: RouterDeps): {
  operations: GitHubScmOperations;
  record: (observation: ScmEntityObservation) => void;
  recordActor: (observation: ScmEntityObservation, action: "create" | "update") => void;
} | Response {
  const workspaceId = c.req.param("workspaceId") ?? "";
  const denied = denyCurrentUserWorkspaceAccess(c, deps.store, workspaceId);
  if (denied) return denied;
  const binding = deps.store.listScmRepositoryBindings({ workspaceId, enabled: true })
    .find(item => item.repositoryId === c.req.param("repositoryId"));
  if (!binding) return c.json({ error: "SCM repository binding not found" }, 404);
  const connection = deps.store.getScmConnection(binding.connectionId);
  if (!connection || !connection.enabled) return c.json({ error: "SCM connection unavailable" }, 409);
  try {
    if (connection.provider !== "github") throw new ScmOperationError("scm_capability_unavailable", "Active SCM operations are not verified for this provider");
    const credential = deps.store.getScmConnectionCredential(connection.id);
    if (!credential) return c.json({ error: "SCM credentials unavailable" }, 503);
    return {
      operations: new GitHubScmOperations({ connection, binding, credential, signal: c.req.raw.signal }),
      recordActor: (observation, action) => {
        const cr = deps.store.mergePolicies.findChangeRequest(connection.id, binding.repositoryId, observation.externalId);
        const actor = scmRequestActor(c, deps, workspaceId);
        if (cr && actor) deps.store.mergePolicies.recordActor(cr.id, action, actor);
      },
      record: observation => {
        reconcileObservation({ store: scmIngestionStore(deps.store), binding, observation, baseline: false });
      },
    };
  } catch (error) { return scmErrorResponse(c, error); }
}

function loadConnection(c: Context, deps: RouterDeps, requireAdmin = false): {
  connection: NonNullable<ReturnType<RouterDeps["store"]["getScmConnectionWithRepositories"]>>;
} | Response {
  const workspaceId = c.req.param("workspaceId") ?? "";
  const denied = denyCurrentUserWorkspaceAccess(c, deps.store, workspaceId)
    ?? (requireAdmin ? requireWorkspaceAdmin(c, deps.store, workspaceId) : null);
  if (denied) return denied;
  const connection = deps.store.getScmConnectionWithRepositories(c.req.param("connectionId") ?? "");
  if (!connection || connection.workspaceId !== workspaceId) return c.json({ error: "SCM connection not found" }, 404);
  return { connection };
}

function cleanQuery(value: string | undefined): string | null {
  return value?.trim() || null;
}

function eventPageLimit(value: string | undefined): number {
  const parsed = Number(value ?? 50);
  if (!Number.isFinite(parsed)) return 50;
  return Math.max(1, Math.min(200, Math.floor(parsed)));
}

function scmErrorResponse(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ScmOperationError) {
    const status = error.code === "scm_capability_unavailable" ? 501
      : /conflict|ambiguous/u.test(error.code) ? 409 : 400;
    return c.json({ error: message, code: error.code }, status);
  }
  if (error instanceof ScmHttpError) {
    return c.json({ error: "SCM provider request failed", code: "scm_provider_error", providerStatus: error.status }, 502);
  }
  if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
    return c.json({ error: "SCM request interrupted; read provider state before retrying a write", code: "scm_operation_unknown" }, 504);
  }
  if (error instanceof ScmCredentialEncryptionError) {
    return c.json({ error: message, code: error.code }, 503);
  }
  if (/already exists|already bound|changed while|UNIQUE constraint|duplicate key/iu.test(message)) {
    return c.json({ error: message }, 409);
  }
  if (/not found/iu.test(message)) return c.json({ error: message }, 404);
  if (/event history/iu.test(message)) return c.json({ error: message }, 409);
  return c.json({ error: message }, 400);
}
