import { afterAll, expect, spyOn, test } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { openHotspotDatabase, useMigratedHotspotDatabases } from "../../fixtures/multiremi/first-screen-hotspots-database.js";

useMigratedHotspotDatabases();
const resources: Array<Awaited<ReturnType<typeof openHotspotDatabase>>> = [];
afterAll(async () => { for (const resource of resources) await resource.dispose(); });

test("usage report bounds lifecycle reads and preserves all lifecycle views", async () => {
  const resource = await openHotspotDatabase(); resources.push(resource);
  const store = new MultiremiStore(resource.db); store.ensureLocalWorkspace();
  const runtime = store.registerRuntime({ name: "usage cost", provider: "codex" });
  const agent = store.createAgent({ name: "usage cost", provider: "codex", runtimeId: runtime.id });
  const app = createMultiremiApp({ store });
  const original = resource.db.query.bind(resource.db);
  let statements: string[] = [];
  const query = spyOn(resource.db, "query").mockImplementation(sql => { statements.push(sql); return original(sql); });
  const counts: number[] = [];
  try {
    for (const tasks of [0, 24]) {
      for (let index = 0; index < tasks; index++) {
        const task = store.createTask({ agentId: agent.id, prompt: `Usage ${index}` });
        store.claimTask(runtime.id); store.startTask(task.id);
        store.completeTask(task.id, { output: "done" });
      }
      statements = [];
      const started = performance.now();
      const response = await app.request("/api/usage/report?workspace_id=local&days=all&tz=UTC");
      const report = await response.json();
      const elapsed = performance.now() - started;
      console.info(JSON.stringify({ route: "/api/usage/report", dialect: resource.db.dialect, tasks, queries: statements.length, elapsed_ms: elapsed }));
      expect(response.status).toBe(200);
      expect(report.summary.status_counts).toEqual({ completed: tasks, failed: 0, cancelled: 0, active: 0, queued: 0 });
      expect(report.task_daily.reduce((sum: number, row: { task_count: number }) => sum + row.task_count, 0)).toBe(tasks);
      for (const rows of [report.daily, report.by_agent, report.by_runtime]) {
        expect(rows.reduce((sum: number, row: { status_counts: { completed: number } }) => sum + row.status_counts.completed, 0)).toBe(tasks);
      }
      // Count executions at the store query entry; transaction execs are excluded.
      counts.push(statements.length);
      expect(elapsed).toBeLessThan(2_000);
    }
    for (const count of counts) expect(count).toBeLessThanOrEqual(8);
  } finally { query.mockRestore(); }
}, 60_000);
