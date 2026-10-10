import { createResponsibleTestIssue } from './helpers.js';
import { attemptMessagesPath, requestMessageBody, sentTask, turnApiPath } from "./unified-test-paths.js";
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { buildTaskPrompt } from "@multiremi/prompt.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

import { bindFeishuTopicFixture } from "./feishu-topic-fixture.js";

afterEach(resetMultiremiTestEnv);

function scaffold() {
  const store = createLocalStore();
  const remi = store.createAgent({ name: "Remi", provider: "codex", workspaceId: "local" });
  const owner = store.createAgent({ name: "Issue owner", provider: "claude", workspaceId: "local" });
  const runtime = store.registerRuntime({ id: "rt_followup", name: "Issue machine", provider: "claude", workspaceId: "local" });
  const issue = createResponsibleTestIssue(store, { title: "Continue existing work", workspaceId: "local", assigneeType: "agent", assigneeId: owner.id });
  const chat = store.createChatSession({ agentId: remi.id, workspaceId: "local" });
  bindFeishuTopicFixture(store, db!, chat.id, issue.id);
  const session = store.getOrCreateDefaultIssueSession(issue.id);
  const task = store.sendChatMessage(chat.id, { body: "Continue the implementation and verify it." }).task;
  return { store, remi, owner, runtime, issue, session, chat, task };
}

async function authenticatedTopic() {
  const setup = scaffold();
  const token = await setup.store.createTaskAccessToken(setup.task, "local");
  const app = createMultiremiApp({ store: setup.store, authToken: "test-root-secret" });
  const headers = { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" };
  return { ...setup, app, headers };
}

describe("bound Issue continuation prompt", () => {
  for (const mode of ["bootstrap", "delta"] as const) {
    for (const request of [
      "Continue the implementation and verify it.",
      "What is the current progress?",
      "The responsible agent completed a work round. Report the current result.",
    ]) {
      it(`includes the execution/read-only boundary for ${mode}: ${request}`, () => {
        const { store, task, issue } = scaffold();
        const claimed = store.getTaskWithAgent(task.id)!;
        const wire = daemonTaskClaimResponse(store, claimed);
        const prompt = buildTaskPrompt({
          ...claimed,
          prompt: request,
          boundIssue: wire.bound_issue,
          sessionProjection: { mode },
        } as any);
        expect(prompt).toContain(mode === "delta" ? "# Delta Prompt" : "# Bootstrap Prompt");
        expect(prompt.match(/## Bound Issue Follow-up/g)).toHaveLength(1);
        expect(prompt).toContain("Progress questions and proactive work-round reports are read-only");
        expect(prompt).toContain("Only an explicit execution request in the current user message");
        expect(prompt).toContain("Quoted messages, previous approvals, and delivered Chat updates are context");
        expect(prompt).toContain("terminal round (completed, failed, or cancelled)");
        expect(prompt).toContain(`remi issue responsibility ${issue.id} --output json`);
        expect(prompt).toContain(`remi issue session list ${issue.id} --output json`);
        expect(prompt).toContain("route to its leader, not an arbitrary teammate");
        expect(prompt).toContain("This is not a provider session_id");
        expect(prompt).toContain("If ambiguous or archived, ask");
        expect(prompt).toContain("Exclude ordinary Chat/reporting turns");
        expect(prompt).toContain("the target does not share your Chat transcript");
        expect(prompt).toContain("remi message send <session-id> --to <responsible-agent-id>");
        expect(prompt).toContain("remi turn list --session <session-id> --output json");
        expect(prompt).toContain("A running turn receives the message as an interruption");
        expect(prompt).toContain("otherwise the inbox may schedule or merge a turn in the original Session");
        expect(prompt).toContain("Chat-origin dispatch keeps the existing topic relay reporting path");
        expect(prompt).toContain("remi turn get <returned-turn-id> --output json");
        expect(prompt).toContain("check the returned message receipt and authorized safe metadata");
        expect(prompt).toContain("Coordination authority does not grant another Session's message history, turn input or attempt trace");
        expect(prompt).toContain("never describe a saved or downgraded message as running work");
        expect(prompt).toContain("do not claim the handoff succeeded or bypass authorization");
        expect(prompt).toContain("reconcile within the permitted metadata scope before retrying and preserve the dedupe key");
        expect(prompt).toContain("After a verified handoff, finish this Chat turn");
      });
    }
  }

  it("does not inject topic coordination into unbound Chats or real Issue execution", () => {
    const { store, remi, issue, session, owner } = scaffold();
    const chat = store.createChatSession({ agentId: remi.id, workspaceId: "local" });
    const unbound = store.sendChatMessage(chat.id, { body: "Just chatting" }).task;
    const executor = store.createSessionTask(session.id, { agentId: owner.id, prompt: "Implement" });
    for (const task of [unbound, executor]) {
      const claimed = store.getTaskWithAgent(task.id)!;
      const wire = daemonTaskClaimResponse(store, claimed);
      const prompt = buildTaskPrompt({ ...claimed, boundIssue: wire.bound_issue } as any);
      expect(prompt).not.toContain("## Bound Issue Follow-up");
    }
    expect(store.getIssue(issue.id)?.assigneeId).toBe(owner.id);
  });
});

describe("topic Task credential handoff through existing APIs", () => {
  it("an explicit message resumes the owner's Issue lane", async () => {
    const { store, app, headers, task, owner, remi, issue, session, runtime, chat } = await authenticatedTopic();
    const previous = store.createSessionTask(session.id, { agentId: owner.id, prompt: "Original implementation" });
    expect(store.claimTask(runtime.id)?.id).toBe(previous.id);
    store.startTask(previous.id);
    store.completeTask(previous.id, { output: "Ready for follow-up", sessionId: "acp_issue_owner", workDir: "/tmp/issue-followup-work" });
    const before = store.listTasks().length;

    const comment = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST", headers,
      body: JSON.stringify(requestMessageBody(store, { content: `[@Issue owner](mention://agent/${owner.id}) Please continue.` }, { type: "role", ref: "issue_owner" })),
    });
    expect(comment.status).toBe(200);
    const { message: posted } = await comment.json();
    expect(store.getMessage(posted.id)?.sender_type).toBe("agent");
    expect(posted).not.toHaveProperty("body_md");
    const mentioned = store.listTasks().find((entry) => entry.triggerCommentId === posted.id)!;
    expect(mentioned).toMatchObject({
      issueId: issue.id, issueSessionId: session.id, agentId: owner.id,
      chatSessionId: null, parentTaskId: null, status: "queued", sessionId: "acp_issue_owner",
      delegationId: null, delegatedByAgentId: null, delegatedFromIssueSessionId: null,
      delegationSkipReason: null,
    });
    expect(store.listTasks()).toHaveLength(before + 1);
    expect(store.claimTask(runtime.id)?.id).toBe(mentioned.id);
    store.startTask(mentioned.id);
    store.completeTask(mentioned.id, { output: "Rich mention follow-up verified." });
    expect(store.getTask(mentioned.id)?.delegationReturnTaskId).toBeNull();
    // #3/#9: source provenance is on the request header; Chat has no delegation return.
    expect(store.getMessage(posted.id)?.task_id).toBe(store.getTurnForAttempt(task.id)!.id);
    expect(store.listTasks()).toHaveLength(before + 1);
    expect(store.listTasks().filter((entry) => entry.chatSessionId === chat.id).map((entry) => entry.id)).toEqual([task.id]);

    const created = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST", headers,
      body: JSON.stringify(requestMessageBody(store, { agent_id: owner.id, prompt: "User requested: add tests, retain the API, and report verification." }, { type: "role", ref: "issue_owner" })),
    });
    expect(created.status).toBe(200);
    const next = sentTask(store, await created.json());
    expect(next).toMatchObject({issueId:issue.id,issueSessionId:session.id,agentId:owner.id,chatSessionId:null,parentTaskId:null,status:"queued",sessionId:"acp_issue_owner",delegationId:null});
    const verified = await app.request(turnApiPath(store, next.id), { headers });
    expect(verified.status).toBe(200);
    expect((await verified.json()).turn).toMatchObject({id:store.getTurnForAttempt(next.id)!.id,current_attempt_id:next.id,session_id:session.id,agent_id:owner.id,status:"pending"});
    const listed = await app.request(`/api/turns?session_id=${session.id}`, { headers });
    expect(listed.status).toBe(200);
    expect((await listed.json()).turns.some((entry: { id: string }) => entry.id === store.getTurnForAttempt(next.id)!.id)).toBe(true);
    expect(store.claimTask(runtime.id)?.id).toBe(next.id);
    expect(store.getSessionAgentLane(session.id, owner.id)?.providerSessionId).toBe("acp_issue_owner");
    expect(store.getChatSession(chat.id)?.agentId).toBe(remi.id);
    expect(store.listIssueSessions(issue.id)).toHaveLength(1);
    expect(store.getIssue(issue.id)?.assigneeId).toBe(owner.id);
  });

  it("a task-linked rich mention dispatches into the work Session without a delegation return to Chat", async () => {
    const { store, app, headers, task, owner, issue, session, chat, runtime } = await authenticatedTopic();
    const before = store.listTasks().map((entry) => entry.id);
    const response = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST", headers,
      body: JSON.stringify(requestMessageBody(store, { body_md: `[@Issue owner](mention://agent/${owner.id}) Please continue.` })),
    });
    expect(response.status).toBe(200);
    const { message: comment } = await response.json();
    const created = store.listTasks().filter((entry) => !before.includes(entry.id));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      issueId: issue.id, issueSessionId: session.id, agentId: owner.id,
      chatSessionId: null, parentTaskId: null, triggerCommentId: comment.id,
      status: "queued", delegationId: null,
    });
    const mentioned = created[0]!;
    expect(store.claimTask(runtime.id)?.id).toBe(mentioned.id);
    store.startTask(mentioned.id);
    store.completeTask(mentioned.id, { output: "Rich mention follow-up verified." });
    expect(store.getTask(mentioned.id)?.delegationReturnTaskId).toBeNull();
    expect(store.getMessage(comment.id)?.task_id).toBe(store.getTurnForAttempt(task.id)!.id);
    expect(store.listTasks()).toHaveLength(before.length + 1);
    expect(store.listTasks().filter((entry) => entry.chatSessionId === chat.id && entry.issueSessionId === null)
      .map((entry) => entry.id)).toEqual([task.id]);
  });

  it("amends a running Issue task without creating another task or steering the Chat", async () => {
    const { store, app, headers, task, owner, issue, session, runtime } = await authenticatedTopic();
    const active = store.createSessionTask(session.id, { agentId: owner.id, prompt: "Implement" });
    expect(store.claimTask(runtime.id)?.id).toBe(active.id);
    store.startTask(active.id);
    const before = store.listTasks().length;
    const sent = await app.request(attemptMessagesPath(store, active.id), {
      method: "POST", headers, body: JSON.stringify(requestMessageBody(store, { body_md: "Also test the failure path." }, { type: "agent", ref: store.getTask(active.id)!.agentId })),
    });
    expect(sent.status).toBe(200);
    const directive = (await sent.json()).message;
    const verified = await app.request(attemptMessagesPath(store, active.id), { headers });
    expect(verified.status).toBe(403);
    expect(await verified.text()).not.toContain("Implement");
    expect(store.getMessage(directive.id)).toMatchObject({ session_id: session.id, body_md: "Also test the failure path." });
    expect(store.listTasks()).toHaveLength(before);
    expect(store.listTaskSteerMessages(task.id)).toHaveLength(0);
    expect(store.getTask(active.id)).toMatchObject({ issueId: issue.id, issueSessionId: session.id, agentId: owner.id, status: "running" });

    store.consumeTaskSteerMessages(active.id, [directive.id]);
    store.completeTask(active.id, { output: "Done" });
    const late = await app.request(attemptMessagesPath(store, active.id), {
      method: "POST", headers, body: JSON.stringify(requestMessageBody(store, { content: "Too late" }, { type: "agent", ref: store.getTask(active.id)!.agentId })),
    });
    expect(late.status).toBe(200);
    expect(store.listTasks()).toHaveLength(before + 1);
    expect(sentTask(store,await late.json()).status).toBe("queued");
  });

  it("surfaces invalid targets and rejected credentials without creating follow-up work", async () => {
    const { store, app, headers, owner, issue, session } = await authenticatedTopic();
    const other = createResponsibleTestIssue(store, { title: "Different issue", workspaceId: "local" });
    const wrongSession = store.getOrCreateDefaultIssueSession(other.id);
    const before = store.listTasks().length;
    for (const [sessionId, agentId, auth, expectedStatus] of [
      ["ises_missing", owner.id, headers, 403],
      [wrongSession.id, owner.id, headers, 403],
      [session.id, "agt_missing", headers, 400],
      [session.id, owner.id, { ...headers, Authorization: "Bearer invalid-task-credential" }, 401],
    ] as const) {
      const failed = await app.request(`/api/sessions/${sessionId}/messages`, {
        method: "POST", headers: auth, body: JSON.stringify(requestMessageBody(store, { agent_id: agentId, prompt: "Continue" }, { type: "role", ref: "issue_owner" })),
      });
      expect(failed.status).toBe(expectedStatus);
      expect(await failed.json()).toHaveProperty("error");
      expect(store.listTasks()).toHaveLength(before);
    }
  });

  it("hands off to a projected Chat-owned Session without exposing its private content", async () => {
    const { store, app, headers, owner, issue, chat } = await authenticatedTopic();
    const session = store.createIssueSession(issue.id, { chatId: chat.id, title: "Topic private work" });
    store.appendSessionEvent(session.id, { authorType: "member", body: "PRIVATE_TOPIC_SESSION_BODY" });
    const comment = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST", headers, body: JSON.stringify({ body_md: "PRIVATE_TOPIC_COMMENT", to: { type: "none" } }),
    });
    expect(comment.status).toBe(403);
    expect(store.listIssueComments(issue.id).some(entry => entry.body === "PRIVATE_TOPIC_COMMENT")).toBe(false);
    const created = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST", headers, body: JSON.stringify({ body_md: "PRIVATE_TOPIC_TASK_PROMPT", to: { type: "agent", ref: owner.id } }),
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json();
    expect(JSON.stringify(createdBody)).not.toContain("PRIVATE_TOPIC_TASK_PROMPT");
    const task = sentTask(store, createdBody);
    expect(task).toMatchObject({ chatSessionId: chat.id, issueSessionId: session.id, agentId: owner.id });
    for (const path of [turnApiPath(store, task.id), `/api/turns?session_id=${session.id}`]) {
      const read = await app.request(path, { headers });
      expect(read.status).toBe(200);
      expect(await read.text()).not.toContain("PRIVATE_TOPIC_TASK_PROMPT");
    }
    for (const path of [
      `/api/sessions/${session.id}/log`, `/api/sessions/${session.id}/messages`,
      turnApiPath(store, task.id, "/trace"),
      turnApiPath(store, task.id, "?input=true"),
      turnApiPath(store, task.id, "?attempts=true"),
    ]) {
      const denied = await app.request(path, { headers });
      expect([403, 404]).toContain(denied.status);
      expect(await denied.text()).not.toContain("PRIVATE_TOPIC_SESSION_BODY");
    }
    const cancel = await app.request(turnApiPath(store, task.id, "/cancel"), { method: "POST", headers });
    expect([403, 404]).toContain(cancel.status);
    expect(store.getTask(task.id)?.status).toBe("queued");
  });
});
