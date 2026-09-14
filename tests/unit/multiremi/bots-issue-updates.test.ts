import { afterEach, describe, expect, it } from "bun:test";
import type { BotIssueNotifications, BotTarget } from "@multiremi/contracts/bots.js";
import { BotIssueUpdates } from "@multiremi/bots/issue-updates.js";
import { ensureBotSchema } from "@multiremi/bots/schema.js";
import { StoreContext } from "@multiremi/store/context.js";
import { botTargetKey } from "@multiremi/bots/routing.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function scaffold() {
  const store = createLocalStore();
  ensureBotSchema(db!);
  const updates = new BotIssueUpdates(new StoreContext(db!, () => store));
  const agent = store.createAgent({ name: "Bot agent", provider: "codex", workspaceId: "local" });
  const otherAgent = store.createAgent({ name: "Other agent", provider: "codex", workspaceId: "local" });
  for (const id of ["rt_host", "rt_execution"]) store.registerRuntime({
    id, name: id, workspaceId: "local", provider: "codex", daemonId: id,
  });
  const target: BotTarget = { kind: "agent", agent_id: agent.id, runtime_id: "rt_execution", project_id: null, runtime_workspace_id: null };
  const now = new Date().toISOString();
  db!.run(`INSERT INTO multiremi_bots
    (id, workspace_id, name, enabled, default_target, created_at, updated_at)
    VALUES ('bot_test', 'local', 'Test Bot', 1, ?, ?, ?)`, [JSON.stringify(target), now, now]);
  for (const id of ["bp_first", "bp_selected"]) db!.run(`INSERT INTO multiremi_bot_platform_bindings
    (id, bot_id, platform, app_id, domain, host_runtime_id, active, app_secret_encrypted, created_at, updated_at)
    VALUES (?, 'bot_test', 'feishu', ?, 'feishu', 'rt_host', 1, 'fixture-unused', ?, ?)`, [id, id, now, now]);
  const configure = (config: BotIssueNotifications | null) => db!.run(
    "UPDATE multiremi_bots SET issue_notifications = ? WHERE id = 'bot_test'", [config ? JSON.stringify(config) : null],
  );
  const issue = store.createIssue({ title: "Completed implementation", workspaceId: "local", assigneeType: "agent", assigneeId: agent.id });
  const leaderTask = store.createSessionTask(store.getOrCreateDefaultIssueSession(issue.id).id, {
    agentId: agent.id, prompt: "Implement this Issue",
  });
  store.cancelTask(leaderTask.id);
  function bindConversation(input: { pendingTask?: boolean; reply?: string } = {}) {
    const chat = store.createChatSession({ workspaceId: "local", agentId: agent.id, issueId: issue.id });
    const now = new Date().toISOString();
    db!.run(`INSERT INTO multiremi_bot_sessions
      (id, bot_id, platform_binding_id, external_session_key, target_key, target,
       chat_session_id, chat_id, thread_id, reply_to_message_id, created_at, updated_at)
      VALUES ('bs_test', 'bot_test', 'bp_selected', 'oc_original:thread:om_root', ?, ?, ?,
       'oc_original', 'om_root', ?, ?, ?)`,
    [botTargetKey(target), JSON.stringify(target), chat.id, input.reply ?? "om_original", now, now]);
    const task = input.pendingTask ? store.createTask({ agentId: agent.id, chatSessionId: chat.id, prompt: "User message" }) : null;
    if (task) db!.run(`INSERT INTO multiremi_bot_deliveries
      (platform_binding_id, external_message_id, bot_session_id, task_id, reply_to_message_id, created_at)
      VALUES ('bp_selected', 'om_original', 'bs_test', ?, 'om_original', ?)`, [task.id, now]);
    return { chat, task };
  }
  return { store, updates, agent, otherAgent, target, configure, issue, leaderTask, bindConversation };
}

describe("Bot Issue updates", () => {
  it("creates one topic on the explicitly configured account and target, even while the host is offline", () => {
    const { store, updates, otherAgent, configure, issue } = scaffold();
    const project = store.createProject({ title: "Bot directory", workspaceId: "local" });
    configure({ platform_binding_id: "bp_selected", chat_id: "oc_notifications", target: {
      kind: "agent", agent_id: otherAgent.id, project_id: project.id, runtime_id: null,
    } });
    expect(updates.prepareIssueTopicWithinTransaction(issue)).toBe(true);
    expect(updates.prepareIssueTopicWithinTransaction(issue)).toBe(false);
    expect(store.listChatSessions("local").filter(chat => chat.issueId === issue.id)).toEqual([
      expect.objectContaining({ agentId: otherAgent.id, projectId: project.id }),
    ]);
    expect(db!.query("SELECT platform_binding_id, chat_id, reply_to_message_id, body FROM multiremi_bot_outbound_deliveries").all()).toEqual([
      { platform_binding_id: "bp_selected", chat_id: "oc_notifications", reply_to_message_id: null, body: `**${issue.key} - ${issue.title}**` },
    ]);
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_feishu_bot_outbound_deliveries").get()).toEqual({ count: 0 });
  });

  it("requires explicit notification configuration and applies project and enabled binding filters", () => {
    const { updates, configure, issue } = scaffold();
    expect(updates.prepareIssueTopicWithinTransaction(issue)).toBe(false);
    configure({ platform_binding_id: "bp_selected", chat_id: "oc_filtered", project_ids: ["prj_other"] });
    expect(updates.prepareIssueTopicWithinTransaction(issue)).toBe(false);
    configure({ platform_binding_id: "bp_selected", chat_id: "oc_filtered" });
    db!.run("UPDATE multiremi_bot_platform_bindings SET active = 0 WHERE id = 'bp_selected'");
    expect(updates.prepareIssueTopicWithinTransaction(issue)).toBe(false);
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_bot_outbound_deliveries").get()).toEqual({ count: 0 });
  });

  it("wakes the original conversation once, retaining its target and reply across config edits and retries", () => {
    const { store, updates, issue, leaderTask, bindConversation, otherAgent } = scaffold();
    const { chat } = bindConversation();
    db!.run("UPDATE multiremi_bots SET default_target = ?, routes = '[]' WHERE id = 'bot_test'",
      [JSON.stringify({ kind: "agent", agent_id: otherAgent.id, runtime_id: "rt_host" })]);
    const tasks = updates.prepareIssueRoundPushesWithinTransaction({ issue, leaderTask });
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    expect(task).toMatchObject({ chatSessionId: chat.id, agentId: chat.agentId, runtimeId: "rt_execution" });
    expect(updates.prepareIssueRoundPushesWithinTransaction({ issue, leaderTask })).toEqual([]);
    db!.run("UPDATE multiremi_bot_sessions SET chat_id = 'oc_changed', reply_to_message_id = 'om_changed' WHERE id = 'bs_test'");
    const retry = store.createTask({ agentId: chat.agentId, chatSessionId: chat.id, prompt: "Retry summary", parentTaskId: task.id });
    updates.retargetTaskWithinTransaction(task.id, retry.id);
    updates.completeTaskWithinTransaction(task, "Obsolete first attempt");
    updates.completeTaskWithinTransaction(retry, "Issue work is ready for review.");
    updates.completeTaskWithinTransaction(retry, "Duplicated terminal event");
    expect(db!.query(`SELECT task_id, platform_binding_id, chat_id, thread_id, reply_to_message_id, body
      FROM multiremi_bot_outbound_deliveries`).all()).toEqual([
      { task_id: retry.id, platform_binding_id: "bp_selected", chat_id: "oc_original", thread_id: "om_root",
        reply_to_message_id: "om_original", body: "Issue work is ready for review." },
    ]);
  });

  it("steers an active inbound task and records only one final outbound reply", () => {
    const { updates, issue, leaderTask, bindConversation } = scaffold();
    const { task } = bindConversation({ pendingTask: true });
    expect(updates.prepareIssueRoundPushesWithinTransaction({ issue, leaderTask })).toEqual([]);
    expect(db!.query("SELECT delivery_mode, wake_task_id FROM multiremi_bot_round_pushes").get())
      .toEqual({ delivery_mode: "inbound", wake_task_id: task!.id });
    updates.completeTaskWithinTransaction(task!, "The round and inbound message share one answer.");
    updates.completeTaskWithinTransaction(task!, "Duplicate terminal hook");
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_bot_outbound_deliveries").get()).toEqual({ count: 1 });
  });

  it("completes an ordinary inbound message by updating its existing streamed card", () => {
    const { updates, bindConversation } = scaffold();
    const { task } = bindConversation({ pendingTask: true });
    db!.run(`INSERT INTO multiremi_bot_reply_messages
      (platform_binding_id, external_message_id, bot_session_id, task_id, created_at)
      VALUES ('bp_selected', 'om_existing_card', 'bs_test', ?, ?)`, [task!.id, new Date().toISOString()]);
    db!.run("UPDATE multiremi_bot_sessions SET reply_to_message_id = 'om_later' WHERE id = 'bs_test'");
    updates.completeTaskWithinTransaction(task!, "Normal streamed answer");
    expect(db!.query("SELECT task_id, reply_to_message_id, update_message_id, body FROM multiremi_bot_outbound_deliveries").all()).toEqual([
      { task_id: task!.id, reply_to_message_id: "om_original", update_message_id: "om_existing_card", body: "Normal streamed answer" },
    ]);
  });

  it("honors the existing Chat notification toggle", () => {
    const { store, updates, issue, leaderTask, bindConversation } = scaffold();
    const { chat } = bindConversation();
    store.upsertAgentChatNotificationChannel({ workspaceId: "local", name: "Issue updates",
      chatSessionId: chat.id, enabled: false });
    expect(updates.prepareIssueRoundPushesWithinTransaction({ issue, leaderTask })).toEqual([]);
  });

  it("runs the real leader completion, Chat retry and outbound acknowledgement lifecycle", () => {
    const { store, agent, issue, bindConversation } = scaffold();
    const { chat } = bindConversation();
    const leader = store.createSessionTask(store.getOrCreateDefaultIssueSession(issue.id).id, {
      agentId: agent.id, prompt: "Finish the implementation",
    });
    expect(store.claimTask("rt_execution")?.id).toBe(leader.id);
    store.startTask(leader.id);
    store.completeTask(leader.id, { output: "The implementation is complete." });
    const summary = store.listTasks().find(task => task.chatSessionId === chat.id && task.status === "queued")!;
    expect(summary).toBeDefined();
    expect(store.claimTask("rt_execution")?.id).toBe(summary.id);
    store.startTask(summary.id);
    store.failTask(summary.id, { error: "Provider request timed out", failureReason: "timeout" });
    const retry = store.listTasks().find(task => task.parentTaskId === summary.id)!;
    expect(retry).toMatchObject({ status: "queued", chatSessionId: chat.id });
    expect(store.claimTask("rt_execution")?.id).toBe(retry.id);
    store.startTask(retry.id);
    store.completeTask(retry.id, { output: "Ready for review." });
    const first = store.claimBotOutbound("bot_test", "bp_selected", "rt_host")!;
    expect(first).toMatchObject({ chatId: "oc_original", replyToMessageId: "om_original", body: "Ready for review." });
    const failedAt = new Date();
    expect(store.reportBotOutbound("bot_test", "bp_selected", "rt_host", first.id, {
      claimToken: first.claimToken, status: "failed", error: "Temporary platform failure",
    }, failedAt)).toBe(true);
    expect(store.claimBotOutbound("bot_test", "bp_selected", "rt_host", failedAt)).toBeNull();
    const retriedAt = new Date(failedAt.getTime() + 10_000);
    const retried = store.claimBotOutbound("bot_test", "bp_selected", "rt_host", retriedAt)!;
    expect(retried.id).toBe(first.id);
    expect(store.reportBotOutbound("bot_test", "bp_selected", "rt_host", retried.id, {
      claimToken: retried.claimToken, status: "sent", externalMessageId: "om_summary_sent",
    }, retriedAt)).toBe(true);
    expect(store.claimBotOutbound("bot_test", "bp_selected", "rt_host", retriedAt)).toBeNull();
  });

  it("waits for the initial topic acknowledgement before delivering an already completed round", () => {
    const { store, updates, issue, leaderTask, otherAgent, configure } = scaffold();
    configure({ platform_binding_id: "bp_selected", chat_id: "oc_notifications", target: { kind: "agent", agent_id: otherAgent.id } });
    expect(updates.prepareIssueTopicWithinTransaction(issue)).toBe(true);
    const round = updates.prepareIssueRoundPushesWithinTransaction({ issue, leaderTask })[0]!;
    expect(round).toBeDefined();
    updates.completeTaskWithinTransaction(round, "The Issue is already complete.");
    const root = store.claimBotOutbound("bot_test", "bp_selected", "rt_host")!;
    expect(root).toMatchObject({ replyToMessageId: null, body: `**${issue.key} - ${issue.title}**` });
    expect(store.claimBotOutbound("bot_test", "bp_selected", "rt_host")).toBeNull();
    expect(store.reportBotOutbound("bot_test", "bp_selected", "rt_host", root.id, {
      claimToken: root.claimToken, status: "sent", externalMessageId: "om_topic_root",
    })).toBe(true);
    const summary = store.claimBotOutbound("bot_test", "bp_selected", "rt_host")!;
    expect(summary).toMatchObject({ threadId: "om_topic_root", replyToMessageId: "om_topic_root", body: "The Issue is already complete." });
    const reply = store.submitBotMessage("bot_test", "bp_selected", "rt_host", {
      revision: 1, externalSessionKey: "oc_notifications:thread:om_topic_root", externalMessageId: "om_user_reply",
      parentMessageId: "om_topic_root", replyToMessageId: "om_user_reply", chatId: "oc_notifications",
      threadId: "om_topic_root", text: "Continue the Issue.",
    });
    expect(reply.chatSessionId).toBe(round.chatSessionId!);
    expect(store.getChatSession(reply.chatSessionId)?.agentId).toBe(otherAgent.id);
  });

  it("preserves a leader result when its Bot directory conflicts with an Agent machine binding", () => {
    const { store, agent, target, issue, bindConversation } = scaffold();
    bindConversation();
    const location = store.runtimeWorkspaces.create("rt_host", { name: "Local files", root_path: "/tmp/bot-fixture-directory" });
    store.updateAgent(agent.id, { runtimeId: "rt_execution" });
    db!.run("UPDATE multiremi_bot_sessions SET target = ? WHERE id = 'bs_test'", [JSON.stringify({
      ...target, runtime_id: null, runtime_workspace_id: location.id,
    })]);
    const leader = store.createSessionTask(store.getOrCreateDefaultIssueSession(issue.id).id, {
      agentId: agent.id, prompt: "Complete with the current machine binding",
    });
    expect(store.claimTask("rt_execution")?.id).toBe(leader.id);
    store.startTask(leader.id);
    expect(store.completeTask(leader.id, { output: "The main work succeeded." }).status).toBe("completed");
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_bot_round_pushes").get()).toEqual({ count: 0 });
  });

  it("keeps ordinary Remi Chat completion outside Bot delivery", () => {
    const { store, agent, updates } = scaffold();
    const chat = store.createChatSession({ agentId: agent.id, workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, chatSessionId: chat.id, prompt: "A web Chat message" });
    updates.completeTaskWithinTransaction(task, "A web Chat answer");
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_bot_outbound_deliveries").get()).toEqual({ count: 0 });
  });
});
