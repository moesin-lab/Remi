// Manual, isolated Docker smoke: bun run tests/integration/platform-backup-smoke.ts
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBackup, isWithin } from "@remi-platform/updater/safety.js";
import { BunCommandRunner } from "@remi-platform/updater/types.js";

const runner = new BunCommandRunner();
const name = `remi-backup-smoke-${randomUUID().slice(0, 8)}`;
const directory = await mkdtemp(join(tmpdir(), "remi-backup-smoke-"));
const persistent = join(directory, "persistent");
await mkdir(persistent);
await writeFile(join(persistent, "transcript.txt"), "agent transcript: 保留数据");
const docker = async (...args: string[]) => {
  const result = await runner.run("docker", args);
  if (result.exitCode !== 0) throw new Error(`Docker smoke step ${args[0]} failed`);
  return result.stdout.trim();
};
let started = false;
try {
  await docker("run", "--detach", "--name", name, "--label", "remi.test=platform-backup", "--env", "POSTGRES_USER=qa", "--env", "POSTGRES_PASSWORD=isolated-test-only", "--env", "POSTGRES_DB=qa", "pgvector/pgvector:pg17");
  started = true;
  for (let i = 0; i < 40; i++) {
    if ((await runner.run("docker", ["exec", name, "pg_isready", "-U", "qa", "-d", "qa"])).exitCode === 0) break;
    await Bun.sleep(500);
  }
  const sql = (...args: string[]) => docker("exec", name, "psql", "-U", "qa", "-d", "qa", "-v", "ON_ERROR_STOP=1", "-tA", "-c", ...args);
  await sql("CREATE TABLE update_sentinel (id integer primary key, text_value text); INSERT INTO update_sentinel VALUES (1, '保留数据'), (2, 'running agent transcript');");
  const before = await sql("SELECT md5(string_agg(id::text || text_value, ',' ORDER BY id)) FROM update_sentinel");
  const config = {
    directory: join(directory, "backups"),
    databaseDumpCommand: ["docker", "exec", name, "pg_dump", "-U", "qa", "-d", "qa", "-Fc"],
    databaseVerifyCommand: [process.execPath, resolve("scripts/verify-platform-backup.ts"), name, "qa"],
    dataPaths: [persistent],
  };
  const backup = await createBackup(config, runner, "pop_smoke");
  const manifest = JSON.parse(await readFile(join(backup, "complete.json"), "utf8"));
  const after = await sql("SELECT md5(string_agg(id::text || text_value, ',' ORDER BY id)) FROM update_sentinel");
  if (before !== after || manifest.files.length !== 2) throw new Error("Data preservation failed");
  if (await readFile(join(backup, "state-0", "transcript.txt"), "utf8") !== "agent transcript: 保留数据") throw new Error("File preservation failed");
  if (await sql("SELECT COUNT(*) FROM pg_database WHERE datname LIKE 'remi_restorecheck_%'") !== "0") throw new Error("Restore verification left a temporary database");
  const broken = { ...config, databaseDumpCommand: [process.execPath, "-e", "process.stdout.write('corrupt backup')"] };
  let refused = false;
  try { await createBackup(broken, runner, "pop_corrupt"); } catch { refused = true; }
  if (!refused) throw new Error("Corrupt database dump was accepted");
  console.log(JSON.stringify({ databaseRestoredToScratch: true, liveDataUnchanged: before === after, persistentFilePreserved: true, verifiedFiles: manifest.files.length, corruptBackupRejected: refused, scratchDatabasesRemaining: await sql("SELECT COUNT(*) FROM pg_database WHERE datname LIKE 'remi_restorecheck_%'") }));
} finally {
  if (started) await docker("rm", "--force", "--volumes", name);
  if (!isWithin(tmpdir(), directory)) throw new Error("Unexpected smoke directory");
  await rm(directory, { recursive: true, force: true });
}
