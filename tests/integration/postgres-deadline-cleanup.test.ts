import { expect, test } from "bun:test";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { withDatabaseDeadline } from "@shared/db/recovery.js";
import { openIntegrationDatabase } from "../helpers/integration-database.js";

const pgTest = test.skipIf(!process.env.MULTIREMI_TEST_POSTGRES_URL);

for (const mode of ["worker timeout", "between statements"] as const) {
  pgTest(`activation deadline cleans up a transaction after ${mode}`, async () => {
    const database = await openIntegrationDatabase();
    const db = database.db as PostgresSyncDatabase;
    const observer = new PostgresSyncDatabase(database.url!);
    try {
      db.exec("CREATE TABLE deadline_probe (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)");
      db.run("INSERT INTO deadline_probe VALUES (1, 0)");
      const pid = Number(db.query("SELECT pg_backend_pid() AS pid").get().pid);
      let wrote = false;
      await expect(withDatabaseDeadline(performance.now() + 1_000, () => db.transaction(() => {
        // Match activation's N → D order; keep the whole-suite sentinel enabled.
        db.advisoryXactLock("deadline-cleanup");
        db.run("UPDATE deadline_probe SET value = 1 WHERE id = 1");
        wrote = true;
        if (mode === "worker timeout") db.query("SELECT pg_sleep(2)").get();
        else {
          Bun.sleepSync(1_100);
          db.query("SELECT 1").get();
        }
      })())).rejects.toThrow(mode === "worker timeout" ? "Database temporarily unavailable" : "deadline exceeded");
      expect(wrote).toBe(true);
      // This must be the FIRST statement after the failed transaction: a new
      // transaction could hide the leaked worker flag by issuing a rollback.
      // Honor the normal connection-outage backoff without sending any SQL.
      if (mode === "worker timeout") Bun.sleepSync(1_050);
      expect(db.query("SELECT 42 AS ok").get().ok).toBe(42);
      expect(observer.query("SELECT value FROM deadline_probe WHERE id = 1").get().value).toBe(0);
      const activity = observer.query("SELECT state, xact_start FROM pg_stat_activity WHERE pid = ?").get(pid);
      if (mode === "between statements") expect(activity).toMatchObject({ state: "idle", xact_start: null });
      else expect(activity).toBeNull(); // The timed-out session was discarded.
      expect(observer.query("SELECT COUNT(*)::int AS n FROM pg_locks WHERE pid = ? AND (locktype = 'advisory' OR mode = 'RowExclusiveLock')").get(pid).n).toBe(0);

      // An independent process must take both the row and transaction advisory
      // locks without waiting for this process to close its bridge.
      const successor = Bun.spawn([process.execPath, "--no-env-file", "-e", `
        import { PostgresSyncDatabase } from './packages/server/src/store/db/postgres.ts';
        const db = new PostgresSyncDatabase(process.env.DEADLINE_TEST_DATABASE_URL);
        try {
          db.exec("SET lock_timeout = '500ms'");
          db.transaction(() => {
            db.advisoryXactLock('deadline-cleanup');
            db.run('UPDATE deadline_probe SET value = 2 WHERE id = 1');
          })();
          console.log('takeover-ok');
        } finally { db.close(); }
      `], { env: { ...process.env, DEADLINE_TEST_DATABASE_URL: database.url! }, stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([
        successor.exited, new Response(successor.stdout).text(), new Response(successor.stderr).text(),
      ]);
      expect(code, stderr).toBe(0);
      expect(stdout).toContain("takeover-ok");
      expect(observer.query("SELECT value FROM deadline_probe WHERE id = 1").get().value).toBe(2);
    } finally { observer.close(); await database.close(); }
  }, 10_000);
}

for (const kind of ["nested transaction", "optional savepoint"] as const) {
  pgTest(`expired deadline permits rollback-to and release of ${kind}`, async () => {
    const database = await openIntegrationDatabase();
    const db = database.db as PostgresSyncDatabase;
    try {
      db.exec("CREATE TABLE deadline_probe (id INTEGER PRIMARY KEY)");
      await expect(withDatabaseDeadline(performance.now() + 1_000, () => db.transaction(() => {
        const inner = () => {
          db.run("INSERT INTO deadline_probe VALUES (1)");
          Bun.sleepSync(1_100);
          throw new Error("inner failure");
        };
        expect(() => kind === "nested transaction" ? db.transaction(inner)() : db.savepoint(inner)).toThrow("inner failure");
        // RELEASE is cleanup too, even after expiry. New work and COMMIT must
        // still fail, so this cannot commit the outer transaction past budget.
        db.exec("SAVEPOINT forbidden_new_work");
      })())).rejects.toThrow("deadline exceeded");
      expect(db.query("SELECT 42 AS ok").get().ok).toBe(42);
      expect(db.query("SELECT COUNT(*)::int AS n FROM deadline_probe").get().n).toBe(0);
    } finally { await database.close(); }
  });
}

for (const cleanup of ["ROLLBACK", "ROLLBACK TO SAVEPOINT probe", "RELEASE SAVEPOINT probe"]) {
  pgTest(`hung ${cleanup} drops the backend and permits independent takeover`, async () => {
    const database = await openIntegrationDatabase();
    const observer = new PostgresSyncDatabase(database.url!);
    const proxy = new Worker(new URL("../fixtures/pg-cleanup-lock-proxy.ts", import.meta.url).href);
    let injected = false;
    let db: PostgresSyncDatabase | undefined;
    const lock = 168103;
    try {
      const port = await new Promise<number>((resolve, reject) => {
        proxy.onerror = reject;
        proxy.onmessage = ({ data }) => {
          if (data.port) resolve(data.port);
          if (data.injected) injected = true;
        };
        proxy.postMessage({ url: database.url, cleanup: cleanup.toUpperCase(), lock });
      });
      const url = new URL(database.url!);
      url.port = String(port);
      url.searchParams.set("sslmode", "disable");
      db = new PostgresSyncDatabase(url.toString());
      db.exec("CREATE TABLE deadline_probe (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)");
      db.run("INSERT INTO deadline_probe VALUES (1, 0)");
      const pid = Number(db.query("SELECT pg_backend_pid() AS pid").get().pid);
      // Keep the blocker held through every assertion: the injected query can
      // never finish naturally, unlike pg_sleep. The old backend owns a role
      // lock and a partial write while it waits for this independent observer.
      observer.query("SELECT pg_advisory_lock(?)").get(lock);
      expect(db.query("SELECT pg_try_advisory_lock(hashtext('remi:hub:runtime')) AS locked").get().locked).toBe(true);
      db.exec("BEGIN");
      db.exec("SAVEPOINT probe");
      db.run("UPDATE deadline_probe SET value = 1 WHERE id = 1");
      const started = performance.now();
      await expect(withDatabaseDeadline(performance.now() - 1, () => db!.exec(cleanup))).rejects.toThrow("Database temporarily unavailable");
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThan(4_500);
      expect(elapsed).toBeLessThan(6_000); // 5s budget plus scheduling tolerance
      await Bun.sleep(20); // deliver the proxy's injection notification
      expect(injected).toBe(true);
      expect(observer.query("SELECT state FROM pg_stat_activity WHERE pid = ?").get(pid)).toBeNull();
      expect(observer.query("SELECT COUNT(*)::int AS n FROM pg_locks WHERE pid = ?").get(pid).n).toBe(0);
      expect(observer.query("SELECT value FROM deadline_probe WHERE id = 1").get().value).toBe(0);
      if (cleanup !== "ROLLBACK") db.exec("ROLLBACK"); // clear the lost-transaction flag
      await Bun.sleep(1_050); // normal outage cooldown, no SQL to hide a leak
      expect(db.query("SELECT 42 AS ok").get().ok).toBe(42);
      const successor = Bun.spawn([process.execPath, "--no-env-file", "-e", `
        import { PostgresSyncDatabase } from './packages/server/src/store/db/postgres.ts';
        const db = new PostgresSyncDatabase(process.env.DEADLINE_TEST_DATABASE_URL);
        try {
          db.exec("SET lock_timeout = '500ms'");
          if (!db.query("SELECT pg_try_advisory_lock(hashtext('remi:hub:runtime')) AS locked").get().locked) throw Error('role lock retained');
          db.run('UPDATE deadline_probe SET value = 2 WHERE id = 1');
          console.log('takeover-ok');
        } finally { db.close(); }
      `], { env: { ...process.env, DEADLINE_TEST_DATABASE_URL: database.url! }, stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([
        successor.exited, new Response(successor.stdout).text(), new Response(successor.stderr).text(),
      ]);
      expect(code, stderr).toBe(0);
      expect(stdout).toContain("takeover-ok");
    } finally {
      db?.close(); proxy.terminate(); observer.close(); await database.close();
    }
  }, 15_000);
}
