import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultiremiStore } from "@multiremi/store.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { openIntegrationDatabase, type IntegrationDatabase } from "../helpers/integration-database.js";
import { ApiChild, freePort, twoProcessChildEnv } from "../helpers/two-process.js";
import { authenticateBrowserWebSocket, nextWebSocketMessage, waitWebSocketOpen } from "../unit/multiremi/helpers.js";

// Transport preparation for MUL-15. These are ordinary PAT controls, not root
// authorization evidence. No peer channel runs, so later revocation tests can
// prove that delivery checks do not depend on receiving a broadcast.
const children: ApiChild[] = [];
const sockets: WebSocket[] = [];
const directory = mkdtempSync(join(tmpdir(), "mul15-api-observer-"));
let database: IntegrationDatabase | undefined;
let taskId: string;
let tokens: string[];

beforeAll(async () => {
  const sqliteFile = join(directory, "store.sqlite");
  if (process.env.MULTIREMI_TEST_POSTGRES_URL) database = await openIntegrationDatabase();
  else {
    const db = openSqliteDatabase(sqliteFile) as unknown as SqlDatabase;
    database = { db, async close() { db.close(); } };
  }
  const store = new MultiremiStore(database.db);
  const workspace = store.ensureLocalWorkspace();
  for (const userId of ["observer", "control"]) {
    store.createWorkspaceMember({ workspaceId: workspace.id, userId, name: userId, role: "member" });
  }
  const agent = store.createAgent({ name: "Observer target", workspaceId: workspace.id,
    provider: "codex", visibility: "private", ownerId: "observer" });
  taskId = store.createTask({ agentId: agent.id, workspaceId: workspace.id, prompt: "Observer fixture" }).id;
  tokens = await Promise.all(["observer", "control"].map(async userId =>
    (await store.createAccessToken({ name: userId, type: "pat", workspaceId: workspace.id, userId })).token));
  const master = randomUUID();
  for (let index = 0; index < 2; index++) {
    const port = await freePort();
    const child = new ApiChild(port, {
      ...twoProcessChildEnv(), NODE_ENV: "test", MULTIREMI_PORT: String(port), MULTIREMI_DATABASE_URL: database.url,
      MULTIREMI_TEST_ROOT_API_SQLITE_FILE: sqliteFile, MULTIREMI_TOKEN: master,
      MULTIREMI_BACKGROUND_JOBS: "0",
    }, join(import.meta.dir, "../helpers/root-api-child.ts"));
    children.push(child);
    await child.waitEvent("prepared");
    child.start();
    await child.ready();
  }
}, 30_000);

afterAll(async () => {
  for (const socket of sockets) socket.close();
  const stopped = await Promise.allSettled(children.map(child => child.stop()));
  try { await database?.close(); }
  finally { rmSync(directory, { recursive: true, force: true }); }
  expect(stopped.every(result => result.status === "fulfilled")).toBe(true);
});

function socketAt(child: ApiChild): WebSocket {
  const socket = new WebSocket(`${child.url.replace("http:", "ws:")}/api/trace/ws?workspace_id=local`);
  sockets.push(socket);
  return socket;
}

async function subscribe(socket: WebSocket, fromSeq = 0): Promise<void> {
  const ack = nextWebSocketMessage(socket);
  socket.send(JSON.stringify({ type: "stream.subscribe", payload: { stream: "trace", id: taskId, from_seq: fromSeq } }));
  expect(await ack).toMatchObject({ type: "stream.ack", payload: { stream: "trace", id: taskId } });
}

test("two isolated APIs deliver private trace frames to valid PATs and preserve a control after invalid HTTP/WS authentication", async () => {
  expect(children[0]!.process.pid).not.toBe(children[1]!.process.pid);
  for (const [index, child] of children.entries()) {
    const socket = socketAt(child);
    await authenticateBrowserWebSocket(socket, tokens[index]!);
    await subscribe(socket);
    const delivered = nextWebSocketMessage(socket);
    const marker = `observer-process-${index}`;
    await child.call("trace", { taskId, seq: 1, marker });
    const frame = await delivered;
    expect(frame).toMatchObject({ type: "stream.data", payload: { stream: "trace", id: taskId } });
    expect(frame.payload.frames).toHaveLength(1);
    expect(JSON.stringify(frame.payload.frames)).toContain(marker);
  }
  const child = children[1]!;
  const valid = socketAt(child);
  await authenticateBrowserWebSocket(valid, tokens[1]!);
  await subscribe(valid, 2);
  const received: Array<{ type: string }> = [];
  valid.addEventListener("message", event => received.push(JSON.parse(String(event.data))));
  for (const path of ["/api/agents", "/api/multiremi/agents"]) {
    const denied = await fetch(`${children[0]!.url}${path}`, { headers: {
      Authorization: "Bearer invalid-observer-credential", Cookie: `multimira_auth=${tokens[0]}`,
    } });
    expect(denied.status).toBe(401);
    const allowed = await fetch(`${child.url}${path}`, { headers: { Authorization: `Bearer ${tokens[1]}` } });
    expect(allowed.status).toBe(200);
  }
  const invalid = socketAt(child);
  await waitWebSocketOpen(invalid);
  const rejected = nextWebSocketMessage(invalid);
  invalid.send(JSON.stringify({ type: "auth", payload: { token: "invalid-observer-credential" } }));
  expect(await rejected).toEqual({ error: "invalid token" });
  const next = nextWebSocketMessage(valid);
  await child.call("trace", { taskId, seq: 2, marker: "independent-control-after-rejection" });
  const frame = await next;
  expect(frame).toMatchObject({ type: "stream.data" });
  expect(JSON.stringify(frame.payload.frames)).toContain("independent-control-after-rejection");
  expect(received.some(frame => frame.type === "stream.data")).toBe(true);
});
