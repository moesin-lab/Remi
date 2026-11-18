import { expect, test } from "bun:test";
import { createResponsibleTestIssue } from "../../unit/multiremi/helpers.js";
import { DaemonProtocolHarness, waitFor } from "./harness.js";
import { useMigratedIntegrationDatabases } from "../../helpers/integration-database.js";

useMigratedIntegrationDatabases();

for (const reason of ["manual", "deploy", "cli_update"] as const) {
  test(`HTTP probe cannot grant restart to a host without the named capability during ${reason} expiry`, async () => {
    let entered = false;
    const h = await DaemonProtocolHarness.create({ beforeStart: harness => {
      (harness.client as any).extraCaps.delete("turn.restart");
    }, providerFactory: () => ({
      async *sendStream(_message, options) {
        entered = true;
        await new Promise<never>((_resolve, reject) => {
          const stop = () => reject(new Error("Cancelled"));
          if (options?.signal?.aborted) stop();
          else options?.signal?.addEventListener("abort", stop, { once: true });
        });
      },
      getLastResponse: () => ({ text: "", sessionId: "probe-session", usage: [], toolCalls: [] } as any),
      close: async () => {},
    }) });
    try {
      await h.startDaemon(); await h.settleHeartbeat();
      const runtime = h.store.listRuntimes()[0]!;
      const runtimeId = runtime.id, daemonId = runtime.daemonId!;
      expect(h.client.sharesCap("turn.restart")).toBe(false);
      expect((h.daemon as any).runtimeCapabilities().planned_restart).toBe(1);
      expect(h.store.getRuntimeLite(runtimeId)?.metadata).toMatchObject({ planned_restart: 0, planned_restart_negotiated: false });
      await (h.daemon as any).protocolLane.probeUpgrade();
      expect(h.store.getRuntimeLite(runtimeId)?.metadata.planned_restart).toBe(0);
      const agent = h.store.createAgent({ name: "Unnegotiated probe", provider: "claude", runtimeId });
      const issue = createResponsibleTestIssue(h.store, { title: "Probe expiry", assigneeType: "agent", assigneeId: agent.id });
      const task = h.store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Long probe work", maxAttempts: 3 });
      await waitFor(() => entered, "long provider running");
      (h.daemon as any).claimsPaused = true;
      const started = performance.now();
      h.store.beginDaemonDrain("local", daemonId, reason, 1);
      await Bun.sleep(5);
      // The production HTTP upgrade path itself reconciles the expired drain.
      await (h.daemon as any).protocolLane.probeUpgrade();
      h.store.reconcileDaemonDrain(runtimeId);
      await waitFor(() => (h.daemon as any).activeTaskCount === 0, "legacy cancellation", 5_000);
      await h.settleHeartbeat();
      expect(h.store.plannedRestarts().get(task.id)).toBeNull();
      expect(h.store.getTask(task.id)).toMatchObject({ status: "failed", failureReason: "runtime_recovery" });
      expect(h.store.listTasksForIssue(issue.id).filter(attempt => attempt.attempt === 2)).toHaveLength(1);
      expect(h.received.some(frame => frame.t === "turn.restart")).toBe(false);
      expect(h.received.some(frame => frame.t === "task.cancelled")).toBe(true);
      expect(h.store.getDaemonDrainStatus("local", daemonId)).toMatchObject({ status: "drained_forced", remaining_tasks: 0, awaiting_daemon_ack: false });
      if (reason === "cli_update") {
        const update = h.store.createRuntimeUpdateRequest(runtimeId, { targetVersion: "0.2.96" });
        expect(h.store.claimRuntimeUpdateRequest(runtimeId)?.id).toBe(update.id);
      }
      expect(performance.now() - started).toBeLessThan(5_000);
    } finally { await h.dispose(); }
  }, 15_000);
}
