import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../../../deploy/docker/api-entrypoint.sh");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "api-entrypoint-"));
  roots.push(root);
  const bin = join(root, "bin");
  const identityFile = join(root, "identity");
  mkdirSync(bin);

  const stubs = {
    // The Bun image already has UID 1000 with /home/bun as its passwd home.
    getent: '#!/bin/sh\nexit 0\n',
    groupadd: '#!/bin/sh\nexit 99\n',
    useradd: '#!/bin/sh\nexit 99\n',
    gosu: `#!/bin/sh
printf '%s' "$1" > "$ENTRYPOINT_TEST_IDENTITY_FILE"
shift
# Like gosu, use the target account's passwd home before executing the command.
HOME=/home/bun
export HOME
exec "$@"
`,
  };
  for (const [name, content] of Object.entries(stubs)) {
    const path = join(bin, name);
    writeFileSync(path, content);
    chmodSync(path, 0o755);
  }

  return {
    root,
    identityFile,
    run(args: string[], overrides: Record<string, string | undefined> = {}) {
      return Bun.spawnSync(["sh", script, ...args], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          ENTRYPOINT_TEST_IDENTITY_FILE: identityFile,
          ...overrides,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
    },
  };
}

describe.skipIf(process.platform === "win32")("API entrypoint persistent home", () => {
  test.each([
    { uid: undefined, gid: undefined, identity: "1000:1000" },
    { uid: "1234", gid: "5678", identity: "1234:5678" },
  ])("preserves configured HOME and argv after gosu ($identity)", ({ uid, gid, identity }) => {
    const { root, identityFile, run } = fixture();
    const home = join(root, "persistent home");
    const args = ["value with spaces", "$literal", ""];
    const result = run([
      process.execPath,
      "-e",
      "console.log(JSON.stringify({ home: process.env.HOME, args: process.argv.slice(1) }))",
      ...args,
    ], { HOME: home, REMI_RUNTIME_UID: uid, REMI_RUNTIME_GID: gid });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({ home, args });
    expect(readFileSync(identityFile, "utf8")).toBe(identity);
  });

  test("defaults an unset HOME to the persistent service home", () => {
    const { run } = fixture();
    const result = run(["sh", "-c", 'printf "%s" "$HOME"'], { HOME: undefined });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toBe("/srv/multiremi");
  });

  test("preserves the command exit status", () => {
    const { run } = fixture();
    const result = run(["sh", "-c", "exit 37"]);

    expect(result.exitCode).toBe(37);
  });
});
