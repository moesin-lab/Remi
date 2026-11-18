import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Actual Bun subprocess: unhandled timer throws/rejections terminate it normally.
// No global unhandledRejection/uncaughtException handler masks a regression.
test("API survives a SQL outage, reports 503, then reclaims its lease without another run", async () => {
  const home = mkdtempSync(join(tmpdir(), "remi-db-recovery-"));
  const pending = new Map<number, (value: any) => void>();
  let ready!: (value: any) => void;
  const startup = new Promise<any>(resolve => { ready = resolve; });
  const child = Bun.spawn([process.execPath, "tests/integration/database-recovery-fixture.ts"], {
    cwd: process.cwd(), env: { ...process.env, HOME: home, USERPROFILE: home, NODE_ENV: "test" },
    stdout: "pipe", stderr: "pipe",
    ipc(message: any) {
      if (message.ready) ready(message);
      else { pending.get(message.id)?.(message); pending.delete(message.id); }
    },
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let id = 0;
  async function command(command: string) {
    const current = ++id;
    const result = new Promise<any>(resolve => pending.set(current, resolve));
    child.send({ id: current, command });
    return Promise.race([result, child.exited.then(async code => { throw new Error(`API exited ${code}: ${await stderr}`); })]);
  }
  try {
    const initial = await Promise.race([startup, child.exited.then(async code => { throw new Error(`startup exited ${code}: ${await stderr}`); })]);
    const base = `http://127.0.0.1:${initial.port}`;
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    const claimed = await command("outage");
    expect(claimed.row.status).toBe("processing");
    expect(claimed.runs).toBe(1);
    const started = performance.now();
    const unavailable = await fetch(`${base}/readyz`);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ reason: "database_unavailable" });
    expect((await fetch(`${base}/api/workspaces`)).status).toBe(503);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    // Stay unavailable across multiple actual retries, not just one synchronous call.
    await Bun.sleep(3_200);
    expect(child.exitCode).toBeNull();
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    await command("recover");
    const deadline = Date.now() + 6_000;
    let recovered: any;
    do {
      recovered = await command("snapshot");
      if (recovered.row.status === "processed") break;
      await Bun.sleep(25);
    } while (Date.now() < deadline);
    expect(recovered.row.status).toBe("processed");
    expect(recovered.row.attempt_count).toBe(2);
    expect(recovered.runs).toBe(1);
    expect(recovered.schedulerTicks).toBeGreaterThan(claimed.schedulerTicks);
    expect(recovered.pid).toBe(initial.pid);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    expect((await fetch(`${base}/api/workspaces`)).status).toBe(200);
  } finally {
    child.kill("SIGTERM");
    await child.exited;
    const logs = (await stdout) + (await stderr);
    if (child.exitCode !== 0) console.error(logs);
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
