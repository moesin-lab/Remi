import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runTests } from "./run-tests.js";

// Separate test processes preserve cold setup and the normal HOME isolation.
const directory = process.argv[2] ?? "outbox-replay-results";
mkdirSync(directory, { recursive: true });
const results: Array<{ iteration: number; exitCode: number; elapsedMs: number }> = [];
for (let iteration = 1; iteration <= 20; iteration++) {
  const started = performance.now();
  let log = "";
  const exitCode = await runTests([
    "tests/unit/daemon/task-report-outbox.test.ts", "--test-name-pattern", "replays over 3000",
  ], text => { log += text; });
  writeFileSync(join(directory, `run-${iteration}.log`), log);
  const result = { iteration, exitCode, elapsedMs: performance.now() - started };
  results.push(result);
  console.log("[outbox-replay-run]", JSON.stringify(result));
}
const elapsed = results.map(result => result.elapsedMs).sort((a, b) => a - b);
const summary = {
  platform: process.platform, bun: Bun.version, results,
  failures: results.filter(result => result.exitCode !== 0).length,
  p50Ms: elapsed[9], p95Ms: elapsed[18], maxMs: elapsed[19],
};
writeFileSync(join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log("[outbox-replay-summary]", JSON.stringify(summary));
if (summary.failures) process.exitCode = 1;
