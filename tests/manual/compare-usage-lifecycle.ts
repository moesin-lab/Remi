/** MUL-279: same scratch DB, pinned old source, complete response comparison.
 * bun run tests/manual/compare-usage-lifecycle.ts > /tmp/usage-comparison.json
 * MULTIREMI_TEST_POSTGRES_URL selects an isolated PG database (never stable).
 * Optional MUL279_TASKS / MUL279_UNITS set the large fixture size.
 */
import { strict as assert } from "node:assert";
import { unlinkSync } from "node:fs";
import { MultiremiStore } from "@multiremi/store.js";
import { StoreContext } from "@multiremi/store/context.js";
import { runTurnExecutionMutation } from "@multiremi/store/turn-execution-records.js";
import { createReplacementAttemptWithinTransaction } from "@multiremi/store/turn-attempts.js";
import { openHotspotDatabase } from "../fixtures/multiremi/first-screen-hotspots-database.js";
import type { TaskUsageUnit } from "@multiremi/contracts/usage-accounting.js";
import type { UsageReportInput } from "@multiremi/store/repos/usage-accounting-repo.js";

const baseline = "1565ee296b3e73733afc2eb0cd221680271272d8";
const source = Bun.spawnSync(["git", "show", `${baseline}:packages/server/src/store/repos/usage-accounting-repo.ts`]);
assert.equal(source.exitCode, 0, source.stderr.toString());
const oldFile = new URL(`.mul279-baseline-${process.pid}.ts`, import.meta.url);
const resource = await openHotspotDatabase();
const db = resource.db;
const RealDate = Date;
const fixed = RealDate.parse("2026-10-05T12:00:00.000Z");
const output: unknown[] = [];
try {
  await Bun.write(oldFile, source.stdout);
  const { UsageAccountingRepo: Before } = await import(oldFile.href);
  const { UsageAccountingRepo: After } = await import("@multiremi/store/repos/usage-accounting-repo.js");
  const store = new MultiremiStore(db); store.ensureLocalWorkspace();
  const ctx = new StoreContext(db, () => store);
  const before = new Before(ctx), after = new After(ctx);
  const runtime = store.registerRuntime({ name: "comparison", provider: "codex" });
  const agent = store.createAgent({ name: "comparison", provider: "codex", runtimeId: runtime.id });
  const project = store.createProject({ title: "comparison", workspaceId: "local" });
  const issue = store.createIssue({ title: "comparison", projectId: project.id, workspaceId: "local" });
  const foreign = store.createWorkspace({ id: "ws_comparison_foreign", name: "Foreign" });
  const otherRuntime = store.registerRuntime({ name: "foreign", provider: "codex", workspaceId: foreign.id });
  const otherAgent = store.createAgent({ name: "foreign", provider: "codex", workspaceId: foreign.id, runtimeId: otherRuntime.id });
  const foreignTask = store.createTask({ agentId: otherAgent.id, workspaceId: foreign.id, prompt: "foreign" });
  const unit: TaskUsageUnit = { unitId: "seed", revision: 1, provider: "codex", model: "model", modelSource: "provider_reported",
    scope: "request", source: "provider_request", accuracy: "exact", inputTokens: 10, outputTokens: 2, cacheReadTokens: 0,
    cacheWriteTokens: 0, actualUnsplitTokens: 0, reportedTotalTokens: 12, contextTokens: null, contextWindow: null,
    costAmount: 0.25, costCurrency: "USD", costSource: "provider_reported", occurredAt: "2026-10-01T16:00:00.000Z" };
  store.reportTaskUsageSnapshot(foreignTask.id, { version: 2, runId: "foreign", revision: 1, complete: true, units: [unit] });
  let seedTask = "";
  const seed = (count: number) => {
    for (let index = 0; index < count; index++) {
      const task = store.createTask({ agentId: agent.id, prompt: `comparison ${index}`, maxAttempts: 1,
        ...(index % 2 === 0 ? { issueId: issue.id } : {}) });
      store.claimTask(runtime.id); store.startTask(task.id);
      store.reportTaskUsageSnapshot(task.id, { version: 2, runId: "fixture", revision: 1, complete: true,
        units: [unit, { ...unit, unitId: "before-midnight", occurredAt: "2026-10-01T15:59:59.999Z", costCurrency: "CNY" }] });
      if (index % 4 === 1) seedTask ||= task.id;
      if (index % 4 === 0) store.completeTask(task.id, { output: "done" });
      else if (index % 4 === 1) store.failTask(task.id, { error: "fixture" });
      else if (index % 4 === 2) store.cancelTask(task.id);
      else store.completeTask(task.id, { output: "done" });
      // Fix lifecycle timestamps on terminal attempts independently of consumption.
      if (index % 4 !== 3) runTurnExecutionMutation(db,
        "UPDATE multiremi_turn_execution_records SET started_at=?,completed_at=?,failed_at=?,cancelled_at=?,updated_at=? WHERE id=?",
        ["2026-10-01T00:00:00.000Z", "2026-10-02T16:00:00.000Z", "2026-10-02T15:59:59.999Z", "2026-10-03T00:00:00.000Z", "2026-10-03T00:00:00.000Z", task.id]);
    }
  };
  const original = db.query.bind(db);
  type Read = { sql: string; params: unknown[]; elapsed_ms: number };
  let reads: Read[] = [];
  const measure = (repo: InstanceType<typeof After>, input: UsageReportInput) => {
    reads = [];
    db.query = sql => {
      const statement = original(sql);
      return new Proxy(statement, { get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        return (...params: unknown[]) => {
          const started = performance.now();
          try { return value.apply(target, params); }
          finally { reads.push({ sql, params, elapsed_ms: performance.now() - started }); }
        };
      } });
    };
    const started = performance.now();
    try { return { report: repo.report(input), elapsed_ms: performance.now() - started, reads: [...reads] }; }
    finally { db.query = original; }
  };
  const plans = (reads: Read[]) => db.transaction(() => {
    if (db.dialect === "postgres") db.exec("SET LOCAL jit=off");
    return reads.map(({ sql, params, elapsed_ms }) => ({ sql, elapsed_ms, plan: original(
      `${db.dialect === "postgres" ? "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)" : "EXPLAIN QUERY PLAN"} ${sql}`,
    ).all(...params) }));
  })();
  // Freeze only the read phase: seeding/migrations retain the real system clock.
  const compare = (scale: string) => {
    globalThis.Date = class extends RealDate {
      constructor(value?: string | number) { super(value === undefined ? fixed : value); }
      static now() { return fixed; }
    } as DateConstructor;
    try {
      const cases: UsageReportInput[] = [
        { workspaceId: "local", days: null, tz: "UTC" },
        { workspaceId: "local", days: null, tz: "Asia/Shanghai", include: "day_model", detailLimit: 500 },
        { workspaceId: "local", days: null, tz: "America/Los_Angeles", since: "2026-10-01T16:00:00.000Z", until: "2026-10-02T16:00:00.000Z" },
        { workspaceId: "local", days: null, runtimeId: runtime.id },
        { workspaceId: "local", days: null, projectId: project.id },
        { workspaceId: foreign.id, days: null },
      ];
      for (const input of cases) {
        before.report(input); after.report(input);
        const old = measure(before, input), current = measure(after, input);
        assert.deepEqual(current.report, old.report, `${scale}: ${JSON.stringify(input)}`);
        assert.equal(old.reads.length - current.reads.length, 3);
        if (input.workspaceId === foreign.id) assert.equal(current.report.summary.actual_total_tokens, 12);
        if (scale !== "empty-local" && input.projectId) assert(current.report.summary.actual_total_tokens > 0);
        console.error(`${scale} ${JSON.stringify(input)}: equal; ${old.reads.length}->${current.reads.length} reads`);
        output.push({ scale, input, equal: true, before_queries: old.reads.length, after_queries: current.reads.length,
          before_ms: old.elapsed_ms, after_ms: current.elapsed_ms,
          ...(scale === "large" && (input.tz === "UTC" || input.projectId) ? { before_plans: plans(old.reads), after_plans: plans(current.reads) } : {}) });
      }
    } finally { globalThis.Date = RealDate; }
  };
  compare("empty-local"); seed(24);
  const turn = original("SELECT turn_id FROM multiremi_turn_attempts WHERE id=?").get(seedTask) as { turn_id: string };
  const retry = db.transaction(() => createReplacementAttemptWithinTransaction(db, turn.turn_id,
    { previousStatus: "failed", reason: "fixture retry", cold: true }))();
  runTurnExecutionMutation(db, "UPDATE multiremi_turn_execution_records SET runtime_id=?,status='running',started_at=? WHERE id=?",
    [runtime.id, "2026-10-03T00:00:00.000Z", retry.attempt_id]);
  store.reportTaskUsageSnapshot(retry.attempt_id, { version: 2, runId: "retry", revision: 1, complete: true, units: [unit] });
  compare("24-and-retry");
  store.completeTask(retry.attempt_id, { output: "retry finished before scaling fixture" });
  const tasks = Number(process.env.MUL279_TASKS ?? 240), units = Number(process.env.MUL279_UNITS ?? 6000);
  assert(Number.isSafeInteger(tasks) && tasks >= 24 && Number.isSafeInteger(units) && units >= 0);
  seed(tasks - 24);
  // Replicate facts without timing ingestion; all required identity/FK fields are copied.
  if (units) db.run(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<?)
    INSERT INTO multiremi_usage_units(task_id,run_id,unit_id,revision,workspace_id,agent_id,runtime_id,provider,model,scope,source,accuracy,occurred_at,input_tokens,output_tokens)
    SELECT task_id,run_id,'bulk-'||n,revision,workspace_id,agent_id,runtime_id,provider,model,scope,source,accuracy,occurred_at,10,2
    FROM multiremi_usage_units CROSS JOIN numbers WHERE task_id=? AND unit_id='seed' AND run_id='fixture'`, [units, seedTask]);
  store.createTask({ agentId: agent.id, prompt: "queued", issueId: issue.id });
  db.exec("ANALYZE"); compare("large");
  console.log(JSON.stringify({ baseline, dialect: db.dialect, tasks, extra_units: units, fixed_time: new RealDate(fixed).toISOString(),
    boundary: "Store report executions, not HTTP/p95; transaction exec/run excluded; synthetic scratch data, not a stable copy", cases: output }, null, 2));
} finally {
  globalThis.Date = RealDate;
  if (await Bun.file(oldFile).exists()) unlinkSync(oldFile);
  await resource.dispose();
}
