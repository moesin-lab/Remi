import { afterEach, expect, spyOn, test } from "bun:test";
import { MultiremiScheduler } from "@daemon/scheduler.js";
import { IssueTitleScheduler } from "@multiremi/issue-title/poller.js";
import { RepositoryWikiService } from "@multiremi/repository-wiki/service.js";
import { LiveTermFence, LIVE_TERM_SCHEMA, liveTermDatabase } from "@multiremi/store/live-term-fence.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { StaleLiveTermError, withBackgroundTerm, currentBackgroundTerm } from "@shared/db/live-term.js";
import { DatabaseRetryLoop } from "@shared/db/recovery.js";
import { startMultiremiServer } from "@multiremi/api/server.js";
import { createLocalStore, createResponsibleTestIssue, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

test("the default server activates a single-process term before starting offers and jobs", async () => {
  const store = createLocalStore();
  const scheduler = new MultiremiScheduler({ store });
  let captured: ReturnType<typeof currentBackgroundTerm>;
  const start = spyOn(scheduler, "start").mockImplementation(() => { captured = currentBackgroundTerm(); });
  const server = startMultiremiServer({ store, port: 0, hostname: "127.0.0.1", backgroundJobs: true,
    scheduler, scmPolling: null, messaging: null, issueTitleScheduler: null,
    bodyHtmlBackfill: null, controlPlaneSshMesh: null });
  try {
    await server.slotStartup;
    expect(server.slot).toBeNull();
    expect(captured).toBeDefined();
    expect(() => captured!.assertCurrent()).not.toThrow();
    expect(db!.query("SELECT holder FROM multiremi_live_terms").get()).toEqual({ holder: `single:${process.pid}` });
  } finally {
    await server.shutdown();
    start.mockRestore();
  }
});

test("old prepared statements and async continuations stay fenced after a new activation", async () => {
  const raw = openSqliteDatabase(":memory:");
  try {
    raw.exec(LIVE_TERM_SCHEMA);
    raw.exec("CREATE TABLE effects(value INTEGER)");
    const database = liveTermDatabase(raw);
    const statement = database.prepare("INSERT INTO effects VALUES (?)");
    let losses = 0;
    const a = LiveTermFence.activate(raw, "A", () => { losses++; });
    expect(a.term).toBe("1");
    // NULL results must not cause the wrapper to execute an action twice.
    withBackgroundTerm(a, () => { statement.run(1); database.exec("INSERT INTO effects VALUES (2)"); });
    let resume!: () => void;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const continuation = withBackgroundTerm(a, async () => { await paused; statement.run(3); });
    const b = LiveTermFence.activate(raw, "B", () => {});
    expect(b.term).toBe("2");
    resume();
    await expect(continuation).rejects.toBeInstanceOf(StaleLiveTermError);
    expect(() => withBackgroundTerm(a, () => database.transaction(() => statement.run(4))())).toThrow(StaleLiveTermError);
    expect(() => withBackgroundTerm(a, () => database.run("INSERT INTO effects VALUES (5)"))).toThrow(StaleLiveTermError);
    expect(losses).toBe(1);
    withBackgroundTerm(b, () => statement.run(6));
    expect(raw.query("SELECT value FROM effects ORDER BY value").all()).toEqual([{ value: 1 }, { value: 2 }, { value: 6 }]);
    expect(() => withBackgroundTerm(a, () => statement.run(7))).toThrow(StaleLiveTermError);
    const reactivated = LiveTermFence.activate(raw, "A", () => {});
    expect(reactivated.term).toBe("3");
    withBackgroundTerm(reactivated, () => statement.run(8));
  } finally { raw.close(); }
});

test("A cron, title poll and wiki tick cannot write after B takes over; a trigger runs once", async () => {
  const store = createLocalStore();
  const agent = store.createAgent({ name: "Fence", provider: "codex" });
  const autopilot = store.createAutopilot({ title: "Fence", assigneeId: agent.id, status: "active", executionMode: "run_only",
    triggerKind: "schedule", cronExpression: "0 0 1 1 *" });
  const trigger = store.createAutopilotTrigger(autopilot.id, { kind: "schedule", cronExpression: "0 0 1 1 *", enabled: true });
  db!.run("UPDATE multiremi_autopilot_triggers SET next_run_at = ? WHERE id = ?", [new Date(0).toISOString(), trigger.id]);
  const a = store.activateBackgroundTerm("A", () => {});
  const scheduler = new MultiremiScheduler({ store });
  const titles = new IssueTitleScheduler({ store, retitle: async () => { throw new Error("old title tick reached model"); } });
  const wiki = new RepositoryWikiService(store, null, "openviking");
  store.updateWorkspaceRepositories("local", [{ id: "repo_fence", name: "fence", url: "https://github.com/acme/fence.git", source: "github", default_branch: "main" }]);
  store.applyRepositoryWikiBatch([{ kind: "create", workspaceId: "local", repositoryId: "repo_fence",
    input: { title: "Pending", path: "pending.md", body: "pending" } }], {
    id: "rwjob_fence", workspaceId: "local", repositoryId: "repo_fence", batchId: "batch_fence",
    manifest: { promotions: [], cleanupUris: ["viking://resources/obsolete"] },
  });
  expect(store.listWorkspaceRepositoryWikiStorageJobs("local")).toHaveLength(1);
  const b = store.activateBackgroundTerm("B", () => {});
  const before = db!.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n;
  expect(() => withBackgroundTerm(a, () => scheduler.trigger(autopilot.id))).toThrow(StaleLiveTermError);
  expect(() => withBackgroundTerm(a, () => titles.runOnce())).toThrow(StaleLiveTermError);
  expect(() => withBackgroundTerm(a, () => wiki.runStorageJobs())).toThrow(StaleLiveTermError);
  expect(() => withBackgroundTerm(a, () => scheduler.tickDueTriggers())).toThrow(StaleLiveTermError);
  expect(db!.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n).toBe(before);
  expect(withBackgroundTerm(b, () => scheduler.tickDueTriggers())).toHaveLength(1);
  expect(withBackgroundTerm(b, () => scheduler.tickDueTriggers())).toHaveLength(0);
  expect(store.listAutopilotRuns(autopilot.id)).toHaveLength(1);
});

test("a resumed slot stops all configured background services and only activation creates a fresh context", async () => {
  const store = createLocalStore();
  const scheduler = new MultiremiScheduler({ store });
  let captured: ReturnType<typeof currentBackgroundTerm>;
  const start = spyOn(scheduler, "start").mockImplementation(() => { captured = currentBackgroundTerm(); });
  const stop = spyOn(scheduler, "stop").mockResolvedValue(undefined);
  const title = new IssueTitleScheduler({ store });
  const titleStart = spyOn(title, "start").mockImplementation(() => {});
  const titleStop = spyOn(title, "stop").mockResolvedValue(undefined);
  const wiki = new RepositoryWikiService(store, null, "sql");
  const wikiStart = spyOn(wiki, "startStorageWorker").mockImplementation(() => {});
  const wikiStop = spyOn(wiki, "stopStorageWorker").mockResolvedValue(undefined);
  const server = startMultiremiServer({ store, port: 0, hostname: "127.0.0.1", backgroundJobs: true,
    scheduler, issueTitleScheduler: title, repositoryWiki: wiki,
    scmPolling: null, messaging: null, bodyHtmlBackfill: null, controlPlaneSshMesh: null,
    slotConfiguration: { id: "A", start: "active", controlToken: "test", lockTimeoutMs: 5000, drainTimeoutMs: 5000 } });
  try {
    await server.slotStartup;
    expect(server.slot!.term).toBe("1");
    const status = await (await fetch(`http://127.0.0.1:${server.port}/internal/slot/status`, {
      headers: { Authorization: 'Bearer test' },
    })).json();
    expect(status.term).toBe("1");
    expect(status.schema).toEqual({ expandLevel: 3, contractLevel: 0, compatibility: { minLevel: 3, maxLevel: 3 } });
    const old = captured!;
    store.activateBackgroundTerm("B", () => {});
    let effects = 0;
    const loop = new DatabaseRetryLoop("paused-slot", () => { effects++; }, 5);
    withBackgroundTerm(old, () => loop.start());
    await Bun.sleep(25);
    expect(effects).toBe(0);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(titleStop).toHaveBeenCalledTimes(1);
    expect(wikiStop).toHaveBeenCalledTimes(1);
    expect(server.slot!.state).toBe("failed");
    withBackgroundTerm(old, () => loop.start());
    await Bun.sleep(10);
    expect(effects).toBe(0);
    await loop.stop();
    await server.slot!.release();
    await server.slot!.activate();
    expect(server.slot!.term).toBe("3");
    expect(captured).not.toBe(old);
    expect(() => withBackgroundTerm(old, () => old.assertCurrent())).toThrow(StaleLiveTermError);
    const previous = captured!;
    await server.slot!.release();
    await server.slot!.activate();
    const stopped = stop.mock.calls.length;
    expect(() => previous.assertCurrent()).toThrow(StaleLiveTermError);
    await Bun.sleep(10);
    expect(server.slot!.state).toBe("active");
    expect(stop.mock.calls.length).toBe(stopped);
  } finally {
    await server.shutdown();
    for (const spy of [start, stop, titleStart, titleStop, wikiStart, wikiStop]) spy.mockRestore();
  }
});


test("title model completion after takeover cannot apply its database changes", async () => {
  const store = createLocalStore();
  const issue = createResponsibleTestIssue(store, { title: "Remi", description: "实现稳定的一键 Issue 自动命名功能，并确保模型网络失败不会影响主流程。" });
  let resume!: () => void;
  let started!: () => void;
  const paused = new Promise<void>(resolve => { resume = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const titles = new IssueTitleScheduler({ store, retitle: async () => {
    started();
    await paused;
    store.updateIssue(issue.id, { title: "stale model result" });
    return { applied: true } as never;
  } });
  const a = store.activateBackgroundTerm("A", () => {});
  const result = withBackgroundTerm(a, () => titles.runOnce(new Date(Date.now() + 10 * 60_000)));
  await entered;
  store.activateBackgroundTerm("B", () => {});
  resume();
  await result.catch(error => { expect(error).toBeInstanceOf(StaleLiveTermError); });
  expect(store.getIssue(issue.id)!.title).toBe("Remi");
});


for (const apiRole of ["all", "ui", "runtime"] as const) {
  test(`read-only ${apiRole} server does not take over the background term`, async () => {
    const store = createLocalStore();
    const active = store.activateBackgroundTerm("live", () => { throw new Error("live owner was displaced"); });
    const server = startMultiremiServer({ store, apiRole, backgroundJobs: false, port: 0, hostname: "127.0.0.1" });
    try {
      await server.slotStartup;
      expect(() => active.assertCurrent()).not.toThrow();
    } finally { await server.shutdown(); }
  });
}


for (const apiRole of ["ui", "runtime"] as const) {
  test(`split ${apiRole} jobs preserve the existing unfenced path`, async () => {
    const store = createLocalStore();
    const active = store.activateBackgroundTerm("live", () => { throw new Error("live owner was displaced"); });
    const scheduler = new MultiremiScheduler({ store });
    let context: ReturnType<typeof currentBackgroundTerm>;
    const start = spyOn(scheduler, "start").mockImplementation(() => { context = currentBackgroundTerm(); });
    const server = startMultiremiServer({ store, apiRole, backgroundJobs: true, scheduler,
      scmPolling: null, messaging: null, issueTitleScheduler: null, bodyHtmlBackfill: null, controlPlaneSshMesh: null,
      port: 0, hostname: "127.0.0.1" });
    try {
      await server.slotStartup;
      expect(context).toBeUndefined();
      expect(() => active.assertCurrent()).not.toThrow();
    } finally { await server.shutdown(); start.mockRestore(); }
  });
}
