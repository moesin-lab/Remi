import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPostgresWorker } from "../../helpers/build-postgres-worker.js";

test("bundled PostgreSQL bridge starts outside the repository without source aliases", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mul101-worker-bundle-"));
  try {
    await buildPostgresWorker(dir);
    const bridge = fileURLToPath(new URL("../../../packages/server/src/store/db/postgres.ts", import.meta.url));
    const recovery = fileURLToPath(new URL("../../../packages/shared/src/db/recovery.ts", import.meta.url));
    const probe = join(dir, "probe.ts");
    writeFileSync(probe, `
      import assert from "node:assert/strict";
      import { PostgresSyncDatabase } from ${JSON.stringify(bridge)};
      import { DatabaseUnavailableError } from ${JSON.stringify(recovery)};
      assert.throws(() => new PostgresSyncDatabase("postgresql://multiremi@127.0.0.1:1/multiremi"), DatabaseUnavailableError);
      if (process.env.MULTIREMI_TEST_POSTGRES_URL) {
        const db = new PostgresSyncDatabase(process.env.MULTIREMI_TEST_POSTGRES_URL);
        try {
          assert.equal(db.query("SELECT 42 AS value").get().value, 42);
          assert.throws(() => db.exec("SELECT FROM"), error => !(error instanceof DatabaseUnavailableError));
        } finally { db.close(); }
      }
      console.log("PASS isolated bundled worker");
    `);
    const result = await Bun.build({ entrypoints: [probe], target: "bun", outdir: dir });
    expect(result.success).toBe(true);
    const child = Bun.spawn([process.execPath, join(dir, "probe.js")], {
      cwd: dir, stdout: "pipe", stderr: "pipe", timeout: 8_000,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("PASS isolated bundled worker");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 15_000);
