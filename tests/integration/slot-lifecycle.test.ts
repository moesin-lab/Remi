import { describe, expect, test } from "bun:test";
import { createServer, connect, type Socket } from "node:net";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";
import { instantiateCoResidentWorkerDaemons } from "../../apps/remi/cli/multiremi.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
import { openIntegrationDatabase } from "../helpers/integration-database.js";
import { twoProcessChildEnv, pollUntil, redactDiagnostic } from "../helpers/two-process.js";
import { InjectedSocket } from "./daemon-protocol-v2/harness.js";

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return port;
}

for (const backend of ["sqlite", "postgres"] as const) {
  const enabled = backend === "sqlite" || Boolean(process.env.MULTIREMI_TEST_POSTGRES_URL);
  if (!enabled) console.info("[MUL-168] SKIP PostgreSQL slot takeover: MULTIREMI_TEST_POSTGRES_URL is not set");
  describe.skipIf(!enabled)(`slot lifecycle: two real API processes (${backend})`, () => {
    test("standby, failed activation, rollback, daemon reconnect and terminal outbox replay", async () => {
      const root = mkdtempSync(join(tmpdir(), "mul168-slots-"));
      mkdirSync(join(root, ".remi"));
      const database = backend === "postgres" ? await openIntegrationDatabase() : null;
      const db = database?.db ?? openSqliteDatabase(join(root, ".remi", "remi.db"));
      if (!database) {
        db.exec("PRAGMA journal_mode=WAL");
        db.exec("PRAGMA busy_timeout=5000");
      }
      const store = new MultiremiStore(db);
      store.ensureLocalWorkspace();
      const token = await store.createAccessToken({ name: "slot fixture", type: "daemon", workspaceId: "local", daemonId: "dmn_slots" });
      const ports = [await freePort(), await freePort()];
      const children: Bun.Subprocess[] = [];
      let diagnostics = "";
      const controlToken = "slot-test-only-secret";
      const request = (index: number, action: string, method = "POST", authenticated = true) => fetch(`http://127.0.0.1:${ports[index]}/internal/slot/${action}`, {
        method, headers: authenticated ? { Authorization: `Bearer ${controlToken}` } : {}, signal: AbortSignal.timeout(10_000),
      });
      const state = async (index: number) => {
        try { return (await (await request(index, "status", "GET")).json() as { state: string }).state; }
        catch { return "unavailable"; }
      };
      const wait = async (predicate: () => boolean | Promise<boolean>, label: string, timeout = 10_000) => {
        if (!await pollUntil(predicate, timeout)) throw new Error(`${label}\n${diagnostics}`);
      };
      let upstream = ports[0]!;
      const connections = new Set<Socket>();
      const proxy = createServer(socket => {
        const target = connect(upstream, "127.0.0.1");
        for (const stream of [socket, target]) { connections.add(stream); stream.on("close", () => connections.delete(stream)); stream.on("error", () => { socket.destroy(); target.destroy(); }); }
        socket.pipe(target).pipe(socket);
      });
      await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
      const proxyPort = (proxy.address() as { port: number }).port;
      let complete!: () => void;
      const running = new Promise<void>(resolve => { complete = resolve; });
      const closeCodes: number[] = [];
      let providerRuns = 0;
      let daemon: ReturnType<typeof instantiateCoResidentWorkerDaemons>[number] | undefined;
      let daemonRun: Promise<void> | undefined;
      try {
        for (const [index, port] of ports.entries()) {
          const child = Bun.spawn([process.execPath, "--no-env-file", "apps/server/main.ts", "serve"], {
            cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
            env: {
              ...twoProcessChildEnv(), HOME: root, NODE_ENV: "test", JWT_SECRET: "slot-test-jwt-secret", MULTIREMI_DATABASE_URL: database?.url,
              MULTIREMI_PORT: String(port), MULTIREMI_HOST: "127.0.0.1", MULTIREMI_BACKGROUND_JOBS: "0",
              MULTIREMI_TOKEN: "fixture-master", MULTIREMI_SLOT: index === 0 ? "A" : "B",
              MULTIREMI_SLOT_START: index === 0 ? "active" : "standby", MULTIREMI_SLOT_CONTROL_TOKEN: controlToken,
              MULTIREMI_SLOT_LOCK_TIMEOUT_MS: "100", MULTIREMI_SLOT_DRAIN_TIMEOUT_MS: "6000",
            },
          });
          children.push(child);
          for (const stream of [child.stdout, child.stderr]) void (async () => {
            for await (const chunk of stream as ReadableStream<Uint8Array>) diagnostics = (diagnostics + redactDiagnostic(new TextDecoder().decode(chunk))).slice(-4000);
          })();
          await wait(() => state(index).then(value => value === (index === 0 ? "active" : "standby")), "slot startup");
        }
        expect(children[0]!.pid).not.toBe(children[1]!.pid);
        expect((await fetch(`http://127.0.0.1:${ports[1]}/readyz`)).status).toBe(503);
        expect((await request(1, "activate", "POST", false)).status).toBe(403);
        expect((await fetch(`http://127.0.0.1:${ports[1]}/api/daemon/ws?protocol=2`, { headers: { Upgrade: "websocket" } })).status).toBe(503);
        if (backend === "postgres") {
          expect((await request(1, "activate")).status).toBe(503);
          expect(await state(1)).toBe("failed");
          expect(children[1]!.exitCode).toBeNull();
        }
        expect((await request(0, "release")).status).toBe(200);
        expect((await request(0, "activate")).status).toBe(200);
        daemon = instantiateCoResidentWorkerDaemons([{
          serverUrl: `http://127.0.0.1:${proxyPort}`, token: token.token, daemonId: "dmn_slots", runtimeId: "rt_slots",
          runtimeName: "slot fixture", deviceName: "slot-fixture", provider: "claude", workspaceId: "local", daemonPort: 0,
          workspacesRoot: join(root, "workspaces"), repoCacheRoot: join(root, "repos"), pluginCacheRoot: join(root, "plugins"),
          outboxPath: join(root, "outbox.db"), gcEnabled: false, inProcessRuntimeModelDiscoveryEnabled: false,
          sshMeshManager: { getHeartbeatStatus: () => ({ status: "disabled" }), reconcile: async () => {}, cleanupForRetirement: async () => {} },
          providerFactory: () => ({ async *sendStream() { providerRuns++; await running; yield { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "survived" }] } as any; },
            getLastResponse: () => ({ text: "survived", sessionId: "slot-session", usage: [], toolCalls: [] } as any), close: async () => {} }),
          protocolClientOptions: { cliVersion: DAEMON_MIN_CLI_VERSION, connect: (url, init) => {
            const socket = new InjectedSocket(url, init);
            socket.native.addEventListener("close", event => closeCodes.push(event.code));
            return socket;
          } },
        }])[0]!;
        (daemon as any).acpVersion = () => null;
        (daemon as any).agentVersion = () => null;
        daemonRun = daemon.start();
        void daemonRun.catch(() => {});
        await wait(() => daemon!.daemonProtocolClient().connectionState() === "connected", "daemon connected");
        const agent = store.createAgent({ name: "slot task", provider: "claude", runtimeId: "rt_slots", workspaceId: "local" });
        const task = store.createTask({ agentId: agent.id, runtimeId: "rt_slots", prompt: "survive two API takeovers" });
        daemon.daemonProtocolClient().send({ t: "runtime.ready", rt: "rt_slots", p: { active_task_ids: [] } });
        await wait(() => providerRuns === 1 && store.getTask(task.id)?.status === "running", "task running");
        const browser = new WebSocket(`ws://127.0.0.1:${ports[0]}/ws?workspace_slug=local`);
        browser.addEventListener("error", () => {});
        await wait(() => browser.readyState === WebSocket.OPEN, "browser connected");
        const browserClosed = new Promise<number>(resolve => browser.addEventListener("close", event => resolve(event.code)));
        upstream = ports[1]!;
        expect((await request(0, "release")).status).toBe(200);
        expect(await browserClosed).toBe(1012);
        expect((await request(1, "activate")).status).toBe(200);
        await wait(() => closeCodes.includes(4001) && daemon!.daemonProtocolClient().connectionState() === "connected", "daemon reconnected to B");
        expect(store.getTask(task.id)?.status).toBe("running");
        expect(store.getTask(task.id)?.failureReason).not.toBe("runtime_recovery");
        // Finish while both slots are released, then replay the durable terminal on A.
        upstream = ports[0]!;
        expect((await request(1, "release")).status).toBe(200);
        complete();
        await wait(() => (daemon!.outboxStats()?.pending ?? 0) > 0, "terminal persisted offline");
        expect((await request(0, "activate")).status).toBe(200);
        await wait(() => store.getTask(task.id)?.status === "completed" && daemon!.outboxStats()?.pending === 0, "outbox replay on A");
        expect(store.getTask(task.id)).toMatchObject({ status: "completed", result: "survived", failureReason: null });
        expect(providerRuns).toBe(1);
        await request(1, "exit");
        await wait(() => children[1]!.exitCode === 0, "standby process exits cleanly");
        children[0]!.kill("SIGTERM");
        await wait(() => children[0]!.exitCode === 0, "active SIGTERM exits cleanly");
      } finally {
        complete();
        await daemon?.stop();
        await daemonRun?.catch(() => {});
        for (const socket of connections) socket.destroy();
        await new Promise<void>(resolve => proxy.close(() => resolve()));
        for (const child of children) {
          if (child.exitCode === null) child.kill("SIGTERM");
          if (!await pollUntil(() => child.exitCode !== null, 3000)) child.kill("SIGKILL");
          await child.exited;
        }
        if (database) await database.close(); else db.close();
        rmSync(root, { recursive: true, force: true });
      }
    }, 60_000);
  });
}
