import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMultiremiApp } from "@multiremi/api.js";
import { readCurrentDaemonBuild, reconcileCurrentDaemonBuild } from "@multiremi/releases/current-daemon-build.js";
import { runtimeCompatibilityResponse } from "@multiremi/api/wire/runtimes.js";
import { createFreshStore, createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";
import { MultiremiStore } from "@multiremi/store.js";

const A = "a".repeat(40), B = "b".repeat(40);
const version = "0.2.95-stable.aaaaaaaa";
const previousTargets = process.env.MULTIREMI_DAEMON_UPDATE_FAILURE_TARGETS;
afterEach(() => {
  if (previousTargets === undefined) delete process.env.MULTIREMI_DAEMON_UPDATE_FAILURE_TARGETS;
  else process.env.MULTIREMI_DAEMON_UPDATE_FAILURE_TARGETS = previousTargets;
  resetMultiremiTestEnv();
});
function runtime(store: MultiremiStore, id = "rt_build", metadata: Record<string, unknown> = {}) {
  return store.registerRuntime({ id, name: id, provider: "codex", daemonId: "dm_build", metadata: { cli_version: "99.0.0", cli_commit: B, ...metadata } });
}

describe("deployment CLI identity reconciliation", () => {
  it("queues a deployment build even from a newer version and sends target_commit through the downlink", () => {
    const store = createLocalStore(); runtime(store);
    const [request] = store.reconcileRuntimeCliRelease(version, A);
    expect(request).toMatchObject({ targetVersion: version, targetCommit: A, target_commit: A, scope: "cli" });
    expect(store.getDaemonDrainStatus("local", "dm_build")).toMatchObject({ reason: "cli_update", mode: "draining" });
    expect(store.pendingRuntimeRequests("rt_build")).toContainEqual({ kind: "update", id: request!.id,
      payload: { id: request!.id, target_version: version, target_commit: A, scope: "cli" } });
    expect(store.reconcileRuntimeCliRelease(version, A)).toEqual([]);
  });
  it("skips matching commits and falls back to exact version only for old daemons", () => {
    const store = createLocalStore(); runtime(store, "rt_build", { cli_commit: A, cli_version: "1.0.0" });
    expect(store.reconcileRuntimeCliRelease(version, A)).toEqual([]);
    store.updateRuntime("rt_build", { metadata: { cli_commit: null, cli_version: version } });
    expect(store.reconcileRuntimeCliRelease(version, A)).toEqual([]);
    store.updateRuntime("rt_build", { metadata: { cli_commit: null, cli_version: "99.0.0" } });
    expect(store.reconcileRuntimeCliRelease(version, A)).toHaveLength(1);
  });
  for (const status of ["failed", "rolled_back", "timeout"] as const) it(`never retries ${status} for a commit, but queues a new commit`, () => {
    const store = createLocalStore(); runtime(store);
    const [request] = store.reconcileRuntimeCliRelease(version, A);
    db!.run("UPDATE multiremi_runtime_update_requests SET status = ? WHERE id = ?", [status, request!.id]);
    expect(store.reconcileRuntimeCliRelease(version, A)).toEqual([]);
    // A deliberate rollback/new platform identity is permitted, regardless of version order.
    const [next] = store.reconcileRuntimeCliRelease("0.1.0+main.cccc", "c".repeat(40));
    expect(next?.targetCommit).toBe("c".repeat(40));
  });
  it("skips offline and desktop daemons, and groups providers by physical daemon", () => {
    const store = createLocalStore(); runtime(store);
    store.registerRuntime({ id: "rt_other", name: "other", provider: "claude", daemonId: "dm_build", metadata: { cli_commit: B } });
    store.registerRuntime({ id: "rt_desktop", name: "desktop", provider: "codex", daemonId: "dm_desktop", metadata: { launched_by: "desktop" } });
    store.registerRuntime({ id: "rt_offline", name: "offline", provider: "codex", daemonId: "dm_offline" });
    db!.run("UPDATE multiremi_runtimes SET status = 'offline', last_heartbeat_at = NULL WHERE id = 'rt_offline'");
    expect(store.reconcileRuntimeCliRelease(version, A).map(r => r.runtimeId)).toEqual(["rt_other"]);
  });
  it("an active sibling request, including non-CLI scope, prevents another queue entry", () => {
    const store = createLocalStore(); runtime(store);
    store.registerRuntime({ id: "rt_other", name: "other", provider: "codex", daemonId: "dm_build" });
    store.createRuntimeUpdateRequest("rt_other", { scope: "acp", targetVersion: "latest" });
    expect(store.reconcileRuntimeCliRelease(version, A)).toEqual([]);
  });
  it("keeps the formal SemVer path and its historical idempotency", () => {
    const store = createLocalStore(); runtime(store, "rt_build", { cli_version: "0.2.94" });
    const [request] = store.reconcileRuntimeCliRelease("v0.2.95");
    expect(request?.targetVersion).toBe("0.2.95");
    expect(request?.targetCommit).toBeNull();
    store.reportRuntimeUpdateResult("rt_build", request!.id, { status: "failed" });
    expect(store.reconcileRuntimeCliRelease("0.2.95")).toEqual([]);
    expect(store.reconcileRuntimeCliRelease(version)).toEqual([]);
  });
  it("the build key changes with commit even when version is unchanged", () => {
    const store = createLocalStore(); runtime(store);
    expect(store.runtimeCliReleaseReconciliationKey(version, A)).not.toBe(store.runtimeCliReleaseReconciliationKey(version, B));
    const key = store.runtimeCliReleaseReconciliationKey(version, A);
    store.updateRuntime("rt_build", { metadata: { cli_commit: A } });
    expect(store.runtimeCliReleaseReconciliationKey(version, A)).not.toBe(key);
  });
  it("exposes daemon build identity in runtime API views", () => {
    const store = createLocalStore(); const r = runtime(store);
    expect(runtimeCompatibilityResponse(r)).toMatchObject({ cli_commit: B, cli_commit_matches_platform: null });
  });
});

describe("automatic failure issues", () => {
  for (const [label, diagnostic, secrets] of [
    ["JSON authorization", '{"headers":{"Authorization":"Bearer exampleOpaqueCredential123"}}', ["exampleOpaqueCredential123"]],
    ["JSON cookie", '{"Cookie":"session=exampleCookieCredential123"}', ["exampleCookieCredential123"]],
    ["JSON proxy authorization", '{"Proxy-Authorization":"Basic exampleProxyCredential123"}', ["exampleProxyCredential123"]],
    ["JSON set-cookie", '{"Set-Cookie":"session=exampleSetCookieCredential123; Secure"}', ["exampleSetCookieCredential123"]],
    ["double quoted password", 'password="alpha beta gamma"', ["alpha", "beta", "gamma"]],
    ["single quoted password", "password='delta epsilon zeta'", ["delta", "epsilon", "zeta"]],
    ["escaped quote in JSON secret", JSON.stringify({ api_key: 'first\\part "second part" finalPart' }), ["first", "second", "finalPart"]],
    ["long quoted credential", `credential="${"longSecret ".repeat(300)}tailSecret"`, ["longSecret", "tailSecret"]],
  ] as const) it(`redacts ${label} in the persisted failure issue`, () => {
    const store = createLocalStore(); runtime(store);
    const project = store.createProject({ title: "Redacted failures" });
    process.env.MULTIREMI_DAEMON_UPDATE_FAILURE_TARGETS = JSON.stringify({ local: { projectId: project.id } });
    const [request] = store.reconcileRuntimeCliRelease(version, A);
    store.reportRuntimeUpdateResult("rt_build", request!.id, { status: "failed", error: diagnostic, output: diagnostic });
    const issues = store.listIssues({ projectId: project.id });
    expect(issues).toHaveLength(1);
    const description = issues[0]!.description!;
    expect(description).toContain(`Target commit: ${A}`);
    expect(description).toContain("Terminal status: failed");
    expect(description).toContain("Error: ");
    expect(description).toContain("Output: ");
    expect(description).toContain("[REDACTED]");
    for (const secret of secrets) expect(description).not.toContain(secret);
  });
  for (const status of ["failed", "rolled_back"] as const) it(`creates one issue for ${status} reports, including after reopen`, () => {
    const store = createLocalStore(); runtime(store);
    const project = store.createProject({ title: "Daemon failures" });
    process.env.MULTIREMI_DAEMON_UPDATE_FAILURE_TARGETS = JSON.stringify({ local: { projectId: project.id } });
    const [request] = store.reconcileRuntimeCliRelease(version, A);
    if (status === "rolled_back") {
      store.reportRuntimeUpdateResult("rt_build", request!.id, { status: "running" });
      store.reportRuntimeUpdateResult("rt_build", request!.id, { status: "restarting" });
    }
    store.reportRuntimeUpdateResult("rt_build", request!.id, { status, error: "Authorization: Bearer secret-value token=secret-value", output: "api_key: secret-value\nAuthorization: Basic secret-value\nCookie: secret-value\ngithub_pat_secret_value" });
    const reopened = new MultiremiStore(db!);
    reopened.reconcileRuntimeUpdateFailures();
    const issues = reopened.listIssues({ projectId: project.id });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.description).toContain(A);
    expect(issues[0]?.description).toContain(status);
    expect(issues[0]?.description).not.toContain("secret-value");
    expect(issues[0]?.description).not.toContain("github_pat_secret_value");
    expect(db!.query("SELECT outcome FROM multiremi_runtime_update_failures").all()).toEqual([{ outcome: "created" }]);
  });
  it("records one event without configured targets, and ignores manual requests", () => {
    const store = createLocalStore(); runtime(store);
    const events: unknown[] = [];
    store.onWorkspaceEvent(event => { if (event.type === "runtime:update_failure") events.push(event); });
    const [request] = store.reconcileRuntimeCliRelease(version, A);
    store.reportRuntimeUpdateResult("rt_build", request!.id, { status: "failed" });
    store.reconcileRuntimeUpdateFailures();
    expect(events).toHaveLength(1);
    expect(db!.query("SELECT outcome, issue_id FROM multiremi_runtime_update_failures").all()).toEqual([{ outcome: "unconfigured", issue_id: null }]);
    expect(store.listIssues()).toHaveLength(0);
    const manual = store.createRuntimeUpdateRequest("rt_build", { targetVersion: version, targetCommit: B });
    store.reportRuntimeUpdateResult("rt_build", manual.id, { status: "failed" });
    expect(events).toHaveLength(1);
  });
  it("sweeps timeout failures without an updater heartbeat", () => {
    const store = createLocalStore(); runtime(store);
    const project = store.createProject({ title: "Timeouts" });
    process.env.MULTIREMI_DAEMON_UPDATE_FAILURE_TARGETS = JSON.stringify({ local: { projectId: project.id } });
    const [request] = store.reconcileRuntimeCliRelease(version, A);
    db!.run("UPDATE multiremi_runtime_update_requests SET status = 'running', updated_at = ?, run_started_at = ? WHERE id = ?",
      ["2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", request!.id]);
    store.reconcileRuntimeUpdateFailures(); store.reconcileRuntimeUpdateFailures();
    expect(store.listIssues({ projectId: project.id })).toHaveLength(1);
    expect(store.getRuntimeUpdateRequest("rt_build", request!.id)?.status).toBe("timeout");
  });
});

it("expands historical request columns as nullable and reads existing requests", () => {
  const store = createFreshStore(); store.ensureLocalWorkspace(); runtime(store);
  const manual = store.createRuntimeUpdateRequest("rt_build", { targetVersion: "0.2.94" });
  // Historical shape: neither nullable identity column existed.
  db!.exec("DROP INDEX idx_runtime_automatic_commit; ALTER TABLE multiremi_runtime_update_requests DROP COLUMN target_commit; ALTER TABLE multiremi_runtime_update_requests DROP COLUMN automatic_daemon_key");
  const reopened = new MultiremiStore(db!);
  expect(reopened.getRuntimeUpdateRequest("rt_build", manual.id)).toMatchObject({ targetVersion: "0.2.94", targetCommit: null });
});

it("validates the platform manifest and skips missing identity/manifests on direct deployments", () => {
  const dir = mkdtempSync(join(tmpdir(), "mul79-manifest-"));
  try {
    expect(readCurrentDaemonBuild(null, dir)).toBeNull();
    expect(readCurrentDaemonBuild(A, dir)).toBeNull();
    mkdirSync(join(dir, A));
    const manifest = { schema: 1, version, commit: A, artifacts: [{ os: "linux", arch: "x64", file: "remi.tar.gz", sha256: "a".repeat(64), size: 10 }] } as const;
    writeFileSync(join(dir, A, "daemon-artifacts.json"), JSON.stringify(manifest));
    expect(readCurrentDaemonBuild(A, dir)).toEqual(manifest);
    writeFileSync(join(dir, A, "daemon-artifacts.json"), JSON.stringify({ ...manifest, commit: B }));
    expect(readCurrentDaemonBuild(A, dir)).toBeNull();
    const store = createLocalStore(); runtime(store);
    reconcileCurrentDaemonBuild(store);
    expect(db!.query("SELECT id FROM multiremi_runtime_update_requests").all()).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("updater deployment heartbeats without a platform manifest do not queue", async () => {
  const store = createLocalStore(); runtime(store);
  const app = createMultiremiApp({ store, platformUpdaterToken: "test-updater" });
  const response = await app.request("/api/platform-updater/heartbeat", { method: "POST",
    headers: { "Content-Type": "application/json", "X-Multiremi-Updater-Token": "test-updater" },
    body: JSON.stringify({ driver: "docker_compose", currentRelease: { version, ref: "main", publishedAt: null, releaseUrl: null, manifestUrl: "https://example.test/manifest", apiImage: null, webImage: null } }) });
  expect(response.status).toBe(200);
  expect(db!.query("SELECT id FROM multiremi_runtime_update_requests").all()).toEqual([]);
});

it("manual runtime.release JSON input preserves target_commit and rejects invalid identities", async () => {
  const store = createLocalStore(); runtime(store);
  const app = createMultiremiApp({ store });
  const post = (body: unknown) => app.request("/api/runtimes/rt_build/update", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect((await post({ target_version: version, target_commit: "invalid" })).status).toBe(400);
  const response = await post({ target_version: version, target_commit: A });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ target_version: version, target_commit: A });
});

it("reconciles after a healthy API starts without an updater; candidates and active operations defer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mul79-startup-"));
  mkdirSync(join(dir, A));
  writeFileSync(join(dir, A, "daemon-artifacts.json"), JSON.stringify({ schema: 1, version, commit: A,
    artifacts: [{ os: "linux", arch: "x64", file: "remi.tar.gz", sha256: "a".repeat(64), size: 10 }] }));
  try {
    for (const mode of ["live", "candidate", "busy", "ui", "heartbeat", "heartbeat-busy"]) {
      const script = `
        import { startMultiremiServer } from "@multiremi/api.js";
        import { MultiremiStore } from "@multiremi/store.js";
        import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
        const db = openSqliteDatabase(":memory:");
        const store = new MultiremiStore(db); store.ensureLocalWorkspace();
        store.registerRuntime({ id: "rt_start", name: "startup", provider: "codex", daemonId: "dm_start", metadata: { cli_commit: "${B}", cli_version: "99.0.0" } });
        if (${JSON.stringify(mode)} === "busy" || ${JSON.stringify(mode)} === "heartbeat-busy") store.createPlatformOperation({ kind: "restart" }, "local");
        const server = startMultiremiServer({ store, port: 0, hostname: "127.0.0.1", backgroundJobs: ${!["candidate", "heartbeat", "heartbeat-busy"].includes(mode)},
          apiRole: ${JSON.stringify(mode === "ui" ? "ui" : "all")}, platformUpdaterToken: "updater-fixture", scheduler: null, scmPolling: null, messaging: null,
          issueTitleScheduler: null, bodyHtmlBackfill: null, controlPlaneSshMesh: null });
        try {
          const response = await fetch(new URL("/readyz", server.url));
          if (${JSON.stringify(mode)}.startsWith("heartbeat")) {
            const heartbeat = await fetch(new URL("/api/platform-updater/heartbeat", server.url), { method: "POST",
              headers: { "Content-Type": "application/json", "X-Multiremi-Updater-Token": "updater-fixture" },
              body: JSON.stringify({ driver: "docker_compose", currentRelease: { version: "0.1.0-stable.unrelated", ref: "main" } }) });
            if (heartbeat.status !== 200) throw new Error("heartbeat failed: " + await heartbeat.text());
          }
          const requests = db.query("SELECT target_commit FROM multiremi_runtime_update_requests").all();
          console.log("STARTUP_RESULT=" + JSON.stringify({ ready: response.status, requests }));
        } finally { server.stop(true); db.close(); }
      `;
      const child = Bun.spawn([process.execPath, "--eval", script], { env: { ...process.env,
        MULTIREMI_BUILD_COMMIT: A, MULTIREMI_DAEMON_ARTIFACT_DIR: dir }, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code, stderr).toBe(0);
      const result = stdout.split("\n").find(line => line.startsWith("STARTUP_RESULT="));
      expect(result).toBeDefined();
      expect(JSON.parse(result!.slice("STARTUP_RESULT=".length))).toEqual({ ready: 200,
        requests: ["live", "heartbeat"].includes(mode) ? [{ target_commit: A }] : [] });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

it("rolls back failure bookkeeping for invalid routing and retries after configuration is corrected", () => {
  const store = createLocalStore(); runtime(store);
  process.env.MULTIREMI_DAEMON_UPDATE_FAILURE_TARGETS = JSON.stringify({ local: { projectId: "missing_project" } });
  const [request] = store.reconcileRuntimeCliRelease(version, A);
  store.reportRuntimeUpdateResult("rt_build", request!.id, { status: "failed" });
  expect(db!.query("SELECT * FROM multiremi_runtime_update_failures").all()).toEqual([]);
  const agent = store.createAgent({ name: "Failure owner", provider: "codex" });
  const project = store.createProject({ title: "Failures", defaultAssigneeType: "agent", defaultAssigneeId: agent.id });
  process.env.MULTIREMI_DAEMON_UPDATE_FAILURE_TARGETS = JSON.stringify({ local: { projectId: project.id } });
  store.reconcileRuntimeUpdateFailures();
  expect(store.listIssues({ projectId: project.id })).toMatchObject([{ assigneeType: "agent", assigneeId: agent.id }]);
});
