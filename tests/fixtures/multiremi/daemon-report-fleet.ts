import { activeRequestReadCache } from "@multiremi/store/request-read-cache.js";
import { ManualDaemonProtocolClock } from "@multiremi/api/daemon-protocol/clock.js";
import { createResponsibleTestIssue } from "../../unit/multiremi/helpers.js";
import {
  afterEach,
  afterAll,
  beforeAll,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import type {
  SqlDatabase,
  SqlStatement,
} from "@multiremi/store/db/postgres.js";
import { FEISHU_CONCIERGE_ATTACHMENT_PROTOCOL_VERSION } from "@multiremi/contracts/types.js";
import type { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import { startMultiremiServer } from "../daemon-protocol.js";
import {
  openHotspotDatabase,
  useMigratedHotspotDatabases,
} from "./first-screen-hotspots-database.js";
import { resetMultiremiTestEnv } from "../../unit/multiremi/helpers.js";

// Every fleet opens its database with this bot key set; warm the migrated
// template under the same environment (registered first, so it runs first).
const FLEET_KEY = Buffer.alloc(32, 52).toString("base64");
const cleanups: Array<() => Promise<void>> = [];
export function useReportFleetFixtures(lifetime: "test" | "file" = "test") {
  let previousEncryptionKey: string | undefined;
  beforeAll(() => {
    previousEncryptionKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
    process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = FLEET_KEY;
  });
  (lifetime === "test" ? afterEach : afterAll)(async () => {
    try {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    } finally {
      setSystemTime();
      if (previousEncryptionKey === undefined)
        delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
      else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousEncryptionKey;
      resetMultiremiTestEnv();
    }
  });
  // Close protocol sessions before the template hook disposes live PG clones.
  useMigratedHotspotDatabases();
}

// Count executions, including WITH queries, until queued downlinks/offers finish.
// Counting only inside handleHeartbeat hides the work it schedules afterwards.
export async function countSql(
  database: SqlDatabase,
  layer: DaemonProtocolLayer,
  action: () => unknown,
  onResult?: (sql: string, value: unknown) => void,
) {
  const statements: string[] = [];
  const traces: { sql: string; parameters: unknown[]; inTransaction: boolean; scope: number | null; generation: number | null; stack?: string }[] = [];
  const scopes = new WeakMap<object, number>();
  let nextScope = 0;
  const record = (sql: string, parameters: unknown[] = []) => {
    statements.push(sql);
    if (process.env.MULTIREMI_TEST_SQL_TRACE) {
      const cache = activeRequestReadCache();
      if (cache && !scopes.has(cache)) scopes.set(cache, ++nextScope);
      traces.push({ sql, parameters, inTransaction: !!database.inTransaction,
        scope: cache ? scopes.get(cache)! : null,
        // Diagnostic only: identify the existing transaction/lock generation.
        generation: cache ? Number(Reflect.get(cache, "generation")) : null, stack: new Error().stack });
    }
  };
  const query = database.query.bind(database);
  const prepare = database.prepare.bind(database);
  const run = database.run.bind(database);
  const exec = database.exec.bind(database);
  // SQLite query() delegates to prepare(); count that execution once.
  const wrapped = new WeakSet<object>();
  const wrap = (statement: SqlStatement, sql: string): SqlStatement => {
    if (wrapped.has(statement)) return statement;
    const proxy = new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (["get", "all", "run", "values"].includes(String(key)))
          return (...args: unknown[]) => {
            record(sql, args);
            const result = value.apply(target, args);
            onResult?.(sql, result);
            return result;
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    wrapped.add(proxy);
    return proxy;
  };
  const querySpy = spyOn(database, "query").mockImplementation(((sql: string) =>
    wrap(query(sql), sql)) as typeof database.query);
  const prepareSpy = spyOn(database, "prepare").mockImplementation(((
    sql: string,
  ) => wrap(prepare(sql), sql)) as typeof database.prepare);
  const runSpy = spyOn(database, "run").mockImplementation(
    (...args: Parameters<SqlDatabase["run"]>) => {
      record(args[0], args.slice(1));
      return run(...args);
    },
  );
  const execSpy = spyOn(database, "exec").mockImplementation((sql) => {
    statements.push(sql);
    exec(sql);
  });
  try {
    await action();
    await layer.drain();
    if (process.env.MULTIREMI_TEST_SQL_TRACE) await Bun.write(`/tmp/mul182-sql-${process.env.MULTIREMI_TEST_SQL_TRACE}.json`, JSON.stringify(traces, null, 2));
    return statements;
  } finally {
    querySpy.mockRestore();
    prepareSpy.mockRestore();
    runSpy.mockRestore();
    execSpy.mockRestore();
  }
}

async function openFleetDatabase() {
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = FLEET_KEY;
  const database = await openHotspotDatabase();
  cleanups.push(() => database.dispose());
  return database;
}

export async function fleet(opened?: Awaited<ReturnType<typeof openFleetDatabase>>, runtimeCount = 8) {
  const database = opened ?? (await openFleetDatabase());
  const store = new MultiremiStore(database.db);
  store.ensureLocalWorkspace();
  const runtimeIds = Array.from(
    { length: runtimeCount },
    (_, index) => `rt_cost_${index}`,
  );
  for (const [index, id] of runtimeIds.entries()) {
    store.registerRuntime({
      id,
      name: id,
      provider: index % 2 ? "codex" : "claude",
      workspaceId: "local",
      ownerId: "local",
      daemonId: `dm_cost_${Math.floor(index / 2)}`,
      maxConcurrency: 4,
      metadata: {
        parallel_agent_execution: 1,
        agent_plugin_protocol: 1,
        codex_profiles: 1,
        claude_profiles: 1,
      },
    });
    store.heartbeatRuntime(id, { supportsFeishuBotConfig: true });
    store.recordSshMeshHeartbeat(id, 1, { status: "disabled" });
  }
  const agent = store.createAgent({
    name: "Cost fixture",
    provider: "claude",
    runtimeId: runtimeIds[0],
  });
  const config = store.upsertFeishuBotConfig("local", {
    agentId: agent.id,
    runtimeId: runtimeIds[0],
    appId: "cli_fixture_cost",
    senderAccessPolicy: "agent",
    appSecret: "fixture-secret",
    appSecretOp: "set",
    domain: "feishu",
    enabled: true,
  });
  const status = (index: number) => ({
    appliedRevision: config.revision,
    state: index === 0 ? ("online" as const) : ("stopped" as const),
    botName: index === 0 ? "Fixture" : null,
    botOpenId: null,
    errorCode: null,
    errorMessage: null,
  });
  runtimeIds.forEach((id, index) =>
    store.reportFeishuBotRuntimeStatus("local", id, status(index)),
  );
  let layer!: DaemonProtocolLayer;
  const server = startMultiremiServer({
    store,
    peerChannel: null,
    apiRole: "runtime",
    authToken: "fixture-cost",
    hostname: "127.0.0.1",
    port: 0,
    onDaemonProtocol: (value) => {
      layer = value;
    },
  });
  cleanups.push(async () => {
    layer.closeAll();
    await layer.drain();
    server.stop(true);
  });
  const sessions: Array<ReturnType<DaemonProtocolLayer["openSession"]>> = [];
  const frames: Array<Array<Record<string, any>>> = [];
  const capabilities = {
    parallel_agent_execution: 1,
    agent_plugin_protocol: 1,
    feishu_concierge_protocol: FEISHU_CONCIERGE_ATTACHMENT_PROTOCOL_VERSION,
  };
  const heartbeat = (index: number, mesh = false, activeTaskCount = 0) =>
    sessions[index]!.handleMessage(
      JSON.stringify({
        v: 2,
        t: "hb",
        p: {
          active_task_count: activeTaskCount,
          drain_ack_generation: 0,
          runtimes: runtimeIds
            .slice(index * 2, index * 2 + 2)
            .map((runtime_id) => ({
              runtime_id,
              capabilities,
              ...(mesh
                ? {
                    ssh_mesh_protocol: 1,
                    ssh_mesh_status: { status: "disabled" },
                  }
                : {}),
            })),
        },
      }),
    );
  for (let index = 0; index < runtimeCount / 2; index++) {
    const received: Array<Record<string, any>> = [];
    frames.push(received);
    const session = layer.openSession(
      {
        send(text) {
          received.push(JSON.parse(text));
          return text.length;
        },
        close() {},
      },
      { accessToken: null, masterToken: true },
      // SQL-cost fixtures drive ACK explicitly. Slow PG seeding is not a
      // daemon outage; timeout behavior belongs to the protocol clock tests.
      new ManualDaemonProtocolClock(Date.now()),
    );
    sessions.push(session);
    await session.handleMessage(
      JSON.stringify({
        v: 2,
        t: "hello",
        p: {
          protocol: 2,
          daemon_id: `dm_cost_${index}`,
          cli_version: "0.2.95",
          caps: [],
          runtimes: runtimeIds
            .slice(index * 2, index * 2 + 2)
            .map((runtime_id, position) => ({
              runtime_id,
              provider: position ? "codex" : "claude",
              max_concurrency: 4,
              active_task_ids: [],
              capabilities,
            })),
        },
      }),
    );
    await layer.drain();
    await heartbeat(index, true);
    await layer.drain();
    await session.handleMessage(
      JSON.stringify({ v: 2, t: "ack", ack: session.lastSentSeq, p: {} }),
    );
    await layer.drain();
  }
  return {
    store,
    layer,
    sessions,
    runtimeIds,
    frames,
    status,
    heartbeat,
    agent,
    config,
    database: database.db,
  };
}

export async function loadedFleet(size: number, runtimeCount = 8, startTarget = true, projectPeer = false) {
  const f = await fleet(undefined, runtimeCount);
  const issue = createResponsibleTestIssue(f.store, {
    title: "Report cost",
    workspaceId: "local",
    status: "in_progress",
    assigneeType: "agent",
    assigneeId: f.agent.id,
  });
  const session = f.store.getOrCreateDefaultIssueSession(issue.id);
  let task = f.store.createTask({
    agentId: f.agent.id,
    issueId: issue.id,
    issueSessionId: session.id,
    prompt: "work",
  });
  await f.layer.drain();
  if (f.store.getTask(task.id)?.status === "queued")
    f.store.claimTask(f.runtimeIds[0]!);
  if (startTarget) f.store.startTask(task.id);
  for (let attempt = 1; attempt < (size === 40 ? 8 : 1); attempt++) {
    const turn = f.store.getTurnForAttempt(task.id)!;
    f.store.failTask(task.id, { error: "retry fixture" });
    const retried = f.store.retryTurn(turn.id);
    await f.layer.drain();
    task = f.store.getTask(retried.current_attempt_id!)!;
    if (task.status === "queued") f.store.claimTask(f.runtimeIds[0]!);
    f.store.startTask(task.id);
    await f.sessions[0]!.handleMessage(
      JSON.stringify({ v: 2, t: "ack", ack: f.sessions[0]!.lastSentSeq, p: {} }),
    );
    await f.layer.drain();
  }
  expect(f.store.getTask(task.id)!.attempt).toBe(size === 40 ? 8 : 1);
  for (let i = 0; i < size; i++)
    f.store.sendMessage({
      session_id: session.id,
      sender: { type: "platform", id: null },
      to: { type: "none" },
      message_kind: "status",
      body_md: `context ${i}`,
      wake_requested: "inbox_only",
    });
  const peerAgent = f.store.createAgent({
    name: "Ongoing peer",
    provider: "claude",
    runtimeId: f.runtimeIds[2],
  });
  const project = projectPeer ? f.store.createProject({ title: "Scale project", workspaceId: "local" }) : null;
  const chat = f.store.createChatSession({ agentId: peerAgent.id, projectId: project?.id });
  let peer = f.store.sendChatMessage(chat.id, { body: "keep working" }).task;
  await f.layer.drain();
  if (f.store.getTask(peer.id)?.status === "queued")
    f.store.claimTask(f.runtimeIds[2]!);
  f.store.startTask(peer.id);
  for (let attempt = 1; attempt < (size === 40 ? 8 : 1); attempt++) {
    const turn = f.store.getTurnForAttempt(peer.id)!;
    f.store.failTask(peer.id, { error: "retry fixture" });
    const retried = f.store.retryTurn(turn.id);
    await f.layer.drain();
    peer = f.store.getTask(retried.current_attempt_id!)!;
    if (peer.status === "queued") f.store.claimTask(f.runtimeIds[2]!);
    f.store.startTask(peer.id);
    await f.sessions[1]!.handleMessage(
      JSON.stringify({
        v: 2,
        t: "ack",
        ack: f.sessions[1]!.lastSentSeq,
        p: {},
      }),
    );
    await f.layer.drain();
  }
  expect(f.store.getTask(peer.id)!.attempt).toBe(size === 40 ? 8 : 1);
  for (let i = 0; i < size; i++)
    f.store.sendMessage({
      session_id: chat.id,
      sender: { type: "platform", id: null },
      to: { type: "none" },
      body_md: `peer ${i}`,
      message_kind: "status",
      wake_requested: "inbox_only",
    });
  await f.layer.drain();
  return { ...f, issue, issueSession: session, task, peer };
}


/** Acknowledge all setup downlinks, including frames emitted by acknowledgement.
 * Large fleets otherwise fill the socket window and silently skip later work. */
export async function settleReportFleet(f: Awaited<ReturnType<typeof fleet>>) {
  const acknowledged = new Map<object, number>();
  for (let pass = 0; pass < 100; pass++) {
    await f.layer.drain();
    let changed = false;
    for (const session of f.sessions) {
      if (session.lastSentSeq === (acknowledged.get(session) ?? -1)) continue;
      acknowledged.set(session, session.lastSentSeq);
      await session.handleMessage(JSON.stringify({ v: 2, t: 'ack', ack: session.lastSentSeq, p: {} }));
      changed = true;
    }
    if (!changed) return;
  }
  throw new Error('Fleet did not settle within 100 acknowledgement passes');
}
