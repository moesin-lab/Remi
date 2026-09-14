/**
 * Persistent workspace path resolution.
 *
 * Computes the stable daemon-owned working directory for every Task surface.
 * A promoted task.workDir remains authoritative because it owns the provider
 * session lineage; brand-new work is partitioned by product session type.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentTask } from "@daemon/contracts/types.js";

/**
 * `ensureDir` marks a directory the daemon owns and may create.
 */
export interface ResolvedWorkDir {
  workDir: string;
  ensureDir: boolean;
}

export function resolveWorkDir(
  task: AgentTask,
  workspacesRoot = join(homedir(), ".remi", "multiremi", "workspaces"),
): ResolvedWorkDir {
  const productSessionId = task.issueSessionId ?? task.issue_session_id;
  // A Session Task may also carry its owning Chat id. The Session marker wins:
  // linked work still prepares the Issue workspace, while ordinary Chat Tasks
  // stay in the Chat root.
  if (productSessionId && task.issue?.key) {
    const issueKey = safePathSegment(task.issue.key, "issue key");
    if (task.holdsWorkspace === false || task.holds_workspace === false) {
      return {
        workDir: join(
          workspacesRoot,
          "discussions",
          issueKey,
          safePathSegment(productSessionId, "product Session id"),
        ),
        ensureDir: true,
      };
    }
    return { workDir: join(workspacesRoot, "issues", issueKey), ensureDir: true };
  }
  if (task.chatSessionId) {
    return {
      workDir: task.workDir ?? join(
        workspacesRoot,
        "chats",
        safePathSegment(task.chatSessionId, "chat session id"),
      ),
      ensureDir: true,
    };
  }
  if (task.issue?.key) {
    const issueKey = safePathSegment(task.issue.key, "issue key");
    if (task.holdsWorkspace === false || task.holds_workspace === false) {
      if (!productSessionId) throw new Error("discussion task requires a product Session id");
      return {
        workDir: join(
          workspacesRoot,
          "discussions",
          issueKey,
          safePathSegment(productSessionId, "product Session id"),
        ),
        ensureDir: true,
      };
    }
    return { workDir: join(workspacesRoot, "issues", issueKey), ensureDir: true };
  }
  if (task.workDir) return { workDir: task.workDir, ensureDir: true };
  return { workDir: join(workspacesRoot, "tasks", safePathSegment(task.id, "task id")), ensureDir: true };
}

function safePathSegment(value: string, label: string): string {
  const key = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!key || key === "." || key === "..") throw new Error(`invalid ${label} for workspace path: ${JSON.stringify(value)}`);
  return key;
}
