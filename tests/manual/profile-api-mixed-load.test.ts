/**
 * Synthetic scale, never a production replay. Actual HTTP + real WS daemon harness,
 * production background schedulers; SQLite-only per-query bridge-delay simulation.
 * MUL85_RUNTIMES=8 MUL85_POLLERS=10 MUL85_SQL_MS=2.5 MUL85_SECONDS=60 \
 * MUL85_PROFILE_OUT=/tmp/mul85-mixed.json bun test tests/manual/profile-api-mixed-load.test.ts
 */
import { expect, it, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DaemonProtocolHarness } from "../integration/daemon-protocol-v2/harness.js";
import { useMigratedIntegrationDatabases } from "../helpers/integration-database.js";
import { seedFirstScreenHotspotsFixture } from "../fixtures/multiremi/first-screen-hotspots-fixture.js";
import { recordDbQuery, startRequestMetricsSummary,
  drainRequestMetricsForTest, readProcessDbCounters, resetRequestMetricsForTest } from "@multiremi/observability/request-metrics.js";
import { MultiremiScheduler } from "@multiremi/scheduler.js";
import { ScmPollingScheduler } from "@multiremi/scm/poller.js";
import { scmIngestionStore } from "@multiremi/scm/store.js";
import { IssueTitleScheduler } from "@multiremi/issue-title/poller.js";
import { MessagingScheduler } from "@multiremi/messaging/scheduler.js";
import { createMessageProviderRegistry } from "@multiremi/messaging/index.js";

useMigratedIntegrationDatabases();
const positive = (key: string, fallback: number) => {
  const n = Number(process.env[key] ?? fallback);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid ${key}`);
  return n;
};
it("profiles mixed HTTP, real daemon heartbeats and production background scans", async () => {
  const runtimes = Math.max(1, positive("MUL85_RUNTIMES", 8));
  const pollers = positive("MUL85_POLLERS", 10);
  const seconds = positive("MUL85_SECONDS", 60);
  const sqlMs = positive("MUL85_SQL_MS", 2.5);
  const skillFiles = positive("MUL85_SKILL_FILES", 0);
  const extraIds = Array.from({ length: runtimes - 1 }, (_, n) => `rt_mul85_${n}`);
  let extraReports: any[] = [];
  const options = { enabled: true, summaryDbRoutes: true, slowRequestMs: 1e9,
    summaryIntervalMs: 1e9, summaryTopRoutes: 50, bufferCapacity: 32768, role: "all" as const };
  const h = await DaemonProtocolHarness.create({
    requestMetrics: options, offerSweepMs: 60_000,
    beforeStart(h) {
      for (const id of extraIds) h.store.registerRuntime({ id, name: "profile runtime", provider: "claude",
        workspaceId: "local", daemonId: "dmn_fixture" });
    },
    // One real socket advertises N real registered runtimes. Their providers are inert;
    // no model runs. This emulates runtime heartbeats, not active provider/lane work.
    beforeSend(frame, socket) {
      if (frame.t === "hello") {
        extraReports = extraIds.map(id => ({ ...frame.p.runtimes[0], runtime_id: id }));
        frame.p.runtimes.push(...extraReports);
      }
      if (frame.t === "hb") frame.p.runtimes.push(...extraReports);
      if (frame.t === "hb" || frame.t === "hello") { socket.native.send(JSON.stringify(frame)); return false; }
    },
  });
  const spies: Array<{ mockRestore(): void }> = [];
  const jobs: Array<{ start(): void; stop(): void }> = [];
  let metrics: ReturnType<typeof startRequestMetricsSummary> = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const summaryLines: any[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const dispatchFailures: string[] = [];
  console.warn = (...args) => {
    if (args.some(arg => typeof arg === "string" && arg.includes("daemon_offer_failed"))) dispatchFailures.push(String(args[0]));
    originalWarn(...args);
  };
  try {
    await h.startDaemon();
    await h.settleHeartbeat();
    await h.layer.drain();
    expect(h.layer.registry.listSessions()[0]!.runtimeIds.length).toBe(runtimes);
    const fixture = seedFirstScreenHotspotsFixture(h.store, { sessions: 60, agents: 8, inboxRows: 100,
      privatePrimaryAgent: false, run: (sql, params) => h.db.run(sql, params as never[]) });
    if (skillFiles) {
      const skill = h.store.createSkill({ name: "Profile shared large bundle", content: "# Shared bundle",
        files: Array.from({ length: skillFiles }, (_, n) => ({ path: `files/${n}.txt`, content: "x".repeat(10_240) })),
      });
      for (const id of fixture.agentIds) h.store.setAgentSkills(id, [skill.id!]);
    }
    const token = await h.store.createAccessToken({ name: "mixed profile reader", type: "pat",
      userId: fixture.readerUserId, workspaceId: "local", purpose: "session" });
    await h.layer.drain();
    await h.settleHeartbeat();
    const statements = new Map<string, number>();
    let measuring = false;
    let executionDepth = 0;
    let injectedMs = 0;
    const statement = (sql: string, action: () => unknown) => {
      if (executionDepth > 0) return action();
      executionDepth++;
      if (measuring) statements.set(sql, (statements.get(sql) ?? 0) + 1);
      const at = performance.now();
      // Inject delay at the execution boundary, not preparation. Never enabled in product.
      if (injectedMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, injectedMs);
      try { return action(); } finally { executionDepth--; recordDbQuery(performance.now() - at, 0); }
    };
    if (h.db.dialect !== "sqlite") throw new Error("This bridge-delay profile requires SQLite; PG is a separate validation");
    for (const method of ["query", "prepare"] as const) {
      const original = h.db[method].bind(h.db);
      spies.push(spyOn(h.db, method).mockImplementation(((sql: string) => {
        const prepared = original(sql);
        return new Proxy(prepared, { get(target, key) {
          const value = Reflect.get(target, key);
          if (["get", "all", "run", "values"].includes(String(key))) return (...args: unknown[]) =>
            statement(sql, () => value.apply(target, args));
          return typeof value === "function" ? value.bind(target) : value;
        } });
      }) as typeof h.db[typeof method]));
    }
    for (const method of ["run", "exec"] as const) {
      const original = h.db[method].bind(h.db);
      spies.push(spyOn(h.db, method).mockImplementation(((sql: string, ...args: unknown[]) =>
        statement(sql, () => (original as Function)(sql, ...args))) as typeof h.db[typeof method]));
    }
    console.log = (...args) => {
      if (typeof args[0] === "string" && args[0].startsWith('{"event":"api_minute_summary"')) summaryLines.push(JSON.parse(args[0]));
      else originalLog(...args);
    };
    jobs.push(new MultiremiScheduler({ store: h.store }), new ScmPollingScheduler({ store: scmIngestionStore(h.store) }),
      new IssueTitleScheduler({ store: h.store }), new MessagingScheduler({ store: h.store.messaging,
        registry: createMessageProviderRegistry() }));
    for (const job of jobs) job.start();
    h.store.startNotificationDeliverySweeper();
    await h.layer.drain();
    await h.settleHeartbeat();
    await Bun.sleep(100);
    const hello = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes;
    const sendHeartbeat = () => h.client.send({ t: "hb", p: { active_task_count: 0, drain_ack_generation: 0,
      runtimes: [hello[0]] } }); // injection supplies the remaining N-1
    sendHeartbeat();
    await h.settleHeartbeat();
    await h.layer.drain();
    // Exclude startup recovery and initial job sweeps; timers keep their actual cadence.
    const before = readProcessDbCounters();
    injectedMs = sqlMs;
    measuring = true;
    drainRequestMetricsForTest();
    metrics = startRequestMetricsSummary(options);
    const started = performance.now();
    sendHeartbeat();
    heartbeat = setInterval(sendHeartbeat, 15_000);
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "profile-api-load-client.ts")], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env },
    });
    child.stdin.write(JSON.stringify({ url: h.url, headers: { Authorization: `Bearer ${token.token}`,
      "X-Workspace-ID": "local" }, pollers, seconds, intervalMs: 1000,
      paths: ["/api/turns", "/api/inbox", "/api/chat/sessions", "/api/issues", "/api/multiremi/runtimes"] }));
    child.stdin.end();
    const [clientText, errors, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, errors).toBe(0);
    clearInterval(heartbeat); heartbeat = undefined;
    for (const job of jobs) job.stop();
    h.store.stopNotificationDeliverySweeper();
    await h.layer.drain();
    await h.settleHeartbeat();
    // Let the independent lag probe observe the final stall before flushing.
    await Bun.sleep(260);
    metrics!.flush();
    expect(dispatchFailures).toEqual([]);
    expect(h.errors).toEqual([]);
    const window = summaryLines.at(-1);
    expect(window.db_queries).toBe(readProcessDbCounters().dbQueries - before.dbQueries);
    expect(window.db_unattributed).toBeGreaterThanOrEqual(0);
    const report = { revision: process.env.MUL85_REVISION ?? "working-tree", dialect: h.db.dialect,
      simulated_sql_delay_ms: sqlMs, seconds, runtimes, pollers, agents: 8, chatSessions: 60,
      activeProviderLanes: 0, daemonSockets: 1, sharedSkillFiles: skillFiles, sharedSkillBytes: skillFiles * 10_240, connections: "real WS + HTTP; synthetic scale; no external model",
      elapsed_ms: performance.now() - started, sql_per_minute: window.db_queries / window.window_ms * 60000,
      statements: [...statements].sort((a, b) => b[1] - a[1]).slice(0, 20),
      client: JSON.parse(clientText), summary: window };
    if (process.env.MUL85_PROFILE_OUT) writeFileSync(process.env.MUL85_PROFILE_OUT, JSON.stringify(report, null, 2));
    originalLog(`MUL85_MIXED_PROFILE ${JSON.stringify(report)}`);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    for (const job of jobs) job.stop();
    metrics?.stop(); console.log = originalLog; console.warn = originalWarn;
    for (const spy of spies.reverse()) spy.mockRestore();
    await h.dispose(); resetRequestMetricsForTest();
  }
}, 240_000);
