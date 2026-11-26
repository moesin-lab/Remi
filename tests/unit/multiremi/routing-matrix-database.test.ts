import { claimWithCurrentRuntime } from "../../helpers/claim-with-current-runtime.js";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createRoutingMatrixDatabase } from "../../helpers/routing-matrix-database.js";
import { createPostgresStoreTemplate } from "../../helpers/postgres-store-template.js";
import { afterCommit } from "@multiremi/store/db/postgres.js";
import { withRequestReadCache } from "@multiremi/store/request-read-cache.js";

for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !process.env.MULTIREMI_TEST_POSTGRES_URL)(`routing matrix fixture (${dialect})`, () => {
    let template: ReturnType<typeof createPostgresStoreTemplate> | undefined;
    if (dialect === "postgres") {
      beforeAll(async () => {
        const owner = createPostgresStoreTemplate(process.env.MULTIREMI_TEST_POSTGRES_URL!, {
          prefix: "mul304", fixture: "routing-matrix-contract-template",
        });
        try { await owner.prepare(); await owner.warm(); }
        catch (error) { await owner.dispose(); throw error; }
        template = owner;
      });
      afterAll(async () => {
        if (!template) return;
        try {
          expect(template.stats()).toMatchObject({ templateBuilds: 1, clones: 4, freshFallbacks: 0 });
        } finally {
          try { await template.dispose(); }
          finally { console.log("REMI_TEST_DB_FIXTURE_STATS " + JSON.stringify(template.stats())); }
        }
      });
    }

    // Captured by ci-backend.ts in each PG shard artifact as well as the log.
    // Template warm-up is reported separately; clone, Store, body and cleanup
    // all remain inside the unchanged default per-case timeout.
    function measuredIt(name: string, body: (fixture: ReturnType<typeof createRoutingMatrixDatabase>) => void) {
      it(name, async () => {
        const started = performance.now();
        let fixture: ReturnType<typeof createRoutingMatrixDatabase> | undefined;
        let database: Awaited<ReturnType<NonNullable<typeof template>["createDatabase"]>> | undefined;
        let databaseCreateMs = 0;
        let cleanupMs = 0;
        try {
          if (template) {
            const createStarted = performance.now();
            database = await template.createDatabase();
            databaseCreateMs = performance.now() - createStarted;
          }
          fixture = createRoutingMatrixDatabase(dialect, process.env.MULTIREMI_TEST_POSTGRES_URL, database);
          const close = fixture.close;
          fixture.close = () => {
            const closeStarted = performance.now();
            try { close(); } finally { cleanupMs += performance.now() - closeStarted; }
          };
          body(fixture);
        } finally {
          try {
            fixture?.close();
          } finally {
            try {
              if (database) {
                const dropStarted = performance.now();
                try { await template!.dropDatabase(database.name); }
                finally { cleanupMs += performance.now() - dropStarted; }
              }
            } finally {
              const totalMs = performance.now() - started;
              console.log("REMI_TEST_DB_FIXTURE_STATS " + JSON.stringify({
                ...fixture?.stats, dialect, case: name, fixture: "routing-matrix-contract-case",
                databaseCreateMs: databaseCreateMs + (fixture?.stats.databaseCreateMs ?? 0),
                bodyMs: totalMs - databaseCreateMs - (fixture?.stats.setupMs ?? 0) - cleanupMs,
                cleanupMs, totalMs,
              }));
            }
          }
        }
      });
    }
    measuredIt("restores native seed values and removes committed cells without restarting the Store", fixture => {
      try {
        const baseline = fixture.db.query("SELECT * FROM multiremi_workspaces ORDER BY id").all();
        const store = fixture.reset();
        const runtime = store.registerRuntime({ id: "fixture_runtime", name: "cell", provider: "codex" });
        const agent = store.createAgent({ name: "cell", provider: "codex" });
        const task = store.createTask({ agentId: agent.id, prompt: "committed claim" });
        let observed: string | undefined;
        const unsubscribe = store.onTaskEvent(event => { observed = event.task.id; });
        expect(claimWithCurrentRuntime(store, runtime.id)?.id).toBe(task.id);
        store.startTask(task.id);
        unsubscribe();
        // This event is delivered by the real Store commit, before reset.
        expect(observed).toBe(task.id);
        fixture.db.run("UPDATE multiremi_workspaces SET name = ? WHERE id = ?", ["mutated", "local"]);
        expect(fixture.reset()).toBe(store);
        expect(fixture.db.query("SELECT * FROM multiremi_workspaces ORDER BY id").all()).toEqual(baseline);
        expect(store.getTask(task.id)).toBeNull();
        expect(store.getRuntime(runtime.id)).toBeNull();
        expect(fixture.stats).toMatchObject({ storeInitializations: 1, migrationRuns: 1, resets: 2 });
      } finally {
        fixture.close();
      }
    });

    measuredIt("closes its connection when a cell fails", fixture => {
      const closeDatabase = fixture.db.close.bind(fixture.db);
      let closes = 0;
      fixture.db.close = () => { closes++; closeDatabase(); };
      expect(() => {
        try {
          fixture.reset();
          throw new Error("cell failed");
        } finally {
          fixture.close();
        }
      }).toThrow("cell failed");
      expect(closes).toBe(1);
      fixture.close();
      expect(closes).toBe(1);
    });

    measuredIt("refuses request caches, live subscriptions, open transactions and schema changes", fixture => {
      try {
        expect(() => withRequestReadCache(() => fixture.reset())).toThrow("request read caches");
        const unsubscribe = fixture.store.subscribeConversationLog({ onEntry() {} });
        expect(() => fixture.reset()).toThrow("subscriptions");
        unsubscribe();
        fixture.db.transaction(() => {
          expect(() => fixture.reset()).toThrow("open transaction");
        })();
        fixture.db.exec("CREATE TABLE routing_schema_mutation (id TEXT)");
        fixture.db.run("INSERT INTO routing_schema_mutation (id) VALUES (?)", ["sentinel"]);
        expect(() => fixture.reset()).toThrow("Schema-changing");
        expect(fixture.db.query("SELECT id FROM routing_schema_mutation").get().id).toBe("sentinel");
      } finally {
        fixture.close();
      }
    });

    if (dialect === "postgres") {
      measuredIt("does not retain afterCommit callbacks from a rolled-back probe", fixture => {
        try {
          // The preceding case committed DDL; a new clone must not inherit it.
          expect(fixture.db.query("SELECT to_regclass('public.routing_schema_mutation') AS relation").get().relation).toBeNull();
          let delivered = 0;
          expect(() => fixture.db.transaction(() => {
            afterCommit(fixture.db, () => delivered++);
            throw new Error("rollback probe");
          })()).toThrow("rollback probe");
          fixture.reset();
          fixture.db.transaction(() => afterCommit(fixture.db, () => delivered++))();
          expect(delivered).toBe(1);
        } finally {
          fixture.close();
        }
      });
    }
  });
}

it("rejects a remote PostgreSQL URL before creating any connection", () => {
  expect(() => createRoutingMatrixDatabase("postgres", "postgresql://test:test@example.com/remi_test")).toThrow("localhost PostgreSQL test URL");
});
