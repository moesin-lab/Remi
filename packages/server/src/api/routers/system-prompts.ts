import type { Context, Hono } from "hono";
import type { RouterDeps } from "./deps.js";
import type { SystemPromptActor, SystemPromptContent, SystemPromptEditInput, SystemPromptRestoreInput, SystemPromptWriteInput } from "@multiremi/contracts/system-prompt-policy.js";
import { denyCurrentUserWorkspaceAccess, requireHumanWorkspaceAdmin, readJsonStrict, isJsonApiError } from "../helpers.js";
import { authenticatedRequestUserId, currentRequestUserId } from "../wire/context.js";
import { SystemPromptError } from "../../store/repos/system-prompts-repo.js";
import { buildSystemPromptPolicyPreview } from "../../prompts/platform-template.js";

export function registerSystemPromptRoutes(app: Hono, { store }: RouterDeps): void {
  function access(c: Context, write = false) {
    const id = c.req.param("id")!;
    return denyCurrentUserWorkspaceAccess(c, store, id) ?? (write ? requireHumanWorkspaceAdmin(c, store, id) : null);
  }
  function actor(c: Context): SystemPromptActor {
    const userId = authenticatedRequestUserId(c);
    return { type: "human", operatorId: currentRequestUserId(c), userId,
      displayName: userId ? store.getUser(userId)?.name ?? null : null };
  }
  function failure(c: Context, error: unknown): Response {
    if (!(error instanceof SystemPromptError)) throw error;
    const status = error.code === "system_prompt_version_not_found" ? 404
      : error.code === "invalid_system_prompt" ? 400 : 409;
    return c.json({ error: error.message, code: error.code,
      ...(error.currentRevision !== undefined ? { currentRevision: error.currentRevision } : {}) }, status);
  }
  app.get("/api/workspaces/:id/system-prompt", c => {
    const denied = access(c);
    return denied ?? c.json(store.getSystemPrompt(c.req.param("id")));
  });
  app.put("/api/workspaces/:id/system-prompt", async c => {
    const denied = access(c, true);
    if (denied) return denied;
    const body = await readJsonStrict<SystemPromptEditInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError, code: "invalid_system_prompt" }, body.statusCode);
    try { return c.json(store.editSystemPrompt(c.req.param("id"), body, actor(c))); }
    catch (error) { return failure(c, error); }
  });
  app.post("/api/workspaces/:id/system-prompt/reset", async c => {
    const denied = access(c, true);
    if (denied) return denied;
    const body = await readJsonStrict<SystemPromptWriteInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError, code: "invalid_system_prompt" }, body.statusCode);
    try { return c.json(store.resetSystemPrompt(c.req.param("id"), body, actor(c))); }
    catch (error) { return failure(c, error); }
  });
  app.post("/api/workspaces/:id/system-prompt/restore", async c => {
    const denied = access(c, true);
    if (denied) return denied;
    const body = await readJsonStrict<SystemPromptRestoreInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError, code: "invalid_system_prompt" }, body.statusCode);
    try { return c.json(store.restoreSystemPrompt(c.req.param("id"), body, actor(c))); }
    catch (error) { return failure(c, error); }
  });
  app.get("/api/workspaces/:id/system-prompt/versions", c => {
    const denied = access(c);
    if (denied) return denied;
    try {
      return c.json(store.listSystemPromptVersions(c.req.param("id"), { cursor: c.req.query("cursor"),
        ...(c.req.query("limit") !== undefined ? { limit: Number(c.req.query("limit")) } : {}) }));
    } catch (error) { return failure(c, error); }
  });
  app.get("/api/workspaces/:id/system-prompt/versions/:versionId", c => {
    const denied = access(c);
    if (denied) return denied;
    const version = store.getSystemPromptVersion(c.req.param("id"), c.req.param("versionId"));
    return version ? c.json(version) : c.json({ error: "System Prompt version not found", code: "system_prompt_version_not_found" }, 404);
  });
  app.post("/api/workspaces/:id/system-prompt/preview", async c => {
    const denied = access(c);
    if (denied) return denied;
    const body = await readJsonStrict<{ content?: SystemPromptContent }>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError, code: "invalid_system_prompt" }, body.statusCode);
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "A preview request object is required", code: "invalid_system_prompt" }, 400);
    try { return c.json(buildSystemPromptPolicyPreview(body.content === undefined ? store.getSystemPrompt(c.req.param("id")).content : body.content)); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error), code: "invalid_system_prompt" }, 400); }
  });
}
