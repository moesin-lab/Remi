import { afterEach, describe, expect, it } from "bun:test";
import { version } from "../../../package.json";
import { createMultiremiApp, startMultiremiServer } from "@multiremi/api.js";
import { createLocalStore, db, resetMultiremiTestEnv, waitWebSocketOpen, nextWebSocketMessage } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const HEADERS = { Authorization: "Bearer master-secret", "Content-Type": "application/json" };
const UPDATER_HEADERS = { ...HEADERS, "X-Multiremi-Updater-Token": "updater-secret" };

function fixture() {
  const store = createLocalStore();
  const options = { store, authToken: "master-secret", platformUpdaterToken: "updater-secret" };
  const app = createMultiremiApp(options);
  const operation = store.createPlatformOperation({ kind: "update", targetVersion: "1.0.0" }, "local");
  store.claimPlatformOperation();
  store.beginPlatformDrain({ operationId: operation.id });
  return { app, store, options, operation };
}

describe("platform maintenance HTTP write gate", () => {
  it("blocks business mutations through every switch phase while keeping reads available", async () => {
    const { app, store, operation } = fixture();
    const label = store.createLabel({ name: "Keep", color: "#112233", workspaceId: "local" });
    for (const status of ["switching", "restarting", "verifying", "rolling_back"] as const) {
      store.reportPlatformOperation(operation.id, { status });
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const path = method === "POST" ? "/api/multiremi/labels" : `/api/multiremi/labels/${label.id}`;
        const response = await app.request(path, {
          method, headers: HEADERS, body: JSON.stringify({ name: "Must not be accepted", workspaceId: "local" }),
        });
        expect(response.status).toBe(503);
        expect(response.headers.get("Retry-After")).toBe("5");
        expect(await response.json()).toMatchObject({ code: "platform_update_in_progress", operation_id: operation.id });
      }
      expect((await app.request("/api/multiremi/labels", { headers: HEADERS })).status).toBe(200);
      expect(store.listLabels("local").map((item) => item.name)).toEqual(["Keep"]);
    }
    expect((await app.request("/readyz")).status).toBe(200);
    expect((await app.request("/health", { method: "HEAD" })).status).toBe(200);
    expect((await app.request("/api/issues", { method: "OPTIONS" })).status).toBe(204);
    // Public write routes and prefix lookalikes cannot evade the global gate.
    expect((await app.request("/auth/password", { method: "POST", body: "{}" })).status).toBe(503);
    expect((await app.request("/api/platform-updater-other", { method: "POST", headers: HEADERS })).status).toBe(503);
  });

  it("also blocks user and daemon writes and preserves the updater's two credentials", async () => {
    const { app, store, operation } = fixture();
    const userToken = await store.createAccessToken({
      name: "User", type: "pat", purpose: "session", workspaceId: "local", userId: "local",
    });
    const daemonToken = await store.createAccessToken({
      name: "Daemon", type: "daemon", purpose: "daemon", workspaceId: "local", userId: "local", daemonId: "daemon_gate",
    });
    const runtime = store.registerRuntime({
      id: "rt_gate", name: "Gate", provider: "claude", workspaceId: "local", daemonId: "daemon_gate",
    });
    const originalName = store.getCurrentUser("local").name;
    store.reportPlatformOperation(operation.id, { status: "verifying" });

    const userWrite = await app.request("/api/me", {
      method: "PATCH", headers: { ...HEADERS, Authorization: `Bearer ${userToken.token}` },
      body: JSON.stringify({ name: "Lost after rollback" }),
    });
    expect(userWrite.status).toBe(503);
    expect(store.getCurrentUser("local").name).toBe(originalName);
    const daemonWrite = await app.request("/api/daemon/heartbeat", {
      method: "POST", headers: { ...HEADERS, Authorization: `Bearer ${daemonToken.token}` },
      body: JSON.stringify({ runtime_id: runtime.id, drain_ack_generation: 1, active_task_count: 0 }),
    });
    expect(daemonWrite.status).toBe(503);

    const reportPath = `/api/platform-updater/operations/${operation.id}/report`;
    for (const headers of [HEADERS, { "X-Multiremi-Updater-Token": "updater-secret", "Content-Type": "application/json" }]) {
      expect((await app.request(reportPath, {
        method: "POST", headers, body: JSON.stringify({ status: "succeeded" }),
      })).status).toBe(401);
    }
    expect(store.getPlatformOperation(operation.id)?.status).toBe("verifying");
    expect((await app.request(reportPath, {
      method: "POST", headers: UPDATER_HEADERS, body: JSON.stringify({ status: "succeeded" }),
    })).status).toBe(200);
    expect((await app.request("/api/me", {
      method: "PATCH", headers: { ...HEADERS, Authorization: `Bearer ${userToken.token}` },
      body: JSON.stringify({ name: "Saved after verification" }),
    })).status).toBe(200);
    expect(store.getCurrentUser("local").name).toBe("Saved after verification");
  });

  it("holds a restored expired switch drain across API recreation until recovery is reported", async () => {
    const { store, options, operation } = fixture();
    store.reportPlatformOperation(operation.id, { status: "switching" });
    // A restored pre-switch backup retains this operation and its old lease.
    // A fresh app must derive its gate from the database, not an in-memory flag.
    db!.run("UPDATE multiremi_platform_maintenance SET expires_at = ? WHERE id = 'platform'", [new Date(0).toISOString()]);
    const restarted = createMultiremiApp(options);
    const write = () => restarted.request("/api/me", {
      method: "PATCH", headers: HEADERS, body: JSON.stringify({ name: "After recovery" }),
    });
    expect((await write()).status).toBe(503);
    expect(store.getPlatformMaintenance().mode).toBe("draining");
    expect((await restarted.request(`/api/platform-updater/operations/${operation.id}/report`, {
      method: "POST", headers: UPDATER_HEADERS, body: JSON.stringify({ status: "rolled_back" }),
    })).status).toBe(200);
    expect((await write()).status).toBe(200);
  });

  it("lets running tasks finish and acknowledge the drain before switching starts", async () => {
    const { app, store, operation } = fixture();
    const runtime = store.registerRuntime({ id: "rt_draining", name: "Drain", provider: "claude", workspaceId: "local", daemonId: "drain-host" });
    const agent = store.createAgent({ name: "Drain Bot", provider: "claude", runtimeId: runtime.id });
    // Start the task before the real drain: the fixture's initial drain is only
    // released here to represent an already-running task when the host arrives.
    store.releasePlatformDrain(operation.id);
    const task = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "Finish this" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    store.beginPlatformDrain({ operationId: operation.id });
    store.reportPlatformOperation(operation.id, { status: "draining" });

    const server = startMultiremiServer({ store, scheduler: null, backgroundJobs: false, authToken: "master-secret", hostname: "127.0.0.1", port: 0 });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/daemon/ws?protocol=2`, { headers: HEADERS } as never);
    try {
      await waitWebSocketOpen(socket);
      const welcome = nextWebSocketMessage(socket);
      socket.send(JSON.stringify({ v: 2, t: "hello", ts: Date.now(), p: { protocol: 2, daemon_id: "drain-host", cli_version: version,
        launched_by: null, caps: [], runtimes: [{ runtime_id: runtime.id, provider: "claude", max_concurrency: 1, active_task_ids: [task.id] }] } }));
      expect(await welcome).toMatchObject({ t: "welcome" });
      socket.send(JSON.stringify({ v: 2, t: "task.complete", seq: 1, rt: runtime.id, ts: Date.now(),
        p: { task_id: task.id, runtime_id: runtime.id, output: "Finished during drain" } }));
      const deadline = performance.now() + 3_000;
      while (store.getTask(task.id)?.status !== "completed" && performance.now() < deadline) await Bun.sleep(10);
    } finally { socket.close(); server.stop(true); }
    expect(store.getTask(task.id)?.status).toBe("completed");
    expect((await app.request("/api/daemon/heartbeat", {
      method: "POST", headers: HEADERS,
      body: JSON.stringify({ runtime_id: runtime.id, drain_ack_generation: store.getPlatformMaintenance().generation, active_task_count: 0 }),
    })).status).toBe(200);
    expect(store.getPlatformDrainStatus().ready).toBe(true);
  });
});
