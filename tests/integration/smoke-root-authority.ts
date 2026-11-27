#!/usr/bin/env bun
/** Real React components in Vite + headless Playwright browser with an isolated HTTP fixture.
 * Run: bun run tests/integration/smoke-root-authority.ts
 * Optional env: NODE_EXECUTABLE, CHROME_EXECUTABLE, FIREFOX_EXECUTABLE.
 * No live server, fixed port, online database, real root grant, or provider credentials are accessed.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.argv.includes("--help")) {
  console.log(
    "Usage: bun run tests/integration/smoke-root-authority.ts\n"
      + "Optional: NODE_EXECUTABLE, CHROME_EXECUTABLE, FIREFOX_EXECUTABLE.",
  );
  process.exit(0);
}
assert.equal(process.argv.length, 2, "Unexpected arguments");

const repo = resolve(import.meta.dir, "../..");
const artifacts = mkdtempSync(join(tmpdir(), "remi-root-authority-smoke-"));
const child = spawn(
  process.env.NODE_EXECUTABLE ?? "node",
  [join(repo, "tests/integration/root-authority-browser.mjs")],
  {
    cwd: repo,
    stdio: ["pipe", "inherit", "inherit"],
    windowsHide: true,
  },
);
child.stdin.end(JSON.stringify({ repo, artifacts }));

const code = await new Promise<number | null>((resolveExit, reject) => {
  child.once("error", reject);
  child.once("close", resolveExit);
});
console.log("Acceptance artifacts: " + artifacts);
process.exit(code === 0 ? 0 : 1);
