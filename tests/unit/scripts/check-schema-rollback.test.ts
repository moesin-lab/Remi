import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schemaLevelFingerprint } from "../../../packages/platform-updater/src/schema-fingerprint.mjs";
import {
  KNOWN_REWRITTEN_RELEASE_REFS,
  verifyPreviousReleaseCheckout,
  verifyPreviousReleaseRef,
} from "../../../scripts/schema-rollback-identity.js";

const V0_2_95_PUBLISHED_REF = "b45ce8e764a83a755ec288f4ab404095ff4915eb";
const V0_2_95_REWRITTEN_REF = "7f81fbf4e6c6c0430f43864720bc4cfe53ed653e";
const V0_2_95_DATA_SCHEMA = "ed09709b5a12212f94c2916203c5641b990cc019e695056ec0063b3bd093bb74";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createReleaseCheckout(version: string, expandLevel = 3): { root: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "remi-schema-rollback-test-"));
  roots.push(root);
  mkdirSync(join(root, "packages/server/src/store"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "remi", version }, null, 2) + "\n");
  writeFileSync(
    join(root, "packages/server/src/store/schema-compatibility.json"),
    JSON.stringify({ format: 1, expandLevel, contractLevel: 0, minLevel: expandLevel, maxLevel: expandLevel }, null, 2) + "\n",
  );
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", `release v${version}`);
  git("tag", `v${version}`);
  return { root, head: git("rev-parse", "HEAD") };
}

test("normal release checkout passes when HEAD, tag, package version and schema fingerprint match", async () => {
  const { root, head } = createReleaseCheckout("0.2.96", 3);
  const dataSchema = await schemaLevelFingerprint(root);
  const result = await verifyPreviousReleaseCheckout(root, { version: "0.2.96", ref: head, dataSchema });
  expect(result).toEqual({ expectedRef: head, rewritten: false, dataSchema });
});

test("known rewritten v0.2.95 release passes only when exact rewritten pair and dataSchema match", async () => {
  expect(KNOWN_REWRITTEN_RELEASE_REFS).toEqual([
    { version: "0.2.95", publishedRef: V0_2_95_PUBLISHED_REF, rewrittenRef: V0_2_95_REWRITTEN_REF },
  ]);
  const { root } = createReleaseCheckout("0.2.95", 3);
  expect(await schemaLevelFingerprint(root)).toBe(V0_2_95_DATA_SCHEMA);
  const stubGit = (_cwd: string, ...args: string[]) => {
    if (args[0] === "rev-parse" && (args[1] === "HEAD" || args[1] === "v0.2.95^{commit}")) {
      return V0_2_95_REWRITTEN_REF;
    }
    throw new Error(`Unexpected git args: ${args.join(" ")}`);
  };

  const result = await verifyPreviousReleaseCheckout(
    root,
    { version: "0.2.95", ref: V0_2_95_PUBLISHED_REF, dataSchema: V0_2_95_DATA_SCHEMA },
    { git: stubGit },
  );
  expect(result).toEqual({ expectedRef: V0_2_95_REWRITTEN_REF, rewritten: true, dataSchema: V0_2_95_DATA_SCHEMA });
});

test("known rewritten v0.2.95 release fails closed when checked-out schemaLevelFingerprint disagrees", async () => {
  const { root } = createReleaseCheckout("0.2.95", 4);
  const stubGit = (_cwd: string, ...args: string[]) => {
    if (args[0] === "rev-parse" && (args[1] === "HEAD" || args[1] === "v0.2.95^{commit}")) {
      return V0_2_95_REWRITTEN_REF;
    }
    throw new Error(`Unexpected git args: ${args.join(" ")}`);
  };

  await expect(
    verifyPreviousReleaseCheckout(
      root,
      { version: "0.2.95", ref: V0_2_95_PUBLISHED_REF, dataSchema: V0_2_95_DATA_SCHEMA },
      { git: stubGit },
    ),
  ).rejects.toThrow();
});

test("unknown ref mismatches, partial tag/HEAD mismatches and dataSchema mismatches are strictly rejected", async () => {
  const otherRef = "1".repeat(40);
  const otherSchema = "2".repeat(64);

  // Unknown version using the same rewritten SHA pair must fail.
  expect(() =>
    verifyPreviousReleaseRef({ version: "0.2.96", ref: V0_2_95_PUBLISHED_REF }, V0_2_95_REWRITTEN_REF, V0_2_95_REWRITTEN_REF),
  ).toThrow();
  // Unknown published ref for v0.2.95 must fail.
  expect(() =>
    verifyPreviousReleaseRef({ version: "0.2.95", ref: otherRef }, V0_2_95_REWRITTEN_REF, V0_2_95_REWRITTEN_REF),
  ).toThrow();
  // HEAD matches rewritten ref, but tag does not.
  expect(() =>
    verifyPreviousReleaseRef({ version: "0.2.95", ref: V0_2_95_PUBLISHED_REF }, V0_2_95_REWRITTEN_REF, otherRef),
  ).toThrow();
  // Tag matches rewritten ref, but HEAD does not.
  expect(() =>
    verifyPreviousReleaseRef({ version: "0.2.95", ref: V0_2_95_PUBLISHED_REF }, otherRef, V0_2_95_REWRITTEN_REF),
  ).toThrow();
  // Arbitrary mismatch on a normal release.
  expect(() =>
    verifyPreviousReleaseRef({ version: "0.2.96", ref: otherRef }, "3".repeat(40), "3".repeat(40)),
  ).toThrow();

  // Normal ref match still rejects mismatched dataSchema, dirty worktree, and package version mismatch.
  const { root, head } = createReleaseCheckout("0.2.96", 3);
  await expect(
    verifyPreviousReleaseCheckout(root, { version: "0.2.96", ref: head, dataSchema: otherSchema }),
  ).rejects.toThrow();
  await expect(
    verifyPreviousReleaseCheckout(root, { version: "0.2.96", ref: otherRef, dataSchema: await schemaLevelFingerprint(root) }),
  ).rejects.toThrow();
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "remi", version: "0.2.99" }, null, 2) + "\n");
  await expect(
    verifyPreviousReleaseCheckout(root, { version: "0.2.96", ref: head, dataSchema: await schemaLevelFingerprint(root) }),
  ).rejects.toThrow();
});
