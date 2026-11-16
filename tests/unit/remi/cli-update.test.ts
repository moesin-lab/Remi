import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  compareVersions,
  performUpdate,
  releaseAssetName,
  releaseRepository,
  runUpdate,
  type GithubRelease,
} from "../../../apps/remi/cli/update.js";

import { buildMultiremiDaemonServiceSpec, systemdQuote } from "../../../apps/remi/cli/multiremi/service.js";

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
    expect(releaseRepository({})).toBe("moesin-lab/Remi");
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
    expectUpdaterServiceLauncher(fixture, join(result.snapshotDir, "remi"));
    expect(fixture.requests).toEqual([
      "https://api.github.com/repos/moesin-lab/Remi/releases/latest",
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

  test.each(["remi-cli-update-", "remi-cli-user's store-"])("rewrites an installer launcher with shell setup and fixed args (%s)", async (prefix) => {
    const fixture = releaseFixture(roots, undefined, prefix);
    const oldRelease = join(fixture.root, "old-release");
    const mocks = join(fixture.root, "mocks");
    mkdirSync(oldRelease); mkdirSync(mocks);
    writeExecutable(join(oldRelease, "remi"), "#!/bin/sh\necho 0.2.80\n");
    const archive = join(fixture.root, "old.tar.gz");
    execFileSync("tar", ["czf", archive, "-C", oldRelease, "remi"]);
    const oldId = createHash("sha256").update(readFileSync(archive)).digest("hex").slice(0, 8);
    writeExecutable(join(mocks, "curl"), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\nif [ "$1" = -o ]; then cp "$FIXTURE_ARCHIVE" "$2"; exit; fi\nshift\ndone\nexit 93\n');
    const installed = spawnSync("bash", [resolve("scripts/install-remi.sh")], { encoding: "utf8", env: {
      ...process.env, PATH: `${mocks}:${process.env.PATH}`, MULTIREMI_VERSION: "0.2.80",
      MULTIREMI_BIN_DIR: join(fixture.root, "bin"), MULTIREMI_INSTALL_ROOT: fixture.installRoot,
      FIXTURE_ARCHIVE: archive,
    } });
    expect(installed.status).toBe(0);
    const installedLauncher = readFileSync(fixture.launcherPath, "utf8");
    const oldBinaryPath = join(fixture.installRoot, "versions", oldId, "remi");
    const quoted = /^[A-Za-z0-9_/:=.,@%+-]+$/.test(oldBinaryPath) ? oldBinaryPath : "'" + oldBinaryPath.replaceAll("'", "'\\''") + "'";
    expect(installedLauncher).toBe(`#!/bin/sh\n# Remi stable launcher; versioned binaries make upgrades recoverable.\nexec ${quoted} "$@"\n`);
    const previous = installedLauncher.replace("# Remi stable", "export LOCAL_SETUP=preserved\n# Remi stable").replace('"$@"', '"fixed argument" "$@"');
    writeExecutable(fixture.launcherPath, previous);
    const result = await performUpdate({ currentVersion: "0.2.80", platform: { os: "darwin", arch: "arm64" },
      fetchImpl: fixture.fetchImpl, env: { PATH: "", FIXTURE_EVENTS: fixture.events },
      homeDir: fixture.homeDir, installRoot: fixture.installRoot, launcherPath: fixture.launcherPath, launchdPath: fixture.launchdPath });
    expect(result.status).toBe("installed");
    expect(readFileSync(fixture.launcherPath, "utf8")).toContain("export LOCAL_SETUP=preserved");
    expect(readFileSync(fixture.launcherPath, "utf8")).toContain('"fixed argument" "$@"');
    expect(readFileSync(fixture.launcherPath, "utf8")).not.toContain(`/versions/${oldId}/remi`);
    expect(execFileSync(fixture.launcherPath, ["--version"], { encoding: "utf8" }).trim()).toBe("0.2.81");
    expect(existsSync(join(fixture.installRoot, "versions", oldId, "remi"))).toBe(true);
    // Complete the reverse direction: the runtime installer must retain settings
    // and fixed arguments emitted by the local updater, including escaped paths.
    const beforeReinstall = readFileSync(fixture.launcherPath, "utf8");
    const reinstalled = spawnSync("bash", [resolve("scripts/install-remi.sh")], { encoding: "utf8", env: {
      ...process.env, PATH: `${mocks}:${process.env.PATH}`, MULTIREMI_VERSION: "0.2.81",
      MULTIREMI_BIN_DIR: join(fixture.root, "bin"), MULTIREMI_INSTALL_ROOT: fixture.installRoot,
      FIXTURE_ARCHIVE: join(fixture.root, "remi-0.2.81-darwin-arm64.tar.gz"), FIXTURE_EVENTS: fixture.events,
    } });
    expect(reinstalled.status).toBe(0);
    expect(readFileSync(fixture.launcherPath, "utf8")).toBe(beforeReinstall);
    expect(execFileSync(fixture.launcherPath, ["--version"], { encoding: "utf8" }).trim()).toBe("0.2.81");
  });

  test.each(["remi-cli-update-", "remi-cli-user's store-"])("installer and local updater emit identical generic launchers (%s)", async (prefix) => {
    const fixture = releaseFixture(roots, undefined, prefix);
    const mocks = join(fixture.root, "mocks"); mkdirSync(mocks);
    writeExecutable(join(mocks, "curl"), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\nif [ "$1" = -o ]; then cp "$FIXTURE_ARCHIVE" "$2"; exit; fi\nshift\ndone\nexit 93\n');
    const installed = spawnSync("bash", [resolve("scripts/install-remi.sh")], { encoding: "utf8", env: {
      ...process.env, PATH: `${mocks}:${process.env.PATH}`, MULTIREMI_VERSION: "0.2.81",
      MULTIREMI_BIN_DIR: join(fixture.root, "bin"), MULTIREMI_INSTALL_ROOT: fixture.installRoot,
      FIXTURE_ARCHIVE: join(fixture.root, "remi-0.2.81-darwin-arm64.tar.gz"), FIXTURE_EVENTS: fixture.events,
    } });
    expect(installed.status).toBe(0);
    const installerLauncher = readFileSync(fixture.launcherPath);
    rmSync(fixture.launcherPath);
    await performUpdate({ currentVersion: "0.2.80", platform: { os: "darwin", arch: "arm64" },
      fetchImpl: fixture.fetchImpl, env: { PATH: "", FIXTURE_EVENTS: fixture.events },
      homeDir: fixture.homeDir, installRoot: fixture.installRoot, launcherPath: fixture.launcherPath, launchdPath: fixture.launchdPath });
    expect(readFileSync(fixture.launcherPath)).toEqual(installerLauncher);
  });

  test("service specs use the actual generic launcher written by the updater", async () => {
    const fixture = releaseFixture(roots);
    const result = await performUpdate({
      currentVersion: "0.2.68",
      platform: { os: "darwin", arch: "arm64" },
      fetchImpl: fixture.fetchImpl,
      env: { PATH: "", FIXTURE_EVENTS: fixture.events },
      homeDir: fixture.homeDir,
      installRoot: fixture.installRoot,
      launcherPath: fixture.launcherPath,
      launchdPath: fixture.launchdPath,
    });
    if (result.status !== "installed") throw new Error("expected installed result");
    expect(readFileSync(fixture.launcherPath, "utf8")).toContain(`exec ${result.snapshotDir}/remi "$@"`);
    expectUpdaterServiceLauncher(fixture, join(result.snapshotDir, "remi"));
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

function releaseFixture(roots: string[], digestOverride?: string, prefix = "remi-cli-update-"): {
  root: string;
  homeDir: string;
  installRoot: string;
  launcherPath: string;
  launchdPath: string;
  events: string;
  requests: string[];
  fetchImpl: typeof fetch;
} {
  const root = mkdtempSync(join(tmpdir(), prefix));
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
    "if [ \"$1\" = \"fixed argument\" ]; then shift; fi",
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

function expectUpdaterServiceLauncher(fixture: { installRoot: string; launcherPath: string; homeDir: string }, binary: string): void {
  const keys = ["MULTIREMI_INSTALL_ROOT", "MULTIREMI_BIN_DIR", "PATH"];
  const previous = keys.map((key) => process.env[key]);
  try {
    process.env.MULTIREMI_INSTALL_ROOT = fixture.installRoot;
    process.env.MULTIREMI_BIN_DIR = fixture.launcherPath.slice(0, -"/remi".length);
    process.env.PATH = "";
    const argv = [binary, "daemon", "service", "install"];
    const systemd = buildMultiremiDaemonServiceSpec({}, "remi", "systemd", fixture.homeDir, argv, binary);
    expect(systemd.content).toContain(`ExecStart=${systemdQuote(fixture.launcherPath)} daemon start --foreground`);
    const launchd = buildMultiremiDaemonServiceSpec({}, "remi", "launchd", fixture.homeDir, argv, binary);
    expect(launchd.content).toContain(`<string>${fixture.launcherPath}</string>`);
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
}
