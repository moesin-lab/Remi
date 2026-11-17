import { expect, test } from "bun:test";
import { MultiremiScheduler } from "@daemon/scheduler.js";
import { ScmPollingScheduler } from "@multiremi/scm/poller.js";
import { MessagingScheduler } from "@multiremi/messaging/scheduler.js";
import { IssueTitleScheduler } from "@multiremi/issue-title/poller.js";
import { OutboundNotificationDispatcher } from "@multiremi/notifications/outbound-dispatcher.js";
import { TaskCapabilityMonitor } from "@multiremi/store/task-capability-monitor.js";
import { DatabaseUnavailableError } from "@shared/db/recovery.js";

// Every timer entrance must route a failure through the shared retry boundary.
test("all polling/sweep entrances retry a dropped database without restarting", async () => {
  const counts = new Map<string, number>();
  function probe(name: string, result: any = []) {
    return () => {
      const count = (counts.get(name) ?? 0) + 1;
      counts.set(name, count);
      if (count === 1) throw new DatabaseUnavailableError();
      return result;
    };
  }
  const loops = [
    new ScmPollingScheduler({ store: { listConnections: probe("scm") } as never }),
    new MessagingScheduler({ store: { deleteExpiredMessages: probe("messaging", 0), listSources: () => [] } as never, registry: {} as never }),
    new IssueTitleScheduler({ store: { listWorkspaces: probe("title") } as never }),
    new OutboundNotificationDispatcher({ store: { listPendingNotificationDeliveries: probe("outbound") } as never }),
    new TaskCapabilityMonitor(probe("capability")),
    new MultiremiScheduler({
      store: {
        recoverLostScheduleTriggers() {}, recoverLostRuntimeProvisionSchedules() {},
        advanceScheduledTargetRuns: probe("scheduler"), claimDueScheduleTriggers: () => [],
        claimDueRuntimeProvisions: () => [], dispatchPendingSystemEvents: () => [], dispatchPendingScmEvents: () => [],
        listAutopilots: () => [], pauseAutopilotsExceedingFailureThreshold: probe("failure-monitor"),
        archiveEligibleIssues: probe("archive"), issueArchiveSweepIntervalMs: () => 60_000,
      } as never,
      failureMonitorStartupDelayMs: 0, issueArchiveSweepStartupDelayMs: 1,
    }),
  ];
  try {
    loops.forEach(loop => loop.start());
    const deadline = Date.now() + 3_000;
    while (counts.size < 8 || [...counts.values()].some(count => count < 2)) {
      if (Date.now() > deadline) throw new Error(`loops did not recover: ${JSON.stringify([...counts])}`);
      await Bun.sleep(10);
    }
    expect([...counts.keys()].sort()).toEqual(["archive", "capability", "failure-monitor", "messaging", "outbound", "scheduler", "scm", "title"]);
  } finally { loops.forEach(loop => loop.stop()); }
});

test("scheduler sync preserves programming errors at every tick", () => {
  const names = ["advanceScheduledTargetRuns", "claimDueScheduleTriggers", "claimDueRuntimeProvisions", "dispatchPendingSystemEvents", "dispatchPendingScmEvents", "listAutopilots"];
  for (const name of names) {
    const store: Record<string, () => unknown> = Object.fromEntries(names.map(key => [key, () => []]));
    store[name] = () => { throw new TypeError(`bug in ${name}`); };
    expect(() => new MultiremiScheduler({ store: store as never }).sync()).toThrow(`bug in ${name}`);
  }
});
