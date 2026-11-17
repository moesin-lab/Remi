import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { assertUpdateServiceLauncher } from "@shared/cli-update-service.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "remi-service-preflight-"));
  roots.push(root);
  const launcherPath = join(root, "bin", "remi");
  const binary = join(root, "versions", "old", "remi");
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "versions", "old"), { recursive: true });
  writeFileSync(launcherPath, "#!/bin/sh\nexec old-remi\n");
  writeFileSync(binary, "old-remi");
  return { root, launcherPath, binary, launchdPath: join(root, "daemon.plist") };
}

for (const manager of ["systemd", "launchd"] as const) {
  for (const scenario of ["launcher", "binary", "overrides-to-binary", "overrides-to-launcher"] as const) {
    test(`${manager}: ${scenario}`, () => {
      const f = fixture();
      const executable = scenario === "binary" || scenario === "overrides-to-binary" ? f.binary : f.launcherPath;
      const calls: [string, string[]][] = [];
      // systemd's show response is the effective result after ALL drop-ins;
      // the base unit and intermediate overrides must never be read instead.
      // launchd has no drop-ins: the selected plist's Program overrides argv[0].
      const effective = manager === "systemd"
        ? `{ path=${executable} ; argv[]=${executable} daemon start ; ignore_errors=no ; pid=42 ; code=(null) ; status=0/0 }`
        : JSON.stringify({ ProgramArguments: [f.launcherPath, "daemon", "start"],
          ...(scenario.startsWith("overrides") ? { Program: executable } : { ProgramArguments: [executable, "daemon", "start"] }) });
      const check = () => assertUpdateServiceLauncher({ ...f,
        restart: { manager, command: manager === "systemd"
          ? ["systemctl", "--user", "restart", "--no-block", "fixture.service"]
          : ["launchctl", "kickstart", "-k", "gui/501/fixture"] },
        run: (cmd, args) => {
          calls.push([cmd, args]);
          if (cmd === "launchctl") return `path = ${f.launchdPath}\nprogram = ${f.launcherPath}`;
          return effective;
        },
      });
      if (executable === f.launcherPath) expect(check).not.toThrow();
      else {
        expect(check).toThrow(f.binary);
        expect(check).toThrow(`expected launcher=${f.launcherPath}`);
        expect(check).toThrow("remi daemon service install");
      }
      expect(calls[0]).toEqual(manager === "systemd"
        ? ["systemctl", ["--user", "show", "-p", "ExecStart", "--value", "--", "fixture.service"]]
        : ["launchctl", ["print", "gui/501/fixture"]]);
      if (manager === "launchd") expect(calls[1]).toEqual(
        ["/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", f.launchdPath]]);
    });
  }
}

for (const output of ["", "garbage", "{ path=/bin/one ; } { path=/bin/two ; }"]) {
  test(`fails closed on unknown or multiple ExecStart: ${output}`, () => {
    expect(() => assertUpdateServiceLauncher({ ...fixture(),
      restart: { manager: "systemd", command: ["systemctl", "fixture.service"] }, run: () => output,
    })).toThrow("CLI update blocked");
  });
}

test("fails closed when service query fails", () => {
  expect(() => assertUpdateServiceLauncher({ ...fixture(),
    restart: { manager: "launchd", command: ["launchctl", "gui/501/fixture"] }, run: () => { throw new Error("unreadable plist"); },
  })).toThrow("unreadable plist");
});

test("does not compare a symlink launcher's current binary target", () => {
  const f = fixture();
  rmSync(f.launcherPath);
  symlinkSync(f.binary, f.launcherPath);
  expect(() => assertUpdateServiceLauncher({ ...f,
    restart: { manager: "systemd", command: ["systemctl", "fixture.service"] },
    run: () => `{ path=${f.binary} ; }`,
  })).toThrow("CLI update blocked");
});

test("resolves directory symlinks and systemd escaped spaces", () => {
  const f = fixture();
  const directory = join(f.root, "alias with space");
  symlinkSync(join(f.root, "bin"), directory);
  const escaped = join(directory, "remi").replaceAll(" ", "\\x20");
  expect(() => assertUpdateServiceLauncher({ ...f,
    restart: { manager: "systemd", command: ["systemctl", "fixture.service"] },
    run: () => `{ path=${escaped} ; }`,
  })).not.toThrow();
});

for (const manager of ["systemd", "launchd"] as const) {
  for (const scenario of ["absolute-chain", "relative-chain", "direct-binary", "cycle"] as const) {
    test(`${manager}: symlink launcher ${scenario}`, () => {
      const f = fixture();
      rmSync(f.launcherPath);
      symlinkSync(f.binary, f.launcherPath);
      const serviceDir = join(f.root, "service");
      mkdirSync(serviceDir);
      const intermediate = join(serviceDir, "intermediate");
      const entry = join(serviceDir, "remi");
      // Both relative and absolute chains pass through a directory alias to
      // the launcher. Direct binary paths must still fail despite realpath
      // resolving both the binary and launcher to the same file.
      const alias = join(f.root, "bin-alias");
      symlinkSync(join(f.root, "bin"), alias);
      symlinkSync(scenario === "cycle" ? entry : join(alias, "remi"), intermediate);
      symlinkSync(scenario === "relative-chain" ? relative(serviceDir, intermediate) : intermediate, entry);
      const executable = scenario === "direct-binary" ? f.binary : entry;
      const check = () => assertUpdateServiceLauncher({ ...f,
        restart: { manager, command: manager === "systemd"
          ? ["systemctl", "fixture.service"] : ["launchctl", "gui/501/fixture"] },
        run: cmd => cmd === "systemctl" ? `{ path=${executable} ; }`
          : cmd === "launchctl" ? `path = ${f.launchdPath}\nprogram = ${executable}`
          : JSON.stringify({ ProgramArguments: [executable, "daemon", "start"] }),
      });
      if (scenario === "direct-binary" || scenario === "cycle") expect(check).toThrow("CLI update blocked");
      else expect(check).not.toThrow();
    });
  }
}

test("unmanaged updates do not query a service manager", () => {
  expect(() => assertUpdateServiceLauncher({ ...fixture(), run: () => { throw new Error("unexpected query"); } })).not.toThrow();
});

test("launchd rejects a loaded binary even when the on-disk plist was repaired", () => {
  const f = fixture();
  expect(() => assertUpdateServiceLauncher({ ...f,
    restart: { manager: "launchd", command: ["launchctl", "kickstart", "-k", "gui/501/fixture"] },
    run: () => `path = ${f.launchdPath}\nprogram = ${f.binary}`,
  })).toThrow(f.binary);
});

test("launchd reads the loaded service plist instead of a possibly unrelated default", () => {
  const f = fixture();
  const loaded = join(f.root, "custom.plist");
  expect(() => assertUpdateServiceLauncher({ ...f,
    restart: { manager: "launchd", command: ["launchctl", "kickstart", "-k", "gui/501/fixture"] },
    run: (cmd, args) => {
      if (cmd === "launchctl") return `path = ${loaded}\nprogram = ${f.launcherPath}`;
      expect(args.at(-1)).toBe(loaded);
      return JSON.stringify({ ProgramArguments: [f.binary, "daemon", "start"] });
    },
  })).toThrow(f.binary);
});

for (const manager of ["systemd", "launchd"] as const) {
  test(`${manager}: error contains entry paths without service environment or arguments`, () => {
    const f = fixture();
    let error = "";
    try {
      assertUpdateServiceLauncher({ ...f,
        restart: { manager, command: manager === "systemd" ? ["systemctl", "fixture.service"] : ["launchctl", "gui/501/fixture"] },
        run: cmd => cmd === "systemctl" ? `{ path=${f.binary} ; argv[]=${f.binary} --token secret-marker ; }`
          : `path = ${f.launchdPath}\nprogram = ${f.binary}\nenvironment = { TOKEN = secret-marker }`,
      });
    } catch (err) { error = (err as Error).message; }
    expect(error).toContain(f.binary);
    expect(error).not.toContain("secret-marker");
  });
}
