import { expect, test } from "bun:test";
import { LiveTermFence, LIVE_TERM_SCHEMA, liveTermDatabase } from "@multiremi/store/live-term-fence.js";
import { StaleLiveTermError, withBackgroundTerm } from "@shared/db/live-term.js";
import { openIntegrationDatabase } from "../helpers/integration-database.js";

// Uses an isolated database and an independent process, never a business DB.
test.skipIf(!process.env.MULTIREMI_TEST_POSTGRES_URL)("PG takeover waits for the old fenced transaction, then rejects old continuations", async () => {
  const database = await openIntegrationDatabase();
  let successor: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    const raw = database.db;
    raw.exec(LIVE_TERM_SCHEMA);
    raw.exec("CREATE TABLE fence_effects(value INTEGER)");
    const fenced = liveTermDatabase(raw);
    const a = LiveTermFence.activate(raw, "A", () => {});
    withBackgroundTerm(a, () => fenced.transaction(() => {
      fenced.run("INSERT INTO fence_effects VALUES (1)");
      successor = Bun.spawn([process.execPath, "--no-env-file", "-e", `
        import { PostgresSyncDatabase } from './packages/server/src/store/db/postgres.ts';
        import { LiveTermFence, liveTermDatabase } from './packages/server/src/store/live-term-fence.ts';
        import { withBackgroundTerm } from './packages/shared/src/db/live-term.ts';
        const db = new PostgresSyncDatabase(process.env.LIVE_TERM_TEST_URL);
        try {
          db.exec("SET application_name = 'mul169-successor'");
          const b = LiveTermFence.activate(db, 'B', () => {});
          if (b.term !== '2') throw new Error('wrong successor term');
          withBackgroundTerm(b, () => liveTermDatabase(db).run('INSERT INTO fence_effects VALUES (2)'));
          console.log('takeover-ok');
        } finally { db.close(); }
      `], { env: { ...process.env, LIVE_TERM_TEST_URL: database.url! }, stdout: "pipe", stderr: "pipe" });
      // Parent keeps the fence row locked while the other process tries UPDATE.
      const deadline = performance.now() + 3000;
      let waiting = false;
      while (performance.now() < deadline) {
        // Statistics are cached for the transaction. Refresh before observing
        // the successor, which connects after this transaction has begun.
        raw.query("SELECT pg_stat_clear_snapshot()").get();
        waiting = !!raw.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'mul169-successor' AND wait_event_type = 'Lock'").get();
        if (waiting) break;
        Bun.sleepSync(10);
      }
      expect(waiting).toBe(true);
      expect(raw.query("SELECT CAST(term AS TEXT) AS term FROM multiremi_live_terms").get().term).toBe("1");
    })());
    const [code, output, errors] = await Promise.all([
      successor!.exited, new Response(successor!.stdout).text(), new Response(successor!.stderr).text(),
    ]);
    expect(code, errors).toBe(0);
    expect(output).toContain("takeover-ok");
    expect(() => withBackgroundTerm(a, () => fenced.run("INSERT INTO fence_effects VALUES (3)"))).toThrow(StaleLiveTermError);
    expect(raw.query("SELECT value FROM fence_effects ORDER BY value").all()).toEqual([{ value: 1 }, { value: 2 }]);
  } finally { successor?.kill(); await database.close(); }
}, 10_000);
