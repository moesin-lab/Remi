import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listIssueConversationRoots, listTaskConversationRoots, resolveTaskProviderHome } from "@daemon/agent-runtime/workspace/session-home.js";
import { conversationForTask, envDirectory, subjectForTask, tracePath, workDirectory } from "@daemon/agent-runtime/workspace/layout.js";
import { TraceFileStore } from "@multiremi/worker/trace-file-store.js";
import type { AgentTask } from "@daemon/contracts/types.js";
import { contractMessage } from "./trace-store-contract.js";
import { cleanupFixtures, issueEnded, reclaimFixture } from "./reclaim-fixture.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  cleanupFixtures();
});

function task(sessionId: string, chatId: string | null): AgentTask {
  return { id: `tsk_${sessionId}`, issueId: "iss_history", issueSessionId: sessionId,
    chatSessionId: chatId, workspaceId: "local", repos: [],
    agent: { id: "agt_one", provider: "claude" },
  } as unknown as AgentTask;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "remi-session-owner-history-"));
  roots.push(root);
  const issue = task("ises_issue", null);
  const chat = task("ises_private_chat", "chat_private");
  const otherChat = task("ises_other_chat", "chat_other");
  const sibling = task("ises_other_issue", "chat_private");
  const add = (input: AgentTask) => {
    const home = resolveTaskProviderHome(input, root)!;
    mkdirSync(home.home, { recursive: true });
    writeFileSync(join(home.home, "history.jsonl"), `${input.issueSessionId} private evidence`);
    return join(envDirectory(root, subjectForTask(input)), conversationForTask(input));
  };
  const issueRoot = add(issue);
  const chatRoot = add(chat);
  const otherChatRoot = add(otherChat);
  const siblingRoot = add(sibling);
  const unknownRoot = join(root, "legacy-20261015", ".runtime", "ises_legacy_private_trace");
  mkdirSync(unknownRoot, { recursive: true });
  writeFileSync(join(unknownRoot, "history.jsonl"), "Unknown historical owner");
  return { root, issue, chat, otherChat, issueRoot, chatRoot, otherChatRoot, siblingRoot, unknownRoot };
}

describe("owner-scoped provider history", () => {
  it("keeps Chat-owned Session history out of an Issue and unrelated Chat conversations", () => {
    const { root, issue, chat, otherChat, issueRoot, chatRoot, otherChatRoot } = fixture();
    expect(listIssueConversationRoots(root, issue.issueId!)).toEqual([issueRoot]);
    expect(listTaskConversationRoots(root, issue)).toEqual([issueRoot]);
    expect(listTaskConversationRoots(root, chat)).toEqual([chatRoot]);
    expect(listTaskConversationRoots(root, otherChat)).toEqual([otherChatRoot]);
  });

  it("does not expose another owner through a linked conversation directory", () => {
    const { root, chat, otherChatRoot } = fixture();
    const missing = { ...chat, issueSessionId: "ises_linked" };
    symlinkSync(otherChatRoot, join(envDirectory(root, subjectForTask(chat)), "ises_linked"));
    expect(listTaskConversationRoots(root, missing)).toEqual([]);
    expect(listTaskConversationRoots(root, { ...chat, issueSessionId: "ises_missing" })).toEqual([]);
  });

  it("reclaims an ended Issue without collecting private Chat or unknown legacy state", async () => {
    const f = reclaimFixture();
    const issue = { kind: "issue", id: "iss_history" } as const;
    const chat = { kind: "chat", id: "chat_private" } as const;
    f.subject(issue);
    f.subject(chat);
    f.worktree(issue);
    const issueLane = f.lane(issue, 1, { conversation: "ises_issue" });
    const chatLane = f.lane(chat, 1, { conversation: "ises_private" });
    const unknown = join(f.root, "legacy-20261015", "retained", "unknown-history");
    mkdirSync(unknown, { recursive: true });
    writeFileSync(join(unknown, "history.jsonl"), "Unverified owner");
    f.server.answer(issue.id, issueEnded());
    f.server.answer(chat.id, { status: "active" });

    const engine = f.engine();
    const report = await engine.run("periodic");
    await engine.measurementSettled();
    expect(report.reclaimed_this_round).toBe(1);
    expect(existsSync(workDirectory(f.root, issue))).toBe(false);
    expect(existsSync(join(issueLane, ".remi-runtime"))).toBe(false);
    expect(existsSync(join(issueLane, "home", "projects", "-work", "session.jsonl"))).toBe(true);
    expect(existsSync(join(chatLane, ".remi-runtime"))).toBe(true);
    expect(readFileSync(join(unknown, "history.jsonl"), "utf8")).toBe("Unverified owner");
  });

  for (const chatId of ["chat_private", null]) {
    it(`records an early trace under its ${chatId ? "Chat" : "Issue"} owner with its product Session identity`, () => {
      const root = mkdtempSync(join(tmpdir(), "remi-early-owner-trace-"));
      roots.push(root);
      const input = task("ises_early", chatId);
      const subject = subjectForTask(input);
      const trace = new TraceFileStore({ workspacesRoot: root, resolveTask: () => ({
        sessionId: conversationForTask(input), subjectId: subject.id, agentId: "agt_one", provider: "codex",
        startedAt: "2026-10-15T00:00:00.000Z",
      }) });
      trace.append(input.id, [{ type: "item.completed", item: contractMessage("early", "Preparation error") }]);
      trace.close(input.id, { status: "failed", ended_at: "2026-10-15T00:00:01.000Z" });
      const path = tracePath(root, subject, input.id);
      expect(readFileSync(path, "utf8")).toContain("Preparation error");
      const header = JSON.parse(readFileSync(path, "utf8").split("\n")[0]!);
      expect(header.session_id).toBe("ises_early");
      const otherOwner = chatId ? input.issueId! : "chat_private";
      expect(existsSync(tracePath(root, otherOwner, input.id))).toBe(false);
      expect(listIssueConversationRoots(root, input.issueId!)).toEqual([]);
    });
  }
});
