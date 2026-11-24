import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DockerComposeDriver } from "@remi-platform/updater/compose-driver.js";
import { SystemdReleaseDriver } from "@remi-platform/updater/systemd-release-driver.js";
import { DEFAULT_PLATFORM_HEALTH_TIMEOUT_MS, resolveHealthTimeoutMs, waitForHealthyUrl } from "../../../packages/platform-updater/src/health-check.js";
import type { MultiremiPlatformOperation } from "@multiremi/contracts";
import type { CommandRunner } from "@remi-platform/updater/types.js";
import { DATA_SCHEMA_INPUTS, migrationFingerprint } from "@remi-platform/updater/safety.js";
import { DATA_SCHEMA, READY_GATE, safetyCommand, testBackup } from "./helpers.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function operation(kind: "restart" | "update" = "restart"): MultiremiPlatformOperation {
  return { id: "health-test", kind, status: "preparing", driver: "docker_compose", targetVersion: "1.2.3", targetRef: "new", targetManifest: {
    dataSchema: DATA_SCHEMA, version: "1.2.3", ref: "new", apiImage: `ghcr.io/test/api@sha256:${"a".repeat(64)}`, webImage: `ghcr.io/test/web@sha256:${"b".repeat(64)}`,
  }, progress: {}, requestedBy: "tester", output: null, error: null, previousRelease: null, resultRelease: null,
    cancelRequested: false, createdAt: "", updatedAt: "", startedAt: null, finishedAt: null };
}

function drivers(timeoutMs?: number) {
  const root = mkdtempSync(join(tmpdir(), "platform-health-")); roots.push(root);
  const envFile = join(root, "platform.env"); writeFileSync(envFile, "ORIGINAL=1\n");
  writeFileSync(join(root, "current-release.json"), JSON.stringify({ dataSchema: DATA_SCHEMA, version: "1.2.2", ref: "old",
    apiImage: `ghcr.io/test/api@sha256:${"c".repeat(64)}`, webImage: `ghcr.io/test/web@sha256:${"d".repeat(64)}` }));
  const backup = testBackup(root);
  const commands: string[] = [];
  const runner: CommandRunner = { async run(command, args, options) {
    commands.push([command, ...args].join(" "));
    // Isolate URL deadline/rollback behavior from the API startup budget tests.
    if (args.includes("config")) return { exitCode: 0, stdout: '{"name":"test-project","services":{"api":{"environment":{"MULTIREMI_USAGE_MIGRATION_TIMEOUT_MS":"1"}},"web":{}}}', stderr: "" };
    if (command === process.execPath && args[0] === "--version") return { exitCode: 0, stdout: "1.3.14", stderr: "" };
    return safetyCommand(command, args, options) ?? { exitCode: 0, stdout: "", stderr: "" };
  } };
  return {
    commands, envFile, root,
    compose: new DockerComposeDriver({ backup, composeFile: join(root, "compose.yml"), envFile, stateDir: root,
      apiHealthUrl: "http://health.test/api", webHealthUrl: "http://health.test/web", extraHealthUrls: ["http://health.test/runtime"], healthTimeoutMs: timeoutMs }, runner),
    systemd: new SystemdReleaseDriver({ backup, root, apiService: "api", webService: "web", bunExecutable: process.execPath,
      apiHealthUrl: "http://health.test/api", webHealthUrl: "http://health.test/web", healthTimeoutMs: timeoutMs }, runner),
  };
}

describe("platform health deadline", () => {
  it("allows readiness after both the old 60s window and the 300s migration budget", async () => {
    let clock = 0, probes = 0;
    await waitForHealthyUrl("http://health.test/api", DEFAULT_PLATFORM_HEALTH_TIMEOUT_MS, {
      now: () => clock, sleep: async ms => { clock += ms; },
      request: async () => { probes++; return new Response(null, { status: clock >= 310_000 ? 200 : 503 }); },
    });
    expect(clock).toBe(310_000);
    expect(probes).toBe(125);
  });

  it("counts slow failed requests against the deadline and never sleeps past it", async () => {
    let clock = 0, probes = 0;
    await expect(waitForHealthyUrl("http://health.test/api", 20_000, {
      now: () => clock, sleep: async ms => { clock += ms; },
      request: async (_url, options) => { expect(options.signal).toBeInstanceOf(AbortSignal); probes++; clock += 5_000; throw new Error("connection refused"); },
    })).rejects.toThrow("within 20000ms: connection refused");
    expect(clock).toBe(20_000);
    expect(probes).toBe(3);
  });

  it("fails persistent HTTP errors at the finite default deadline", async () => {
    let clock = 0;
    await expect(waitForHealthyUrl("http://health.test/api", DEFAULT_PLATFORM_HEALTH_TIMEOUT_MS, {
      now: () => clock, sleep: async ms => { clock += ms; }, request: async () => new Response(null, { status: 503 }),
    })).rejects.toThrow("within 360000ms: returned 503");
    expect(clock).toBe(360_000);
  });

  it("caps the last request and rejects success that arrives after the deadline", async () => {
    let clock = 0;
    const originalTimeout = AbortSignal.timeout;
    const budgets: number[] = [];
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation(ms => { budgets.push(ms); return originalTimeout(ms); });
    try {
      await expect(waitForHealthyUrl("http://health.test/api", 3_000, {
        now: () => clock, request: async () => { clock = 3_001; return new Response(null, { status: 200 }); },
      })).rejects.toThrow("readiness arrived after deadline");
      expect(budgets).toEqual([3_000]);
    } finally { timeout.mockRestore(); }
  });

  it("rejects invalid budgets before any deployment command", () => {
    expect(resolveHealthTimeoutMs(undefined)).toBe(360_000);
    for (const value of ["", "0", "-1", "1.5", "bad", Infinity]) expect(() => resolveHealthTimeoutMs(value)).toThrow("positive integer");
    expect(() => drivers(0)).toThrow("positive integer");
  });

  for (const kind of ["compose", "systemd"] as const) {
    it.skipIf(kind === "systemd" && process.platform !== "linux")(`${kind} keeps waiting past 60s through a drain-protected restart`, async () => {
      let clock = 0;
      const hits = new Set<string>();
      const time = spyOn(performance, "now").mockImplementation(() => clock);
      const sleep = spyOn(Bun, "sleep").mockImplementation(async ms => { clock += Number(ms); return; });
      const request = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0]) => {
        hits.add(String(input)); return new Response(null, { status: clock >= 80_000 ? 200 : 503 });
      }, { preconnect: () => {} }));
      try {
        const bed = drivers();
        if (kind === "systemd") {
          const releasePath = join(bed.root, "releases", "old");
          const source = DATA_SCHEMA_INPUTS.map(path => `// ${path}\n`).join("");
          for (const input of DATA_SCHEMA_INPUTS) {
            mkdirSync(dirname(join(releasePath, input)), { recursive: true });
            writeFileSync(join(releasePath, input), `// ${input}\n`);
          }
          writeFileSync(join(releasePath, ".platform-release.json"), JSON.stringify({ dataSchema: migrationFingerprint(source), version: "1.2.2", ref: "old" }));
          symlinkSync(releasePath, join(bed.root, "current"));
        }
        await bed[kind].execute({ ...operation(), driver: bed[kind].kind }, async () => {}, READY_GATE);
        expect(clock).toBeGreaterThanOrEqual(80_000);
        expect([...hits].sort()).toEqual(kind === "compose"
          ? ["http://health.test/api", "http://health.test/runtime", "http://health.test/web"]
          : ["http://health.test/api", "http://health.test/web"]);
      } finally { request.mockRestore(); sleep.mockRestore(); time.mockRestore(); }
    });
  }

  it("Compose still restores the old images and env when target readiness never succeeds", async () => {
    let clock = 0;
    const time = spyOn(performance, "now").mockImplementation(() => clock);
    const sleep = spyOn(Bun, "sleep").mockImplementation(async ms => { clock += Number(ms); return; });
    const bed = drivers(70_000);
    const request = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(null, {
      status: bed.commands.filter(command => command.includes("up -d --no-deps")).length >= 2 ? 200 : 503,
    }), { preconnect: () => {} }));
    try {
      const originalEnv = `ORIGINAL=1\nREMI_API_IMAGE=ghcr.io/test/api@sha256:${"c".repeat(64)}\nREMI_WEB_IMAGE=ghcr.io/test/web@sha256:${"d".repeat(64)}\n`;
      writeFileSync(bed.envFile, originalEnv);
      await expect(bed.compose.execute(operation("update"), async () => {}, READY_GATE)).rejects.toThrow("within 70000ms");
      expect(readFileSync(bed.envFile, "utf8")).toBe(originalEnv);
      expect(bed.commands.filter(command => command.includes("up -d --no-deps")).length).toBe(2);
      expect(JSON.parse(readFileSync(join(bed.root, "current-release.json"), "utf8")).ref).toBe("old");
      expect(JSON.parse(readFileSync(join(bed.root, "operation-health-test.json"), "utf8")).phase).toBe("rolled_back");
    } finally { request.mockRestore(); sleep.mockRestore(); time.mockRestore(); }
  });
});
