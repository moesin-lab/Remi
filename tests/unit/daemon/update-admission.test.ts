import { afterEach, expect, it } from "bun:test";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import { MultiremiDaemonClient, type MultiremiDaemonHeartbeatConfigAck } from "@multiremi/worker/client.js";
import { DaemonDownlinkDedupe, DaemonProtocolRpcError, type DaemonProtocolClient } from "@multiremi/worker/daemon-protocol-client.js";
import { registerDaemonRuntimeDownlinks } from "@multiremi/worker/daemon-runtime-downlinks.js";
import { daemonReportTransport } from "@multiremi/worker/report-transport.js";
import { MultiremiTaskReportOutbox } from "@multiremi/worker/outbox.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore, resetMultiremiTestEnv } from "../multiremi/helpers.js";
import { reportFrame } from "../../fixtures/report-session.js";
import { disabledSshMeshRuntime } from "../../helpers/ssh-mesh-isolation.js";
import { assertNoOpenFilesUnder } from "../../helpers/open-file-handles.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  try {
    for (const f of cleanup.splice(0).reverse()) {
      try { await f(); } catch (error) { errors.push(error); }
    }
  } finally { resetMultiremiTestEnv(); }
  if (errors.length) throw new AggregateError(errors, "admission fixture cleanup failed");
});

async function fixture(mode: "lost" | "lost-terminal" | "outage" | "reject") {
  const store = createLocalStore();
  store.registerRuntime({ id: "rt", daemonId: "machine", provider: "codex", name: "test", workspaceId: "local" });
  const token = await store.createAccessToken({ name: "daemon", type: "daemon", daemonId: "machine", workspaceId: "local" });
  const app = createMultiremiApp({ store, authToken: "root-test" });
  store.registerRuntime({ id: "owner", daemonId: "machine", provider: "claude", name: "owner", workspaceId: "local" });
  const ownerRt = mode === "reject" ? "owner" : "rt";
  const a = store.createRuntimeUpdateRequest(ownerRt, { scope: "cli", targetVersion: "0.2.96" });
  const b = mode === "reject" ? store.createRuntimeUpdateRequest("rt", { scope: "cli", targetVersion: "0.2.97" }) : a;
  store.recordRuntimeDrainAck("rt", 0, 0);
  store.recordRuntimeDrainAck("owner", 0, 0);
  let runningCalls = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const body = req.method === "POST" ? await req.clone().json() : {};
    if (body.status === "running") {
      runningCalls++;
      if (mode === "outage") return new Response("unavailable", { status: 503 });
      const response = await app.fetch(req);
      if ((mode === "lost" || mode === "lost-terminal") && runningCalls === 1) {
        if (mode === "lost-terminal") store.reportRuntimeUpdateResult("rt", a.id, { status: "failed", error: "ended while reply was lost" });
        // The DB committed running, but the client never receives its reply.
        await Bun.sleep(600);
      }
      return response;
    }
    return app.fetch(req);
  } });
  cleanup.push(() => server.stop(true));
  const root = mkdtempSync(join(tmpdir(), "update-admission-"));
  cleanup.push(() => {
    assertNoOpenFilesUnder([root]);
    rmSync(root, { recursive: true, force: true });
  });
  const client = new MultiremiDaemonClient(`http://127.0.0.1:${server.port}`, token.token, { requestTimeoutMs: 250 });
  const delivered: string[] = [];
  const updateStatuses: unknown[] = [];
  const outbox = new MultiremiTaskReportOutbox({ path: join(root, "outbox.db"), backoffScheduleMs: [5],
    deliver: async record => {
      delivered.push(record.kind);
      const p = record.payload;
      if (record.kind === "runtime.update_result") updateStatuses.push(p.status);
      const reply = await reportFrame(store, record.kind, p, { runtimeId: "rt", token });
      if (!reply.ok) throw new DaemonProtocolRpcError(reply.code, reply.retryable);
      return {};
    } });
  cleanup.push(() => outbox.close());
  // Real report transport + disk outbox: running must bypass both.
  client.setReportTransport(daemonReportTransport({ connectionState: () => "connected" } as DaemonProtocolClient, () => "rt", () => outbox));
  const daemon = new MultiremiDaemon({ serverUrl: `http://127.0.0.1:${server.port}`, provider: "codex",
    sshMeshManager: disabledSshMeshRuntime(), workspacesRoot: root, repoCacheRoot: join(root, "repos") });
  const state = daemon as unknown as { client: MultiremiDaemonClient; claimsPaused: boolean; restartRequestedFlag: boolean; updateRunner: () => string;
    handleHeartbeatAck(rt: string, ack: MultiremiDaemonHeartbeatConfigAck): Promise<boolean>;
    handleRuntimeUpdate(rt: string, id: string, version: string, scope: "cli", deadline: string): Promise<void> };
  state.client = client;
  let installs = 0;
  state.updateRunner = () => { installs++; return "installed"; };
  return { outboxPath: join(root, "outbox.db"), httpClient: new MultiremiDaemonClient(`http://127.0.0.1:${server.port}`, token.token), store, a, b, state, outbox, delivered, updateStatuses, installs: () => installs, calls: () => runningCalls };
}

it("confirms a committed running after losing the HTTP reply without a replayable running record", async () => {
  const f = await fixture("lost");
  await f.state.handleRuntimeUpdate("rt", f.a.id, "0.2.96", "cli", new Date(Date.now() + 3000).toISOString());
  await f.outbox.flushAll();
  expect(f.calls()).toBeGreaterThanOrEqual(2);
  expect(f.installs()).toBe(1);
  expect(f.store.getRuntimeUpdateRequest("rt", f.a.id)?.status).toBe("restarting");
  expect(f.delivered).toEqual(["runtime.update_result"]);
  expect(f.updateStatuses).toEqual(["restarting"]);
  expect(f.outbox.stats().pending).toBe(0);
});

it("ends unknown admission with failed and releases drain, with nothing that can replay running", async () => {
  const f = await fixture("outage");
  await f.state.handleRuntimeUpdate("rt", f.a.id, "0.2.96", "cli", new Date(Date.now() + 100).toISOString());
  await f.outbox.flushAll();
  expect(f.installs()).toBe(0);
  expect(f.store.getRuntimeUpdateRequest("rt", f.a.id)).toMatchObject({ status: "failed", error: expect.stringContaining("admission confirmation deadline exceeded") });
  expect(f.store.getDaemonDrainStatus("local", "machine").mode).toBe("normal");
  expect(f.state.claimsPaused).toBe(false);
  expect(f.outbox.stats().pending).toBe(0);
  const runningCalls = f.calls();
  await f.outbox.pumpAll();
  expect(f.calls()).toBe(runningCalls);
  expect(f.updateStatuses).toEqual(["failed"]);
  expect(f.store.getRuntimeUpdateRequest("rt", f.a.id)?.status).toBe("failed");
});

for (const path of ["WS", "heartbeat"] as const) it(`retries the same rejected id through ${path} after handoff without blocking runtime results`, async () => {
  const f = await fixture("reject");
  const deadline = () => f.store.getDaemonDrainStatus("local", "machine").deadline!;
  const handlers = new Map<string, (frame: any) => Promise<void>>();
  registerDaemonRuntimeDownlinks({ dedupe: new DaemonDownlinkDedupe(), send() {}, registerFrameHandler(type: string, handler: any) { handlers.set(type, handler); } } as unknown as DaemonProtocolClient,
    () => "rt", async (_rt, ack) => {
      const u = ack.pending_update!;
      await f.state.handleRuntimeUpdate("rt", u.id, u.target_version, "cli", u.drain_deadline!);
    }, async () => {});
  const run = () => path === "WS" ? handlers.get("runtime.update")!({ rt: "rt", payload: { id: f.b.id, target_version: "0.2.97", scope: "cli", drain_deadline: deadline() } })
    : f.state.handleHeartbeatAck("rt", { pending_update: { id: f.b.id, target_version: "0.2.97", scope: "cli", drain_deadline: deadline() } } as MultiremiDaemonHeartbeatConfigAck);
  await expect(run()).rejects.toMatchObject({ code: "cli_update_not_admitted", status: 409 });
  expect(f.installs()).toBe(0);
  expect(f.state.claimsPaused).toBe(false);
  expect(f.store.getRuntimeUpdateRequest("rt", f.b.id)?.status).toBe("pending");
  const command = f.store.createRuntimeCommandRequest("rt", { command: "pwd" });
  await f.state.client.reportRuntimeCommandResult("rt", command.id, { status: "completed", exit_code: 0, stdout: "ok", stderr: "", duration_ms: 1 });
  await f.outbox.flushAll();
  expect(f.store.getRuntimeCommandRequest("rt", command.id)?.status).toBe("completed");
  expect(f.outbox.stats().blocked).toBe(0);
  f.store.reportRuntimeUpdateResult("owner", f.a.id, { status: "failed", error: "owner ended" });
  await run();
  await f.outbox.flushAll();
  expect(f.installs()).toBe(1);
  expect(f.store.getRuntimeUpdateRequest("rt", f.b.id)?.status).toBe("restarting");
  f.store.recordDaemonProtocol("rt", "machine", 2, "0.2.97");
  f.store.reportRuntimeUpdateResult("rt", f.b.id, { status: "completed", self_check: true });
  expect(f.store.getDaemonDrainStatus("local", "machine").mode).toBe("normal");
});

it("discards only a legacy rejected running row and delivers the next result in the same rt partition", async () => {
  const f = await fixture("reject");
  const rejected = f.outbox.enqueueAndWait("rt:rt", "runtime.update_result", {
    runtime_id: "rt", request_id: f.b.id, status: "running",
  }, 1000).catch(error => error);
  const command = f.store.createRuntimeCommandRequest("rt", { command: "pwd" });
  await f.state.client.reportRuntimeCommandResult("rt", command.id, {
    status: "completed", exit_code: 0, stdout: "ok", stderr: "", duration_ms: 1,
  });
  await f.outbox.flushAll();
  expect(await rejected).toMatchObject({ code: "cli_update_not_admitted", retryable: false });
  expect(f.store.getRuntimeUpdateRequest("rt", f.b.id)?.status).toBe("pending");
  expect(f.store.getRuntimeCommandRequest("rt", command.id)?.status).toBe("completed");
  expect(f.outbox.stats()).toMatchObject({ pending: 0, blocked: 0 });
});


it("rejects a terminal owner's late HTTP admission without touching the sibling drain", async () => {
  const f = await fixture("reject");
  f.store.reportRuntimeUpdateResult("owner", f.a.id, { status: "failed", error: "owner ended" });
  const drain = f.store.getDaemonDrainStatus("local", "machine");
  await expect(f.state.handleRuntimeUpdate("owner", f.a.id, "0.2.96", "cli", drain.deadline!))
    .rejects.toMatchObject({ code: "cli_update_not_runnable", status: 409 });
  expect(f.calls()).toBe(1);
  expect(f.installs()).toBe(0);
  expect(f.state.restartRequestedFlag).toBe(false);
  expect(f.state.claimsPaused).toBe(false);
  expect(f.updateStatuses).toEqual([]);
  expect(f.store.getDaemonDrainStatus("local", "machine")).toEqual(drain);
  expect(f.store.getRuntimeUpdateRequest("owner", f.a.id)?.status).toBe("failed");
  expect(f.store.getRuntimeUpdateRequest("rt", f.b.id)?.status).toBe("pending");
  // Other terminal reports retain their idempotent HTTP success.
  await f.httpClient.reportRuntimeUpdateResult("owner", f.a.id, { status: "failed" });
  expect(f.store.claimRuntimeUpdateRequest("rt")?.id).toBe(f.b.id);
});

it("does not install when a lost running receipt is followed by terminal rejection on retry", async () => {
  const f = await fixture("lost-terminal");
  const sibling = f.store.createRuntimeUpdateRequest("owner", { scope: "cli", targetVersion: "0.2.97" });
  await expect(f.state.handleRuntimeUpdate("rt", f.a.id, "0.2.96", "cli", new Date(Date.now() + 3000).toISOString()))
    .rejects.toMatchObject({ code: "cli_update_not_runnable", status: 409 });
  expect(f.calls()).toBe(2);
  expect(f.installs()).toBe(0);
  expect(f.state.restartRequestedFlag).toBe(false);
  expect(f.state.claimsPaused).toBe(false);
  expect(f.updateStatuses).toEqual([]);
  await f.outbox.pumpAll();
  expect(f.store.getRuntimeUpdateRequest("rt", f.a.id)?.status).toBe("failed");
  expect(f.store.claimRuntimeUpdateRequest("owner")?.id).toBe(sibling.id);
});

for (const status of ["restarting", "verifying"] as const) it(`rejects late HTTP running during ${status}`, async () => {
  const f = await fixture("reject");
  f.store.reportRuntimeUpdateResult("owner", f.a.id, { status: "failed" });
  const requestId = f.b.id;
  f.store.claimRuntimeUpdateRequest("rt");
  f.store.reportRuntimeUpdateResult("rt", requestId, { status: "restarting" });
  if (status === "verifying") f.store.recordDaemonProtocol("rt", "machine", 2, "0.2.97");
  await expect(f.state.client.reportRuntimeUpdateResult("rt", requestId, { status: "running" }))
    .rejects.toMatchObject({ code: "cli_update_not_runnable", status: 409 });
  expect(f.store.getRuntimeUpdateRequest("rt", requestId)?.status).toBe(status);
});

it("discards a legacy terminal running rejection without blocking the rt partition", async () => {
  const f = await fixture("reject");
  f.store.reportRuntimeUpdateResult("owner", f.a.id, { status: "failed" });
  f.store.reportRuntimeUpdateResult("rt", f.b.id, { status: "failed" });
  const rejected = f.outbox.enqueueAndWait("rt:rt", "runtime.update_result", {
    runtime_id: "rt", request_id: f.b.id, status: "running",
  }, 1000).catch(error => error);
  const command = f.store.createRuntimeCommandRequest("rt", { command: "pwd" });
  await f.state.client.reportRuntimeCommandResult("rt", command.id, {
    status: "completed", exit_code: 0, stdout: "ok", stderr: "", duration_ms: 1,
  });
  await f.outbox.flushAll();
  expect(await rejected).toMatchObject({ code: "cli_update_not_runnable", retryable: false });
  expect(f.store.getRuntimeUpdateRequest("rt", f.b.id)?.status).toBe("failed");
  expect(f.store.getRuntimeCommandRequest("rt", command.id)?.status).toBe("completed");
  expect(f.outbox.stats()).toMatchObject({ pending: 0, blocked: 0 });
});


for (const code of ["cli_update_not_admitted", "cli_update_not_runnable", "protocol_violation"]) it(`recovers persisted legacy admission blocks only for the two admission codes: ${code}`, async () => {
  const f = await fixture("reject");
  await f.outbox.close();
  const command = f.store.createRuntimeCommandRequest("rt", { command: "pwd" });
  // Construct the exact disk state left by a pre-upgrade daemon, then close
  // SQLite before starting the upgraded outbox against the same file.
  const db = openSqliteDatabase(f.outboxPath);
  try {
    const insert = db.query(`INSERT INTO outbox_events
      (idempotency_key,task_id,kind,payload,seq,status,last_error,next_attempt_at,created_at)
      VALUES (?, 'rt:rt', ?, ?, ?, 'blocked', 'legacy rejection', 9999999999999, ?)`);
    insert.run("legacy-running", "runtime.update_result", JSON.stringify({ runtime_id: "rt", request_id: f.b.id, status: "running" }), 1, new Date().toISOString());
    insert.run("legacy-command", "runtime.command_result", JSON.stringify({ runtime_id: "rt", request_id: command.id,
      status: "completed", exit_code: 0, stdout: "recovered", stderr: "", duration_ms: 1 }), 2, new Date().toISOString());
    db.run("INSERT INTO outbox_meta (key,value) VALUES (?,?),(?,?)", ["blocked:rt:rt", "legacy rejection", "blocked-code:rt:rt", code]);
  } finally { db.close(true); }
  const delivered: string[] = [];
  const recovered = new MultiremiTaskReportOutbox({ path: f.outboxPath, deliver: async record => {
    delivered.push(record.kind);
    const reply = await reportFrame(f.store, record.kind, record.payload, { runtimeId: "rt" });
    if (!reply.ok) throw new DaemonProtocolRpcError(reply.code, reply.retryable);
    return {};
  } });
  cleanup.push(() => recovered.close());
  const inspect = openSqliteDatabase(f.outboxPath);
  cleanup.push(() => inspect.close(true));
  const admission = code !== "protocol_violation";
  expect(inspect.query("SELECT status,last_error,next_attempt_at FROM outbox_events WHERE idempotency_key='legacy-command'").get())
    .toEqual(admission ? { status: "pending", last_error: null, next_attempt_at: null }
      : { status: "blocked", last_error: "legacy rejection", next_attempt_at: 9999999999999 });
  expect(inspect.query("SELECT id FROM outbox_events WHERE idempotency_key='legacy-running'").get() === null).toBe(admission);
  expect(inspect.query("SELECT key FROM outbox_meta WHERE key LIKE 'blocked%'").all()).toHaveLength(admission ? 0 : 2);
  await recovered.flushAll();
  expect(delivered).toEqual(admission ? ["runtime.command_result"] : []);
  expect(f.store.getRuntimeCommandRequest("rt", command.id)?.status).toBe(admission ? "completed" : "pending");
  const next = f.store.createRuntimeCommandRequest("rt", { command: "pwd" });
  recovered.enqueue("rt:rt", "runtime.command_result", { runtime_id: "rt", request_id: next.id,
    status: "completed", exit_code: 0, stdout: "new", stderr: "", duration_ms: 1 });
  await recovered.flushAll();
  expect(f.store.getRuntimeCommandRequest("rt", next.id)?.status).toBe(admission ? "completed" : "pending");
  expect(recovered.stats()).toMatchObject({ pending: 0, blocked: admission ? 0 : 3 });
  expect(f.store.getRuntimeUpdateRequest("rt", f.b.id)?.status).toBe("pending");
  expect(f.installs()).toBe(0);
  expect(f.state.restartRequestedFlag).toBe(false);
});
