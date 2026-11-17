import { expect, test } from "bun:test";
import { connect, createServer, type Socket } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { twoProcessChildEnv, pollUntil, redactDiagnostic } from "../helpers/two-process.js";
import { openIntegrationDatabase } from "../helpers/integration-database.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import { API_SHUTDOWN_TIMEOUT_MS } from "@multiremi/api/slot-lifecycle.js";

async function child(mode: string, path: string, id = "A") {
  let ready: { port: number; issue: string } | undefined;
  let ack: ((value: any) => void) | undefined;
  let output = "";
  const process = Bun.spawn([globalThis.process.execPath, "--no-env-file", "tests/fixtures/slot-deadlines.ts", mode, path, id], {
    env: { ...twoProcessChildEnv(), MULTIREMI_DATABASE_URL: "", NODE_ENV: "test" },
    stdout: "pipe", stderr: "pipe",
    ipc(message: any) {
      if (message.event === "ready") ready = message;
      if (message.event === "ack") ack?.(message);
    },
  });
  for (const stream of [process.stdout, process.stderr]) void (async () => {
    for await (const chunk of stream) output += redactDiagnostic(new TextDecoder().decode(chunk));
  })();
  if (!await pollUntil(() => Boolean(ready) || process.exitCode !== null, 10_000) || !ready) {
    process.kill("SIGKILL"); await process.exited;
    throw new Error(`child startup failed: ${output}`);
  }
  const url = `http://127.0.0.1:${ready.port}`;
  return {
    process, url, issue: ready.issue, output: () => output,
    send: (message: object) => new Promise<any>(resolve => { ack = resolve; process.send(message); }),
    control: (action: string) => fetch(`${url}/internal/slot/${action}`, {
      method: "POST", headers: { Authorization: "Bearer control-test" }, signal: AbortSignal.timeout(3000),
    }),
    async close() { if (process.exitCode === null) process.kill("SIGKILL"); await process.exited; },
  };
}

test.skipIf(!process.env.MULTIREMI_TEST_POSTGRES_URL)("slow real PATCH retains PG ownership; rollback restores A; exit fences SQLite writes before B activates", async () => {
  const database = await openIntegrationDatabase();
  const root = mkdtempSync(join(tmpdir(), "slot-drain-deadline-"));
  const path = join(root, "data.db");
  const a = await child("drain", path);
  const b = await child("drain", path, "B");
  let socket: Socket | undefined;
  try {
    for (const c of [a, b]) await c.send({ op: "database", url: database.url });
    expect((await a.control("activate")).status).toBe(200);
    const body = JSON.stringify({ title: "late old write" });
    socket = connect(Number(new URL(a.url).port), "127.0.0.1");
    socket.on("error", () => {});
    socket.write(`PATCH /api/multiremi/issues/${a.issue} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer deadline-test\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body.slice(0, 1)}`);
    expect(await pollUntil(async () => (await a.send({ op: "pending" })).pending > 0)).toBe(true);
    const release = await a.control("release");
    expect(release.status).toBe(503);
    expect(await release.json()).toMatchObject({ state: "draining", error: "drain_timeout", in_flight: 1 });
    expect((await b.control("activate")).status).toBe(503);
    expect((await a.control("activate")).status).toBe(200);
    expect((await fetch(`${a.url}/readyz`)).status).toBe(200);
    const restored = await fetch(`${a.url}/api/multiremi/issues/${a.issue}`, {
      method: "PATCH", headers: { Authorization: "Bearer deadline-test", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "rollback restored" }),
    });
    expect(restored.status).toBe(200);
    await restored.text();
    expect((await a.control("release")).status).toBe(503);
    // Even if the old handler finishes naturally, retry release cannot hand off
    // after a timed-out drain; supervisor must choose rollback or process death.
    expect((await a.control("exit")).status).toBe(200);
    expect(await Promise.race([a.process.exited, Bun.sleep(2000).then(() => "timeout")]), a.output()).toBe(1);
    expect((await b.control("activate")).status).toBe(200);
    socket.end(body.slice(1));
    await Bun.sleep(200);
    const db = openSqliteDatabase(path);
    try { expect(new MultiremiStore(db).getIssue(a.issue)?.title).toBe("rollback restored"); } finally { db.close(); }
    expect((await fetch(`${b.url}/readyz`)).status).toBe(200);
  } finally { socket?.destroy(); await a.close(); await b.close(); await database.close(); rmSync(root, { recursive: true, force: true }); }
}, 20_000);

test("real activation bounds TCP blackhole, SQL blackhole and fence under one deadline; late fence cannot start or leak locks", async () => {
  const root = mkdtempSync(join(tmpdir(), "slot-activate-deadline-"));
  const c = await child("activate", join(root, "data.db"));
  const sockets = new Set<Socket>();
  let queries = 0;
  // PostgreSQL protocol stub: first hang the startup handshake, then complete
  // startup and hang the backend-pid SQL. This is real TCP, not mocked SQL.
  let sqlMode = false;
  const sink = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    socket.on("data", data => {
      if (!sqlMode) return;
      if (data[0] === 0) {
        const auth = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]);
        socket.write(Buffer.concat([auth, Buffer.from([0x5a, 0, 0, 0, 5, 0x49])]));
      } else queries++;
    });
  });
  await new Promise<void>(resolve => sink.listen(0, "127.0.0.1", resolve));
  try {
    const port = (sink.address() as { port: number }).port;
    await c.send({ op: "database", url: `postgres://unused:unused@127.0.0.1:${port}/unused?sslmode=disable` });
    await c.send({ op: "timeout", value: 30 });
    for (const mode of ["connect", "sql"]) {
      sqlMode = mode === "sql";
      const started = performance.now();
      const response = await c.control("activate");
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ state: "failed" });
      expect(performance.now() - started).toBeLessThan(250);
      expect(c.process.exitCode).toBeNull();
      expect(await pollUntil(() => sockets.size === 0, 1000), `${mode}: ${sockets.size} sockets; ${c.output()}`).toBe(true);
    }
    expect(queries).toBeGreaterThan(0);
    await c.send({ op: "database", url: process.env.MULTIREMI_TEST_POSTGRES_URL ?? "" });
    await c.send({ op: "fence", value: "hang" });
    const started = performance.now();
    expect((await c.control("activate")).status).toBe(503);
    expect(performance.now() - started).toBeLessThan(250);
    if (process.env.MULTIREMI_TEST_POSTGRES_URL) {
      const successor = await child("activate", join(root, "successor.db"), "B");
      try {
        await successor.send({ op: "database", url: process.env.MULTIREMI_TEST_POSTGRES_URL });
        expect((await successor.control("activate")).status).toBe(200);
        expect((await successor.control("release")).status).toBe(200);
      } finally { await successor.close(); }
    }
    await Bun.sleep(550);
    expect((await fetch(`${c.url}/readyz`)).status).toBe(503);
    await c.send({ op: "timeout", value: 100 });
    await c.send({ op: "fence", value: "normal" });
    expect((await c.control("activate")).status).toBe(200);
    expect((await c.control("release")).status).toBe(200);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => sink.close(() => resolve()));
    await c.close(); rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test.skipIf(!process.env.MULTIREMI_TEST_POSTGRES_URL)("advisory SQL deadline closes a real PG session after it has acquired a lock", async () => {
  const database = await openIntegrationDatabase();
  const root = mkdtempSync(join(tmpdir(), "slot-pg-query-deadline-"));
  const a = await child("activate", join(root, "a.db"));
  const b = await child("activate", join(root, "b.db"), "B");
  const peers = new Set<Socket>();
  const target = new URL(database.url!);
  const proxy = createServer(socket => {
    const upstream = connect(Number(target.port || 5432), target.hostname);
    let swallow = false;
    let lockRequested = false;
    let buffered = Buffer.alloc(0);
    for (const stream of [socket, upstream]) {
      peers.add(stream);
      stream.on("close", () => { peers.delete(stream); socket.destroy(); upstream.destroy(); });
      stream.on("error", () => { socket.destroy(); upstream.destroy(); });
    }
    socket.on("data", data => {
      if (Buffer.from(data).includes(Buffer.from("pg_try_advisory_lock"))) lockRequested = true;
      upstream.write(data);
    });
    upstream.on("data", data => {
      buffered = Buffer.concat([buffered, Buffer.from(data)]);
      while (buffered.length >= 5) {
        const length = buffered.readInt32BE(1) + 1;
        if (buffered.length < length) break;
        const frame = buffered.subarray(0, length);
        buffered = buffered.subarray(length);
        // Allow Parse/Bind to complete. Swallow the actual lock result only
        // after PG executed the query and acquired ownership.
        if (lockRequested && frame[0] === 0x44) swallow = true;
        if (!swallow) socket.write(frame);
      }
    });
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const sql = new Bun.SQL(database.url!);
  const locks = async () => Number((await sql.unsafe<{ n: number }[]>(
    "SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
  ))[0]!.n);
  try {
    const proxied = new URL(database.url!);
    proxied.port = String((proxy.address() as { port: number }).port);
    proxied.searchParams.set("sslmode", "disable");
    await a.send({ op: "database", url: proxied.toString() });
    await a.send({ op: "timeout", value: 200 });
    const started = performance.now();
    const activating = a.control("activate");
    const sawLock = await pollUntil(async () => await locks() > 0, 180);
    const response = await activating.catch(error => { throw new Error(`${error}; child=${a.process.exitCode}; ${a.output()}`); });
    expect(sawLock, a.output()).toBe(true);
    expect(response.status).toBe(503);
    expect(performance.now() - started).toBeLessThan(450);
    expect(await pollUntil(async () => await locks() === 0, 1000)).toBe(true);
    expect(await pollUntil(() => peers.size === 0, 1000)).toBe(true);
    expect(a.process.exitCode).toBeNull();
    await b.send({ op: "database", url: database.url });
    expect((await b.control("activate")).status).toBe(200);
    expect((await b.control("release")).status).toBe(200);
  } finally {
    await a.close(); await b.close();
    for (const socket of peers) socket.destroy();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await sql.end({ timeout: 1 });
    await database.close(); rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("real activation rejects synchronous fence overruns even before timers can run", async () => {
  const root = mkdtempSync(join(tmpdir(), "slot-sync-fence-"));
  const c = await child("activate", join(root, "data.db"));
  try {
    await c.send({ op: "timeout", value: 30 });
    await c.send({ op: "fence", value: "sync" });
    const response = await c.control("activate");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ state: "failed" });
    expect((await fetch(`${c.url}/readyz`)).status).toBe(503);
    expect(c.process.exitCode).toBeNull();
    await c.send({ op: "fence", value: "normal" });
    expect((await c.control("activate")).status).toBe(200);
    expect((await c.control("release")).status).toBe(200);
  } finally { await c.close(); rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(!process.env.MULTIREMI_TEST_POSTGRES_URL)("synchronous PG fence shares the absolute SQL budget and releases real role locks", async () => {
  const database = await openIntegrationDatabase();
  const root = mkdtempSync(join(tmpdir(), "slot-sync-pg-fence-"));
  const a = await child("activate", join(root, "a.db"));
  const b = await child("activate", join(root, "b.db"), "B");
  const sql = new Bun.SQL(database.url!);
  const locks = async () => Number((await sql.unsafe<{ n: number }[]>(
    "SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
  ))[0]!.n);
  try {
    for (const c of [a, b]) await c.send({ op: "database", url: database.url });
    for (const scenario of [
      { budget: 30, sleepMs: 120, queries: 1 },
      { budget: 100, sleepMs: 45, queries: 3 },
      { budget: 10_000, sleepMs: 10_200, queries: 1 },
    ]) {
      await a.send({ op: "timeout", value: scenario.budget });
      await a.send({ op: "fenceDatabase", url: database.url, ...scenario });
      await a.send({ op: "fence", value: "sync-pg" });
      // The default-budget case needs a client timeout beyond ten seconds.
      const started = performance.now();
      const response = await fetch(`${a.url}/internal/slot/activate`, {
        method: "POST", headers: { Authorization: "Bearer control-test" },
        signal: AbortSignal.timeout(scenario.budget + 3000),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ state: "failed" });
      expect(performance.now() - started).toBeLessThan(scenario.budget + 250);
      expect((await fetch(`${a.url}/readyz`)).status).toBe(503);
      expect(await pollUntil(async () => await locks() === 0, 1000)).toBe(true);
      expect((await b.control("activate")).status).toBe(200);
      expect((await b.control("release")).status).toBe(200);
    }
    await a.send({ op: "fence", value: "normal" });
    expect((await a.control("activate")).status).toBe(200);
    expect((await a.control("release")).status).toBe(200);
  } finally {
    await a.close(); await b.close(); await sql.end({ timeout: 1 });
    await database.close(); rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("slot and legacy SIGTERM bound the entire sequence including four post-server disposal steps", async () => {
  await Promise.all(["slot-shutdown", "legacy-shutdown"].map(async mode => {
    const root = mkdtempSync(join(tmpdir(), "slot-total-shutdown-"));
    const c = await child(mode, join(root, "data.db"));
    try {
      if (mode === "slot-shutdown") expect((await c.control("activate")).status).toBe(200);
      const start = performance.now();
      c.process.kill("SIGTERM");
      expect(await Promise.race([c.process.exited, Bun.sleep(28_000).then(() => "timeout")]), c.output()).toBe(1);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeGreaterThan(24_000);
      expect(elapsed).toBeLessThan(28_000);
      expect(c.output()).toContain("disposal:1");
      expect(c.output()).not.toContain("disposal:2");
    } finally { await c.close(); rmSync(root, { recursive: true, force: true }); }
  }));
}, 40_000);

test("every API compose layer and supervisor grace exceeds the single total shutdown budget", () => {
  const composeFiles = [...new Bun.Glob("deploy/**/compose*.yml").scanSync(".")];
  let apiServices = 0;
  for (const path of composeFiles) {
    const text = readFileSync(path, "utf8");
    for (const service of text.split(/\n  (?=[a-z][\w-]*:)/).slice(1)) {
      if (!/^api(?:-runtime)?:/.test(service)) continue;
      apiServices++;
      const seconds = Number(service.match(/stop_grace_period: (\d+)s/)?.[1]);
      expect(seconds * 1000, path).toBeGreaterThan(API_SHUTDOWN_TIMEOUT_MS);
    }
  }
  expect(apiServices).toBeGreaterThanOrEqual(7);
  const supervisor = readFileSync("packages/platform-updater/src/supervisor.mjs", "utf8");
  const grace = Number(supervisor.match(/SIGKILL'[\s\S]*?}, ([\d_]+)\)/)?.[1]?.replaceAll("_", ""));
  expect(grace).toBeGreaterThan(API_SHUTDOWN_TIMEOUT_MS);
});
