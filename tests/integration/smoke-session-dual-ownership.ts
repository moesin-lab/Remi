#!/usr/bin/env bun
/** Real React components in Vite/Chromium, with an isolated HTTP fixture.
 * Run: bun run tests/integration/smoke-session-dual-ownership.ts
 * NODE_EXECUTABLE and CHROME_EXECUTABLE may select compatible local runtimes.
 * No model, user browser, host API, database or deployment is accessed.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.argv.includes("--help")) {
  console.log("Usage: bun run tests/integration/smoke-session-dual-ownership.ts\nOptional: NODE_EXECUTABLE, CHROME_EXECUTABLE. No provider credentials required.");
  process.exit(0);
}
assert.equal(process.argv.length, 2, "Unexpected arguments");
const repo = resolve(import.meta.dir, "../..");
const artifacts = mkdtempSync(join(tmpdir(), "remi-session-ownership-smoke-"));
const child = spawn(process.env.NODE_EXECUTABLE ?? "node", [join(repo, "tests/integration/session-dual-ownership-browser.mjs")], {
  cwd: repo, stdio: ["pipe", "inherit", "inherit"], windowsHide: true,
});
child.stdin.end(JSON.stringify({ repo, artifacts }));
const code = await new Promise<number | null>((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
console.log("Acceptance artifacts: " + artifacts);
process.exit(code === 0 ? 0 : 1);
