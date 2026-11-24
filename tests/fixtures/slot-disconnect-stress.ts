/** Isolated process: a Bun segfault must fail the parent test, not its runner. */
import { fileURLToPath } from "node:url";
import { SlotLifecycle } from "@multiremi/api/slot-lifecycle.js";
import { startMultiremiServer } from "@multiremi/api.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";

const mode = process.argv[2];
const config = { id: "stress", start: "active" as const, controlToken: "stress-only", lockTimeoutMs: 10, drainTimeoutMs: 100 };
let handled = 0;
const lifecycle = new SlotLifecycle(config, "test", {
  acquire: async () => ({ close: async () => {} }), start() {}, stop() {}, disconnect() {},
});
const db = mode === "body" ? null : openSqliteDatabase(":memory:");
const server = mode === "body"
  ? Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => lifecycle.request(req, async () => {
      handled++;
      return new Response(new ReadableStream({
        async pull(controller) {
          await Bun.sleep(5);
          controller.enqueue(new Uint8Array(16 * 1024));
          controller.close();
        },
      }));
    }) })
  : startMultiremiServer({ store: new MultiremiStore(db!), hostname: "127.0.0.1", port: 0,
      authToken: "stress-token", backgroundJobs: false, slotConfiguration: mode === "slot" ? config : null });
if ("slotStartup" in server) await server.slotStartup;
// A separate Node client keeps reset timing independent of Bun's response pulls.
const client = Bun.spawn([Bun.which("node")!, fileURLToPath(new URL("./slot-disconnect-client.mjs", import.meta.url)), String(server.port)], {
  stdout: "pipe", stderr: "inherit",
});
const clientOutput = new Response(client.stdout).text();
if (await client.exited !== 0) throw new Error("disconnect client failed");
const { resets, received } = JSON.parse(await clientOutput);
// Confirm the listener still answers after the resets.
if (!(await fetch(new URL("/healthz", server.url))).ok) throw new Error("listener failed");
await server.stop(true);
db?.close();
console.log(JSON.stringify({ resets, received, ...(mode === "body" ? { handled } : {}) }));
