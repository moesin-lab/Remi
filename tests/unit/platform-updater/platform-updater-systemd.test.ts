import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { SystemdReleaseDriver } from "@remi-platform/updater/systemd-release-driver.js";
import { DATA_SCHEMA_INPUTS, migrationFingerprint, readMigrationSource } from "@remi-platform/updater/safety.js";
import type { MultiremiPlatformOperation } from "@multiremi/contracts";
import { READY_GATE, safetyCommand, testBackup } from "./helpers.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("systemd release recovery", () => {
  it.skipIf(process.platform !== "linux")("backs up before activation, restores the old symlink on restart failure, and replays verification without a second restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "systemd-recovery-")); roots.push(root);
    const oldPath = join(root, "releases", "v1.0.0-old");
    const nextPath = join(root, "releases", "v1.0.1-next");
    const source = DATA_SCHEMA_INPUTS.map((path) => `// ${path}\n`).join("");
    const releases = [oldPath, nextPath].map((path, index) => {
      for (const input of DATA_SCHEMA_INPUTS) { mkdirSync(dirname(join(path, input)), { recursive: true }); writeFileSync(join(path, input), `// ${input}\n`); }
      const release = { version: `1.0.${index}`, ref: index ? "next" : "old", dataSchema: migrationFingerprint(source), publishedAt: null, releaseUrl: null, manifestUrl: null, apiImage: null, webImage: null };
      writeFileSync(join(path, ".platform-release.json"), JSON.stringify(release));
      return release;
    });
    symlinkSync(oldPath, join(root, "current"));
    const events: string[] = [];
    let fail = true;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("healthy") });
    const driver = new SystemdReleaseDriver({ root, backup: testBackup(root), apiService: "qa-api", webService: "qa-web", apiHealthUrl: server.url.href, webHealthUrl: server.url.href, bunExecutable: "bun" }, {
      async run(command, args, options) {
        events.push([command, ...args].join(" "));
        if (command === "bun") return { exitCode: 0, stdout: "1.3.14", stderr: "" };
        if (args[0] === "restart" && fail) { fail = false; return { exitCode: 1, stdout: "", stderr: "restart failed" }; }
        return safetyCommand(command, args, options) ?? { exitCode: 0, stdout: "active", stderr: "" };
      },
    });
    const operation = { id: "pop_systemd", kind: "rollback", status: "preparing", driver: "systemd_release", targetVersion: "1.0.1", targetRef: "next", targetManifest: {}, progress: {}, cancelRequested: false, requestedBy: "local", output: null, error: null, previousRelease: null, resultRelease: null, createdAt: "", updatedAt: "", startedAt: null, finishedAt: null } satisfies MultiremiPlatformOperation;
    try {
      await expect(driver.execute(operation, async (input) => { events.push(input.status); }, READY_GATE)).rejects.toThrow("restart failed");
      expect(readlinkSync(join(root, "current"))).toBe(oldPath);
      expect(events.indexOf("test-verify")).toBeLessThan(events.indexOf("switching"));
      expect(readFileSync(join(root, "persistent", "user-data.txt"), "utf8")).toBe("preserve all user data");
      const retry = { ...operation, id: "pop_systemd_retry" };
      expect(await driver.execute(retry, async () => {}, READY_GATE)).toEqual(releases[1]);
      expect(readlinkSync(join(root, "current"))).toBe(nextPath);
      const before = events.length;
      expect(await driver.execute({ ...retry, status: "switching" }, async () => {}, READY_GATE)).toEqual(releases[1]);
      expect(events).toHaveLength(before);
      writeFileSync(join(root, "operation-pop_systemd_retry.json"), JSON.stringify({ phase: "committed", previousPath: oldPath, previous: releases[0] }));
      await driver.recoverInterrupted();
      expect(readlinkSync(join(root, "current"))).toBe(oldPath);
      await expect(driver.execute({ ...retry, status: "verifying" }, async () => {}, READY_GATE)).rejects.toThrow("recovered");
    } finally { server.stop(true); }
  });

  it("uses the same fingerprint as release publication and includes data-transform dependencies", async () => {
    const source = await readMigrationSource(process.cwd());
    const result = Bun.spawnSync([process.execPath, "scripts/platform-data-schema.mjs"], { stdout: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(migrationFingerprint(source));
    expect(DATA_SCHEMA_INPUTS).toContain("packages/server/src/store/daemon-routing.ts");
    expect(DATA_SCHEMA_INPUTS).toContain("packages/shared/src/db/index.ts");
  });
});
