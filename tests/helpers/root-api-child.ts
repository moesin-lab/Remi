import { MultiremiStore } from "@multiremi/store.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { startMultiremiServer } from "@multiremi/api.js";
import { createHub } from "@multiremi/api/hub/hub-core.js";
import { createLocalHubTransport } from "@multiremi/api/hub/hub-transport.js";
import { deltaTraceEvent } from "./turn-trace.js";
import { redactDiagnostic } from "./two-process.js";

const db = process.env.MULTIREMI_DATABASE_URL
  ? new PostgresSyncDatabase(process.env.MULTIREMI_DATABASE_URL)
  : openSqliteDatabase(process.env.MULTIREMI_TEST_ROOT_API_SQLITE_FILE!) as unknown as SqlDatabase;
const hub = createHub({ transport: createLocalHubTransport(), scheduleFlush: () => {} });
let store: MultiremiStore;
let server: ReturnType<typeof startMultiremiServer> | undefined;

process.on("SIGTERM", () => {
  server?.stop(true);
  hub.shutdown();
  db.close();
  process.exit(0);
});

process.on("message", async (message: { id?: number; command: string; args: any }) => {
  try {
    if (message.command === "start") {
      store = new MultiremiStore(db);
      server = startMultiremiServer({ store, scheduler: null, liveHub: hub, peerChannel: null,
        port: Number(process.env.MULTIREMI_PORT), hostname: "127.0.0.1", authToken: process.env.MULTIREMI_TOKEN });
      process.send!({ event: "ready" });
    } else if (message.command === "trace") {
      hub.append(message.args.taskId, [deltaTraceEvent(message.args.seq, message.args.marker)]);
      hub.flushNow();
    } else {
      throw new Error("Unknown root API fixture command");
    }
    if (message.id !== undefined) process.send!({ id: message.id });
  } catch (error) {
    process.send!({ id: message.id, event: message.id === undefined ? "error" : undefined,
      error: redactDiagnostic(error instanceof Error ? error.message : String(error)) });
  }
});

process.send!({ event: "prepared" });
