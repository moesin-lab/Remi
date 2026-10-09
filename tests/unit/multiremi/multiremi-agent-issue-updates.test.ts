import { runTurnExecutionMutation } from '@multiremi/store/turn-execution-records.js';
import type { SqlDatabase as UnifiedFixtureDatabase } from '@multiremi/store/db/postgres.js';
import { beforeEach, expect, it, spyOn } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { useTaskSessionInput } from "@multiremi/api/daemon-protocol/offer-budget.js";
import { buildTaskPrompt } from "@multiremi/prompt.js";
import { createCommitEventQueue } from "@multiremi/store/context.js";
import { runMigrations } from "@multiremi/store/migrations.js";
import { bindFeishuTopicFixture } from "./feishu-topic-fixture.js";
import { installPendingTurnTestConstraints, pendingTurnBackendTests } from "./pending-turn-test-backends.js";

pendingTurnBackendTests("MUL-486 relay Issue log", (fixture) => {
  beforeEach(() => installPendingTurnTestConstraints(fixture()));
  const foreignBody = "FOREIGN_ISSUE_HISTORY_MUST_NOT_SHIP";

  function setup() {
    const f = fixture();
    const agent = f.store.createAgent({ name: "Relay", provider: "codex", maxConcurrentTasks: 4 });
    const issue = f.store.createIssue({ title: "Relay log", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
    const session = f.store.getOrCreateDefaultIssueSession(issue.id);
    f.store.createIssueComment(issue.id, { body: foreignBody });
    const chat = f.store.createChatSession({ agentId: agent.id });
    bindFeishuTopicFixture(f.store, f.db, chat.id, issue.id);
    const runtime = f.store.registerRuntime({ name: "Relay test runtime", provider: "codex", maxConcurrency: 4 });
    const legacyRows = () => Number((f.db.query("SELECT COUNT(*) AS count FROM multiremi_agent_issue_update_state").get() as { count: number }).count);
    const lane = () => f.store.getOrCreateSessionAgentLane(session.id, agent.id, `relay:${chat.id}`);
    const reports = () => f.store.listChatMessages(chat.id).filter(message => message.role === "system" && message.body.includes(issue.key));
    return { ...f, agent, issue, session, chat, runtime, lane, reports, legacyRows };
  }

  function claimRelayAfterCompletedIssueRound(f: ReturnType<typeof setup>) {
    const issueTask = f.store.createSessionTask(f.session.id, { agentId: f.agent.id, prompt: "Issue work" });
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(issueTask.id);
    f.store.startTask(issueTask.id);
    f.store.completeTask(issueTask.id, { output: "Issue result" });
    const relay = f.store.listTasks().find(task => task.chatSessionId === f.chat.id && task.wakeSource === "platform_to_owner")!;
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(relay.id);
    return relay;
  }

  function foreignLog(f: ReturnType<typeof setup>, taskId: string) {
    const task = f.store.getTaskWithAgent(taskId)!;
    const wire = daemonTaskClaimResponse(f.store, task);
    const toSeq = f.store.getBoundIssueLogToSeq(taskId)!;
    const log = wire.bound_issue_log as {
      session_id: string; from_seq: number; to_seq: number; content_jsonl: string;
      next_seq: number; has_more: boolean;
    };
    expect(log).toEqual({ session_id: f.session.id, from_seq: 0, to_seq: toSeq,
      content_jsonl: "", next_seq: 0, has_more: false });
    expect(JSON.stringify(wire)).not.toContain(foreignBody);
    const read = spyOn(f.store, "listConversationLogEntries");
    try {
      useTaskSessionInput(f.store, task, wire);
      expect(read.mock.calls.some(([sessionId]) => sessionId === f.session.id)).toBe(false);
    } finally {
      read.mockRestore();
    }
    expect(log.content_jsonl).toBe("");
    expect(JSON.stringify(wire)).not.toContain(foreignBody);
    const prompt = buildTaskPrompt({ ...task, prompt: wire.prompt,
      sessionProjection: wire.session_projection, boundIssue: wire.bound_issue,
      boundIssueLog: wire.bound_issue_log } as any);
    expect(prompt).not.toContain(foreignBody);
    expect(prompt).not.toContain("## Bound Issue Log");
    expect(f.db.query("SELECT bound_issue_log_delivered_seq FROM multiremi_turn_execution_records WHERE id = ?")
      .get(taskId)).toEqual({ bound_issue_log_delivered_seq: null });
    return log;
  }

  function assertForeignCursorUnchanged(f: ReturnType<typeof setup>) {
    expect(f.lane()?.cursorSeq).toBe(0);
    expect(f.db.query("SELECT provider_cursor_seq FROM multiremi_session_lanes WHERE session_id=? AND reader_id=? AND execution_scope=?")
      .get(f.session.id, f.agent.id, `relay:${f.chat.id}`)).toEqual({ provider_cursor_seq: 0 });
  }

  async function authenticatedTask(f: ReturnType<typeof setup>, taskId: string) {
    const token = await f.store.createTaskAccessToken(f.store.getTask(taskId)!, "local");
    return { app: createMultiremiApp({ store: f.store, authToken: "relay-test-root" }),
      headers: { Authorization: `Bearer ${token.token}` } };
  }

  for (const status of ["failed", "cancelled"] as const) {
    it(`reports a ${status} Issue round in its Chat without advancing the foreign Issue cursor`, async () => {
      const f = setup();
      const before = f.legacyRows();
      const task = f.store.createSessionTask(f.session.id, { agentId: f.agent.id, prompt: "Work on the Issue" });
      expect(f.store.claimTask(f.runtime.id)?.id).toBe(task.id);
      f.store.startTask(task.id);
      const issueReader = await authenticatedTask(f, task.id);
      const issueRead = await issueReader.app.request(`/api/sessions/${f.session.id}/messages?from=0&to=${f.store.getConversationLogHead(f.session.id)!.headSeq}`, { headers: issueReader.headers });
      expect(issueRead.status).toBe(200);
      expect((await issueRead.json()).entries.map((row: any) => row.body_md).join("\n")).toContain(foreignBody);
      if (status === "failed") f.store.failTask(task.id, { error: "Known failure", failureReason: "agent_error" });
      else f.store.cancelTask(task.id);
      expect(f.reports()).toHaveLength(1);
      expect(f.reports()[0]!.body).toContain(`状态 ${status}`);
      const entry = f.store.listConversationLogShown(f.chat.id).find(item => item.id === f.reports()[0]!.id)!;
      expect(entry.metadata.envelope).toMatchObject({ kind: "report", outcome: status, wake: "now" });
      const relay = f.store.listTasks().find(item => item.chatSessionId === f.chat.id && item.wakeSource === "platform_to_owner")!;
      expect(relay).toBeDefined();
      expect(f.lane()?.cursorSeq).toBe(0);
      expect(f.store.claimTask(f.runtime.id)?.id).toBe(relay.id);
      const log = foreignLog(f, relay.id);
      expect(log.to_seq).toBeGreaterThan(0);
      const { app, headers } = await authenticatedTask(f, relay.id);
      const denied = await app.request(`/api/sessions/${f.session.id}/messages?from=0&to=${log.to_seq}`, { headers });
      expect(denied.status).toBe(403);
      expect(await denied.text()).not.toContain(foreignBody);
      const own = await app.request(`/api/sessions/${f.chat.id}/messages?from=0&to=${f.store.getConversationLogHead(f.chat.id)!.headSeq}`, { headers });
      expect(own.status).toBe(200);
      expect((await own.json()).entries.map((row: any) => row.body_md).join("\n")).toContain(`状态 ${status}`);
      assertForeignCursorUnchanged(f);
      f.store.startTask(relay.id);
      f.store.completeTask(relay.id, { output: "Reported to Feishu" });
      assertForeignCursorUnchanged(f);
      expect(f.legacyRows()).toBe(before);
    });
  }

  it("deduplicates a repeated round trigger and reads the delivered Chat reports without foreign history", async () => {
    const f = setup();
    const first = f.store.createSessionTask(f.session.id, { agentId: f.agent.id, prompt: "First round" });
    f.store.claimTask(f.runtime.id);
    f.store.startTask(first.id);
    f.store.completeTask(first.id, { output: "First result" });
    const relay = f.store.listTasks().find(task => task.chatSessionId === f.chat.id && task.wakeSource === "platform_to_owner")!;
    f.store.claimTask(f.runtime.id);
    const firstLog = foreignLog(f, relay.id);
    f.store.startTask(relay.id);
    f.store.completeTask(relay.id, { output: "First summary" });
    expect(f.lane()?.cursorSeq).toBe(0);
    const duplicate = f.transaction(() => f.store.sendEnvelopeWithinTransaction({
      to: { role: "relay", issueId: f.issue.id }, kind: "report", outcome: "done", wake: "now",
      dedupeKey: `relay:${f.issue.id}:${first.id}`, body: "Repeated terminal hook", source: { issueId: f.issue.id, taskId: first.id },
    }, [], createCommitEventQueue()));
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0]).toMatchObject({ deduplicated: true, action: "none" });
    expect(f.reports()).toHaveLength(1);
    const second = f.store.createSessionTask(f.session.id, { agentId: f.agent.id, prompt: "Second round" });
    f.store.claimTask(f.runtime.id);
    f.store.startTask(second.id);
    f.store.completeTask(second.id, { output: "Second result" });
    const nextRelay = f.store.listTasks().find(task => task.chatSessionId === f.chat.id && task.status === "queued")!;
    f.store.claimTask(f.runtime.id);
    const nextLog = foreignLog(f, nextRelay.id);
    expect(nextLog.from_seq).toBe(0);
    expect(nextLog.to_seq).toBeGreaterThan(firstLog.to_seq);
    const { app, headers } = await authenticatedTask(f, nextRelay.id);
    const own = await app.request(`/api/sessions/${f.chat.id}/messages?from=0&to=${f.store.getConversationLogHead(f.chat.id)!.headSeq}`, { headers });
    expect(own.status).toBe(200);
    const bodies = (await own.json()).entries.map((row: any) => row.body_md).join("\n");
    expect(bodies).toContain("First result");
    expect(bodies).toContain("Second result");
    expect(bodies).not.toContain(foreignBody);
    expect(f.reports()).toHaveLength(2);
    assertForeignCursorUnchanged(f);
  });

  it("does not read foreign Issue history even when its reader would fail", () => {
    const f = setup();
    const relay = claimRelayAfterCompletedIssueRound(f);
    const toSeq = f.store.getBoundIssueLogToSeq(relay.id)!;
    expect(toSeq).toBe(5);
    const read = spyOn(f.store, "listConversationLogShown").mockImplementation(() => {
      throw new Error("injected foreign relay log read failure");
    });
    try {
      expect(foreignLog(f, relay.id).to_seq).toBe(toSeq);
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
    f.store.startTask(relay.id);
    f.store.completeTask(relay.id, { output: "Summary from the delivered Chat report" });
    assertForeignCursorUnchanged(f);

    const nextRelay = claimRelayAfterCompletedIssueRound(f);
    expect(foreignLog(f, nextRelay.id).to_seq).toBeGreaterThan(toSeq);
    expect(f.reports()).toHaveLength(2);
    expect(f.reports().every(message => message.body.includes("Issue result"))).toBe(true);
  });

  it("does not write a foreign delivery marker even when its writer would fail", () => {
    const f = setup();
    const relay = claimRelayAfterCompletedIssueRound(f);
    const mark = spyOn(f.store, "markBoundIssueLogDelivered").mockImplementation(() => {
      throw new Error("injected foreign relay delivery marker failure");
    });
    try {
      expect(foreignLog(f, relay.id).to_seq).toBe(5);
      expect(mark).not.toHaveBeenCalled();
    } finally {
      mark.mockRestore();
    }
    f.store.startTask(relay.id);
    f.store.completeTask(relay.id, { output: "Summary without foreign delivery" });
    assertForeignCursorUnchanged(f);
  });

  it("rejects a mismatched frozen marker and never attempts it while offering foreign metadata", () => {
    const f = setup();
    const relay = claimRelayAfterCompletedIssueRound(f);
    expect(f.store.getBoundIssueLogToSeq(relay.id)).toBe(5);
    expect(f.store.markBoundIssueLogDelivered(relay.id, 6)).toBe(false);
    const originalMark = f.store.markBoundIssueLogDelivered.bind(f.store);
    const mark = spyOn(f.store, "markBoundIssueLogDelivered").mockImplementation((taskId, toSeq) => originalMark(taskId, toSeq + 1));
    const warnings = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(foreignLog(f, relay.id).to_seq).toBe(5);
      expect(mark).not.toHaveBeenCalled();
      expect(warnings.mock.calls).toHaveLength(0);
    } finally {
      mark.mockRestore();
      warnings.mockRestore();
    }
    f.store.startTask(relay.id);
    f.store.completeTask(relay.id, { output: "No foreign delivery window" });
    assertForeignCursorUnchanged(f);
  });

  it("does not warn or mark delivery when offering the safe frozen foreign window", () => {
    const f = setup();
    const relay = claimRelayAfterCompletedIssueRound(f);
    const mark = spyOn(f.store, "markBoundIssueLogDelivered");
    const warnings = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(foreignLog(f, relay.id).to_seq).toBe(5);
      expect(mark).not.toHaveBeenCalled();
      expect(warnings.mock.calls).toHaveLength(0);
    } finally {
      mark.mockRestore();
      warnings.mockRestore();
    }
    assertForeignCursorUnchanged(f);
  });

  it("replays the relay and pending-turn migrations twice without losing either column", () => {
    const f = setup();
    runMigrations(f.db);
    runMigrations(f.db);
    const task = f.store.createSessionTask(f.session.id, { agentId: f.agent.id, prompt: "Migration check" });
    expect(f.db.query("SELECT bound_issue_log_to_seq, bound_issue_log_delivered_seq FROM multiremi_turn_execution_records WHERE id = ?")
      .get(task.id)).toEqual({ bound_issue_log_to_seq: null, bound_issue_log_delivered_seq: null });
    for (const id of ["20260929_relay_issue_log_to_seq", "20260929_relay_issue_log_delivered_seq", "20260929_tasks_one_pending_turn"]) {
      const row = f.db.query("SELECT COUNT(*) AS count FROM multiremi_schema_migrations WHERE id = ?")
        .get(id) as { count: number | bigint };
      expect(Number(row.count)).toBe(1);
    }
  });

  it("clears a historical delivery marker before retrying a stale relay without reading foreign history", () => {
    const f = setup();
    const relay = claimRelayAfterCompletedIssueRound(f);
    const firstLog = foreignLog(f, relay.id);
    const deliveredSeq = () => (f.db.query("SELECT bound_issue_log_delivered_seq FROM multiremi_turn_execution_records WHERE id = ?")
      .get(relay.id) as { bound_issue_log_delivered_seq: number | null }).bound_issue_log_delivered_seq;
    // Persist a pre-cutover receipt; a retry must invalidate that old proof.
    runTurnExecutionMutation(f.db as unknown as UnifiedFixtureDatabase, "UPDATE multiremi_turn_execution_records SET bound_issue_log_delivered_seq = ?, dispatched_at = ? WHERE id = ?", [
      firstLog.to_seq, new Date(Date.now() - 120_000).toISOString(), relay.id,
    ]);
    expect(deliveredSeq()).toBe(firstLog.to_seq);
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(relay.id);
    expect(deliveredSeq()).toBeNull();
    const read = spyOn(f.store, "listConversationLogShown").mockImplementation(() => {
      throw new Error("injected reclaimed foreign relay read failure");
    });
    try {
      expect(foreignLog(f, relay.id).to_seq).toBe(firstLog.to_seq);
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
    f.store.startTask(relay.id);
    f.store.completeTask(relay.id, { output: "Reclaimed from the delivered Chat report" });
    assertForeignCursorUnchanged(f);
  });

  it("waits for the final active Issue task regardless of its assignee", async () => {
    const f = setup();
    const other = f.store.createAgent({ name: "Contributor", provider: "codex", maxConcurrentTasks: 4 });
    const first = f.store.createSessionTask(f.session.id, { agentId: f.agent.id, prompt: "First" });
    const second = f.store.createSessionTask(f.session.id, { agentId: other.id, prompt: "Second" });
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(first.id);
    f.store.startTask(first.id);
    const firstReader = await authenticatedTask(f, first.id);
    const firstRead = await firstReader.app.request(`/api/sessions/${f.session.id}/messages?from=0&to=${f.store.getConversationLogHead(f.session.id)!.headSeq}`, { headers: firstReader.headers });
    expect(firstRead.status).toBe(200);
    f.store.failTask(first.id, { error: "Failed while contributor is pending", failureReason: "agent_error" });
    expect(f.reports()).toHaveLength(0);
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(second.id);
    f.store.startTask(second.id);
    const secondReader = await authenticatedTask(f, second.id);
    const secondRead = await secondReader.app.request(`/api/sessions/${f.session.id}/messages?from=0&to=${f.store.getConversationLogHead(f.session.id)!.headSeq}`, { headers: secondReader.headers });
    expect(secondRead.status).toBe(200);
    f.store.cancelTask(second.id);
    expect(f.reports()).toHaveLength(1);
    expect(f.reports()[0]!.body).toContain(second.id);
  });

  it("does not advance the relay lane after a failed chat task", () => {
    const f = setup();
    const first = f.store.createSessionTask(f.session.id, { agentId: f.agent.id, prompt: "Issue work" });
    f.store.claimTask(f.runtime.id);
    f.store.startTask(first.id);
    f.store.completeTask(first.id, { output: "First result" });
    const relay = f.store.listTasks().find(task => task.chatSessionId === f.chat.id && task.wakeSource === "platform_to_owner")!;
    f.store.claimTask(f.runtime.id);
    const firstLog = foreignLog(f, relay.id);
    f.store.startTask(relay.id);
    f.store.failTask(relay.id, { error: "Delivery failed", failureReason: "agent_error" });
    expect(f.lane()?.cursorSeq).toBe(0);
    const second = f.store.createSessionTask(f.session.id, { agentId: f.agent.id, prompt: "Another round" });
    f.store.claimTask(f.runtime.id);
    f.store.startTask(second.id);
    f.store.completeTask(second.id, { output: "Second result" });
    const nextRelay = f.store.listTasks().find(task => task.chatSessionId === f.chat.id && task.status === "queued")!;
    f.store.claimTask(f.runtime.id);
    const nextLog = foreignLog(f, nextRelay.id);
    expect(nextLog.from_seq).toBe(0);
    expect(nextLog.to_seq).toBeGreaterThan(firstLog.to_seq);
    const reports = f.reports().map(message => message.body).join("\n");
    expect(reports).toContain("First result");
    expect(reports).toContain("Second result");
    assertForeignCursorUnchanged(f);
  });

  it("folds an owned public Issue body while preserving authenticated full-message and range reads", async () => {
    const f = setup();
    const body = "Issue detail: " + "x".repeat(4_001);
    const entry = f.store.appendConversationLog({
      sessionId: f.session.id, kind: "message", authorType: "member", bodyMd: body,
    });
    const task = f.store.createSessionTask(f.session.id, { agentId: f.agent.id, prompt: "Read this Issue detail" });
    expect(task.chatSessionId).toBeNull();
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(task.id);
    const wire = daemonTaskClaimResponse(f.store, f.store.getTaskWithAgent(task.id)!);
    const projection = wire.session_projection as { jsonl: string; to_seq: number };
    const projected = projection.jsonl.split("\n").map(line => JSON.parse(line))
      .find(line => line.type === "session_event" && line.seq === entry.seq);
    expect(projected).toMatchObject({ body_folded: true, expand: `remi message get ${entry.id}` });
    expect(projected.body).toBeUndefined();
    expect(f.store.getConversationLogEntry(f.session.id, entry.seq)?.body_md).toBe(body);
    const { app, headers } = await authenticatedTask(f, task.id);
    const expanded = await app.request(`/api/messages/${entry.id}`, { headers });
    expect(expanded.status).toBe(200);
    expect((await expanded.json()).message.body_md).toBe(body);
    const range = await app.request(`/api/sessions/${f.session.id}/messages?from=0&to=${projection.to_seq}`, { headers });
    expect(range.status).toBe(200);
    const page = await range.json();
    expect(page.next_cursor).toBeNull();
    expect(page.entries.find((row: any) => row.id === entry.id).body_md).toBe(body);
  });

  it("caps authenticated public Issue range pages at 100 and reads the full frozen interval", async () => {
    const f = setup();
    for (let index = 0; index < 110; index++) {
      f.store.createIssueComment(f.issue.id, {
        issueSessionId: f.session.id, authorType: "system", authorId: null,
        body: `Log item ${index.toString().padStart(3, "0")}`,
      });
    }
    const task = f.store.createSessionTask(f.session.id, { agentId: f.agent.id, prompt: "Read the log" });
    expect(task.chatSessionId).toBeNull();
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(task.id);
    const toSeq = f.store.getConversationLogHead(f.session.id)!.headSeq;
    // The range reader omits this Agent's own turn card, while retaining every message body.
    const expected = f.store.listConversationLogShown(f.session.id, { toSeq })
      .filter(entry => entry.kind !== "turn");
    const { app, headers } = await authenticatedTask(f, task.id);
    const path = `/api/sessions/${f.session.id}/messages?from=0&to=${toSeq}`;
    const first = await app.request(path, { headers });
    expect(first.status).toBe(200);
    const firstPage = await first.json();
    // The first 100 log rows include this Agent's turn pointer at seq 2.
    expect(firstPage.read_end).toEqual({ seq: 101, offset: 0 });
    expect(firstPage.entries).toHaveLength(99);
    expect(firstPage.next_cursor).toBeString();
    expect(firstPage.read_end.seq).toBeLessThan(toSeq + 1);
    expect(JSON.stringify(firstPage.entries)).not.toContain("Log item 109");
    f.store.createIssueComment(f.issue.id, { body: "LATE_PUBLIC_BODY_OUTSIDE_FROZEN_RANGE" });
    const next = await app.request(`${path}&cursor=${encodeURIComponent(firstPage.next_cursor)}`, { headers });
    expect(next.status).toBe(200);
    const nextPage = await next.json();
    expect(nextPage.next_cursor).toBeNull();
    expect(nextPage.read_end).toEqual({ seq: toSeq + 1, offset: 0 });
    const entries = [...firstPage.entries, ...nextPage.entries];
    expect(entries.map(row => ({ id: row.id, body: row.body_md })))
      .toEqual(expected.map(row => ({ id: row.id, body: row.body_md })));
    expect(entries.filter(row => row.body_md.startsWith("Log item "))).toHaveLength(110);
    expect(JSON.stringify(entries)).not.toContain("LATE_PUBLIC_BODY_OUTSIDE_FROZEN_RANGE");
    expect(f.store.getSessionAgentReadProgress(f.session.id, f.agent.id, task.id)).toMatchObject({ seq: toSeq, offset: 0 });
  }, 30_000);

  it("hides system queue rows from user edits, priority, and removal", () => {
    const f = fixture();
    const agent = f.store.createAgent({ name: "Relay queue", provider: "codex", maxConcurrentTasks: 4 });
    const issue = f.store.createIssue({ title: "Bound", status: "in_progress" });
    const chat = f.store.createChatSession({ agentId: agent.id });
    const runtime = f.store.registerRuntime({ name: "Chat", provider: "codex", maxConcurrency: 4 });
    const user = f.store.sendChatMessage(chat.id, { content: "Private turn" });
    f.store.claimTask(runtime.id);
    f.store.startTask(user.task.id);
    f.store.cancelTask(user.task.id);
    bindFeishuTopicFixture(f.store, f.db, chat.id, issue.id);
    const sent = f.transaction(() => f.store.sendEnvelopeWithinTransaction({
      to: { role: "chat", chatSessionId: chat.id, agentId: agent.id }, kind: "report", wake: "now",
      body: "Read bound Issue", source: { issueId: issue.id },
    }, [], createCommitEventQueue()))[0]!;
    expect(sent.action).toBe("created");
    expect(sent.task?.wakeSource).not.toBeNull();
    expect(f.store.listQueuedChatTasks(chat.id)).toEqual([]);
    expect(() => f.store.updateQueuedChatTask(chat.id, sent.task!.id, "Tampered")).toThrow();
    expect(() => f.store.prioritizeQueuedChatTask(chat.id, sent.task!.id)).toThrow();
    expect(() => f.store.removeQueuedChatTasks(chat.id, sent.task!.id)).toThrow();
    f.store.removeQueuedChatTasks(chat.id);
    expect(f.store.getTask(sent.task!.id)?.status).toBe("queued");
  });
});
