import type { Context, Hono } from "hono";
import { resolveRequestWorkspaceId } from "../helpers/workspace-context.js";
import { denyCurrentUserWorkspaceAccess } from "../helpers.js";
import { workspaceMemberToGoResponse } from "../wire/index.js";
import type { RouterDeps } from "./deps.js";

export function registerMemberRoutes(app: Hono, { store }: RouterDeps): void {
  const retired = (c: Context) => c.json({
    error: "Workspace operators are shared; member management is no longer supported",
    code: "workspace_members_retired",
  }, 410);
  const retiredWorkspaceMember = (c: Context) => {
    const denied = denyCurrentUserWorkspaceAccess(c, store, c.req.param("id") ?? "");
    return denied ?? retired(c);
  };
  app.get("/api/workspaces/:id/members", c => {
    const workspaceId = c.req.param("id");
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const operator = store.getWorkspaceOperator(workspaceId);
    const members = c.req.query("include_history") === "true"
      ? store.listWorkspaceMembers(workspaceId, { includeArchived: true }).map(member => member.id === operator?.id ? operator : member)
      : operator ? [operator] : [];
    return c.json(members.map(member => workspaceMemberToGoResponse(member, { includeName: true })));
  });
  app.post("/api/workspaces/:id/members", retiredWorkspaceMember);
  app.patch("/api/workspaces/:id/members/:memberId", retiredWorkspaceMember);
  app.delete("/api/workspaces/:id/members/:memberId", retiredWorkspaceMember);
  app.get("/api/multiremi/members", c => {
    const workspaceId = resolveRequestWorkspaceId(c, store, c.req.query("workspaceId"));
    if (workspaceId instanceof Response) return workspaceId;
    const denied = denyCurrentUserWorkspaceAccess(c, store, workspaceId);
    if (denied) return denied;
    const operator = store.getWorkspaceOperator(workspaceId);
    const members = operator ? [operator] : [];
    return c.json({ members, total: members.length });
  });
  app.get("/api/multiremi/members/:id", c => {
    const member = store.getWorkspaceMember(c.req.param("id"));
    if (!member) return c.json({ error: "member not found" }, 404);
    const denied = denyCurrentUserWorkspaceAccess(c, store, member.workspaceId);
    if (denied) return denied;
    const operator = store.getWorkspaceOperator(member.workspaceId);
    return c.json({ member: operator?.id === member.id ? operator : member });
  });
  app.post("/api/multiremi/members", retired);
  app.patch("/api/multiremi/members/:id", retired);
  app.delete("/api/multiremi/members/:id", retired);
}
