import { fileURLToPath } from "node:url";

/** Package the worker with its imports for fixtures running outside the source tree. */
export async function buildPostgresWorker(outdir: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL("../../packages/server/src/store/db/pg-worker.ts", import.meta.url))],
    target: "bun",
    outdir,
    // PgBridge resolves this filename relative to the bundled fixture.
    naming: "pg-worker.ts",
  });
  if (!result.success) throw new Error(result.logs.map(String).join("\n"));
}
