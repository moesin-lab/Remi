import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildMultiremiDaemonLaunchSpec,
  buildMultiremiDaemonServiceSpec,
  shellQuote,
  systemdQuote,
} from "../../../apps/remi/cli/multiremi/service.js";

let root: string;
let binary: string;
let launcher: string;
let previous: Record<string, string | undefined>;
const envKeys = ["MULTIREMI_INSTALL_ROOT", "MULTIREMI_BIN_DIR", "PATH"];

beforeEach(() => {
  previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  root = mkdtempSync(join(tmpdir(), "daemon-launcher-"));
  process.env.MULTIREMI_INSTALL_ROOT = join(root, "install root's");
  binary = join(process.env.MULTIREMI_INSTALL_ROOT, "versions", "release-a", "remi");
  launcher = join(root, "bin", "remi");
  process.env.PATH = dirname(launcher);
  delete process.env.MULTIREMI_BIN_DIR;
  mkdirSync(dirname(binary), { recursive: true });
  writeFileSync(binary, "binary fixture", { mode: 0o755 });
});

afterEach(() => {
  for (const key of envKeys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  rmSync(root, { recursive: true, force: true });
});

function writeLauncher(path = launcher, target = binary): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n# Remi stable launcher\nexec ${shellQuote(target)} "$@"\n`, { mode: 0o755 });
}

function expectCommand(execPath: string, expected: string): void {
  const argv = [execPath, "daemon", "service", "install"];
  expect(buildMultiremiDaemonLaunchSpec({}, "remi", argv, execPath).command).toBe(expected);
  const systemd = buildMultiremiDaemonServiceSpec({}, "remi", "systemd", root, argv, execPath);
  expect(systemd.content).toContain(`ExecStart=${systemdQuote(expected)} daemon start --foreground\n`);
  const launchd = buildMultiremiDaemonServiceSpec({}, "remi", "launchd", root, argv, execPath);
  const escaped = expected.replace(/&/g, "&amp;").replace(/'/g, "&apos;");
  expect(launchd.content).toContain(`<key>ProgramArguments</key>\n  <array>\n    <string>${escaped}</string>`);
}

describe("daemon service stable launcher", () => {
  test("keeps a directly installed binary even with a matching PATH wrapper", () => {
    const direct = join(root, "direct", "remi");
    writeLauncher(launcher, direct);
    expectCommand(direct, direct);
  });

  test("uses the PATH launcher for this installed version, including shell quoting", () => {
    writeLauncher();
    expectCommand(binary, launcher);
  });

  test("prefers MULTIREMI_BIN_DIR over PATH when both match", () => {
    writeLauncher();
    const custom = join(root, "custom bin", "remi");
    writeLauncher(custom);
    process.env.MULTIREMI_BIN_DIR = dirname(custom);
    expectCommand(binary, custom);
  });

  test("continues searching past a launcher for another installation", () => {
    const unrelated = join(root, "unrelated", "remi");
    writeLauncher(unrelated, join(root, "other", "versions", "release-a", "remi"));
    process.env.MULTIREMI_BIN_DIR = dirname(unrelated);
    writeLauncher();
    expectCommand(binary, launcher);
  });

  test("keeps the version binary when the launcher is missing or targets another version", () => {
    expectCommand(binary, binary);
    writeLauncher(launcher, binary.replace("release-a", "release-b"));
    expectCommand(binary, binary);
    writeLauncher(launcher, `${binary}-other`);
    expectCommand(binary, binary);
  });

  test("ignores non-executable launchers and target text outside an exec command", () => {
    writeLauncher();
    chmodSync(launcher, 0o644);
    expectCommand(binary, binary);
    chmodSync(launcher, 0o755);
    writeFileSync(launcher, `#!/bin/sh\n# exec ${shellQuote(binary)} "$@"\nexit 0\n`);
    expectCommand(binary, binary);
  });

  test("accepts a double quoted exec target", () => {
    const plainBinary = join(root, "install", "versions", "release-a", "remi");
    process.env.MULTIREMI_INSTALL_ROOT = join(root, "install");
    writeLauncher();
    writeFileSync(launcher, `#!/bin/sh\nexec "${plainBinary}" "$@"\n`);
    expectCommand(plainBinary, launcher);
  });

  test("preserves Bun source command and script arguments", () => {
    const bun = join(root, "install", "versions", "release-a", "bun");
    const script = join(root, "repo", "apps", "remi", "main.ts");
    writeLauncher(launcher, bun);
    const argv = [bun, script];
    const spec = buildMultiremiDaemonLaunchSpec({}, "remi", argv, bun);
    expect(spec.command).toBe(bun);
    expect(spec.args).toEqual([script, "daemon", "start", "--foreground"]);
    const service = buildMultiremiDaemonServiceSpec({}, "remi", "systemd", root, argv, bun);
    expect(service.content).toContain(`ExecStart=${bun} ${script} daemon start --foreground`);
  });
});
