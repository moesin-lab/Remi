import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareVersions,
  performUpdate,
  releaseAssetName,
  releaseRepository,
  runUpdate,
  type GithubRelease,
} from "../../../apps/remi/cli/update.js";

describe("Remi CLI updater", () => {
  const roots: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("uses the release pipeline repository and asset naming contract", () => {
    expect(releaseRepository({})).toBe("Grassgod/Remi");
    expect(releaseRepository({ MULTIREMI_REPO: "legacy/repo" })).toBe("legacy/repo");
    expect(releaseRepository({ MULTIREMI_RELEASE_REPO: "release/repo", MULTIREMI_REPO: "legacy/repo" }))
      .toBe("release/repo");
    expect(releaseAssetName("v0.2.81", { os: "darwin", arch: "arm64" }))
      .toBe("remi-0.2.81-darwin-arm64.tar.gz");
    expect(compareVersions("0.2.81", "0.2.68-stable.9498e426")).toBeGreaterThan(0);
  });

  test("prints update help without accessing the network", async () => {
    const output: string[] = [];
    console.log = (value?: unknown) => { output.push(String(value ?? "")); };
    globalThis.fetch = (() => { throw new Error("network must not be called"); }) as unknown as typeof fetch;

    await runUpdate(["--help"]);

    expect(output.join("\n")).toContain("Usage: remi update");
    expect(output.join("\n")).toContain("The daemon is not restarted");
  });

  test("upgrades macOS arm64 through a verified snapshot and keeps launcher rollback", async () => {
    const fixture = releaseFixture(roots);
    const oldSnapshot = join(fixture.installRoot, "versions", "9498e426");
    mkdirSync(oldSnapshot, { recursive: true });
    writeExecutable(join(oldSnapshot, "remi"), "#!/bin/sh\necho 0.2.68-stable.9498e426\n");
    const previousLauncher = [
      "#!/bin/bash",
      "# keep the local relay wrapper while changing only its version target",
      "args=(\"$@\")",
      `exec ${oldSnapshot}/remi \"\${args[@]}\"`,
      "",
    ].join("\n");
    writeExecutable(fixture.launcherPath, previousLauncher);
    mkdirSync(join(fixture.homeDir, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(fixture.launchdPath, launchdPlist(join(oldSnapshot, "remi")));

    const result = await performUpdate({
      currentVersion: "0.2.68-stable.9498e426",
      platform: { os: "darwin", arch: "arm64" },
      fetchImpl: fixture.fetchImpl,
      env: { PATH: "", FIXTURE_EVENTS: fixture.events },
      homeDir: fixture.homeDir,
      installRoot: fixture.installRoot,
      launcherPath: fixture.launcherPath,
      launchdPath: fixture.launchdPath,
    });

    expect(result).toMatchObject({
      status: "installed",
      version: "0.2.81",
      assetName: "remi-0.2.81-darwin-arm64.tar.gz",
      launchdUpdated: true,
    });
    if (result.status !== "installed") throw new Error("expected installed result");
    expect(fixture.requests).toEqual([
      "https://api.github.com/repos/Grassgod/Remi/releases/latest",
      "https://downloads.example.test/remi-0.2.81-darwin-arm64.tar.gz",
    ]);
    expect(readFileSync(fixture.events, "utf8")).toBe("prepared");
    expect(readFileSync(fixture.launcherPath, "utf8")).toContain(`${result.snapshotDir}/remi`);
    expect(readFileSync(fixture.launcherPath, "utf8")).toContain("keep the local relay wrapper");
    expect(readFileSync(join(result.snapshotDir, "previous-launcher"), "utf8")).toBe(previousLauncher);
    expect(readFileSync(fixture.launchdPath, "utf8")).toContain(`<string>${fixture.launcherPath}</string>`);
    expect(readFileSync(join(result.snapshotDir, "previous-launchd.plist"), "utf8"))
      .toContain(`<string>${oldSnapshot}/remi</string>`);
    expect(existsSync(join(oldSnapshot, "remi"))).toBe(true);
    expect(execFileSync(fixture.launcherPath, ["--version"], { encoding: "utf8" }).trim()).toBe("0.2.81");
  });

  test("does not replace the executable when the release checksum fails", async () => {
    const fixture = releaseFixture(roots, "0".repeat(64));
    const oldLauncher = "#!/bin/sh\necho old-remi\n";
    writeExecutable(fixture.launcherPath, oldLauncher);

    await expect(performUpdate({
      currentVersion: "0.2.68-stable.9498e426",
      platform: { os: "darwin", arch: "arm64" },
      fetchImpl: fixture.fetchImpl,
      env: { PATH: "", FIXTURE_EVENTS: fixture.events },
      homeDir: fixture.homeDir,
      installRoot: fixture.installRoot,
      launcherPath: fixture.launcherPath,
      launchdPath: fixture.launchdPath,
    })).rejects.toThrow("SHA-256 mismatch");

    expect(readFileSync(fixture.launcherPath, "utf8")).toBe(oldLauncher);
    expect(existsSync(join(fixture.installRoot, "versions"))).toBe(false);
  });
});

function releaseFixture(roots: string[], digestOverride?: string): {
  root: string;
  homeDir: string;
  installRoot: string;
  launcherPath: string;
  launchdPath: string;
  events: string;
  requests: string[];
  fetchImpl: typeof fetch;
} {
  const root = mkdtempSync(join(tmpdir(), "remi-cli-update-"));
  roots.push(root);
  const releaseDir = join(root, "release");
  const homeDir = join(root, "home");
  const binDir = join(root, "bin");
  const installRoot = join(homeDir, ".local", "lib", "remi");
  const launcherPath = join(binDir, "remi");
  const launchdPath = join(homeDir, "Library", "LaunchAgents", "dev.remi.multiremi.daemon.plist");
  const events = join(root, "events");
  for (const directory of [releaseDir, homeDir, binDir]) mkdirSync(directory, { recursive: true });
  writeExecutable(join(releaseDir, "remi"), [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then echo 0.2.81; exit 0; fi",
    "if [ \"$1 $2\" = \"runtime prepare\" ]; then printf prepared > \"$FIXTURE_EVENTS\"; exit 0; fi",
    "exit 91",
    "",
  ].join("\n"));
  writeExecutable(join(releaseDir, "remi-claude-agent-acp"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(releaseDir, "runtime-bundle.json"), '{"schema":1}\n');
  const archivePath = join(root, "remi-0.2.81-darwin-arm64.tar.gz");
  execFileSync("tar", ["-czf", archivePath, "-C", releaseDir, "remi", "remi-claude-agent-acp", "runtime-bundle.json"]);
  const archive = readFileSync(archivePath);
  const digest = digestOverride ?? createHash("sha256").update(archive).digest("hex");
  const requests: string[] = [];
  const release: GithubRelease = {
    tag_name: "v0.2.81",
    assets: [{
      name: "remi-0.2.81-darwin-arm64.tar.gz",
      browser_download_url: "https://downloads.example.test/remi-0.2.81-darwin-arm64.tar.gz",
      digest: `sha256:${digest}`,
      size: archive.byteLength,
    }],
  };
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push(url);
    if (url.includes("api.github.com")) return Response.json(release);
    if (url === release.assets[0]!.browser_download_url) return new Response(archive);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { root, homeDir, installRoot, launcherPath, launchdPath, events, requests, fetchImpl };
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function launchdPlist(binary: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>ProgramArguments</key><array>
  <string>${binary}</string>
  <string>daemon</string><string>start</string><string>--foreground</string>
</array>
</dict></plist>
`;
}
