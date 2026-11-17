import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Exercise the real spawnSync signal result and the real fallback spawn in a
// child process, so process.exit and child_process mocks cannot hide a successor.
for (const outcome of ["SIGTERM", "success", "failure", "SIGKILL", "missing", "unmanaged"]) {
  test.skipIf(process.platform !== "linux")(`foreground restart handoff: ${outcome}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "daemon-restart-handoff-"));
    roots.push(root);
    const bin = join(root, "bin");
    mkdirSync(bin);
    const calls = join(root, "manager-args");
    const successor = join(root, "successor");
    if (outcome !== "missing") {
      const action = outcome === "success" ? "exit 0" : outcome === "failure" ? "exit 23" : `kill -${outcome === "SIGKILL" ? "KILL" : "TERM"} $$`;
      writeFileSync(join(bin, "systemctl"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${calls}'\n${action}\n`, { mode: 0o755 });
    }
    const entry = join(root, "successor.ts");
    writeFileSync(entry, `await Bun.write(${JSON.stringify(successor)}, "started");`);
    const module = resolve("apps/remi/cli/multiremi.ts");
    const child = Bun.spawn([process.execPath, "--eval", `
      import { restartForegroundDaemonProcess } from ${JSON.stringify(module)};
      process.argv = [process.execPath, ${JSON.stringify(entry)}];
      restartForegroundDaemonProcess({}, "remi");
    `], {
      env: { ...process.env, PATH: bin, INVOCATION_ID: outcome === "unmanaged" ? "" : "fixture-invocation" },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(0);
    const fallback = !["SIGTERM", "success"].includes(outcome);
    expect(stderr.includes("restarting with updated binary")).toBe(fallback);
    expect(existsSync(successor)).toBe(fallback);
    if (outcome === "SIGTERM") {
      expect(stderr).toContain("interrupted by SIGTERM; leaving restart to the service manager");
      expect(stderr).not.toContain("failed");
      expect(stderr).not.toContain("falling back");
    }
    if (outcome === "success") expect(stderr).toContain("restarting via systemctl");
    if (["failure", "SIGKILL", "missing"].includes(outcome)) expect(stderr).toContain("falling back to a spawned successor");
    if (!["missing", "unmanaged"].includes(outcome)) {
      expect(readFileSync(calls, "utf8").split("\n").slice(0, 3)).toEqual(["--user", "restart", "--no-block"]);
    } else expect(existsSync(calls)).toBe(false);
  });
}
