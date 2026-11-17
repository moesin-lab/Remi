import { expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import { openHotspotDatabase, useMigratedHotspotDatabases } from "../../fixtures/multiremi/first-screen-hotspots-database.js";
import { seedFirstScreenHotspotsFixture } from "../../fixtures/multiremi/first-screen-hotspots-fixture.js";

useMigratedHotspotDatabases();
it("empty claims batch queued Chat decision facts without usage/autopilot hydration", async () => {
  const counts: number[] = [];
  for (const sessions of [1, 10, 50]) {
    const database = await openHotspotDatabase();
    const store = new MultiremiStore(database.db);
    try {
      const fixture = seedFirstScreenHotspotsFixture(store, { sessions, agents: 1, inboxRows: 1,
        privatePrimaryAgent: false, run: (sql, args) => database.db.run(sql, args as never[]) });
      const runtime = store.registerRuntime({ id: "rt_wrong_provider", provider: "claude", name: "Ineligible",
        workspaceId: "local", daemonId: "other-daemon" });
      const before = fixture.taskIds.map(id => store.getTask(id)!);
      const sql: string[] = [];
      const original = database.db.query.bind(database.db);
      database.db.query = ((text: string) => { sql.push(text); return original(text); }) as typeof database.db.query;
      try { expect(store.claimTask(runtime.id)).toBeNull(); }
      finally { database.db.query = original; }
      counts.push(sql.length);
      expect(sql.some(text => text.includes("SUM(COALESCE(input_tokens"))).toBe(false);
      expect(sql.some(text => text.includes("FROM multiremi_autopilot_run_records WHERE task_id"))).toBe(false);
      // The unsuccessful claimant must preserve routing, frozen state and queue order.
      const after = fixture.taskIds.map(id => store.getTask(id)!);
      expect(after.map(task => [task.id, task.status, task.runtimeId, task.sessionId, task.workDir, task.executionFingerprint]))
        .toEqual(before.map(task => [task.id, task.status, task.runtimeId, task.sessionId, task.workDir, task.executionFingerprint]));
    } finally { store.stopNotificationDeliverySweeper(); await database.dispose(); }
  }
  expect(counts[0]).toBeLessThanOrEqual(35);
  expect(new Set(counts).size).toBe(1);
  console.info(`MUL85_CLAIM_BUDGET ${JSON.stringify({ sessions: [1, 10, 50], counts })}`);
}, 30_000);
