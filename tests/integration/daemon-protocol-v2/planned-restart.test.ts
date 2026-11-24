import { expect, test } from "bun:test";
import { createResponsibleTestIssue } from "../../unit/multiremi/helpers.js";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DaemonProtocolHarness, waitFor } from "./harness.js";
import { useMigratedIntegrationDatabases } from "../../helpers/integration-database.js";
import type { TraceEvent } from "@multiremi/contracts/trace.js";
import { createHash } from "node:crypto";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { daemonTraceService } from "@multiremi/api/daemon-protocol/trace-handlers.js";
import { EMPTY_TURN_TRACE, applyTurnTraceEvents } from "@shared/turn-trace.js";
import { PlannedRestartJournal } from "@multiremi/worker/planned-restart-journal.js";

useMigratedIntegrationDatabases();

// Real daemon/provider lifetime, disk outbox/journal and authenticated v2 RPCs.
// Candidate update acceptance is exercised separately with the MUL-27 harness.
for (const kind of ["task", "autopilot", "lost response", "large context"] as const) test(`${kind} joins provider shutdown before preparing and acknowledging the same-attempt checkpoint`, async () => {
  let entered = false;
  let resumed = false;
  let providerClosed = false;
  let releaseClose!: () => void;
  const closed = new Promise<void>(resolve => { releaseClose = resolve; });
  const h = await DaemonProtocolHarness.create({ outboxBackoffMs: [5], providerFactory: () => ({
    async *sendStream(_message, options) {
      if (providerClosed) {
        resumed = true;
        yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "complete resumed answer" }] } as any;
        return;
      }
      entered = true;
      await new Promise<never>((_resolve, reject) => {
        const stop = () => reject(new Error("Cancelled"));
        if (options?.signal?.aborted) stop();
        else options?.signal?.addEventListener("abort", stop, { once: true });
      });
    },
    getLastResponse: () => ({ text: resumed ? "complete resumed answer" : "", sessionId: "planned-session", usage: [], toolCalls: [] } as any),
    close: async () => { await closed; providerClosed = true; },
  }) });
  try {
    await h.startDaemon();
    await h.settleHeartbeat();
    const runtimeId = h.store.listRuntimes()[0]!.id;
    const daemonId = h.store.getRuntimeLite(runtimeId)!.daemonId!;
    const agent = h.store.createAgent({ name: "Planned stop", provider: "claude", runtimeId });
    const autopilot = kind === "autopilot" ? h.store.createAutopilot({ title: "Planned automation", assigneeId: agent.id, executionMode: "run_only" }) : null;
    const run = autopilot ? h.store.runAutopilot(autopilot.id, { prompt: "Long synthetic round" }) : null;
    const task = run ? h.store.getTask(run.taskId!)! : h.store.createTask({ agentId: agent.id, runtimeId, prompt: "Long synthetic round", maxAttempts: 1 });
    const maxAttempts = task.maxAttempts;
    await waitFor(() => entered, "provider entered", 5_000);
    expect(h.client.sharesCap("turn.restart")).toBe(true);
    expect(h.store.getRuntimeLite(runtimeId)?.metadata).toMatchObject({ planned_restart: 1, planned_restart_negotiated: true });
    h.store.beginDaemonDrain("local", daemonId, "manual", 1);
    await Bun.sleep(2);
    h.store.reconcileDaemonDrain(runtimeId);
    const handoff = h.store.plannedRestarts().get(task.id)!;
    expect(handoff).not.toBeNull();
    await waitFor(() => h.received.some(f => f.t === "turn.restart"), "restart request delivered");
    expect(h.client.sharesCap("turn.restart")).toBe(true);
    expect(providerClosed).toBe(false);
    expect(h.store.plannedRestarts().get(task.id)?.state).toBe("requested");
    expect((h.daemon as any).restartJournal.entries()).toHaveLength(0);
    releaseClose();
    await waitFor(() => h.store.plannedRestarts().get(task.id)?.state === "suspended", "checkpoint RPC committed", 10_000);
    await waitFor(() => (h.daemon as any).activeTaskCount === 0, "checkpoint locally acknowledged");
    expect(providerClosed).toBe(true);
    expect(h.store.getTask(task.id)).toMatchObject({ status: "running", attempt: 1, maxAttempts, sessionId: "planned-session" });
    const journalPath = readdirSync(h.root).find(name => name.startsWith("restart-") && name.endsWith(".db"))!;
    const journal = new PlannedRestartJournal(join(h.root, journalPath));
    try { expect(journal.get(handoff.handoff_id)).toMatchObject({ state: "acknowledged", execution: { attempt_id: task.id, generation: 0 } }); }
    finally { journal.close(); }
    expect(h.ledger.some(e => e.type === "task.fail")).toBe(false);
    expect(h.ledger.some(e => e.type === "turn.restart.checkpoint")).toBe(true);
    expect(h.ledger.some(e => e.type === "turn.restart.suspend")).toBe(true);
    await h.stopDaemon();
    const originalResume = (h.layer as any).rpcHandlers.get("turn.restart.resume_bound");
    let dropped = false;
    let fenced = false;
    let failed = false;
    h.layer.registerRpcHandler("turn.restart.resume_bound", async (frame, session) => {
      const reply = await originalResume(frame, session);
      if (reply.code === "resume_fenced") fenced = true;
      if (kind === "lost response" && reply.ok && dropped && !failed) {
        failed = true;
        throw new Error("Injected resume server failure after lost reply");
      }
      if (kind === "lost response" && reply.ok && !dropped) {
        dropped = true;
        return session.deferReply(frame.id!, new Promise(() => {}));
      }
      return reply;
    });
    if (kind === "large context") h.store.updateAgent(agent.id, { instructions: "Resume context ".repeat(100_000) });
    // The real operator sequence keeps the manual fence through replacement.
    await h.recreateDaemon();
    await waitFor(() => fenced, "resume fenced while drain survives");
    expect(h.store.plannedRestarts().get(task.id)?.state).toBe("suspended");
    expect(resumed).toBe(false);
    h.store.undrainDaemon("local", daemonId);
    if (kind === "lost response") {
      await waitFor(() => dropped, "first resume response lost", 10_000);
      expect(h.store.plannedRestarts().get(task.id)?.state).toBe("resuming");
      expect(h.store.recoverOrphans(runtimeId)).toEqual({ orphaned: 0, retried: 0 });
      h.clock.advance(30_001);
      await waitFor(() => failed, "retry receives server_error", 10_000);
      expect(h.store.recoverOrphans(runtimeId)).toEqual({ orphaned: 0, retried: 0 });
      expect(h.store.plannedRestarts().get(task.id)?.state).toBe("resuming");
    }
    await waitFor(() => h.store.getTask(task.id)?.status === "completed", "same attempt finished after replacement", 10_000);
    expect(h.store.plannedRestarts().get(task.id)?.state).toBe("running");
    expect(resumed).toBe(true);
    if (kind === "lost response") expect(failed).toBe(true);
    if (run) expect(h.store.getAutopilotRun(run.id)?.status).toBe("completed");
    expect(h.store.getTask(task.id)).toMatchObject({ status: "completed", attempt: 1, maxAttempts, result: "complete resumed answer" });
    expect(h.ledger.some(e => e.type === "turn.restart.resume_bound")).toBe(true);
    expect(h.ledger.some(e => e.type === "turn.restart.resume")).toBe(false);
    expect(h.ledger.some(e => e.type === "task.fail")).toBe(false);
    expect(h.ledger.filter(e => e.type === "turn.complete").at(-1)?.frame.p.generation).toBe(1);
    expect(h.db.query("SELECT id FROM multiremi_turn_attempts WHERE turn_id=?").all(handoff.turn_id)).toHaveLength(1);
    const trace = h.daemon.traceStore().read(task.id, 0, 500, 1024 * 1024).events;
    expect(trace.filter(event => event.type === "turn.started")).toHaveLength(1);
    expect(trace.some(event => {
      const item = event.item as { type?: string; title?: string } | undefined;
      return event.type === "item.completed" && item?.type === "notice" && item.title === "Remi 已更新";
    })).toBe(true);
  } finally { releaseClose(); await h.dispose(); }
}, 25_000);

test("live report, input and trace boundaries reject suspended and obsolete generations", async () => {
  const h = await DaemonProtocolHarness.create({ onReady: daemon => { (daemon as any).claimsPaused = true; } });
  try {
    await h.startDaemon();
    const runtimeId = h.store.listRuntimes()[0]!.id;
    const daemonId = h.store.getRuntimeLite(runtimeId)!.daemonId!;
    const scope = { workspaceId: "local", runtimeId, daemonId };
    const agent = h.store.createAgent({ name: "Generation boundaries", provider: "claude", runtimeId });
    const task = h.store.createTask({ agentId: agent.id, runtimeId, prompt: "Generation fixture", maxAttempts: 1 });
    expect(h.store.claimTask(runtimeId)?.id).toBe(task.id);
    h.store.startTask(task.id);
    const input = h.store.getDaemonTurnBridge().offerInput(h.store.getTaskWithAgent(task.id)!);
    h.store.beginDaemonDrain("local", daemonId, "manual", 60_000);
    const handoff = h.store.plannedRestarts().request(task.id, scope);
    const identity = { turn_id: handoff.turn_id, attempt_id: task.id, handoff_id: handoff.handoff_id, generation: 0 };
    await expect(h.client.rpc("turn.restart.checkpoint", { ...identity, handoff_id: "obsolete" }, runtimeId))
      .rejects.toMatchObject({ code: "stale_execution", retryable: false });
    const refs = await h.client.rpc("turn.restart.checkpoint", identity, runtimeId);
    await h.client.rpc("turn.restart.suspend", { ...identity, checkpoint: refs.checkpoint }, runtimeId);
    const before = h.store.getTask(task.id)!;
    let seq = 990_000;
    const progress = (generation?: number) => h.client.event({ t: "task.progress", seq: ++seq, rt: runtimeId,
      p: { task_id: task.id, summary: "late progress", generation } });
    await expect(progress(0)).rejects.toMatchObject({ code: "stale_execution" });
    await expect(h.client.rpc("turn.input", { ...input, message_ids: [], generation: 0 }, runtimeId))
      .rejects.toMatchObject({ code: "stale_execution" });
    const append = (generation: number) => h.client.rpc("trace.append", { task_id: task.id, generation, closed: false,
      events: [{ seq: 1, ts: new Date().toISOString(), type: "turn.started", turn: { status: "running" } }] }, runtimeId);
    await expect(append(0)).rejects.toMatchObject({ code: "stale_execution" });
    expect(h.store.getTask(task.id)).toEqual(before);
    h.store.undrainDaemon("local", daemonId);
    // Storage CAS only: no claim that startup/provider activation is implemented.
    h.store.plannedRestarts().resume(task.id, handoff.handoff_id, "generation-consumer-0001", scope, () => {});
    await expect(progress()).rejects.toMatchObject({ code: "stale_execution" });
    await expect(progress(0)).rejects.toMatchObject({ code: "stale_execution" });
    await expect(append(0)).rejects.toMatchObject({ code: "stale_execution" });
    await progress(1);
    expect(h.store.getTask(task.id)?.progressSummary).toBe("late progress");
    expect(h.store.getTask(task.id)).toMatchObject({ status: "running", attempt: 1, maxAttempts: 1 });
    await expect(h.client.event({ t: "task.fail", seq: ++seq, rt: runtimeId,
      p: { task_id: task.id, generation: 0, error: "old provider died" } })).rejects.toMatchObject({ code: "stale_execution" });
    await expect(h.client.event({ t: "turn.complete", seq: ++seq, rt: runtimeId,
      p: { ...input, generation: 0, reply: { body_md: "old reply", message_kind: "final" } } }))
      .rejects.toMatchObject({ code: "stale_execution" });
    expect(h.store.getTask(task.id)?.status).toBe("running");
  } finally { await h.dispose(); }
}, 20_000);

for (const unresponsive of ["cancel", "close"] as const) test(`planned restart bounds an unresponsive provider ${unresponsive} and keeps crash retry semantics`, async () => {
  let entered = false;
  let expired = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = await DaemonProtocolHarness.create({ daemonOptions: { stopTimeoutMs: 200, onStopTimeout: () => { expired = true; } },
    providerFactory: () => ({
      async *sendStream(_message, options) {
        entered = true;
        if (unresponsive === "cancel") { await gate; throw new Error("Cancelled"); }
        await new Promise<never>((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true }));
      },
      getLastResponse: () => ({ text: "", sessionId: "timeout-session", usage: [], toolCalls: [] } as any),
      close: async () => { if (unresponsive === "close") await gate; },
    }) });
  try {
    await h.startDaemon();
    const runtimeId = h.store.listRuntimes()[0]!.id;
    const daemonId = h.store.getRuntimeLite(runtimeId)!.daemonId!;
    const agent = h.store.createAgent({ name: "Uncooperative provider", provider: "claude", runtimeId });
    const issue = h.store.createIssue({ title: "Hung provider restart", assigneeType: "agent", assigneeId: agent.id });
    const task = h.store.createTask({ agentId: agent.id, issueId: issue.id, runtimeId, prompt: "Long tool", maxAttempts: 2 });
    await waitFor(() => entered, "provider entered", 5_000);
    h.store.beginDaemonDrain("local", daemonId, "deploy", 1);
    await Bun.sleep(5);
    h.store.reconcileDaemonDrain(runtimeId);
    const started = performance.now();
    await waitFor(() => expired, "bounded crash fallback", 2_000);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(h.daemon.traceStore().read(task.id).events.some(event => (event.item as any)?.title === "Remi 已更新")).toBe(false);
    expect(h.daemon.restartRequested()).toBe(true);
    expect(h.store.plannedRestarts().get(task.id)?.state).toBe("requested");
    expect(h.store.plannedRestarts().protectsFromOrphanRecovery(task.id)).toBe(false);
    release();
    await h.stopDaemon();
    const recovered = h.store.recoverOrphans(runtimeId);
    expect(recovered).toEqual({ orphaned: 1, retried: 1 });
    expect(h.store.getTask(task.id)).toMatchObject({ status: "failed", failureReason: "runtime_recovery" });
    expect(h.store.listTasks().filter(next => next.parentTaskId === task.id)).toHaveLength(1);
  } finally { release(); await h.dispose(); }
}, 20_000);


for (const httpProbe of [false, true]) test(`${httpProbe ? "version 1 HTTP probe without named capability" : "old capability fixture"} cancels through the real socket and admits CLI update after the deadline`, async () => {
  let entered = false;
  const h = await DaemonProtocolHarness.create({
    cliVersion: "0.2.95", // N-1 fixture: admission succeeds, named restart capability is absent.
    onReady: daemon => {
      (daemon.daemonProtocolClient() as any).extraCaps.delete("turn.restart");
      const capabilities = (daemon as any).runtimeCapabilities.bind(daemon);
      if (!httpProbe) (daemon as any).runtimeCapabilities = () => {
        const { planned_restart: _unsupported, ...legacy } = capabilities();
        return legacy;
      };
    },
    providerFactory: () => ({
      async *sendStream(_message, options) {
        entered = true;
        await new Promise<never>((_resolve, reject) => {
          const stop = () => reject(new Error("Cancelled"));
          if (options?.signal?.aborted) stop();
          else options?.signal?.addEventListener("abort", stop, { once: true });
        });
      },
      getLastResponse: () => ({ text: "", sessionId: "legacy-session", usage: [], toolCalls: [] } as any),
      close: async () => {},
    }),
  });
  try {
    await h.startDaemon(); await h.settleHeartbeat();
    const runtime = h.store.listRuntimes()[0]!;
    const runtimeId = runtime.id, daemonId = runtime.daemonId!;
    expect(h.store.getRuntimeLite(runtimeId)?.metadata.planned_restart).toBe(0);
    // A legacy reconnect must clear previously stored support too.
    h.store.heartbeatRuntime(runtimeId, { claimPending: false, plannedRestartNegotiated: true, plannedRestartProtocol: 1 });
    await h.disconnect(); await h.reconnect(); await h.settleHeartbeat();
    expect(h.store.getRuntimeLite(runtimeId)?.metadata.planned_restart).toBe(0);
    expect(h.store.getRuntimeLite(runtimeId)?.metadata.planned_restart_negotiated).toBe(false);
    if (httpProbe) {
      expect((h.daemon as any).runtimeCapabilities().planned_restart).toBe(1);
      // The upgrade probe uses HTTP while the current socket lacks the handler.
      const response = await fetch(`${h.url}/api/daemon/heartbeat`, { method: "POST",
        headers: { Authorization: "Bearer fixture-master", "Content-Type": "application/json" },
        body: JSON.stringify({ runtime_id: runtimeId, planned_restart: 1 }) });
      expect(response.status).toBe(200);
      expect(h.store.getRuntimeLite(runtimeId)?.metadata.planned_restart).toBe(0);
    }
    const agent = h.store.createAgent({ name: "Legacy capability", provider: "claude", runtimeId });
    const issue = createResponsibleTestIssue(h.store, { title: "Legacy update", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
    const task = h.store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Legacy long work", maxAttempts: 3 });
    await waitFor(() => entered, "legacy provider running");
    h.store.beginDaemonDrain("local", daemonId, "cli_update", 100);
    // This test checks installation admission, so prevent the real update pump
    // from consuming the update; installer/watchdog acceptance is separate.
    (h.daemon as any).claimsPaused = true;
    const began = performance.now();
    await Bun.sleep(110); h.store.reconcileDaemonDrain(runtimeId);
    h.store.reconcileDaemonDrain(runtimeId);
    await waitFor(() => (h.daemon as any).activeTaskCount === 0, "legacy cancellation reaches provider", 5_000);
    await h.settleHeartbeat();
    expect(h.store.plannedRestarts().get(task.id)).toBeNull();
    expect(h.received.some(frame => frame.t === "turn.restart")).toBe(false);
    expect(h.received.some(frame => frame.t === "task.cancelled")).toBe(true);
    expect(h.store.getTask(task.id)).toMatchObject({ status: "failed", failureReason: "runtime_recovery", attempt: 1 });
    expect(h.store.listTasksForIssue(issue.id).filter(retry => retry.attempt === 2 && retry.status === "queued")).toHaveLength(1);
    expect(h.store.listTasksForIssue(issue.id).some(retry => retry.attempt > 2)).toBe(false);
    expect(h.store.getDaemonDrainStatus("local", daemonId)).toMatchObject({ status: "drained_forced", remaining_tasks: 0, awaiting_daemon_ack: false });
    const update = h.store.createRuntimeUpdateRequest(runtimeId, { scope: "cli", targetVersion: "0.2.96" });
    expect(h.store.claimRuntimeUpdateRequest(runtimeId)?.id).toBe(update.id);
    h.store.reportRuntimeUpdateResult(runtimeId, update.id, { status: "restarting" });
    h.store.recordDaemonProtocol(runtimeId, daemonId, 2, "0.2.96");
    h.store.reportRuntimeUpdateResult(runtimeId, update.id, { status: "completed", self_check: true });
    expect(h.store.getRuntimeUpdateRequest(runtimeId, update.id)?.status).toBe("completed");
    expect(performance.now() - began).toBeLessThan(5_000);
    console.log(`legacy fixture: drain 100ms, cancellation/ACK/update admission ${Math.round(performance.now() - began)}ms`);
  } finally { await h.dispose(); }
}, 20_000);


test("per-runtime restart version cannot grant support without the negotiated hello capability", async () => {
  const h = await DaemonProtocolHarness.create({ beforeStart: harness => {
    (harness.client as any).extraCaps.delete("turn.restart");
  } });
  try {
    await h.startDaemon(); await h.settleHeartbeat();
    const runtimeId = h.store.listRuntimes()[0]!.id;
    expect((h.daemon as any).runtimeCapabilities().planned_restart).toBe(1);
    expect(h.store.getRuntimeLite(runtimeId)?.metadata.planned_restart).toBe(0);
    expect(h.ledger.find(entry => entry.type === "hello")?.frame.p.caps).not.toContain("turn.restart");
    expect(h.client.sharesCap("turn.restart")).toBe(false);
  } finally { await h.dispose(); }
}, 10_000);

const waitResumeCases = (["permission", "question"] as const).flatMap(kind =>
  (["suspended", "resumed"] as const).map(answerAt => ({ kind, answerAt, snapshot: true })));
waitResumeCases.push({ kind: "permission", answerAt: "suspended", snapshot: false });
for (const { kind, answerAt, snapshot } of waitResumeCases) {
  test(`daemon resumes the original ${kind} callback and consumes an answer saved while ${answerAt}${snapshot ? "" : " with fold-only trace"}`, async () => {
    let replacement = false, replyUsed = false, rebound = false;
    const h = await DaemonProtocolHarness.create({ daemonOptions: { approvalMode: "ask" }, providerFactory: () => {
      let permission: ((params: any) => Promise<any>) | undefined;
      let elicitation: ((params: any) => Promise<any>) | undefined;
      return {
        setPermissionHandler: handler => { permission = handler; },
        setElicitationHandler: handler => { elicitation = handler; },
        async *sendStream(_message, options) {
          if (replacement) rebound = true;
          const outcome = kind === "permission" ? await permission!({ sessionId: "permission-session",
            toolCall: { toolCallId: replacement ? "reissued-tool" : "old-tool", title: "Write receipt", rawInput: { path: "receipt.txt", content: "approved" } },
            options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }] })
            : await elicitation!({ mode: "form", sessionId: "question-session", message: "Where?",
                requestedSchema: { type: "object", properties: { city: { type: "string", title: "City" } }, required: ["city"] } });
          if (options?.signal?.aborted) throw new Error("Cancelled");
          replyUsed = replacement && (kind === "permission" ? outcome.optionId === "allow" : outcome.action === "accept" && outcome.content.city === "Paris");
          if (!replyUsed) throw new Error(`original answer was not delivered: ${JSON.stringify(outcome)}`);
          yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "Original answer applied; full final response" }] } as any;
        },
        getLastResponse: () => ({ text: replyUsed ? "Original answer applied; full final response" : "", sessionId: "wait-provider-session", usage: [], toolCalls: [] } as any),
        close: async () => { replacement = true; },
      };
    } });
    try {
      await h.startDaemon(); await h.settleHeartbeat();
      const runtimeId = h.store.listRuntimes()[0]!.id;
      const daemonId = h.store.getRuntimeLite(runtimeId)!.daemonId!;
      const agent = h.store.createAgent({ name: "Waiting worker", provider: "claude", runtimeId });
      const issue = createResponsibleTestIssue(h.store, { title: "Restart waiting callback", assigneeType: "agent", assigneeId: agent.id });
      const task = h.store.createTask({ agentId: agent.id, issueId: issue.id, runtimeId, prompt: "Wait for a human", maxAttempts: 1 });
      const turn = h.store.getTurnForAttempt(task.id)!;
      const original = () => h.db.query("SELECT id FROM multiremi_conversation_log WHERE task_id=? AND message_kind='decision'").get(turn.id);
      await waitFor(() => !!original(), "original native question", 5_000);
      const questionId = String(original()!.id);
      expect(h.store.getQuestion(questionId)).toMatchObject({ stage: "human", status: "pending", wait_status: "waiting" });
      h.store.beginDaemonDrain("local", daemonId, "manual", 60_000);
      h.store.plannedRestarts().request(task.id, { workspaceId: "local", runtimeId, daemonId });
      await waitFor(() => h.store.plannedRestarts().get(task.id)?.state === "suspended", "waiting callback checkpoint", 10_000);
      await waitFor(() => (h.daemon as any).activeTaskCount === 0, "native wait released");
      expect(h.store.plannedRestarts().get(task.id)?.checkpoint?.question_ids).toEqual([questionId]);
      expect(h.store.getQuestion(questionId)?.wait_status).toBe("waiting");
      const before = applyTurnTraceEvents(EMPTY_TURN_TRACE, h.daemon.traceStore().read(task.id).events as TraceEvent[]);
      const originalWait = before.items.find(item => (item.type === kind) && item.message_id === questionId)!;
      expect(originalWait).toMatchObject({ status: "in_progress" });
      await h.stopDaemon();
      if (!snapshot) {
        const path = join(h.root, readdirSync(h.root).find(name => name.startsWith("restart-") && name.endsWith(".db"))!);
        const db = openSqliteDatabase(path);
        try { db.run("DELETE FROM planned_restart_trace_identities"); } finally { db.close(); }
      }
      const answer = () => h.store.answerQuestion(questionId, { expected_route_revision: h.store.getQuestion(questionId)!.route_revision,
        response: kind === "permission" ? { option_id: "allow" } : { answers: { city: "Paris" } } }, { type: "member", id: "mem_local_local" });
      if (answerAt === "suspended") answer();
      h.store.undrainDaemon("local", daemonId);
      await h.recreateDaemon();
      if (answerAt === "resumed") {
        await waitFor(() => rebound, "replacement reissued native request", 5_000);
        answer();
      }
      await waitFor(() => h.store.getTask(task.id)?.status === "completed", "same attempt applied original answer", 10_000);
      expect(replyUsed).toBe(true);
      const result = await daemonTraceService(h.layer).reader.read({ runtimeId, taskId: task.id, view: "events" });
      expect(result.ok).toBe(true);
      if (!result.ok || !("events" in result)) throw new Error("server trace events unavailable");
      const state = applyTurnTraceEvents(EMPTY_TURN_TRACE, result.events as TraceEvent[]);
      const waits = state.items.filter(item => item.type === kind && item.message_id === questionId);
      expect(waits).toHaveLength(1);
      expect(waits[0]).toMatchObject({ id: originalWait.id, started_at: originalWait.started_at,
        status: "completed", tool_item_id: kind === "permission" ? "reissued-tool" : null,
        ...(kind === "permission" ? { decision: { option_id: "allow" }, outcome: "selected" } : { answers: { "Where?": "Paris" } }) });
      expect((result.events as TraceEvent[]).filter(event => event.type === "item.started" && event.item.id === originalWait.id)).toHaveLength(1);
      expect(h.store.getQuestion(questionId)).toMatchObject({ id: questionId, answer_revision: 1, wait_status: "consumed" });
      expect(h.store.getTask(task.id)).toMatchObject({ status: "completed", attempt: 1, result: "Original answer applied; full final response" });
      expect(h.db.query("SELECT id FROM multiremi_conversation_log WHERE task_id=? AND message_kind='decision'").all(turn.id)).toHaveLength(1);
      expect(h.db.query("SELECT id FROM multiremi_turn_attempts WHERE turn_id=?").all(turn.id)).toHaveLength(1);
      expect(h.ledger.some(event => event.type === "task.fail")).toBe(false);
    } finally { await h.dispose(); }
  }, 25_000);
}

for (const echoed of [false, true]) test(`steer injected before cancellation is ${echoed ? "confirmed by its provider echo" : "replayed when only queued"}`, async () => {
  let replacement = false, entered = false, injection = "", consumed = false, used = false, modelOutput = false;
  const prompts: string[] = [];
  const h = await DaemonProtocolHarness.create({ providerFactory: () => ({
    async *sendStream(message, options) {
      options?.onPromptStarted?.();
      if (replacement) {
        prompts.push(String(message));
        // The fake native session retains only explicitly consumed input.
        // Queue-only injection was lost when the old bridge closed.
        used = consumed || String(message).includes("USE_BLUE_RECEIPT");
        if (!used) throw new Error("The queued instruction was lost during restart");
        yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "Applied USE_BLUE_RECEIPT" }] } as any;
        return;
      }
      entered = true;
      while (!options?.signal?.aborted) {
        if (!echoed && injection && !modelOutput) {
          modelOutput = true;
          yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: injection }] } as any;
        }
        if (echoed && injection && !consumed) {
          consumed = true;
          yield { sessionUpdate: "user_message_chunk", content: [{ type: "text", text: injection }] } as any;
        }
        await Bun.sleep(5);
      }
      throw new Error("Cancelled");
    },
    steer: async text => { injection = text; return { outcome: "injected" as const }; },
    getLastResponse: () => ({ text: used ? "Applied USE_BLUE_RECEIPT" : "", sessionId: "steer-replay-session", usage: [], toolCalls: [] } as any),
    close: async () => { replacement = true; if (!echoed) injection = ""; },
  }) });
  try {
    await h.startDaemon(); await h.settleHeartbeat();
    const runtimeId = h.store.listRuntimes()[0]!.id;
    const daemonId = h.store.getRuntimeLite(runtimeId)!.daemonId!;
    const agent = h.store.createAgent({ name: "Steer replay", provider: "claude", runtimeId });
    const task = h.store.createTask({ agentId: agent.id, runtimeId, prompt: "Long synthetic prompt", maxAttempts: 1 });
    await waitFor(() => entered, "original prompt started");
    const message = h.store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "USE_BLUE_RECEIPT" });
    await waitFor(() => !!injection, "steer queued by the bridge");
    if (echoed) await waitFor(() => consumed, "provider consumed with exact id echo");
    else await waitFor(() => modelOutput, "model output does not prove steer consumption");
    h.store.beginDaemonDrain("local", daemonId, "manual", 60_000);
    const handoff = h.store.plannedRestarts().request(task.id, { workspaceId: "local", runtimeId, daemonId });
    await waitFor(() => h.store.plannedRestarts().get(task.id)?.state === "suspended", "steer checkpoint");
    await waitFor(() => (h.daemon as any).activeTaskCount === 0, "original execution released");
    expect(h.store.plannedRestarts().get(task.id)?.checkpoint?.delivered_message_ids.includes(message.id)).toBe(echoed);
    await h.stopDaemon(); h.store.undrainDaemon("local", daemonId); await h.recreateDaemon();
    await waitFor(() => h.store.getTask(task.id)?.status === "completed", "steer applied after replacement", 10_000);
    expect(used).toBe(true);
    if (echoed) expect(prompts.join("\n")).not.toContain("USE_BLUE_RECEIPT");
    else {
      expect(prompts[0]).toContain("USE_BLUE_RECEIPT");
      expect(prompts[0]).toContain(`[Remi steer id: ${message.id}]`);
      expect(prompts[0]).toContain("可能已经收到过");
    }
    const events = h.daemon.traceStore().read(task.id, 0, 500, 1024 * 1024).events;
    expect(events.filter(event => event.type === "item.completed" && (event.item as any)?.steer?.steer_id === message.id)).toHaveLength(1);
    expect(h.store.getTask(task.id)).toMatchObject({ attempt: 1, result: "Applied USE_BLUE_RECEIPT" });
    expect(h.db.query("SELECT id FROM multiremi_turn_attempts WHERE turn_id=?").all(handoff.turn_id)).toHaveLength(1);
    expect(h.ledger.some(event => event.type === "task.fail")).toBe(false);
  } finally { await h.dispose(); }
}, 25_000);

// Read the authoritative trace through the server's reverse daemon reader and
// fold it with the same reducer used by Turn views, across a fresh daemon.
for (const snapshot of ["valid", "missing", "digest", "binding"] as const) test(`planned restart preserves native routes and continuous Turn history with ${snapshot} identity journal`, async () => {
  const child = "a0000000000000001";
  let entered = false, replacement = false, background = true;
  const h = await DaemonProtocolHarness.create({ providerFactory: () => ({
    async *sendStream(_message, options) {
      if (replacement) {
        yield { sessionUpdate: "tool_call", toolCallId: "send_after", name: "SendMessage", kind: "other", status: "completed",
          rawInput: { to: child, message: "Continue after update" }, _meta: { claudeCode: { toolName: "SendMessage" } } } as any;
        yield { sessionUpdate: "subagent_spawned", subagentSessionId: `${child}:generation:1`, name: "Child", prompt: "Continue after update" } as any;
        yield { sessionUpdate: "tool_call", toolCallId: "child_after", name: "Bash", kind: "execute", status: "completed",
          rawInput: { command: "echo continued" }, _meta: snapshot === "valid"
            ? { claudeCode: { toolName: "Bash", parentToolUseId: "original_alias" } }
            : { remiSessionId: child, claudeCode: { toolName: "Bash" } } } as any;
        yield { sessionUpdate: "subagent_state_update", subagentSessionId: `${child}:generation:1`, state: "completed" } as any;
        yield { sessionUpdate: "tool_call", toolCallId: "send_after", name: "SendMessage", status: "completed", rawOutput: "Message delivered", _meta: { claudeCode: { toolName: "SendMessage" } } } as any;
        yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "continuous complete reply" }] } as any;
        return;
      }
      yield { sessionUpdate: "subagent_spawned", subagentSessionId: child, name: "Child", _meta: { remi: { backgrounded: true } } } as any;
      yield { sessionUpdate: "tool_call", toolCallId: "child_before", name: "Bash", kind: "execute", status: "in_progress",
        rawInput: { command: "sleep 999" }, _meta: { remiSessionId: child, claudeCode: { toolName: "Bash", parentToolUseId: "original_alias" } } } as any;
      yield { sessionUpdate: "async_task_spawned", asyncTaskId: "old_background", name: "Long background", taskType: "shell", canStop: true } as any;
      entered = true;
      await new Promise<never>((_resolve, reject) => {
        const stop = () => reject(new Error("Cancelled"));
        if (options?.signal?.aborted) stop(); else options?.signal?.addEventListener("abort", stop, { once: true });
      });
    },
    listAsyncTasks: () => background ? [{ id: "old_background", state: "running", type: "shell" } as any] : [],
    async *settleAsyncTasks() { background = false; },
    getLastResponse: () => ({ text: replacement ? "continuous complete reply" : "", sessionId: "trace-session", usage: [], toolCalls: [] } as any),
    close: async () => { replacement = true; background = false; },
  }) });
  try {
    await h.startDaemon(); await h.settleHeartbeat();
    const runtimeId = h.store.listRuntimes()[0]!.id, daemonId = h.store.getRuntimeLite(runtimeId)!.daemonId!;
    const agent = h.store.createAgent({ name: "Trace identity restart", provider: "claude", runtimeId });
    const task = h.store.createTask({ agentId: agent.id, runtimeId, prompt: "Long native and background work", maxAttempts: 1 });
    await waitFor(() => entered, "native work entered");
    h.store.beginDaemonDrain("local", daemonId, "manual", 60_000);
    const handoff = h.store.plannedRestarts().request(task.id, { workspaceId: "local", runtimeId, daemonId });
    await waitFor(() => h.store.plannedRestarts().get(task.id)?.state === "suspended", "identity checkpoint", 10_000);
    await waitFor(() => (h.daemon as any).activeTaskCount === 0, "old provider released");
    const before = applyTurnTraceEvents(EMPTY_TURN_TRACE, h.daemon.traceStore().read(task.id).events as TraceEvent[]);
    expect(before.items.find(item => item.id === `sa:${child}`)).toMatchObject({ status: "stopped" });
    expect(before.items.find(item => item.type === "background_task")).toMatchObject({ status: "stopped", stop_reason: "cancelled" });
    expect(before.items.find(item => item.id === "child_before")).toMatchObject({ status: "stopped" });
    await h.stopDaemon();
    const path = join(h.root, readdirSync(h.root).find(name => name.startsWith("restart-") && name.endsWith(".db"))!);
    const db = openSqliteDatabase(path);
    try {
      const row = db.query("SELECT payload FROM planned_restart_trace_identities WHERE handoff_id=?").get(handoff.handoff_id) as { payload: string };
      expect(row).toBeTruthy();
      if (snapshot === "missing") db.run("DELETE FROM planned_restart_trace_identities");
      if (snapshot === "digest") db.run("UPDATE planned_restart_trace_identities SET sha256='bad'");
      if (snapshot === "binding") {
        const value = JSON.parse(row.payload); value.execution.generation++;
        const payload = JSON.stringify(value);
        db.run("UPDATE planned_restart_trace_identities SET payload=?,sha256=?", [payload, createHash("sha256").update(payload).digest("hex")]);
      }
    } finally { db.close(); }
    h.store.undrainDaemon("local", daemonId); await h.recreateDaemon();
    await waitFor(() => h.store.getTask(task.id)?.status === "completed", "identity resume completed without autonomous debt", 10_000);
    const result = await daemonTraceService(h.layer).reader.read({ runtimeId, taskId: task.id, view: "events" });
    expect(result.ok).toBe(true);
    if (!result.ok || !("events" in result)) throw new Error("server trace events unavailable");
    const events = result.events as TraceEvent[];
    const state = applyTurnTraceEvents(EMPTY_TURN_TRACE, events);
    expect(events.filter(event => event.type === "turn.started")).toHaveLength(1);
    expect(events.filter(event => event.type === "item.started").map(event => event.type === "item.started" ? event.item.id : "").length)
      .toBe(new Set(events.filter(event => event.type === "item.started").map(event => event.type === "item.started" ? event.item.id : "")).size);
    expect(state.items.filter(item => item.type === "subagent")).toHaveLength(1);
    expect(state.items.find(item => item.id === "child_after")?.parent_id).toBe(`sa:${child}`);
    expect(state.items.find(item => item.type === "user_message" && item.parent_id === `sa:${child}` && item.text === "Continue after update")).toBeTruthy();
    expect(state.items.find(item => item.type === "background_task")).toMatchObject({ status: "stopped", stop_reason: "cancelled" });
    expect(state.items.filter(item => item.type === "notice" && item.title === "Remi 已更新")).toHaveLength(1);
    expect(state.turn).toMatchObject({ status: "completed", turn_id: handoff.turn_id });
    expect(h.store.getTask(task.id)).toMatchObject({ status: "completed", attempt: 1, failureReason: null, result: "continuous complete reply" });
    expect(h.db.query("SELECT id FROM multiremi_turn_attempts WHERE turn_id=?").all(handoff.turn_id)).toHaveLength(1);
    expect(h.ledger.some(event => event.type === "task.fail")).toBe(false);
  } finally { await h.dispose(); }
}, 25_000);

for (const cleanup of ["resume", "sweep", "exhaustion"] as const) test(`stale lost attempt with a running handoff stops daemon recovery via ${cleanup}`, async () => {
  let providerCalls = 0;
  const h = await DaemonProtocolHarness.create({ providerFactory: () => ({
    async *sendStream() { providerCalls++; yield {} as any; },
    getLastResponse: () => ({ text: "", sessionId: "stale-session", usage: [], toolCalls: [] } as any),
    close: async () => {},
  }) });
  try {
    await h.startDaemon();
    await h.settleHeartbeat();
    const runtimeId = h.store.listRuntimes()[0]!.id;
    const scope = { workspaceId: "local", runtimeId, daemonId: h.store.getRuntimeLite(runtimeId)!.daemonId! };
    await h.stopDaemon();
    const agent = h.store.createAgent({ name: "Stale restart", provider: "claude", runtimeId });
    const issue = createResponsibleTestIssue(h.store, { title: "Stale retry", assigneeType: "agent", assigneeId: agent.id });
    const task = h.store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Historical attempt", maxAttempts: 3 });
    h.store.claimTask(runtimeId); h.store.startTask(task.id);
    h.store.beginDaemonDrain("local", scope.daemonId);
    const restarts = h.store.plannedRestarts();
    const handoff = restarts.request(task.id, scope);
    const checkpoint = restarts.checkpointReferences(task.id, scope);
    restarts.suspend(task.id, handoff.handoff_id, 0, checkpoint, scope);
    h.store.undrainDaemon("local", scope.daemonId);
    const journalPath = readdirSync(h.root).find(name => name.startsWith("restart-") && name.endsWith(".db"))!;
    const journal = new PlannedRestartJournal(join(h.root, journalPath));
    try {
      const entry = journal.prepare({ workspace_id: "local", daemon_id: scope.daemonId, runtime_id: runtimeId,
        turn_id: handoff.turn_id, attempt_id: task.id, handoff_id: handoff.handoff_id, generation: 0 }, checkpoint);
      journal.acknowledge(handoff.handoff_id);
      restarts.resume(task.id, handoff.handoff_id, entry.consumer_id, scope, () => {});
      restarts.withExecution(task.id, 1, scope, () => {}, entry.consumer_id);
      expect(h.store.recoverOrphans(runtimeId, [])).toEqual({ orphaned: 1, retried: 1 });
      expect(h.db.query("SELECT status FROM multiremi_turn_attempts WHERE id=?").get(task.id)).toMatchObject({ status: "lost" });
      const successor = h.db.query("SELECT current_attempt_id FROM multiremi_turns WHERE id=?").get(handoff.turn_id) as { current_attempt_id: string };
      // Match stable: the replacement attempt has already finished.
      h.store.claimTask(runtimeId); h.store.startTask(successor.current_attempt_id);
      h.store.completeTask(successor.current_attempt_id, { output: "Replacement finished" });
      expect(restarts.get(task.id)?.state).toBe("running");
      if (cleanup === "sweep") restarts.recoverExpiredResumes(runtimeId);
    } finally { journal.close(); }
    const evidence = openSqliteDatabase(join(h.root,journalPath));
    const row = () => evidence.query('SELECT * FROM planned_restart_journal WHERE handoff_id=?').get(handoff.handoff_id);
    try {
      if (cleanup === 'exhaustion') evidence.run('INSERT INTO planned_restart_retries VALUES(?,?,?,?)',[handoff.handoff_id,Date.now(),24,Date.now()]);
      const before = row();
      const retries = () => evidence.query('SELECT * FROM planned_restart_retries WHERE handoff_id=?').get(handoff.handoff_id);
      const budget = retries();
      await h.startDaemon();
      await h.settleHeartbeat();
      await (h.daemon as any).resumePlannedRestarts();
      await h.recreateDaemon();
      await (h.daemon as any).resumePlannedRestarts();
      expect(h.ledger.filter(e => ['turn.restart.suspend','turn.restart.resume','turn.restart.resume_bound'].includes(e.type))).toHaveLength(0);
      expect(row()).toEqual(before);
      expect(retries()).toEqual(budget);
      expect(evidence.query('SELECT reason FROM planned_restart_holds WHERE handoff_id=?').get(handoff.handoff_id)).toEqual({reason:'restart_policy_unverifiable'});
    } finally { evidence.close(); }
    expect(providerCalls).toBe(0);
  } finally { await h.dispose(); }
}, 30_000);
