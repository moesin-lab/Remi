/**
 * Isolated SQL source profile, not a production traffic replay.
 * bun run test tests/manual/profile-api-load.test.ts
 * Optional MULTIREMI_TEST_POSTGRES_URL selects a real isolated PG database;
 * an explicit unreachable database fails rather than falling back to SQLite.
 * Compare the same fixture and request mix at both revisions. No provider runs.
 */
import { expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import type { SqlDatabase, SqlStatement } from "@multiremi/store/db/postgres.js";
import { percentile } from "@multiremi/observability/request-metrics.js";
import { openHotspotDatabase, useMigratedHotspotDatabases } from "../fixtures/multiremi/first-screen-hotspots-database.js";
import { seedFirstScreenHotspotsFixture } from "../fixtures/multiremi/first-screen-hotspots-fixture.js";

useMigratedHotspotDatabases();

it("profiles twelve real HTTP routes with a fixed, equal-frequency request mix", async () => {
  const database = await openHotspotDatabase();
  let queries = 0;
  const sqlCounts = new Map<string, number>();
  const record = (sql: string) => {
    queries++;
    sqlCounts.set(sql, (sqlCounts.get(sql) ?? 0) + 1);
  };
  const db = new Proxy(database.db, {
    get(target, property) {
      if (property === "query" || property === "prepare") return (sql: string) => {
        const statement = target[property](sql);
        return new Proxy(statement, {
          get(statement, method) {
            const value = Reflect.get(statement, method);
            if (["get", "all", "run", "values"].includes(String(method))) return (...params: unknown[]) => {
              record(sql);
              return (value as (...args: unknown[]) => unknown).apply(statement, params);
            };
            return typeof value === "function" ? value.bind(statement) : value;
          },
        }) as SqlStatement;
      };
      const value = Reflect.get(target, property);
      if (property === "run" || property === "exec") return (sql: string, ...params: unknown[]) => {
        record(sql);
        return value.call(target, sql, ...params);
      };
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as SqlDatabase;
  const store = new MultiremiStore(db);
  try {
    const fixture = seedFirstScreenHotspotsFixture(store, {
      sessions: 60, agents: 8, inboxRows: 100, privatePrimaryAgent: false,
      run: (sql, params) => db.run(sql, params as never[]),
    });
    const credential = await store.createAccessToken({ name: "MUL-85 isolated profile", type: "pat",
      userId: fixture.readerUserId, workspaceId: fixture.workspaceId, purpose: "session" });
    const headers = { Authorization: `Bearer ${credential.token}`, "X-Workspace-ID": fixture.workspaceId };
    const app = createMultiremiApp({ store, authToken: "isolated-profile-root" });
    const paths = ["/api/turns", "/api/inbox", "/api/agents", "/api/multiremi/runtimes",
      "/api/projects", "/api/issues", "/api/chat/sessions", "/api/workspaces/local",
      "/api/skills", "/api/workspaces", `/api/issues/${fixture.issueIds[0]}`,
      `/api/issues/${fixture.issueIds[0]}/sessions`];
    const ranking = [];
    for (const path of paths) {
      expect((await app.request(path, { headers })).status, path).toBe(200);
      queries = 0;
      sqlCounts.clear();
      const durations = [];
      for (let n = 0; n < 10; n++) {
        const startedAt = performance.now();
        const response = await app.request(path, { headers });
        await response.text();
        durations.push(performance.now() - startedAt);
        expect(response.status).toBe(200);
      }
      ranking.push({ path, requests: 10, queries_per_request: queries / 10, db_queries: queries,
        p50_ms: percentile(durations, 0.5), sum_ms: durations.reduce((a, b) => a + b, 0),
        statements: [...sqlCounts].sort((a, b) => b[1] - a[1]).slice(0, 5) });
    }
    ranking.sort((a, b) => b.db_queries - a.db_queries || b.sum_ms - a.sum_ms);
    console.info(`MUL85_PROFILE ${JSON.stringify({ dialect: db.dialect, agents: 8, sessions: 60,
      inboxRows: 100, runtimes: 1, liveDaemons: 0, traffic: "equal-frequency HTTP only", ranking })}`);
  } finally {
    store.stopNotificationDeliverySweeper();
    await database.dispose();
  }
}, 30_000);
