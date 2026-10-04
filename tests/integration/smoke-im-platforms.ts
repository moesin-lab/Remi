#!/usr/bin/env bun
/** Real browser -> Next -> HTTP API -> isolated SQLite. Only the external
 * Feishu transport is simulated. No live account or outgoing IM messages.
 * Run: bun run smoke:im [--port=3331]
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { startMultiremiServer } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { MessageProviderRegistry } from "@multiremi/messaging/index.js";
import type { CanonicalMessage, MessageProviderManifest } from "@multiremi/contracts/messaging.js";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: bun run smoke:im [--port=3331]\nOptional CHROME_EXECUTABLE; temporary database and synthetic Feishu transport.");
  process.exit(0);
}
for (const arg of args) assert.match(arg, /^--port=\d+$/, `Unknown argument: ${arg}`);
const port = Number(args.find(arg => arg.startsWith("--port="))?.slice(7) ?? 3331);
assert(Number.isInteger(port) && port > 0 && port < 65536, "Invalid port");
const repo = resolve(import.meta.dir, "../..");
const root = mkdtempSync(join(tmpdir(), "remi-im-fixture-"));
const artifacts = process.env.IM_SMOKE_ARTIFACTS ? resolve(process.env.IM_SMOKE_ARTIFACTS) : mkdtempSync(join(tmpdir(), "remi-im-smoke-"));
mkdirSync(artifacts, { recursive: true });
const frontend = `http://127.0.0.1:${port}`;
const checks: string[] = [], jsErrors: string[] = [], apiFailures: string[] = [];
const tokens: string[] = [];
let next: ChildProcess | null = null, browserWorker: ChildProcess | null = null;
let server: ReturnType<typeof startMultiremiServer> | null = null, db: Database | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null, failure: unknown = null, nextLogs = "";
const check = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
const redact = (text: string) => tokens.reduce((result, token) => result.split(token).join("[redacted]"), text);

class SimulatedFeishu {
  readonly manifest: MessageProviderManifest = {
    provider: "lark_cli", channels: ["feishu"], displayName: "Isolated Feishu transport", authMethods: ["external_tool"],
    capabilities: { pull: false, push: false, searchConversations: true, readConversations: true, send: false, reply: false, attachmentDownload: false, attachmentUpload: false, mention: false, reaction: false, edit: false, recall: false, connectionProvisioning: true, interactiveAuthorization: true },
  };
  async checkHealth() { return { status: "ready" as const, version: "1.0.90", externalAccountId: "ou_fixture", externalAccountName: "Smoke account", errorCode: null, detail: null, checkedAt: new Date().toISOString() }; }
  async searchConversations() { return { conversations: [{ externalConversationId: "oc_smoke", name: "Smoke group", kind: "group" as const, url: null, memberCount: 2, metadata: {} }], cursor: null, done: true }; }
  async getConversation() { return (await this.searchConversations()).conversations[0]!; }
  async provisionConnection() { return { config: { profile: "smoke-only", managedProfile: true } }; }
  async removeConnection() {}
  async beginAuthorization() { return { id: "smoke-authorization", status: "pending" as const, verificationUrl: "https://example.test/im-authorization", userCode: "SMOKE", expiresAt: new Date(Date.now() + 300_000).toISOString(), errorCode: null }; }
  async getAuthorizationSession() { return { ...await this.beginAuthorization(), status: "ready" as const }; }
}

// Isolate the standalone process from deployment config and real credentials.
for (const key of Object.keys(process.env)) if (/^(MULTIREMI_|REMI_|FEISHU_)/.test(key)) delete process.env[key];
process.env.NODE_ENV = "test";
process.env.MULTIREMI_UPLOAD_DIR = join(root, "uploads");
process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

try {
  await new Promise<void>((done, reject) => {
    const probe = createServer(); probe.once("error", reject); probe.listen(port, "127.0.0.1", () => probe.close(error => error ? reject(error) : done()));
  });
  db = openSqliteDatabase(join(root, "im.sqlite"));
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  const owner = store.getOrCreateUser({ name: "IM owner", email: "im-owner@example.test" });
  const workspace = store.createWorkspace({ name: "IM smoke workspace", slug: "im-smoke" }, owner.id);
  const other = store.createWorkspace({ name: "Other workspace", slug: "im-other" }, owner.id);
  const member = store.getOrCreateUser({ name: "IM member", email: "im-member@example.test" });
  store.createWorkspaceMember({ workspaceId: workspace.id, userId: member.id, name: member.name, role: "member" });
  const ownerToken = (await store.createAccessToken({ workspaceId: workspace.id, userId: owner.id, name: "IM browser smoke", type: "pat" })).token;
  const memberToken = (await store.createAccessToken({ workspaceId: workspace.id, userId: member.id, name: "IM member smoke", type: "pat" })).token;
  tokens.push(ownerToken, memberToken);
  const agent = store.createAgent({ workspaceId: workspace.id, ownerId: owner.id, name: "IM Concierge", provider: "codex" });
  const specialist = store.createAgent({ workspaceId: workspace.id, ownerId: owner.id, name: "Group Specialist", provider: "codex" });
  const runtime = store.registerRuntime({ name: "Smoke bot host", provider: "codex", workspaceId: workspace.id, ownerId: owner.id, daemonId: "im-smoke-daemon", status: "online" });
  store.heartbeatRuntime(runtime.id, { supportsFeishuBotConfig: true });
  heartbeat = setInterval(() => store.heartbeatRuntime(runtime.id, { supportsFeishuBotConfig: true }), 10_000);
  const botSecret = "synthetic-im-bot-secret";
  store.upsertFeishuBotConfig(workspace.id, { agentId: agent.id, runtimeId: runtime.id, appId: "cli_im_smoke", domain: "feishu", enabled: false, appSecret: botSecret, appSecretOp: "set" });
  const now = new Date().toISOString(), earlier = new Date(Date.now() - 86_400_000).toISOString();
  for (const [id, name] of [["smoke-one", "Personal connection"], ["smoke-two", "Team connection"]]) {
    store.messaging.upsertConnection({ id: id!, workspaceId: workspace.id, provider: "lark_cli", channel: "feishu", name: name!, status: "ready", lastCheckedAt: now });
  }
  store.messaging.upsertSource({ id: "smoke-source", workspaceId: workspace.id, connectionId: "smoke-one", name: "Engineering feed", enabled: true, allowlist: [{ externalConversationId: "oc_smoke", addedAt: earlier }], createdAt: earlier });
  const message: CanonicalMessage = { externalMessageId: "om_smoke", externalConversationId: "oc_smoke", conversationName: "Smoke group", conversationKind: "group", externalThreadId: null, externalRootId: null, externalParentId: null, sender: { externalSenderId: "ou_test", displayName: "Smoke sender", kind: "user", isSelf: false }, text: "IM refactor message preserved", attachments: [], mentions: [], reactions: [], url: null, sentAt: now, editedAt: null, recalled: false, raw: {} };
  assert.equal(store.messaging.ingestMessages({ connectionId: "smoke-one", sourceId: "smoke-source", messages: [message] }).inserted, 1);
  server = startMultiremiServer({ store, authToken: randomUUID(), hostname: "127.0.0.1", port: 0, backgroundJobs: false, scheduler: null, scmPolling: null, messaging: null, controlPlaneSshMesh: null, messagingProviders: new MessageProviderRegistry([new SimulatedFeishu()]) });
  const backend = `http://127.0.0.1:${server.port}`;
  next = spawn("node", [require.resolve("next/dist/bin/next"), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: join(repo, "frontend/apps/web"), env: { ...process.env, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", REMOTE_API_URL: backend, NEXT_PUBLIC_API_URL: "", NEXT_PUBLIC_WS_URL: "", FRONTEND_PORT: String(port) }, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  next.on("error", error => { nextLogs += `\n${error.message}`; });
  for (const stream of [next.stdout, next.stderr]) stream?.on("data", chunk => { nextLogs = (nextLogs + String(chunk)).slice(-32_000); });
  await poll(async () => {
    assert(next?.exitCode === null, `Next exited: ${redact(nextLogs)}`);
    try { return (await fetch(`${frontend}/api/health`, { signal: AbortSignal.timeout(2000) })).status < 500; } catch { return false; }
  }, 90_000, "Next startup");
  browserWorker = spawn("node", ["--experimental-strip-types", join(repo, "tests/integration/smoke-im-platforms-browser.ts")], {
    cwd: repo, env: { ...process.env, NODE_NO_WARNINGS: "1" }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  browserWorker.stdout!.on("data", chunk => process.stdout.write(redact(String(chunk))));
  browserWorker.stderr!.on("data", chunk => process.stderr.write(redact(String(chunk))));
  const browserResult = new Promise<number | null>((done, reject) => {
    browserWorker!.once("error", reject);
    browserWorker!.once("close", done);
  });
  browserWorker.stdin!.end(JSON.stringify({ frontend, workspace: { id: workspace.id, slug: workspace.slug }, other: { slug: other.slug }, memberToken, ownerToken, artifacts, message: { text: message.text } }));
  const exitCode = await browserResult;
  const browserReport = JSON.parse(readFileSync(join(artifacts, "browser-report.json"), "utf8"));
  checks.push(...browserReport.checks); jsErrors.push(...browserReport.jsErrors); apiFailures.push(...browserReport.apiFailures);
  assert.equal(exitCode, 0, browserReport.error ?? "Browser worker failed");
  assert.equal(store.getFeishuBotConfig(workspace.id)?.appId, "cli_im_updated");
  assert.equal(store.revealFeishuBotSecrets(workspace.id)?.appSecret, botSecret);
  assert.equal(store.getFeishuBotConfig(workspace.id)?.enabled, false);
  assert.equal(store.getFeishuBotConfig(workspace.id)?.senderAccessPolicy, "agent");
  assert(store.listFeishuBotAgentRoutes(workspace.id).some(route => route.agentId === specialist.id));
  check("database retains saved bot, write-only secret, sender policy and agent route");
} catch (error) {
  failure = error;
  console.error(redact(error instanceof Error ? error.stack ?? error.message : String(error)));
  writeFileSync(join(artifacts, "next.log"), redact(nextLogs));
} finally {
  if (heartbeat) clearInterval(heartbeat);
  for (const child of [next, browserWorker]) if (child?.pid) {
    if (process.platform === "win32") {
      // Kill only this harness's process tree, including Next's dev worker.
      await new Promise<void>(done => spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).once("close", () => done()));
    } else {
      try { child === next ? process.kill(-child.pid, "SIGTERM") : child.kill("SIGTERM"); } catch { /* Already exited. */ }
    }
  }
  server?.stop(true); db?.close();
  assert(resolve(root).startsWith(resolve(tmpdir()) + sep) && basename(root).startsWith("remi-im-fixture-"));
  try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  catch { console.warn(`Temporary fixture retained because a database handle is still closing: ${root}`); }
}
const report = { ok: failure === null, checks, artifacts, externalFeishu: "simulated", jsErrors, apiFailures, error: failure instanceof Error ? redact(failure.stack ?? failure.message) : failure };
writeFileSync(join(artifacts, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(failure === null ? 0 : 1);

async function poll(condition: () => boolean | Promise<boolean>, timeout: number, label: string): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await condition())) { assert(Date.now() < deadline, `Timed out: ${label}`); await new Promise(done => setTimeout(done, 100)); }
}
