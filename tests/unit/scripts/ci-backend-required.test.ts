import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { backendRequired } from "../../../scripts/ci-backend-required.js";

test("PR backend inputs require all shards even alongside frontend/docs", () => {
  for (const path of ["packages/server/a.ts", "packages/daemon/a.ts", "packages/shared/a.ts",
    "packages/contracts/a.ts", "packages/acp/a.ts", "apps/remi/main.ts", "tests/a.test.ts",
    "scripts/ci-backend.ts", "bun.lock", "package.json", "bunfig.toml", "tsconfig.json",
    ".github/workflows/release-build-check.yml", "deploy/docker/Dockerfile.api"]) {
    expect(backendRequired("pull_request", ["docs/a.md", "frontend/page.tsx", path])).toBe(true);
  }
});

test("pure frontend/docs PRs skip backend, missing diff and other events fail closed", () => {
  expect(backendRequired("pull_request", ["README.md", "docs/test.md", "frontend/packages/core/replica/store.ts"])).toBe(false);
  expect(backendRequired("pull_request", [])).toBe(false);
  expect(backendRequired("pull_request", null)).toBe(true);
  for (const event of ["push", "workflow_dispatch", ""]) expect(backendRequired(event, [])).toBe(true);
});

test("real git detector catches backend files renamed into frontend and fails closed on missing base", () => {
  const root = mkdtempSync(join(tmpdir(), "backend-scope-"));
  const script = resolve(import.meta.dir, "../../../scripts/ci-backend-required.ts");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const detect = (base: string, head: string) => execFileSync(process.execPath, [script], {
    cwd: root, encoding: "utf8", env: { ...process.env, EVENT_NAME: "pull_request", BASE_SHA: base, HEAD_SHA: head }, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  try {
    git("init", "-q");
    git("config", "user.email", "ci@example.test"); git("config", "user.name", "CI test");
    mkdirSync(join(root, "packages")); mkdirSync(join(root, "frontend"));
    writeFileSync(join(root, "packages", "service.ts"), "export const service = true;\n");
    git("add", "."); git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(root, "frontend", "page.ts"), "// frontend\n");
    git("add", "."); git("commit", "-qm", "frontend only");
    expect(detect(base, git("rev-parse", "HEAD"))).toBe("required=false");
    git("mv", "packages/service.ts", "frontend/service.ts"); git("commit", "-qm", "move backend out");
    expect(detect(base, git("rev-parse", "HEAD"))).toBe("required=true");
    expect(detect("missing-base", "HEAD")).toBe("required=true");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
