import { createResponsibleTestIssue } from './helpers.js';
import { issueMessagesPath, requestMessageBody, taskRequestPath, sentTask, mutateExecutionFixture } from "./unified-test-paths.js";
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { bindFeishuTopicFixture } from "./feishu-topic-fixture.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

async function fixture(topic = false) {
  const store = createLocalStore();
  const agent = store.createAgent({ name: "Chat worker", provider: "codex" });
  const executor = store.createAgent({ name: "Project executor", provider: "claude" });
  const project = store.createProject({
    title: "Former Chat project",
    defaultAssigneeType: "agent",
    defaultAssigneeId: executor.id,
  });
  const issue = createResponsibleTestIssue(store, {
    title: "Former Chat Issue", projectId: project.id, issueKind: "intake",
    assigneeType: "agent", assigneeId: executor.id,
  });
  const defaultSession = store.getOrCreateDefaultIssueSession(issue.id);
  const session = store.createIssueSession(issue.id, { title: "Original task session" });
  const chat = store.createChatSession({ agentId: agent.id, creatorId: "local" });
  if (topic) {
    // This Chat's technical creator is not its verified external human source.
    const runtime=store.registerRuntime({name:'Synthetic transport host',provider:'codex',workspaceId:'local'});
    const previousKey=process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
    process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY=Buffer.alloc(32,19).toString('base64');
    try {
      store.upsertFeishuBotConfig('local',{agentId:agent.id,runtimeId:runtime.id,domain:'feishu',appId:'synthetic-isolation',appSecretOp:'set',appSecret:'synthetic-test-only',
        enabled:false,responsibleMemberId:store.resolveIssueResponsibility(issue.id).rootHuman!.id});
    } finally {
      if(previousKey===undefined)delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
      else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY=previousKey;
    }
    bindFeishuTopicFixture(store, db!, chat.id, issue.id);
  }
  const task = store.sendChatMessage(chat.id, { body: "Continue the conversation" }).task;
  // Model the persisted audit row of a task already running when the migration
  // detaches its ordinary Chat. The task credential remains valid for this run.
  // A retained Chat turn has one canonical session; its old Issue is audit data.
  db!.run("UPDATE multiremi_turns SET status='running',issue_id=?,session_id=? WHERE current_attempt_id=?", [issue.id,chat.id,task.id]);
  db!.run("UPDATE multiremi_turn_attempts SET status='running' WHERE id=?",[task.id]);
  const token = await store.createTaskAccessToken(store.getTask(task.id)!, "local");
  const app = createMultiremiApp({ store, authToken: "request-isolation-root" });
  const headers = { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" };
  return { store, app, headers, agent, executor, project, issue, defaultSession, session, chat, task };
}

describe("Chat task request isolation", () => {
  it("uses the Chat conversation and ignores a body-supplied Issue without creating a turn", async () => {
    const { store, app, headers, agent, issue, chat } = await fixture();
    const before = store.listTasks().length;
    const response = await app.request(taskRequestPath(store, { chatSessionId: chat.id, issueId: issue.id }), {
      method: "POST", headers,
      body: JSON.stringify(requestMessageBody(store, { agentId: agent.id, chatSessionId: chat.id, prompt: "Try attaching an Issue", issueId: issue.id })),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).message).toMatchObject({session_id:chat.id,wake_reason:"self"});
    expect(store.listTasks()).toHaveLength(before);
  });

  it("ignores a body-supplied trigger comment instead of deriving an Issue from it", async () => {
    const { store, app, headers, agent, issue, chat } = await fixture();
    // MUL-448: `trigger_comment_id` is server-derived (the mention dispatcher
    // calls the repo directly), so the public task route strips it. That also
    // removes the old path where a body could pull an Issue into a Chat task.
    const comment = store.createIssueComment(issue.id, { authorType: "member", authorId: "local", body: "Issue trigger" });
    for (const spelling of ["triggerCommentId", "trigger_comment_id"] as const) {
      const response = await app.request(taskRequestPath(store, { chatSessionId: chat.id }), {
        method: "POST", headers,
        body: JSON.stringify(requestMessageBody(store, {
          agentId: agent.id,
          chatSessionId: chat.id,
          prompt: "Try attaching an Issue",
          [spelling]: comment.id,
        })),
      });
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.message).toMatchObject({session_id:chat.id,wake_reason:"self"});
      expect(result.message.reply_to_id).toBeNull();
      expect(result.turn_id).toBeUndefined();
    }
  });

  it("keeps the old running audit row but exposes no Issue or Issue Session through CLI context", async () => {
    const { store, app, headers, issue, session, chat, task } = await fixture();
    expect(store.getTask(task.id)).toMatchObject({ status: "running", issueId: issue.id, issueSessionId: null });

    const response = await app.request("/api/cli/context", { headers });
    expect(response.status).toBe(200);
    expect((await response.json()).current).toMatchObject({
      task: { id: task.id, status: "running", issue_id: null, session_id: null, chat_id: chat.id },
      issue: null,
      session: null,
      project: null,
      chat: { id: chat.id },
    });
    expect(store.getTask(task.id)).toMatchObject({ issueId: issue.id, issueSessionId: null });
  });

  it("does not inherit the old intake Issue, project, or project assignee when the running Chat creates an Issue", async () => {
    const { store, app, headers, task, issue, chat } = await fixture();
    const human = store.findWorkspaceMemberForUser(chat.creatorId!, chat.workspaceId)!;
    expect(human.id).not.toBe(issue.responsibleMemberId);
    for (const input of [{}, { project_id: null }]) {
      const response = await app.request("/api/issues", {
        method: "POST", headers,
        body: JSON.stringify({ title: "Independent new Issue", ...input }),
      });
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body).toMatchObject({ project_id: null, source_issue_id: null, assignee_type: null, assignee_id: null,
        responsible_member_id: human.id });
      expect(store.getIssue(body.id)?.responsibleMemberId).toBe(human.id);
      expect(store.getIssue(body.id)?.contextRefs).toEqual([]);
      expect(store.listTasksForIssue(body.id)).toHaveLength(0);
    }
    expect(store.getTask(task.id)?.status).toBe("running");
  });

  for (const owner of ["issue", "chat"] as const) {
    it(`inherits only the actual ${owner} Session human when Task audit columns are NULL`, async () => {
      const { store, app, agent, executor, project, issue, chat, defaultSession } = await fixture();
      const sourceSession = owner === "issue" ? defaultSession
        : store.createIssueSession(issue.id, { chatId: chat.id, title: "Private responsibility source" });
      const source = store.createSessionTask(sourceSession.id, {
        agentId: owner === "issue" ? executor.id : agent.id, prompt: "Create a responsibility-scoped root",
      });
      const turn = store.getTurnForAttempt(source.id)!;
      db!.run("UPDATE multiremi_turns SET issue_id = NULL, chat_session_id = NULL WHERE id = ?", [turn.id]);
      const persisted = store.getTask(source.id)!;
      expect(persisted).toMatchObject({ issueId: null, chatSessionId: null, issueSessionId: sourceSession.id });
      const token = await store.createTaskAccessToken(persisted, "local");
      expect(await store.verifyAccessToken(token.token, ["task"])).not.toBeNull();
      const human = owner === "issue" ? issue.responsibleMemberId!
        : store.findWorkspaceMemberForUser(chat.creatorId!, chat.workspaceId)!.id;

      for (const path of ["/api/issues", "/api/multiremi/issues"]) {
        const response = await app.request(path, {
          method: "POST", headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ title: `NULL audit ${owner} root via ${path}` }),
        });
        expect(response.status, await response.clone().text()).toBe(201);
        const body = await response.json();
        const created = store.getIssue(body.id ?? body.issue?.id)!;
        expect(created.responsibleMemberId).toBe(human);
        expect(created.parentIssueId).toBeNull();
        if (owner === "chat") {
          expect(created.responsibleMemberId).not.toBe(issue.responsibleMemberId);
          expect(created).toMatchObject({ projectId: null, sourceIssueId: null, assigneeType: null, assigneeId: null, contextRefs: [] });
          expect(store.listTasksForIssue(created.id)).toHaveLength(0);
        } else if (path === "/api/issues") {
          expect(created).toMatchObject({ projectId: project.id, sourceIssueId: issue.id });
        }
      }
      expect(store.getTask(source.id)).toMatchObject({ issueId: null, chatSessionId: null, issueSessionId: sourceSession.id });
    });

    for (const corruption of ["foreign-owner", "forged-audit"] as const) {
      it(`rejects ${corruption} on a ${owner} Session without creating or mutating business records`, async () => {
        const { store, app, agent, executor, issue, chat, defaultSession } = await fixture();
        const sourceSession = owner === "issue" ? defaultSession
          : store.createIssueSession(issue.id, { chatId: chat.id, title: "Private responsibility source" });
        const source = store.createSessionTask(sourceSession.id, {
          agentId: owner === "issue" ? executor.id : agent.id, prompt: "Reject forged responsibility",
        });
        const turn = store.getTurnForAttempt(source.id)!;
        db!.run("UPDATE multiremi_turns SET issue_id = NULL, chat_session_id = NULL WHERE id = ?", [turn.id]);
        const foreign = store.createWorkspace({ name: "Foreign responsibility", slug: "foreign-responsibility" });
        if (corruption === "foreign-owner") {
          db!.run(`UPDATE ${owner === "issue" ? "multiremi_issues" : "multiremi_chat_sessions"} SET workspace_id = ? WHERE id = ?`,
            [foreign.id, owner === "issue" ? issue.id : chat.id]);
        } else if (owner === "issue") {
          const decoy = createResponsibleTestIssue(store, { title: "Forged audit Issue", assigneeType: "agent", assigneeId: executor.id });
          db!.run("UPDATE multiremi_turns SET issue_id = ? WHERE id = ?", [decoy.id, turn.id]);
        } else {
          const decoy = store.createChatSession({ agentId: agent.id, creatorId: "local" });
          db!.run("UPDATE multiremi_turns SET chat_session_id = ? WHERE id = ?", [decoy.id, turn.id]);
        }
        const token = await store.createTaskAccessToken(store.getTask(source.id)!, "local");
        expect(await store.verifyAccessToken(token.token, ["task"])).not.toBeNull();
        const human = store.findWorkspaceMemberForUser("local", "local")!;
        const snapshot = () => Object.fromEntries([
          "multiremi_issues", "multiremi_issue_activity", "multiremi_issue_sessions", "multiremi_conversation_log",
          "multiremi_conversation_heads", "multiremi_turns", "multiremi_turn_attempts", "multiremi_session_lanes",
          "multiremi_attachments", "multiremi_workspace_members",
        ].map(table => [table, db!.query(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
        const before = snapshot();
        const events: string[] = [];
        const stop = store.onWorkspaceEvent(event => events.push(event.type));
        try {
          for (const path of ["/api/issues", "/api/multiremi/issues"]) {
            for (const forgedHuman of [false, true]) {
              const response = await app.request(path, {
                method: "POST", headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
                body: JSON.stringify({ title: "Forbidden root", ...(forgedHuman ? { responsible_member_id: human.id } : {}) }),
              });
              expect(response.status, await response.clone().text()).toBe(forgedHuman ? 403 : 409);
              expect(await response.json()).toMatchObject({ code: forgedHuman
                ? "human_issue_responsibility_required" : "issue_responsibility_required" });
              expect(snapshot()).toEqual(before);
              expect(events).toEqual([]);
            }
          }
        } finally { stop(); }
      });
    }
  }

  it("still honors an explicitly selected project from an ordinary Chat", async () => {
    const { app, headers, project, executor } = await fixture();
    const response = await app.request("/api/issues", {
      method: "POST", headers,
      body: JSON.stringify({ title: "Explicit project request", project_id: project.id }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      project_id: project.id, source_issue_id: null, assignee_type: "agent", assignee_id: executor.id,
    });
  });

  it("does not grant Issue message access from historical audit data or forged Topic fields", async () => {
    const { store, app, headers, issue, defaultSession } = await fixture();
    const before = store.listMessages(defaultSession.id);
    for (const forged of [{}, { kind: "topic", task_kind: "topic", source_turn_id: "forged", issue_id: issue.id }]) {
      const response = await app.request(issueMessagesPath(store, issue.id), {
        method: "POST", headers,
        body: JSON.stringify({ body_md: "FORBIDDEN_AUDIT_ISSUE_WRITE", to: { type: "none" }, ...forged }),
      });
      expect(response.status).toBe(403);
      expect(store.listMessages(defaultSession.id)).toEqual(before);
    }
  });

  it("cannot reuse the old Issue project as implicit knowledge write scope", async () => {
    const { app, headers, project } = await fixture();
    const response = await app.request(`/api/projects/${project.id}/docs`, {
      method: "POST", headers,
      body: JSON.stringify({ kind: "memory", title: "Old scope", body: "Do not inherit Issue authority" }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "task knowledge target does not match its issue project" });
  });

  it("preserves Issue context and project inheritance for a real Feishu Issue topic", async () => {
    const { store, app, headers, issue, session, project, executor, chat, task } = await fixture(true);
    const context = await app.request("/api/cli/context", { headers });
    expect(context.status).toBe(200);
    expect((await context.json()).current).toMatchObject({
      task: { id: task.id, issue_id: issue.id, session_id: null, chat_id: chat.id },
      issue: { id: issue.id }, session: null, project: { id: project.id },
    });

    const response = await app.request("/api/issues", {
      method: "POST", headers, body: JSON.stringify({ title: "A topic follow-up" }),
    });
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created).toMatchObject({
      project_id: project.id, source_issue_id: issue.id, assignee_type: "agent", assignee_id: executor.id,
      responsible_member_id: issue.responsibleMemberId,
    });
    expect(store.getIssue(created.id)?.responsibleMemberId).toBe(issue.responsibleMemberId);

    const comment = await app.request(issueMessagesPath(store, issue.id), {
      method: "POST", headers, body: JSON.stringify(requestMessageBody(store, { agent_id: executor.id, content: "Topic request stays on its session" })),
    });
    expect(comment.status).toBe(200);
    expect((await comment.json()).message.session_id).toBe(store.getOrCreateDefaultIssueSession(issue.id).id);

    const knowledge = await app.request(`/api/projects/${project.id}/docs`, {
      method: "POST", headers, body: JSON.stringify({ kind: "memory", title: "Topic finding", body: "Scoped to the topic Issue" }),
    });
    expect(knowledge.status).toBe(202);
    const knowledgeBody = await knowledge.json();
    expect(store.getKnowledgeSubmission(knowledgeBody.submission_id)?.sourceIssueId).toBe(issue.id);
  });

  it("ignores transport Issue overrides and keeps the persisted Feishu topic binding", async () => {
    const { store, app, headers, agent, chat, issue, task } = await fixture(true);
    const other = createResponsibleTestIssue(store, { title: "Unrelated Issue" });
    for (const issueId of [issue.id, other.id]) {
      const before = store.listTasks().length;
      const response = await app.request(`/api/sessions/${chat.id}/messages`, {
        method: "POST",headers,
        body:JSON.stringify(requestMessageBody(store,{agentId:agent.id,issueId,prompt:"Topic transport"})),
      });
      expect(response.status).toBe(200);
      expect((await response.json()).message).toMatchObject({session_id:chat.id,wake_reason:"self"});
      expect(store.listTasks()).toHaveLength(before);
      expect(store.getTask(task.id)?.issueId).toBe(issue.id);
    }
  });
});
