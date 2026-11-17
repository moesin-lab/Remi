import { expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { executionClaimBaseSql } from "@multiremi/store/turn-execution-records.js";
import { openHotspotDatabase, useMigratedHotspotDatabases } from "../../fixtures/multiremi/first-screen-hotspots-database.js";
import { seedFirstScreenHotspotsFixture } from "../../fixtures/multiremi/first-screen-hotspots-fixture.js";

// Count execution, not statement preparation: a prepared selector can run repeatedly.
function countedQuery(query: SqlDatabase["query"], sql: string[]): SqlDatabase["query"] {
  return ((text: string) => new Proxy(query(text), {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (["get", "all", "run"].includes(String(key))) sql.push(text);
        return value.apply(target, args);
      };
    },
  })) as SqlDatabase["query"];
}

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
      const originalRun = database.db.run.bind(database.db);
      database.db.run = ((text: string, ...args: unknown[]) => {
        sql.push(text); return originalRun(text, ...args as [never]);
      }) as typeof database.db.run;
      const original = database.db.query.bind(database.db);
      database.db.query = countedQuery(original, sql);
      try { expect(store.claimTask(runtime.id)).toBeNull(); }
      finally { database.db.query = original; database.db.run = originalRun; }
      counts.push(sql.filter(text => /^SELECT/.test(text.trim())).length);
      expect(sql.filter(text => text.includes("WHERE claim_attempt.status = 'offered'"))).toHaveLength(1);
      expect(sql.some(text => text.startsWith("SELECT id,turn_id,") && text.includes("SELECT t.id"))).toBe(false);
      expect(sql.some(text => text.includes("UPDATE multiremi_turns SET current_attempt_id=current_attempt_id") && text.includes("SELECT t.id"))).toBe(false);
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

it("the active ID set preserves the VIEW awaiting-human override for every attempt status", async () => {
  const database = await openHotspotDatabase();
  const store = new MultiremiStore(database.db);
  try {
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "Active status", provider: "codex", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, prompt: "status projection" });
    const sql = `SELECT runtime_active.id FROM multiremi_turn_execution_records runtime_active
      WHERE runtime_active.status IN ('dispatched','running','waiting_local_directory','awaiting_human')`;
    for (const attempt of ["offered", "accepted", "running", "waiting_local_directory", "completed", "failed", "cancelled", "lost"]) {
      for (const turn of ["running", "awaiting_human"]) {
        database.db.run("UPDATE multiremi_turn_attempts SET status=? WHERE id=?", [attempt, task.id]);
        database.db.run("UPDATE multiremi_turns SET status=? WHERE current_attempt_id=?", [turn, task.id]);
        expect(database.db.query(executionClaimBaseSql(sql)).all()).toEqual(database.db.query(sql).all());
      }
    }
  } finally { store.stopNotificationDeliverySweeper(); await database.dispose(); }
}, 30_000);

it("successful claims evaluate the candidate predicate once regardless of queue size", async () => {
  const counts: number[] = [];
  for (const queued of [1, 50]) {
    const database = await openHotspotDatabase();
    const store = new MultiremiStore(database.db);
    try {
      const runtime = store.registerRuntime({ id: "rt_claim_cost", provider: "codex", name: "Cost",
        workspaceId: "local", metadata: { parallel_agent_execution: 1 } });
      const agent = store.createAgent({ name: "Cost", provider: "codex", workspaceId: "local" });
      for (let i = 0; i < queued; i++) store.createTask({ agentId: agent.id, prompt: "claim" });
      const sql: string[] = [];
      const originalQuery = database.db.query.bind(database.db);
      const originalRun = database.db.run.bind(database.db);
      database.db.query = countedQuery(originalQuery, sql);
      database.db.run = ((text: string, ...args: unknown[]) => {
        sql.push(text); return originalRun(text, ...args as [never]);
      }) as typeof database.db.run;
      try { expect(store.claimTask(runtime.id)?.status).toBe("dispatched"); }
      finally { database.db.query = originalQuery; database.db.run = originalRun; }
      expect(sql.filter(text => text.includes("WHERE claim_attempt.status = 'offered'"))).toHaveLength(1);
      expect(sql.filter(text => text.includes("UPDATE multiremi_turns SET current_attempt_id=current_attempt_id"))
        .every(text => !text.includes("SELECT t.id"))).toBe(true);
      counts.push(sql.length);
    } finally { store.stopNotificationDeliverySweeper(); await database.dispose(); }
  }
  expect(counts[0]).toBe(counts[1]);
  console.info(`MUL163_SUCCESSFUL_CLAIM ${JSON.stringify({ queued: [1, 50], counts })}`);
}, 30_000);
