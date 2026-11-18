import { expect, test } from "bun:test";
import { createResponsibleTestIssue } from "../../unit/multiremi/helpers.js";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DaemonProtocolHarness, waitFor } from "./harness.js";
import { useMigratedIntegrationDatabases } from "../../helpers/integration-database.js";
import { PlannedRestartJournal } from "@multiremi/worker/planned-restart-journal.js";

useMigratedIntegrationDatabases();

// Real daemon/provider lifetime, disk outbox/journal and authenticated v2 RPCs.
// Candidate update acceptance is exercised separately with the MUL-27 harness.
test("daemon joins provider shutdown before preparing and acknowledging the same-attempt checkpoint", async () => {
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
    const task = h.store.createTask({ agentId: agent.id, runtimeId, prompt: "Long synthetic round", maxAttempts: 1 });
    await waitFor(() => entered, "provider entered", 5_000);
    h.store.beginDaemonDrain("local", daemonId, "manual", 60_000);
    const handoff = h.store.plannedRestarts().request(task.id, { workspaceId: "local", runtimeId, daemonId });
    await waitFor(() => h.received.some(f => f.t === "turn.restart"), "restart request delivered");
    expect(h.client.sharesCap("turn.restart")).toBe(true);
    expect(providerClosed).toBe(false);
    expect(h.store.plannedRestarts().get(task.id)?.state).toBe("requested");
    expect((h.daemon as any).restartJournal.entries()).toHaveLength(0);
    releaseClose();
    await waitFor(() => h.store.plannedRestarts().get(task.id)?.state === "suspended", "checkpoint RPC committed", 10_000);
    await waitFor(() => (h.daemon as any).activeTaskCount === 0, "checkpoint locally acknowledged");
    expect(providerClosed).toBe(true);
    expect(h.store.getTask(task.id)).toMatchObject({ status: "running", attempt: 1, maxAttempts: 1, sessionId: "planned-session" });
    const journalPath = readdirSync(h.root).find(name => name.startsWith("restart-") && name.endsWith(".db"))!;
    const journal = new PlannedRestartJournal(join(h.root, journalPath));
    try { expect(journal.get(handoff.handoff_id)).toMatchObject({ state: "acknowledged", execution: { attempt_id: task.id, generation: 0 } }); }
    finally { journal.close(); }
    expect(h.ledger.some(e => e.type === "task.fail")).toBe(false);
    expect(h.ledger.some(e => e.type === "turn.restart.checkpoint")).toBe(true);
    expect(h.ledger.some(e => e.type === "turn.restart.suspend")).toBe(true);
    await h.stopDaemon();
    h.store.undrainDaemon("local", daemonId);
    await h.recreateDaemon();
    await waitFor(() => h.store.getTask(task.id)?.status === "completed", "same attempt finished after replacement", 10_000);
    expect(resumed).toBe(true);
    expect(h.store.getTask(task.id)).toMatchObject({ status: "completed", attempt: 1, maxAttempts: 1, result: "complete resumed answer" });
    expect(h.ledger.some(e => e.type === "turn.restart.resume")).toBe(true);
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
      .rejects.toMatchObject({ code: "stale_attempt" });
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
      .rejects.toMatchObject({ code: "stale_attempt" });
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
    expect(h.store.listTasksForIssue(issue.id).some(retry => retry.attempt === 2 && retry.status === "queued")).toBe(true);
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

for (const kind of ["permission", "question"] as const) for (const answerAt of ["suspended", "resumed"] as const) {
  test(`daemon resumes the original ${kind} callback and consumes an answer saved while ${answerAt}`, async () => {
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
      await h.stopDaemon();
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
      expect(h.store.getQuestion(questionId)).toMatchObject({ id: questionId, answer_revision: 1, wait_status: "consumed" });
      expect(h.store.getTask(task.id)).toMatchObject({ status: "completed", attempt: 1, result: "Original answer applied; full final response" });
      expect(h.db.query("SELECT id FROM multiremi_conversation_log WHERE task_id=? AND message_kind='decision'").all(turn.id)).toHaveLength(1);
      expect(h.db.query("SELECT id FROM multiremi_turn_attempts WHERE turn_id=?").all(turn.id)).toHaveLength(1);
      expect(h.ledger.some(event => event.type === "task.fail")).toBe(false);
    } finally { await h.dispose(); }
  }, 25_000);
}
