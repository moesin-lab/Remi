/**
 * Opt-in, disposable Docker verification; never connects to an existing DB.
 * MULTIREMI_TEST_DOCKER_RECOVERY=1 bun test tests/integration/platform-recovery-postgres.test.ts
 * Images must already exist locally; no ports or host database paths are used.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

const enabled = process.env.MULTIREMI_TEST_DOCKER_RECOVERY === "1";
const repository = resolve(import.meta.dir, "../..");

function docker(args: string[], input?: string | Buffer): Buffer {
  // Exercise the same Node binary I/O as the production host script, even
  // when this test itself runs through Bun on Windows.
  const bridge = `const fs=require('node:fs');const cp=require('node:child_process');
    const request=JSON.parse(fs.readFileSync(0,'utf8'));
    const result=cp.spawnSync('docker',request.args,{input:request.input===null?undefined:Buffer.from(request.input,'base64'),maxBuffer:16*1024*1024,timeout:90000});
    process.stdout.write(JSON.stringify({status:result.status,stdout:result.stdout?.toString('base64'),stderr:result.stderr?.toString(),error:result.error?.message}));`;
  const native = spawnSync("node", ["-e", bridge], {
    input: JSON.stringify({ args, input: input === undefined ? null : Buffer.from(input).toString("base64") }),
    maxBuffer: 24 * 1024 * 1024, timeout: 95_000,
  });
  if (native.status !== 0) throw new Error(`Node Docker bridge failed: ${native.stderr?.toString()}`);
  const result = JSON.parse(native.stdout.toString());
  if (result.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(" ")} failed: ${result.error ?? result.stderr}`);
  return Buffer.from(result.stdout, "base64");
}

describe.skipIf(!enabled)("isolated PostgreSQL platform recovery", () => {
  test("restores a clean business DB, overlays the current control plane, and reconciles receipts atomically", async () => {
    const container = `remi-updater-recovery-test-${process.pid}`;
    const temporary = mkdtempSync(join(tmpdir(), "remi-updater-recovery-"));
    let started = false;
    try {
      // --network none leaves only loopback; the test runner joins that same
      // namespace. There is no published port or access to production services.
      docker(["run", "--detach", "--rm", "--pull=never", "--name", container,
        "--label", "remi.test=platform-recovery", "--network", "none",
        "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "--env", "POSTGRES_USER=multiremi",
        "--env", "POSTGRES_DB=multiremi", "pgvector/pgvector:pg17"]);
      started = true;
      for (let attempt = 0; ; attempt += 1) {
        const result = spawnSync("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "multiremi", "-d", "multiremi"], { timeout: 5000 });
        if (result.status === 0) break;
        if (attempt >= 30) throw new Error("isolated PostgreSQL did not become ready");
        await Bun.sleep(500);
      }
      const sql = (statement: string) => docker(["exec", "--interactive", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-At", "-U", "multiremi", "-d", "multiremi"], statement).toString().trim();
      const migrations = readFileSync(join(repository, "packages/server/src/store/migrations.ts"), "utf8");
      const definitions = [...migrations.matchAll(/CREATE TABLE IF NOT EXISTS multiremi_platform_(?:state|operations|maintenance) \([\s\S]*?\n    \);/gu)].map((match) => match[0]);
      expect(definitions).toHaveLength(3);
      sql(`${definitions.join("\n")}
        ALTER TABLE multiremi_platform_operations ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;
        CREATE UNIQUE INDEX active_operation ON multiremi_platform_operations(active_slot);
        CREATE UNIQUE INDEX operation_key ON multiremi_platform_operations(requested_by,idempotency_key) WHERE idempotency_key IS NOT NULL;
        CREATE TABLE issues (id TEXT PRIMARY KEY, title TEXT NOT NULL);
        INSERT INTO issues VALUES ('historical', 'original data');
        INSERT INTO multiremi_platform_state (id,driver,created_at,updated_at) VALUES ('platform','local_profile','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
        INSERT INTO multiremi_platform_maintenance (id,created_at,updated_at) VALUES ('platform','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');`);
      const fullDump = docker(["exec", container, "pg_dump", "-U", "multiremi", "-d", "multiremi", "-Fc"]);
      expect(fullDump.subarray(0, 5).toString()).toBe("PGDMP");
      sql(`UPDATE issues SET title='new version writes';
        CREATE TABLE introduced_by_new_version (id INTEGER PRIMARY KEY);
        INSERT INTO introduced_by_new_version VALUES (1);
        INSERT INTO multiremi_platform_operations (id,idempotency_key,kind,status,driver,active_slot,target_version,requested_by,created_at,updated_at,started_at)
          VALUES ('pop_current','rollback-current','rollback','rolling_back','local_profile',1,'1.0.0','local','2026-09-30T10:00:00.000Z','2026-09-30T10:00:00.000Z','2026-09-30T10:00:00.000Z');
        UPDATE multiremi_platform_maintenance SET mode='draining',generation=9,operation_id='pop_current',expires_at='9999-12-31T23:59:59.999Z';`);
      const controlPlaneDump = docker(["exec", container, "pg_dump", "-U", "multiremi", "-d", "multiremi", "-Fc",
        "--table=public.multiremi_platform_operations", "--table=public.multiremi_platform_maintenance", "--table=public.multiremi_platform_state"]);

      // These are the actual restoreBackup commands in local-profile.mjs.
      docker(["exec", container, "dropdb", "-U", "multiremi", "--if-exists", "--force", "multiremi"]);
      docker(["exec", container, "createdb", "-U", "multiremi", "--owner=multiremi", "--template=template0", "multiremi"]);
      docker(["exec", "--interactive", container, "pg_restore", "-U", "multiremi", "-d", "multiremi", "--exit-on-error", "--single-transaction"], fullDump);
      expect(sql("SELECT title FROM issues WHERE id='historical'")).toBe("original data");
      expect(sql("SELECT to_regclass('public.introduced_by_new_version') IS NULL")).toBe("t");
      expect(sql("SELECT COUNT(*) FROM multiremi_platform_operations")).toBe("0");
      docker(["exec", "--interactive", container, "pg_restore", "-U", "multiremi", "-d", "multiremi", "--clean", "--if-exists", "--exit-on-error", "--single-transaction"], controlPlaneDump);
      expect(sql("SELECT status FROM multiremi_platform_operations WHERE id='pop_current'")).toBe("rolling_back");
      expect(sql("SELECT mode || '|' || operation_id || '|' || expires_at FROM multiremi_platform_maintenance WHERE id='platform'"))
        .toBe("draining|pop_current|9999-12-31T23:59:59.999Z");
      expect(sql("SELECT title FROM issues WHERE id='historical'")).toBe("original data");

      const built = await Bun.build({ entrypoints: [join(import.meta.dir, "platform-recovery-postgres-fixture.ts")], target: "bun", outdir: temporary });
      if (!built.success) throw new Error(built.logs.map(String).join("\n"));
      copyFileSync(join(repository, "packages/server/src/store/db/pg-worker.ts"), join(temporary, "pg-worker.ts"));
      const output = docker(["run", "--rm", "--pull=never", "--network", `container:${container}`,
        "--mount", `type=bind,src=${temporary},dst=/check,readonly`, "--workdir", "/check",
        "oven/bun:1.3.14", "bun", `/check/${basename(built.outputs[0]!.path)}`]).toString();
      expect(output).toContain("PASS PostgreSQL reconciliation");
      console.log("PASS clean DB restore + control-plane overlay + PostgreSQL receipt transactions");
    } finally {
      if (started) docker(["rm", "--force", container]);
      const resolved = realpathSync(temporary);
      if (!resolved.startsWith(realpathSync(tmpdir()) + sep) || !basename(resolved).startsWith("remi-updater-recovery-")) throw new Error("refusing to clean an unexpected test directory");
      rmSync(resolved, { recursive: true, force: true });
    }
  }, 120_000);
});
