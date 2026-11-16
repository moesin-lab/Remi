import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test("installer shell fixtures preserve stable launchers and failure recovery", () => {
  const result = spawnSync("node", ["--test", "scripts/install-remi.test.mjs"], {
    cwd: resolve(import.meta.dir, "../../.."), encoding: "utf8", timeout: 20_000,
  });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  expect(result.status).toBe(0);
}, 25_000);
