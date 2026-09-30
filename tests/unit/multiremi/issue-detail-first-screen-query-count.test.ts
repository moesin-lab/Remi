// MUL-385: guards for the Issue detail first-screen routes.
//
// The three routes the detail page fires on open are `GET /api/issues/:id`,
// `/sessions` and `/timeline?issue_session_id=@default&limit=40`. This file
// pins two properties that a future refactor could quietly break:
//
//   1. the response shape does not drift — each route's body is compared
//      against a pinned golden (including S4's pending decision count)
//      (`tests/fixtures/multiremi/issue-detail-first-screen-golden.json`), and
//      a `bun run scripts/snapshot-api-routes.ts --check` run covers the same
//      ground for the whole route table;
//   2. the query count is bounded — `/sessions` must not grow with session
//      count, and `/api/issues/:id` must not re-load tasks/children/dependencies.
import { afterEach, describe, expect, it } from "bun:test";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { markSqliteDialect, openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { createMultiremiApp } from "@multiremi/api.js";
import type { SqlDatabase, SqlStatement } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import {
  installDeterministicIds,
  normalizeIssueDetailResponse,
  seedIssueDetailFirstScreenFixture,
} from "../../fixtures/multiremi/issue-detail-first-screen-fixture.js";
import golden from "../../fixtures/multiremi/issue-detail-first-screen-golden.json";

let databases: Database[] = [];

afterEach(() => {
  for (const database of databases) database.close();
  databases = [];
});

const AUTH_TOKEN = "mul385-first-screen-token";
const AUTH_HEADERS = { Authorization: `Bearer ${AUTH_TOKEN}` };

/** Bind the fixture's pinned `joined_at` writes without tripping the binder types. */
function runPinned(db: Database, sql: string, params: unknown[]): void {
  db.run(sql, params as SQLQueryBindings[]);
}

interface Probe {
  statements: number;
  bySql: Map<string, number>;
  reset(): void;
}

function countingDatabase(raw: Database, probe: Probe): SqlDatabase {
  const record = (sql: string): void => {
    probe.statements += 1;
    const key = sql.replace(/\s+/g, " ").trim();
    probe.bySql.set(key, (probe.bySql.get(key) ?? 0) + 1);
  };
  const wrap = (statement: SqlStatement, sql: string): SqlStatement => new Proxy(statement, {
    get(target, property) {
      const value = target[property as keyof SqlStatement];
      if (["get", "all", "run", "values"].includes(String(property))) {
        return (...params: unknown[]) => {
          record(sql);
          return (value as (...args: unknown[]) => unknown).apply(target, params);
        };
      }
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return markSqliteDialect<SqlDatabase>({
    query: (sql) => wrap(raw.query(sql) as unknown as SqlStatement, sql),
    prepare: (sql) => wrap(raw.prepare(sql) as unknown as SqlStatement, sql),
    run(sql, ...params) {
      record(sql);
      const bindings = (params.length === 1 && Array.isArray(params[0]) ? params[0] : params) as SQLQueryBindings[];
      return raw.run(sql, bindings);
    },
    exec: (sql) => {
      raw.exec(sql);
    },
    transaction: (fn) => raw.transaction(fn),
    close: () => raw.close(),
  });
}

function createCountedStore(): { store: MultiremiStore; db: Database; probe: Probe } {
  const db = openSqliteDatabase(":memory:");
  databases.push(db);
  const probe: Probe = {
    statements: 0,
    bySql: new Map(),
    reset() {
      this.statements = 0;
      this.bySql = new Map();
    },
  };
  return { store: new MultiremiStore(countingDatabase(db, probe)), db, probe };
}

function createStore(): { store: MultiremiStore; db: Database } {
  const db = openSqliteDatabase(":memory:");
  databases.push(db);
  return { store: new MultiremiStore(db), db };
}

describe("MUL-385 issue detail first-screen response shape", () => {
  it("matches the pinned golden for all three routes", async () => {
    // The golden was captured with the same PRNG + clock pin, so ids and page
    // cursors line up and only a genuine shape change can fail this comparison.
    const restoreIds = installDeterministicIds();
    try {
    const { store, db } = createStore();
    const app = createMultiremiApp({ store, authToken: AUTH_TOKEN });
    const fixture = seedIssueDetailFirstScreenFixture(store, {
      legacyIssueSessions: true,
      run: (sql, params) => { runPinned(db, sql, params); },
    });

    const issueDetail = await (await app.request(`/api/issues/${fixture.issueId}`, { headers: AUTH_HEADERS })).json();
    const sessions = await (await app.request(`/api/issues/${fixture.issueId}/sessions`, { headers: AUTH_HEADERS })).json();
    const timeline = await (await app.request(
      `/api/issues/${fixture.issueId}/timeline?issue_session_id=%40default&limit=40`,
      { headers: AUTH_HEADERS },
    )).json();

    // Timestamps are scrubbed on both sides: the golden carries `<timestamp>`
    // placeholders, so field presence and value types are still compared while
    // the wall clock is not.
    expect(normalizeIssueDetailResponse(issueDetail)).toEqual(golden.issueDetail);
    expect(normalizeIssueDetailResponse(sessions)).toEqual(golden.sessions);
    expect(normalizeIssueDetailResponse(timeline)).toEqual(golden.timeline);
    } finally {
      restoreIds();
    }
  });

  it("keeps the timeline's legacy naked-array shape when no page parameter is sent", async () => {
    const { store, db } = createStore();
    const app = createMultiremiApp({ store, authToken: AUTH_TOKEN });
    const fixture = seedIssueDetailFirstScreenFixture(store, {
      run: (sql, params) => { runPinned(db, sql, params); },
    });

    const body = await (await app.request(
      `/api/issues/${fixture.issueId}/timeline`,
      { headers: AUTH_HEADERS },
    )).json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });
});

describe("MUL-385 issue detail first-screen query counts", () => {
  it("adds only one aggregate query for the pending decision count", async () => {
    const { store, db, probe } = createCountedStore();
    const app = createMultiremiApp({ store, authToken: AUTH_TOKEN });
    const fixture = seedIssueDetailFirstScreenFixture(store, {
      run: (sql, params) => { runPinned(db, sql, params); },
    });

    probe.reset();
    const response = await app.request(`/api/issues/${fixture.issueId}`, { headers: AUTH_HEADERS });
    expect(response.status).toBe(200);

    // The original four reads remain; S4 adds one aggregate over escalated
    // decisions and pending human requests on this Issue and direct children.
    expect(probe.statements).toBe(5);
    expect([...probe.bySql.keys()].filter((sql) => sql.includes("multiremi_issue_decisions"))).toHaveLength(1);
    expect([...probe.bySql.keys()].some((sql) => sql.includes("SELECT * FROM multiremi_tasks"))).toBe(false);
    expect([...probe.bySql.keys()].some((sql) => sql.includes("multiremi_issue_dependencies"))).toBe(false);
  });

  it("keeps /sessions query count constant as session count grows", async () => {
    const counts: number[] = [];
    for (const sessions of [1, 10]) {
      const { store, db, probe } = createCountedStore();
      const app = createMultiremiApp({ store, authToken: AUTH_TOKEN });
      const fixture = seedIssueDetailFirstScreenFixture(store, {
        rootComments: 4,
        replies: 2,
        sideSessions: sessions - 1,
        tasks: 2,
        decoratedComments: 0,
      });

      probe.reset();
      const response = await app.request(`/api/issues/${fixture.issueId}/sessions`, { headers: AUTH_HEADERS });
      expect(response.status).toBe(200);
      const body = await response.json() as unknown[];
      expect(body).toHaveLength(sessions);
      counts.push(probe.statements);
    }

    // Issue lookup + session list + one batched participant scan + the label
    // join the session rows are hydrated with. The per-session form used to add
    // two statements per session (`listSessionParticipants` re-read the session
    // before scanning participants), so 1 vs 10 sessions went 9 → 27.
    expect(counts[0]).toBe(4);
    expect(counts[1]).toBe(counts[0]);
  });

  it("round-trips every session's participants through the batched lookup", async () => {
    const { store } = createCountedStore();
    const fixture = seedIssueDetailFirstScreenFixture(store);

    const sessions = store.listIssueSessions(fixture.issueId);
    const batched = store.listSessionParticipantsForSessions(sessions.map((session) => session.id));
    for (const session of sessions) {
      const expected = store.listSessionParticipants(session.id);
      expect(batched.get(session.id)).toEqual(expected);
      expect(expected.length).toBe(fixture.participantCountBySession[session.id]!);
    }

    // An empty input must not issue a statement and must not invent sessions.
    expect(store.listSessionParticipantsForSessions([]).size).toBe(0);
  });

  it("batches multiple Chats without exposing another creator or an inaccessible private Agent", async () => {
    const { store, db, probe } = createCountedStore();
    store.ensureLocalWorkspace();
    for (const [userId, role] of [["alice", "member"], ["bob", "member"], ["admin", "admin"]] as const) {
      store.createWorkspaceMember({ id: `mem_first_screen_${userId}`, workspaceId: "local", userId, name: userId, role });
    }
    const publicAgent = store.createAgent({ id: "agt_first_screen_public", name: "Shared", provider: "codex", ownerId: "alice", visibility: "workspace" });
    const privateAgent = store.createAgent({ id: "agt_first_screen_private", name: "Private", provider: "codex", ownerId: "bob", visibility: "private" });
    const issue = store.createIssue({ id: "iss_first_screen_access", title: "Shared issue", workspaceId: "local" });
    const addChat = (id: string, creatorId: string, agentId = publicAgent.id) => {
      const chat = store.createChatSession({ id, agentId, creatorId, workspaceId: "local" });
      const session = store.getOrCreateDefaultChatSession(chat.id, creatorId);
      db.run("UPDATE multiremi_issue_sessions SET issue_id = ? WHERE id = ?", [issue.id, session.id]);
      store.addSessionParticipant(session.id, { participantType: "agent", participantId: agentId });
      return session.id;
    };
    const aliceVisible = addChat("chat_first_screen_alice", "alice");
    const bobVisible = addChat("chat_first_screen_bob", "bob", privateAgent.id);
    const alicePrivate = addChat("chat_first_screen_inaccessible", "alice", privateAgent.id);
    const adminVisible = addChat("chat_first_screen_admin", "admin", privateAgent.id);
    const inconsistentChat = addChat("chat_first_screen_foreign", "alice");
    store.createWorkspace({ id: "ws_first_screen_foreign", name: "Foreign", slug: "first-screen-foreign" });
    db.run("UPDATE multiremi_chat_sessions SET workspace_id = ? WHERE id = ?", ["ws_first_screen_foreign", "chat_first_screen_foreign"]);
    const foreignAgent = store.createAgent({ id: "agt_first_screen_foreign", name: "Foreign", provider: "codex",
      workspaceId: "ws_first_screen_foreign", ownerId: "alice", visibility: "workspace" });
    store.createChatSession({ id: "chat_first_screen_foreign_session", workspaceId: "ws_first_screen_foreign",
      creatorId: "alice", agentId: foreignAgent.id });
    const foreignSession = store.getOrCreateDefaultChatSession("chat_first_screen_foreign_session", "alice");
    db.run("UPDATE multiremi_issue_sessions SET issue_id = ? WHERE id = ?", [issue.id, foreignSession.id]);
    const app = createMultiremiApp({ store, authToken: AUTH_TOKEN });
    const headersFor = async (userId: string) => ({ Authorization: `Bearer ${(await store.createAccessToken({
      name: userId, type: "pat", userId, workspaceId: "local",
    })).token}` });
    const aliceHeaders = await headersFor("alice");
    const path = `/api/issues/${issue.id}/sessions`;
    const read = async (headers: Record<string, string>) => {
      const response = await app.request(path, { headers });
      expect(response.status).toBe(200);
      return await response.json() as Array<{ id: string; participants: unknown[] }>;
    };
    // Warm token verification so the first last-used write does not distort
    // the comparison against later requests with the same credential.
    await read(aliceHeaders);
    probe.reset();
    expect((await read(aliceHeaders)).map((session) => session.id)).toEqual([aliceVisible]);
    const initialCount = probe.statements;
    expect((await read(await headersFor("bob"))).map((session) => session.id)).toEqual([bobVisible]);
    // Admin may access a private Agent, but remains restricted to their own Chat.
    expect((await read(await headersFor("admin"))).map((session) => session.id)).toEqual([adminVisible]);
    expect((await read(AUTH_HEADERS)).map((session) => session.id)).toEqual([]);
    const outsiders = await headersFor("outsider");
    expect((await app.request(path, { headers: outsiders })).status).toBe(404);
    for (let index = 0; index < 12; index += 1) addChat(`chat_first_screen_extra_${index}`, "alice");
    probe.reset();
    const expanded = await read(aliceHeaders);
    expect(expanded).toHaveLength(13);
    expect(expanded.every((session) => session.participants.length > 0)).toBe(true);
    expect(expanded.some((session) => session.id === alicePrivate)).toBe(false);
    expect(expanded.some((session) => session.id === inconsistentChat)).toBe(false);
    expect(expanded.some((session) => session.id === foreignSession.id)).toBe(false);
    expect(probe.statements).toBe(initialCount);
    expect([...probe.bySql.keys()].filter((sql) => sql.includes("FROM multiremi_session_participants"))).toHaveLength(1);
    const task = store.createTask({ id: "tsk_first_screen_access", agentId: publicAgent.id, prompt: "Credential scope" });
    const taskCredential = await store.createAccessToken({ name: "Task", type: "task", userId: "alice",
      agentId: publicAgent.id, taskId: task.id, workspaceId: "local" });
    const taskSessions = await read({ Authorization: `Bearer ${taskCredential.token}` });
    expect(taskSessions.map((session) => session.id).sort()).toEqual(expanded.map((session) => session.id).sort());
    // Private-Agent ownership changes are evaluated afresh on each request.
    store.updateAgent(privateAgent.id, { ownerId: "alice" });
    expect((await read(aliceHeaders)).some((session) => session.id === alicePrivate)).toBe(true);
  });
});

/**
 * MUL-386: the golden scrubber rewrites the wall clock inside a timeline page
 * cursor (`base64url([createdAt, id])`), but only for that exact shape. The id
 * has to stay in the comparison, and a payload of any other shape has to survive
 * untouched — otherwise the guard would silently accept a real shape change.
 */
describe("MUL-386 cursor normalization", () => {
  const encodeCursor = (payload: unknown): string =>
    Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const decodeCursor = (cursor: string): unknown =>
    JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  const normalizeCursorField = (cursor: string): string => {
    const out = normalizeIssueDetailResponse({ next_cursor: cursor }) as { next_cursor: string };
    return out.next_cursor;
  };

  it("scrubs the timestamp and keeps the id verbatim", () => {
    const cursor = encodeCursor(["2026-09-20T12:00:00.188Z", "cmt_8yh955wqxxjs"]);
    expect(decodeCursor(normalizeCursorField(cursor))).toEqual(["<timestamp>", "cmt_8yh955wqxxjs"]);
  });

  it("scrubs prev_cursor the same way", () => {
    const cursor = encodeCursor(["2026-09-20T12:00:00.187Z", "cmt_8yh955wqxxjs"]);
    const out = normalizeIssueDetailResponse({ prev_cursor: cursor }) as { prev_cursor: string };
    expect(decodeCursor(out.prev_cursor)).toEqual(["<timestamp>", "cmt_8yh955wqxxjs"]);
  });

  it("keeps the id participating in the comparison", () => {
    const first = normalizeCursorField(encodeCursor(["2026-09-20T12:00:00.188Z", "cmt_first"]));
    const second = normalizeCursorField(encodeCursor(["2026-09-20T12:00:00.188Z", "cmt_second"]));
    expect(first).not.toBe(second);
  });

  it("absorbs a millisecond shift and is idempotent", () => {
    const earlier = normalizeCursorField(encodeCursor(["2026-09-20T12:00:00.187Z", "cmt_x"]));
    const later = normalizeCursorField(encodeCursor(["2026-09-20T12:00:00.188Z", "cmt_x"]));
    expect(later).toBe(earlier);
    expect(normalizeCursorField(later)).toBe(later);
  });

  it("leaves a single-element payload untouched", () => {
    const cursor = encodeCursor(["2026-09-20T12:00:00.188Z"]);
    expect(normalizeCursorField(cursor)).toBe(cursor);
  });

  it("leaves a payload whose id is not a string untouched", () => {
    const cursor = encodeCursor(["2026-09-20T12:00:00.188Z", 123]);
    expect(normalizeCursorField(cursor)).toBe(cursor);
  });

  it("keeps an id that merely looks like a timestamp", () => {
    const cursor = encodeCursor(["2026-09-20T12:00:00.188Z", "cmt_2026-09-20T12:00:00.188Z"]);
    expect(decodeCursor(normalizeCursorField(cursor))).toEqual([
      "<timestamp>",
      "cmt_2026-09-20T12:00:00.188Z",
    ]);
  });

  it("leaves payloads of other arities or shapes untouched", () => {
    for (const payload of [
      ["2026-09-20T12:00:00.188Z", "cmt_x", "extra"],
      [123, "2026-09-20T12:00:00.188Z"],
      ["see 2026-09-20T12:00:00.188Z", "cmt_x"],
      { createdAt: "2026-09-20T12:00:00.188Z", id: "cmt_x" },
      "2026-09-20T12:00:00.188Z",
      null,
    ]) {
      const cursor = encodeCursor(payload);
      expect(normalizeCursorField(cursor)).toBe(cursor);
    }
  });

  it("leaves an undecodable cursor untouched", () => {
    for (const cursor of ["not-json", "!!!", "YWJj"]) {
      expect(normalizeCursorField(cursor)).toBe(cursor);
    }
  });

  it("still replaces plain timestamps outside cursors", () => {
    const out = normalizeIssueDetailResponse({
      created_at: "2026-09-20T12:00:00.188Z",
      id: "cmt_8yh955wqxxjs",
      next_cursor: null,
    }) as Record<string, unknown>;
    expect(out).toEqual({ created_at: "<timestamp>", id: "cmt_8yh955wqxxjs", next_cursor: null });
  });
});
