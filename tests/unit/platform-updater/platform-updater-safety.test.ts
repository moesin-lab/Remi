import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackup, checkBackup, RecoveryRequiredError } from "@remi-platform/updater/safety.js";
import { BunCommandRunner, type CommandRunner } from "@remi-platform/updater/types.js";
import { DockerComposeDriver } from "@remi-platform/updater/compose-driver.js";
import { PlatformDrainCoordinator } from "@remi-platform/updater/drain.js";
import type { PlatformUpdaterClient } from "@remi-platform/updater/client.js";
import type { MultiremiPlatformOperation } from "@multiremi/contracts";
import { DATA_SCHEMA, READY_GATE, safetyCommand, testBackup } from "./helpers.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const value = mkdtempSync(join(tmpdir(), "platform-safety-")); roots.push(value); return value; }
const oldApi = `ghcr.io/test/api@sha256:${"1".repeat(64)}`;
const oldWeb = `ghcr.io/test/web@sha256:${"2".repeat(64)}`;
const api = `mirror.example:5000/team/api@sha256:${"3".repeat(64)}`;
const web = `mirror.example:5000/team/web@sha256:${"4".repeat(64)}`;
function bed(fail: "pull" | "backup" | "verify_backup" | "switch" | "both_switches" | null = null) {
  const dir = root();
  const envFile = join(dir, "platform.env");
  const original = `# retained exactly\nREMI_API_IMAGE=${oldApi}\nREMI_WEB_IMAGE=${oldWeb}\n`;
  writeFileSync(envFile, original);
  const previous = { version: "1.0.0", ref: "old", dataSchema: DATA_SCHEMA, apiImage: oldApi, webImage: oldWeb };
  writeFileSync(join(dir, "current-release.json"), JSON.stringify(previous));
  const commands: string[][] = [];
  let switches = 0;
  const runner: CommandRunner = { async run(command, args, options) {
    commands.push([command, ...args]);
    if ((fail === "pull" && args.includes("pull")) || (fail === "backup" && command === "test-dump") || (fail === "verify_backup" && command === "test-verify")) return { exitCode: 1, stdout: "", stderr: "failure" };
    if (args.includes("up")) {
      switches++;
      if (fail === "both_switches" || (fail === "switch" && switches === 1)) return { exitCode: 1, stdout: "", stderr: "switch failure" };
    }
    return safetyCommand(command, args, options) ?? { exitCode: 0, stdout: "", stderr: "" };
  } };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("healthy") });
  const config = { envFile, composeFile: join(dir, "compose.yaml"), stateDir: dir, backup: testBackup(dir), apiHealthUrl: server.url.href, webHealthUrl: server.url.href };
  const driver = new DockerComposeDriver(config, runner);
  const operation: MultiremiPlatformOperation = {
    id: "pop_safety", kind: "update", status: "preparing", driver: "docker_compose", targetVersion: "1.0.1", targetRef: "https://mirror.example/feed",
    targetManifest: { version: "1.0.1", ref: "next", apiImage: api, webImage: web, dataSchema: DATA_SCHEMA },
    progress: {}, cancelRequested: false, requestedBy: "local", output: null, error: null, previousRelease: null, resultRelease: null,
    createdAt: "", updatedAt: "", startedAt: null, finishedAt: null,
  };
  return { dir, original, envFile, previous, commands, config, driver, operation, runner, stop: () => server.stop(true) };
}

describe("platform backup and safe failure", () => {
  it.each(["pull", "backup", "verify_backup"] as const)("does not restart any service after %s failure and preserves exact configuration and data", async (fail) => {
    const test = bed(fail);
    try {
      await expect(test.driver.execute(test.operation, async () => {}, READY_GATE)).rejects.toThrow();
      expect(test.commands.some((args) => args.includes("up") || args.includes("restart"))).toBe(false);
      expect(readFileSync(test.envFile, "utf8")).toBe(test.original);
      expect(readFileSync(join(test.dir, "persistent", "user-data.txt"), "utf8")).toBe("preserve all user data");
    } finally { test.stop(); }
  });

  it("rejects schema changes, missing backup configuration, and a missing drain before any switch", async () => {
    const test = bed();
    try {
      await expect(test.driver.execute({ ...test.operation, targetManifest: { ...test.operation.targetManifest, dataSchema: "b".repeat(64) } }, async () => {}, READY_GATE)).rejects.toThrow("schema");
      await expect(test.driver.execute(test.operation, async () => {})).rejects.toThrow("drain");
      delete (test.config as { backup?: unknown }).backup;
      await expect(test.driver.execute(test.operation, async () => {}, READY_GATE)).rejects.toThrow("database dump");
      expect(test.commands.some((args) => args.includes("up"))).toBe(false);
    } finally { test.stop(); }
  });

  it("rechecks the lease after backup and does not switch if it was lost", async () => {
    const test = bed();
    try {
      await expect(test.driver.execute(test.operation, async () => {}, { ...READY_GATE, assertReady: async () => { throw new Error("lease lost"); } })).rejects.toThrow("lease lost");
      expect(test.commands.some((args) => args.includes("up"))).toBe(false);
      expect(readdirSync(test.config.backup.directory)).toHaveLength(1);
    } finally { test.stop(); }
  });

  it("retains a failed-switch journal and recovers it without re-fetching the target or restoring the database", async () => {
    const test = bed("both_switches");
    try {
      await expect(test.driver.execute(test.operation, async () => {}, READY_GATE)).rejects.toThrow(RecoveryRequiredError);
      expect(JSON.parse(readFileSync(join(test.dir, "operation-pop_safety.json"), "utf8")).previous.ref).toBe("old");
      const recoveredCommands: string[][] = [];
      const recovering = new DockerComposeDriver(test.config, { async run(command, args, options) { recoveredCommands.push([command, ...args]); return safetyCommand(command, args, options) ?? { exitCode: 0, stdout: "", stderr: "" }; } });
      // Startup recovery needs only local journal/config and health probes, not
      // an operation claim from the API that the broken image may have stopped.
      await recovering.recoverInterrupted();
      await expect(recovering.execute({ ...test.operation, status: "verifying", targetManifest: {} }, async () => {}, READY_GATE)).rejects.toThrow("recovered");
      expect(recoveredCommands.filter((args) => args.includes("up"))).toHaveLength(1);
      expect(recoveredCommands.some((args) => args.includes("pg_restore") || args.includes("test-dump") || args.includes("pull") && !args.includes("never"))).toBe(false);
      expect(readFileSync(test.envFile, "utf8")).toBe(test.original);
    } finally { test.stop(); }
  });

  it("replays a verified result after a lost terminal report without restarting services again", async () => {
    const test = bed();
    try {
      const result = await test.driver.execute(test.operation, async () => {}, READY_GATE);
      const before = test.commands.length;
      const resumed = await test.driver.execute({ ...test.operation, status: "switching", targetManifest: {} }, async () => {}, READY_GATE);
      expect(resumed).toEqual(result);
      expect(test.commands.length).toBe(before);
      expect(test.commands.filter((args) => args.includes("up")).every((args) => !args.includes("ssh-mesh-control-plane") && !args.includes("postgres"))).toBe(true);
      const cleanup = test.commands.find((args) => args[1] === "ps");
      expect(cleanup).toContain("label=com.docker.compose.project=test-project");
    } finally { test.stop(); }
  });

  it("never recreates services for a journal prepared before the switch was committed", async () => {
    const test = bed();
    try {
      writeFileSync(join(test.dir, "operation-pop_safety.json"), JSON.stringify({ previous: test.previous, originalEnv: test.original }));
      await test.driver.recoverInterrupted();
      expect(test.commands).toHaveLength(0);
      await expect(test.driver.execute({ ...test.operation, status: "backing_up" }, async () => {}, READY_GATE)).rejects.toThrow("before commit");
      expect(test.commands).toHaveLength(0);
      expect(readFileSync(test.envFile, "utf8")).toBe(test.original);
    } finally { test.stop(); }
  });

  it.each(["{broken", "null", JSON.stringify({ phase: "verified" })])("keeps maintenance pinned for an unreadable or incomplete recovery journal: %s", async (source) => {
    const test = bed();
    try {
      writeFileSync(join(test.dir, "operation-pop_safety.json"), source);
      await expect(test.driver.execute({ ...test.operation, status: "verifying" }, async () => {}, READY_GATE)).rejects.toThrow(RecoveryRequiredError);
      expect(test.commands).toHaveLength(0);
    } finally { test.stop(); }
  });

  it("requires a verified backup before a restart too", async () => {
    const test = bed("verify_backup");
    try {
      await expect(test.driver.execute({ ...test.operation, kind: "restart" }, async () => {}, READY_GATE)).rejects.toThrow("restore verification");
      expect(test.commands.some((args) => args.includes("restart"))).toBe(false);
    } finally { test.stop(); }
  });

  it("backs up binary output with real child processes, validates it and preserves files", async () => {
    const dir = root();
    const config = testBackup(dir);
    const bytes = Buffer.from([0, 10, 13, 128, 255]);
    config.databaseDumpCommand = [process.execPath, "-e", "process.stdout.write(Buffer.from([0,10,13,128,255]))"];
    config.databaseVerifyCommand = [process.execPath, "-e", "const b=Buffer.from(await Bun.stdin.arrayBuffer()); if (!b.equals(Buffer.from([0,10,13,128,255]))) process.exit(1)"];
    const backup = await createBackup(config, new BunCommandRunner(), "pop_binary");
    expect(readFileSync(join(backup, "database.dump"))).toEqual(bytes);
    const manifest = JSON.parse(readFileSync(join(backup, "complete.json"), "utf8"));
    expect(manifest.files).toHaveLength(2);
    expect(manifest.files.every((file: { sha256: string }) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    expect(readFileSync(join(backup, "state-0", "user-data.txt"), "utf8")).toBe("preserve all user data");
    await expect(checkBackup({ ...config, directory: config.dataPaths[0]! })).rejects.toThrow("overlap");
  }, 30_000);

  it("keeps renewing the drain during a long backup and rechecks cancellation before switching", async () => {
    let renewals = 0;
    let cancelled = false;
    const client = {
      drainBegin: async () => {}, drainRelease: async () => {},
      drainRenew: async () => { renewals++; return { maintenance: { operationId: "pop_keepalive" }, status: { ready: true }, cancel_requested: cancelled }; },
    } as unknown as PlatformUpdaterClient;
    const gate = new PlatformDrainCoordinator(client, "pop_keepalive", { pollMs: 10 });
    try {
      await gate.waitUntilDrained(async () => {});
      await Bun.sleep(60);
      expect(renewals).toBeGreaterThan(1);
      cancelled = true;
      await expect(gate.assertReady()).rejects.toThrow("cancelled");
    } finally { await gate.release(); }
  });
});
