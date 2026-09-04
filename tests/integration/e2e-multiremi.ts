#!/usr/bin/env bun
/**
 * Full-stack e2e for the native Multiremi API + daemon.
 *
 * Boots a real `startMultiremiServer` (open local mode) on an isolated temp DB,
 * seeds an agent, and runs a REAL agent task to completion through the daemon.
 * The D11 frontend is a separate app and is covered by `e2e:frontend`; this test
 * asserts:
 *   - the API service descriptor is served at `/`
 *   - every endpoint the frontend loads on boot returns 200
 *   - a real agent task completes end-to-end (provider transcript + marker)
 *   - seeded data and an API write round-trip correctly
 *
 * Usage: bun run tests/integration/e2e-multiremi.ts [--provider=claude|codex|grok] [--port=6191] [--executable=/path/to/provider]
 */
import "@shared/db/sqlite-custom.js"; // must be first: swaps sqlite before any Database
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setDbPath } from "@shared/db/index.js";
import { startMultiremiServer } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { MultiremiDaemon } from "@multiremi/daemon.js";

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) args.set(m[1], m[2]);
}
const SUPPORTED_PROVIDERS = ["claude", "codex", "grok"] as const;
type E2EProvider = typeof SUPPORTED_PROVIDERS[number];
const providerArg = args.get("provider") || "claude";
if (!SUPPORTED_PROVIDERS.includes(providerArg as E2EProvider)) {
  throw new Error(`Unsupported provider: ${providerArg}. Expected one of: ${SUPPORTED_PROVIDERS.join(", ")}`);
}
const PROVIDER = providerArg as E2EProvider;
const EXECUTABLE = args.get("executable") || null;
const PORT = Number(args.get("port") || 6191);
const MARKER = "__E2E_OK__";

const checks: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
}

async function main() {
  const dbDir = mkdtempSync(join(tmpdir(), "multiremi-e2e-db-"));
  const workDir = mkdtempSync(join(tmpdir(), "multiremi-e2e-work-"));
  setDbPath(join(dbDir, "e2e.db"));
  const store = new MultiremiStore();

  const agent = store.createAgent({
    name: "E2E Smoke Agent",
    provider: PROVIDER,
    executable: EXECUTABLE,
    model: null,
    allowedTools: [],
  });
  // Seed an issue to verify the read API against known data.
  const issue = store.createIssue({
    workspaceId: "local",
    title: "E2E seeded issue",
    description: "Created by the e2e harness",
  });

  const server = startMultiremiServer({ store, scheduler: null, hostname: "127.0.0.1", port: PORT });
  const base = `http://127.0.0.1:${PORT}`;

  try {
    // ───────────────────────── API e2e ─────────────────────────
    const rootRes = await fetch(base + "/");
    const rootJson = await rootRes.json() as { service?: string; ui?: string };
    check("GET / reports the API service and frontend location",
      rootRes.ok && rootJson.service === "multiremi-api" && rootJson.ui === "frontend/apps/web",
      `status=${rootRes.status} body=${JSON.stringify(rootJson)}`);

    const loadEndpoints = [
      "/api/multiremi/agents", "/api/multiremi/issues", "/api/multiremi/tasks",
      "/api/multiremi/runtimes", "/api/multiremi/members", "/api/multiremi/projects",
      "/api/multiremi/squads", "/api/multiremi/autopilots", "/api/multiremi/skills",
      "/api/multiremi/tokens", "/api/multiremi/notification-preferences",
      "/api/multiremi/chats", "/api/multiremi/inbox",
      "/api/multiremi/labels", "/api/multiremi/pins", "/api/dashboard/usage/daily",
      "/api/dashboard/usage/by-agent", "/api/dashboard/runtime/daily",
    ];
    let allOk = true;
    const bad: string[] = [];
    for (const ep of loadEndpoints) {
      const r = await fetch(base + ep);
      if (!r.ok) { allOk = false; bad.push(`${ep}=${r.status}`); }
    }
    check(`all ${loadEndpoints.length} frontend-load endpoints return 200`, allOk, bad.join(" "));

    const agentsJson = await (await fetch(base + "/api/multiremi/agents")).json();
    check("seeded agent present via API", (agentsJson.agents || []).some((a: any) => a.id === agent.id));
    const issuesJson = await (await fetch(base + "/api/multiremi/issues")).json();
    check("seeded issue present via API", (issuesJson.issues || []).some((i: any) => i.id === issue.id));

    // Real agent run: create a task, run the daemon once against the live provider.
    const task = store.createTask({
      agentId: agent.id,
      prompt: `Reply with exactly the token ${MARKER} and nothing else. Do not use any tools.`,
      workspaceId: "local",
      workDir,
    });
    const daemonToken = await store.createAccessToken({ name: "e2e daemon", type: "daemon", workspaceId: "local" });
    const daemon = new MultiremiDaemon({
      serverUrl: base,
      token: daemonToken.token,
      provider: PROVIDER,
      runtimeName: "e2e-runtime",
      workspaceId: "local",
      once: true,
      taskTimeoutMs: 120_000,
    });
    await daemon.start();
    const done = store.getTask(task.id);
    check("real agent task completed", done?.status === "completed",
      `status=${done?.status} reason=${done?.failureReason || ""}`);
    check(`agent output contains marker ${MARKER}`, String(done?.result || "").includes(MARKER),
      `output=${JSON.stringify(done?.result || "").slice(0, 80)}`);
    const messages = store.listTaskMessages(task.id);
    check("agent transcript has a text message",
      messages.some((m) => m.type === "text" || m.type === "assistant"),
      `types=${[...new Set(messages.map((m) => m.type))].join(",")}`);
    const persistedUsage = done?.usage ?? [];
    check("agent usage is persisted on the task",
      persistedUsage.some((entry) => entry.provider === PROVIDER
        && ((entry.totalTokens ?? 0) > 0 || entry.inputTokens + entry.outputTokens > 0)),
      `usage=${JSON.stringify(persistedUsage)}`);

    // Preserve a write round-trip in this self-contained API+daemon harness. Browser
    // rendering belongs to the separately hosted D11 frontend's e2e suite.
    const newTitle = "E2E live-refresh issue " + task.id.slice(-6);
    const createRes = await fetch(base + "/api/multiremi/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "local", title: newTitle }),
    });
    check("POST /api/multiremi/issues creates issue", createRes.ok, `status=${createRes.status}`);
    const refreshedIssues = await (await fetch(base + "/api/multiremi/issues")).json();
    check("created issue is readable through the API",
      (refreshedIssues.issues || []).some((item: any) => item.title === newTitle));
  } finally {
    server.stop(true);
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${failed.length === 0 ? "✅ ALL PASS" : "❌ " + failed.length + " FAILED"} (${checks.length} checks, provider=${PROVIDER})`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error("E2E harness error:", e); process.exit(1); });
