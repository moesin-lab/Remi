import type { Context, Hono } from "hono";
import { denyCurrentUserWorkspaceAccess } from "../helpers.js";
import type { RouterDeps } from "./deps.js";

export function registerInvitationRoutes(app: Hono, { store }: RouterDeps): void {
  const retired = (c: Context) => c.json({
    error: "Workspace operators are shared; invitations are no longer supported",
    code: "workspace_invitations_retired",
  }, 410);
  const retiredWorkspaceInvitation = (c: Context) => {
    const denied = denyCurrentUserWorkspaceAccess(c, store, c.req.param("id") ?? "");
    return denied ?? retired(c);
  };
  app.get("/api/workspaces/:id/invitations", retiredWorkspaceInvitation);
  app.delete("/api/workspaces/:id/invitations/:invitationId", retiredWorkspaceInvitation);
  app.get("/api/invitations", retired);
  app.get("/api/invitations/:id", retired);
  app.post("/api/invitations/:id/accept", retired);
  app.post("/api/invitations/:id/decline", retired);
}
