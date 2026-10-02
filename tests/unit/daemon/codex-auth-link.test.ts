import { afterEach, expect, it } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkCodexAuthFromBase } from "../../../packages/daemon/src/agent-runtime/agent-plugins/codex-home.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "remi-auth-link-")); roots.push(root);
  const base = join(root, "base"), target = join(root, "target");
  await mkdir(base); await mkdir(target);
  await writeFile(join(base, "auth.json"), "test-credential", { mode: 0o600 });
  return { base, target };
}
it("shares credential writes and accepts repeated reconciliation", async () => {
  const { base, target } = await fixture();
  await linkCodexAuthFromBase(base, target);
  await linkCodexAuthFromBase(base, target);
  await writeFile(join(base, "auth.json"), "refreshed");
  expect(await readFile(join(target, "auth.json"), "utf8")).toBe("refreshed");
  const info = await lstat(join(target, "auth.json"));
  expect(info.isSymbolicLink() || (process.platform === "win32" && info.nlink > 1)).toBe(true);
});
it("does not overwrite an unrelated credential target", async () => {
  const { base, target } = await fixture();
  await writeFile(join(target, "auth.json"), "unrelated");
  await expect(linkCodexAuthFromBase(base, target)).rejects.toThrow("not a managed link");
  expect(await readFile(join(target, "auth.json"), "utf8")).toBe("unrelated");
});
it("rejects a directory as the credential source", async () => {
  const { base, target } = await fixture();
  await rm(join(base, "auth.json")); await mkdir(join(base, "auth.json"));
  await expect(linkCodexAuthFromBase(base, target)).rejects.toThrow("private regular file");
});
it.skipIf(process.platform === "win32")("still rejects broad POSIX credential permissions", async () => {
  const { base, target } = await fixture();
  await chmod(join(base, "auth.json"), 0o644);
  await expect(linkCodexAuthFromBase(base, target)).rejects.toThrow("private regular file");
});
