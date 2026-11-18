import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DaemonProtocolHarness, waitFor } from "./harness.js";
import { useMigratedIntegrationDatabases } from "../../helpers/integration-database.js";
import { PlannedRestartJournal } from "@multiremi/worker/planned-restart-journal.js";

useMigratedIntegrationDatabases();

// Real daemon/provider lifetime, disk outbox/journal and authenticated v2 RPCs.
// This is the suspension half, not the candidate-update acceptance harness.
test("daemon joins provider shutdown before preparing and acknowledging the same-attempt checkpoint", async () => {
  let entered = false;
  let providerClosed = false;
  let releaseClose!: () => void;
  const closed = new Promise<void>(resolve => { releaseClose = resolve; });
  const h = await DaemonProtocolHarness.create({ outboxBackoffMs: [5], providerFactory: () => ({
    async *sendStream(_message, options) {
      entered = true;
      await new Promise<never>((_resolve, reject) => {
        const stop = () => reject(new Error("Cancelled"));
        if (options?.signal?.aborted) stop();
        else options?.signal?.addEventListener("abort", stop, { once: true });
      });
    },
    getLastResponse: () => ({ text: "", sessionId: "planned-session", usage: [], toolCalls: [] } as any),
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
    expect(providerClosed).toBe(false);
    expect(h.store.plannedRestarts().get(task.id)?.state).toBe("requested");
    expect(readdirSync(h.root).some(name => name.startsWith("restart-"))).toBe(false);
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
