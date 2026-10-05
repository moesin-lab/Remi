#!/usr/bin/env bun
/** Isolated browser smoke: Next -> HTTP API -> temporary SQLite.
 * Uses synthetic credentials; binding acknowledgements below are simulated.
 * Run: bun run tests/integration/smoke-execution-configuration.ts [--port=3328]
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { startMultiremiServer } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: bun run tests/integration/smoke-execution-configuration.ts [--port=3328]\nOptional: CHROME_EXECUTABLE=/path/to/chrome. No provider credentials required.");
  process.exit(0);
}
for (const arg of args) assert.match(arg, /^--port=\d+$/, `Unknown argument: ${arg}`);
const port = Number(args.find(arg => arg.startsWith("--port="))?.slice(7) ?? 3328);
assert(Number.isInteger(port) && port > 0 && port < 65536, "Invalid frontend port");
const repo = resolve(import.meta.dir, "../..");
const webRoot = join(repo, "frontend/apps/web");
const frontend = `http://127.0.0.1:${port}`;
const root = mkdtempSync(join(tmpdir(), "remi-execution-config-fixture-"));
const artifacts = process.env.EXECUTION_CONFIG_ARTIFACTS ? resolve(process.env.EXECUTION_CONFIG_ARTIFACTS) : mkdtempSync(join(tmpdir(), "remi-execution-config-smoke-"));
mkdirSync(artifacts, { recursive: true });
let next: ChildProcess | null = null;
let nextLogs = "";
let browserHost: ChildProcess | null = null;
let control: ReturnType<typeof Bun.serve> | null = null;
let server: ReturnType<typeof startMultiremiServer> | null = null;
let db: Database | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let failure: unknown = null;
let pat = "";
const redact = (value: string) => pat ? value.split(pat).join("[redacted]") : value;

// This is a standalone process. Ignore host deployment knobs so its API cannot
// load host data or background integrations; fixtures below provide all state.
for (const key of Object.keys(process.env)) if (key.startsWith("MULTIREMI_")) delete process.env[key];
process.env.MULTIREMI_UPLOAD_DIR = join(root, "uploads");
process.env.NODE_ENV = "test";
process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

try {
  await assertPortAvailable(port);
  db = openSqliteDatabase(":memory:");
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  const user = store.getOrCreateUser({ name: "Configuration smoke user", email: "configuration-smoke@example.test" });
  const workspace = store.createWorkspace({ name: "Configuration smoke", slug: "configuration-smoke" }, user.id);
  assert.notEqual(workspace.id, "local");
  const runtime = store.registerRuntime({ name: "Simulated worker (no provider)", provider: "codex", workspaceId: workspace.id, ownerId: user.id, status: "online", maxConcurrency: 1 });
  pat = (await store.createAccessToken({ name: "Isolated browser smoke", type: "pat", workspaceId: workspace.id, userId: user.id })).token;
  server = startMultiremiServer({ store, authToken: randomUUID(), hostname: "127.0.0.1", port: 0, backgroundJobs: false, scheduler: null, scmPolling: null, messaging: null, controlPlaneSshMesh: null });
  heartbeat = setInterval(() => store.heartbeatRuntime(runtime.id, { claimPending: false }), 10_000);
  const backend = `http://127.0.0.1:${server.port}`;
  const env = { ...process.env, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", REMOTE_API_URL: backend, NEXT_PUBLIC_API_URL: "", NEXT_PUBLIC_WS_URL: "", FRONTEND_PORT: String(port) };
  next = spawn("node", [require.resolve("next/dist/bin/next"), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: webRoot, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  next.on("error", error => { nextLogs += `\n${error.message}`; });
  for (const stream of [next.stdout, next.stderr]) stream?.on("data", chunk => { nextLogs = (nextLogs + String(chunk)).slice(-24_000); });
  await poll(async () => {
    assert(next?.exitCode === null, `Next exited: ${redact(nextLogs)}`);
    try { return (await fetch(`${frontend}/api/health`, { signal: AbortSignal.timeout(2000) })).status < 500; } catch { return false; }
  }, 90_000, "Next startup");
  store.registerRuntime({ name: "Other Claude machine", provider: "claude", workspaceId: workspace.id, ownerId: user.id, status: "online" });
  control = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.headers.get("Authorization") !== `Bearer ${pat}`) return new Response(null, { status: 403 });
    if (new URL(request.url).pathname === "/ack" && request.method === "POST") {
      const bindings = await request.json() as any[];
      store.recordRuntimeExecutionBindingAcks(runtime.id, bindings.map(binding => ({ ...binding, status: "ready" })));
      return Response.json({ ok: true });
    }
    const profiles = store.listExecutionProfiles(workspace.id);
    const groups = store.listExecutionGroups(workspace.id);
    return Response.json({ profiles, groups, localProfiles: store.listExecutionProfiles("local"), bindings: store.getRuntimeExecutionBindings(runtime.id), runtimeProfile: store.getRuntimeCodexProfile(runtime.id), members: Object.fromEntries(groups.map(group => [group.id, store.getExecutionGroupMembers(group.id, workspace.id)])), keysMatch: profiles.every(profile => !profile.profile.credential_id || store.getRuntimeCodexProfileKey(runtime.id, profile.profile.credential_id) === "synthetic-smoke-key") });
  } });
  browserHost = spawn("node", ["--experimental-strip-types", join(repo, "tests/integration/execution-configuration-browser.ts")], {
    cwd: repo, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, EXECUTION_SMOKE_INPUT: JSON.stringify({ frontend, workspace, runtime, pat, controlUrl: `http://127.0.0.1:${control.port}`, artifacts, chrome: resolveChrome() }) },
  });
  for (const stream of [browserHost.stdout, browserHost.stderr]) stream?.on("data", chunk => process.stdout.write(redact(String(chunk))));
  const code = await new Promise<number | null>((resolve, reject) => { browserHost!.once("error", reject); browserHost!.once("exit", resolve); });
  assert.equal(code, 0, "Browser E2E failed; see the artifact diagnostics");

} catch (error) {
  failure = error;
  console.error(redact(error instanceof Error ? error.stack ?? error.message : String(error)));
  writeFileSync(join(artifacts, "next-failure.log"), redact(nextLogs));
} finally {
  if (heartbeat) clearInterval(heartbeat);
  if (browserHost?.exitCode === null && browserHost?.signalCode === null) browserHost.kill();
  control?.stop(true);
  if (next?.pid) {
    try { process.kill(process.platform === "win32" ? next.pid : -next.pid, "SIGTERM"); } catch { /* Already exited. */ }
    await poll(() => next?.exitCode !== null || next?.signalCode !== null, 5000, "Next shutdown").catch(() => {
      try { process.kill(process.platform === "win32" ? next!.pid! : -next!.pid!, "SIGKILL"); } catch { /* Already exited. */ }
    });
  }
  server?.stop(true);
  db?.close();
  // Allow asynchronous handles to release the temporary SQLite/upload files on
  // Windows, and never hide the original browser failure behind a cleanup error.
  await poll(() => {
    try { rmSync(root, { recursive: true, force: true }); return true; } catch { return false; }
  }, 5000, "fixture cleanup").catch(error => { failure ??= error; });
}
console.log(JSON.stringify({ ok: failure === null, artifacts, realProvider: false, error: failure instanceof Error ? redact(failure.stack ?? failure.message) : failure }, null, 2));
process.exit(failure === null ? 0 : 1);

async function poll(condition: () => boolean | Promise<boolean>, timeout: number, label: string): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await condition())) {
    assert(Date.now() < deadline, `Timed out waiting for ${label} after ${timeout}ms`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function assertPortAvailable(value: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(value, "127.0.0.1", () => probe.close(error => error ? reject(error) : resolve()));
  });
}

function resolveChrome(): string {
  const configured = process.env.CHROME_EXECUTABLE;
  if (configured) { assert(existsSync(configured), "CHROME_EXECUTABLE does not exist"); return configured; }
  const caches = [join(homedir(), "AppData/Local/ms-playwright"), join(homedir(), "Library/Caches/ms-playwright"), join(homedir(), ".cache/ms-playwright")];
  const suffixes = ["chrome-win/chrome.exe", "chrome-win64/chrome.exe", "chrome-headless-shell-win64/chrome-headless-shell.exe", "chrome-headless-shell-mac-arm64/chrome-headless-shell", "chrome-headless-shell-mac-x64/chrome-headless-shell", "chrome-linux/headless_shell", "chrome-linux64/chrome", "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"];
  for (const cache of caches) {
    if (!existsSync(cache)) continue;
    for (const entry of readdirSync(cache).filter(name => name.startsWith("chromium")).sort().reverse()) {
      for (const suffix of suffixes) { const candidate = join(cache, entry, suffix); if (existsSync(candidate)) return candidate; }
    }
  }
  const installed = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  const chrome = installed.find(existsSync);
  assert(chrome, "No Chromium found; set CHROME_EXECUTABLE");
  return chrome;
}
