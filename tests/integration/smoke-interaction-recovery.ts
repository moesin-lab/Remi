#!/usr/bin/env bun
/** Isolated browser smoke: Next -> HTTP API -> temporary SQLite.
 * Uses synthetic credentials; worker lifecycle below is simulated; all user mutations use the real HTTP API.
 * Run: bun run tests/integration/smoke-interaction-recovery.ts [--port=3348]
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { startMultiremiServer } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: bun run tests/integration/smoke-interaction-recovery.ts [--port=3348]\nOptional: CHROME_EXECUTABLE=/path/to/chrome. No provider credentials required.");
  process.exit(0);
}
for (const arg of args) assert.match(arg, /^--port=\d+$/, `Unknown argument: ${arg}`);
const port = Number(args.find(arg => arg.startsWith("--port="))?.slice(7) ?? 3348);
assert(Number.isInteger(port) && port > 0 && port < 65536, "Invalid frontend port");
const repo = resolve(import.meta.dir, "../..");
const webRoot = join(repo, "frontend/apps/web");
const frontend = `http://127.0.0.1:${port}`;
const root = mkdtempSync(join(tmpdir(), "remi-interaction-recovery-fixture-"));
const artifacts = mkdtempSync(join(tmpdir(), "remi-interaction-recovery-smoke-"));
let next: ChildProcess | null = null;
let nextLogs = "";
let fixtureControl: ReturnType<typeof Bun.serve> | null = null;
let browserHost: ChildProcess | null = null;

let server: ReturnType<typeof startMultiremiServer> | null = null;
let db: Database | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let failure: unknown = null;
let pat = "";
const redact = (value: string) => pat ? value.split(pat).join("[redacted]") : value;

// This is a standalone process. Ignore host deployment knobs so its API cannot
// load host data or background integrations; fixtures below provide all state.
for (const key of Object.keys(process.env)) if (key.startsWith("MULTIREMI_") || key.startsWith("REMI_")) delete process.env[key];
process.env.MULTIREMI_UPLOAD_DIR = join(root, "uploads");
process.env.NODE_ENV = "test";
process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

try {
  await assertPortAvailable(port);
  db = openSqliteDatabase(join(root, "interaction.sqlite"));
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  const user = store.getOrCreateUser({ name: "Interaction smoke user", email: "interaction-smoke@example.test" });
  const workspace = store.createWorkspace({ name: "Interaction smoke", slug: "interaction-smoke" }, user.id);
  assert.notEqual(workspace.id, "local");
  const runtime = store.registerRuntime({ name: "Simulated worker (no provider)", provider: "codex", workspaceId: workspace.id, ownerId: user.id, status: "online", maxConcurrency: 1, metadata: { cli_version: "0.2.85", issue_workspaces: 1, parallel_agent_execution: 1 } });
  const agent = store.createAgent({ name: "Recovery Agent", provider: "codex", workspaceId: workspace.id, ownerId: user.id, runtimeId: runtime.id });
  const changedAssignee = store.createAgent({ name: "New assignee", provider: "codex", workspaceId: workspace.id, ownerId: user.id, runtimeId: runtime.id });
  pat = (await store.createAccessToken({ name: "Isolated browser smoke", type: "pat", workspaceId: workspace.id, userId: user.id })).token;
  server = startMultiremiServer({ store, authToken: randomUUID(), hostname: "127.0.0.1", port: 0, backgroundJobs: false, scheduler: null, scmPolling: null, messaging: null, controlPlaneSshMesh: null });
  heartbeat = setInterval(() => store.heartbeatRuntime(runtime.id, { claimPending: false }), 10_000);
  const backend = `http://127.0.0.1:${server.port}`;
  const env = { ...process.env, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", REMOTE_API_URL: backend, NEXT_PUBLIC_API_URL: "", NEXT_PUBLIC_WS_URL: "", FRONTEND_PORT: String(port) };
  next = spawn("node", [require.resolve("next/dist/bin/next"), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: webRoot, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  next.on("error", error => { nextLogs += `\n${error.message}`; });
  for (const stream of [next.stdout, next.stderr]) stream?.on("data", chunk => { nextLogs = (nextLogs + String(chunk)).slice(-24_000); });
  await poll(async () => {
    assert(next?.exitCode === null, `Next exited: ${redact(nextLogs)}`);
    try { return (await fetch(`${frontend}/api/health`, { signal: AbortSignal.timeout(2000) })).status < 500; } catch { return false; }
  }, 90_000, "Next startup");

  const controlToken = randomUUID();
  const methods = {
    getTask: store.getTask.bind(store), getIssue: store.getIssue.bind(store), listTasksForIssue: store.listTasksForIssue.bind(store),
    cancelTask: store.cancelTask.bind(store), createIssue: store.createIssue.bind(store), createTask: store.createTask.bind(store),
    claimTask: store.claimTask.bind(store), startTask: store.startTask.bind(store), failTask: store.failTask.bind(store),
    completeTask: store.completeTask.bind(store), listIssues: store.listIssues.bind(store),
  };
  // This endpoint exists only in the standalone fixture, bound to loopback and
  // protected with an ephemeral token passed to the browser runner over stdin.
  fixtureControl = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "POST" || request.headers.get("authorization") !== "Bearer " + controlToken) return new Response(null, { status: 403 });
    const body = await request.json() as { method: keyof typeof methods; args: unknown[] };
    if (!Object.hasOwn(methods, body.method) || !Array.isArray(body.args)) return new Response(null, { status: 400 });
    try { return Response.json(Reflect.apply(methods[body.method], undefined, body.args) ?? null); }
    catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
  } });
  console.log("Starting isolated Node/Chromium browser runner");
  browserHost = spawn("node", [join(repo, "tests/integration/interaction-recovery-browser.mjs")], { cwd: repo, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  browserHost.stdout?.on("data", chunk => process.stdout.write(chunk));
  browserHost.stderr?.on("data", chunk => process.stderr.write(chunk));
  browserHost.stdin?.end(JSON.stringify({ user, workspace, runtime, agent, changedAssignee, frontend, artifacts, pat, controlUrl: "http://127.0.0.1:" + fixtureControl.port, controlToken }));
  const result = await new Promise<number | null>((resolve, reject) => { browserHost!.once("error", reject); browserHost!.once("close", resolve); });
  assert.equal(result, 0, "Browser acceptance failed; inspect " + artifacts);
} catch (error) {
  failure = error;
  console.error(redact(String(error)));
  writeFileSync(join(artifacts, "next-failure.log"), redact(nextLogs));
} finally {
  if (heartbeat) clearInterval(heartbeat);
  for (const child of [browserHost, next]) {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) continue;
    if (process.platform === "win32") {
      const stop = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      await new Promise(resolve => stop.once("close", resolve));
    } else {
      try { process.kill(child === next ? -child.pid : child.pid, "SIGTERM"); } catch { /* Already exited. */ }
    }
  }
  fixtureControl?.stop(true);
  server?.stop(true);
  try { db?.close(true); } catch { /* Windows may retain statements until this process exits. */ }
  assert.equal(resolve(root, ".."), resolve(tmpdir()), "Fixture cleanup must stay within temp directory");
  assert(root.split(/[\\/]/).at(-1)?.startsWith("remi-interaction-recovery-fixture-"));
  try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  catch (error) { console.warn("Fixture retained for cleanup after process exit: " + root + " (" + String(error) + ")"); }
}
console.log("Acceptance artifacts: " + artifacts);
process.exit(failure === null ? 0 : 1);

async function poll(condition: () => boolean | Promise<boolean>, timeout: number, label: string): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await condition())) {
    assert(Date.now() < deadline, "Timed out waiting for " + label);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function assertPortAvailable(value: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer(); probe.once("error", reject);
    probe.listen(value, "127.0.0.1", () => probe.close(error => error ? reject(error) : resolve()));
  });
}
