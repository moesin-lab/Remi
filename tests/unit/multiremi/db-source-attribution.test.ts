import { afterEach, expect, it } from "bun:test";
import { Hono } from "hono";
import { withDbJob, withDbSource, configureDbSources, drainDbSources } from "@shared/observability/db-sources.js";
import { createRequestMetricsMiddleware, recordDbQuery, resetRequestMetricsForTest,
  startRequestMetricsSummary } from "@multiremi/observability/request-metrics.js";

afterEach(resetRequestMetricsForTest);

it("partitions interleaved HTTP, WS and jobs in the same SQL window, including an unfinished request", async () => {
  const options = { enabled: true, summaryDbRoutes: true, slowRequestMs: 1e9,
    summaryIntervalMs: 1e9, summaryTopRoutes: 2, bufferCapacity: 1, role: "all" as const };
  const app = new Hono();
  app.use(createRequestMetricsMiddleware(options));
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  app.get("/api/item/:id", async c => {
    recordDbQuery(2, 0);
    // Job starts inside HTTP context but owns its queries exclusively.
    await withDbJob("scm.poll", async () => { await Promise.resolve(); recordDbQuery(3, 0); });
    entered();
    await gate;
    recordDbQuery(5, 0);
    return c.json({ ok: true });
  });
  const lines: any[] = [];
  const log = console.log;
  console.log = line => { lines.push(JSON.parse(line)); };
  const runtime = startRequestMetricsSummary(options)!;
  try {
    const pending = app.request("/api/item/private-token?secret=private");
    await ready;
    await withDbSource("ws", "hb", async () => { await Promise.resolve(); recordDbQuery(7, 0); });
    recordDbQuery(11, 0);
    runtime.flush();
    expect(lines[0]).toMatchObject({ db_queries: 4, db_attributed: { http: 1, ws: 1, job: 1 }, db_unattributed: 1 });
    expect(lines[0].db_sources).toHaveLength(2); // top-N doesn't truncate attribution totals
    release();
    const response = await pending;
    expect(response.headers.get("Server-Timing")).toContain('dbq;desc="2"');
    runtime.flush();
    expect(lines[1]).toMatchObject({ db_queries: 1, db_attributed: { http: 1, ws: 0, job: 0 }, db_unattributed: 0 });
    expect(lines[1].db_sources).toEqual([{ kind: "http", name: "GET /api/item/:id",
      count: 1, db_queries: 1, queries_per_invocation: 1, db_ms: 5 }]);
    runtime.flush();
    expect(lines[2]).toMatchObject({ db_queries: 0, db_sources: [], db_unattributed: 0 });
    expect(JSON.stringify(lines)).not.toContain("private");
  } finally { release(); runtime.stop(); console.log = log; }
});

it("bounds source cardinality and preserves every query in overflow totals", () => {
  configureDbSources(true);
  for (let n = 0; n < 600; n++) withDbSource("http", `GET /pattern-${n}`, () => recordDbQuery(1, 0));
  const window = drainDbSources(1000);
  expect(window.db_sources.length).toBeLessThanOrEqual(515);
  expect(window.db_sources.find(row => row.name === "<overflow>")?.db_queries).toBe(88);
  expect(window.db_attributed).toEqual({ http: 600, ws: 0, job: 0 });
});

it("does not collect sources unless explicitly enabled, even for a job that throws", () => {
  expect(() => withDbJob("scm.poll", () => { recordDbQuery(1, 0); throw new Error("fixture"); })).toThrow("fixture");
  expect(drainDbSources(10).db_sources).toEqual([]);
});

it("keeps response-derived asynchronous SQL in its execution window without double counting", async () => {
  const options = { enabled: true, summaryDbRoutes: true, slowRequestMs: 1e9,
    summaryIntervalMs: 1e9, summaryTopRoutes: 10, bufferCapacity: 10, role: "all" as const };
  const app = new Hono();
  app.use(createRequestMetricsMiddleware(options));
  let release!: () => void;
  let completion!: Promise<void>;
  const gate = new Promise<void>(resolve => { release = resolve; });
  app.get("/api/launch/:id", c => {
    completion = gate.then(() => { recordDbQuery(2, 0); });
    return c.json({ ok: true });
  });
  const lines: any[] = [];
  const log = console.log;
  console.log = line => { lines.push(JSON.parse(line)); };
  const runtime = startRequestMetricsSummary(options)!;
  try {
    await app.request("/api/launch/private");
    runtime.flush();
    expect(lines[0]).toMatchObject({ db_queries: 0, requests: 1, db_unattributed: 0 });
    release(); await completion;
    runtime.flush();
    expect(lines[1]).toMatchObject({ db_queries: 1, requests: 0,
      db_attributed: { http: 1, ws: 0, job: 0 }, db_unattributed: 0, db_routes: [] });
    expect(lines[1].db_sources[0]).toMatchObject({ name: "GET /api/launch/:id", count: 1, db_queries: 1 });
  } finally { release(); runtime.stop(); console.log = log; }
});
