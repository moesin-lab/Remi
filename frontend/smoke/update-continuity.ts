/**
 * bun --tsconfig-override tsconfig.json frontend/smoke/update-continuity.ts
 * Isolated real API child, SQLite, two standalone builds and Chromium.
 * Uses 14341/14342 by default; never production profiles or daemon services.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
const repo = resolve(import.meta.dir, "../..");
const root = mkdtempSync(join(tmpdir(), "remi-update-smoke-"));
const webDir = join(repo, "frontend/apps/web");
const apiPort = Number(process.env.UPDATE_SMOKE_API_PORT ?? 14341);
const webPort = Number(process.env.UPDATE_SMOKE_WEB_PORT ?? 14342);
assert(![6131, 6132, 6133, 6134].includes(apiPort) && ![6131, 6132, 6133, 6134].includes(webPort));
const web = `http://127.0.0.1:${webPort}`;
const children = new Set<ChildProcess>();
const checks: string[] = [];
function child(command: string, args: string[], env = process.env, cwd = repo) {
  const process = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  children.add(process); process.once("exit", () => children.delete(process));
  return process;
}
function lineChannel(process: ChildProcess) {
  const queued: string[] = []; const waits: Array<(line: string) => void> = [];
  createInterface({ input: process.stdout! }).on("line", line => {
    if (line.startsWith("SMOKE_") || /^(BROWSER_|prepare-|PENDING_|SENT_|swap-|BUILD_)/.test(line)) {
      const waiting = waits.shift(); if (waiting) waiting(line); else queued.push(line);
    }
  });
  return () => new Promise<string>((resolve, reject) => {
    if (queued.length) { resolve(queued.shift()!); return; }
    const timer = setTimeout(() => reject(new Error("Child protocol timed out")), 120_000);
    timer.unref();
    waits.push(line => { clearTimeout(timer); resolve(line); });
    process.once("exit", code => { if (code !== 0) reject(new Error(`Child exited ${code}`)); });
  });
}
async function stop(process: ChildProcess) {
  if (process.exitCode !== null) return;
  const done = new Promise(resolve => process.once("exit", resolve)); process.kill("SIGTERM"); await done;
}
async function api() {
  const process = child(Bun.which("bun") ?? globalThis.process.execPath, ["--tsconfig-override", join(repo, "tsconfig.json"), join(repo, "frontend/smoke/update-api.ts"), root, String(apiPort)]);
  process.stderr!.on("data", data => writeFileSync(join(root, "api.log"), data, { flag: "a" }));
  const read = lineChannel(process); assert.equal(await read(), "SMOKE_READY"); return { process, read };
}
async function build(id: string) {
  const process = child("node", [join(repo, "node_modules/next/dist/bin/next"), "build", "--webpack"], { ...globalThis.process.env, STANDALONE: "true", NEXT_BUILD_CPUS: "2", NEXT_TELEMETRY_DISABLED: "1", REMI_WEB_BUILD_ID: `mul34-build-${id}`, REMOTE_API_URL: `http://127.0.0.1:${apiPort}` }, webDir);
  for (const stream of [process.stdout!, process.stderr!]) stream.on("data", data => writeFileSync(join(root, `build-${id}.log`), data, { flag: "a" }));
  const code = await new Promise(resolve => process.once("exit", resolve)); assert.equal(code, 0, `build ${id}: ${join(root, `build-${id}.log`)}`);
  const target = join(root, `build-${id}`); cpSync(join(webDir, ".next/standalone"), target, { recursive: true });
  const app = join(target, "frontend/apps/web");
  cpSync(join(webDir, ".next/static"), join(app, ".next/static"), { recursive: true });
  cpSync(join(webDir, "public"), join(app, "public"), { recursive: true });
  return join(app, "server.js");
}
async function serve(path: string) {
  const process = child("node", [path], { ...globalThis.process.env, PORT: String(webPort), HOSTNAME: "127.0.0.1", REMOTE_API_URL: `http://127.0.0.1:${apiPort}` }, dirname(path));
  for (const stream of [process.stdout!, process.stderr!]) stream.on("data", data => writeFileSync(join(root, "web.log"), data, { flag: "a" }));
  for (let i = 0; i < 120; i++) {
    if (await fetch(`${web}/health/build`).then(r => r.ok).catch(() => false)) return process;
    await Bun.sleep(500);
  }
  throw new Error("Standalone Web did not start");
}
let failure: unknown;
try {
  for (const port of [apiPort, webPort]) await new Promise<void>((resolve, reject) => {
    const probe = createServer(); probe.once("error", reject); probe.listen(port, "127.0.0.1", () => probe.close(error => error ? reject(error) : resolve()));
  });
  console.log(`Artifacts: ${root}`);
  let backend = await api();
  const a = await build("a"); console.log("Built A");
  const b = await build("b"); console.log("Built B");
  let frontend = await serve(a);
  const identity = await fetch(`${web}/health/build`);
  assert.equal(identity.headers.get("cache-control"), "no-store"); assert.deepEqual(await identity.json(), { build_id: "mul34-build-a" });
  checks.push("standalone A build endpoint is reachable with no-store");
  const fixture = JSON.parse(readFileSync(join(root, "fixture.json"), "utf8"));
  const browser = child("node", ["--experimental-strip-types", join(repo, "frontend/smoke/update-browser.ts")]);
  browser.stderr!.on("data", data => writeFileSync(join(root, "browser.log"), data, { flag: "a" }));
  const read = lineChannel(browser); browser.stdin!.write(JSON.stringify({ ...fixture, web, artifacts: root }) + "\n");
  assert.equal(await read(), "BROWSER_READY");
  for (const mode of ["gate", "restart"]) {
    assert.equal(await read(), `prepare-${mode}`);
    if (mode === "gate") { backend.process.stdin!.write("gate\n"); assert.equal(await backend.read(), "SMOKE_GATED"); }
    else await stop(backend.process);
    browser.stdin!.write(`prepare-${mode}\n`);
    assert.equal(await read(), `PENDING_${mode}`);
    await Bun.sleep(mode === "gate" ? 25_000 : 6_000);
    if (mode === "gate") { backend.process.stdin!.write("release\n"); assert.equal(await backend.read(), "SMOKE_RELEASED"); }
    else backend = await api();
    assert.equal(await read(), `SENT_${mode}`);
    const db = new Database(join(root, "smoke.sqlite"), { readonly: true });
    const row = db.query("SELECT count(*) AS total FROM multiremi_conversation_log WHERE session_id = ? AND body_md = ?").get(fixture.sessionId, `continuity-${mode}`) as { total: number };
    assert.equal(row.total, 1); db.close();
    checks.push(`${mode}: pending UI, restored delivery, exactly one SQLite row, no error UI`); console.log(`PASS ${checks.at(-1)}`);
  }
  assert.equal(await read(), "swap-build"); await stop(frontend); frontend = await serve(b);
  browser.stdin!.write("swap-build\n"); assert.equal(await read(), "BUILD_B_OK");
  checks.push("A tab reaches B on first navigation via document request; no chunk/page errors");
  browser.stdin!.end(); assert.equal(await new Promise(resolve => browser.once("exit", resolve)), 0);
} catch (error) { failure = error; console.error(error); }
finally {
  for (const process of [...children]) await stop(process);
  writeFileSync(join(root, "result.json"), JSON.stringify({ checks, passed: !failure, error: failure ? String(failure) : null }, null, 2));
  console.log(`Result: ${join(root, "result.json")}`);
}
if (failure) process.exitCode = 1;
