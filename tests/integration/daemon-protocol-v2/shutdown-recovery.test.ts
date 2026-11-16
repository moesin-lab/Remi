import { expect, test } from "bun:test";
import { DaemonProtocolHarness, waitFor } from "./harness.js";
import { createResponsibleTestIssue } from "../../unit/multiremi/helpers.js";
import { AcpRpcError, AcpSessionFailureError } from "@acp/index.js";

for (const [shape, error, failureReason] of [
  ["AIR authentication", new AcpSessionFailureError({ id: "auth", revision: 1,
    category: "authentication", severity: "error", title: "Cancelled" }), "agent_error.provider_auth_or_access"],
  ["RPC authentication", new AcpRpcError(-32603, "Internal error", { category: "authentication" }), "agent_error.provider_auth_or_access"],
  ["plain authentication", new Error("invalid api key"), "agent_error.provider_auth_or_access"],
  ["unrelated provider failure", new Error("fixture provider failure"), "agent_error.unknown"],
] as const) {
  test(`stop before provider failure: ${shape}`, async () => {
    let rejectFirst!: (error: Error) => void;
    const failing = new Promise<never>((_resolve, reject) => { rejectFirst = reject; });
    let runs = 0;
    const h = await DaemonProtocolHarness.create({ database: "sqlite", providerFactory: () => ({
      async *sendStream() { runs++; await failing; },
      getLastResponse: () => ({ text: "", sessionId: "drain-failure-session", usage: [], toolCalls: [] } as any),
      close: async () => {},
    }) });
    try {
      await h.startDaemon();
      const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id;
      const agent = h.store.createAgent({ name: "Drain failure fixture", provider: "claude", runtimeId });
      const issue = createResponsibleTestIssue(h.store, { title: "Real failure during drain", status: "in_progress",
        assigneeType: "agent", assigneeId: agent.id });
      const task = h.store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Long round", maxAttempts: 3 });
      await waitFor(() => runs === 1, "provider running", 5_000);
      h.daemon.stop();
      rejectFirst(error);
      await h.waitForDaemonExit();
      await h.recreateDaemon();
      await waitFor(() => h.store.getTask(task.id)?.status === "failed" && h.daemon.outboxStats()?.pending === 0,
        "original failure delivered after stop", 5_000);
      expect(h.store.getTask(task.id)).toMatchObject({ failureReason, sessionId: "drain-failure-session" });
      expect(h.store.listTasksForIssue(issue.id)).toHaveLength(1);
      expect(runs).toBe(1);
    } finally { rejectFirst(new Error("fixture cleanup")); await h.dispose(); }
  }, 20_000);
}

for (const error of ["Cancelled", "ACP agent died unexpectedly (stdout EOF)"]) {
  for (const scenario of ["live", "SIGTERM", "error_before_stop"] as const) {
    const stopping = scenario === "SIGTERM";
    test(`${scenario}: ${error}`, async () => {
      let rejectFirst!: (error: Error) => void;
      const interrupted = new Promise<never>((_resolve, reject) => { rejectFirst = reject; });
      let runs = 0;
      let responseReads = 0;
      const sessions: Array<string | null | undefined> = [];
      const h = await DaemonProtocolHarness.create({ database: "sqlite", outboxBackoffMs: [5],
        providerFactory: () => ({
          async *sendStream(_message, options) {
            sessions.push(options?.sessionId);
            if (++runs === 1) await interrupted;
            yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "resumed answer" }] } as any;
          },
          getLastResponse: () => {
            // Stop after sendStream has thrown, before runAgent propagates it.
            if (scenario === "error_before_stop" && runs === 1 && ++responseReads === 2) h.daemon.stop();
            return { text: "resumed answer", sessionId: "shutdown-session", usage: [], toolCalls: [] } as any;
          },
          close: async () => {},
        }),
      });
      const onTerm = () => {
        h.daemon.stop();
        // Inert provider models the ACP child exiting as the process group stops.
        rejectFirst(new Error(error));
      };
      try {
        await h.startDaemon();
        await h.settleHeartbeat();
        const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id;
        const agent = h.store.createAgent({ name: "Shutdown fixture", provider: "claude", runtimeId });
        const issue = createResponsibleTestIssue(h.store, { title: "Isolated shutdown recovery", status: "in_progress",
          assigneeType: "agent", assigneeId: agent.id });
        const task = h.store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Long synthetic round", maxAttempts: 3 });
        await waitFor(() => runs === 1, "provider running", 5_000);
        const before = h.store.listTasksForIssue(issue.id).map(row => ({ id: row.id, attempt: row.attempt, status: row.status }));
        if (stopping) {
          process.once("SIGTERM", onTerm);
          process.kill(process.pid, "SIGTERM");
          await h.waitForDaemonExit();
          // Recreate from the same isolated state/outbox, as a daemon restart does.
          await h.recreateDaemon();
          await waitFor(() => h.store.listTasksForIssue(issue.id).some(row => row.status === "completed"), "automatic retry completes", 5_000);
          const attempts = h.store.listTasksForIssue(issue.id).sort((a, b) => a.attempt - b.attempt);
          expect(attempts).toHaveLength(2);
          expect(attempts[0]).toMatchObject({ id: task.id, status: "failed", failureReason: "runtime_recovery", sessionId: "shutdown-session" });
          expect(attempts[1]).toMatchObject({ attempt: 2, status: "completed", sessionId: "shutdown-session", result: "resumed answer" });
          expect(h.store.getTurnForAttempt(attempts[1]!.id)?.id).toBe(h.store.getTurnForAttempt(task.id)?.id);
          expect(sessions[1]).toBe("shutdown-session");
          expect(h.store.getIssue(issue.id)?.status).not.toBe("blocked");
          console.log("MUL-45 SIGTERM", JSON.stringify({ error, before, after: attempts.map(row => ({ id: row.id,
            attempt: row.attempt, status: row.status, failureReason: row.failureReason, sessionId: row.sessionId })) }));
        } else {
          rejectFirst(new Error(error));
          if (scenario === "error_before_stop") {
            await h.waitForDaemonExit();
            await h.recreateDaemon();
          }
          await waitFor(() => h.store.getTask(task.id)?.status === "failed" && h.daemon.outboxStats()?.pending === 0, "Agent failure delivered", 5_000);
          expect(h.store.getTask(task.id)).toMatchObject({ status: "failed", failureReason: "agent_error.unknown", error });
          expect(h.store.listTasksForIssue(issue.id)).toHaveLength(1);
          expect(runs).toBe(1);
        }
      } finally {
        process.off("SIGTERM", onTerm);
        rejectFirst(new Error("fixture cleanup"));
        await h.dispose();
      }
    }, 20_000);
  }
}

for (const outcome of ["completed", "cancelled"] as const) {
  test(`stop during finalization: ${outcome}`, async () => {
    let finish!: () => void;
    const finishing = new Promise<void>(resolve => { finish = resolve; });
    let running = false;
    const h = await DaemonProtocolHarness.create({ database: "sqlite", providerFactory: () => ({
      async *sendStream() {
        running = true;
        await finishing;
        yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "drained answer" }] } as any;
      },
      getLastResponse: () => ({ text: "drained answer", sessionId: "drained-session", usage: [], toolCalls: [] } as any),
      close: async () => {},
    }) });
    try {
      await h.startDaemon();
      const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id;
      const agent = h.store.createAgent({ name: "Drain fixture", provider: "claude", runtimeId });
      const issue = createResponsibleTestIssue(h.store, { title: "Drain preserves terminal semantics", status: "in_progress",
        assigneeType: "agent", assigneeId: agent.id });
      const task = h.store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Long round", maxAttempts: 3 });
      await waitFor(() => running, "running provider", 5_000);
      if (outcome === "cancelled") {
        h.store.cancelTask(task.id);
        await waitFor(() => h.received.some(frame => frame.t === "task.cancelled"), "server cancellation delivered", 5_000);
      }
      h.daemon.stop();
      finish();
      await h.waitForDaemonExit();
      await h.recreateDaemon();
      await waitFor(() => h.store.listTasksForIssue(issue.id).some(row => row.status === outcome)
        && h.daemon.outboxStats()?.pending === 0, "terminal replay drains", 5_000);
      if (outcome === "cancelled") {
        expect(h.store.listTasksForIssue(issue.id)).toHaveLength(1);
        expect(h.store.getTask(task.id)?.failureReason).not.toBe("runtime_recovery");
      } else {
        // The socket closes before the provider finishes: finalization RPCs
        // lose authority, so this is also a resumable runtime interruption.
        expect(h.store.listTasksForIssue(issue.id)).toHaveLength(2);
        expect(h.store.getTask(task.id)?.failureReason).toBe("runtime_recovery");
      }
    } finally { finish(); await h.dispose(); }
  }, 20_000);
}
