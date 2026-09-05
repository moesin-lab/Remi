import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function fixture() {
  const store = createLocalStore();
  const runtime = store.registerRuntime({ name: "Laptop Codex", provider: "codex", daemonId: "laptop", workspaceId: "local", metadata: { runtime_workspaces: 1 }, maxConcurrency: 4 });
  const workspace = store.runtimeWorkspaces.create(runtime.id, { name: "Local research", root_path: "/home/user/research", cwd: ".", context_paths: ["AGENTS.md"] });
  const agent = store.createAgent({ name: "Researcher", provider: "codex", maxConcurrentTasks: 4 });
  return { store, runtime, workspace, agent };
}

describe("Runtime-owned workspaces", () => {
  it("runs independent Chats on the owning daemon and serializes a shared workspace", () => {
    const { store, runtime, workspace, agent } = fixture();
    const other = store.registerRuntime({ name: "Other laptop", provider: "codex", daemonId: "other", workspaceId: "local", metadata: { runtime_workspaces: 1 } });
    const first = store.createChatSession({ agentId: agent.id, runtime_workspace_id: workspace.id });
    const second = store.createChatSession({ agentId: agent.id, runtime_workspace_id: workspace.id });
    const t1 = store.sendChatMessage(first.id, { body: "Inspect local context" }).task;
    const t2 = store.sendChatMessage(second.id, { body: "Reuse local dependencies" }).task;
    expect(t1.runtimeWorkspaceId).toBe(workspace.id);
    expect(store.claimTask(other.id)).toBeNull();
    const claimed = store.claimTask(runtime.id)!;
    expect(claimed.id).toBe(t1.id);
    expect(claimed.runtimeWorkspace?.rootPath).toBe(workspace.rootPath);
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(() => store.runtimeWorkspaces.archive(workspace.id)).toThrow("Finish or cancel tasks");
    store.cancelTask(t1.id);
    expect(store.claimTask(runtime.id)?.id).toBe(t2.id);
    store.cancelTask(t2.id);
    store.deleteChatSession(first.id);
    store.deleteChatSession(second.id);
    expect(store.runtimeWorkspaces.get(workspace.id)?.archivedAt).toBeNull();
    store.runtimeWorkspaces.archive(workspace.id);
    expect(() => store.createTask({ agentId: agent.id, prompt: "run", runtime_workspace_id: workspace.id })).toThrow("archived");
  });

  it("allows another provider on the same daemon but parks work for legacy or missing runtimes", () => {
    const { store, runtime, workspace } = fixture();
    const claude = store.registerRuntime({ name: "Laptop Claude", provider: "claude", daemonId: "laptop", workspaceId: "local" });
    const agent = store.createAgent({ name: "Writer", provider: "claude" });
    const issue = store.createIssue({ title: "Local-only Issue", runtime_workspace_id: workspace.id });
    const task = store.createTask({ issueId: issue.id, agentId: agent.id, prompt: "Inspect" });
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(store.claimTask(claude.id)).toBeNull();
    store.registerRuntime({ id: claude.id, name: claude.name, provider: "claude", daemonId: "laptop", workspaceId: "local", metadata: { runtime_workspaces: 1 } });
    expect(store.claimTask(claude.id)?.id).toBe(task.id);
    expect(() => store.updateIssue(issue.id, { runtime_workspace_id: null })).toThrow("executed Issue");
    store.cancelTask(task.id);
    store.deleteIssue(issue.id);
    expect(store.runtimeWorkspaces.get(workspace.id)).not.toBeNull();
  });

  it("retains standalone task bindings through infrastructure retries and Runtime replacement", () => {
    const { store, runtime, workspace, agent } = fixture();
    store.registerRuntime({ name: "Laptop Claude", provider: "claude", daemonId: "laptop", workspaceId: "local" });
    const other = store.registerRuntime({ name: "Other", provider: "codex", daemonId: "other", workspaceId: "local", metadata: { runtime_workspaces: 1 } });
    const task = store.createTask({ agentId: agent.id, prompt: "Use local context", runtime_workspace_id: workspace.id, maxAttempts: 2 });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    expect(store.recoverOrphans(runtime.id)).toEqual({ orphaned: 1, retried: 1 });
    const retry = store.listTasks().find(t => t.parentTaskId === task.id)!;
    expect(retry.runtimeWorkspaceId).toBe(workspace.id);
    expect(retry.runtimeId).toBeNull();
    expect(retry.sessionId).toBeNull();
    expect(store.claimTask(other.id)).toBeNull();
    expect(store.deleteRuntime(runtime.id)).toBe(true);
    expect(store.runtimeWorkspaces.get(workspace.id)?.daemonId).toBe("laptop");
    const replacement = store.registerRuntime({ name: "Laptop Codex", provider: "codex", daemonId: "laptop", workspaceId: "local", metadata: { runtime_workspaces: 1 } });
    expect(replacement.id).not.toBe(runtime.id);
    expect(store.claimTask(replacement.id)?.id).toBe(retry.id);
  });

  it("rejects cross-tenant bindings and paths outside the configured root", () => {
    const { store, runtime, workspace } = fixture();
    store.createWorkspace({ id: "other", name: "Other", slug: "other" });
    expect(() => store.createIssue({ title: "Wrong tenant", workspaceId: "other", runtime_workspace_id: workspace.id })).toThrow("not found");
    for (const cwd of ["../private", "/etc", "C:\\Windows", "repo/../../private"]) {
      expect(() => store.runtimeWorkspaces.create(runtime.id, { name: "Invalid", root_path: "/local", cwd })).toThrow("inside root_path");
    }
    expect(() => store.runtimeWorkspaces.create(runtime.id, { name: "Relative", root_path: "research" })).toThrow("absolute");
    expect(() => store.runtimeWorkspaces.create(runtime.id, { name: "Duplicate", root_path: workspace.rootPath })).toThrow("already registered");
  });

  it("keeps Issue workspace selection explicit and validates batch binding access", async () => {
    const { store, workspace } = fixture();
    const parent = store.createIssue({ title: "Parent", runtime_workspace_id: workspace.id });
    const child = store.createIssue({ title: "Child", parent_issue_id: parent.id, runtime_workspace_id: null });
    expect(child.runtimeWorkspaceId).toBeNull();
    const foreign = store.registerRuntime({ name: "Private machine", provider: "codex", daemonId: "private", workspaceId: "local", ownerId: "someone-else", visibility: "private" });
    const privateWorkspace = store.runtimeWorkspaces.create(foreign.id, { name: "Private", root_path: "/private" });
    const app = createMultiremiApp({ store });
    for (const prefix of ["/api", "/api/multiremi"]) {
      const request = (id: string | null) => app.request(`${prefix}/issues/batch-update`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issue_ids: [child.id], updates: { runtime_workspace_id: id } }),
      });
      expect((await request(privateWorkspace.id)).status).toBe(403);
      expect(store.getIssue(child.id)?.runtimeWorkspaceId).toBeNull();
      const bound = await request(workspace.id);
      expect(bound.status).toBe(200);
      expect((await bound.json()).updated).toBe(1);
      expect(store.getIssue(child.id)?.runtimeWorkspaceId).toBe(workspace.id);
      expect((await request(null)).status).toBe(200);
      expect(store.getIssue(child.id)?.runtimeWorkspaceId).toBeNull();
    }
  });

  it("provides Web/CLI registration, listing, Chat/Issue binding and non-destructive archive APIs", async () => {
    const { store, runtime, agent } = fixture();
    const app = createMultiremiApp({ store });
    const request = (path: string, method: string, body?: unknown) => app.request(path, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const registered = await request(`/api/runtimes/${runtime.id}/workspaces`, "POST", { name: "Private notes", root_path: "C:\\notes", context_paths: ["AGENTS.md"] });
    expect(registered.status).toBe(201);
    const item = await registered.json();
    expect(item.status).toBe("available");
    expect((await (await request("/api/runtime-workspaces", "GET")).json()).workspaces).toHaveLength(2);
    const chat = await request("/api/chat/sessions", "POST", { agent_id: agent.id, runtime_workspace_id: item.id });
    expect(chat.status).toBe(201);
    expect((await chat.json()).runtime_workspace_id).toBe(item.id);
    const issue = await request("/api/issues", "POST", { title: "No cloud Git", runtime_workspace_id: item.id });
    expect(issue.status).toBe(201);
    expect((await issue.json()).runtime_workspace_id).toBe(item.id);
    expect((await request(`/api/runtime-workspaces/${item.id}`, "PATCH", { root_path: "/changed" })).status).toBe(400);
    expect((await request(`/api/runtime-workspaces/${item.id}`, "DELETE")).status).toBe(200);
    expect(store.runtimeWorkspaces.get(item.id)?.rootPath).toBe("C:\\notes");
  });
});
