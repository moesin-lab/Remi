#!/usr/bin/env bun
/** Isolated browser smoke: Next -> HTTP API -> temporary SQLite.
 * Uses synthetic credentials; binding acknowledgements below are simulated.
 * Run: bun run tests/integration/smoke-execution-configuration.ts [--port=3328]
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { chromium, type Browser, type Page } from "playwright-core";
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
const artifacts = mkdtempSync(join(tmpdir(), "remi-execution-config-smoke-"));
const checks: string[] = [];
const apiFailures: string[] = [];
const jsErrors: string[] = [];
let next: ChildProcess | null = null;
let nextLogs = "";
let browser: Browser | null = null;
let page: Page | null = null;
let server: ReturnType<typeof startMultiremiServer> | null = null;
let db: Database | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let failure: unknown = null;
let pat = "";
const check = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
const redact = (value: string) => pat ? value.split(pat).join("[redacted]") : value;

// This is a standalone process. Ignore host deployment knobs so its API cannot
// load host data or background integrations; fixtures below provide all state.
for (const key of Object.keys(process.env)) if (key.startsWith("MULTIREMI_")) delete process.env[key];
process.env.MULTIREMI_UPLOAD_DIR = join(root, "uploads");
process.env.NODE_ENV = "test";
process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

try {
  await assertPortAvailable(port);
  db = new Database(join(root, "configuration.sqlite"));
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
  browser = await chromium.launch({ executablePath: resolveChrome(), headless: true, args: ["--disable-dev-shm-usage"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US" });
  await context.addCookies([
    { name: "multimira_logged_in", value: "1", url: frontend },
    { name: "multimira_auth", value: pat, url: frontend, httpOnly: true },
    { name: "last_workspace_slug", value: workspace.slug, url: frontend },
    { name: "multimira-locale", value: "en", url: frontend },
  ]);
  await context.addInitScript(token => localStorage.setItem("multimira_token", token), pat);
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", error => jsErrors.push(redact(error.message)));
  page.on("response", response => {
    if (response.url().startsWith(`${frontend}/api/`) && response.status() >= 500 && response.headers()["x-configuration-smoke-injected-fault"] !== "1") apiFailures.push(`${new URL(response.url()).pathname} ${response.status()}`);
  });

  store.registerRuntime({ name: "Other Claude machine", provider: "claude", workspaceId: workspace.id, ownerId: user.id, status: "online" });
  assert.equal(store.listExecutionGroups(workspace.id).length, 0);
  await page.goto(`${frontend}/${workspace.slug}/runtimes/configuration`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByRole("button", { name: "Add profile", exact: true }).waitFor();
  await page.getByText("No capability groups assigned.", { exact: true }).waitFor();
  await page.locator("button").filter({ has: page.locator("svg.lucide-minus") }).click();
  check("non-local workspace loads; discovery creates no capability groups");

  const submit = async (method: string, path: string, status: number) => {
    const response = page!.waitForResponse(r => r.request().method() === method && new URL(r.url()).pathname === path);
    await page!.locator("form").getByRole("button", { name: "Save connection", exact: true }).click();
    const result = await response;
    assert.equal(result.status(), status, await result.text());
    await page!.locator("form").waitFor({ state: "detached" });
    return result.json();
  };
  const createProfile = async (name: string, model: string) => {
    await page!.getByRole("button", { name: "Add profile", exact: true }).click();
    const form = page!.locator("form");
    await form.getByLabel("Name", { exact: true }).fill(name);
    await form.getByLabel("API base URL", { exact: true }).fill("https://example.test/v1");
    await form.getByLabel("Model ID", { exact: true }).fill(model);
    await form.getByLabel("API key", { exact: true }).fill("synthetic-smoke-key");
    const result = await submit("POST", "/api/execution-profiles", 201);
    assert(!JSON.stringify(result).includes("synthetic-smoke-key"));
    return result.profile;
  };
  const a = await createProfile("Gateway A", "model-a");
  const b = await createProfile("Gateway B", "model-b");
  assert.equal(store.listExecutionProfiles(workspace.id).length, 2);
  assert.equal(store.listExecutionProfiles("local").length, 0);
  check("two reusable profiles persist in selected workspace; secrets never return in API responses");
  const createGroup = async (name: string, profileId: string) => {
    await page!.getByRole("button", { name: "Add group", exact: true }).click();
    const form = page!.locator("form");
    await form.getByLabel("Name", { exact: true }).fill(name);
    await form.getByRole("combobox", { name: /^Connection profiles/ }).selectOption(profileId);
    assert.equal(await form.getByLabel("Other Claude machine", { exact: true }).count(), 0);
    await form.getByLabel(runtime.name, { exact: true }).check();
    return (await submit("POST", "/api/execution-groups", 201)).group;
  };
  const ga = await createGroup("Group A", a.id);
  const gb = await createGroup("Group B", b.id);
  assert.equal(store.getRuntimeExecutionBindings(runtime.id).length, 2);
  await page.getByText("Pending", { exact: true }).first().waitFor();
  const profileRow = (name: string) => page!.locator("section").first().locator(":scope > div").filter({ has: page!.getByText(name, { exact: true }) });
  assert(await profileRow("Gateway A").getByRole("button", { name: "Delete", exact: true }).isDisabled());
  check("one runtime accepts two profile groups; mismatched engines hidden; bound profiles cannot be deleted");

  const oldBindings = store.getRuntimeExecutionBindings(runtime.id);
  store.recordRuntimeExecutionBindingAcks(runtime.id, oldBindings.map(binding => ({ ...binding, status: "ready" })));
  await poll(async () => await page!.getByText("Applied", { exact: true }).count() === 2, 20_000, "ready status polling");
  check("simulated daemon acknowledgements refresh both groups to Applied without reload");
  await profileRow("Gateway A").getByRole("button", { name: "Edit", exact: true }).click();
  assert.equal(await page.locator("form").getByLabel("API key", { exact: true }).inputValue(), "");
  await page.locator("form").getByLabel("Model ID", { exact: true }).fill("model-a-next");
  const updated = (await submit("PUT", `/api/execution-profiles/${a.id}`, 200)).profile;
  assert.equal(updated.revision, 2);
  assert.equal(store.getRuntimeCodexProfileKey(runtime.id, updated.profile.credential_id), "synthetic-smoke-key");
  store.recordRuntimeExecutionBindingAcks(runtime.id, oldBindings.map(binding => ({ ...binding, status: "ready" })));
  assert(!store.isRuntimeExecutionBindingReady(ga.id, runtime.id, a.id, 2));
  await page.getByText("Pending", { exact: true }).waitFor();
  const currentBindings = store.getRuntimeExecutionBindings(runtime.id);
  store.recordRuntimeExecutionBindingAcks(runtime.id, currentBindings.map(binding => ({ ...binding, status: "ready" })));
  await poll(async () => await page!.getByText("Applied", { exact: true }).count() === 2, 20_000, "new revision ready");
  check("editing retains hidden key, increments revision, rejects old acknowledgement, and reapplies");
  await page.screenshot({ path: join(artifacts, "configuration-desktop.png"), fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth);
  await page.screenshot({ path: join(artifacts, "configuration-mobile.png"), fullPage: false });
  check("390px mobile configuration fits viewport");
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const [name, id] of [["Group A", ga.id], ["Group B", gb.id]]) {
    const row = page.locator("section").filter({ has: page.getByRole("heading", { name: "Capability groups", exact: true }) }).locator(":scope > div").filter({ has: page!.getByText(name, { exact: true }) });
    const response = page.waitForResponse(r => r.request().method() === "DELETE" && new URL(r.url()).pathname === `/api/execution-groups/${id}`);
    await row.getByRole("button", { name: "Delete", exact: true }).click();
    assert.equal((await response).status(), 200);
    await page.getByText(name, { exact: true }).waitFor({ state: "detached" });
  }
  for (const profile of [a, b]) {
    const response = page.waitForResponse(r => r.request().method() === "DELETE" && new URL(r.url()).pathname === `/api/execution-profiles/${profile.id}`);
    await profileRow(profile.name).getByRole("button", { name: "Delete", exact: true }).click();
    assert.equal((await response).status(), 200);
    await page.getByText(profile.name, { exact: true }).waitFor({ state: "detached" });
  }
  assert.equal(store.listExecutionGroups(workspace.id).length, 0);
  assert.equal(store.listExecutionProfiles(workspace.id).length, 0);
  check("deleting groups unbinds runtimes and allows profile deletion");
  assert.deepEqual(apiFailures, []);
  assert.deepEqual(jsErrors, []);
  check("no uncaught browser errors or API 5xx");
} catch (error) {
  failure = error;
  if (page) await page.screenshot({ path: join(artifacts, "configuration-failure.png"), fullPage: false }).catch(() => {});
  if (page) writeFileSync(join(artifacts, "failure-dom.txt"), redact(await page.locator("body").innerText().catch(() => "")));
  writeFileSync(join(artifacts, "next-failure.log"), redact(nextLogs));
} finally {
  if (heartbeat) clearInterval(heartbeat);
  await browser?.close().catch(() => {});
  if (next?.pid) {
    try { process.kill(process.platform === "win32" ? next.pid : -next.pid, "SIGTERM"); } catch { /* Already exited. */ }
    await poll(() => next?.exitCode !== null || next?.signalCode !== null, 5000, "Next shutdown").catch(() => {
      try { process.kill(process.platform === "win32" ? next!.pid! : -next!.pid!, "SIGKILL"); } catch { /* Already exited. */ }
    });
  }
  server?.stop(true);
  db?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
console.log(JSON.stringify({ ok: failure === null, checks, artifacts, realProvider: false, apiFailures, jsErrors, error: failure instanceof Error ? redact(failure.stack ?? failure.message) : failure }, null, 2));
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
  const caches = [join(homedir(), "Library/Caches/ms-playwright"), join(homedir(), ".cache/ms-playwright")];
  const suffixes = ["chrome-headless-shell-mac-arm64/chrome-headless-shell", "chrome-headless-shell-mac-x64/chrome-headless-shell", "chrome-linux/headless_shell", "chrome-linux64/chrome", "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"];
  for (const cache of caches) {
    if (!existsSync(cache)) continue;
    for (const entry of readdirSync(cache).filter(name => name.startsWith("chromium")).sort().reverse()) {
      for (const suffix of suffixes) { const candidate = join(cache, entry, suffix); if (existsSync(candidate)) return candidate; }
    }
  }
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  assert(existsSync(chrome), "No Chromium found; set CHROME_EXECUTABLE");
  return chrome;
}
