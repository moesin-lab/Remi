import type { Context } from "hono";
import type { MultiremiStore } from "@multiremi/store/store.js";
import { cleanString, currentAccessToken } from "../wire/context.js";

export function resolveDefaultWorkspaceIdForUser(store: MultiremiStore, userId: string): string {
  return store.getWorkspace("local")?.id ?? store.listWorkspaces()[0]?.id ?? "local";
}

/** Resolve request context only; callers must authorize this same ID before using it. */
export function resolveRequestWorkspaceId(
  c: Context,
  store: MultiremiStore,
  explicitId?: string | null,
): string | Response {
  const id = cleanString(explicitId) ?? cleanString(c.req.header("X-Workspace-ID"));
  if (id) return id;
  const slug = cleanString(c.req.header("X-Workspace-Slug"));
  if (slug) {
    const workspace = store.listWorkspaces().find((candidate) => candidate.slug === slug);
    return workspace?.id ?? c.json({ error: "workspace not found" }, 404);
  }
  const token = currentAccessToken(c);
  if (token?.type === "task" || token?.type === "daemon") return token.workspaceId;
  // Human accounts share the same default; explicit workspace selections above
  // still win. User-less legacy PATs retain their bound workspace.
  if (token?.type === "pat" && token.userId === "local" && token.purpose !== "session") return token.workspaceId;
  return resolveDefaultWorkspaceIdForUser(store, "local");
}
