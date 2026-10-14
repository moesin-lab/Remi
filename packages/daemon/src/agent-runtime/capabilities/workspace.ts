import type { CapabilityBlock, PersistentContext, EphemeralContext } from "../types.js";
import { codexRuntimeWorkspaceDirectories } from "../workspace/runtime-context.js";

export const workspaceBlock: CapabilityBlock = {
  name: "workspace",

  persistent(ctx: PersistentContext) {
    const cwd = ctx.sessionRow?.cwd?.trim() || ctx.topicCwd?.trim();
    if (!cwd) {
      throw new Error(`Persistent session for Agent ${ctx.agent.id} has no workspace`);
    }
    return { cwd };
  },

  ephemeral(ctx: EphemeralContext) {
    if (ctx.task.runtimeWorkspace && ctx.task.agent?.provider === "codex") {
      return { cwd: ctx.workDir, addDirs: codexRuntimeWorkspaceDirectories(ctx.task, ctx.workDir, ctx.providerHome) };
    }
    return { cwd: ctx.workDir, ...(ctx.task.runtimeWorkspace ? { addDirs: [ctx.task.runtimeWorkspace.rootPath] } : {}) };
  },
};
