import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);
const admin = { Authorization: "Bearer master", "Content-Type": "application/json" };
const updater = { ...admin, "X-Multiremi-Updater-Token": "updater" };
function fixture() {
  const store = createLocalStore();
  const app = createMultiremiApp({ store, authToken: "master", platformUpdaterToken: "updater" });
  return { app, store };
}

describe("platform safe update API", () => {
  it("persists and resets a custom source, invalidates old checks, and rejects invalid URLs and unauthenticated writes", async () => {
    const { app, store } = fixture();
    const patch = (body: unknown, headers = admin) => app.request("/api/multiremi/platform/settings", { method: "PATCH", headers, body: JSON.stringify(body) });
    expect((await patch({ releaseFeedUrl: "https://mirror.example/releases.json" }, { Authorization: "Bearer wrong", "Content-Type": "application/json" })).status).toBe(401);
    for (const value of ["http://example.com/feed", "file:///tmp/feed", "https://user:password@example.com/feed", "https://example.com/#x", 25]) {
      expect((await patch({ releaseFeedUrl: value })).status).toBe(400);
    }
    expect((await patch({ releaseFeedUrl: "https://mirror.example/releases.json" })).status).toBe(200);
    expect(store.getPlatformState()).toMatchObject({ releaseFeedUrl: "https://mirror.example/releases.json", latestRelease: null, preflight: null });
    const heartbeat = await app.request("/api/platform-updater/heartbeat", { method: "POST", headers: updater, body: JSON.stringify({ driver: "docker_compose", defaultReleaseFeedUrl: "https://default.example/feed" }) });
    expect((await heartbeat.json()).state.releaseFeedUrl).toBe("https://mirror.example/releases.json");
    expect((await patch({ releaseFeedUrl: null })).status).toBe(200);
    const status = await app.request("/api/multiremi/platform/status", { headers: admin });
    expect(await status.json()).toMatchObject({ releaseFeedUrl: null, defaultReleaseFeedUrl: "https://default.example/feed" });
  });

  it("ignores in-flight results from a superseded source and refuses changes during an operation", async () => {
    const { app, store } = fixture();
    store.setPlatformAutoUpdateSettings({ enabled: false, time: "05:00", timezone: "UTC", releaseFeedUrl: "https://new.example/feed" });
    store.heartbeatPlatformUpdater({ driver: "docker_compose", releaseFeedUrl: "https://old.example/feed", preflight: { ready: true, checkedAt: new Date().toISOString(), platform: "linux", arch: "x64", checks: [] } });
    expect(store.getPlatformState().preflight).toBeNull();
    store.createPlatformOperation({ kind: "check_updates" }, "local");
    const response = await app.request("/api/multiremi/platform/settings", { method: "PATCH", headers: admin, body: JSON.stringify({ releaseFeedUrl: null }) });
    expect(response.status).toBe(409);
  });

  it("rejects service operations while offline or preflight is blocked, but still permits checks", async () => {
    const { app } = fixture();
    for (const kind of ["restart", "update", "rollback"]) {
      const response = await app.request("/api/multiremi/platform/operations", { method: "POST", headers: admin, body: JSON.stringify({ kind, targetVersion: "1.2.3" }) });
      expect(response.status).toBe(409);
    }
    expect((await app.request("/api/multiremi/platform/operations", { method: "POST", headers: admin, body: JSON.stringify({ kind: "check_updates" }) })).status).toBe(202);
  });

  it("refuses switching before drain, fences cancellation, and keeps committed maintenance after lease expiry", async () => {
    const { app, store } = fixture();
    const op = store.createPlatformOperation({ kind: "update", targetVersion: "1.2.3" }, "local");
    store.claimPlatformOperation();
    const report = () => app.request(`/api/platform-updater/operations/${op.id}/report`, { method: "POST", headers: updater, body: JSON.stringify({ status: "switching" }) });
    expect((await report()).status).toBe(409);
    store.beginPlatformDrain({ operationId: op.id });
    expect((await report()).status).toBe(200);
    expect(() => store.cancelPlatformOperation(op.id)).toThrow();
    db!.run("UPDATE multiremi_platform_maintenance SET expires_at = ? WHERE id = 'platform'", [new Date(0).toISOString()]);
    expect(store.getPlatformMaintenance().mode).toBe("draining");
    expect(store.getActivePlatformOperation()?.status).toBe("switching");
    const finished = await app.request(`/api/platform-updater/operations/${op.id}/report`, { method: "POST", headers: updater, body: JSON.stringify({ status: "succeeded" }) });
    expect(finished.status).toBe(200);
    expect(store.getPlatformMaintenance().mode).toBe("normal");
  });

  it("rejects invalid, expired or future readiness timestamps even with a fresh heartbeat", async () => {
    const { app, store } = fixture();
    for (const checkedAt of ["invalid", new Date(Date.now() - 361_000).toISOString(), new Date(Date.now() + 360_000).toISOString()]) {
      store.heartbeatPlatformUpdater({ driver: "docker_compose", preflight: { ready: true, checkedAt, platform: "win32", arch: "x64", checks: [] } });
      const response = await app.request("/api/multiremi/platform/operations", { method: "POST", headers: admin, body: JSON.stringify({ kind: "restart" }) });
      expect(response.status).toBe(409);
    }
  });

  it("does not commit when cancellation arrives after backup", async () => {
    const { app, store } = fixture();
    const op = store.createPlatformOperation({ kind: "restart" }, "local");
    store.claimPlatformOperation();
    store.beginPlatformDrain({ operationId: op.id });
    store.reportPlatformOperation(op.id, { status: "backing_up" });
    store.cancelPlatformOperation(op.id);
    const response = await app.request(`/api/platform-updater/operations/${op.id}/report`, { method: "POST", headers: updater, body: JSON.stringify({ status: "switching" }) });
    expect(response.status).toBe(409);
    expect(store.getActivePlatformOperation()?.status).toBe("backing_up");
  });
});
