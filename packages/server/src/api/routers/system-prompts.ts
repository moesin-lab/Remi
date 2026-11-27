import type { Context, Hono } from "hono";
import type { RouterDeps } from "./deps.js";
import { guardRootResourceWrite } from "../helpers/root-access.js";
import type { SystemPromptActor, SystemPromptContent, SystemPromptEditInput, SystemPromptRestoreInput, SystemPromptWriteInput } from "@multiremi/contracts/system-prompt-policy.js";
import { denyCurrentUserWorkspaceAccess, requireHumanWorkspaceAdmin, readJsonStrict, isJsonApiError } from "../helpers.js";
import { authenticatedRequestUserId, currentRequestUserId, currentTaskAccessToken } from "../wire/context.js";
import { hashSystemPromptContent } from "@shared/system-prompt-policy-hash.js";
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
  function writePrompt<T>(c: Context, version: number, operation: () => T): T {
    const workspaceId = c.req.param('id')!;
    return guardRootResourceWrite(c, store, workspaceId, 'system-prompt', workspaceId, operation, { version });
  }
  app.get("/api/workspaces/:id/system-prompt", c => {
    const denied = access(c);
    if (denied) return denied;
    const attempt = c.req.query("attempt");
    const hash = c.req.query("contentHash");
    const workspaceId = c.req.param("id");
    if (attempt === undefined && hash === undefined) return c.json(store.getSystemPrompt(workspaceId));
    if (!attempt || !hash || !/^[a-f0-9]{64}$/.test(hash)) return c.json({ error: "Expected attempt and SHA-256 contentHash" }, 400);
    const token = currentTaskAccessToken(c);
    if (token && token.taskId !== attempt) return c.json({ error: "Attempt access denied" }, 403);
    const binding = store.getAttemptSystemPrompt(attempt);
    if (!binding || binding.workspaceId !== workspaceId) return c.json({ error: "Attempt snapshot not found" }, 404);
    if (hash !== binding.contentHash || hash !== hashSystemPromptContent(binding.content)) return c.json({ error: "Attempt content hash mismatch" }, 409);
    return c.json(binding);
  });
  app.put("/api/workspaces/:id/system-prompt", async c => {
    const denied = access(c, true);
    if (denied) return denied;
    const body = await readJsonStrict<SystemPromptEditInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError, code: "invalid_system_prompt" }, body.statusCode);
    try { return c.json(writePrompt(c, body.expectedRevision, () => store.editSystemPrompt(c.req.param("id"), body, actor(c)))); }
    catch (error) { return failure(c, error); }
  });
  app.post("/api/workspaces/:id/system-prompt/reset", async c => {
    const denied = access(c, true);
    if (denied) return denied;
    const body = await readJsonStrict<SystemPromptWriteInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError, code: "invalid_system_prompt" }, body.statusCode);
    try { return c.json(writePrompt(c, body.expectedRevision, () => store.resetSystemPrompt(c.req.param("id"), body, actor(c)))); }
    catch (error) { return failure(c, error); }
  });
  app.post("/api/workspaces/:id/system-prompt/restore", async c => {
    const denied = access(c, true);
    if (denied) return denied;
    const body = await readJsonStrict<SystemPromptRestoreInput>(c);
    if (isJsonApiError(body)) return c.json({ error: body.apiError, code: "invalid_system_prompt" }, body.statusCode);
    try { return c.json(writePrompt(c, body.expectedRevision, () => store.restoreSystemPrompt(c.req.param("id"), body, actor(c)))); }
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
