/** Restore a pg_dump archive from stdin into a disposable database, never the live database. */
import { randomUUID } from "node:crypto";

const [container, user] = process.argv.slice(2);
if (!container || !user || container.startsWith("-") || user.startsWith("-")) throw new Error("Usage: bun verify-platform-backup.ts <postgres-container> <postgres-user>");
const scratch = `remi_restorecheck_${randomUUID().replaceAll("-", "")}`;
async function run(args: string[], input = false) {
  const child = Bun.spawn(["docker", "exec", ...(input ? ["-i"] : []), container!, ...args], {
    stdin: input ? Bun.stdin : "ignore", stdout: "ignore", stderr: "pipe",
  });
  // Drain stderr but keep credentials/record contents out of updater output.
  await new Response(child.stderr).text();
  if (await child.exited !== 0) throw new Error("PostgreSQL backup restore verification command failed");
}
let created = false;
try {
  await run(["createdb", "--username", user, scratch]);
  created = true;
  await run(["pg_restore", "--username", user, "--dbname", scratch, "--no-owner", "--no-privileges", "--exit-on-error"], true);
  await run(["psql", "--username", user, "--dbname", scratch, "--set", "ON_ERROR_STOP=1", "--command", "SELECT COUNT(*) FROM pg_catalog.pg_tables"]);
} finally {
  if (created) await run(["dropdb", "--username", user, scratch]);
}
