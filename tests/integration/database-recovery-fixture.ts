import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store/store.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiScheduler } from "@daemon/scheduler.js";
import { DatabaseUnavailableError } from "@shared/db/recovery.js";
import { createResponsibleTestAutopilot, createResponsibleTestIssue, acceptTestIssueDelivery } from "../unit/multiremi/helpers.js";

const raw = openSqliteDatabase(":memory:");
let down = false;
let failAck = false;
let schedulerTicks = 0;
// Inject at the synchronous SQL boundary, so production Store/transactions,
// scheduler timers, Hono routes and system-event deduplication all run unchanged.
const db = new Proxy(raw, {
  get(target, key) {
    if (key === "connectionUnavailable") return down;
    if (key === "query" || key === "prepare") return (sql: string) => {
      const statement = target[key](sql);
      return new Proxy(statement, { get(stmt, method) {
        const value = Reflect.get(stmt, method, stmt);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => { check(sql); return value.apply(stmt, args); };
      } });
    };
    if (key === "run" || key === "exec") return (sql: string, ...args: any[]) => {
      check(sql);
      return (target[key] as Function).call(target, sql, ...args);
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
function check(sql: string) {
  if (failAck && /SET status = 'processed'/.test(sql)) {
    failAck = false;
    down = true;
  }
  if (down) throw new DatabaseUnavailableError();
}
const store = new MultiremiStore(db);
const agent = store.createAgent({ name: "Recovery fixture", provider: "codex" });
const project = store.createProject({ title: "Recovery fixture" });
const issue = createResponsibleTestIssue(store, { title: "Recover", projectId: project.id, status: "in_review", assigneeType: "agent", assigneeId: agent.id });
const autopilot = createResponsibleTestAutopilot(store, {
  title: "Recovery", projectId: project.id, assigneeId: agent.id, executionMode: "trigger_issue",
  sessionPolicy: "new", workspacePolicy: "reuse_issue", issueTitleTemplate: "Recover event",
});
store.createAutopilotTrigger(autopilot.id, { kind: "system_event", eventConfig: {
  resource: "issue", event: "status_changed", projectId: project.id,
  conditions: [{ field: "status", operator: "becomes", value: "done" }],
} });
acceptTestIssueDelivery(store, issue.id);
const event = raw.query("SELECT id FROM multiremi_system_events WHERE resource_id=? AND event='status_changed' AND json_extract(payload,'$.status')='done'").get(issue.id) as { id: string };
const scheduler = new MultiremiScheduler({ store, pollIntervalMs: 20, failureMonitorIntervalMs: 0 });
const originalSync = scheduler.sync.bind(scheduler);
scheduler.sync = () => { schedulerTicks++; originalSync(); };
const app = createMultiremiApp({ store });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
process.on("message", (input: any) => {
  if (input.command === "outage") {
    // First dispatch commits its run; lose the DB before acknowledging the event.
    failAck = true;
    scheduler.start();
  }
  if (input.command === "recover") {
    down = false;
    raw.run("UPDATE multiremi_system_events SET lease_until=? WHERE id=?", [new Date(Date.now() - 1).toISOString(), event.id]);
  }
  const row = raw.query("SELECT status,attempt_count FROM multiremi_system_events WHERE id=?").get(event.id);
  const runs = raw.query("SELECT COUNT(*) AS count FROM multiremi_autopilot_run_records WHERE event_id=?").get(event.id) as { count: number };
  process.send?.({ id: input.id, row, runs: runs.count, schedulerTicks, pid: process.pid });
});
process.on("SIGTERM", () => { scheduler.stop(); server.stop(true); raw.close(); process.exit(0); });
process.send?.({ ready: true, port: server.port, pid: process.pid });
