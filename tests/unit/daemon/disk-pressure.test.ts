import { describe, expect, test } from "bun:test";
import { STORAGE_SETTINGS_DEFAULTS as defaults } from "@multiremi/contracts/storage.js";
import { classifyDiskSpace, DiskPressureMonitor, strictestDiskThresholds, DISK_HYSTERESIS_BYTES, PRESSURE_RETRY_MS } from "@daemon/agent-runtime/workspace/disk-pressure.js";
import { parseDaemonHealth } from "@multiremi/contracts/daemon-protocol.js";
const GiB = 1024 ** 3;
const space = (free: number) => ({ free_bytes: free * GiB, total_bytes: 100 * GiB });

describe("disk watermarks", () => {
  test("either percent or bytes triggers pressure/critical, with equality allowed", () => {
    expect(classifyDiskSpace(space(20), defaults)).toBe("ok");
    expect(classifyDiskSpace(space(19), defaults)).toBe("pressure");
    expect(classifyDiskSpace(space(4), defaults)).toBe("critical");
    expect(classifyDiskSpace({ free_bytes: 10 * GiB, total_bytes: 1000 * GiB }, { ...defaults, critical_free_bytes: 0 })).toBe("critical");
  });
  test("recovery requires hysteresis; disabling both conditions removes it", () => {
    expect(classifyDiskSpace(space(6), defaults, "critical")).toBe("critical");
    expect(classifyDiskSpace(space(8), defaults, "critical")).toBe("pressure");
    expect(classifyDiskSpace(space(21), defaults, "pressure")).toBe("pressure");
    expect(classifyDiskSpace(space(23), defaults, "pressure")).toBe("ok");
    expect(classifyDiskSpace(space(0), { pressure_free_percent: 0, pressure_free_bytes: 0, critical_free_percent: 0, critical_free_bytes: 0 }, "critical")).toBe("ok");
    expect(DISK_HYSTERESIS_BYTES).toBe(2 * GiB);
  });
  test("takes the maximum for each condition across workspaces", () => {
    expect(strictestDiskThresholds([{ ...defaults, critical_free_percent: 9 }, { ...defaults, pressure_free_bytes: 40 * GiB }]))
      .toEqual({ critical_free_percent: 9, critical_free_bytes: 5 * GiB, pressure_free_percent: 15, pressure_free_bytes: 40 * GiB });
  });
  test("critical refuses claims independently, health recovers and wakes claims; retries bounded", async () => {
    let now = 0, free = 4, runs = 0, wakes = 0, heartbeats = 0;
    const monitor = new DiskPressureMonitor({ path: "/tmp", thresholds: () => defaults, read: async () => space(free), now: () => now,
      criticalChanged: (_disk, wasCritical) => { heartbeats++; if (wasCritical) wakes++; }, pressure: async () => { runs++; } });
    await monitor.check();
    expect(monitor.critical).toBe(true);
    expect(parseDaemonHealth(monitor.health())).toMatchObject({ state: "degraded", reasons: [{ code: "disk_critical" }] });
    now++; free = 6; await monitor.check();
    expect(monitor.critical).toBe(true); expect(runs).toBe(1);
    now += PRESSURE_RETRY_MS; await monitor.check(); expect(runs).toBe(2);
    free = 8; await monitor.check();
    expect(monitor.critical).toBe(false); expect(wakes).toBe(1); expect(heartbeats).toBe(2);
    expect(monitor.health()).toMatchObject({ state: "ok", reasons: [{ code: "disk_pressure" }] });
    free = 24; await monitor.check(); expect(monitor.health().reasons).toEqual([]);
  });
  test("measurement failure preserves the last critical state", async () => {
    let failed = false;
    const monitor = new DiskPressureMonitor({ path: "/tmp", thresholds: () => defaults, read: async () => failed ? null : space(1), criticalChanged: () => {}, pressure: async () => {} });
    await monitor.check(); failed = true; await monitor.check(); expect(monitor.critical).toBe(true);
    expect(parseDaemonHealth({ state: "degraded", reasons: [{ code: "disk_critical", detail: {} }] })).toBeUndefined();
  });
});

test("health checks continue while a pressure reclaim is blocked", async () => {
  let free = 4;
  let finish!: () => void;
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const monitor = new DiskPressureMonitor({ path: "/tmp", thresholds: () => defaults,
    read: async () => space(free), criticalChanged: () => {}, pressure: () => blocked });
  await monitor.check(); expect(monitor.critical).toBe(true);
  free = 30; await monitor.check(); expect(monitor.critical).toBe(false);
  finish();
});
