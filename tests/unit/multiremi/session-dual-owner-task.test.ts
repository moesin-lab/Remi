import { afterEach, describe, expect, it } from "bun:test";
import { daemonTaskClaimResponse, taskRealtimePayload } from "@multiremi/api/wire/tasks.js";
import { buildTaskPrompt } from "@daemon/agent-runtime/prompts/ephemeral.js";
import { resolveWorkDir } from "@daemon/agent-runtime/workspace/persistent.js";
import { resolveIssueSessionProviderHome } from "@daemon/agent-runtime/workspace/session-home.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";
import { bindFeishuTopicFixture } from "./feishu-topic-fixture.js";

afterEach(resetMultiremiTestEnv);

function fixture(owner: "chat" | "issue", projected = false) {
  const store = createLocalStore();
  const runtime = store.registerRuntime({ name: "Session executor", provider: "claude", workspaceId: "local" });
  const agent = store.createAgent({ name: "Session worker", provider: "claude", runtimeId: runtime.id });
  const issue = owner === "issue" || projected ? store.createIssue({ title: "Session work" }) : null;
  const chat = owner === "chat" ? store.createChatSession({ agentId: agent.id, creatorId: "local" }) : null;
  const session = chat
    ? projected ? store.createIssueSession(issue!.id, { chatId: chat.id, title: "Projected work" })
      : store.getOrCreateDefaultChatSession(chat.id)
    : store.getOrCreateDefaultIssueSession(issue!.id);
  return { store, runtime, agent, issue, chat, session };
}

describe("Session Task dual ownership", () => {
  for (const owner of ["chat", "issue"] as const) {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      it(`persists ${status} on the ${owner} owner's Session without creating a Chat`, () => {
        const { store, runtime, agent, issue, chat, session } = fixture(owner);
        const chatsBefore = store.listChatSessions("local", { includeArchived: true }).length;
        store.appendSessionEvent(session.id, { authorType: "member", body: "Visible Session request" });
        const task = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Execute this Session" });
        expect(task).toMatchObject({ issueSessionId: session.id, chatSessionId: chat?.id ?? null, issueId: issue?.id ?? null });
        const claimed = store.claimTask(runtime.id)!;
        expect(claimed.id).toBe(task.id);
        const wire = daemonTaskClaimResponse(store, claimed);
        expect(wire.session_projection).toMatchObject({ session_id: session.id, mode: "bootstrap" });
        expect(wire.issue_session).toMatchObject({ ownerType: owner, ownerId: chat?.id ?? issue!.id });
        expect(taskRealtimePayload(task)).toMatchObject({ issue_session_id: session.id });
        const daemonTask = { ...claimed, issueSession: session, agent } as any;
        expect(resolveIssueSessionProviderHome(daemonTask, "/tmp/work", "/tmp/session-workspaces")?.sessionId).toBe(session.id);
        expect(resolveWorkDir(daemonTask, "/tmp/session-workspaces").workDir)
          .toBe(owner === "issue" ? `/tmp/session-workspaces/issues/${issue!.key}` : `/tmp/session-workspaces/chats/${chat!.id}`);
        store.startTask(task.id);
        if (status === "completed") store.completeTask(task.id, { output: "Durable result", sessionId: "provider_result", workDir: "/tmp/work" });
        else if (status === "failed") store.failTask(task.id, { error: "boom" });
        else store.cancelTask(task.id);

        const terminal = store.listSessionEvents(session.id).filter(event => event.taskId === task.id && event.kind === `task_${status}`);
        expect(terminal).toHaveLength(1);
        expect(store.findTurnEntry(task.id)).toMatchObject({ session_id: session.id, metadata: { status } });
        expect(store.listChatSessions("local", { includeArchived: true })).toHaveLength(chatsBefore);
        if (chat) expect(store.listChatMessages(chat.id)).toHaveLength(0);
        if (status === "completed") {
          const turn = store.findTurnEntry(task.id)!;
          if (issue) expect(store.getIssueComment(String(turn.metadata.final_entry_id))?.body).toBe("Durable result");
          else expect(turn.metadata.final_reply_md).toBe("Durable result");
          expect(store.getSessionAgentLane(session.id, agent.id)).toMatchObject({ providerSessionId: "provider_result", lastTaskId: task.id });
          expect(() => store.completeTask(task.id, { output: "Duplicate reply" })).toThrow("Task not found or terminal");
          expect(store.listSessionEvents(session.id).filter(event => event.taskId === task.id && event.kind === "task_completed")).toHaveLength(1);
        }
      });
    }

    it(`rejects an archived ${owner} Session through the common Task funnel`, () => {
      const { store, agent, session } = fixture(owner);
      store.updateIssueSession(session.id, { status: "archived" });
      const tasksBefore = store.listTasks().length;
      expect(() => store.createTask({ agentId: agent.id, issueSessionId: session.id, prompt: "Bypass Session API" }))
        .toThrow("Session is archived");
      expect(store.listTasks()).toHaveLength(tasksBefore);
    });
  }

  for (const status of ["completed", "failed"] as const) {
    it(`keeps a projected Chat Session's ${status} body out of public Issue comments and activity`, () => {
      const { store, runtime, agent, issue, session } = fixture("chat", true);
      const task = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Private projected request" });
      expect(store.claimTask(runtime.id)?.id).toBe(task.id);
      store.startTask(task.id);
      const privateBody = `private-chat-${status}-content`;
      if (status === "completed") store.completeTask(task.id, { output: privateBody });
      else if (status === "failed") store.failTask(task.id, { error: privateBody });
      const publicComments = store.listIssueComments(issue!.id);
      const publicActivity = db!.query("SELECT body, data FROM multiremi_issue_activity WHERE issue_id = ?").all(issue!.id);
      expect(JSON.stringify(publicComments)).not.toContain(privateBody);
      expect(JSON.stringify(publicActivity)).not.toContain(privateBody);
      const turn = store.findTurnEntry(task.id)!;
      expect(turn).toMatchObject({ session_id: session.id, metadata: { status } });
      if (status === "completed") expect(turn.metadata.final_reply_md).toBe(privateBody);
      else expect(store.listSessionEvents(session.id).find(event => event.taskId === task.id && event.kind === `task_${status}`)?.body)
        .toBe(privateBody);
    });
  }

  it("rejects a different Chat, Issue, or workspace without leaving Task or lane state", () => {
    const { store, agent, issue, chat, session } = fixture("chat", true);
    const otherChat = store.createChatSession({ agentId: agent.id });
    const issueOwned = store.getOrCreateDefaultIssueSession(issue!.id);
    const otherIssue = store.createIssue({ title: "Another Issue" });
    const workspace = store.createWorkspace({ name: "Other workspace", slug: "other-workspace" });
    const foreignAgent = store.createAgent({ name: "Foreign worker", provider: "claude", workspaceId: workspace.id });
    const tasksBefore = store.listTasks().length;
    for (const input of [
      { agentId: agent.id, issueSessionId: session.id, chatSessionId: otherChat.id },
      { agentId: agent.id, issueSessionId: issueOwned.id, chatSessionId: chat!.id },
      { agentId: agent.id, issueSessionId: session.id, issueId: otherIssue.id },
      { agentId: foreignAgent.id, issueSessionId: session.id },
    ]) expect(() => store.createTask({ ...input, prompt: "Invalid owner" })).toThrow();
    expect(store.listTasks()).toHaveLength(tasksBefore);
    expect(store.getSessionAgentLane(session.id, agent.id)).toBeNull();
    expect(store.getSessionAgentLane(issueOwned.id, agent.id)).toBeNull();
  });

  it("checks each owner's archive state while preserving a Chat's optional Issue projection", () => {
    const { store, agent, issue, chat, session } = fixture("chat", true);
    const issueOwned = store.getOrCreateDefaultIssueSession(issue!.id);
    db!.run("UPDATE multiremi_issues SET archived_at = ? WHERE id = ?", [new Date().toISOString(), issue!.id]);
    expect(() => store.createTask({ agentId: agent.id, issueSessionId: issueOwned.id, prompt: "Archived Issue owner" }))
      .toThrow("Issue is archived");
    expect(store.createTask({ agentId: agent.id, issueSessionId: session.id, prompt: "Live Chat owner" }).chatSessionId).toBe(chat!.id);
    store.updateChatSession(chat!.id, { status: "archived" });
    expect(() => store.createTask({ agentId: agent.id, issueSessionId: session.id, prompt: "Archived Chat owner" }))
      .toThrow("Chat session is archived");
  });

  it("keeps public Issue snapshots visible while restricting private Chat rows to the authenticated Task", () => {
    const { store, agent, issue, chat, session } = fixture("chat", true);
    const issueSession = store.getOrCreateDefaultIssueSession(issue!.id);
    const siblingSession = store.createIssueSession(issue!.id, { title: "Issue sibling" });
    const siblingAgent = store.createAgent({ name: "Snapshot sibling", provider: "claude" });
    const ownChatTask = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Private snapshot task" });
    const ownIssueTask = store.createSessionTask(issueSession.id, { agentId: agent.id, prompt: "Issue snapshot task" });
    const siblingTask = store.createSessionTask(siblingSession.id, { agentId: siblingAgent.id, prompt: "Sibling snapshot task" });
    store.createTask({ agentId: agent.id, chatSessionId: chat!.id, prompt: "Ordinary Chat snapshot task" });

    const publicIds = [ownIssueTask.id, siblingTask.id].sort();
    for (const task of [ownChatTask, ownIssueTask]) {
      const access = { userId: null, taskToken: { taskId: task.id, agentId: task.agentId, workspaceId: task.workspaceId } };
      const expected = [...publicIds, ...(task === ownChatTask ? [task.id] : [])].sort();
      expect(store.listActiveTasksForIssue(issue!.id, access).map(entry => entry.id).sort()).toEqual(expected);
      expect(store.listWorkspaceAgentTaskSnapshot("local", access).map(entry => entry.id).sort()).toEqual(expected);
      const wrongAgent = { ...access, taskToken: { ...access.taskToken, agentId: siblingAgent.id } };
      expect(store.listActiveTasksForIssue(issue!.id, wrongAgent).map(entry => entry.id).sort()).toEqual(publicIds);
      expect(store.listWorkspaceAgentTaskSnapshot("local", wrongAgent).map(entry => entry.id).sort()).toEqual(publicIds);
      const wrongWorkspace = { ...access, taskToken: { ...access.taskToken, workspaceId: "another-workspace" } };
      expect(store.listActiveTasksForIssue(issue!.id, wrongWorkspace).map(entry => entry.id).sort()).toEqual(publicIds);
      expect(store.listWorkspaceAgentTaskSnapshot("local", wrongWorkspace).map(entry => entry.id).sort()).toEqual(publicIds);
    }
    // A damaged Task pointer cannot turn its actual private Session into a
    // public Issue Task in either SQL entry point.
    db!.run("UPDATE multiremi_tasks SET chat_session_id = NULL WHERE id = ?", [ownChatTask.id]);
    const access = { userId: null, taskToken: { taskId: ownIssueTask.id, agentId: agent.id, workspaceId: "local" } };
    expect(store.listActiveTasksForIssue(issue!.id, access).map(entry => entry.id).sort()).toEqual(publicIds);
    expect(store.listWorkspaceAgentTaskSnapshot("local", access).map(entry => entry.id).sort()).toEqual(publicIds);
  });

  for (const firstSurface of ["ordinary", "session-a", "session-b", "topic"] as const) {
    it(`leases the shared Chat checkout across Agents when ${firstSurface} starts first`, () => {
      const store = createLocalStore();
      const runtime = store.registerRuntime({ name: "Chat checkout lease", provider: "claude", workspaceId: "local", maxConcurrency: 10 });
      const agents = ["Ordinary", "Session A", "Session B", "Other Chat", "Issue"].map(name =>
        store.createAgent({ name, provider: "claude", runtimeId: runtime.id, maxConcurrentTasks: 10 }));
      const chat = store.createChatSession({ agentId: agents[0]!.id });
      const sessionA = store.getOrCreateDefaultChatSession(chat.id);
      const sessionB = store.createSession(chat.id, { title: "Independent Session B" });
      const issue = store.createIssue({ title: "Independent Issue owner" });
      if (firstSurface === "topic") bindFeishuTopicFixture(store, db!, chat.id, issue.id);
      const ordinary = store.createTask({ agentId: agents[0]!.id, chatSessionId: chat.id,
        ...(firstSurface === "topic" ? { issueId: issue.id, holdsWorkspace: false } : {}),
        prompt: "Ordinary Chat request", priority: firstSurface === "ordinary" || firstSurface === "topic" ? 100 : 30 });
      const taskA = store.createSessionTask(sessionA.id, { agentId: agents[1]!.id, prompt: "Session A request", priority: firstSurface === "session-a" ? 100 : 20 });
      const taskB = store.createSessionTask(sessionB.id, { agentId: agents[2]!.id, prompt: "Session B request", priority: firstSurface === "session-b" ? 100 : 10 });
      const sharedTasks = [ordinary, taskA, taskB];
      for (const task of sharedTasks) {
        expect(resolveWorkDir(store.getTaskWithAgent(task.id)! as any, "/tmp/chat-lease-workspaces").workDir)
          .toBe(`/tmp/chat-lease-workspaces/chats/${chat.id}`);
      }
      const first = firstSurface === "session-a" ? taskA : firstSurface === "session-b" ? taskB : ordinary;
      expect(store.claimTask(runtime.id)?.id).toBe(first.id);
      // A dispatched offer already holds the lease before the start ACK.
      expect(store.claimTask(runtime.id)).toBeNull();
      store.startTask(first.id);
      expect(store.claimTask(runtime.id)).toBeNull();
      expect(sharedTasks.filter(task => task.id !== first.id).map(task => store.getTask(task.id)!.status)).toEqual(["queued", "queued"]);

      const otherChat = store.createChatSession({ agentId: agents[3]!.id });
      const otherChatTask = store.createTask({ agentId: agents[3]!.id, chatSessionId: otherChat.id, prompt: "Other Chat request", priority: 50 });
      const issueTask = store.createSessionTask(store.getOrCreateDefaultIssueSession(issue.id).id,
        { agentId: agents[4]!.id, prompt: "Issue-owned request", priority: 40 });
      expect(store.claimTask(runtime.id)?.id).toBe(otherChatTask.id);
      expect(store.claimTask(runtime.id)?.id).toBe(issueTask.id);
      expect(store.claimTask(runtime.id)).toBeNull();

      store.completeTask(first.id, { output: "Shared checkout lease released" });
      const remaining = sharedTasks.filter(task => task.id !== first.id).sort((left, right) => right.priority - left.priority);
      for (const task of remaining) {
        expect(store.claimTask(runtime.id)?.id).toBe(task.id);
        expect(store.claimTask(runtime.id)).toBeNull();
        store.startTask(task.id);
        store.completeTask(task.id, { output: "Next shared checkout request completed" });
      }
      expect(store.getTask(otherChatTask.id)?.status).toBe("dispatched");
      expect(store.getTask(issueTask.id)?.status).toBe("dispatched");
    });
  }

  for (const outcome of ["unknown", "rejected"] as const) {
    it(`${outcome === "unknown" ? "retains" : "releases"} the shared Chat lease after an ${outcome} offer requeue`, () => {
      const { store, runtime, agent, chat, session } = fixture("chat");
      store.updateRuntime(runtime.id, { maxConcurrency: 10 });
      const otherAgent = store.createAgent({ name: "Other Session offer", provider: "claude", runtimeId: runtime.id });
      const otherSession = store.createSession(chat!.id, { title: "Other Session offer" });
      const offered = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Original offered request", priority: 10 });
      expect(store.claimTask(runtime.id)?.id).toBe(offered.id);
      expect(store.recordTaskOffered(offered.id, runtime.id)).toBe(true);
      expect(store.requeueTaskOffer(offered.id, runtime.id, outcome)).toBe(true);
      const other = store.createSessionTask(otherSession.id, { agentId: otherAgent.id, prompt: "Higher priority request", priority: 100 });
      const authority = { runtimeId: runtime.id, workspaceId: "local", daemonId: runtime.id };

      if (outcome === "unknown") {
        expect(store.getTask(offered.id)?.offeredAt).not.toBeNull();
        // The old offer can be reclaimed without treating itself as a blocker.
        expect(store.claimTask(runtime.id)?.id).toBe(offered.id);
        expect(store.requeueTaskOffer(offered.id, runtime.id, "unknown")).toBe(true);
        expect(store.getTask(other.id)?.status).toBe("queued");
        expect(() => store.startTaskFromDaemon(other.id, authority)).toThrow("server_error");
        expect(store.startTaskFromDaemon(offered.id, authority)).toBe("started");
        expect(store.claimTask(runtime.id)).toBeNull();
        store.completeTask(offered.id, { output: "Original offer completed" });
        expect(store.claimTask(runtime.id)?.id).toBe(other.id);
      } else {
        expect(store.getTask(offered.id)?.offeredAt).toBeNull();
        expect(store.claimTask(runtime.id)?.id).toBe(other.id);
        expect(() => store.startTaskFromDaemon(offered.id, authority)).toThrow("server_error");
      }
    });
  }

  for (const release of ["rejected", "completed"] as const) {
    it(`replays a reserved ordinary Chat offer before a newer higher priority request until ${release}`, () => {
      const { store, runtime, agent, chat } = fixture("chat");
      store.updateRuntime(runtime.id, { maxConcurrency: 10 });
      store.updateAgent(agent.id, { maxConcurrentTasks: 10 });
      const offered = store.createTask({ agentId: agent.id, chatSessionId: chat!.id, prompt: "Reserved ordinary Chat offer", priority: 10 });
      expect(offered.issueSessionId).toBeNull();
      expect(store.claimTask(runtime.id)?.id).toBe(offered.id);
      expect(store.recordTaskOffered(offered.id, runtime.id)).toBe(true);
      expect(store.requeueTaskOffer(offered.id, runtime.id, "unknown")).toBe(true);
      const newer = store.createTask({ agentId: agent.id, chatSessionId: chat!.id, prompt: "New higher priority Chat request", priority: 100 });
      // The existing reservation must be replayable even while the ordinary
      // queue head is the newer request, which cannot take its occupied root.
      expect(store.claimTask(runtime.id)?.id).toBe(offered.id);
      expect(store.claimTask(runtime.id)).toBeNull();
      expect(store.getTask(newer.id)?.status).toBe("queued");

      if (release === "rejected") {
        expect(store.requeueTaskOffer(offered.id, runtime.id, "rejected")).toBe(true);
        expect(store.getTask(offered.id)?.offeredAt).toBeNull();
      } else {
        store.startTask(offered.id);
        store.completeTask(offered.id, { output: "Reserved Chat offer completed" });
      }
      expect(store.claimTask(runtime.id)?.id).toBe(newer.id);
      expect(store.getTask(newer.id)?.priority).toBe(100);
      expect(store.getTask(offered.id)?.priority).toBe(10);
    });
  }

  it("shares published results only with the actual Session owner and its public Issue work", () => {
    const { store, runtime, agent, issue, chat, session } = fixture("chat", true);
    const ownSibling = store.createSession(chat!.id, { title: "Unprojected sibling" });
    const otherChat = store.createChatSession({ agentId: agent.id, creatorId: "another-user" });
    const privateSibling = store.createIssueSession(issue!.id, { chatId: otherChat.id, title: "Private projected sibling" });
    const issueSibling = store.getOrCreateDefaultIssueSession(issue!.id);
    const publicSibling = store.createIssueSession(issue!.id, { title: "Public Issue sibling" });
    const own = store.publishSessionResult(ownSibling.id, { title: "Own Chat result", body: "Own curated evidence" });
    const privateResult = store.publishSessionResult(privateSibling.id, { title: "Private result", body: "Private evidence" });
    const publicResult = store.publishSessionResult(publicSibling.id, { title: "Issue result", body: "Public curated evidence" });
    for (const [target, expected] of [[session, [own.id, publicResult.id]], [issueSibling, [publicResult.id]], [ownSibling, []]] as const) {
      const task = store.createSessionTask(target.id, { agentId: agent.id, prompt: "Read curated sibling results" });
      const claimed = store.claimTask(runtime.id)!;
      expect(claimed.id).toBe(task.id);
      const wire = daemonTaskClaimResponse(store, claimed);
      const results = wire.issue_session_results as { id: string }[];
      expect(results.map(result => result.id).sort()).toEqual([...expected].sort());
      expect(results.map(result => result.id)).not.toContain(privateResult.id);
      const prompt = buildTaskPrompt({ ...claimed, issueSession: target, sessionProjection: wire.session_projection,
        issueSessionResults: results, agent } as any);
      const publishCommand = target.chatId
        ? `remi session result publish ${target.chatId} ${target.id}`
        : `remi issue session result publish ${issue!.id} ${target.id}`;
      expect(prompt).toContain(publishCommand);
      store.cancelTask(task.id);
    }
  });
});
