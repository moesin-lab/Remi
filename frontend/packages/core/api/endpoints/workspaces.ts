import type {
  Workspace,
  WorkspacePromptSettings,
  PlatformPromptTemplatePreview,
  UpdateWorkspacePromptSettingsRequest,
  WorkspaceRepo,
  BotMenuConfig,
  BotMenuResponse,
  BotMenuPublishResponse,
} from "../../types";
import type { HttpClient } from "../http";
import { parseWithFallback, parseStrictResponse } from "../schema";
import {
  EMPTY_PLATFORM_PROMPT_TEMPLATE,
  EMPTY_WORKSPACE_ENV,
  BotMenuPublishResponseSchema,
  BotMenuResponseSchema,
  PlatformPromptTemplatePreviewSchema,
  WorkspaceEnvResponseSchema,
  WorkspaceOperatorSchema,
  type WorkspaceEnvResponse,
} from "../schemas/workspaces";

export class WorkspacesEndpoints {
  constructor(readonly http: HttpClient) {}

  // Workspaces
  async listWorkspaces(): Promise<Workspace[]> {
    const workspaces = await this.http.fetch<Workspace[]>("/api/workspaces");
    return workspaces.map(parseWorkspaceIdentity);
  }

  async getWorkspace(id: string): Promise<Workspace> {
    return parseWorkspaceIdentity(await this.http.fetch<Workspace>(`/api/workspaces/${id}`));
  }

  async createWorkspace(data: { name: string; slug: string; description?: string; context?: string }): Promise<Workspace> {
    return this.http.fetch("/api/workspaces", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async updateWorkspace(id: string, data: { name?: string; description?: string; context?: string; settings?: Record<string, unknown>; repos?: WorkspaceRepo[]; issue_prefix?: string; avatar_url?: string }): Promise<Workspace> {
    return this.http.fetch(`/api/workspaces/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  async getWorkspacePromptSettings(workspaceId: string): Promise<WorkspacePromptSettings> {
    return this.http.fetch(`/api/workspaces/${workspaceId}/prompts`);
  }

  async updateWorkspacePromptSettings(
    workspaceId: string,
    data: UpdateWorkspacePromptSettingsRequest,
  ): Promise<WorkspacePromptSettings> {
    return this.http.fetch(`/api/workspaces/${workspaceId}/prompts`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
  }

  async getBotMenu(workspaceId: string, botId = "default"): Promise<BotMenuResponse> {
    const raw = await this.http.fetch<unknown>(botMenuPath(workspaceId, botId));
    return parseStrictResponse(raw, BotMenuResponseSchema, { endpoint: "GET /api/workspaces/:id/bot-menu" });
  }

  async updateBotMenu(workspaceId: string, botMenu: BotMenuConfig, botId = "default"): Promise<BotMenuResponse> {
    const raw = await this.http.fetch<unknown>(botMenuPath(workspaceId, botId), {
      method: "PUT", body: JSON.stringify({ bot_menu: botMenu }),
    });
    return parseStrictResponse(raw, BotMenuResponseSchema, { endpoint: "PUT /api/workspaces/:id/bot-menu" });
  }

  async publishBotMenu(workspaceId: string, dryRun: boolean, botId = "default"): Promise<BotMenuPublishResponse> {
    const raw = await this.http.fetch<unknown>(botMenuPath(workspaceId, botId, "/publish"), {
      method: "POST", body: JSON.stringify({ dry_run: dryRun }),
    });
    return parseStrictResponse(raw, BotMenuPublishResponseSchema, { endpoint: "POST /api/workspaces/:id/bot-menu/publish" });
  }

  async getBotMenuPublish(workspaceId: string, requestId: string, botId = "default"): Promise<BotMenuPublishResponse> {
    const raw = await this.http.fetch<unknown>(botMenuPath(workspaceId, botId, `/publish/${encodeURIComponent(requestId)}`));
    return parseStrictResponse(raw, BotMenuPublishResponseSchema, { endpoint: "GET /api/workspaces/:id/bot-menu/publish/:requestId" });
  }

  async getWorkspacePromptTemplate(workspaceId: string): Promise<PlatformPromptTemplatePreview> {
    const raw = await this.http.fetch<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/prompt-template`,
    );
    return parseWithFallback(
      raw,
      PlatformPromptTemplatePreviewSchema,
      EMPTY_PLATFORM_PROMPT_TEMPLATE,
      { endpoint: "GET /api/workspaces/:id/prompt-template" },
    );
  }

  // Workspace-level env for task sessions (owner/admin only). GET returns
  // plaintext values — call it on explicit user intent (reveal), not on mount.
  async getWorkspaceEnv(workspaceId: string): Promise<WorkspaceEnvResponse> {
    const raw = await this.http.fetch<unknown>(`/api/workspaces/${workspaceId}/env`);
    return parseWithFallback(raw, WorkspaceEnvResponseSchema, EMPTY_WORKSPACE_ENV, {
      endpoint: "GET /api/workspaces/:id/env",
    });
  }

  // Replaces the whole map; a value of "****" keeps the currently stored
  // value for that key (same contract as the agent env endpoint).
  async updateWorkspaceEnv(workspaceId: string, data: { env: Record<string, string> }): Promise<WorkspaceEnvResponse> {
    const raw = await this.http.fetch<unknown>(`/api/workspaces/${workspaceId}/env`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
    return parseWithFallback(raw, WorkspaceEnvResponseSchema, EMPTY_WORKSPACE_ENV, {
      endpoint: "PUT /api/workspaces/:id/env",
    });
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.http.fetch(`/api/workspaces/${workspaceId}`, {
      method: "DELETE",
    });
  }
}

function botMenuPath(workspaceId: string, botId: string, suffix = ""): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/bot-menu${suffix}?bot_id=${encodeURIComponent(botId)}`;
}

function parseWorkspaceIdentity(workspace: Workspace): Workspace {
  // Older servers can omit the identity field; permissions still require the
  // canonical operator returned by the workspace actor query.
  if (workspace.operator === undefined) return workspace;
  return { ...workspace, operator: parseStrictResponse(workspace.operator, WorkspaceOperatorSchema,
    { endpoint: "GET /api/workspaces operator" }) };
}
