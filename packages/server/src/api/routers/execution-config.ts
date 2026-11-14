import type { Context, Hono } from "hono";
import type { RouterDeps } from "./deps.js";
import { parseEndpointConnection, type EndpointProtocol } from "@multiremi/contracts/execution-endpoint.js";
import { inspectEndpoint } from "@multiremi/relay/endpoint-inspection.js";
import { resolveRequestWorkspaceId } from "../helpers/workspace-context.js";
import {
  denyCurrentUserWorkspaceAccess,
  requireHumanWorkspaceAdmin,
  loadRuntimeForCurrentEditor,
  listRuntimesForCurrentUser,
  readJsonStrict,
  isJsonApiError,
} from "../helpers.js";
import {
  currentAccessToken,
  currentWorkspaceRoleStrict,
} from "../wire/index.js";
import type {
  ExecutionProfileInput,
  ExecutionGroupInput,
} from "@multiremi/contracts/execution-profile.js";

export function registerExecutionConfigRoutes(
  app: Hono,
  { store }: RouterDeps,
): void {
  function workspace(c: Context, write = false, supplied?: unknown) {
    if (["task", "daemon"].includes(currentAccessToken(c)?.type ?? ""))
      return c.json({ error: "Human credentials required" }, 403);
    const id = resolveRequestWorkspaceId(
      c,
      store,
      typeof supplied === "string" ? supplied : c.req.query("workspace_id"),
    );
    if (id instanceof Response) return id;
    return (
      (write
        ? requireHumanWorkspaceAdmin(c, store, id)
        : denyCurrentUserWorkspaceAccess(c, store, id)) ?? id
    );
  }
  const failure = (c: Context, error: unknown) =>
    c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Invalid execution configuration",
      },
      400,
    );
  app.get("/api/execution-endpoints", (c) => {
    const ws = workspace(c);
    return ws instanceof Response ? ws : c.json({ endpoints: store.listExecutionEndpoints(ws) });
  });
  app.post("/api/execution-endpoints/inspect", async (c) => {
    const body = await readJsonStrict<{ workspace_id?: string; endpoint_id?: string; connection: unknown; api_key?: string;
      operation: "models" | "detect" | "test"; protocol?: EndpointProtocol; model?: string }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    const ws = workspace(c, true, body.workspace_id);
    if (ws instanceof Response) return ws;
    try {
      const saved = body.endpoint_id ? store.getExecutionEndpoint(body.endpoint_id, ws) : null;
      if (body.endpoint_id && !saved) return c.json({ error: "Endpoint not found" }, 404);
      const connection = parseEndpointConnection(body.connection ?? saved?.connection);
      let key = body.api_key;
      if (key !== undefined && (typeof key !== "string" || !key.trim() || key.length > 8192 || /[\x00-\x1f\x7f]/.test(key)))
        return c.json({ error: "Invalid API key" }, 400);
      if (connection.auth_mode === "env" && !(body.operation === "models" && connection.options?.fetch_models === false))
        return c.json({ error: "This endpoint uses a Runtime environment credential. Server-side inspection cannot access it; inspect its execution group's Runtime model catalog." }, 400);
      if (!key && saved?.connection.credential_id) key = store.getExecutionProfileKey(saved.id, ws, saved.revision, saved.connection.credential_id) ?? undefined;
      if (!key && !(body.operation === "models" && connection.options?.fetch_models === false))
        return c.json({ error: "API key is required to inspect this endpoint" }, 400);
      const result = await inspectEndpoint(connection, key?.trim() ?? "", {
        operation: body.operation, protocol: body.protocol, model: body.model, signal: c.req.raw.signal,
      });
      const persisted = saved && !body.api_key && JSON.stringify(connection) === JSON.stringify(saved.connection);
      if (persisted) store.recordExecutionEndpointInspection(saved.id, ws, saved.revision, result);
      return c.json({ inspection: result, persisted: Boolean(persisted) });
    } catch (error) { return failure(c, error); }
  });
  app.get("/api/execution-endpoints/:id/catalog", (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    const endpoint = store.getExecutionEndpoint(c.req.param("id"), ws);
    if (!endpoint) return c.json({ error: "Endpoint not found" }, 404);
    return c.json({ catalogs: store.getExecutionEndpointCatalog(endpoint.id, ws) });
  });
  app.get("/api/workspaces/:workspaceId/system-model-endpoints", (c) => {
    const ws = workspace(c, false, c.req.param("workspaceId"));
    return ws instanceof Response ? ws : c.json({ defaults: store.getSystemModelEndpoints(ws) });
  });
  app.put("/api/workspaces/:workspaceId/system-model-endpoints", async (c) => {
    const ws = workspace(c, true, c.req.param("workspaceId"));
    if (ws instanceof Response) return ws;
    const body = await readJsonStrict<{ defaults: unknown }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
    try { return c.json({ defaults: store.setSystemModelEndpoints(ws, body.defaults) }); }
    catch (error) { return failure(c, error); }
  });
  app.get("/api/execution-endpoints/:id", (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    const endpoint = store.getExecutionEndpoint(c.req.param("id"), ws);
    return endpoint ? c.json({ endpoint }) : c.json({ error: "Endpoint not found" }, 404);
  });
  for (const method of ["post", "put"] as const) app[method](
    method === "post" ? "/api/execution-endpoints" : "/api/execution-endpoints/:id", async (c) => {
      const body = await readJsonStrict<import("@multiremi/contracts/execution-endpoint.js").ExecutionEndpointInput & { workspace_id?: string }>(c);
      if (isJsonApiError(body)) return c.json({ error: body.apiError }, body.statusCode);
      const ws = workspace(c, true, body.workspace_id);
      if (ws instanceof Response) return ws;
      const id = method === "put" ? c.req.param("id") : undefined;
      if (id && !store.getExecutionEndpoint(id, ws)) return c.json({ error: "Endpoint not found" }, 404);
      try { return c.json({ endpoint: store.saveExecutionEndpoint(ws, body, id) }, method === "post" ? 201 : 200); }
      catch (error) { return failure(c, error); }
    });
  app.delete("/api/execution-endpoints/:id", (c) => {
    const ws = workspace(c, true);
    if (ws instanceof Response) return ws;
    if (!store.getExecutionEndpoint(c.req.param("id"), ws)) return c.json({ error: "Endpoint not found" }, 404);
    try { store.deleteExecutionEndpoint(c.req.param("id"), ws); return c.json({ ok: true }); }
    catch (error) { return failure(c, error); }
  });
  app.get("/api/execution-profiles", (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    return c.json({ profiles: store.listExecutionProfiles(ws) });
  });
  app.get("/api/execution-profiles/:id", (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    const profile = store.getExecutionProfile(c.req.param("id"), ws);
    return profile
      ? c.json({ profile })
      : c.json({ error: "Profile not found" }, 404);
  });
  for (const method of ["post", "put"] as const)
    app[method](
      method === "post"
        ? "/api/execution-profiles"
        : "/api/execution-profiles/:id",
      async (c) => {
        const body = await readJsonStrict<
          ExecutionProfileInput & { workspace_id?: string }
        >(c);
        if (isJsonApiError(body))
          return c.json({ error: body.apiError }, body.statusCode);
        const ws = workspace(c, true, body.workspace_id);
        if (ws instanceof Response) return ws;
        const id = method === "put" ? c.req.param("id") : undefined;
        if (id && !store.getExecutionProfile(id, ws))
          return c.json({ error: "Profile not found" }, 404);
        try {
          return c.json(
            { profile: store.saveExecutionProfile(ws, body, id) },
            method === "post" ? 201 : 200,
          );
        } catch (error) {
          return failure(c, error);
        }
      },
    );
  app.delete("/api/execution-profiles/:id", (c) => {
    const ws = workspace(c, true);
    if (ws instanceof Response) return ws;
    if (!store.getExecutionProfile(c.req.param("id"), ws))
      return c.json({ error: "Profile not found" }, 404);
    try {
      store.deleteExecutionProfile(c.req.param("id"), ws);
      return c.json({ ok: true });
    } catch (error) {
      return failure(c, error);
    }
  });
  const wire = (
    group: NonNullable<ReturnType<typeof store.getExecutionGroup>>,
  ) => ({
    members: store.getExecutionGroupMembers(group.id, group.workspaceId),
    id: group.id,
    workspace_id: group.workspaceId,
    name: group.name,
    description: group.description,
    provider: group.provider,
    profile_id: group.profileId,
    profile_revision: group.profileRevision,
    endpoint_id: group.endpointId,
    connection_mode: group.connectionMode,
    model_policy: group.modelPolicy,
    runtime_ids: group.runtimeIds,
    managed: group.managed,
    is_default: !group.managed,
    online_runtime_count: group.runtimeIds.filter(
      (id) => store.getRuntime(id)?.status === "online",
    ).length,
  });
  app.get("/api/execution-groups/:id", (c) => {
    const ws = workspace(c);
    if (ws instanceof Response) return ws;
    const group = store.getExecutionGroup(c.req.param("id"), ws);
    if (!group) return c.json({ error: "Execution group not found" }, 404);
    const loaded = listRuntimesForCurrentUser(c, store);
    if (loaded instanceof Response) return loaded;
    const admin = ["owner", "admin"].includes(
      currentWorkspaceRoleStrict(c, store, ws) ?? "",
    );
    const ids = new Set(loaded.runtimes.map((runtime) => runtime.id));
    const result = wire(group);
    if (!admin) {
      result.runtime_ids = result.runtime_ids.filter((id) => ids.has(id));
      result.members = result.members.filter((member) =>
        ids.has(member.runtime_id),
      );
      result.online_runtime_count = result.runtime_ids.filter(
        (id) => store.getRuntime(id)?.status === "online",
      ).length;
    }
    return c.json({ group: result });
  });
  for (const method of ["post", "put"] as const)
    app[method](
      method === "post" ? "/api/execution-groups" : "/api/execution-groups/:id",
      async (c) => {
        const body = await readJsonStrict<
          ExecutionGroupInput & { workspace_id?: string }
        >(c);
        if (isJsonApiError(body))
          return c.json({ error: body.apiError }, body.statusCode);
        const ws = workspace(c, true, body.workspace_id);
        if (ws instanceof Response) return ws;
        const id = method === "put" ? c.req.param("id") : undefined;
        const previous = id ? store.getExecutionGroup(id, ws) : null;
        if (id && !previous)
          return c.json({ error: "Execution group not found" }, 404);
        if (
          !Array.isArray(body.runtime_ids) ||
          body.runtime_ids.some((id) => typeof id !== "string")
        )
          return c.json(
            { error: "runtime_ids must be an array of Runtime IDs" },
            400,
          );
        for (const runtimeId of new Set([
          ...(previous?.runtimeIds ?? []),
          ...body.runtime_ids,
        ])) {
          const loaded = loadRuntimeForCurrentEditor(
            c,
            store,
            runtimeId,
            "edit",
          );
          if (loaded instanceof Response) return loaded;
        }
        try {
          return c.json(
            { group: wire(store.saveExecutionGroup(ws, body, id)) },
            method === "post" ? 201 : 200,
          );
        } catch (error) {
          return failure(c, error);
        }
      },
    );
  app.delete("/api/execution-groups/:id", (c) => {
    const ws = workspace(c, true);
    if (ws instanceof Response) return ws;
    const group = store.getExecutionGroup(c.req.param("id"), ws);
    if (!group) return c.json({ error: "Execution group not found" }, 404);
    for (const id of group.runtimeIds) {
      const loaded = loadRuntimeForCurrentEditor(c, store, id, "edit");
      if (loaded instanceof Response) return loaded;
    }
    try {
      store.deleteExecutionGroup(group.id, ws);
      return c.json({ ok: true });
    } catch (error) {
      return failure(c, error);
    }
  });
}
