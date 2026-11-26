import { claimWithCurrentRuntime } from "../helpers/claim-with-current-runtime.js";
/** MUL-163: isolated real-PG plans; creates/drops its own database, never uses production data.
 * MULTIREMI_TEST_POSTGRES_URL=postgres://... bun tests/manual/bench-claim-base-selection.ts
 */
import { writeFileSync } from "node:fs";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { executionParameterCount, splitExecutionSql } from "@multiremi/store/turn-execution-records.js";
import { MUL449_CLAIM_SQL_GOLDEN } from "../fixtures/mul449-claim-sql-golden.js";

const url = new URL(process.env.MULTIREMI_TEST_POSTGRES_URL!);
const admin = new Bun.SQL(url.toString());
const name = `mul163_plan_${process.pid}`;
await admin.unsafe(`CREATE DATABASE ${name}`);
url.pathname = `/${name}`;
const db = new PostgresSyncDatabase(url.toString());
let store: MultiremiStore | undefined;
try {
  store = new MultiremiStore(db); store.ensureLocalWorkspace();
  const runtime = store.registerRuntime({ id: "rt_golden", name: "plan", provider: "codex", workspaceId: "local", daemonId: "dev-golden" });
  const agent = store.createAgent({ name: "plan", provider: "codex", workspaceId: "local" });
  store.createTask({ agentId: agent.id, prompt: "plan" });
  // A large terminal history and a smaller queued tail, with no expensive prompt payload.
  const seed = db.query("SELECT * FROM multiremi_turns LIMIT 1").get()!;
  db.run(`INSERT INTO multiremi_turns(id, session_id, seq, agent_id, workspace_id, status, current_attempt_id, created_at, execution_scope)
    SELECT 'bench_turn_' || n, ?, n + 100, ?, 'local', CASE WHEN n <= 10000 THEN 'completed' ELSE 'pending' END,
      'bench_attempt_' || n, ?, 'bench_' || n FROM generate_series(1,10200) n`, [seed.session_id, agent.id, seed.created_at]);
  db.run(`INSERT INTO multiremi_turn_attempts(id, turn_id, attempt_no, status, created_at, updated_at)
    SELECT 'bench_attempt_' || n, 'bench_turn_' || n, 1, CASE WHEN n <= 10000 THEN 'completed' ELSE 'offered' END,
      ?, ? FROM generate_series(1,10200) n`, [seed.created_at, seed.created_at]);
  db.exec("ANALYZE");
  let selectedSql = ""; let selectedParams: unknown[] = [];
  const query = db.query.bind(db);
  db.query = ((sql: string) => {
    const statement = query(sql);
    if (!sql.includes("WHERE claim_attempt.status = 'offered'")) return statement;
    selectedSql = sql;
    return { ...statement, get: (...params: unknown[]) => { selectedParams = params; return statement.get(...params); } };
  }) as typeof db.query;
  // Capture the actual production query/arguments while rolling back its effects.
  const rollback = new Error("benchmark rollback");
  try { db.transaction(() => { claimWithCurrentRuntime(store!, runtime.id); throw rollback; })(); }
  catch (error) { if (error !== rollback) throw error; }
  finally { db.query = query; }
  if (!selectedSql) throw new Error("claim selection not captured");
  const [assignments, predicate] = splitExecutionSql(MUL449_CLAIM_SQL_GOLDEN.split(" SET ")[1]!, " WHERE ");
  const where = splitExecutionSql(predicate!, " RETURNING ")[0]!;
  const fields = splitExecutionSql(assignments!, ",").map(part => part.slice(part.indexOf("=") + 1));
  const oldLock = `UPDATE multiremi_turns SET current_attempt_id=current_attempt_id WHERE id IN
    (SELECT turn_id FROM multiremi_turn_execution_records WHERE ${where})`;
  const oldSnapshot = `SELECT id,turn_id,${fields.map((field, i) => `(${field}) AS mutation_${i}`).join(",")}
    FROM multiremi_turn_execution_records WHERE ${where}`;
  const now = new Date().toISOString();
  const setParams = [runtime.id, runtime.id, runtime.id, now, now];
  if (executionParameterCount(oldSnapshot) !== setParams.length + selectedParams.length) throw new Error("golden parameter drift");
  const cases = [["before_lock", oldLock, selectedParams], ["before_snapshot", oldSnapshot, [...setParams, ...selectedParams]],
    ["after_selection", selectedSql, selectedParams]] as const;
  const plans: Record<string, unknown> = {};
  for (const [label, sql, params] of cases) {
    db.exec("BEGIN");
    try { plans[label] = db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`).all(...params); }
    finally { db.exec("ROLLBACK"); }
  }
  const output = { postgres: db.query("SELECT version()").get(), turns: 10201, queued: 201,
    scope: "One eligible Agent, terminal history plus queued tail; isolated warm local PG, not production latency.",
    plans };
  const path = process.env.MUL163_PLAN_OUTPUT ?? "/tmp/MUL-163-plans.json";
  writeFileSync(path, JSON.stringify(output, null, 2));
  console.log(path);
} finally {
  store?.stopNotificationDeliverySweeper(); db.close();
  await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end();
}
