import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MultiremiPlatformOperation, ReportPlatformOperationInput } from "@multiremi/contracts";
import { LocalProfileDriver } from "@remi-platform/updater/local-profile-driver.js";
import type { PlatformDrainGate } from "@remi-platform/updater/drain.js";
import type { CommandRunner } from "@remi-platform/updater/types.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local profile platform driver", () => {
  it("stages a checksum-pinned commit before drain and delegates the switch to the host journal", async () => {
    const fixture = createFixture();
    const events: string[] = [];
    const runner = fixture.runner(events);
    const driver = fixture.driver(runner);
    const reports: ReportPlatformOperationInput[] = [];
    const drain: PlatformDrainGate = {
      async waitUntilDrained() { events.push("drain"); },
      async release() {},
    };

    const result = await driver.execute(operation(), async (report) => { reports.push(report); }, drain);

    expect(events).toEqual(["host-stage", "drain", "host-activate"]);
    expect(reports.map((report) => report.status)).toEqual(["pulling", "switching"]);
    expect(result?.ref).toBe(NEW_REF);
  });

  it("runs crash recovery before inspection can reconnect to the API", async () => {
    const fixture = createFixture();
    const events: string[] = [];
    const driver = fixture.driver(fixture.runner(events));

    const inspection = await driver.inspect();

    expect(events[0]).toBe("host-recover");
    expect(inspection.driver).toBe("local_profile");
    expect(inspection.currentRelease?.ref).toBe(OLD_REF);
  });

  it("rejects mutable refs and unchecked source artifacts before invoking the host", async () => {
    const fixture = createFixture();
    const events: string[] = [];
    const driver = fixture.driver(fixture.runner(events));
    const invalid = operation({ ref: "main", sourceSha256: "bad" });
    const drain: PlatformDrainGate = { async waitUntilDrained() {}, async release() {} };

    await expect(driver.execute(invalid, async () => {}, drain)).rejects.toThrow("full Git commit");
    expect(events).toEqual([]);

    const credentialLikeQuery = operation({ sourceUrl: "https://example.com/platform.tar.gz?token=secret" });
    await expect(driver.execute(credentialLikeQuery, async () => {}, drain)).rejects.toThrow("query");
    expect(events).toEqual([]);
  });
});

const OLD_REF = "1".repeat(40);
const NEW_REF = "2".repeat(40);

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "remi-local-profile-driver-"));
  roots.push(root);
  const repository = join(root, "repository");
  const profilesRoot = join(root, "profiles");
  const profileRoot = join(profilesRoot, "stable");
  mkdirSync(join(repository, "scripts"), { recursive: true });
  mkdirSync(join(profileRoot, "host-operations", "pop_test"), { recursive: true });
  writeFileSync(join(repository, "scripts", "local-profile.mjs"), "// fixture\n");
  writeDeployment(profileRoot, OLD_REF);

  return {
    driver(runner: CommandRunner) {
      return new LocalProfileDriver({
        repository, profilesRoot, profile: "stable", nodeExecutable: "node",
        expectedArchitecture: "x64", minimumFreeBytes: 1,
      }, runner);
    },
    runner(events: string[]): CommandRunner {
      return {
        async run(command, args) {
          if (command === "node") {
            const action = args[2]!;
            events.push(action);
            if (action === "host-stage") {
              writeFileSync(join(profileRoot, "host-operations", "pop_test", "operation.json"), JSON.stringify({
                status: "running", phase: "built",
              }));
            }
            if (action === "host-activate") {
              writeDeployment(profileRoot, NEW_REF);
              writeFileSync(join(profileRoot, "host-operations", "pop_test", "operation.json"), JSON.stringify({
                status: "succeeded", resultRelease: release(NEW_REF),
              }));
            }
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (command === "docker") return { exitCode: 0, stdout: "", stderr: "" };
          throw new Error(`unexpected command ${command}`);
        },
      };
    },
  };
}

function writeDeployment(profileRoot: string, ref: string): void {
  mkdirSync(profileRoot, { recursive: true });
  const deployment = {
    profile: "stable", ref, version: `0.2.81-stable.${ref.slice(0, 8)}`,
    apiImage: `remi-api:stable-${ref}`, webImage: `remi-web:stable-${ref}`,
  };
  writeFileSync(join(profileRoot, "active.json"), JSON.stringify(deployment));
  writeFileSync(join(profileRoot, "deployment.json"), JSON.stringify(deployment));
  writeFileSync(join(profileRoot, "compose.env"), "REMI_PROFILE='stable'\n");
  writeFileSync(join(profileRoot, "compose.yml"), "services: {}\n");
}

function operation(overrides: Record<string, unknown> = {}): MultiremiPlatformOperation {
  return {
    id: "pop_test", kind: "update", status: "preparing", driver: "local_profile",
    targetVersion: "0.2.81", targetRef: "https://example.com/platform-release.json",
    targetManifest: {
      version: "0.2.81", ref: NEW_REF,
      sourceUrl: "https://example.com/platform.tar.gz", sourceSha256: "a".repeat(64),
      ...overrides,
    },
    progress: {}, requestedBy: "local", output: null, error: null,
    previousRelease: null, resultRelease: null, cancelRequested: false,
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    startedAt: new Date(0).toISOString(), finishedAt: null,
  };
}

function release(ref: string) {
  return {
    version: "0.2.81", ref, publishedAt: null, releaseUrl: null, manifestUrl: null,
    apiImage: `remi-api:stable-${ref}`, webImage: `remi-web:stable-${ref}`,
  };
}
