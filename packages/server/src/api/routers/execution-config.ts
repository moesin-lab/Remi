import type { Context, Hono } from "hono";
import type { RouterDeps } from "./deps.js";
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
    provider: group.provider,
    profile_id: group.profileId,
    profile_revision: group.profileRevision,
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
