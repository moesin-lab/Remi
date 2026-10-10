import { afterEach, beforeEach, expect, it } from "bun:test";
import { StoreContext, createCommitEventQueue } from "@multiremi/store/context.js";
import { Questions } from "@multiremi/store/inbox/questions.js";
import { migrateFeishuMultipleBots } from "@multiremi/store/migrations.js";
import { pendingTurnBackendTests, type PendingTurnTestFixture } from "./pending-turn-test-backends.js";
import { unifiedModelBackendTests } from "./unified-model-test-backends.js";
import { bindFeishuTopicFixture } from "./feishu-topic-fixture.js";

let previousKey: string | undefined;
let previousJobs: string | undefined;

beforeEach(() => {
  previousKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  previousJobs = process.env.MULTIREMI_BACKGROUND_JOBS;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64");
  process.env.MULTIREMI_BACKGROUND_JOBS = "0";
});

afterEach(() => {
  if (previousKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousKey;
  if (previousJobs === undefined) delete process.env.MULTIREMI_BACKGROUND_JOBS;
  else process.env.MULTIREMI_BACKGROUND_JOBS = previousJobs;
});

function multibotFixture(f: PendingTurnTestFixture, projected = false) {
  const { store, db } = f;
  const humans = ["first", "second"].map(name => {
    const user = store.getOrCreateUser({ externalId: `multibot_${name}`, name: `Human ${name}` });
    db.run("UPDATE multiremi_users SET feishu_union_id=? WHERE id=?", [`on_${name}`, user.id]);
    return store.createWorkspaceMember({ workspaceId: "local", userId: user.id, name: `Human ${name}`, role: "member" });
  });
  const bots = ["default", "bot_second"].map((botId, index) => {
    const runtime = store.registerRuntime({ id: `rt_multibot_${index}`, name: `Bot host ${index}`, provider: "codex",
      daemonId: `multibot_daemon_${index}`, maxConcurrency: 8 });
    store.heartbeatRuntime(runtime.id, { supportsFeishuBotConfig: true, supportsDecisionCard: true });
    const agent = store.createAgent({ name: `Presenter ${index}`, provider: "codex", runtimeId: runtime.id });
    const bot = store.feishuBotFor(botId);
    const config = bot.upsertConfig("local", { agentId: agent.id, runtimeId: runtime.id, appId: `cli_multibot_${index}`,
      appSecretOp: "set", appSecret: `synthetic-multibot-${index}`, domain: "feishu", enabled: true,
      responsibleMemberId: humans[index]!.id });
    store.reportFeishuBotRuntimeStatus("local", runtime.id, { state: "online", appliedRevision: config.revision });
    const openId = `ou_multibot_${index}`;
    const at = new Date().toISOString();
    db.run(`INSERT INTO multiremi_feishu_bot_senders
      (id,workspace_id,bot_id,app_id,open_id,union_id,display_name,allowed,first_seen_at,last_seen_at)
      VALUES(?,?,?,?,?,?,?,1,?,?)`, [`fbs_multibot_${index}`, "local", botId, config.appId, openId,
      `on_${index ? "second" : "first"}`, humans[index]!.name, at, at]);
    return { bot, runtime, agent, config, openId };
  });
  const second = bots[1]!;
  const worker = store.createAgent({ name: "Private second-bot worker", provider: "codex", runtimeId: second.runtime.id });
  const chat = store.createChatSession({ agentId: worker.id, creatorId: "transport-sender", title: "Second bot private Chat" });
  const at = new Date().toISOString();
  db.run(`INSERT INTO multiremi_feishu_bot_chat_bindings
    (id,workspace_id,bot_id,app_id,agent_id,external_session_key,chat_session_id,chat_id,created_at,updated_at)
    VALUES('fbb_multibot_second','local',?,?,?,'second-private-chat',?,'oc_multibot_second',?,?)`,
    [second.config.botId, second.config.appId, worker.id, chat.id, at, at]);
  const issue = projected ? store.createIssue({ title: "Optional public projection", responsibleMemberId: humans[0]!.id }) : null;
  const session = issue ? store.createIssueSession(issue.id, { chatId: chat.id, title: "Private projected work", holdsWorkspace: false })
    : store.createSession(chat.id, { title: "Second bot work", holdsWorkspace: false });
  const task = store.createSessionTask(session.id, { agentId: worker.id, prompt: "Ask in the original private working Session" });
  expect(store.claimTask(second.runtime.id)?.id).toBe(task.id);
  store.startTask(task.id);
  const turn = store.getTurnForAttempt(task.id)!;
  return { ...f, humans, bots, worker, chat, issue, session, task, turn };
}

function ask(h: ReturnType<typeof multibotFixture>, suffix = "original") {
  const runtime = h.bots[1]!.runtime;
  const result = h.store.getDaemonTurnBridge().rpc("turn.decision", { turn_id: h.turn.id, attempt_id: h.task.id,
    wait_id: `multibot-wait:${h.task.id}:${suffix}`, dedupe_key: `multibot-question:${h.task.id}:${suffix}`,
    body_md: "Private second-bot direction", options: [{ label: "A", value: "A" }],
    metadata: { kind: "question", questions: [{ fieldKey: "direction", question: { question: "Direction?", options: [{ label: "A" }] } }] } },
    { runtimeId: runtime.id, daemonId: runtime.daemonId!, workspaceId: "local" });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return h.store.getQuestion(String(result.message_id))!;
}

function present(h: ReturnType<typeof multibotFixture>, questionId: string) {
  const second = h.bots[1]!;
  const record = h.store.getMessage(questionId)!.metadata.question as { presentation_session_id: string };
  const notification = h.store.listMessages(record.presentation_session_id).find(message => message.metadata.question_present_request === true)!;
  expect(notification).toMatchObject({ to_agent_id: second.agent.id, metadata: { root_question_id: questionId, question_route_revision: 1 } });
  expect(notification.session_id).not.toBe(h.session.id);
  const presenterTurn = h.store.getTurn(String(notification.metadata.delivery_turn_id))!;
  const presenter = h.store.claimTask(second.runtime.id)!;
  expect(presenter.id).toBe(presenterTurn.current_attempt_id!);
  expect(presenter.agentId).toBe(second.agent.id);
  h.store.startTask(presenter.id);
  h.store.presentQuestion(questionId, { expected_route_revision: 1, summary: "Read the original second-bot options" },
    { type: "agent", id: second.agent.id }, presenterTurn.id);
}

pendingTurnBackendTests("multibot Question Session ownership", fixture => {
  it("uses the second bot's human, notification presenter, app-scoped recipient and card token", () => {
    const h = multibotFixture(fixture());
    const first = h.bots[0]!, second = h.bots[1]!;
    const question = ask(h);
    expect(question).toMatchObject({ session_id: h.session.id, source_issue_id: null, source_agent_id: h.worker.id,
      stage: "human", current_handler: { type: "member", id: h.humans[1]!.id }, wait_status: "waiting", route_revision: 1 });
    expect(h.store.getFeishuBotConfigForSession("local", h.session.id)).toMatchObject({ botId: second.config.botId,
      appId: second.config.appId, agentId: second.agent.id, responsibleMemberId: h.humans[1]!.id });
    expect(h.store.getQuestion(question.id, { type: "agent", id: first.agent.id })!.actions.allowed).not.toContain("present");
    expect(h.store.getQuestion(question.id, { type: "agent", id: second.agent.id })!.actions.allowed).toContain("present");

    present(h, question.id);

    // The persisted transport carrier deliberately has the other app's recipient.
    // Materialization must resolve this Q's handler instead of copying that value.
    const at = new Date().toISOString();
    h.db.run(`INSERT INTO multiremi_feishu_bot_outbound_deliveries
      (id,workspace_id,binding_id,task_id,chat_id,body,kind,delivery_mode,status,interaction_open_id,available_at,created_at,updated_at)
      VALUES('fbo_multibot_carrier','local','fbb_multibot_second',?,'oc_multibot_second','','cot','split','sent',?,?,?,?)`,
      [h.task.id, first.openId, at, at, at]);
    const deliveries = [...h.store.claimFeishuBotOutbounds("local", second.runtime.id),
      ...h.store.claimFeishuBotOutbounds("local", second.runtime.id)];
    const interactions = deliveries.filter(delivery => delivery.kind === "interaction_card");
    expect(interactions).toHaveLength(1);
    expect(interactions[0]).toMatchObject({ humanRequestId: question.id, interactionOpenId: second.openId });
    expect(interactions[0]).not.toHaveProperty("degraded");
    expect(h.db.query("SELECT degraded FROM multiremi_feishu_bot_outbound_deliveries WHERE id=?").get(interactions[0]!.id)?.degraded).toBeNull();
    expect(h.store.claimFeishuBotOutbounds("local", first.runtime.id)).toEqual([]);

    expect(h.store.prepareTaskStreamQuestionCard(question.id, first.openId)).toBeNull();
    expect(h.store.prepareTaskStreamQuestionCard(question.id, second.openId)).not.toBeNull();
    const protectedMessage = h.store.getMessage(question.id)!;
    expect(protectedMessage.card_token_recipient).toBe(second.openId);
    expect(protectedMessage.card_token_hash).toBeTruthy();
    expect(() => h.store.answerQuestion(question.id, { expected_route_revision: 1, response: { answers: { direction: "A" } } },
      { type: "member", id: h.humans[0]!.id })).toThrow("question_handler_required");
    expect(h.store.getMessage(question.id)!.card_token_hash).toBe(protectedMessage.card_token_hash);
    expect(h.store.getQuestion(question.id)).toMatchObject({ status: "pending", session_id: h.session.id, wait_status: "waiting",
      summary: { agent_id: second.agent.id, body_md: "Read the original second-bot options" } });
  });

  it("editing or deleting default leaves the second bot's Question, token and running directive unchanged", () => {
    const h = multibotFixture(fixture());
    const first = h.bots[0]!, second = h.bots[1]!;
    const question = ask(h);
    h.store.issueMessageCardToken(question.id, second.openId);
    const beforeQuestion = h.store.getQuestion(question.id);
    const beforeMessage = h.store.getMessage(question.id);
    const beforeConfig = second.bot.getConfig("local");
    first.bot.upsertConfig("local", { agentId: first.agent.id, runtimeId: first.runtime.id, appId: first.config.appId,
      appSecretOp: "keep", domain: "feishu", enabled: true, responsibleMemberId: h.humans[1]!.id });
    expect(h.store.getQuestion(question.id)).toEqual(beforeQuestion);
    expect(h.store.getMessage(question.id)).toEqual(beforeMessage);
    expect(h.store.deleteFeishuBotConfig("local", "mem_local_local")).toBe(true);
    expect(h.store.getQuestion(question.id)).toEqual(beforeQuestion);
    expect(h.store.getMessage(question.id)).toEqual(beforeMessage);
    expect(second.bot.getConfig("local")).toEqual(beforeConfig);
    expect(h.store.feishuBotDirectiveForRuntime("local", second.runtime.id)?.desired_state).toBe("running");
    expect(h.store.feishuBotDirectiveForRuntime("local", first.runtime.id)?.desired_state).toBe("stopped");
  });

  for (const missingAudit of [false, true]) {
    it(`a private Chat's Issue projection ${missingAudit ? "with null" : "with non-null"} audit keeps its bot responsibility and never notifies the public Issue`, () => {
      const h = multibotFixture(fixture(), true);
      expect(h.session).toMatchObject({ chatId: h.chat.id, issueId: h.issue!.id });
      expect(h.turn.issue_id).toBe(h.issue!.id);
      const first = h.bots[0]!;
      const topic = h.store.createChatSession({ agentId: first.agent.id, creatorId: "local", title: "Public projection topic" });
      bindFeishuTopicFixture(h.store, h.db, topic.id, h.issue!.id);
      h.db.run("UPDATE multiremi_feishu_bot_chat_bindings SET app_id=?,chat_id='oc_multibot_public' WHERE chat_session_id=?", [first.config.appId, topic.id]);
      h.store.updateWorkspace("local", { settings: { ...h.store.getWorkspace("local")!.settings,
        issueTopics: { enabled: true, chatId: "oc_multibot_public" } } });
      if (missingAudit) h.db.run("UPDATE multiremi_turns SET issue_id=NULL WHERE id=?", h.turn.id);
      const question = ask(h);
      expect(question).toMatchObject({ session_id: h.session.id, source_issue_id: null,
        current_handler: { type: "member", id: h.humans[1]!.id }, wait_status: "waiting" });
      present(h, question.id);
      expect(first.bot.statusSnapshot("local").status).toBe("online");
      const request = h.store.getTaskHumanRequest(question.id)!;
      expect(h.store.prepareFeishuBotHumanRequestPush(request)).toBeNull();
      expect(first.bot.prepareHumanRequestPush(request)).toBeNull();
      expect(h.store.claimFeishuBotOutbounds("local", h.bots[1]!.runtime.id)).toEqual([]);
      expect(h.store.claimFeishuBotOutbounds("local", first.runtime.id)).toEqual([]);
      expect(h.db.query("SELECT * FROM multiremi_feishu_bot_human_request_pushes WHERE request_id=?").all(question.id)).toEqual([]);
      expect(h.db.query("SELECT * FROM multiremi_feishu_bot_outbound_deliveries WHERE chat_id='oc_multibot_public'").all()).toEqual([]);
      expect(h.store.listIssueQuestions(h.issue!.id, { type: "member", id: h.humans[0]!.id }).map(item => item.id)).not.toContain(question.id);
      const publicSession = h.store.getOrCreateDefaultIssueSession(h.issue!.id);
      expect(h.store.listMessages(publicSession.id).some(message => message.metadata.root_question_id === question.id)).toBe(false);
      expect(h.store.getMessage(question.id)!.body_md).toBe("Private second-bot direction");
      expect(h.store.getMessage(question.id)!.session_id).toBe(h.session.id);
    });
  }

  it("an Issue-owned Session supplies the business source when the Turn's Issue audit is null", () => {
    const { store, db } = fixture();
    const runtime = store.registerRuntime({ name: "Null-audit Issue host", provider: "codex", daemonId: "null-audit-question-host" });
    const agent = store.createAgent({ name: "Issue source", provider: "codex", runtimeId: runtime.id });
    const issue = store.createIssue({ title: "Actual Issue owner", responsibleMemberId: "mem_local_local" });
    const session = store.createIssueSession(issue.id, { title: "Original Issue work", holdsWorkspace: false });
    const task = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Ask the actual Issue human" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    const turn = store.getTurnForAttempt(task.id)!;
    db.run("UPDATE multiremi_turns SET issue_id=NULL WHERE id=?", turn.id);
    const response = store.getDaemonTurnBridge().rpc("turn.decision", { turn_id: turn.id, attempt_id: task.id,
      wait_id: "issue-null-audit-wait", dedupe_key: "issue-null-audit-question", body_md: "Approve the actual owner?",
      options: [{ label: "Yes", value: "yes" }], metadata: { kind: "permission", options: [{ optionId: "yes", name: "Yes" }] } },
      { runtimeId: runtime.id, daemonId: runtime.daemonId!, workspaceId: "local" });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    const question = store.getQuestion(String(response.message_id))!;
    expect(question).toMatchObject({ session_id: session.id, source_issue_id: issue.id, stage: "human",
      current_handler: { type: "member", id: "mem_local_local" }, wait_status: "waiting" });
    expect(store.getMessage(question.id)!.session_id).toBe(session.id);
    expect(store.listIssueQuestions(issue.id).map(item => item.id)).toContain(question.id);
  });

  for (const mismatch of ["issue", "workspace"] as const) {
    it(`rejects an explicit ${mismatch} mismatch before creating a Question or changing its native wait`, () => {
      const { store, db } = fixture();
      const runtime = store.registerRuntime({ name: "Rejected Q host", provider: "codex", daemonId: "rejected-question-host" });
      const agent = store.createAgent({ name: "Rejected Q source", provider: "codex", runtimeId: runtime.id });
      const issue = store.createIssue({ title: "Actual Q Issue", responsibleMemberId: "mem_local_local" });
      const session = store.createIssueSession(issue.id, { title: "Protected Issue work", holdsWorkspace: false });
      const task = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Keep source and wait unchanged" });
      expect(store.claimTask(runtime.id)?.id).toBe(task.id);
      store.startTask(task.id);
      const turn = store.getTurnForAttempt(task.id)!;
      if (mismatch === "issue") {
        const other = store.createIssue({ title: "Unrelated Issue", responsibleMemberId: "mem_local_local" });
        db.run("UPDATE multiremi_turns SET issue_id=? WHERE id=?", [other.id, turn.id]);
      } else {
        const foreign = store.createWorkspace({ name: "Foreign Q owner", slug: "foreign-q-owner" });
        db.run("UPDATE multiremi_issue_sessions SET workspace_id=? WHERE id=?", [foreign.id, session.id]);
      }
      const protectedTables = ["multiremi_conversation_log", "multiremi_conversation_heads", "multiremi_turns",
        "multiremi_turn_attempts", "multiremi_agent_lane_records", "multiremi_feishu_bot_outbound_operations"];
      const snapshot = () => protectedTables.map(table => db.query(`SELECT * FROM ${table} ORDER BY 1`).all());
      const before = snapshot();
      const questions = new Questions(new StoreContext(db, () => store));
      expect(() => db.transaction(() => questions.createWithinTransaction({ id: "question_rejected_owner",
        session_id: session.id, sender: { type: "agent", id: agent.id }, source_turn_id: turn.id, to: { type: "none" },
        message_kind: "decision", wake_requested: "inbox_only", body_md: "Must not become an authorized Question",
        options: [{ label: "Yes", value: "yes" }], metadata: { kind: "permission", wait_id: "rejected-owner-wait" } },
      task.id, createCommitEventQueue()))()).toThrow(`question_source_${mismatch === "issue" ? "issue" : "workspace"}_changed`);
      expect(snapshot()).toEqual(before);
      expect(store.getMessage("question_rejected_owner")).toBeNull();
      expect(db.query("SELECT status,waiting_on_message_id FROM multiremi_turns WHERE id=?").get(turn.id))
        .toMatchObject({ status: "running", waiting_on_message_id: null });
    });
  }
});

unifiedModelBackendTests("single-bot responsibility migration", fixture => {
  it("preserves an existing responsible human and encrypted credentials when assigning default identity", () => {
    const { db, store } = fixture();
    const at = "2026-10-01T00:00:00.000Z";
    const agent = store.createAgent({ name: "Legacy responsible bot", provider: "codex" });
    db.run("INSERT INTO multiremi_runtimes(id,name,provider,workspace_id,created_at,updated_at) VALUES('rt_responsible_old','Old host','codex','local',?,?)", [at, at]);
    db.run(`INSERT INTO multiremi_feishu_bot_configs
      (workspace_id,agent_id,runtime_id,app_id,app_secret_encrypted,responsible_member_id,enabled,revision,created_at,updated_at)
      VALUES('local',?,'rt_responsible_old','cli_responsible_old','preserved-responsible-ciphertext','mem_local_local',1,7,?,?)`,
      [agent.id, at, at]);
    const before = db.query("SELECT * FROM multiremi_feishu_bot_configs").all();
    if (db.dialect !== "postgres") db.exec("PRAGMA foreign_keys = ON");
    migrateFeishuMultipleBots(db);
    migrateFeishuMultipleBots(db);
    const after = db.query("SELECT * FROM multiremi_feishu_bot_configs").all();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ bot_id: "default", responsible_member_id: "mem_local_local",
      app_secret_encrypted: "preserved-responsible-ciphertext", revision: 7 });
    expect(after.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !["bot_id", "name"].includes(key))))).toEqual(before);
    if (db.dialect !== "postgres") {
      expect(db.query("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    }
  });
});
