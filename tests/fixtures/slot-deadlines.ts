/** Real API child; only external latency and post-server disposal are injected. */
import { startMultiremiServer } from "@multiremi/api.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import { waitForShutdown } from "../../apps/remi/cli/multiremi.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";

const [mode, path, id] = process.argv.slice(2);
const db = openSqliteDatabase(path!);
db.exec("PRAGMA journal_mode=WAL");
const store = new MultiremiStore(db);
store.ensureLocalWorkspace();
const issue = store.listIssues({ workspaceId: "local" })[0] ?? store.createIssue({ title: "before", workspaceId: "local" });
let fence: "normal" | "hang" | "sync" | "sync-pg" = "normal";
let fenceDb: PostgresSyncDatabase | undefined;
let fenceSleepMs = 120;
let fenceQueries = 1;
const server = startMultiremiServer({ store, hostname: "127.0.0.1", port: 0, backgroundJobs: false,
  authToken: "deadline-test", readPool: null,
  slotConfiguration: mode === "legacy-shutdown" ? null : {
    id: id!, start: "standby", controlToken: "control-test", lockTimeoutMs: 100, drainTimeoutMs: 50,
  },
  slotFence: async () => {
    if (fence === "hang") await Bun.sleep(500);
    if (fence === "sync") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, fenceSleepMs);
    if (fence === "sync-pg") {
      for (let i = 0; i < fenceQueries; i++) fenceDb!.query(`SELECT pg_sleep(${fenceSleepMs / 1000})`).get();
    }
    return 7;
  },
});
process.on("message", (message: any) => {
  if (message.op === "database") process.env.MULTIREMI_DATABASE_URL = message.url;
  if (message.op === "timeout" && server.slot) server.slot.config.lockTimeoutMs = message.value;
  if (message.op === "fence") fence = message.value;
  if (message.op === "fenceDatabase") {
    fenceDb?.close();
    fenceDb = new PostgresSyncDatabase(message.url);
    fenceSleepMs = message.sleepMs;
    fenceQueries = message.queries ?? 1;
  }
  process.send?.({ event: "ack", pending: server.pendingRequests });
});
const stopped = waitForShutdown(async () => {
  await server.shutdown();
  if (mode.endsWith("shutdown")) {
    // Models the additional guard/database/read-resource cleanup candidates.
    for (let step = 0; step < 4; step++) { console.log(`disposal:${step}`); await Bun.sleep(20_000); }
  }
  db.close();
  fenceDb?.close();
}, server.exitRequested);
await server.slotStartup;
process.send?.({ event: "ready", port: server.port, issue: issue.id });
await stopped;
process.exit(0);
