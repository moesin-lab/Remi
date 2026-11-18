import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
/**
 * MUL-417 — the v2 connection layer as it is actually wired into `Bun.serve`.
 *
 * The session tests cover the state machine against a fake socket. What only a
 * real socket can show is the wiring: that the upgrade distinguishes a v2 socket
 * from a rejected v1 URL, that the URL marker and the credential both work,
 * that `hello` really reaches the transport over the wire, that the server's
 * accepted limits are the A-0 constants. A-2 removes A-1's v1 coexistence path.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { drainDbSources, withDbJob, withDbSource } from "@shared/observability/db-sources.js";
import { recordDbQuery, resetRequestMetricsForTest } from "@multiremi/observability/request-metrics.js";
import { WsFrameMetricsRing, resetWsFrameMetricsForTest } from "../../../packages/server/src/api/daemon-protocol/metrics.js";
import type { DaemonProtocolLayer } from "../../../packages/server/src/api/daemon-protocol/index.js";
import { watchRuntimeFrames } from "../../fixtures/runtime-downlinks.js";
import { startMultiremiServer } from "@multiremi/api.js";
import { handleDaemonProtocolMessage } from "../../../packages/server/src/api/server.js";
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_WS_MAX_PAYLOAD_BYTES,
} from "@multiremi/contracts/daemon-protocol.js";
import { createStore, nextWebSocketMessage, resetMultiremiTestEnv, waitWebSocketOpen } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

for (const summaryDbRoutes of [true, false]) {
  it(`MUL-209 real WebSockets isolate SQL across await (db_sources=${summaryDbRoutes})`, async () => {
    const { store } = await daemonFixture();
    const database = process.env.MULTIREMI_TEST_POSTGRES_URL
      ? new PostgresSyncDatabase(process.env.MULTIREMI_TEST_POSTGRES_URL) : null;
    // PG CI exercises the actual SQL completion hook. Local SQLite has no such
    // hook, so its fallback verifies transport/context only, not PG behavior.
    const query = () => {
      if (database) expect(database.query("SELECT 1 AS n").get()?.n).toBe(1);
      else recordDbQuery(2, 0);
    };
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let ready!: () => void;
    const allEntered = new Promise<void>(resolve => { ready = resolve; });
    let entered = 0;
    let layer!: DaemonProtocolLayer;
    resetWsFrameMetricsForTest();
    const samples = spyOn(WsFrameMetricsRing.prototype, "record"); // call through
    const output = spyOn(console, "log").mockImplementation(() => {});
    const sockets: WebSocket[] = [];
    const inboxes: ReturnType<typeof watchRuntimeFrames>[] = [];
    const server = startMultiremiServer({
      store, scheduler: null, port: 0, hostname: "127.0.0.1", authToken: "root-secret",
      requestMetrics: { enabled: true, summaryDbRoutes, summaryIntervalMs: 60_000,
        summaryTopRoutes: 20, bufferCapacity: 256, slowRequestMs: 1e9, role: "all" },
      onDaemonProtocol: protocol => {
        layer = protocol;
        protocol.registerRpcHandler("trace.head", async () => {
          query();
          if (++entered === 8) ready();
          await gate;
          query(); // ALS must survive restoration after all peers interleave.
          return { ok: true };
        });
      },
    });
    try {
      for (let index = 0; index < 8; index++) {
        const runtimeId = `rt_attribution_${index}`;
        const daemonId = `dmn_attribution_${index}`;
        store.registerRuntime({ id: runtimeId, daemonId, workspaceId: "local", name: runtimeId, provider: "codex" });
        const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/daemon/ws?protocol=2`,
          { headers: { Authorization: "Bearer root-secret" } } as never);
        sockets.push(socket);
        const inbox = watchRuntimeFrames(socket);
        inboxes.push(inbox);
        await waitWebSocketOpen(socket);
        socket.send(helloFrame({ daemon_id: daemonId,
          runtimes: [{ runtime_id: runtimeId, provider: "codex", max_concurrency: 1, active_task_ids: [] }] }));
        await inbox.next("welcome");
      }
      layer.flushMetrics();
      samples.mockClear();
      output.mockClear();
      drainDbSources(100);
      const replies = sockets.map((socket, index) => {
        const inbox = inboxes[index]!;
        const reply = inbox.next("res", "sql-probe");
        socket.send(JSON.stringify({ v: 2, t: "trace.head", id: "sql-probe", p: {} }));
        return reply;
      });
      await allEntered;
      await withDbSource("http", "GET /fixture", async () => { query(); });
      await withDbJob("scm.poll", async () => { query(); });
      query(); // unrelated process activity must not enter any frame
      release();
      for (const reply of await Promise.all(replies)) expect(reply.p).toMatchObject({ ok: true });
      const frames = samples.mock.calls.map(([sample]) => sample).filter(sample => sample.type === "trace.head");
      expect(frames.map(frame => frame.dbQueries)).toEqual(Array(8).fill(2));
      layer.flushMetrics();
      const summaries = output.mock.calls.flatMap(([line]) => {
        try { const value = JSON.parse(String(line)); return value.event === "ws_minute_summary" ? [value] : []; }
        catch { return []; }
      });
      expect(summaries).toHaveLength(1);
      expect(summaries[0].types.find((type: { type: string }) => type.type === "trace.head"))
        .toMatchObject({ count: 8, db_queries: 16 });
      expect(drainDbSources(100).db_sources.find(source => source.kind === "ws" && source.name === "trace.head")?.db_queries)
        .toBe(summaryDbRoutes ? 16 : undefined);
    } finally {
      release();
      for (const inbox of inboxes) inbox.close();
      for (const socket of sockets) socket.close();
      server.stop(true);
      database?.close();
      samples.mockRestore();
      output.mockRestore();
      resetRequestMetricsForTest();
      resetWsFrameMetricsForTest();
    }
  }, 20_000);
}

/** A store with one workspace owner, one daemon and one runtime bound to it. */
async function daemonFixture(options: { retired?: boolean } = {}) {
  const store = createStore();
  store.ensureLocalWorkspace();
  store.createWorkspaceMember({ workspaceId: "local", userId: "owner-1", name: "Owner", role: "owner" });
  store.registerRuntime({
    id: "rt_v2",
    name: "v2 runtime",
    provider: "codex",
    daemonId: "dmn_v2",
    workspaceId: "local",
  });
  const token = await store.createAccessToken({
    name: "v2 daemon",
    type: "daemon",
    workspaceId: "local",
    daemonId: "dmn_v2",
    userId: "owner-1",
  });
  if (options.retired) {
    const plan = store.getDaemonRetirementPlan("local", "dmn_v2");
    store.retireDaemon("local", "dmn_v2", plan.snapshot, "owner-1");
  }
  return { store, token };
}

function helloFrame(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: DAEMON_PROTOCOL_VERSION,
    t: "hello",
    ts: Date.now(),
    p: {
      protocol: DAEMON_PROTOCOL_VERSION,
      daemon_id: "dmn_v2",
      cli_version: DAEMON_MIN_CLI_VERSION,
      launched_by: null,
      runtimes: [{ runtime_id: "rt_v2", provider: "codex", max_concurrency: 1, active_task_ids: [] }],
      caps: [],
      ...patch,
    },
  });
}

describe("MUL-417 daemon protocol v2 — server wiring", () => {
  it("logs only fixed metadata when the daemon message handler throws sensitive content", async () => {
    const sentinel = "token_like_secret_123?key=value";
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await handleDaemonProtocolMessage({
        sessionId: "dws_sentinel",
        handleMessage: async () => { throw new Error(sentinel); },
      }, "frame");
      const output = JSON.stringify(warn.mock.calls);
      expect(output).toContain("daemon_protocol_frame_failed");
      expect(output).toContain('"session_id":"dws_sentinel"');
      expect(output).toContain('"error_class":"Error"');
      expect(output).not.toContain(sentinel);
      expect(output).not.toContain("stack");
    } finally {
      warn.mockRestore();
    }
  });

  it("completes a handshake over a real socket and stamps the runtime heartbeat", async () => {
    const { store, token } = await daemonFixture();
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1", authToken: "root-secret" });
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.port}/api/daemon/ws?protocol=2`,
      { headers: { Authorization: `Bearer ${token.token}` } } as never,
    );
    try {
      await waitWebSocketOpen(socket);
      socket.send(helloFrame());
      const welcome = await nextWebSocketMessage(socket);
      expect(welcome).toMatchObject({
        v: DAEMON_PROTOCOL_VERSION,
        t: "welcome",
        p: {
          protocol: DAEMON_PROTOCOL_VERSION,
          min_cli_version: DAEMON_MIN_CLI_VERSION,
          hb_interval_ms: 15_000,
          // A-1 advertises the A-0 limits and leaves the trace heads to A-6.
          limits: { frame_bytes: 1024 * 1024, window_frames: 64, window_bytes: 1024 * 1024 },
          trace_heads: {},
        },
      });
      expect(welcome.p.session_id).toMatch(/^dws_/);

      socket.send(JSON.stringify({
        v: DAEMON_PROTOCOL_VERSION,
        t: "hb",
        ts: Date.now(),
        p: { active_task_count: 0, drain_ack_generation: 0 },
      }));
      await Bun.sleep(120);
      expect(store.getRuntime("rt_v2")?.lastHeartbeatAt).not.toBeNull();
    } finally {
      socket.close();
      server.stop(true);
    }
  });

  it("requires the protocol URL marker even with a valid daemon credential", async () => {
    const { store, token } = await daemonFixture();
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1", authToken: "root-secret" });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/daemon/ws`, {
        headers: { Upgrade: "websocket", Connection: "Upgrade", Authorization: `Bearer ${token.token}` },
      });
      expect(response.status).toBe(426);
      expect(await response.json()).toMatchObject({ code: "daemon_protocol_upgrade_required", min_version: 2 });
    } finally {
      server.stop(true);
    }
  });

  it("accepts a marked v2 socket on the deployment master credential", async () => {
    const { store } = await daemonFixture();
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1", authToken: "root-secret" });
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.port}/api/daemon/ws?protocol=2`,
      { headers: { Authorization: "Bearer root-secret" } } as never,
    );
    try {
      await waitWebSocketOpen(socket);
      socket.send(helloFrame());
      expect(await nextWebSocketMessage(socket)).toMatchObject({ t: "welcome" });
    } finally {
      socket.close();
      server.stop(true);
    }
  });

  it("rejects the removed v1 per-runtime wake-up URL with an upgrade response", async () => {
    const { store, token } = await daemonFixture();
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1", authToken: "root-secret" });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/daemon/ws?runtime_ids=rt_v2`, {
        headers: { Upgrade: "websocket", Connection: "Upgrade", Authorization: `Bearer ${token.token}` },
      });
      expect(response.status).toBe(426);
      expect(await response.json()).toMatchObject({ code: "daemon_protocol_upgrade_required", min_version: 2 });
    } finally {
      server.stop(true);
    }
  });

  it("answers a marker-less, credential-less upgrade with 426", async () => {
    const { store } = await daemonFixture();
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1", authToken: "root-secret" });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/daemon/ws`, {
        headers: { Upgrade: "websocket", Connection: "Upgrade" },
      });
      expect(response.status).toBe(426);
      expect(await response.json()).toMatchObject({ code: "daemon_protocol_upgrade_required", min_version: 2 });
    } finally {
      server.stop(true);
    }
  });

  it("refuses a v2 upgrade whose token is not a daemon credential", async () => {
    const { store } = await daemonFixture();
    const human = await store.createAccessToken({
      name: "human",
      type: "pat",
      workspaceId: "local",
      userId: "owner-1",
    });
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1", authToken: "root-secret" });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/daemon/ws?protocol=2`, {
        headers: { Upgrade: "websocket", Connection: "Upgrade", Authorization: `Bearer ${human.token}` },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "daemon_token_required" });
    } finally {
      server.stop(true);
    }
  });

  it("welcomes [rt_ok, rt_missing] over a real socket and reports the missing one as runtime_gone", async () => {
    // The end-to-end form of the review's case: the handshake path in `server.ts`
    // must not have a second place that turns a runtime-level fact into a close.
    const { store, token } = await daemonFixture();
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1", authToken: "root-secret" });
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.port}/api/daemon/ws?protocol=2`,
      { headers: { Authorization: `Bearer ${token.token}` } } as never,
    );
    const inbox = watchRuntimeFrames(socket);
    try {
      await waitWebSocketOpen(socket);
      socket.send(JSON.stringify({
        v: DAEMON_PROTOCOL_VERSION,
        t: "hello",
        ts: Date.now(),
        p: {
          protocol: DAEMON_PROTOCOL_VERSION,
          daemon_id: "dmn_v2",
          cli_version: DAEMON_MIN_CLI_VERSION,
          launched_by: null,
          runtimes: [
            { runtime_id: "rt_v2", provider: "codex", max_concurrency: 1, active_task_ids: [] },
            { runtime_id: "rt_deleted_while_offline", provider: "codex", max_concurrency: 1, active_task_ids: [] },
          ],
          caps: [],
        },
      }));

      expect(await inbox.next("welcome")).toMatchObject({ t: "welcome" });
      expect(socket.readyState).toBe(WebSocket.OPEN);

      socket.send(JSON.stringify({
        v: DAEMON_PROTOCOL_VERSION,
        t: "hb",
        id: "hb-1",
        ts: Date.now(),
        p: { active_task_count: 0, drain_ack_generation: 0 },
      }));
      const reply = await inbox.next("res", "hb-1");
      expect(reply).toMatchObject({
        t: "res",
        re: "hb-1",
        p: {
          runtime_acks: [
            { runtime_id: "rt_v2", status: "ok" },
            { runtime_id: "rt_deleted_while_offline", status: "runtime_gone", runtime_gone: true },
          ],
        },
      });
      expect(socket.readyState).toBe(WebSocket.OPEN);
      expect(store.getRuntime("rt_v2")?.lastHeartbeatAt).not.toBeNull();
    } finally {
      inbox.close();
      socket.close();
      server.stop(true);
    }
  });

  it("does not evict the first master-credential connection when a second claims the same runtime", async () => {
    // Two daemons, both on the deployment master credential, both naming `rt_v2`.
    // The earlier connection must keep serving it; the later one is told
    // `runtime_gone` on its first heartbeat. Evicting the first would take every
    // OTHER runtime on that machine down with it.
    const { store } = await daemonFixture();
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1", authToken: "root-secret" });
    const connect = () => new WebSocket(
      `ws://127.0.0.1:${server.port}/api/daemon/ws?protocol=2`,
      { headers: { Authorization: "Bearer root-secret" } } as never,
    );
    const hello = (daemonId: string) => JSON.stringify({
      v: DAEMON_PROTOCOL_VERSION,
      t: "hello",
      ts: Date.now(),
      p: {
        protocol: DAEMON_PROTOCOL_VERSION,
        daemon_id: daemonId,
        cli_version: DAEMON_MIN_CLI_VERSION,
        launched_by: null,
        runtimes: [{ runtime_id: "rt_v2", provider: "codex", max_concurrency: 1, active_task_ids: [] }],
        caps: [],
      },
    });
    const first = connect();
    const second = connect();
    try {
      await waitWebSocketOpen(first);
      first.send(hello("dmn_v2"));
      expect(await nextWebSocketMessage(first)).toMatchObject({ t: "welcome" });

      await waitWebSocketOpen(second);
      second.send(hello("dmn_other"));
      expect(await nextWebSocketMessage(second)).toMatchObject({ t: "welcome" });
      expect(first.readyState).toBe(WebSocket.OPEN);

      second.send(JSON.stringify({
        v: DAEMON_PROTOCOL_VERSION,
        t: "hb",
        id: "hb-second",
        ts: Date.now(),
        p: { active_task_count: 0 },
      }));
      expect(await nextWebSocketMessage(second)).toMatchObject({
        t: "res",
        re: "hb-second",
        p: { runtime_acks: [{ runtime_id: "rt_v2", status: "runtime_gone", runtime_gone: true }] },
      });

      // The first connection is still alive and still owns the runtime.
      first.send(JSON.stringify({
        v: DAEMON_PROTOCOL_VERSION,
        t: "hb",
        id: "hb-first",
        ts: Date.now(),
        p: { active_task_count: 0 },
      }));
      expect(await nextWebSocketMessage(first)).toMatchObject({
        t: "res",
        re: "hb-first",
        p: { runtime_acks: [{ runtime_id: "rt_v2", status: "ok" }] },
      });
      expect(first.readyState).toBe(WebSocket.OPEN);
      expect(second.readyState).toBe(WebSocket.OPEN);
    } finally {
      first.close();
      second.close();
      server.stop(true);
    }
  });

  it("closes 4410 when a retired daemon completes a hello", async () => {
    // Retirement revokes that daemon's tokens, so the credential route answers
    // 401 before `hello` is ever read. The deployment master credential survives
    // retirement, and that is the route on which a retired daemon is actually
    // identifiable - so this is the path 4410 has to be asserted on.
    const { store } = await daemonFixture({ retired: true });
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1", authToken: "root-secret" });
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.port}/api/daemon/ws?protocol=2`,
      { headers: { Authorization: "Bearer root-secret" } } as never,
    );
    try {
      await waitWebSocketOpen(socket);
      const closed = new Promise<CloseEvent>((resolve) => {
        socket.addEventListener("close", (event) => resolve(event as CloseEvent), { once: true });
      });
      socket.send(helloFrame());
      const event = await closed;
      expect(event.code).toBe(4410);
    } finally {
      socket.close();
      server.stop(true);
    }
  });

  it("answers a retired daemon's own revoked credential with 401 at the upgrade", async () => {
    const { store, token } = await daemonFixture({ retired: true });
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1", authToken: "root-secret" });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/daemon/ws?protocol=2`, {
        headers: { Upgrade: "websocket", Connection: "Upgrade", Authorization: `Bearer ${token.token}` },
      });
      expect(response.status).toBe(401);
    } finally {
      server.stop(true);
    }
  });

  it("answers an unknown frame over a real socket and keeps the connection", async () => {
    const { store, token } = await daemonFixture();
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1", authToken: "root-secret" });
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.port}/api/daemon/ws?protocol=2`,
      { headers: { Authorization: `Bearer ${token.token}` } } as never,
    );
    const inbox = watchRuntimeFrames(socket);
    try {
      await waitWebSocketOpen(socket);
      socket.send(helloFrame());
      await inbox.next("welcome");
      socket.send(JSON.stringify({ v: 2, t: "not.a.frame", id: "q-7", ts: Date.now(), p: {} }));
      expect(await inbox.next("res", "q-7")).toMatchObject({
        t: "res",
        re: "q-7",
        p: { ok: false, code: "unknown_frame", retryable: false },
      });
      expect(socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      inbox.close();
      socket.close();
      server.stop(true);
    }
  });

  it("advertises the A-0 payload ceiling to every socket", () => {
    // The two numbers the Issue fixed: the protocol frame cap and the Bun
    // `maxPayloadLength` that has to sit above it.
    expect(DAEMON_WS_MAX_PAYLOAD_BYTES).toBe(4 * 1024 * 1024);
  });
});
