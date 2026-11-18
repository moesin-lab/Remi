import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
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
  let caches = false;
  const report = await f.engine({ cleanExecutionCaches: async () => { caches = true; },
    diskSpace: async () => { expect(caches || !f.server.reclaimed.length).toBe(true); return f.server.reclaimed.length ? high : low; } }).run("pressure");
  expect(caches).toBe(true);
  expect(report).toMatchObject({ mode: "pressure", reclaimed_this_round: 1, disk: { level: "ok" } });
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
