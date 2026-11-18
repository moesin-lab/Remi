import { afterEach, expect, spyOn, test } from "bun:test";
import { DaemonProtocolHarness, waitFor } from "./harness.js";
import { useMigratedIntegrationDatabases } from "../../helpers/integration-database.js";

useMigratedIntegrationDatabases();
const fixtures: DaemonProtocolHarness[] = [];
afterEach(async () => { for (const h of fixtures.splice(0)) await h.dispose(); });

for (const recovery of ["transport recovery", "daemon restart", "receipt ACK loss + restart", "completion ACK loss"] as const) {
  test(`final input receipt timeout preserves completion through ${recovery}`, async () => {
    let blocked = true;
    let receiptSent = false;
    let receiptApplied = false;
    let dropReceiptAck = recovery === "receipt ACK loss + restart";
    let providerRuns = 0;
    let taskId = "";
    let dropCompletionAck = recovery === "completion ACK loss";
    const h = await DaemonProtocolHarness.create({
      outboxBackoffMs: [5], daemonOptions: { taskDrainTimeoutMs: 30 },
      providerFactory: () => ({
        async *sendStream() {
          providerRuns++;
          yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "durable final" }] } as any;
        },
        getLastResponse: () => ({ text: "durable final", sessionId: "fixture-session", usage: [], toolCalls: [] } as any),
        close: async () => {},
      }),
      beforeSend(frame, socket, harness) {
        if (frame.t === "turn.input") {
          receiptSent = true;
          if (blocked && !dropReceiptAck) return false;
          if (dropReceiptAck) {
            dropReceiptAck = false;
            const session = harness.sessions.at(-1)!;
            const sendReply = session.sendReply.bind(session);
            const reply = spyOn(session, "sendReply").mockImplementation((re, payload) => {
              if (re === frame.id) { receiptApplied = true; reply.mockRestore(); return false; }
              return sendReply(re, payload);
            });
          }
        }
        if (frame.t === "turn.complete" && dropCompletionAck) {
          dropCompletionAck = false;
          const session = harness.sessions.at(-1)!;
          const sendReply = session.sendReply.bind(session);
          const reply = spyOn(session, "sendReply").mockImplementation((re, payload) => {
            if (re === String(frame.seq)) { reply.mockRestore(); socket.close(4001); return false; }
            return sendReply(re, payload);
          });
        }
      },
    });
    fixtures.push(h);
    const fail = spyOn(h.store, "failTask");
    try {
      await h.startDaemon();
      await h.settleHeartbeat();
      const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id;
      const agent = h.store.createAgent({ name: "final receipt", provider: "claude", runtimeId });
      const task = h.store.createTask({ agentId: agent.id, prompt: "finish exactly once", maxAttempts: 3 });
      taskId = task.id;
      await waitFor(() => receiptSent, "completion input receipt RPC");
      expect((h.daemon as any).ensureOutbox().taskIdsWithPendingTerminal(runtimeId)).toContain(taskId);
      if (recovery === "receipt ACK loss + restart") await waitFor(() => receiptApplied, "receipt committed without ACK");
      // The real client timer fires while the final reply is already durable.
      h.clock.advance(10_000);
      await waitFor(() => h.daemon.traceStore().head(taskId)?.closed === true, "local completion after bounded report wait");
      expect(h.daemon.traceStore().snapshotPart(taskId, 0)?.turn?.error).toBeNull();
      expect(h.store.getTask(taskId)?.status).toBe("running");
      expect(providerRuns).toBe(1);
      blocked = false;
      if (recovery === "daemon restart" || recovery === "receipt ACK loss + restart") await h.recreateDaemon();
      if (recovery === "completion ACK loss") {
        await waitFor(() => h.client.connectionState() === "disconnected", "completion ACK dropped after commit");
        await h.reconnect();
      }
      await waitFor(() => h.store.getTask(taskId)?.status === "completed"
        && h.daemon.outboxStats()?.pending === 0, "durable completion replay", 5_000);
      expect(h.store.getTask(taskId)).toMatchObject({ status: "completed", result: "durable final", error: null });
      expect(providerRuns).toBe(1);
      expect(h.store.listTurnAttempts(taskId)).toHaveLength(1);
      expect(fail.mock.calls.filter(([id]) => id === taskId)).toHaveLength(0);
      expect(h.received.filter(frame => frame.t === "task.offer" && frame.p.attempt_id === taskId)).toHaveLength(1);
      expect(h.ledger.filter(entry => entry.type === "turn.complete").every(entry => !("input_receipt" in entry.frame.p))).toBe(true);
      const turn = h.store.getTurn(taskId)!;
      expect(h.store.getMessage(turn.reply_message_id!)?.body_md).toBe("durable final");
      expect(h.store.listMessages(turn.session_id).filter(message => message.body_md === "durable final")).toHaveLength(1);
    } finally { fail.mockRestore(); }
  }, 15_000);
}

test("start report timeout before a final preserves the existing execution failure", async () => {
  let providerRuns = 0;
  let blockStart = true;
  const h = await DaemonProtocolHarness.create({ daemonOptions: { requestTimeoutMs: 1_000 }, outboxBackoffMs: [5],
    beforeSend: frame => blockStart && frame.t === "task.start" ? false : undefined,
    providerFactory: () => ({
      async *sendStream() { providerRuns++; yield {} as any; },
      close: async () => {},
    }),
  });
  fixtures.push(h);
  await h.startDaemon();
  await h.settleHeartbeat();
  const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id;
  const agent = h.store.createAgent({ name: "before final timeout", provider: "claude", runtimeId });
  const task = h.store.createTask({ agentId: agent.id, prompt: "no final", maxAttempts: 1 });
  await waitFor(() => h.daemon.outboxStats()?.pendingTerminal === 1, "failure queued after start wait timeout");
  expect(providerRuns).toBe(0);
  expect(h.daemon.traceStore().head(task.id)?.head ?? 0).toBe(0);
  // Unblock the start RPC by letting its real ACK deadline expire; the retained
  // start report then replays before the failure, just as it did before MUL-88.
  blockStart = false;
  h.clock.advance(30_000);
  await waitFor(() => h.store.getTask(task.id)?.status === "failed", "pre-final timeout remains failed");
  expect(h.store.getTask(task.id)).toMatchObject({ status: "failed", failureReason: "agent_error.unknown" });
  expect(h.store.getTask(task.id)?.error).toContain("daemon_timeout");
  expect(providerRuns).toBe(0);
}, 10_000);

for (const blockedReport of ["turn.input", "task.usage", "turn.complete"] as const) {
  for (const restart of [false, true]) {
    test(`delivered steer → final → ${blockedReport} timeout → ${restart ? "restart" : "recovery"} never re-executes`, async () => {
      let blocked = true;
      let timedReportSent = false;
      let providerRuns = 0;
      let steerDelivered = false;
      let taskId = "";
      let steerId = "";
      const h = await DaemonProtocolHarness.create({
        daemonOptions: { taskDrainTimeoutMs: 30 }, outboxBackoffMs: [5],
        providerFactory: () => ({
          async *sendStream(_prompt, options) {
            providerRuns++;
            options?.onPromptStarted?.();
            // Deliver ordinary input through the real downlink/native pump,
            // then let the same prompt produce its final response naturally.
            steerId = h.store.createTaskSteerMessage({ taskId, kind: "steer", content: "finish exactly once" }).id;
            await waitFor(() => steerDelivered, "native steer delivered");
            yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "steered durable final" }] } as any;
          },
          steer: async () => { steerDelivered = true; return { outcome: "injected" as const }; },
          getLastResponse: () => ({ text: "steered durable final", sessionId: "fixture-session", usage: [], toolCalls: [] } as any),
          close: async () => {},
        }),
        beforeSend(frame) {
          if (blocked && frame.t === blockedReport) { timedReportSent = true; return false; }
        },
      });
      fixtures.push(h);
      const fail = spyOn(h.store, "failTask");
      try {
        await h.startDaemon(); await h.settleHeartbeat();
        const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id;
        const agent = h.store.createAgent({ name: "steered receipt", provider: "claude", runtimeId });
        const task = h.store.createTask({ agentId: agent.id, prompt: "start once", maxAttempts: 3 });
        taskId = task.id;
        await waitFor(() => timedReportSent && h.daemon.traceStore().head(taskId)?.closed === true, "final durably queued");
        expect((h.daemon as any).ensureOutbox().taskIdsWithPendingTerminal(runtimeId)).toContain(taskId);
        h.clock.advance(30_000);
        await Bun.sleep(20);
        expect(h.daemon.traceStore().snapshotPart(taskId, 0)?.turn?.error).toBeNull();
        expect(h.store.getTask(taskId)?.status).toBe("running");
        blocked = false;
        h.clock.advance(5); // release the manual-clock outbox retry backoff
        if (restart) await h.recreateDaemon();
        await waitFor(() => h.store.getTask(taskId)?.status === "completed" && h.daemon.outboxStats()?.pending === 0,
          "steered completion replay", 5_000);
        expect(h.store.getTask(taskId)).toMatchObject({ status: "completed", result: "steered durable final", error: null });
        expect(providerRuns).toBe(1);
        expect(h.store.listTurnAttempts(taskId)).toHaveLength(1);
        expect(fail.mock.calls.filter(([id]) => id === taskId)).toHaveLength(0);
        expect(h.received.filter(frame => frame.t === "task.offer" && frame.p.attempt_id === taskId)).toHaveLength(1);
        expect(h.ledger.some(entry => entry.type === "turn.input" && entry.frame.p.message_ids?.includes(steerId))).toBe(true);
        const turn = h.store.getTurn(taskId)!;
        expect(h.store.listMessages(turn.session_id).filter(message => message.body_md === "steered durable final")).toHaveLength(1);
      } finally { fail.mockRestore(); }
    }, 15_000);
  }
}
