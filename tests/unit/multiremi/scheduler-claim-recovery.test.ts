import { afterEach, expect, spyOn, test } from "bun:test";
import { MultiremiScheduler } from "@daemon/scheduler.js";
import { DatabaseUnavailableError } from "@shared/db/recovery.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("scheduler did not recover claimed schedules");
    await Bun.sleep(10);
  }
}

// Real SQLite claims and advances, with an outage only at the dispatch boundary.
// Keep the same started scheduler throughout; the serial retry loop must finish
// unwinding a failed batch before recovery changes any of its claimed rows.
for (const count of [1, 3]) {
  for (const committed of [false, true]) {
    test(`scheduler recovers ${count} claimed trigger(s), dispatch committed=${committed}`, async () => {
      const store = createLocalStore();
      const agent = store.createAgent({ name: "Schedule recovery", provider: "codex" });
      const autopilot = store.createAutopilot({
        title: "Schedule recovery", assigneeId: agent.id, status: "active", executionMode: "run_only",
      });
      const triggers = Array.from({ length: count }, () => store.createAutopilotTrigger(autopilot.id, {
        kind: "schedule", cronExpression: "0 0 1 1 *", enabled: true,
      }));
      db!.run("UPDATE multiremi_autopilot_triggers SET next_run_at = ? WHERE autopilot_id = ?",
        [new Date(0).toISOString(), autopilot.id]);
      const original = store.runAutopilot.bind(store);
      let calls = 0;
      const successful: string[] = [];
      const dispatch = spyOn(store, "runAutopilot").mockImplementation((id, input) => {
        calls++;
        // The first dispatch fails after the entire batch has been claimed.
        if (calls === 1) {
          expect(triggers.every(t => store.getAutopilotTrigger(t.id)!.nextRunAt === null)).toBe(true);
          if (committed) { original(id, input); successful.push(input!.triggerId!); }
          throw new DatabaseUnavailableError();
        }
        const run = original(id, input);
        successful.push(input!.triggerId!);
        return run;
      });
      const scheduleRecovery = spyOn(store, "recoverLostScheduleTriggers");
      const provisionRecovery = spyOn(store, "recoverLostRuntimeProvisionSchedules");
      const scheduler = new MultiremiScheduler({ store, pollIntervalMs: 10, failureMonitorIntervalMs: 0 });
      try {
        scheduler.start();
        await until(() => triggers.every(t => store.getAutopilotTrigger(t.id)!.nextRunAt !== null));
        expect(scheduleRecovery).toHaveBeenCalledTimes(2);
        expect(provisionRecovery).toHaveBeenCalledTimes(2);
        expect(calls).toBe(1); // Recovery skips the lost occurrence, including unprocessed batch members.
        const next = triggers.map(t => store.getAutopilotTrigger(t.id)!.nextRunAt!);
        expect(next.every(at => Date.parse(at) > Date.now())).toBe(true);
        expect(scheduler.tickDueTriggers(new Date(Date.parse(next[0]!) - 1))).toHaveLength(0);
        expect(scheduler.tickDueTriggers(new Date(next[0]!))).toHaveLength(count);
        expect(calls).toBe(count + 1);
        expect(successful).toHaveLength(count + (committed ? 1 : 0));
        expect(new Set(successful.slice(committed ? 1 : 0)).size).toBe(count);
        expect(scheduler.tickDueTriggers()).toHaveLength(0);
        await Bun.sleep(30);
        expect(calls).toBe(count + 1);
      } finally {
        scheduler.stop();
        dispatch.mockRestore(); scheduleRecovery.mockRestore(); provisionRecovery.mockRestore();
      }
    });
  }
}

for (const committed of [false, true]) {
  test(`scheduler recovers a claimed runtime provision, enqueue committed=${committed}`, async () => {
    const store = createLocalStore();
    const runtime = store.registerRuntime({ id: "rt_recovery", name: "Recovery", provider: "codex", workspaceId: "local" });
    const provision = store.createWorkspaceRuntimeProvision("local", {
      kind: "command", command: "printf recovery", enabled: true,
      triggerKinds: ["cron"], cronExpression: "0 0 1 1 *",
    });
    db!.run("UPDATE multiremi_workspace_runtime_provisions SET next_run_at = ? WHERE id = ?",
      [new Date(0).toISOString(), provision.id]);
    const original = store.enqueueWorkspaceRuntimeProvision.bind(store);
    let calls = 0;
    const dispatch = spyOn(store, "enqueueWorkspaceRuntimeProvision").mockImplementation(id => {
      calls++;
      if (calls === 1) {
        expect(store.getWorkspaceRuntimeProvision(id)!.nextRunAt).toBeNull();
        if (committed) original(id);
        throw new DatabaseUnavailableError();
      }
      return original(id);
    });
    const scheduler = new MultiremiScheduler({ store, pollIntervalMs: 10, failureMonitorIntervalMs: 0 });
    try {
      scheduler.start();
      await until(() => store.getWorkspaceRuntimeProvision(provision.id)!.nextRunAt !== null);
      expect(calls).toBe(1);
      const next = store.getWorkspaceRuntimeProvision(provision.id)!.nextRunAt!;
      expect(Date.parse(next)).toBeGreaterThan(Date.now());
      const first = store.claimRuntimeCommandRequest(runtime.id);
      expect(first?.provisionId ?? null).toBe(committed ? provision.id : null);
      if (first) store.reportRuntimeCommandResult(runtime.id, first.id, { status: "completed", exitCode: 0 });
      expect(scheduler.tickRuntimeProvisions(new Date(Date.parse(next) - 1))).toBe(0);
      expect(scheduler.tickRuntimeProvisions(new Date(next))).toBe(1);
      expect(calls).toBe(2);
      expect(store.claimRuntimeCommandRequest(runtime.id)?.provisionId).toBe(provision.id);
      expect(store.claimRuntimeCommandRequest(runtime.id)).toBeNull();
      expect(scheduler.tickRuntimeProvisions()).toBe(0);
      await Bun.sleep(30);
      expect(calls).toBe(2);
    } finally { scheduler.stop(); dispatch.mockRestore(); }
  });
}
