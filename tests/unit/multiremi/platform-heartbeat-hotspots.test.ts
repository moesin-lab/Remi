import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { openHotspotDatabase, useMigratedHotspotDatabases } from "../../fixtures/multiremi/first-screen-hotspots-database.js";

const databases = useMigratedHotspotDatabases();
afterAll(() => {
  if (process.env.MULTIREMI_TEST_POSTGRES_URL) {
    expect(databases.postgresStats()).toMatchObject({ templateBuilds: 1, clones: 2, freshFallbacks: 0 });
  }
});
afterEach(() => setSystemTime());

// Keep fixture and business costs separate in the CI shard artifact. Each case
// owns a database, connection and Store; migrate() is the real production entry.
function heartbeatTest(name: string, body: (database: Awaited<ReturnType<typeof openHotspotDatabase>>, store: MultiremiStore) => Promise<void>) {
  test(name, async () => {
    const started = performance.now();
    const database = await openHotspotDatabase();
    const opened = performance.now();
    let migrationMs = 0;
    let initialized = opened;
    class TimedStore extends MultiremiStore {
      override migrate(): void {
        const migrationStarted = performance.now();
        try { super.migrate(); }
        finally { migrationMs += performance.now() - migrationStarted; }
      }
    }
    try {
      let store: MultiremiStore;
      try { store = new TimedStore(database.db); }
      finally { initialized = performance.now(); }
      // Template compatibility requires a native clock during initialization.
      // These tests assert business schedules, not migration seed timestamps.
      setSystemTime(new Date("2026-10-05T00:00:00.000Z"));
      await body(database, store);
    } finally {
      const bodyEnded = performance.now();
      try { await database.dispose(); }
      finally {
        console.info("REMI_TEST_DB_FIXTURE_STATS " + JSON.stringify({
          fixture: "platform-heartbeat-case", dialect: database.db.dialect, case: name,
          databaseMs: opened - started, migrationMs, storeMs: initialized - opened - migrationMs,
          bodyMs: bodyEnded - initialized, cleanupMs: performance.now() - bodyEnded,
          totalMs: performance.now() - started,
        }));
      }
    }
  });
}
const release = (version: string) => ({ version, ref: `v${version}`, publishedAt: null, releaseUrl: null,
  manifestUrl: "https://example.test/platform-release.json", apiImage: null, webImage: null });

heartbeatTest("heartbeat skips unchanged CLI reconciliation but sees new daemons, retries failures and defers live releases", async (database, store) => {
  store.ensureLocalWorkspace();
  store.registerRuntime({ id: "rt_aligned", name: "aligned", provider: "codex", daemonId: "dm_aligned",
    metadata: { cli_version: "0.2.85" } });
  const original = store.reconcileRuntimeCliRelease.bind(store);
  let calls = 0, fail = false;
  store.reconcileRuntimeCliRelease = version => {
    calls++;
    if (fail) { fail = false; throw new Error("injected reconciliation failure"); }
    return original(version);
  };
  const app = createMultiremiApp({ store, platformUpdaterToken: "heartbeat-fixture" });
  const heartbeat = (current: string | null = "0.2.85", latest = "0.2.85") => app.request("/api/platform-updater/heartbeat", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Multiremi-Updater-Token": "heartbeat-fixture" },
    body: JSON.stringify({ driver: "docker_compose", currentRelease: current ? release(current) : null, latestRelease: release(latest) }),
  });
  for (let i = 0; i < 20; i++) expect((await heartbeat()).status).toBe(200);
  expect(calls).toBe(1);
  expect((await heartbeat("0.2.85", "0.2.86")).status).toBe(200);
  expect(calls).toBe(1); // advertised latest is not the live release
  store.registerRuntime({ id: "rt_arrival", name: "arrival", provider: "claude", daemonId: "dm_arrival",
    metadata: { cli_version: "0.2.84" } });
  expect((await heartbeat()).status).toBe(200);
  expect(database.db.query("SELECT runtime_id, target_version FROM multiremi_runtime_update_requests").all())
    .toEqual([{ runtime_id: "rt_arrival", target_version: "0.2.85" }]);
  const operation = store.createPlatformOperation({ kind: "restart" }, "local");
  const beforeBusy = calls;
  for (let i = 0; i < 3; i++) expect((await heartbeat("0.2.86")).status).toBe(200);
  expect(calls).toBe(beforeBusy);
  store.reportPlatformOperation(operation.id, { status: "failed" });
  fail = true;
  expect((await heartbeat("0.2.86")).status).toBe(500);
  expect((await heartbeat("0.2.86")).status).toBe(200);
  expect(calls).toBe(beforeBusy + 2);
  const settled = calls;
  for (let i = 0; i < 20; i++) expect((await heartbeat("0.2.86")).status).toBe(200);
  // One verification after our own queue write; stable heartbeats thereafter do no reconciliation.
  expect(calls).toBeLessThanOrEqual(settled + 1);
  expect((await heartbeat(null)).status).toBe(200);
  expect(store.getPlatformState().currentRelease).toBeNull();
  expect((await heartbeat("0.2.86")).status).toBe(200);
});

heartbeatTest("heartbeat claims exactly at due and repairs a missing/invalid schedule without delaying settings changes", async (database, store) => {
  store.ensureLocalWorkspace();
  store.setPlatformAutoUpdateSettings({ enabled: true, time: "01:00", timezone: "UTC" });
  const app = createMultiremiApp({ store, platformUpdaterToken: "heartbeat-fixture" });
  const heartbeat = () => app.request("/api/platform-updater/heartbeat", { method: "POST",
    headers: { "Content-Type": "application/json", "X-Multiremi-Updater-Token": "heartbeat-fixture" },
    body: JSON.stringify({ driver: "docker_compose", currentRelease: release("0.2.85"), latestRelease: release("0.2.85") }) });
  for (const next of [null, "invalid"]) {
    database.db.run("UPDATE multiremi_platform_state SET auto_update_next_check_at = ?", next);
    const response = await heartbeat();
    expect(response.status).toBe(200);
    expect((await response.json()).state.autoUpdateNextCheckAt).toBe("2026-10-05T01:00:00.000Z");
  }
  setSystemTime(new Date("2026-10-05T00:59:59.999Z"));
  await heartbeat(); expect(store.getPlatformState().autoUpdateLastCheckedAt).toBeNull();
  setSystemTime(new Date("2026-10-05T01:00:00.000Z"));
  const responses = await Promise.all([heartbeat(), heartbeat()]);
  expect(responses.map(response => response.status)).toEqual([200, 200]);
  expect(store.getPlatformState()).toMatchObject({ autoUpdateLastCheckedAt: "2026-10-05T01:00:00.000Z",
    autoUpdateLastResult: "no_update", autoUpdateNextCheckAt: "2026-10-06T01:00:00.000Z" });
  store.setPlatformAutoUpdateSettings({ enabled: true, time: "02:00", timezone: "UTC" });
  setSystemTime(new Date("2026-10-05T02:00:00.000Z"));
  await heartbeat(); expect(store.getPlatformState().autoUpdateLastCheckedAt).toBe("2026-10-05T02:00:00.000Z");
});
