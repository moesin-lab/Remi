import { createResponsibleTestIssue } from './helpers.js';
import { turnApiPath } from "./unified-test-paths.js";
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { authorizeBrowserWebSocketToken, notifyBrowserTaskEvent } from "@multiremi/api/realtime.js";
import { bindFeishuTopicFixture } from "./feishu-topic-fixture.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Project Chat startup progress", () => {
  it("publishes progress to shared workspace operators and recovers it after reopening Chat", async () => {
    const store = createLocalStore();
    const agent = store.createAgent({ name: "Worker", provider: "codex" });
    const project = store.createProject({ title: "Project" });
    const chat = store.createChatSession({ agentId: agent.id, projectId: project.id });
    const task = store.sendChatMessage(chat.id, { body: "Prepare" }).task;
    const events: Array<{ type: string; task: any }> = [];
    store.onTaskEvent(event => events.push(event));
    store.reportProgress(task.id, "正在准备项目仓库…", 1, 3);
    expect(events.map(event => event.type)).toEqual(["task:progress"]);
    const frames: string[] = [];
    const otherOperatorFrames: string[] = [];
    const unrelatedFrames: string[] = [];
    const browser = (userId: string, workspaceId: string, output: string[], authenticated = true) => ({
      data: { kind: "browser", authenticated, userId, workspaceId },
      sendText: (frame: string) => output.push(frame),
    }) as any;
    const accountIdentity = async (userId: string) => {
      const credential = await store.createAccessToken({ name: userId, type: "pat", userId, workspaceId: "local", purpose: "session" });
      const authorized = await authorizeBrowserWebSocketToken(credential.token, store, "root-secret", "local");
      expect(authorized).toMatchObject({ userId: "local" });
      if ("error" in authorized) throw new Error(authorized.error);
      return authorized.userId;
    };
    const chatClient = browser(await accountIdentity(chat.creatorId!), "local", frames);
    const otherOperator = browser(await accountIdentity("another-login-account"), "local", otherOperatorFrames);
    const unauthenticated = browser("anonymous", "local", unrelatedFrames, false);
    const otherWorkspace = browser("another-login-account", "foreign", unrelatedFrames);
    notifyBrowserTaskEvent(
      new Map([["local", new Set([chatClient, otherOperator, unauthenticated])], ["foreign", new Set([otherWorkspace])]]),
      new Map([[chat.creatorId!, new Set([chatClient])]]),
      store,
      events[0]!.type, events[0]!.task,
    );
    expect(JSON.parse(frames[0]!)).toMatchObject({ type: "task:progress", payload: {
      chat_session_id: chat.id, task_id: task.id, progress_summary: "正在准备项目仓库…",
    } });
    expect(otherOperatorFrames).toEqual(frames);
    expect(unrelatedFrames).toEqual([]);
    const app = createMultiremiApp({ store });
    const response = await app.request(turnApiPath(store, task.id, "?attempts=true"));
    expect(response.status).toBe(200);
    expect((await response.json()).attempts.at(-1)).toMatchObject({ id: task.id, progress_summary: "正在准备项目仓库…" });
  });

  it("keeps pure Chat and Issue topic progress behavior unchanged", async () => {
    const store = createLocalStore();
    const agent = store.createAgent({ name: "Worker", provider: "codex" });
    const project = store.createProject({ title: "Project" });
    const issue = createResponsibleTestIssue(store, { title: "Issue", projectId: project.id });
    const app = createMultiremiApp({ store });
    for (const topic of [false, true]) {
      const chat = store.createChatSession({ agentId: agent.id, ...(topic ? { projectId: project.id } : {}) });
      if (topic) bindFeishuTopicFixture(store, db!, chat.id, issue.id);
      const task = store.createTask({ agentId: agent.id, chatSessionId: chat.id, prompt: "Work",
        ...(topic ? { issueId: issue.id } : {}) });
      const events: string[] = [];
      const unsubscribe = store.onTaskEvent(event => events.push(event.type));
      expect(store.reportProgress(task.id, "Original startup line", 1, 3).progressSummary).toBe("Original startup line");
      expect(events).toEqual([]);
      unsubscribe();
      const response = await app.request(turnApiPath(store, task.id, "?attempts=true"));
      expect(response.status).toBe(200);
      expect(await response.json()).not.toHaveProperty("progress_summary");
    }
  });
});
