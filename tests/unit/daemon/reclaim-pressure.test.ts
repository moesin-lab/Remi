import { join } from "node:path";
import { DiskPressureMonitor } from "@daemon/agent-runtime/workspace/disk-pressure.js";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import * as fs from "node:fs";
import { workDirectory } from "@daemon/agent-runtime/workspace/layout.js";
import { cleanupFixtures, reclaimFixture } from "./reclaim-fixture.js";
import { executionTrackerFor } from "@daemon/agent-runtime/workspace/execution-tracker.js";
afterEach(cleanupFixtures);
const GiB = 1024 ** 3;
const low = { free_bytes: GiB, total_bytes: 100 * GiB };
const high = { free_bytes: 25 * GiB, total_bytes: 100 * GiB };

test("pressure clears residue first then reclaims ended subjects by LRU, stopping above threshold", async () => {
  const f = reclaimFixture();
  const older = { kind: "issue" as const, id: "iss_old" }, newer = { kind: "issue" as const, id: "iss_new" };
  for (const [subject, age] of [[newer, 1000], [older, 2000]] as const) {
    f.subject(subject, { usedAgoMs: age }); f.worktree(subject);
    f.server.answer(subject.id, { status: "done", updated_at: new Date(f.now).toISOString() });
  }
  const report = await f.engine({
    diskSpace: async () => f.server.reclaimed.length ? high : low }).run("pressure");
  expect(report).toMatchObject({ mode: "pressure", reclaimed_this_round: 1 });
  expect(report.disk).toBeUndefined();
  expect(report.plan).toContainEqual(expect.objectContaining({ subject: older, reason: "pressure" }));
  expect(existsSync(workDirectory(f.root, newer))).toBe(true);
});

test("pressure never reclaims running, pinned, active or unsaveable work", async () => {
  const f = reclaimFixture();
  const cases = [{ id: "iss_active", kind: "issue" as const }, { id: "chat_pinned", kind: "chat" as const }, { id: "iss_running", kind: "issue" as const }];
  for (const subject of cases) { f.subject(subject); f.worktree(subject); f.server.answer(subject.id, subject.kind === "chat" ? { status: "archived", pinned: true } : { status: subject.id === "iss_active" ? "in_progress" : "done" }); }
  const tracker = executionTrackerFor(f.root);
  const release = tracker.begin(cases[2]!.id, "tsk_running");
  try {
    const report = await f.engine({ diskSpace: async () => low }).run("pressure");
    expect(report.reclaimed_this_round).toBe(0);
    expect(report.retained).toMatchObject({ pinned: 1, running: 1, not_ended: 1 });
    for (const subject of cases) expect(existsSync(workDirectory(f.root, subject))).toBe(true);
  } finally { release(); }
});

test("pressure cleans temp and a superseded generation without TTL, then stops before ended workspaces", async () => {
  const f = reclaimFixture();
  const subject = { kind: "issue" as const, id: "iss_superseded" };
  f.subject(subject, { usedAgoMs: 1000 });
  f.worktree(subject);
  const old = f.lane(subject, 1, { ageMs: 1000 });
  const newest = f.lane(subject, 2, { ageMs: 500 });
  f.server.answer(subject.id, { status: "done", updated_at: new Date(f.now).toISOString() });
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { taskTmpRoot } = await import("@daemon/agent-runtime/workspace/layout.js");
  const tmp = join(taskTmpRoot(f.root, subject), "tsk_residue");
  mkdirSync(tmp, { recursive: true }); writeFileSync(join(tmp, "cache"), "x");
  let observedOrder = false;
  const report = await f.engine({ diskSpace: async () => {
    if (!existsSync(join(old, "work"))) {
      expect(existsSync(tmp)).toBe(false); observedOrder = true; return high;
    }
    return low;
  } }).run("pressure");
  expect(observedOrder).toBe(true);
  expect(report.reclaimed_this_round).toBe(0);
  expect(existsSync(join(newest, "work"))).toBe(true);
  expect(existsSync(workDirectory(f.root, subject))).toBe(true);
});

test("pressure retains unsaved standalone work and never deletes an external work directory", async () => {
  const f = reclaimFixture();
  const subject = { kind: "issue" as const, id: "iss_dirty" };
  const external = { kind: "issue" as const, id: "iss_external" };
  const { cloneAt } = await import("./reclaim-fixture.js");
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  f.subject(subject); const tree = f.worktree(subject);
  cloneAt(f, join(tree, "standalone"));
  writeFileSync(join(tree, "standalone", "local-only"), "must survive");
  const ext = join(f.scratch, "external"); mkdirSync(ext);
  writeFileSync(join(ext, "keep"), "keep");
  f.subject(external, { externalWorkDir: ext }); f.lane(external, 1);
  for (const item of [subject, external]) f.server.answer(item.id, { status: "done" });
  const report = await f.engine({ diskSpace: async () => low }).run("pressure");
  expect(report.retained.snapshot_failed).toBe(1);
  expect(existsSync(join(tree, "standalone", "local-only"))).toBe(true);
  expect(existsSync(join(ext, "keep"))).toBe(true);
});

function monitorFor(f: ReturnType<typeof reclaimFixture>, read: () => Promise<typeof low>, criticalChanged = () => {}) {
  const monitor = new DiskPressureMonitor({ path: f.root, read, thresholds: () => f.policy,
    criticalChanged, pressure: async () => {} });
  return { monitor, options: { diskSpace: read, checkDisk: () => monitor.check(), storageDisk: () => monitor.latest } };
}

test("report shares the monitor's critical hysteresis watermark at 4 -> 6 GiB", async () => {
  const f = reclaimFixture();
  let free = 4;
  const { monitor, options } = monitorFor(f, async () => ({ ...low, free_bytes: free * GiB }));
  await monitor.check();
  free = 6;
  const report = await f.engine(options).run("periodic");
  expect(report.disk).toEqual(monitor.latest);
  expect(report.disk?.level).toBe("critical");
  expect(monitor.health()).toMatchObject({ state: "degraded", reasons: [{ code: "disk_critical" }] });
  expect(monitor.critical).toBe(true); // the daemon's offer rejection gate
});

test("equal pressure and critical thresholds reclaim beyond the critical exit line and restore claims", async () => {
  const f = reclaimFixture();
  f.policy.pressure_free_percent = f.policy.critical_free_percent = 5;
  f.policy.pressure_free_bytes = f.policy.critical_free_bytes = 5 * GiB;
  for (let n = 0; n < 3; n++) {
    const subject = { kind: "issue" as const, id: `iss_equal_${n}` };
    f.subject(subject, { usedAgoMs: (3 - n) * 1000 }); f.worktree(subject);
    f.server.answer(subject.id, { status: "done" });
  }
  let wakes = 0;
  const { monitor, options } = monitorFor(f,
    async () => ({ ...low, free_bytes: [4, 6, 8][Math.min(2, f.server.reclaimed.length)]! * GiB }),
    () => { if (!monitor.critical) wakes++; });
  await monitor.check(); expect(monitor.critical).toBe(true);
  const report = await f.engine(options).run("pressure");
  expect(report.reclaimed_this_round).toBe(2); // 6 GiB is above pressure but still critical
  expect(report.disk?.level).toBe("ok");
  expect(monitor.critical).toBe(false);
  expect(monitor.health()).toEqual({ state: "ok", reasons: [] });
  expect(wakes).toBe(1);
});

test.each([
  ["plugins.sha", "plugins.sync.lock"],
  ["plugins.sync.lock", "plugins.sha"],
])("pressure cleans finished execution caches first, keeps running caches and stops before ended subjects (%s before %s)", async (first, second) => {
  const f = reclaimFixture();
  const ended = { kind: "issue" as const, id: "iss_cache_ended" };
  const running = { kind: "issue" as const, id: "iss_cache_running" };
  const paths = [ended, running].map(subject => {
    f.subject(subject); f.worktree(subject); f.server.answer(subject.id, { status: "done" });
    const lane = f.lane(subject, 1);
    const home = join(lane, "executions", "exec_finished", "home", ".tmp");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "plugins.sha"), "cached");
    writeFileSync(join(home, "plugins.sync.lock"), "cached");
    return home;
  });
  // Directory enumeration order is filesystem-dependent. Exercise both orders
  // while retaining real cache files, safe deletion and the reclaim engine.
  const readDirectory = fs.readdirSync;
  let cacheReads = 0;
  const enumeration = spyOn(fs, "readdirSync").mockImplementation(((...args: Parameters<typeof readDirectory>) => {
    if (String(args[0]) === paths[0] && args[1] === undefined) {
      cacheReads++;
      return [first, second];
    }
    return readDirectory(...args);
  }) as typeof readDirectory);
  const release = executionTrackerFor(f.root).begin(running.id, "tsk_running");
  try {
    // One deleted entry frees enough space, whichever entry was enumerated first.
    const report = await f.engine({ diskSpace: async () =>
      [first, second].every(name => existsSync(join(paths[0]!, name))) ? low : high }).run("pressure");
    expect(existsSync(join(paths[0]!, first))).toBe(false);
    // Check after every entry: enough space means leave even the next cache entry alone.
    expect(existsSync(join(paths[0]!, second))).toBe(true);
    for (const name of [first, second]) expect(existsSync(join(paths[1]!, name))).toBe(true);
    expect(existsSync(workDirectory(f.root, ended))).toBe(true);
    expect(report.reclaimed_this_round).toBe(0);
    expect(cacheReads).toBe(1);
    expect(report.codex_plugin_cache).toEqual({ planned_homes: 1, cleaned_homes: 0 });
  } finally { enumeration.mockRestore(); release(); }
});
