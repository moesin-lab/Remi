import { expect, test } from "bun:test";

test("JSONL preserves error class, message and stack for single and mixed arguments", async () => {
  // Isolate the process-global persistence buffer and directory from other tests.
  const child = Bun.spawn([process.execPath, "-e", `
    import { mkdtempSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { createLogger, initLogPersistence, flushLogs, readLogEntries } from "./packages/shared/src/logger.ts";
    const dir = mkdtempSync(join(tmpdir(), "remi-error-log-"));
    try {
      initLogPersistence(dir);
      const log = createLogger("test");
      const error = new TypeError("programming-error-sentinel");
      log.error("single", error);
      log.error("mixed", "context", error);
      flushLogs();
      process.stdout.write(JSON.stringify(readLogEntries(new Date().toISOString().slice(0, 10), dir)));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  `], { stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  expect(await child.exited).toBe(0);
  expect(await stderr).toContain("ERROR");
  const entries = JSON.parse(await stdout);
  for (const data of [entries[0].data, entries[1].data._args[1]]) {
    expect(data.name).toBe("TypeError");
    expect(data.message).toBe("programming-error-sentinel");
    expect(data.stack).toContain("TypeError: programming-error-sentinel");
    expect(data.stack).toContain("at ");
  }
});
