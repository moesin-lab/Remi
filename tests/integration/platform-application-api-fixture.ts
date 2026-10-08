// Bundled into the disposable application's API image by the Docker smoke.
// Uses the real authenticated API and PostgreSQL store across API restarts.
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { openMultiremiDatabase } from "@multiremi/store/db/postgres.js";

const store = new MultiremiStore(openMultiremiDatabase());
store.ensureLocalWorkspace();
export const app = createMultiremiApp({
  store,
  authToken: process.env.FIXTURE_ADMIN_TOKEN!,
  platformUpdaterToken: process.env.FIXTURE_UPDATER_TOKEN!,
});

// A controlled active execution tests drain without starting a real provider.
// This module only ships in a randomly named, isolated test image.
app.post("/fixture/task", async (c) => {
  const runtime = store.registerRuntime({ id: "rt_fixture", name: "fixture", provider: "claude", workspaceId: "local" });
  store.heartbeatRuntime(runtime.id);
  const agent = store.createAgent({ name: "Fixture", provider: "claude", runtimeId: runtime.id });
  const task = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "fixture" });
  if (store.claimTask(runtime.id)?.id !== task.id) throw new Error("Fixture could not claim task");
  store.startTask(task.id);
  return c.json({ id: task.id });
});
app.post("/fixture/task/:id/finish", (c) => {
  store.completeTask(c.req.param("id"), { output: "completed without interruption" });
  return c.json({ ok: true });
});
// Model the daemon heartbeat/ack, keeping the real drain aggregation and gate.
setInterval(() => {
  if (!store.getRuntime("rt_fixture")) return;
  store.heartbeatRuntime("rt_fixture");
  store.recordRuntimeDrainAck("rt_fixture", store.getPlatformMaintenance().generation, 0);
}, 100);
