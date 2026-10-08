import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listIssueSessionRuntimeRoots } from "@daemon/agent-runtime/workspace/session-home.js";
import { prepareIssueSessionArchive } from "@daemon/agent-runtime/workspace/session-archive.js";
import { runWorkspaceGcOnce } from "@daemon/agent-runtime/workspace/gc.js";
import { writeTaskGcContext } from "@daemon/agent-runtime/skills/ephemeral.js";
import { TraceFileStore } from "@multiremi/worker/trace-file-store.js";
import type { AgentTask } from "@daemon/contracts/types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "remi-session-owner-history-"));
  roots.push(root);
  const issueId = "iss_history";
  const workspace = join(root, "MUL-history");
  const task = { id: "tsk_history", issueId, issueSessionId: "ises_issue", workspaceId: "local", repos: [] } as unknown as AgentTask;
  writeTaskGcContext(workspace, task);
  const add = (sessionId: string, chatId: string | null) => {
    const sessionRoot = join(root, ".runtime", sessionId);
    writeTaskGcContext(sessionRoot, { ...task, issueSessionId: sessionId, chatSessionId: chatId } as AgentTask, { kind: "issue_runtime" });
    const home = join(sessionRoot, "generations", "1", "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "history.jsonl"), `{"body":"${sessionId} private evidence"}\n`);
    return sessionRoot;
  };
  const issueRoot = add("ises_issue", null);
  const chatRoot = add("ises_private_chat", "chat_private");
  const otherChatRoot = add("ises_other_chat", "chat_other");
  // Older early traces had this shape for both owners. They cannot establish
  // that a private Chat projection belongs to the public Issue history.
  const unknownRoot = join(root, ".runtime", "ises_legacy_private_trace");
  mkdirSync(join(unknownRoot, ".multiremi"), { recursive: true });
  writeFileSync(join(unknownRoot, ".multiremi", "gc.json"), JSON.stringify({
    version: 2, kind: "issue_runtime", issue_id: issueId,
  }));
  const trace = new TraceFileStore({ workspacesRoot: root, resolveTask: () => ({
    sessionId: "ises_legacy_private_trace", issueId, chatSessionId: "chat_private", agentId: "agt_one", provider: "codex",
    startedAt: "2026-10-08T00:00:00.000Z",
  }) });
  trace.append("tsk_legacy_private", [{ type: "text", content: "Legacy private preparation error" }]);
  trace.close("tsk_legacy_private", { status: "failed", ended_at: "2026-10-08T00:00:01.000Z" });
  return { root, workspace, issueId, issueRoot, chatRoot, otherChatRoot, unknownRoot };
}

describe("owner-scoped provider history", () => {
  it("keeps owner history separate and excludes legacy traces without a verified owner", () => {
    const { root, issueId, issueRoot, chatRoot, otherChatRoot, unknownRoot } = fixture();
    expect(listIssueSessionRuntimeRoots(root, issueId).map(entry => entry.root)).toEqual([issueRoot]);
    expect(listIssueSessionRuntimeRoots(root, issueId, "chat_private").map(entry => entry.root)).toEqual([chatRoot]);
    expect(listIssueSessionRuntimeRoots(root, issueId, "chat_other").map(entry => entry.root)).toEqual([otherChatRoot]);
    expect(JSON.parse(readFileSync(join(issueRoot, ".multiremi", "gc.json"), "utf8")).chat_session_id).toBeNull();
    expect(JSON.parse(readFileSync(join(unknownRoot, ".multiremi", "gc.json"), "utf8")).chat_session_id).toBeUndefined();
  });

  it("excludes projected Chat and unknown legacy files from an Issue archive", async () => {
    const { root, workspace, issueId } = fixture();
    const archive = await prepareIssueSessionArchive(workspace, {
      issueId, sessionRoots: listIssueSessionRuntimeRoots(root, issueId), sessionRootBoundary: root,
    });
    const paths = archive.metadata.files.map(file => file.path);
    expect(paths).toContain("sessions/ises_issue/generations/1/home/history.jsonl");
    expect(paths.some(path => path.includes("ises_private_chat") || path.includes("ises_other_chat") || path.includes("ises_legacy_private_trace"))).toBe(false);
  });

  it("cleans verified Issue-owned runtime while retaining projected Chat and unknown legacy state", async () => {
    const { root, workspace, issueRoot, chatRoot, otherChatRoot, unknownRoot } = fixture();
    const archive = { archiveId: "sar_ready", sourceRevision: "owner-history", sha256: "archive-hash" };
    const result = await runWorkspaceGcOnce({
      root, ttlMs: 0, orphanTtlMs: 0, runtimeId: "rt_history", requireIssueSessionArchive: true,
      ensureIssueSessionArchive: async () => archive,
      client: {
        getIssueGcCheck: async () => ({ status: "done", updated_at: "2000-01-01T00:00:00.000Z" }),
        getChatSessionGcCheck: async () => ({ status: "active" }),
        getAutopilotRunGcCheck: async () => ({ status: "running" }),
        getTaskGcCheck: async () => ({ status: "running" }),
      },
      now: Date.now() + 1_000,
    });
    expect(result.cleaned).toBe(1);
    expect(existsSync(workspace)).toBe(false);
    expect(existsSync(issueRoot)).toBe(false);
    expect(readFileSync(join(chatRoot, "generations", "1", "home", "history.jsonl"), "utf8")).toContain("private evidence");
    expect(existsSync(otherChatRoot)).toBe(true);
    expect(readFileSync(join(unknownRoot, "traces", "tsk_legacy_private.jsonl"), "utf8")).toContain("Legacy private preparation error");
  });

  it("records a projected Chat owner even when the first trace precedes provider preparation", () => {
    const root = mkdtempSync(join(tmpdir(), "remi-early-owner-trace-"));
    roots.push(root);
    const trace = new TraceFileStore({ workspacesRoot: root, resolveTask: () => ({
      sessionId: "ises_early", issueId: "iss_early", chatSessionId: "chat_private", agentId: "agt_one", provider: "codex",
      startedAt: "2026-10-08T00:00:00.000Z",
    }) });
    trace.append("tsk_early", [{ type: "text", content: "Private preparation error" }]);
    expect(listIssueSessionRuntimeRoots(root, "iss_early")).toEqual([]);
    expect(listIssueSessionRuntimeRoots(root, "iss_early", "chat_private").map(entry => entry.sessionId)).toEqual(["ises_early"]);
  });

  it("records an explicit null Chat identity for an early Issue-owned trace", () => {
    const root = mkdtempSync(join(tmpdir(), "remi-early-issue-owner-trace-"));
    roots.push(root);
    const trace = new TraceFileStore({ workspacesRoot: root, resolveTask: () => ({
      sessionId: "ises_early_issue", issueId: "iss_early", chatSessionId: null, agentId: "agt_one", provider: "codex",
      startedAt: "2026-10-08T00:00:00.000Z",
    }) });
    trace.append("tsk_early_issue", [{ type: "text", content: "Public Issue preparation error" }]);
    const metadata = JSON.parse(readFileSync(join(root, ".runtime", "ises_early_issue", ".multiremi", "gc.json"), "utf8"));
    expect(metadata.chat_session_id).toBeNull();
    expect(listIssueSessionRuntimeRoots(root, "iss_early").map(entry => entry.sessionId)).toEqual(["ises_early_issue"]);
    expect(listIssueSessionRuntimeRoots(root, "iss_early", "chat_private")).toEqual([]);
  });
});
