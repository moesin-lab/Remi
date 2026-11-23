import { expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createMultiremiApp } from "@multiremi/api.js";
import type { MultiremiIssueSearchResult } from "@multiremi/contracts/types.js";
import {
  DB_REPLY_TRANSITION_EXCEPTIONS,
  createRequestMetricsMiddleware,
  currentDbReplyPolicy,
} from "@multiremi/observability/request-metrics.js";
import { MultiremiStore } from "@multiremi/store.js";
import {
  PostgresSyncDatabase,
  postgresReplyMaxBytes,
  resetDbReplyLimitForTest,
  translateSqliteToPg,
  type SqlDatabase,
  type SqlStatement,
} from "@multiremi/store/db/postgres.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import {
  clampSearchLimit,
  extractSearchSnippet,
  normalizeSearchQuery,
  searchMatch,
  searchRank,
} from "@multiremi/store/helpers.js";
import { pendingTurnBackendTests, type PendingTurnTestFixture } from "./pending-turn-test-backends.js";
import { createResponsibleTestIssue, seedHistoricalIssueFacts } from "./helpers.js";

const LEGACY_CLOSED_ISSUE_STATUSES = new Set(["done", "completed", "closed", "cancelled", "failed"]);

type SearchInput = {
  q: string;
  workspaceId?: string | null;
  includeClosed?: boolean;
  includeCommentBodies?: boolean;
  limit?: number;
  offset?: number;
};

/**
 * Verbatim pre-MUL-331 searchIssues implementation used as the ground-truth
 * semantic oracle and before-change SQL query-count baseline.
 *
 * Note on equal-`created_at` comments: the legacy query ordered only by
 * `created_at DESC` (non-deterministic on ties across SQLite/PostgreSQL).
 * MUL-331 standardizes equal-`created_at` tie-breaking to
 * `ORDER BY l.created_at DESC, l.seq DESC, l.id DESC` (latest session `seq` first),
 * asserted explicitly in the dedicated tie-breaking test below.
 */
function legacySearchIssuesOracle(
  store: MultiremiStore,
  db: SqlDatabase,
  input: SearchInput,
): { issues: MultiremiIssueSearchResult[]; total: number } {
  const query = normalizeSearchQuery(input.q);
  if (!query) throw new Error("q parameter is required");
  const workspaceId = input.workspaceId ?? "local";
  const includeClosed = Boolean(input.includeClosed);
  const includeCommentBodies = input.includeCommentBodies !== false;
  const limit = clampSearchLimit(input.limit);
  const offset = Math.max(0, Number(input.offset ?? 0));

  const searchCommentSnippet = (issueId: string): string | null => {
    const rows = db.query(
      "SELECT body FROM multiremi_issue_message_records WHERE issue_id = ? ORDER BY created_at DESC",
    ).all(issueId) as Array<Record<string, unknown>>;
    const match = rows.find((row) => searchMatch(String(row.body ?? ""), query));
    return match ? extractSearchSnippet(String(match.body ?? ""), query) : null;
  };

  const rows = store.listIssues({ includeArchived: true }).map((issue) => ({
    issue,
    matchedCommentSnippet: includeCommentBodies ? searchCommentSnippet(issue.id) : null,
  })).filter(({ issue, matchedCommentSnippet }) => {
    if (issue.workspaceId !== workspaceId) return false;
    if (!includeClosed && LEGACY_CLOSED_ISSUE_STATUSES.has(issue.status) && !issue.archivedAt) return false;
    return searchMatch(issue.key, query)
      || searchMatch(issue.title, query)
      || searchMatch(issue.description ?? "", query)
      || matchedCommentSnippet !== null;
  }).map(({ issue, matchedCommentSnippet }) => {
    const matchSource = searchMatch(issue.key, query)
      ? "key"
      : searchMatch(issue.title, query)
        ? "title"
        : searchMatch(issue.description ?? "", query)
          ? "description"
          : "comment";
    const result: MultiremiIssueSearchResult = {
      ...issue,
      matchSource,
    };
    if (matchSource === "description" && issue.description) {
      result.matchedDescriptionSnippet = extractSearchSnippet(issue.description, query);
    }
    if (matchedCommentSnippet !== null) {
      result.matchedCommentSnippet = matchedCommentSnippet;
      if (matchSource === "comment") result.matchedSnippet = matchedCommentSnippet;
    }
    return result;
  }).sort((left, right) =>
    searchRank(left.matchSource) - searchRank(right.matchSource)
    || Date.parse(right.updatedAt) - Date.parse(left.updatedAt));

  return { issues: rows.slice(offset, offset + limit), total: rows.length };
}

const SQL_WRITE_RE =
  /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|REPLACE\s+INTO|CREATE\s+(?:TABLE|INDEX|VIEW|TRIGGER|UNIQUE)|DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER)|ALTER\s+TABLE)\b/i;

const SQL_TX_CONTROL_RE = /^\s*SET\s+TRANSACTION\s+ISOLATION\s+LEVEL\b/i;

function measureSql<T>(db: SqlDatabase, fn: () => T): {
  result: T;
  reads: number;
  writes: number;
  txControl: number;
  total: number;
  elapsedMs: number;
  statements: string[];
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const statements: string[] = [];
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let txControl = 0;
  const record = (text: string, params: unknown[]) => {
    if (SQL_TX_CONTROL_RE.test(text)) {
      txControl += 1;
      return;
    }
    statements.push(text);
    calls.push({ sql: text, params });
  };
  const wrapped = new WeakSet<object>();
  const wrap = (statement: SqlStatement, text: string): SqlStatement => {
    if (wrapped.has(statement)) return statement;
    const proxy = new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (["get", "all", "run", "values"].includes(String(key))) {
          return (...args: unknown[]) => {
            record(text, args);
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    wrapped.add(proxy);
    return proxy;
  };
  const query = db.query.bind(db);
  const prepare = db.prepare.bind(db);
  const run = db.run.bind(db);
  const exec = db.exec.bind(db);
  const querySpy = spyOn(db, "query").mockImplementation((text) => wrap(query(text), text));
  const prepareSpy = spyOn(db, "prepare").mockImplementation((text) => wrap(prepare(text), text));
  const runSpy = spyOn(db, "run").mockImplementation((text, ...args) => {
    record(text, args);
    return run(text, ...args);
  });
  const execSpy = spyOn(db, "exec").mockImplementation((text) => {
    record(text, []);
    exec(text);
  });
  const startedAt = performance.now();
  try {
    const result = fn();
    const elapsedMs = performance.now() - startedAt;
    const writes = statements.filter((text) => SQL_WRITE_RE.test(text)).length;
    return { result, reads: statements.length - writes, writes, txControl, total: statements.length, elapsedMs, statements, calls };
  } finally {
    querySpy.mockRestore();
    prepareSpy.mockRestore();
    runSpy.mockRestore();
    execSpy.mockRestore();
  }
}

async function measureSqlAsync<T>(db: SqlDatabase, fn: () => Promise<T>): Promise<{
  result: T;
  reads: number;
  writes: number;
  txControl: number;
  total: number;
  elapsedMs: number;
  statements: string[];
}> {
  const statements: string[] = [];
  let txControl = 0;
  const record = (text: string) => {
    if (SQL_TX_CONTROL_RE.test(text)) {
      txControl += 1;
      return;
    }
    statements.push(text);
  };
  const wrapped = new WeakSet<object>();
  const wrap = (statement: SqlStatement, text: string): SqlStatement => {
    if (wrapped.has(statement)) return statement;
    const proxy = new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (["get", "all", "run", "values"].includes(String(key))) {
          return (...args: unknown[]) => {
            record(text);
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    wrapped.add(proxy);
    return proxy;
  };
  const query = db.query.bind(db);
  const prepare = db.prepare.bind(db);
  const run = db.run.bind(db);
  const exec = db.exec.bind(db);
  const querySpy = spyOn(db, "query").mockImplementation((text) => wrap(query(text), text));
  const prepareSpy = spyOn(db, "prepare").mockImplementation((text) => wrap(prepare(text), text));
  const runSpy = spyOn(db, "run").mockImplementation((text, ...args) => {
    record(text);
    return run(text, ...args);
  });
  const execSpy = spyOn(db, "exec").mockImplementation((text) => {
    record(text);
    exec(text);
  });
  const startedAt = performance.now();
  try {
    const result = await fn();
    const elapsedMs = performance.now() - startedAt;
    const writes = statements.filter((text) => SQL_WRITE_RE.test(text)).length;
    return { result, reads: statements.length - writes, writes, txControl, total: statements.length, elapsedMs, statements };
  } finally {
    querySpy.mockRestore();
    prepareSpy.mockRestore();
    runSpy.mockRestore();
    execSpy.mockRestore();
  }
}

function setUpdatedAt(db: SqlDatabase, issueId: string, updatedAt: string): void {
  db.run("UPDATE multiremi_issues SET updated_at = ? WHERE id = ?", [updatedAt, issueId]);
}

function setCommentCreatedAt(db: SqlDatabase, commentId: string, createdAt: string): void {
  db.run("UPDATE multiremi_conversation_log SET created_at = ? WHERE id = ?", [createdAt, commentId]);
}

function seedEquivalenceFixture(f: PendingTurnTestFixture) {
  const { store, db } = f;
  const foreignWs = store.createWorkspace({ name: "Foreign Tenant", slug: "search-foreign" });
  const labelUrgent = store.createLabel({ name: "urgent", color: "#ef4444", workspaceId: "local" });
  const labelSearch = store.createLabel({ name: "search-tag", color: "#3b82f6", workspaceId: "local" });

  // 1. Key match (we'll search "MUL-1" and also a token that hits all 4 tiers)
  const keyAndComment = f.createIssue({
    workspaceId: "local",
    title: "Neutral title for key tier",
    description: "Neutral description without token",
  });
  db.run("UPDATE multiremi_issues SET issue_key = ? WHERE id = ?", ["ALPHA-100", keyAndComment.id]);
  store.attachLabelToIssue(keyAndComment.id, labelUrgent.id);
  const kcComment = store.createIssueComment(keyAndComment.id, {
    body: "Also mentions alpha-100 in comment so matchedCommentSnippet must be populated",
  });
  setCommentCreatedAt(db, kcComment.id, "2026-10-01T10:00:00.000Z");
  setUpdatedAt(db, keyAndComment.id, "2026-10-01T10:00:00.000Z");

  // 2. Title match + comment match (rank = title, still includes matchedCommentSnippet, NOT matchedSnippet)
  const titleAndComment = f.createIssue({
    workspaceId: "local",
    title: "Investigate ALPHA-100 regression",
    description: "Description also contains ALPHA-100 but title outranks description",
  });
  store.attachLabelToIssue(titleAndComment.id, labelSearch.id);
  const tcCommentOld = store.createIssueComment(titleAndComment.id, {
    body: "Older ALPHA-100 comment should lose to newer matching comment",
  });
  const tcCommentNew = store.createIssueComment(titleAndComment.id, {
    body: "Newest ALPHA-100 comment snippet winner",
  });
  const tcCommentUnrelated = store.createIssueComment(titleAndComment.id, {
    body: "Most recent comment without the target word",
  });
  setCommentCreatedAt(db, tcCommentOld.id, "2026-10-01T08:00:00.000Z");
  setCommentCreatedAt(db, tcCommentNew.id, "2026-10-01T09:00:00.000Z");
  setCommentCreatedAt(db, tcCommentUnrelated.id, "2026-10-01T11:00:00.000Z");
  setUpdatedAt(db, titleAndComment.id, "2026-10-02T10:00:00.000Z");

  // 3. Description match only (newer updated_at with mixed ISO format to verify Date.parse sorting)
  const descMatchNewer = f.createIssue({
    workspaceId: "local",
    title: "General task",
    description: "Detailed writeup mentioning alpha-100 inside a longer paragraph for snippet extraction",
  });
  setUpdatedAt(db, descMatchNewer.id, "2026-10-03T12:00:00Z");

  // 4. Description match older (timezone offset that is lexicographically larger than Z string if compared naively,
  //    but earlier by Date.parse: 2026-10-03T13:00:00+02:00 === 2026-10-03T11:00:00Z < 12:00:00Z)
  const descMatchOlder = f.createIssue({
    workspaceId: "local",
    title: "Another general task",
    description: "Second writeup mentioning alpha-100 earlier in UTC",
  });
  setUpdatedAt(db, descMatchOlder.id, "2026-10-03T13:00:00+02:00");

  // 5. Comment-only match across multiple sessions (must pick latest matching across sessions)
  const commentOnly = f.createIssue({
    workspaceId: "local",
    title: "Unrelated title",
    description: "Unrelated description",
  });
  const secondSession = store.createIssueSession(commentOnly.id, { title: "Follow-up", holdsWorkspace: false });
  const c1 = store.createIssueComment(commentOnly.id, {
    body: "First matching ALPHA-100 note in main session",
  });
  const c2 = store.createIssueComment(commentOnly.id, {
    issueSessionId: secondSession.id,
    body: "Latest matching ALPHA-100 note in second session",
  });
  const c3 = store.createIssueComment(commentOnly.id, {
    issueSessionId: secondSession.id,
    body: "Even newer non-matching chatter",
  });
  setCommentCreatedAt(db, c1.id, "2026-10-04T08:00:00.000Z");
  setCommentCreatedAt(db, c2.id, "2026-10-04T09:00:00.000Z");
  setCommentCreatedAt(db, c3.id, "2026-10-04T10:00:00.000Z");
  setUpdatedAt(db, commentOnly.id, "2026-10-04T10:00:00.000Z");

  // 6. Hidden / deleted / non-message / chat-session comments MUST NOT match
  const nonVisibleCommentIssue = f.createIssue({
    workspaceId: "local",
    title: "Should never match invisible log rows",
    description: "Clean description",
  });
  const deletedComment = store.createIssueComment(nonVisibleCommentIssue.id, {
    body: "ALPHA-100 inside a deleted comment",
  });
  db.run("UPDATE multiremi_conversation_log SET deleted_at = ? WHERE id = ?", ["2026-10-05T00:00:00.000Z", deletedComment.id]);
  const hiddenComment = store.createIssueComment(nonVisibleCommentIssue.id, {
    body: "ALPHA-100 inside a hidden comment",
  });
  db.run("UPDATE multiremi_conversation_log SET visibility = 'hidden' WHERE id = ?", [hiddenComment.id]);
  const turnLogEntry = store.createIssueComment(nonVisibleCommentIssue.id, {
    body: "ALPHA-100 inside a non-message kind row",
  });
  db.run("UPDATE multiremi_conversation_log SET kind = 'turn' WHERE id = ?", [turnLogEntry.id]);
  // Chat-owned session linked to this issue_id (chat_id IS NOT NULL).
  // Seed a real multiremi_chat_sessions parent row so PostgreSQL enforces
  // multiremi_issue_sessions_chat_id_fkey without error.
  const chatAgent = store.createAgent({ name: "Search Chat Agent", workspaceId: "local", provider: "claude" });
  const leakChat = store.createChatSession({
    workspaceId: "local",
    agentId: chatAgent.id,
    title: "Chat projection",
    creatorId: "local",
  });
  db.run(
    `INSERT INTO multiremi_issue_sessions (id, chat_id, issue_id, workspace_id, title, status, is_default, created_at, updated_at)
     VALUES ('chat_sess_leak', ?, ?, 'local', 'Chat projection', 'active', 0, '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z')`,
    [leakChat.id, nonVisibleCommentIssue.id],
  );
  db.run(
    `INSERT INTO multiremi_conversation_log (session_id, seq, id, kind, visibility, sender_type, body_md, created_at, updated_at)
     VALUES ('chat_sess_leak', 1, 'msg_chat_leak', 'message', 'shown', 'member', 'ALPHA-100 inside chat session', '2026-10-05T01:00:00.000Z', '2026-10-05T01:00:00.000Z')`,
  );
  setUpdatedAt(db, nonVisibleCommentIssue.id, "2026-10-05T00:00:00.000Z");

  // 7. Closed (done & cancelled) unarchived vs archived issues
  const unarchivedDone = f.createIssue({
    workspaceId: "local",
    title: "Closed unarchived ALPHA-100 done",
    description: "Closed status done without archived_at",
  });
  seedHistoricalIssueFacts(store, unarchivedDone.id, { status: "done" });
  setUpdatedAt(db, unarchivedDone.id, "2026-10-06T00:00:00.000Z");

  const unarchivedCancelled = f.createIssue({
    workspaceId: "local",
    title: "Closed unarchived ALPHA-100 cancelled",
    description: "Closed status cancelled without archived_at",
  });
  seedHistoricalIssueFacts(store, unarchivedCancelled.id, { status: "cancelled" });
  setUpdatedAt(db, unarchivedCancelled.id, "2026-10-06T01:00:00.000Z");

  const archivedDone = f.createIssue({
    workspaceId: "local",
    title: "Archived ALPHA-100 done stays visible",
    description: "Archived done issue keeps legacy visibility even when includeClosed=false",
  });
  seedHistoricalIssueFacts(store, archivedDone.id, { status: "done" });
  db.run("UPDATE multiremi_issues SET archived_at = ? WHERE id = ?", ["2026-10-06T02:00:00.000Z", archivedDone.id]);
  setUpdatedAt(db, archivedDone.id, "2026-10-06T02:00:00.000Z");

  const archivedCancelled = f.createIssue({
    workspaceId: "local",
    title: "Archived ALPHA-100 cancelled stays visible",
    description: "Archived cancelled issue keeps legacy visibility even when includeClosed=false",
  });
  seedHistoricalIssueFacts(store, archivedCancelled.id, { status: "cancelled" });
  db.run("UPDATE multiremi_issues SET archived_at = ? WHERE id = ?", ["2026-10-06T03:00:00.000Z", archivedCancelled.id]);
  setUpdatedAt(db, archivedCancelled.id, "2026-10-06T03:00:00.000Z");

  // 8. Special characters: %, _, \, quotes, multi-word, Chinese, non-ASCII cased Unicode
  const specialWildcardReal = f.createIssue({
    workspaceId: "local",
    title: "Rate 100% pass_check path c:\\remidb\\file and 'quoted' \"token\"",
    description: "中文性能回归测试：搜索下推 SQL 语义等价",
  });
  const specialComment = store.createIssueComment(specialWildcardReal.id, {
    body: "评论正文含 50%_off 与 c:\\logs\\search 以及 中文评论关键词 和 CAFÉ",
  });
  setCommentCreatedAt(db, specialComment.id, "2026-10-07T01:00:00.000Z");
  setUpdatedAt(db, specialWildcardReal.id, "2026-10-07T01:00:00.000Z");

  const specialWildcardDecoy = f.createIssue({
    workspaceId: "local",
    title: "Rate 1000 passXcheck path c:remidbfile",
    description: "Decoy row that unescaped LIKE wildcards would wrongly match",
  });
  const decoyComment = store.createIssueComment(specialWildcardDecoy.id, {
    body: "Decoy comment 500Xoff and c:logssearch",
  });
  setCommentCreatedAt(db, decoyComment.id, "2026-10-07T02:00:00.000Z");
  setUpdatedAt(db, specialWildcardDecoy.id, "2026-10-07T02:00:00.000Z");

  // 9. Raw-inserted legacy row with NULL issue_key (key falls back to MUL-<number> or id)
  db.run(
    `INSERT INTO multiremi_issues (id, issue_number, issue_key, title, description, status, workspace_id, created_at, updated_at)
     VALUES ('raw_legacy_id_777', 0, NULL, 'Legacy null key issue', NULL, 'todo', 'local', '2026-10-07T03:00:00.000Z', '2026-10-07T03:00:00.000Z')`,
  );
  db.run(
    `INSERT INTO multiremi_issues (id, issue_number, issue_key, title, description, status, workspace_id, created_at, updated_at)
     VALUES ('raw_num_key_888', 888, NULL, 'Legacy numbered null key issue', NULL, 'todo', 'local', '2026-10-07T04:00:00.000Z', '2026-10-07T04:00:00.000Z')`,
  );

  // 10. Unicode ASCII-folding edge cases (U+212A 'K' -> 'k' and U+0130 'İ' -> 'i\u0307')
  const kelvinTitleIssue = f.createIssue({
    workspaceId: "local",
    title: "\u212Aelvin temperature calibration",
    description: "Title uses U+212A unit sign",
  });
  setUpdatedAt(db, kelvinTitleIssue.id, "2026-10-07T05:00:00.000Z");

  const kelvinCommentIssue = f.createIssue({
    workspaceId: "local",
    title: "Neutral telemetry ticket",
    description: "Comment carries U+212A unit sign only",
  });
  const kelvinComment = store.createIssueComment(kelvinCommentIssue.id, {
    body: "Recorded \u212Aelvin drift in sensor comment",
  });
  setCommentCreatedAt(db, kelvinComment.id, "2026-10-07T05:30:00.000Z");
  setUpdatedAt(db, kelvinCommentIssue.id, "2026-10-07T05:30:00.000Z");

  const istanbulTitleIssue = f.createIssue({
    workspaceId: "local",
    title: "\u0130stanbul edge POP rollout",
    description: "Title uses U+0130 dotted capital I",
  });
  setUpdatedAt(db, istanbulTitleIssue.id, "2026-10-07T06:00:00.000Z");

  const istanbulDescIssue = f.createIssue({
    workspaceId: "local",
    title: "Neutral edge POP capacity",
    description: "Description references \u0130stanbul region",
  });
  setUpdatedAt(db, istanbulDescIssue.id, "2026-10-07T06:15:00.000Z");

  const istanbulCommentIssue = f.createIssue({
    workspaceId: "local",
    title: "Neutral edge note",
    description: "Comment uses U+0130 dotted capital I",
  });
  const istanbulComment = store.createIssueComment(istanbulCommentIssue.id, {
    body: "Observed \u0130stanbul latency spike in comment",
  });
  setCommentCreatedAt(db, istanbulComment.id, "2026-10-07T06:30:00.000Z");
  setUpdatedAt(db, istanbulCommentIssue.id, "2026-10-07T06:30:00.000Z");

  // 11. Whitespace-padded raw status values (\t, \n, \r, \v, \f) vs JS .trim()
  const wsOpenControl = f.createIssue({
    workspaceId: "local",
    title: "WSCLOSED-99 open control",
    description: "Remains visible when includeClosed=false",
  });
  setUpdatedAt(db, wsOpenControl.id, "2026-10-07T07:00:00.000Z");

  const wsTabNewlineDone = f.createIssue({
    workspaceId: "local",
    title: "WSCLOSED-99 tab newline done",
    description: "Unarchived done with tab/newline padding",
  });
  db.run("UPDATE multiremi_issues SET status = ? WHERE id = ?", ["\tdone\n", wsTabNewlineDone.id]);
  setUpdatedAt(db, wsTabNewlineDone.id, "2026-10-07T07:10:00.000Z");

  const wsCancelledTab = f.createIssue({
    workspaceId: "local",
    title: "WSCLOSED-99 space tab cancelled",
    description: "Unarchived cancelled with space/tab padding",
  });
  db.run("UPDATE multiremi_issues SET status = ? WHERE id = ?", [" cancelled\t", wsCancelledTab.id]);
  setUpdatedAt(db, wsCancelledTab.id, "2026-10-07T07:20:00.000Z");

  const wsControlCharsDone = f.createIssue({
    workspaceId: "local",
    title: "WSCLOSED-99 cr vt ff done",
    description: "Unarchived done with CR/VT/FF padding",
  });
  db.run("UPDATE multiremi_issues SET status = ? WHERE id = ?", ["\r\v\fdone\n", wsControlCharsDone.id]);
  setUpdatedAt(db, wsControlCharsDone.id, "2026-10-07T07:30:00.000Z");

  const wsArchivedTabDone = f.createIssue({
    workspaceId: "local",
    title: "WSCLOSED-99 archived tab done",
    description: "Archived tab/newline done stays visible when includeClosed=false",
  });
  db.run("UPDATE multiremi_issues SET status = ?, archived_at = ? WHERE id = ?", [
    "\tdone\n",
    "2026-10-07T07:40:00.000Z",
    wsArchivedTabDone.id,
  ]);
  setUpdatedAt(db, wsArchivedTabDone.id, "2026-10-07T07:40:00.000Z");

  // 12. Foreign workspace data with identical tokens (must stay isolated)
  const foreignIssue = f.createIssue({
    workspaceId: foreignWs.id,
    title: "ALPHA-100 foreign workspace title 100% 中文性能回归",
    description: "ALPHA-100 foreign description",
  });
  store.createIssueComment(foreignIssue.id, {
    body: "ALPHA-100 foreign comment 50%_off 中文评论关键词 CAFÉ",
  });
  setUpdatedAt(db, foreignIssue.id, "2026-10-08T00:00:00.000Z");

  return {
    foreignWs,
    keyAndComment,
    titleAndComment,
    descMatchNewer,
    descMatchOlder,
    commentOnly,
    nonVisibleCommentIssue,
    unarchivedDone,
    unarchivedCancelled,
    archivedDone,
    archivedCancelled,
    specialWildcardReal,
    specialWildcardDecoy,
    kelvinTitleIssue,
    kelvinCommentIssue,
    istanbulTitleIssue,
    istanbulDescIssue,
    istanbulCommentIssue,
    wsOpenControl,
    wsTabNewlineDone,
    wsCancelledTab,
    wsControlCharsDone,
    wsArchivedTabDone,
    foreignIssue,
  };
}

pendingTurnBackendTests("MUL-331 issue search SQL pushdown & query budget", (fixture, backend) => {
  it("matches legacy searchIssues semantics field-for-field across workspace, closed/archive, comment, special-char, Unicode and paging cases", () => {
    const f = fixture();
    const seeded = seedEquivalenceFixture(f);

    const assertMatchesOracle = (input: SearchInput) => {
      const expected = legacySearchIssuesOracle(f.store, f.db, input);
      const actual = f.store.searchIssues(input);
      expect(actual).toEqual(expected);
      return actual;
    };

    // Empty / whitespace query validation
    expect(() => f.store.searchIssues({ q: "   ", workspaceId: "local" })).toThrow("q parameter is required");

    // 1. Multi-tier ranking + workspace isolation + archived closed visible when includeClosed=false
    const openAlpha = assertMatchesOracle({ q: "alpha-100", workspaceId: "local", includeClosed: false, includeCommentBodies: true });
    expect(openAlpha.issues.map((item) => item.id)).toEqual([
      seeded.keyAndComment.id,
      seeded.archivedCancelled.id,
      seeded.archivedDone.id,
      seeded.titleAndComment.id,
      seeded.descMatchNewer.id,
      seeded.descMatchOlder.id,
      seeded.commentOnly.id,
    ]);
    expect(openAlpha.issues[0]?.matchSource).toBe("key");
    expect(openAlpha.issues[0]?.matchedCommentSnippet).toContain("alpha-100");
    expect(openAlpha.issues[0]?.matchedSnippet).toBeUndefined();
    expect(openAlpha.issues[0]?.labels.map((label) => label.name)).toEqual(["urgent"]);
    // Title match + comment match: latest matching comment wins over older matching & newest non-matching
    const titleHit = openAlpha.issues.find((item) => item.id === seeded.titleAndComment.id)!;
    expect(titleHit.matchSource).toBe("title");
    expect(titleHit.matchedCommentSnippet).toContain("Newest ALPHA-100 comment snippet winner");
    expect(titleHit.matchedSnippet).toBeUndefined();
    expect(titleHit.matchedDescriptionSnippet).toBeUndefined();
    // Description match
    const descHit = openAlpha.issues.find((item) => item.id === seeded.descMatchNewer.id)!;
    expect(descHit.matchSource).toBe("description");
    expect(descHit.matchedDescriptionSnippet).toContain("alpha-100");
    expect(descHit.matchedCommentSnippet).toBeUndefined();
    // Comment-only match picks latest matching across sessions
    const commentHit = openAlpha.issues.find((item) => item.id === seeded.commentOnly.id)!;
    expect(commentHit.matchSource).toBe("comment");
    expect(commentHit.matchedCommentSnippet).toContain("Latest matching ALPHA-100 note in second session");
    expect(commentHit.matchedSnippet).toBe(commentHit.matchedCommentSnippet);

    // 2. includeClosed=true adds unarchived done & cancelled
    const allAlpha = assertMatchesOracle({ q: "ALPHA-100", workspaceId: "local", includeClosed: true, includeCommentBodies: true });
    expect(allAlpha.total).toBe(openAlpha.total + 2);
    expect(allAlpha.issues.map((item) => item.id)).toContain(seeded.unarchivedDone.id);
    expect(allAlpha.issues.map((item) => item.id)).toContain(seeded.unarchivedCancelled.id);
    expect(allAlpha.issues.map((item) => item.id)).not.toContain(seeded.nonVisibleCommentIssue.id);
    expect(allAlpha.issues.map((item) => item.id)).not.toContain(seeded.foreignIssue.id);

    // 3. includeCommentBodies=false omits comment-only matches and matchedCommentSnippet
    const noComments = assertMatchesOracle({ q: "alpha-100", workspaceId: "local", includeClosed: false, includeCommentBodies: false });
    expect(noComments.issues.map((item) => item.id)).not.toContain(seeded.commentOnly.id);
    expect(noComments.issues.every((item) => item.matchedCommentSnippet === undefined && item.matchedSnippet === undefined)).toBe(true);

    // 4. Foreign workspace isolation
    const foreignResult = assertMatchesOracle({ q: "alpha-100", workspaceId: seeded.foreignWs.id, includeClosed: true, includeCommentBodies: true });
    expect(foreignResult.total).toBe(1);
    expect(foreignResult.issues[0]?.id).toBe(seeded.foreignIssue.id);

    // 5. Special LIKE wildcard characters %, _, \, quotes, multi-word out-of-order, Chinese & Unicode cased
    const pctHit = assertMatchesOracle({ q: "100%", workspaceId: "local" });
    expect(pctHit.issues.map((item) => item.id)).toEqual([seeded.specialWildcardReal.id]);

    const underscoreHit = assertMatchesOracle({ q: "pass_check", workspaceId: "local" });
    expect(underscoreHit.issues.map((item) => item.id)).toEqual([seeded.specialWildcardReal.id]);

    const backslashHit = assertMatchesOracle({ q: "c:\\remidb\\file", workspaceId: "local" });
    expect(backslashHit.issues.map((item) => item.id)).toEqual([seeded.specialWildcardReal.id]);

    const quoteHit = assertMatchesOracle({ q: "'quoted' \"token\"", workspaceId: "local" });
    expect(quoteHit.issues.map((item) => item.id)).toEqual([seeded.specialWildcardReal.id]);

    const commentWildcardHit = assertMatchesOracle({ q: "50%_off c:\\logs\\search", workspaceId: "local" });
    expect(commentWildcardHit.issues.map((item) => item.id)).toEqual([seeded.specialWildcardReal.id]);
    expect(commentWildcardHit.issues[0]?.matchSource).toBe("comment");

    const chineseDescHit = assertMatchesOracle({ q: "下推 中文性能回归测试", workspaceId: "local" });
    expect(chineseDescHit.issues.map((item) => item.id)).toEqual([seeded.specialWildcardReal.id]);
    expect(chineseDescHit.issues[0]?.matchSource).toBe("description");

    const chineseCommentHit = assertMatchesOracle({ q: "中文评论关键词", workspaceId: "local" });
    expect(chineseCommentHit.issues.map((item) => item.id)).toEqual([seeded.specialWildcardReal.id]);
    expect(chineseCommentHit.issues[0]?.matchSource).toBe("comment");

    // Non-ASCII cased Unicode ("café" matching "CAFÉ")
    const unicodeCasedHit = assertMatchesOracle({ q: "café", workspaceId: "local" });
    expect(unicodeCasedHit.issues.map((item) => item.id)).toEqual([seeded.specialWildcardReal.id]);
    expect(unicodeCasedHit.issues[0]?.matchSource).toBe("comment");

    // Unicode ASCII-folding edge cases (U+212A 'K' -> 'k', U+0130 'İ' -> 'i\u0307')
    const kelvinHit = assertMatchesOracle({ q: "kelvin", workspaceId: "local", includeCommentBodies: true });
    expect(kelvinHit.issues.map((item) => item.id)).toEqual([
      seeded.kelvinTitleIssue.id,
      seeded.kelvinCommentIssue.id,
    ]);
    expect(kelvinHit.issues[0]?.matchSource).toBe("title");
    expect(kelvinHit.issues[1]?.matchSource).toBe("comment");
    expect(kelvinHit.issues[1]?.matchedCommentSnippet).toContain("\u212Aelvin drift");

    const kelvinNoComments = assertMatchesOracle({ q: "kelvin", workspaceId: "local", includeCommentBodies: false });
    expect(kelvinNoComments.issues.map((item) => item.id)).toEqual([seeded.kelvinTitleIssue.id]);
    expect(kelvinNoComments.issues[0]?.matchSource).toBe("title");

    // 'istanbul' MUST NOT match 'İstanbul' (JS 'İstanbul'.toLowerCase() === 'i\u0307stanbul'),
    // and includeCommentBodies=false must never fabricate matchSource='comment'.
    const istanbulMissWithComments = assertMatchesOracle({ q: "istanbul", workspaceId: "local", includeCommentBodies: true });
    expect(istanbulMissWithComments).toEqual({ issues: [], total: 0 });
    const istanbulMissNoComments = assertMatchesOracle({ q: "istanbul", workspaceId: "local", includeCommentBodies: false });
    expect(istanbulMissNoComments).toEqual({ issues: [], total: 0 });

    const istanbulExactHit = assertMatchesOracle({ q: "\u0130stanbul", workspaceId: "local", includeCommentBodies: true });
    expect(istanbulExactHit.issues.map((item) => item.id)).toEqual([
      seeded.istanbulTitleIssue.id,
      seeded.istanbulDescIssue.id,
      seeded.istanbulCommentIssue.id,
    ]);
    expect(istanbulExactHit.issues[0]?.matchSource).toBe("title");
    expect(istanbulExactHit.issues[1]?.matchSource).toBe("description");
    expect(istanbulExactHit.issues[2]?.matchSource).toBe("comment");
    const istanbulExactNoComments = assertMatchesOracle({ q: "\u0130stanbul", workspaceId: "local", includeCommentBodies: false });
    expect(istanbulExactNoComments.issues.map((item) => item.id)).toEqual([
      seeded.istanbulTitleIssue.id,
      seeded.istanbulDescIssue.id,
    ]);

    // Queries containing only combining dot above ('\u0307' or '\u0307stan', without 'i')
    // still match 'İstanbul' via SQL pushdown because JS 'İ'.toLowerCase() === 'i\u0307'.
    for (const dotQuery of ["\u0307", "\u0307stan"]) {
      const dotWithComments = assertMatchesOracle({ q: dotQuery, workspaceId: "local", includeCommentBodies: true });
      expect(dotWithComments.issues.map((item) => item.id)).toEqual([
        seeded.istanbulTitleIssue.id,
        seeded.istanbulDescIssue.id,
        seeded.istanbulCommentIssue.id,
      ]);
      expect(dotWithComments.issues.map((item) => item.matchSource)).toEqual(["title", "description", "comment"]);

      const dotNoComments = assertMatchesOracle({ q: dotQuery, workspaceId: "local", includeCommentBodies: false });
      expect(dotNoComments.issues.map((item) => item.id)).toEqual([
        seeded.istanbulTitleIssue.id,
        seeded.istanbulDescIssue.id,
      ]);
      expect(dotNoComments.issues.map((item) => item.matchSource)).toEqual(["title", "description"]);
    }

    // Whitespace-padded raw closed statuses (\t, \n, \r, \v, \f) align with normalizeIssueStatus (.trim())
    const wsClosedExcluded = assertMatchesOracle({ q: "WSCLOSED-99", workspaceId: "local", includeClosed: false });
    expect(wsClosedExcluded.total).toBe(2);
    expect(wsClosedExcluded.issues.map((item) => item.id)).toEqual([
      seeded.wsArchivedTabDone.id,
      seeded.wsOpenControl.id,
    ]);
    const wsClosedIncluded = assertMatchesOracle({ q: "WSCLOSED-99", workspaceId: "local", includeClosed: true });
    expect(wsClosedIncluded.total).toBe(5);
    expect(wsClosedIncluded.issues.map((item) => item.id)).toEqual([
      seeded.wsArchivedTabDone.id,
      seeded.wsControlCharsDone.id,
      seeded.wsCancelledTab.id,
      seeded.wsTabNewlineDone.id,
      seeded.wsOpenControl.id,
    ]);

    // Raw NULL issue_key fallback matching id or MUL-<number>
    const rawIdKeyHit = assertMatchesOracle({ q: "raw_legacy_id_777", workspaceId: "local" });
    expect(rawIdKeyHit.issues.map((item) => item.id)).toEqual(["raw_legacy_id_777"]);
    expect(rawIdKeyHit.issues[0]?.matchSource).toBe("key");

    const rawNumKeyHit = assertMatchesOracle({ q: "mul-888", workspaceId: "local" });
    expect(rawNumKeyHit.issues.map((item) => item.id)).toEqual(["raw_num_key_888"]);
    expect(rawNumKeyHit.issues[0]?.matchSource).toBe("key");

    // 6. Pagination offset/limit and total consistency
    const page1 = assertMatchesOracle({ q: "alpha-100", workspaceId: "local", limit: 2, offset: 0 });
    const page2 = assertMatchesOracle({ q: "alpha-100", workspaceId: "local", limit: 2, offset: 2 });
    const pageBeyond = assertMatchesOracle({ q: "alpha-100", workspaceId: "local", limit: 2, offset: 50 });
    expect(page1.total).toBe(openAlpha.total);
    expect(page2.total).toBe(openAlpha.total);
    expect(pageBeyond.total).toBe(openAlpha.total);
    expect(page1.issues).toHaveLength(2);
    expect(page2.issues).toHaveLength(2);
    expect(pageBeyond.issues).toHaveLength(0);
    expect([...page1.issues, ...page2.issues].map((item) => item.id)).toEqual(openAlpha.issues.slice(0, 4).map((item) => item.id));
  }, 30_000);

  it("breaks equal created_at comment snippet ties deterministically by seq DESC, id DESC", () => {
    const f = fixture();
    const issue = f.createIssue({
      workspaceId: "local",
      title: "Tie-break comment issue",
      description: "Clean description",
    });
    const first = f.store.createIssueComment(issue.id, {
      body: "TIEBREAK-777 café earlier seq 1 snippet",
    });
    const second = f.store.createIssueComment(issue.id, {
      body: "TIEBREAK-777 café later seq 2 winner snippet",
    });
    const nonMatching = f.store.createIssueComment(issue.id, {
      body: "Unrelated seq 3 comment at identical timestamp",
    });
    const tiedTimestamp = "2026-10-10T10:00:00.000Z";
    setCommentCreatedAt(f.db, first.id, tiedTimestamp);
    setCommentCreatedAt(f.db, second.id, tiedTimestamp);
    setCommentCreatedAt(f.db, nonMatching.id, tiedTimestamp);

    // SQL pushdown path: ORDER BY l.created_at DESC, l.seq DESC, l.id DESC
    const sqlPath = f.store.searchIssues({ q: "TIEBREAK-777", workspaceId: "local" });
    expect(sqlPath.total).toBe(1);
    expect(sqlPath.issues[0]?.matchSource).toBe("comment");
    expect(sqlPath.issues[0]?.matchedCommentSnippet).toContain("later seq 2 winner snippet");
    expect(sqlPath.issues[0]?.matchedSnippet).toBe(sqlPath.issues[0]?.matchedCommentSnippet);

    // Non-ASCII cased fallback path enforces the exact same tie-breaking contract
    const fallbackPath = f.store.searchIssues({ q: "café tiebreak-777", workspaceId: "local" });
    expect(fallbackPath.total).toBe(1);
    expect(fallbackPath.issues[0]?.matchSource).toBe("comment");
    expect(fallbackPath.issues[0]?.matchedCommentSnippet).toContain("later seq 2 winner snippet");
    expect(fallbackPath.issues[0]?.matchedSnippet).toBe(fallbackPath.issues[0]?.matchedCommentSnippet);
  }, 30_000);

  it("filters all 25 ECMAScript whitespace-padded closed statuses and SQLite non-text archived_at identically to legacy oracle", () => {
    const f = fixture();
    const ecmaWhitespaceChars = [
      "\t", "\n", "\v", "\f", "\r", " ",
      "\u00a0", "\u1680",
      "\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005", "\u2006", "\u2007", "\u2008", "\u2009", "\u200a",
      "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff",
    ];
    expect(ecmaWhitespaceChars).toHaveLength(25);

    const openControl = f.createIssue({
      workspaceId: "local",
      title: "UNIWS-25 open control",
      description: "Must stay visible when includeClosed=false",
    });
    setUpdatedAt(f.db, openControl.id, "2026-10-12T00:00:00.000Z");

    const archivedUnicodeClosed = f.createIssue({
      workspaceId: "local",
      title: "UNIWS-25 archived nbsp bom done",
      description: "Archived closed row stays visible even when includeClosed=false",
    });
    f.db.run("UPDATE multiremi_issues SET status = ?, archived_at = ? WHERE id = ?", [
      "\u00a0\u3000done\ufeff",
      "2026-10-12T00:01:00.000Z",
      archivedUnicodeClosed.id,
    ]);
    setUpdatedAt(f.db, archivedUnicodeClosed.id, "2026-10-12T00:01:00.000Z");

    const unarchivedClosedIds: string[] = [];
    ecmaWhitespaceChars.forEach((wsChar, idx) => {
      const closedStatus = idx % 2 === 0 ? "done" : "cancelled";
      const issue = f.createIssue({
        workspaceId: "local",
        title: `UNIWS-25 padded ${closedStatus} #${idx}`,
        description: `Wrapped with U+${wsChar.codePointAt(0)!.toString(16).toUpperCase()}`,
      });
      f.db.run("UPDATE multiremi_issues SET status = ? WHERE id = ?", [`${wsChar}${closedStatus}${wsChar}`, issue.id]);
      setUpdatedAt(f.db, issue.id, `2026-10-12T01:${String(idx).padStart(2, "0")}:00.000Z`);
      unarchivedClosedIds.push(issue.id);
    });

    const emptyArchivedCancelled = f.createIssue({
      workspaceId: "local",
      title: "UNIWS-25 empty-string archived_at cancelled",
      description: "Empty string archived_at is falsy in !issue.archivedAt and must not exempt closed row",
    });
    f.db.run("UPDATE multiremi_issues SET status = ?, archived_at = ? WHERE id = ?", [
      "\u3000cancelled\u202f",
      "",
      emptyArchivedCancelled.id,
    ]);
    setUpdatedAt(f.db, emptyArchivedCancelled.id, "2026-10-12T01:59:00.000Z");
    unarchivedClosedIds.push(emptyArchivedCancelled.id);

    if (backend === "SQLite") {
      // Non-text SQLite BLOB stored in TEXT column archived_at: SQLite TEXT affinity preserves BLOBs,
      // and baseline nullableString(row.archived_at) returns null for Uint8Array so !issue.archivedAt is true.
      const blobArchivedDone = f.createIssue({
        workspaceId: "local",
        title: "UNIWS-25 sqlite blob archived_at done",
        description: "SQLite BLOB archived_at must not exempt closed row",
      });
      f.db.run("UPDATE multiremi_issues SET status = ?, archived_at = ? WHERE id = ?", [
        "\u00a0done\ufeff",
        new Uint8Array([50, 48, 50, 54]),
        blobArchivedDone.id,
      ]);
      setUpdatedAt(f.db, blobArchivedDone.id, "2026-10-12T02:00:00.000Z");
      unarchivedClosedIds.push(blobArchivedDone.id);
    }

    for (const includeCommentBodies of [true, false]) {
      const closedExcludedExpected = legacySearchIssuesOracle(f.store, f.db, {
        q: "UNIWS-25",
        workspaceId: "local",
        includeClosed: false,
        includeCommentBodies,
        limit: 50,
      });
      const closedExcludedActual = f.store.searchIssues({
        q: "UNIWS-25",
        workspaceId: "local",
        includeClosed: false,
        includeCommentBodies,
        limit: 50,
      });
      expect(closedExcludedActual).toEqual(closedExcludedExpected);
      expect(closedExcludedActual.issues.map((item) => item.id)).toEqual([
        archivedUnicodeClosed.id,
        openControl.id,
      ]);

      const closedIncludedExpected = legacySearchIssuesOracle(f.store, f.db, {
        q: "UNIWS-25",
        workspaceId: "local",
        includeClosed: true,
        includeCommentBodies,
        limit: 50,
      });
      const closedIncludedActual = f.store.searchIssues({
        q: "UNIWS-25",
        workspaceId: "local",
        includeClosed: true,
        includeCommentBodies,
        limit: 50,
      });
      expect(closedIncludedActual).toEqual(closedIncludedExpected);
      expect(closedIncludedActual.total).toBe(2 + unarchivedClosedIds.length);
    }
  }, 30_000);

  it("matches tie-breaking for equal Date.parse(updatedAt) timezone variants and deterministic identical-timestamp paging across store and HTTP routes", async () => {
    const f = fixture();

    // Two comment-only matches with the exact same UTC instant (2026-10-15T12:00:00Z),
    // written with different timezone offsets. Lexicographically "...14:00:00+02:00" > "...12:00:00Z",
    // so baseline ORDER BY updated_at DESC + stable JS sort places offsetIssue before utcIssue
    // even though utcIssue was inserted first (smaller rowid).
    const commentUtcIssue = f.createIssue({
      workspaceId: "local",
      title: "Timezone comment tie A",
      description: "Clean description",
    });
    f.store.createIssueComment(commentUtcIssue.id, { body: "TZTIE-COMMENT-888 café utc variant" });
    setUpdatedAt(f.db, commentUtcIssue.id, "2026-10-15T12:00:00Z");

    const commentOffsetIssue = f.createIssue({
      workspaceId: "local",
      title: "Timezone comment tie B",
      description: "Clean description",
    });
    f.store.createIssueComment(commentOffsetIssue.id, { body: "TZTIE-COMMENT-888 café +02:00 variant" });
    setUpdatedAt(f.db, commentOffsetIssue.id, "2026-10-15T14:00:00+02:00");

    // Two title matches with the exact same UTC instant and different timezone spellings
    const titleUtcIssue = f.createIssue({
      workspaceId: "local",
      title: "TZTIE-TITLE-888 café utc variant",
      description: "Clean description",
    });
    setUpdatedAt(f.db, titleUtcIssue.id, "2026-10-16T08:00:00.000Z");

    const titleOffsetIssue = f.createIssue({
      workspaceId: "local",
      title: "TZTIE-TITLE-888 café +03:00 variant",
      description: "Clean description",
    });
    setUpdatedAt(f.db, titleOffsetIssue.id, "2026-10-16T11:00:00+03:00");

    // Verify both SQL pushdown path and non-ASCII fallback path across limit=1 pagination
    for (const input of [
      { q: "TZTIE-COMMENT-888", includeCommentBodies: true },
      { q: "TZTIE-COMMENT-888 café", includeCommentBodies: true },
      { q: "TZTIE-TITLE-888", includeCommentBodies: true },
      { q: "TZTIE-TITLE-888", includeCommentBodies: false },
      { q: "TZTIE-TITLE-888 café", includeCommentBodies: false },
    ]) {
      const expectedFirst = input.q.includes("COMMENT") ? commentOffsetIssue.id : titleOffsetIssue.id;
      const expectedSecond = input.q.includes("COMMENT") ? commentUtcIssue.id : titleUtcIssue.id;

      const page0Expected = legacySearchIssuesOracle(f.store, f.db, { ...input, workspaceId: "local", limit: 1, offset: 0 });
      const page0Actual = f.store.searchIssues({ ...input, workspaceId: "local", limit: 1, offset: 0 });
      const page1Expected = legacySearchIssuesOracle(f.store, f.db, { ...input, workspaceId: "local", limit: 1, offset: 1 });
      const page1Actual = f.store.searchIssues({ ...input, workspaceId: "local", limit: 1, offset: 1 });

      expect(page0Actual).toEqual(page0Expected);
      expect(page1Actual).toEqual(page1Expected);
      expect(page0Actual.issues.map((item) => item.id)).toEqual([expectedFirst]);
      expect(page1Actual.issues.map((item) => item.id)).toEqual([expectedSecond]);
    }

    // Identical updated_at text on two comment-only hits that each also have a newer hidden draft:
    // - SQLite preserves legacy `i.rowid ASC` insertion order (`iss_zz_ident_first` -> `iss_aa_ident_second`).
    // - PostgreSQL defines deterministic logical primary-key tie-breaking `i.id ASC`
    //   (`iss_aa_ident_second` -> `iss_zz_ident_first`), avoiding physical heap/ctid drift
    //   and undefined PG baseline quicksort ties.
    const identTimestamp = "2026-10-17T00:00:00.000Z";
    f.db.run(
      `INSERT INTO multiremi_issues (id, issue_number, issue_key, title, description, status, workspace_id, created_at, updated_at)
       VALUES ('iss_zz_ident_first', 9901, 'MUL-9901', 'Neutral identical-ts first inserted', NULL, 'todo', 'local', ?, ?)`,
      [identTimestamp, identTimestamp],
    );
    f.db.run(
      `INSERT INTO multiremi_issues (id, issue_number, issue_key, title, description, status, workspace_id, created_at, updated_at)
       VALUES ('iss_aa_ident_second', 9902, 'MUL-9902', 'Neutral identical-ts second inserted', NULL, 'todo', 'local', ?, ?)`,
      [identTimestamp, identTimestamp],
    );
    for (const [issueId, label] of [
      ["iss_zz_ident_first", "first-inserted-zz"],
      ["iss_aa_ident_second", "second-inserted-aa"],
    ] as const) {
      const visible = f.store.createIssueComment(issueId, {
        body: `IDENTTIE-777 café visible winner ${label}`,
      });
      setCommentCreatedAt(f.db, visible.id, "2026-10-17T01:00:00.000Z");
      const hiddenDraft = f.store.createIssueComment(issueId, {
        body: `IDENTTIE-777 café hidden newer draft ${label}`,
      });
      setCommentCreatedAt(f.db, hiddenDraft.id, "2026-10-17T02:00:00.000Z");
      f.db.run("UPDATE multiremi_conversation_log SET visibility = 'hidden' WHERE id = ?", [hiddenDraft.id]);
      setUpdatedAt(f.db, issueId, identTimestamp);
    }

    const expectedIdentOrder = backend === "PostgreSQL"
      ? ["iss_aa_ident_second", "iss_zz_ident_first"]
      : ["iss_zz_ident_first", "iss_aa_ident_second"];

    const app = createMultiremiApp({ store: f.store });
    for (const q of ["IDENTTIE-777", "IDENTTIE-777 café"]) {
      // 1. Store pagination: limit=1, offset=0/1/2
      const p0 = f.store.searchIssues({ q, workspaceId: "local", limit: 1, offset: 0 });
      const p1 = f.store.searchIssues({ q, workspaceId: "local", limit: 1, offset: 1 });
      const p2 = f.store.searchIssues({ q, workspaceId: "local", limit: 1, offset: 2 });
      expect(p0.total).toBe(2);
      expect(p1.total).toBe(2);
      expect(p2.total).toBe(2);
      expect(p0.issues.map((item) => item.id)).toEqual([expectedIdentOrder[0]]);
      expect(p1.issues.map((item) => item.id)).toEqual([expectedIdentOrder[1]]);
      expect(p2.issues).toEqual([]);
      expect(p0.issues[0]?.matchedCommentSnippet).toContain("visible winner");
      expect(p0.issues[0]?.matchedCommentSnippet).not.toContain("hidden newer draft");
      expect(p1.issues[0]?.matchedCommentSnippet).toContain("visible winner");
      expect(p1.issues[0]?.matchedCommentSnippet).not.toContain("hidden newer draft");

      if (backend === "SQLite") {
        expect(p0).toEqual(legacySearchIssuesOracle(f.store, f.db, { q, workspaceId: "local", limit: 1, offset: 0 }));
        expect(p1).toEqual(legacySearchIssuesOracle(f.store, f.db, { q, workspaceId: "local", limit: 1, offset: 1 }));
        expect(p2).toEqual(legacySearchIssuesOracle(f.store, f.db, { q, workspaceId: "local", limit: 1, offset: 2 }));
      }

      // 2. Compatibility HTTP route GET /api/issues/search (limit=1, offset=0/1/2)
      const identPages: Array<[number, string[]]> = [
        [0, [expectedIdentOrder[0]!]],
        [1, [expectedIdentOrder[1]!]],
        [2, []],
      ];
      for (const [offset, expectedIds] of identPages) {
        const compatResp = await app.request(
          `/api/issues/search?q=${encodeURIComponent(q)}&workspace_id=local&limit=1&offset=${offset}`,
        );
        expect(compatResp.status).toBe(200);
        expect(compatResp.headers.get("X-Total-Count")).toBe("2");
        const compatBody = await compatResp.json() as {
          issues: Array<{ id: string; matched_comment_snippet?: string }>;
          total: number;
        };
        expect(compatBody.total).toBe(2);
        expect(compatBody.issues.map((item) => item.id)).toEqual(expectedIds);
        if (expectedIds.length === 1) {
          expect(compatBody.issues[0]?.matched_comment_snippet).toContain("visible winner");
          expect(compatBody.issues[0]?.matched_comment_snippet).not.toContain("hidden newer draft");
        }
      }

      // 3. Canonical HTTP route GET /api/multiremi/issues/search (limit=1, offset=0/1/2)
      for (const [offset, expectedIds] of identPages) {
        const canonicalResp = await app.request(
          `/api/multiremi/issues/search?q=${encodeURIComponent(q)}&workspaceId=local&limit=1&offset=${offset}`,
        );
        expect(canonicalResp.status).toBe(200);
        const canonicalBody = await canonicalResp.json() as {
          issues: Array<{ id: string; matchedCommentSnippet?: string }>;
          total: number;
        };
        expect(canonicalBody.total).toBe(2);
        expect(canonicalBody.issues.map((item) => item.id)).toEqual(expectedIds);
        if (expectedIds.length === 1) {
          expect(canonicalBody.issues[0]?.matchedCommentSnippet).toContain("visible winner");
          expect(canonicalBody.issues[0]?.matchedCommentSnippet).not.toContain("hidden newer draft");
        }
      }
    }
  }, 30_000);

  it("matches native DB collation tie-breaking for equal-instant ISO strings (with vs without fractional seconds) across store paths and HTTP", async () => {
    const f = fixture();
    // Same UTC instant (2026-01-01T12:00:00Z), but SQLite BINARY ('.' 0x2E > '+' 0x2B)
    // and PostgreSQL en_US.utf8 UCA collation order these two strings in opposite directions
    // under native `ORDER BY updated_at DESC`. Relying on database-native ROW_NUMBER() /
    // ORDER BY instead of JS code-unit comparison keeps every page identical to legacy oracle.
    const isoWithoutMs = "2026-01-01T13:00:00+01:00";
    const isoWithMs = "2026-01-01T13:00:00.000+01:00";
    expect(Date.parse(isoWithoutMs)).toBe(Date.parse(isoWithMs));

    const titleNoMs = f.createIssue({
      workspaceId: "local",
      title: "ISOTIE-TITLE-999 café without fractional seconds",
      description: "Clean description",
    });
    setUpdatedAt(f.db, titleNoMs.id, isoWithoutMs);

    const titleWithMs = f.createIssue({
      workspaceId: "local",
      title: "ISOTIE-TITLE-999 café with fractional seconds",
      description: "Clean description",
    });
    setUpdatedAt(f.db, titleWithMs.id, isoWithMs);

    const commentNoMs = f.createIssue({
      workspaceId: "local",
      title: "Neutral ISO comment tie A",
      description: "Clean description",
    });
    f.store.createIssueComment(commentNoMs.id, { body: "ISOTIE-COMMENT-999 café without fractional seconds" });
    setUpdatedAt(f.db, commentNoMs.id, isoWithoutMs);

    const commentWithMs = f.createIssue({
      workspaceId: "local",
      title: "Neutral ISO comment tie B",
      description: "Clean description",
    });
    f.store.createIssueComment(commentWithMs.id, { body: "ISOTIE-COMMENT-999 café with fractional seconds" });
    setUpdatedAt(f.db, commentWithMs.id, isoWithMs);

    // 1. Store paths: title hit, comment-only hit, SQL pushdown, non-ASCII fallback
    for (const input of [
      { q: "ISOTIE-TITLE-999", includeCommentBodies: true, pair: [titleNoMs.id, titleWithMs.id] },
      { q: "ISOTIE-TITLE-999", includeCommentBodies: false, pair: [titleNoMs.id, titleWithMs.id] },
      { q: "ISOTIE-TITLE-999 café", includeCommentBodies: false, pair: [titleNoMs.id, titleWithMs.id] },
      { q: "ISOTIE-COMMENT-999", includeCommentBodies: true, pair: [commentNoMs.id, commentWithMs.id] },
      { q: "ISOTIE-COMMENT-999 café", includeCommentBodies: true, pair: [commentNoMs.id, commentWithMs.id] },
    ]) {
      const page0Expected = legacySearchIssuesOracle(f.store, f.db, {
        q: input.q,
        includeCommentBodies: input.includeCommentBodies,
        workspaceId: "local",
        limit: 1,
        offset: 0,
      });
      const page0Actual = f.store.searchIssues({
        q: input.q,
        includeCommentBodies: input.includeCommentBodies,
        workspaceId: "local",
        limit: 1,
        offset: 0,
      });
      const page1Expected = legacySearchIssuesOracle(f.store, f.db, {
        q: input.q,
        includeCommentBodies: input.includeCommentBodies,
        workspaceId: "local",
        limit: 1,
        offset: 1,
      });
      const page1Actual = f.store.searchIssues({
        q: input.q,
        includeCommentBodies: input.includeCommentBodies,
        workspaceId: "local",
        limit: 1,
        offset: 1,
      });

      expect(page0Actual).toEqual(page0Expected);
      expect(page1Actual).toEqual(page1Expected);
      expect(page0Actual.total).toBe(2);
      expect(page1Actual.total).toBe(2);
      expect([...page0Actual.issues.map((i) => i.id), ...page1Actual.issues.map((i) => i.id)].sort()).toEqual([...input.pair].sort());
    }

    // 2. HTTP /api/issues/search page 1 and page 2 parity against legacy oracle
    const app = createMultiremiApp({ store: f.store });
    for (const q of ["ISOTIE-TITLE-999", "ISOTIE-COMMENT-999", "ISOTIE-COMMENT-999 café"]) {
      const expected0 = legacySearchIssuesOracle(f.store, f.db, { q, workspaceId: "local", limit: 1, offset: 0 });
      const expected1 = legacySearchIssuesOracle(f.store, f.db, { q, workspaceId: "local", limit: 1, offset: 1 });

      const resp0 = await app.request(`/api/issues/search?q=${encodeURIComponent(q)}&workspace_id=local&limit=1&offset=0`);
      expect(resp0.status).toBe(200);
      expect(resp0.headers.get("X-Total-Count")).toBe("2");
      const body0 = await resp0.json() as { issues: Array<{ id: string }>; total: number };

      const resp1 = await app.request(`/api/issues/search?q=${encodeURIComponent(q)}&workspace_id=local&limit=1&offset=1`);
      expect(resp1.status).toBe(200);
      expect(resp1.headers.get("X-Total-Count")).toBe("2");
      const body1 = await resp1.json() as { issues: Array<{ id: string }>; total: number };

      expect(body0.total).toBe(2);
      expect(body1.total).toBe(2);
      expect(body0.issues.map((item) => item.id)).toEqual(expected0.issues.map((item) => item.id));
      expect(body1.issues.map((item) => item.id)).toEqual(expected1.issues.map((item) => item.id));
    }
  }, 30_000);

  it("keeps SQL query count O(1) across growing workspace and foreign issue counts", async () => {
    const f = fixture();
    const foreignWs = f.store.createWorkspace({ name: "Foreign Scale", slug: "scale-foreign" });
    const tag = f.store.createLabel({ name: "perf-label", color: "#10b981", workspaceId: "local" });

    const seedScale = (startIndex: number, localCount: number, foreignCount: number) => {
      f.transaction(() => {
        for (let i = startIndex; i < startIndex + localCount; i += 1) {
          const id = `scale_local_${i}`;
          const num = 1000 + i;
          const updatedAt = `2026-11-${String(1 + (i % 20)).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.${String(i % 1000).padStart(3, "0")}Z`;
          const isTitleMatch = i % 5 === 0;
          const isCommentMatch = i % 7 === 0;
          const title = isTitleMatch ? `Target titlehit batch ${i}` : `Ordinary local issue ${i}`;
          f.db.run(
            `INSERT INTO multiremi_issues (id, issue_number, issue_key, title, description, status, workspace_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'todo', 'local', ?, ?)`,
            [id, num, `MUL-${num}`, title, `Description body for issue ${i}`, updatedAt, updatedAt],
          );
          if (i % 3 === 0) {
            f.db.run("INSERT INTO multiremi_issue_to_labels (issue_id, label_id) VALUES (?, ?)", [id, tag.id]);
          }
          const sessionId = `sess_local_${i}`;
          f.db.run(
            `INSERT INTO multiremi_issue_sessions (id, issue_id, workspace_id, title, status, is_default, created_at, updated_at)
             VALUES (?, ?, 'local', 'Main', 'active', 1, ?, ?)`,
            [sessionId, id, updatedAt, updatedAt],
          );
          f.db.run(
            `INSERT INTO multiremi_conversation_log (session_id, seq, id, kind, visibility, sender_type, body_md, created_at, updated_at)
             VALUES (?, 1, ?, 'message', 'shown', 'member', ?, ?, ?)`,
            [
              sessionId,
              `msg_local_${i}_1`,
              isCommentMatch ? `Older commenthit token on issue ${i}` : `Regular comment one on ${i}`,
              "2026-11-01T00:00:00.000Z",
              "2026-11-01T00:00:00.000Z",
            ],
          );
          f.db.run(
            `INSERT INTO multiremi_conversation_log (session_id, seq, id, kind, visibility, sender_type, body_md, created_at, updated_at)
             VALUES (?, 2, ?, 'message', 'shown', 'member', ?, ?, ?)`,
            [
              sessionId,
              `msg_local_${i}_2`,
              isCommentMatch ? `Latest commenthit token on issue ${i}` : `Regular comment two on ${i}`,
              "2026-11-02T00:00:00.000Z",
              "2026-11-02T00:00:00.000Z",
            ],
          );
        }
        for (let i = startIndex; i < startIndex + foreignCount; i += 1) {
          const id = `scale_foreign_${i}`;
          const num = 5000 + i;
          const updatedAt = `2026-11-05T${String(i % 24).padStart(2, "0")}:00:00.000Z`;
          f.db.run(
            `INSERT INTO multiremi_issues (id, issue_number, issue_key, title, description, status, workspace_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, ?)`,
            [id, num, `MUL-${num}`, `Foreign titlehit commenthit ${i}`, `Foreign body ${i}`, foreignWs.id, updatedAt, updatedAt],
          );
          const sessionId = `sess_foreign_${i}`;
          f.db.run(
            `INSERT INTO multiremi_issue_sessions (id, issue_id, workspace_id, title, status, is_default, created_at, updated_at)
             VALUES (?, ?, ?, 'Main', 'active', 1, ?, ?)`,
            [sessionId, id, foreignWs.id, updatedAt, updatedAt],
          );
          f.db.run(
            `INSERT INTO multiremi_conversation_log (session_id, seq, id, kind, visibility, sender_type, body_md, created_at, updated_at)
             VALUES (?, 1, ?, 'message', 'shown', 'member', ?, ?, ?)`,
            [sessionId, `msg_foreign_${i}`, `Foreign commenthit token ${i}`, updatedAt, updatedAt],
          );
        }
      });
    };

    // Small scale: 15 local + 25 foreign = 40 total issues
    seedScale(0, 15, 25);

    const smallMissBefore = measureSql(f.db, () => legacySearchIssuesOracle(f.store, f.db, { q: "no-match-anywhere", workspaceId: "local", limit: 5 }));
    const smallMissAfter = measureSql(f.db, () => f.store.searchIssues({ q: "no-match-anywhere", workspaceId: "local", limit: 5 }));
    const smallTitleAfter = measureSql(f.db, () => f.store.searchIssues({ q: "titlehit", workspaceId: "local", limit: 5 }));
    const smallCommentBefore = measureSql(f.db, () => legacySearchIssuesOracle(f.store, f.db, { q: "commenthit", workspaceId: "local", limit: 5 }));
    const smallCommentAfter = measureSql(f.db, () => f.store.searchIssues({ q: "commenthit", workspaceId: "local", limit: 5 }));
    const smallNoCommentAfter = measureSql(f.db, () => f.store.searchIssues({ q: "titlehit", workspaceId: "local", includeCommentBodies: false, limit: 5 }));

    expect(smallMissAfter.result).toEqual(smallMissBefore.result);
    expect(smallCommentAfter.result).toEqual(smallCommentBefore.result);
    expect(smallMissAfter).toMatchObject({ reads: 1, writes: 0 });
    expect(smallTitleAfter).toMatchObject({ reads: 3, writes: 0 });
    expect(smallCommentAfter).toMatchObject({ reads: 4, writes: 0 });
    expect(smallNoCommentAfter).toMatchObject({ reads: 3, writes: 0 });
    expect(smallMissBefore.reads).toBeGreaterThanOrEqual(40);

    // Large scale: +105 local + 155 foreign => 120 local + 180 foreign = 300 total issues
    seedScale(100, 105, 155);

    const largeMissBefore = measureSql(f.db, () => legacySearchIssuesOracle(f.store, f.db, { q: "no-match-anywhere", workspaceId: "local", limit: 5 }));
    const largeMissAfter = measureSql(f.db, () => f.store.searchIssues({ q: "no-match-anywhere", workspaceId: "local", limit: 5 }));
    const largeTitleBefore = measureSql(f.db, () => legacySearchIssuesOracle(f.store, f.db, { q: "titlehit", workspaceId: "local", limit: 5 }));
    const largeTitleAfter = measureSql(f.db, () => f.store.searchIssues({ q: "titlehit", workspaceId: "local", limit: 5 }));
    const largeCommentBefore = measureSql(f.db, () => legacySearchIssuesOracle(f.store, f.db, { q: "commenthit", workspaceId: "local", limit: 5 }));
    const largeCommentAfter = measureSql(f.db, () => f.store.searchIssues({ q: "commenthit", workspaceId: "local", limit: 5 }));
    const largeMultiTermAfter = measureSql(f.db, () => f.store.searchIssues({ q: "token commenthit", workspaceId: "local", limit: 5 }));
    const largeNoCommentAfter = measureSql(f.db, () => f.store.searchIssues({ q: "titlehit", workspaceId: "local", includeCommentBodies: false, limit: 5 }));
    const largeUnicodeMissAfter = measureSql(f.db, () => f.store.searchIssues({ q: "café-absent", workspaceId: "local", limit: 5 }));

    expect(largeMissAfter.result).toEqual(largeMissBefore.result);
    expect(largeTitleAfter.result).toEqual(largeTitleBefore.result);
    expect(largeCommentAfter.result).toEqual(largeCommentBefore.result);
    expect(largeMultiTermAfter.result).toEqual(legacySearchIssuesOracle(f.store, f.db, { q: "token commenthit", workspaceId: "local", limit: 5 }));

    // Constant O(1) SQL statement budget identical between 40-issue and 300-issue datasets!
    expect(largeMissAfter.reads).toBe(smallMissAfter.reads);
    expect(largeTitleAfter.reads).toBe(smallTitleAfter.reads);
    expect(largeCommentAfter.reads).toBe(smallCommentAfter.reads);
    expect(largeMultiTermAfter.reads).toBe(smallCommentAfter.reads);
    expect(largeNoCommentAfter.reads).toBe(smallNoCommentAfter.reads);
    expect(largeUnicodeMissAfter).toMatchObject({ reads: 2, writes: 0 });
    expect(largeMissAfter.writes).toBe(0);
    expect(largeTitleAfter.writes).toBe(0);
    expect(largeCommentAfter.writes).toBe(0);
    expect(largeMissAfter.txControl).toBe(backend === "PostgreSQL" ? 1 : 0);
    expect(largeCommentAfter.txControl).toBe(backend === "PostgreSQL" ? 1 : 0);
    expect(largeUnicodeMissAfter.txControl).toBe(backend === "PostgreSQL" ? 1 : 0);
    expect(largeMissBefore.reads).toBeGreaterThanOrEqual(300);

    // Calling searchIssues inside an existing outer transaction reuses that transaction
    // without issuing a nested SET TRANSACTION ISOLATION LEVEL statement (PostgreSQL
    // requires REPEATABLE READ or SERIALIZABLE isolation and verifies it via current_setting).
    const nestedSearch = f.transaction(() => {
      if (backend === "PostgreSQL") {
        f.db.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      }
      return measureSql(f.db, () => f.store.searchIssues({ q: "no-match-anywhere", workspaceId: "local", limit: 5 }));
    });
    expect(nestedSearch.result).toEqual(largeMissAfter.result);
    expect(nestedSearch.txControl).toBe(0);
    expect(nestedSearch).toMatchObject({ reads: backend === "PostgreSQL" ? 2 : 1, writes: 0 });

    if (backend === "PostgreSQL") {
      // Calling searchIssues inside a default READ COMMITTED outer transaction must fail fast
      // rather than silently allowing cross-statement snapshot tearing.
      expect(() =>
        f.transaction(() => f.store.searchIssues({ q: "no-match-anywhere", workspaceId: "local", limit: 5 })),
      ).toThrow("searchIssues inside an open PostgreSQL transaction requires REPEATABLE READ or SERIALIZABLE isolation");
    }

    // Candidate query with comment bodies materializes workspace_issues once + matched_comments via UNION ALL
    expect(largeMissAfter.statements[0]).toContain("workspace_issues AS MATERIALIZED");
    expect(largeMissAfter.statements[0]).toContain("matched_comments AS MATERIALIZED");
    expect(largeMissAfter.statements[0]).toContain("UNION ALL");
    if (backend === "PostgreSQL") {
      expect(largeMissAfter.statements[0]).toContain("BTRIM(");
      expect(largeMissAfter.statements[0]).not.toContain("TYPEOF(");
      expect(largeMissAfter.statements[0]).not.toContain("i.rowid");
      expect(largeMissAfter.statements[0]).not.toContain("i.ctid");
      expect(largeMissAfter.statements[0]).toContain("ROW_NUMBER() OVER (ORDER BY i.updated_at DESC, i.id ASC) AS issue_ord");
      expect(largeMissAfter.statements[0]).toContain("CROSS JOIN LATERAL");
      expect(largeMissAfter.statements[0]).toContain("LIMIT 1");

      // Under un-analyzed bulk inserts (reltuples = 0), CROSS JOIN LATERAL (... LIMIT 1) must force
      // an Index Cond probe on multiremi_conversation_log.session_id (no unindexed Join Filter / Seq Scan).
      const candidateCall = largeMissAfter.calls[0]!;
      const explainRows = f.db.query(`EXPLAIN ${candidateCall.sql}`).all(...candidateCall.params) as Array<Record<string, unknown>>;
      const explainText = explainRows.map((row) => String(Object.values(row)[0] ?? "")).join("\n");
      expect(explainText).toMatch(/Index Cond:.*session_id/i);
      expect(explainText).not.toMatch(/Join Filter:.*session_id/i);
      expect(explainText).not.toContain("Seq Scan on multiremi_conversation_log");
    } else {
      expect(largeMissAfter.statements[0]).toContain("TRIM(");
      expect(largeMissAfter.statements[0]).toContain("TYPEOF(i.archived_at) = 'text'");
      expect(largeMissAfter.statements[0]).toContain("ROW_NUMBER() OVER (ORDER BY i.updated_at DESC, i.rowid ASC) AS issue_ord");
      expect(largeMissAfter.statements[0]).not.toContain("CROSS JOIN LATERAL");
      expect(largeMissAfter.statements[0]).toContain("CHAR(0)");
      expect(largeMissAfter.statements[0]).not.toContain("X'00'");
      expect(largeMissAfter.statements[0]).not.toContain("ZEROBLOB(1)");
      expect(largeNoCommentAfter.statements[0]).toContain("CHAR(0)");
      expect(largeNoCommentAfter.statements[0]).not.toContain("X'00'");
      expect(largeNoCommentAfter.statements[0]).not.toContain("ZEROBLOB(1)");
    }

    // Every emitted SQL statement translates cleanly for PostgreSQL (numbered $N placeholders, intact ESCAPE '\' and AS MATERIALIZED).
    for (const sql of [...largeMissAfter.statements, ...largeCommentAfter.statements, ...largeMultiTermAfter.statements, ...largeNoCommentAfter.statements]) {
      const pgSql = translateSqliteToPg(sql);
      expect(pgSql).not.toContain("?");
      if (sql.includes("AS MATERIALIZED")) {
        expect(pgSql).toContain("AS MATERIALIZED");
        expect(pgSql).toContain("UNION ALL");
      }
      if (sql.includes("LIKE")) {
        expect(pgSql).toContain("ESCAPE '\\'");
      }
    }

    // Explicitly verify translateSqliteToPg preserves the PostgreSQL LATERAL + ROW_NUMBER(i.id) candidate shape
    // even when this test runs on SQLite locally without MULTIREMI_TEST_POSTGRES_URL.
    const pgCandidateTemplate = `WITH workspace_issues AS MATERIALIZED (
      SELECT i.id, i.updated_at, ROW_NUMBER() OVER (ORDER BY i.updated_at DESC, i.id ASC) AS issue_ord,
        CASE WHEN (LOWER(i.title) LIKE ? ESCAPE '\\') THEN 1 ELSE NULL END AS match_rank
      FROM multiremi_issues i
      WHERE i.workspace_id = ?
    ),
    matched_comments AS MATERIALIZED (
      SELECT DISTINCT wi.id, wi.updated_at, wi.issue_ord
      FROM workspace_issues wi
      JOIN multiremi_issue_sessions s ON s.issue_id = wi.id AND s.chat_id IS NULL
      CROSS JOIN LATERAL (
        SELECT 1 AS hit
        FROM multiremi_conversation_log l
        WHERE l.session_id = s.id
          AND l.visibility = 'shown'
          AND l.kind = 'message'
          AND l.deleted_at IS NULL
          AND (LOWER(l.body_md) LIKE ? ESCAPE '\\')
        LIMIT 1
      ) cm
    )
    SELECT id, updated_at, issue_ord, 0 AS has_comment_match, match_rank FROM workspace_issues WHERE match_rank IS NOT NULL
    UNION ALL
    SELECT id, updated_at, issue_ord, 1 AS has_comment_match, 3 AS match_rank FROM matched_comments`;
    const translatedPgCandidate = translateSqliteToPg(pgCandidateTemplate);
    expect(translatedPgCandidate).not.toContain("?");
    expect(translatedPgCandidate).toContain("$1");
    expect(translatedPgCandidate).toContain("$2");
    expect(translatedPgCandidate).toContain("$3");
    expect(translatedPgCandidate).toContain("workspace_issues AS MATERIALIZED");
    expect(translatedPgCandidate).toContain("matched_comments AS MATERIALIZED");
    expect(translatedPgCandidate).toContain("ROW_NUMBER() OVER (ORDER BY i.updated_at DESC, i.id ASC) AS issue_ord");
    expect(translatedPgCandidate).toContain("CROSS JOIN LATERAL");
    expect(translatedPgCandidate).toContain("LIMIT 1");
    expect(translatedPgCandidate).toContain("ESCAPE '\\'");

    // Also verify translateSqliteToPg preserves the bounded PostgreSQL comment-scan window SQL,
    // oversize SUBSTR chunking SQL, and transaction_isolation check.
    const pgBoundedCommentTemplate = `WITH batch AS (
      SELECT s.issue_id AS issue_id, l.created_at AS created_at, l.seq AS seq, l.id AS id, l.body_md AS body_md,
        OCTET_LENGTH(to_json(COALESCE(l.body_md, ''))::text) + OCTET_LENGTH(to_json(COALESCE(s.issue_id, ''))::text) + OCTET_LENGTH(to_json(COALESCE(l.created_at, ''))::text) + OCTET_LENGTH(to_json(COALESCE(l.id, ''))::text) + 160 AS row_bytes
      FROM multiremi_issue_sessions s
      JOIN multiremi_conversation_log l ON l.session_id = s.id
      WHERE s.issue_id IN (?, ?) AND s.chat_id IS NULL AND l.kind = 'message' AND l.visibility = 'shown' AND l.deleted_at IS NULL
      ORDER BY s.issue_id ASC, l.created_at DESC, l.seq DESC, l.id DESC
      LIMIT ?
    ),
    sized AS (
      SELECT issue_id, created_at, seq, id, body_md, row_bytes,
        ROW_NUMBER() OVER (ORDER BY issue_id ASC, created_at DESC, seq DESC, id DESC) AS rn,
        SUM(row_bytes) OVER (ORDER BY issue_id ASC, created_at DESC, seq DESC, id DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_bytes
      FROM batch
    )
    SELECT issue_id, created_at, seq, id,
      CASE WHEN cum_bytes > ? THEN NULL ELSE body_md END AS body_md,
      CASE WHEN rn = 1 AND cum_bytes > ? THEN 1 ELSE 0 END AS oversize,
      CASE WHEN rn > 1 AND cum_bytes > ? THEN 1 ELSE 0 END AS truncated
    FROM sized
    WHERE rn = 1 OR (cum_bytes - row_bytes) <= ?
    ORDER BY rn ASC`;
    const translatedPgBounded = translateSqliteToPg(pgBoundedCommentTemplate);
    expect(translatedPgBounded).not.toContain("?");
    expect(translatedPgBounded).toContain("$7");
    expect(translatedPgBounded).toContain("OCTET_LENGTH(to_json(COALESCE(l.body_md, ''))::text)");
    expect(translatedPgBounded).toContain("ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW");
    expect(translatedPgBounded).toContain("CASE WHEN rn = 1 AND cum_bytes > $5 THEN 1 ELSE 0 END AS oversize");
    expect(translatedPgBounded).toContain("WHERE rn = 1 OR (cum_bytes - row_bytes) <= $7");
    expect(
      translateSqliteToPg("SELECT SUBSTR(COALESCE(body_md, ''), ?, ?) AS c FROM multiremi_conversation_log WHERE id = ?"),
    ).toBe("SELECT SUBSTR(COALESCE(body_md, ''), $1, $2) AS c FROM multiremi_conversation_log WHERE id = $3");
    expect(
      translateSqliteToPg("SELECT current_setting('transaction_isolation') AS iso"),
    ).toBe("SELECT current_setting('transaction_isolation') AS iso");

    // HTTP route smoke check on the 300-issue dataset
    const app = createMultiremiApp({ store: f.store });
    const httpMeasured = await measureSqlAsync(f.db, async () => {
      const response = await app.request("/api/issues/search?q=commenthit&workspace_id=local&limit=5");
      expect(response.status).toBe(200);
      expect(response.headers.get("X-Total-Count")).toBe(String(largeCommentAfter.result.total));
      return await response.json() as { issues: Array<{ id: string; matched_comment_snippet?: string }>; total: number };
    });
    expect(httpMeasured.result.total).toBe(largeCommentAfter.result.total);
    expect(httpMeasured.result.issues).toHaveLength(5);
    expect(httpMeasured.result.issues[0]?.matched_comment_snippet).toContain("Latest commenthit token");
    expect(httpMeasured.writes).toBe(0);
    expect(httpMeasured.reads).toBeLessThanOrEqual(8);

    console.log(JSON.stringify({
      suite: "MUL-331",
      backend,
      smallTotalIssues: 40,
      largeTotalIssues: 300,
      miss: {
        smallBeforeReads: smallMissBefore.reads,
        smallAfterReads: smallMissAfter.reads,
        largeBeforeReads: largeMissBefore.reads,
        largeAfterReads: largeMissAfter.reads,
        largeBeforeMs: Number(largeMissBefore.elapsedMs.toFixed(2)),
        largeAfterMs: Number(largeMissAfter.elapsedMs.toFixed(2)),
      },
      titleHit: {
        largeBeforeReads: largeTitleBefore.reads,
        largeAfterReads: largeTitleAfter.reads,
        largeBeforeMs: Number(largeTitleBefore.elapsedMs.toFixed(2)),
        largeAfterMs: Number(largeTitleAfter.elapsedMs.toFixed(2)),
      },
      commentHit: {
        smallBeforeReads: smallCommentBefore.reads,
        smallAfterReads: smallCommentAfter.reads,
        largeBeforeReads: largeCommentBefore.reads,
        largeAfterReads: largeCommentAfter.reads,
        largeBeforeMs: Number(largeCommentBefore.elapsedMs.toFixed(2)),
        largeAfterMs: Number(largeCommentAfter.elapsedMs.toFixed(2)),
      },
      httpCommentHitReads: httpMeasured.reads,
      httpCommentHitMs: Number(httpMeasured.elapsedMs.toFixed(2)),
    }));
  }, 30_000);

  it("paginates comment reads within postgresReplyMaxBytes under low HTTP reply budget without PostgresReplyTooLargeError", async () => {
    const f = fixture();
    const pad = (label: string, bytes = 860) => `${label} ${"x".repeat(bytes)}`;

    // 8 issues x 3 visible comments (~900B each) => > 21 KiB total comment payload (>> 4 KiB bridge ceiling).
    const titleHitA = f.createIssue({
      workspaceId: "local",
      title: "BUDGETHIT-900 CAFÉ title hit A",
      description: "Short description A",
    });
    const tA1 = f.store.createIssueComment(titleHitA.id, { body: pad("Older BUDGETHIT-900 CAFÉ titleA seq1") });
    const tA2 = f.store.createIssueComment(titleHitA.id, { body: pad("Winner BUDGETHIT-900 CAFÉ titleA seq2") });
    const tA3 = f.store.createIssueComment(titleHitA.id, { body: pad("Newest unrelated chatter titleA seq3") });
    setCommentCreatedAt(f.db, tA1.id, "2026-11-10T01:00:00.000Z");
    setCommentCreatedAt(f.db, tA2.id, "2026-11-10T02:00:00.000Z");
    setCommentCreatedAt(f.db, tA3.id, "2026-11-10T03:00:00.000Z");
    setUpdatedAt(f.db, titleHitA.id, "2026-11-10T10:00:00.000Z");

    const titleHitB = f.createIssue({
      workspaceId: "local",
      title: "BUDGETHIT-900 CAFÉ title hit B",
      description: "Short description B",
    });
    const tB1 = f.store.createIssueComment(titleHitB.id, { body: pad("Winner BUDGETHIT-900 CAFÉ titleB seq1") });
    const tB2 = f.store.createIssueComment(titleHitB.id, { body: pad("Unrelated chatter titleB seq2") });
    const tB3 = f.store.createIssueComment(titleHitB.id, { body: pad("Unrelated chatter titleB seq3") });
    setCommentCreatedAt(f.db, tB1.id, "2026-11-10T01:00:00.000Z");
    setCommentCreatedAt(f.db, tB2.id, "2026-11-10T02:00:00.000Z");
    setCommentCreatedAt(f.db, tB3.id, "2026-11-10T03:00:00.000Z");
    setUpdatedAt(f.db, titleHitB.id, "2026-11-10T09:00:00.000Z");

    // 4 comment-only hits exercising oldest-match continuation (after_row),
    // newest-match skip (after_issue), and multi-match latest-winner tie-break.
    const commentHitA = f.createIssue({ workspaceId: "local", title: "Neutral budget issue C1", description: "Short C1" });
    const cA1 = f.store.createIssueComment(commentHitA.id, { body: pad("Oldest-match BUDGETHIT-900 COMMENTONLY-900 CAFÉ C1 seq1") });
    const cA2 = f.store.createIssueComment(commentHitA.id, { body: pad("Unrelated filler C1 seq2") });
    const cA3 = f.store.createIssueComment(commentHitA.id, { body: pad("Unrelated filler C1 seq3") });
    setCommentCreatedAt(f.db, cA1.id, "2026-11-10T01:00:00.000Z");
    setCommentCreatedAt(f.db, cA2.id, "2026-11-10T02:00:00.000Z");
    setCommentCreatedAt(f.db, cA3.id, "2026-11-10T03:00:00.000Z");
    setUpdatedAt(f.db, commentHitA.id, "2026-11-10T08:00:00.000Z");

    const commentHitB = f.createIssue({ workspaceId: "local", title: "Neutral budget issue C2", description: "Short C2" });
    const cB1 = f.store.createIssueComment(commentHitB.id, { body: pad("Unrelated filler C2 seq1") });
    const cB2 = f.store.createIssueComment(commentHitB.id, { body: pad("Middle-match BUDGETHIT-900 COMMENTONLY-900 CAFÉ C2 seq2") });
    const cB3 = f.store.createIssueComment(commentHitB.id, { body: pad("Unrelated filler C2 seq3") });
    setCommentCreatedAt(f.db, cB1.id, "2026-11-10T01:00:00.000Z");
    setCommentCreatedAt(f.db, cB2.id, "2026-11-10T02:00:00.000Z");
    setCommentCreatedAt(f.db, cB3.id, "2026-11-10T03:00:00.000Z");
    setUpdatedAt(f.db, commentHitB.id, "2026-11-10T07:00:00.000Z");

    const commentHitC = f.createIssue({ workspaceId: "local", title: "Neutral budget issue C3", description: "Short C3" });
    const cC1 = f.store.createIssueComment(commentHitC.id, { body: pad("Unrelated filler C3 seq1") });
    const cC2 = f.store.createIssueComment(commentHitC.id, { body: pad("Unrelated filler C3 seq2") });
    const cC3 = f.store.createIssueComment(commentHitC.id, { body: pad("Newest-match BUDGETHIT-900 COMMENTONLY-900 CAFÉ C3 seq3") });
    setCommentCreatedAt(f.db, cC1.id, "2026-11-10T01:00:00.000Z");
    setCommentCreatedAt(f.db, cC2.id, "2026-11-10T02:00:00.000Z");
    setCommentCreatedAt(f.db, cC3.id, "2026-11-10T03:00:00.000Z");
    setUpdatedAt(f.db, commentHitC.id, "2026-11-10T06:00:00.000Z");

    const commentHitD = f.createIssue({ workspaceId: "local", title: "Neutral budget issue C4", description: "Short C4" });
    const cD1 = f.store.createIssueComment(commentHitD.id, { body: pad("Older-match BUDGETHIT-900 COMMENTONLY-900 CAFÉ C4 seq1") });
    const cD2 = f.store.createIssueComment(commentHitD.id, { body: pad("Winner-match BUDGETHIT-900 COMMENTONLY-900 CAFÉ C4 seq2") });
    const cD3 = f.store.createIssueComment(commentHitD.id, { body: pad("Unrelated filler C4 seq3") });
    setCommentCreatedAt(f.db, cD1.id, "2026-11-10T01:00:00.000Z");
    setCommentCreatedAt(f.db, cD2.id, "2026-11-10T02:00:00.000Z");
    setCommentCreatedAt(f.db, cD3.id, "2026-11-10T03:00:00.000Z");
    setUpdatedAt(f.db, commentHitD.id, "2026-11-10T05:00:00.000Z");

    // 2 completely non-matching issues adding extra ~5.5 KiB of non-matching comment noise
    for (const suffix of ["N1", "N2"]) {
      const noise = f.createIssue({ workspaceId: "local", title: `Unrelated budget noise ${suffix}`, description: "Noise" });
      for (let seq = 1; seq <= 3; seq += 1) {
        const msg = f.store.createIssueComment(noise.id, { body: pad(`Noise commentary ${suffix} seq${seq}`) });
        setCommentCreatedAt(f.db, msg.id, `2026-11-10T0${seq}:00:00.000Z`);
      }
      setUpdatedAt(f.db, noise.id, "2026-11-10T04:00:00.000Z");
    }

    const previousLimit = process.env.MULTIREMI_PG_REPLY_MAX_BYTES;
    const previousEnforce = process.env.MULTIREMI_PG_REPLY_ENFORCE;
    const replyExceptions = DB_REPLY_TRANSITION_EXCEPTIONS as Set<string>;
    const wasCompatExempt = replyExceptions.delete("GET /api/issues/search");
    const wasCanonicalExempt = replyExceptions.delete("GET /api/multiremi/issues/search");
    process.env.MULTIREMI_PG_REPLY_MAX_BYTES = "4096";
    process.env.MULTIREMI_PG_REPLY_ENFORCE = "1";
    resetDbReplyLimitForTest();

    let fallbackPage0Actual: { issues: MultiremiIssueSearchResult[]; total: number };
    let fallbackPage1Actual: { issues: MultiremiIssueSearchResult[]; total: number };
    let fallbackCommentOnlyActual: { issues: MultiremiIssueSearchResult[]; total: number };
    let pushdownPage0Actual: { issues: MultiremiIssueSearchResult[]; total: number };
    let pushdownPage1Actual: { issues: MultiremiIssueSearchResult[]; total: number };

    try {
      // Verify createRequestMetricsMiddleware activates the 4096-byte enforced policy.
      const policyProbe = new Hono();
      policyProbe.use("*", createRequestMetricsMiddleware({
        enabled: false,
        slowRequestMs: 500,
        summaryIntervalMs: 60_000,
        summaryTopRoutes: 10,
        bufferCapacity: 256,
        role: "all",
      }));
      policyProbe.get("/api/search-reply-budget-probe", (c) => {
        expect(postgresReplyMaxBytes()).toBe(4096);
        expect(currentDbReplyPolicy()).toMatchObject({ limitBytes: 4096, enforced: true, exempt: false });
        return c.body(null, 204);
      });
      expect((await policyProbe.request("/api/search-reply-budget-probe")).status).toBe(204);

      const app = createMultiremiApp({ store: f.store });

      // 1. Non-ASCII fallback (mixed field + comment hits): must batch comment scans under 4096B
      const fallbackPage0Measured = await measureSqlAsync(f.db, async () => {
        const resp = await app.request(
          `/api/multiremi/issues/search?q=${encodeURIComponent("café budgethit-900")}&workspaceId=local&limit=4&offset=0`,
        );
        expect(resp.status).toBe(200);
        return await resp.json() as { issues: MultiremiIssueSearchResult[]; total: number };
      });
      fallbackPage0Actual = fallbackPage0Measured.result;
      expect(fallbackPage0Measured.writes).toBe(0);
      expect(fallbackPage0Measured.reads).toBeGreaterThanOrEqual(8);

      const fallbackPage1Resp = await app.request(
        `/api/multiremi/issues/search?q=${encodeURIComponent("café budgethit-900")}&workspaceId=local&limit=4&offset=4`,
      );
      expect(fallbackPage1Resp.status).toBe(200);
      fallbackPage1Actual = await fallbackPage1Resp.json() as { issues: MultiremiIssueSearchResult[]; total: number };

      // 2. Non-ASCII fallback comment-only (0 field hits -> workspace-wide bounded comment scan > 21 KiB)
      const fallbackCommentOnlyMeasured = await measureSqlAsync(f.db, async () => {
        const resp = await app.request(
          `/api/multiremi/issues/search?q=${encodeURIComponent("café commentonly-900")}&workspaceId=local&limit=4&offset=0`,
        );
        expect(resp.status).toBe(200);
        return await resp.json() as { issues: MultiremiIssueSearchResult[]; total: number };
      });
      fallbackCommentOnlyActual = fallbackCommentOnlyMeasured.result;
      expect(fallbackCommentOnlyMeasured.writes).toBe(0);
      expect(fallbackCommentOnlyMeasured.reads).toBeGreaterThanOrEqual(8);

      // 3. ASCII SQL pushdown: searchIssueCommentSnippets must batch the 4 ~900B winning snippets under 4096B
      const pushdownPage0Measured = await measureSqlAsync(f.db, async () => {
        const resp = await app.request(
          `/api/multiremi/issues/search?q=${encodeURIComponent("budgethit-900")}&workspaceId=local&limit=4&offset=0`,
        );
        expect(resp.status).toBe(200);
        return await resp.json() as { issues: MultiremiIssueSearchResult[]; total: number };
      });
      pushdownPage0Actual = pushdownPage0Measured.result;
      expect(pushdownPage0Measured.writes).toBe(0);
      // 1 candidate + 1 hydration + 1 labels + >=2 snippet batches (+ workspace lookup)
      const snippetQueries = pushdownPage0Measured.statements.filter((sql) => sql.includes("WITH latest_per_issue"));
      expect(snippetQueries.length).toBeGreaterThanOrEqual(2);

      const pushdownPage1Resp = await app.request(
        `/api/multiremi/issues/search?q=${encodeURIComponent("budgethit-900")}&workspaceId=local&limit=4&offset=4`,
      );
      expect(pushdownPage1Resp.status).toBe(200);
      pushdownPage1Actual = await pushdownPage1Resp.json() as { issues: MultiremiIssueSearchResult[]; total: number };

      // 4. Compatibility HTTP route GET /api/issues/search under the same 4096B bridge ceiling
      for (const q of ["café budgethit-900", "budgethit-900"]) {
        const compatResp = await app.request(
          `/api/issues/search?q=${encodeURIComponent(q)}&workspace_id=local&limit=4&offset=0`,
        );
        expect(compatResp.status).toBe(200);
        expect(compatResp.headers.get("X-Total-Count")).toBe("6");
        const compatBody = await compatResp.json() as { issues: Array<{ id: string; matched_comment_snippet?: string }>; total: number };
        expect(compatBody.total).toBe(6);
        expect(compatBody.issues).toHaveLength(4);
        expect(compatBody.issues.every((item) => typeof item.matched_comment_snippet === "string" && item.matched_comment_snippet.length > 0)).toBe(true);
      }
    } finally {
      if (previousLimit === undefined) delete process.env.MULTIREMI_PG_REPLY_MAX_BYTES;
      else process.env.MULTIREMI_PG_REPLY_MAX_BYTES = previousLimit;
      if (previousEnforce === undefined) delete process.env.MULTIREMI_PG_REPLY_ENFORCE;
      else process.env.MULTIREMI_PG_REPLY_ENFORCE = previousEnforce;
      if (wasCompatExempt) replyExceptions.add("GET /api/issues/search");
      if (wasCanonicalExempt) replyExceptions.add("GET /api/multiremi/issues/search");
      resetDbReplyLimitForTest();
    }

    // Compare every low-budget HTTP result field-for-field against legacySearchIssuesOracle under default budget.
    expect(fallbackPage0Actual).toEqual(legacySearchIssuesOracle(f.store, f.db, { q: "café budgethit-900", workspaceId: "local", limit: 4, offset: 0 }));
    expect(fallbackPage1Actual).toEqual(legacySearchIssuesOracle(f.store, f.db, { q: "café budgethit-900", workspaceId: "local", limit: 4, offset: 4 }));
    expect(fallbackCommentOnlyActual).toEqual(legacySearchIssuesOracle(f.store, f.db, { q: "café commentonly-900", workspaceId: "local", limit: 4, offset: 0 }));
    expect(pushdownPage0Actual).toEqual(legacySearchIssuesOracle(f.store, f.db, { q: "budgethit-900", workspaceId: "local", limit: 4, offset: 0 }));
    expect(pushdownPage1Actual).toEqual(legacySearchIssuesOracle(f.store, f.db, { q: "budgethit-900", workspaceId: "local", limit: 4, offset: 4 }));
  }, 30_000);

  it("chunks single oversized 4,000-byte comments (with emoji, quotes, control chars) via SUBSTR under non-exempt 4096B reply budget across both paths", async () => {
    const f = fixture();
    // Place supplementary-plane emoji '😀' right across the 650-code-point chunk boundary
    // (ceiling=4096 -> chunkChars=650) alongside quotes, backslashes, and control chars so
    // UTF-16 length bugs or unescaped JSON-expansion overflows would fail immediately.
    const emojiBridge = "a".repeat(645) + "😀😀😀😀😀😀😀😀😀😀" + "\x01\t\"quoted\"\\'\\n" + "b".repeat(1200);
    const oversizeBody1 = `${emojiBridge} ${"z".repeat(2200)} OVERSIZE-ARCHIVE-TAIL archive CAFÉ 😀 "end"`;
    expect(Buffer.byteLength(oversizeBody1, "utf8")).toBeGreaterThanOrEqual(4000);

    const oversizeNonMatch = `${"😀".repeat(200)} ${"\x02\t\"noise\"\\".repeat(80)} ${"m".repeat(2600)} unrelated latest comment`;
    expect(Buffer.byteLength(oversizeNonMatch, "utf8")).toBeGreaterThanOrEqual(4000);

    // Issue 1 (lexicographically first): single 4,000+ UTF-8 byte matching comment
    f.db.run(
      `INSERT INTO multiremi_issues (id, issue_number, issue_key, title, description, status, workspace_id, created_at, updated_at)
       VALUES ('iss_oversize_01', 9951, 'MUL-9951', 'Oversize comment holder 1', 'Clean description 1', 'todo', 'local', '2026-11-11T01:00:00.000Z', '2026-11-11T03:00:00.000Z')`,
    );
    const o1c1 = f.store.createIssueComment("iss_oversize_01", { body: oversizeBody1 });
    setCommentCreatedAt(f.db, o1c1.id, "2026-11-11T01:00:00.000Z");
    setUpdatedAt(f.db, "iss_oversize_01", "2026-11-11T03:00:00.000Z");

    // Issue 2 (lexicographically second): newer 4,000+ byte NON-matching comment + older matching comment
    // Proves `oversize = 1` on rn=1 does not stop cursor advancement and `after_row` reaches older comments.
    f.db.run(
      `INSERT INTO multiremi_issues (id, issue_number, issue_key, title, description, status, workspace_id, created_at, updated_at)
       VALUES ('iss_oversize_02', 9952, 'MUL-9952', 'Oversize comment holder 2', 'Clean description 2', 'todo', 'local', '2026-11-11T02:00:00.000Z', '2026-11-11T02:00:00.000Z')`,
    );
    const o2cOld = f.store.createIssueComment("iss_oversize_02", {
      body: `Older matching OVERSIZE-ARCHIVE-TAIL archive CAFÉ 😀 "older-winner" after 4KB noise`,
    });
    const o2cNew = f.store.createIssueComment("iss_oversize_02", { body: oversizeNonMatch });
    setCommentCreatedAt(f.db, o2cOld.id, "2026-11-11T01:00:00.000Z");
    setCommentCreatedAt(f.db, o2cNew.id, "2026-11-11T02:00:00.000Z");
    setUpdatedAt(f.db, "iss_oversize_02", "2026-11-11T02:00:00.000Z");

    // Issue 3 (lexicographically third): normal-sized matching comment after two oversize issues
    f.db.run(
      `INSERT INTO multiremi_issues (id, issue_number, issue_key, title, description, status, workspace_id, created_at, updated_at)
       VALUES ('iss_oversize_03', 9953, 'MUL-9953', 'Oversize follower 3', 'Clean description 3', 'todo', 'local', '2026-11-11T01:00:00.000Z', '2026-11-11T01:00:00.000Z')`,
    );
    const o3c1 = f.store.createIssueComment("iss_oversize_03", {
      body: `Short follower OVERSIZE-ARCHIVE-TAIL archive CAFÉ 😀`,
    });
    setCommentCreatedAt(f.db, o3c1.id, "2026-11-11T01:00:00.000Z");
    setUpdatedAt(f.db, "iss_oversize_03", "2026-11-11T01:00:00.000Z");

    const previousLimit = process.env.MULTIREMI_PG_REPLY_MAX_BYTES;
    const previousEnforce = process.env.MULTIREMI_PG_REPLY_ENFORCE;
    process.env.MULTIREMI_PG_REPLY_MAX_BYTES = "4096";
    process.env.MULTIREMI_PG_REPLY_ENFORCE = "1";
    resetDbReplyLimitForTest();

    let asciiActual: { issues: MultiremiIssueSearchResult[]; total: number };
    let fallbackActual: { issues: MultiremiIssueSearchResult[]; total: number };

    try {
      // Non-exempt request context (GET /api/review-fixture is NOT in DB_REPLY_TRANSITION_EXCEPTIONS).
      const reviewApp = new Hono();
      reviewApp.use("*", createRequestMetricsMiddleware({
        enabled: false,
        slowRequestMs: 500,
        summaryIntervalMs: 60_000,
        summaryTopRoutes: 10,
        bufferCapacity: 256,
        role: "all",
      }));
      reviewApp.get("/api/review-fixture", (c) => {
        expect(postgresReplyMaxBytes()).toBe(4096);
        expect(currentDbReplyPolicy()).toMatchObject({ limitBytes: 4096, enforced: true, exempt: false });
        const q = c.req.query("q") ?? "";
        const result = f.store.searchIssues({ q, workspaceId: "local", limit: 10 });
        return c.json(result);
      });

      const expectedSubstrSql = backend === "PostgreSQL"
        ? "SELECT SUBSTR(COALESCE(body_md, '')"
        : "SELECT SUBSTR(CAST(COALESCE(body_md, '') AS BLOB)";

      const asciiMeasured = await measureSqlAsync(f.db, async () => {
        const resp = await reviewApp.request(`/api/review-fixture?q=${encodeURIComponent("archive")}`);
        expect(resp.status).toBe(200);
        return await resp.json() as { issues: MultiremiIssueSearchResult[]; total: number };
      });
      asciiActual = asciiMeasured.result;
      expect(asciiMeasured.writes).toBe(0);
      expect(asciiMeasured.statements.some((sql) => sql.includes(expectedSubstrSql))).toBe(true);

      const fallbackMeasured = await measureSqlAsync(f.db, async () => {
        const resp = await reviewApp.request(`/api/review-fixture?q=${encodeURIComponent("café")}`);
        expect(resp.status).toBe(200);
        return await resp.json() as { issues: MultiremiIssueSearchResult[]; total: number };
      });
      fallbackActual = fallbackMeasured.result;
      expect(fallbackMeasured.writes).toBe(0);
      expect(fallbackMeasured.statements.some((sql) => sql.includes(expectedSubstrSql))).toBe(true);
    } finally {
      if (previousLimit === undefined) delete process.env.MULTIREMI_PG_REPLY_MAX_BYTES;
      else process.env.MULTIREMI_PG_REPLY_MAX_BYTES = previousLimit;
      if (previousEnforce === undefined) delete process.env.MULTIREMI_PG_REPLY_ENFORCE;
      else process.env.MULTIREMI_PG_REPLY_ENFORCE = previousEnforce;
      resetDbReplyLimitForTest();
    }

    const asciiExpected = legacySearchIssuesOracle(f.store, f.db, { q: "archive", workspaceId: "local", limit: 10 });
    const fallbackExpected = legacySearchIssuesOracle(f.store, f.db, { q: "café", workspaceId: "local", limit: 10 });

    expect(asciiActual).toEqual(asciiExpected);
    expect(fallbackActual).toEqual(fallbackExpected);
    expect(asciiActual.issues.map((item) => item.id)).toEqual(["iss_oversize_01", "iss_oversize_02", "iss_oversize_03"]);
    expect(fallbackActual.issues.map((item) => item.id)).toEqual(["iss_oversize_01", "iss_oversize_02", "iss_oversize_03"]);
    expect(asciiActual.issues[0]?.matchedCommentSnippet).toContain("OVERSIZE-ARCHIVE-TAIL archive CAFÉ 😀");
    expect(asciiActual.issues[1]?.matchedCommentSnippet).toContain("older-winner");
    expect(fallbackActual.issues[0]?.matchedCommentSnippet).toContain("OVERSIZE-ARCHIVE-TAIL archive CAFÉ 😀");
    expect(fallbackActual.issues[1]?.matchedCommentSnippet).toContain("older-winner");
  }, 30_000);

  it("keeps candidate discovery, total, page hydration, and comment snippets inside one consistent read snapshot under concurrent status and comment mutations", () => {
    const f = fixture();

    const verifyConcurrentTransition = (
      db1: SqlDatabase,
      store1: MultiremiStore,
      db2: SqlDatabase,
      createIssue: (title: string, updatedAt: string) => string,
      modes: Array<{ name: string; runSearch: (fn: () => { issues: MultiremiIssueSearchResult[]; total: number }) => { issues: MultiremiIssueSearchResult[]; total: number } }>,
    ) => {
      for (const mode of modes) {
        const scenarios: Array<{ label: string; token: string; query: string }> = [
          { label: `${mode.name}:sql-pushdown`, token: `SNAPRACE-ASCII-${mode.name}`, query: `SNAPRACE-ASCII-${mode.name}` },
          { label: `${mode.name}:non-ascii-fallback`, token: `SNAPRACE-CAFÉ-${mode.name}`, query: `snaprace-café-${mode.name}` },
        ];

        for (const scenario of scenarios) {
          const id1 = createIssue(`${scenario.token} issue 1`, "2026-11-12T01:00:00.000Z");
          const id2 = createIssue(`${scenario.token} issue 2`, "2026-11-12T02:00:00.000Z");
          const id3 = createIssue(`${scenario.token} issue 3`, "2026-11-12T03:00:00.000Z");
          const comment = store1.createIssueComment(id2, { body: `OLD-SNAP-COMMENT mentioning ${scenario.token}` });
          setUpdatedAt(db1, id2, "2026-11-12T02:00:00.000Z");

          // Inject a concurrent commit on connection 2 right after candidate discovery
          // and immediately before page hydration reads multiremi_issues: both
          // status (`todo -> done`) and comment body (`OLD -> NEW`) mutate together.
          let mutated = false;
          const originalQuery = db1.query.bind(db1);
          const querySpy = spyOn(db1, "query").mockImplementation((sql) => {
            if (!mutated && sql.includes("SELECT i.* FROM multiremi_issues i WHERE i.workspace_id = ? AND i.id IN (")) {
              mutated = true;
              db2.run("UPDATE multiremi_issues SET status = 'done' WHERE id = ?", [id2]);
              db2.run("UPDATE multiremi_conversation_log SET body_md = ? WHERE id = ?", [
                `NEW-SNAP-COMMENT mentioning ${scenario.token}`,
                comment.id,
              ]);
            }
            return originalQuery(sql);
          });

          let duringMutation: { issues: MultiremiIssueSearchResult[]; total: number };
          try {
            duringMutation = mode.runSearch(() => store1.searchIssues({
              q: scenario.query,
              workspaceId: "local",
              includeClosed: false,
              includeCommentBodies: true,
              limit: 10,
            }));
          } finally {
            querySpy.mockRestore();
          }

          expect(mutated, `${scenario.label}: concurrent writer should fire before hydration`).toBe(true);
          // Consistent pre-commit snapshot: all 3 open issues returned, no unarchived done leaked,
          // no short page, and comment snippet reflects the pre-commit OLD text.
          expect(duringMutation.total).toBe(3);
          expect(duringMutation.issues).toHaveLength(3);
          expect(duringMutation.issues.map((item) => item.id)).toEqual([id3, id2, id1]);
          expect(duringMutation.issues.every((item) => item.status === "todo")).toBe(true);
          const id2During = duringMutation.issues.find((item) => item.id === id2)!;
          expect(id2During.matchedCommentSnippet).toContain("OLD-SNAP-COMMENT");
          expect(id2During.matchedCommentSnippet).not.toContain("NEW-SNAP-COMMENT");

          // Next search starts a fresh snapshot and observes the committed todo -> done transition.
          const afterMutation = store1.searchIssues({
            q: scenario.query,
            workspaceId: "local",
            includeClosed: false,
            includeCommentBodies: true,
            limit: 10,
          });
          expect(afterMutation.total).toBe(2);
          expect(afterMutation.issues).toHaveLength(2);
          expect(afterMutation.issues.map((item) => item.id)).toEqual([id3, id1]);
          expect(afterMutation.issues.map((item) => item.id)).not.toContain(id2);

          // And includeClosed=true on the fresh snapshot observes both `done` and NEW comment body.
          const afterClosed = store1.searchIssues({
            q: scenario.query,
            workspaceId: "local",
            includeClosed: true,
            includeCommentBodies: true,
            limit: 10,
          });
          const id2After = afterClosed.issues.find((item) => item.id === id2)!;
          expect(id2After.status).toBe("done");
          expect(id2After.matchedCommentSnippet).toContain("NEW-SNAP-COMMENT");
        }
      }
    };

    if (backend === "PostgreSQL") {
      expect(f.databaseUrl).toBeTruthy();
      const db2 = new PostgresSyncDatabase(f.databaseUrl!);
      try {
        verifyConcurrentTransition(
          f.db,
          f.store,
          db2,
          (title, updatedAt) => {
            const issue = f.createIssue({ workspaceId: "local", title, description: "Concurrent PG snapshot check" });
            setUpdatedAt(f.db, issue.id, updatedAt);
            return issue.id;
          },
          [
            { name: "pg-top-level", runSearch: (fn) => fn() },
            {
              name: "pg-outer-rr",
              runSearch: (fn) => f.transaction(() => {
                f.db.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
                return fn();
              }),
            },
          ],
        );
      } finally {
        db2.close();
      }
    } else {
      // File-backed SQLite WAL fixture with two independent connections so connection 2
      // can commit while connection 1 holds a BEGIN DEFERRED WAL read snapshot.
      const dir = mkdtempSync(join(tmpdir(), "mul331-wal-snapshot-"));
      const dbPath = join(dir, "search-snapshot.sqlite");
      const db1 = openSqliteDatabase(dbPath) as unknown as SqlDatabase;
      const db2 = openSqliteDatabase(dbPath) as unknown as SqlDatabase;
      try {
        db1.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 30000");
        db2.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 30000");
        const store1 = new MultiremiStore(db1);
        store1.ensureLocalWorkspace();
        verifyConcurrentTransition(
          db1,
          store1,
          db2,
          (title, updatedAt) => {
            const issue = createResponsibleTestIssue(store1, { workspaceId: "local", title, description: "Concurrent SQLite WAL snapshot check" });
            setUpdatedAt(db1, issue.id, updatedAt);
            return issue.id;
          },
          [
            { name: "sqlite-top-level", runSearch: (fn) => fn() },
            {
              name: "sqlite-outer-tx",
              runSearch: (fn) => {
                const tx = db1.transaction(fn);
                return (tx.deferred ?? tx)();
              },
            },
          ],
        );
      } finally {
        db2.close();
        db1.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 30_000);

  it("handles embedded U+0000 (NUL) in SQLite persisted fields/comments and NUL query terms across both backends without truncation or bind errors", async () => {
    const f = fixture();

    // Control issue without NUL characters (present on both SQLite and PostgreSQL).
    const controlIssue = f.createIssue({
      workspaceId: "local",
      title: "Ordinary control ticket",
      description: "No embedded nul byte here",
    });
    setUpdatedAt(f.db, controlIssue.id, "2026-11-13T00:00:00.000Z");

    if (backend === "PostgreSQL") {
      // PostgreSQL TEXT columns cannot persist U+0000; searching NUL-containing queries
      // must return { issues: [], total: 0 } cleanly without UTF-8 bind errors and match oracle.
      for (const nulQuery of ["summary\u0000", "\u0000", "ordinary\u0000control"]) {
        for (const includeCommentBodies of [true, false]) {
          const expected = legacySearchIssuesOracle(f.store, f.db, {
            q: nulQuery,
            workspaceId: "local",
            includeCommentBodies,
          });
          const actual = f.store.searchIssues({
            q: nulQuery,
            workspaceId: "local",
            includeCommentBodies,
          });
          expect(actual).toEqual(expected);
          expect(actual).toEqual({ issues: [], total: 0 });
        }
      }
      return;
    }

    // 1. SQLite persisted NUL in title, description, and visible comment via normal Store APIs.
    const nulTitleIssue = f.createIssue({
      workspaceId: "local",
      title: "Clipboard\u0000summary",
      description: "Clean title-case description",
    });
    setUpdatedAt(f.db, nulTitleIssue.id, "2026-11-13T01:00:00.000Z");

    const nulDescIssue = f.createIssue({
      workspaceId: "local",
      title: "Clean description holder",
      description: "Imported note\u0000minutes",
    });
    setUpdatedAt(f.db, nulDescIssue.id, "2026-11-13T02:00:00.000Z");

    const nulCommentIssue = f.createIssue({
      workspaceId: "local",
      title: "Clean comment holder",
      description: "Clean comment description",
    });
    const nulComment = f.store.createIssueComment(nulCommentIssue.id, {
      body: "\u0000archive café",
    });
    setCommentCreatedAt(f.db, nulComment.id, "2026-11-13T03:00:00.000Z");
    setUpdatedAt(f.db, nulCommentIssue.id, "2026-11-13T03:00:00.000Z");

    const authToken = "mul331-nul-auth-secret";
    const app = createMultiremiApp({ store: f.store, authToken });
    const authHeaders = { Authorization: `Bearer ${authToken}` };

    const unauthResp = await app.request("/api/issues/search?q=summary&workspace_id=local");
    expect(unauthResp.status).toBe(401);

    const singleHitCases: Array<{
      q: string;
      expectedId: string;
      expectedSource: "title" | "description" | "comment";
      includeCommentBodies: boolean;
    }> = [
      { q: "summary", expectedId: nulTitleIssue.id, expectedSource: "title", includeCommentBodies: true },
      { q: "summary", expectedId: nulTitleIssue.id, expectedSource: "title", includeCommentBodies: false },
      { q: "minutes", expectedId: nulDescIssue.id, expectedSource: "description", includeCommentBodies: true },
      { q: "minutes", expectedId: nulDescIssue.id, expectedSource: "description", includeCommentBodies: false },
      { q: "archive", expectedId: nulCommentIssue.id, expectedSource: "comment", includeCommentBodies: true },
      { q: "café", expectedId: nulCommentIssue.id, expectedSource: "comment", includeCommentBodies: true },
    ];

    for (const tc of singleHitCases) {
      const expected = legacySearchIssuesOracle(f.store, f.db, {
        q: tc.q,
        workspaceId: "local",
        includeCommentBodies: tc.includeCommentBodies,
      });
      const actual = f.store.searchIssues({
        q: tc.q,
        workspaceId: "local",
        includeCommentBodies: tc.includeCommentBodies,
      });
      expect(actual).toEqual(expected);
      expect(actual.total).toBe(1);
      expect(actual.issues).toHaveLength(1);
      expect(actual.issues[0]?.id).toBe(tc.expectedId);
      expect(actual.issues[0]?.matchSource).toBe(tc.expectedSource);

      if (tc.includeCommentBodies) {
        const resp = await app.request(
          `/api/issues/search?q=${encodeURIComponent(tc.q)}&workspace_id=local`,
          { headers: authHeaders },
        );
        expect(resp.status).toBe(200);
        expect(resp.headers.get("X-Total-Count")).toBe("1");
        const body = await resp.json() as {
          issues: Array<{
            id: string;
            match_source: string;
            matched_description_snippet?: string;
            matched_comment_snippet?: string;
            matched_snippet?: string;
          }>;
          total: number;
        };
        expect(body.total).toBe(1);
        expect(body.issues).toHaveLength(1);
        expect(body.issues[0]?.id).toBe(tc.expectedId);
        expect(body.issues[0]?.match_source).toBe(tc.expectedSource);
        expect(body.issues[0]?.matched_description_snippet).toBe(expected.issues[0]?.matchedDescriptionSnippet);
        expect(body.issues[0]?.matched_comment_snippet).toBe(expected.issues[0]?.matchedCommentSnippet);
        expect(body.issues[0]?.matched_snippet).toBe(expected.issues[0]?.matchedSnippet);
      }
    }

    // 2. Queries containing U+0000 themselves match SQLite rows identically to legacy oracle.
    for (const nulQuery of ["summary\u0000", "\u0000", "clipboard\u0000summary", "\u0000archive"]) {
      for (const includeCommentBodies of [true, false]) {
        const expected = legacySearchIssuesOracle(f.store, f.db, {
          q: nulQuery,
          workspaceId: "local",
          includeCommentBodies,
        });
        const actual = f.store.searchIssues({
          q: nulQuery,
          workspaceId: "local",
          includeCommentBodies,
        });
        expect(actual).toEqual(expected);
      }
    }
    expect(f.store.searchIssues({ q: "clipboard\u0000summary", workspaceId: "local" }).issues.map((i) => i.id)).toEqual([
      nulTitleIssue.id,
    ]);
    expect(f.store.searchIssues({ q: "\u0000archive", workspaceId: "local" }).issues.map((i) => i.id)).toEqual([
      nulCommentIssue.id,
    ]);
    expect(f.store.searchIssues({ q: "\u0000", workspaceId: "local" }).total).toBe(3);

    // 3. Same issue has older non-NUL matching comment and newer NUL matching comment:
    //    matched_comments MAX(has_nul) must trigger fallback so the newer NUL comment wins.
    const multiCommentIssue = f.createIssue({
      workspaceId: "local",
      title: "Older vs newer NUL comment issue",
      description: "Clean description",
    });
    const oldComment = f.store.createIssueComment(multiCommentIssue.id, { body: "archive old" });
    const newerNulComment = f.store.createIssueComment(multiCommentIssue.id, { body: "\u0000archive newer" });
    setCommentCreatedAt(f.db, oldComment.id, "2026-11-13T04:00:00.000Z");
    setCommentCreatedAt(f.db, newerNulComment.id, "2026-11-13T05:00:00.000Z");
    setUpdatedAt(f.db, multiCommentIssue.id, "2026-11-13T05:00:00.000Z");

    const archiveExpected = legacySearchIssuesOracle(f.store, f.db, { q: "archive", workspaceId: "local" });
    const archiveActual = f.store.searchIssues({ q: "archive", workspaceId: "local" });
    expect(archiveActual).toEqual(archiveExpected);
    const newerHit = archiveActual.issues.find((item) => item.id === multiCommentIssue.id)!;
    expect(newerHit.matchSource).toBe("comment");
    expect(newerHit.matchedCommentSnippet).toBe("\u0000archive newer");
    expect(newerHit.matchedSnippet).toBe("\u0000archive newer");

    // 4. Raw NULL issue_key + issue_number=0 row whose effective key falls back to `i.id`
    //    containing U+0000 must also trigger fallback via `CHAR(0)` check on `i.id`.
    const nulIdKey = "raw_nul\u0000id_tail_991";
    f.db.run(
      `INSERT INTO multiremi_issues (id, issue_number, issue_key, title, description, status, workspace_id, created_at, updated_at)
       VALUES (?, 0, NULL, 'Neutral NUL id key issue', NULL, 'todo', 'local', '2026-11-13T06:00:00.000Z', '2026-11-13T06:00:00.000Z')`,
      [nulIdKey],
    );
    for (const includeCommentBodies of [true, false]) {
      const idKeyExpected = legacySearchIssuesOracle(f.store, f.db, {
        q: "id_tail_991",
        workspaceId: "local",
        includeCommentBodies,
      });
      const idKeyActual = f.store.searchIssues({
        q: "id_tail_991",
        workspaceId: "local",
        includeCommentBodies,
      });
      expect(idKeyActual).toEqual(idKeyExpected);
      expect(idKeyActual.total).toBe(1);
      expect(idKeyActual.issues[0]?.id).toBe(nulIdKey);
      expect(idKeyActual.issues[0]?.matchSource).toBe("key");
    }
  }, 30_000);

  it("chunks oversized >4,000-byte SQLite comments containing U+0000 via BLOB SUBSTR under non-exempt 4096B reply budget", async () => {
    if (backend !== "SQLite") return;
    const f = fixture();

    // Place multi-byte emoji right across the 650-byte BLOB chunk boundary and embed U+0000
    // before the matching tail (`\u0000archive café 😀`) so text-based SUBSTR would truncate at NUL
    // and naive chunk-wise UTF-8 decoding would corrupt split multi-byte characters.
    const prefix = "p".repeat(648) + "😀😀😀😀😀😀" + "q".repeat(3500);
    const oversizeNulBody = `${prefix}\u0000archive café 😀 tail-marker`;
    expect(Buffer.byteLength(oversizeNulBody, "utf8")).toBeGreaterThan(4000);

    const nulOversizeIssue = f.createIssue({
      workspaceId: "local",
      title: "Oversize NUL comment holder",
      description: "Clean description",
    });
    const comment = f.store.createIssueComment(nulOversizeIssue.id, { body: oversizeNulBody });
    setCommentCreatedAt(f.db, comment.id, "2026-11-14T01:00:00.000Z");
    setUpdatedAt(f.db, nulOversizeIssue.id, "2026-11-14T01:00:00.000Z");

    // Leading U+FEFF (BOM) on a >= 4113-byte UTF-8 comment containing U+0000 must be preserved
    // (TextDecoder `{ ignoreBOM: true }`) so matchedCommentSnippet.codePointAt(0) === 0xfeff (65279).
    const bomRest = `bomneedle café ${"y".repeat(4100)}\u0000bomtail`;
    expect(Buffer.byteLength(`\uFEFF${bomRest}`, "utf8")).toBeGreaterThanOrEqual(4113);
    const bomIssue = f.createIssue({
      workspaceId: "local",
      title: "Oversize leading BOM comment holder",
      description: "Clean description",
    });
    const bomComment = f.store.createIssueComment(bomIssue.id, { body: "placeholder" });
    // Persist raw leading U+FEFF via CHAR(65279) || ? (bun:sqlite strips one leading BOM on JS bind
    // and createIssueComment trims leading ECMA whitespace; raw SQLite rows retain U+FEFF).
    f.db.run("UPDATE multiremi_conversation_log SET body_md = CHAR(65279) || ? WHERE id = ?", [bomRest, bomComment.id]);
    const persistedBom = f.db.query("SELECT body_md FROM multiremi_conversation_log WHERE id = ?").get(bomComment.id) as { body_md: string };
    expect(persistedBom.body_md.codePointAt(0)).toBe(0xfeff);
    setCommentCreatedAt(f.db, bomComment.id, "2026-11-14T02:00:00.000Z");
    setUpdatedAt(f.db, bomIssue.id, "2026-11-14T02:00:00.000Z");

    const previousLimit = process.env.MULTIREMI_PG_REPLY_MAX_BYTES;
    const previousEnforce = process.env.MULTIREMI_PG_REPLY_ENFORCE;
    process.env.MULTIREMI_PG_REPLY_MAX_BYTES = "4096";
    process.env.MULTIREMI_PG_REPLY_ENFORCE = "1";
    resetDbReplyLimitForTest();

    let asciiActual: { issues: MultiremiIssueSearchResult[]; total: number };
    let unicodeActual: { issues: MultiremiIssueSearchResult[]; total: number };
    let bomAsciiActual: { issues: MultiremiIssueSearchResult[]; total: number };
    let bomUnicodeActual: { issues: MultiremiIssueSearchResult[]; total: number };

    try {
      const reviewApp = new Hono();
      reviewApp.use("*", createRequestMetricsMiddleware({
        enabled: false,
        slowRequestMs: 500,
        summaryIntervalMs: 60_000,
        summaryTopRoutes: 10,
        bufferCapacity: 256,
        role: "all",
      }));
      reviewApp.get("/api/review-fixture", (c) => {
        expect(postgresReplyMaxBytes()).toBe(4096);
        expect(currentDbReplyPolicy()).toMatchObject({ limitBytes: 4096, enforced: true, exempt: false });
        const q = c.req.query("q") ?? "";
        return c.json(f.store.searchIssues({ q, workspaceId: "local", limit: 10 }));
      });

      const asciiMeasured = await measureSqlAsync(f.db, async () => {
        const resp = await reviewApp.request(`/api/review-fixture?q=${encodeURIComponent("archive")}`);
        expect(resp.status).toBe(200);
        return await resp.json() as { issues: MultiremiIssueSearchResult[]; total: number };
      });
      asciiActual = asciiMeasured.result;
      expect(asciiMeasured.writes).toBe(0);
      expect(asciiMeasured.statements.some((sql) => sql.includes("SELECT SUBSTR(CAST(COALESCE(body_md, '') AS BLOB)"))).toBe(true);

      const unicodeMeasured = await measureSqlAsync(f.db, async () => {
        const resp = await reviewApp.request(`/api/review-fixture?q=${encodeURIComponent("archive café")}`);
        expect(resp.status).toBe(200);
        return await resp.json() as { issues: MultiremiIssueSearchResult[]; total: number };
      });
      unicodeActual = unicodeMeasured.result;
      expect(unicodeMeasured.writes).toBe(0);
      expect(unicodeMeasured.statements.some((sql) => sql.includes("SELECT SUBSTR(CAST(COALESCE(body_md, '') AS BLOB)"))).toBe(true);

      const bomAsciiMeasured = await measureSqlAsync(f.db, async () => {
        const resp = await reviewApp.request(`/api/review-fixture?q=${encodeURIComponent("bomneedle")}`);
        expect(resp.status).toBe(200);
        return await resp.json() as { issues: MultiremiIssueSearchResult[]; total: number };
      });
      bomAsciiActual = bomAsciiMeasured.result;
      expect(bomAsciiMeasured.writes).toBe(0);
      expect(bomAsciiMeasured.statements.some((sql) => sql.includes("HEX(CAST('A' AS BLOB))"))).toBe(true);

      const bomUnicodeMeasured = await measureSqlAsync(f.db, async () => {
        const resp = await reviewApp.request(`/api/review-fixture?q=${encodeURIComponent("bomneedle café")}`);
        expect(resp.status).toBe(200);
        return await resp.json() as { issues: MultiremiIssueSearchResult[]; total: number };
      });
      bomUnicodeActual = bomUnicodeMeasured.result;
      expect(bomUnicodeMeasured.writes).toBe(0);
      expect(bomUnicodeMeasured.statements.some((sql) => sql.includes("HEX(CAST('A' AS BLOB))"))).toBe(true);
    } finally {
      if (previousLimit === undefined) delete process.env.MULTIREMI_PG_REPLY_MAX_BYTES;
      else process.env.MULTIREMI_PG_REPLY_MAX_BYTES = previousLimit;
      if (previousEnforce === undefined) delete process.env.MULTIREMI_PG_REPLY_ENFORCE;
      else process.env.MULTIREMI_PG_REPLY_ENFORCE = previousEnforce;
      resetDbReplyLimitForTest();
    }

    const asciiExpected = legacySearchIssuesOracle(f.store, f.db, { q: "archive", workspaceId: "local", limit: 10 });
    const unicodeExpected = legacySearchIssuesOracle(f.store, f.db, { q: "archive café", workspaceId: "local", limit: 10 });
    const bomAsciiExpected = legacySearchIssuesOracle(f.store, f.db, { q: "bomneedle", workspaceId: "local", limit: 10 });
    const bomUnicodeExpected = legacySearchIssuesOracle(f.store, f.db, { q: "bomneedle café", workspaceId: "local", limit: 10 });

    expect(asciiActual).toEqual(asciiExpected);
    expect(unicodeActual).toEqual(unicodeExpected);
    expect(bomAsciiActual).toEqual(bomAsciiExpected);
    expect(bomUnicodeActual).toEqual(bomUnicodeExpected);
    expect(asciiActual.total).toBe(1);
    expect(unicodeActual.total).toBe(1);
    expect(asciiActual.issues[0]?.id).toBe(nulOversizeIssue.id);
    expect(asciiActual.issues[0]?.matchedCommentSnippet).toContain("\u0000archive café 😀 tail-marker");
    expect(unicodeActual.issues[0]?.id).toBe(nulOversizeIssue.id);
    expect(unicodeActual.issues[0]?.matchedCommentSnippet).toContain("\u0000archive café 😀 tail-marker");
    expect(bomAsciiActual.total).toBe(1);
    expect(bomAsciiActual.issues[0]?.id).toBe(bomIssue.id);
    expect(bomAsciiActual.issues[0]?.matchedCommentSnippet?.codePointAt(0)).toBe(0xfeff);
    expect(bomUnicodeActual.total).toBe(1);
    expect(bomUnicodeActual.issues[0]?.id).toBe(bomIssue.id);
    expect(bomUnicodeActual.issues[0]?.matchedCommentSnippet?.codePointAt(0)).toBe(0xfeff);
  }, 30_000);

  it("keeps 1-SQL fast path and decodes chunked U+0000/U+FEFF/emoji comments accurately on file-backed SQLite UTF-16le and UTF-16be databases", async () => {
    if (backend !== "SQLite") return;

    const dir = mkdtempSync(join(tmpdir(), "mul331-utf16-"));
    try {
      for (const encoding of ["UTF-16le", "UTF-16be"] as const) {
        const dbPath = join(dir, `search-${encoding.toLowerCase()}.sqlite`);
        const db = openSqliteDatabase(dbPath) as unknown as SqlDatabase;
        try {
          db.exec(`PRAGMA encoding = '${encoding}'`);
          const actualEncoding = String((db.query("PRAGMA encoding").get() as { encoding?: string } | null)?.encoding ?? "");
          expect(actualEncoding).toBe(encoding);

          const store = new MultiremiStore(db);
          store.ensureLocalWorkspace();

          // 1. NUL-free issues containing ASCII and supplementary-plane emoji ('😀' has 0x00 bytes
          //    in UTF-16le/UTF-16be BLOB representation): CHAR(0) detection must NOT false-trigger.
          const fastIssue = createResponsibleTestIssue(store, {
            workspaceId: "local",
            title: "UTF16FAST-101 ASCII & 😀 title",
            description: "Normal UTF-16 description with 😀 emoji",
          });
          store.createIssueComment(fastIssue.id, { body: "UTF16FAST-101 normal comment 😀" });

          const nulFreeMiss = measureSql(db, () => store.searchIssues({ q: "no-match-utf16", workspaceId: "local", limit: 5 }));
          expect(nulFreeMiss.result).toEqual({ issues: [], total: 0 });
          expect(nulFreeMiss).toMatchObject({ reads: 1, writes: 0 });

          const nulFreeHit = measureSql(db, () => store.searchIssues({ q: "utf16fast-101", workspaceId: "local", limit: 5 }));
          expect(nulFreeHit).toMatchObject({ reads: 4, writes: 0 });
          expect(nulFreeHit.result).toEqual(legacySearchIssuesOracle(store, db, { q: "utf16fast-101", workspaceId: "local", limit: 5 }));

          // 2. Neutral-titled issue with oversized comment carrying leading U+FEFF, emoji, U+0000, needle, café
          const oversizeNeedleRest = `${"x".repeat(4095)}😀\u0000needle café`;
          const needleIssue = createResponsibleTestIssue(store, {
            workspaceId: "local",
            title: "Neutral UTF-16 oversize holder",
            description: "Clean neutral description",
          });
          const needleComment = store.createIssueComment(needleIssue.id, { body: "placeholder" });
          // SQLite UTF-16 translation strips one leading U+FEFF BOM on >=2048-char values
          // (including on subsequent row rewrites), so update body_md and created_at together
          // with CHAR(65279, 65279) || ? to persist a single raw leading U+FEFF in the column.
          db.run(
            "UPDATE multiremi_conversation_log SET body_md = CHAR(65279, 65279) || ?, created_at = ? WHERE id = ?",
            [oversizeNeedleRest, "2026-11-15T01:00:00.000Z", needleComment.id],
          );
          const persistedNeedle = db.query("SELECT body_md FROM multiremi_conversation_log WHERE id = ?").get(needleComment.id) as { body_md: string };
          expect(persistedNeedle.body_md.codePointAt(0)).toBe(0xfeff);
          expect(persistedNeedle.body_md.codePointAt(1)).toBe("x".codePointAt(0));
          setUpdatedAt(db, needleIssue.id, "2026-11-15T01:00:00.000Z");

          // 3. Neutral-titled issue with >= 4113 B comment starting with U+FEFF + match token to verify BOM preservation
          const bomHeadRest = `bomhead ${"z".repeat(4100)}😀\u0000bomend`;
          expect(Buffer.byteLength(`\uFEFF${bomHeadRest}`, "utf8")).toBeGreaterThanOrEqual(4113);
          const bomHeadIssue = createResponsibleTestIssue(store, {
            workspaceId: "local",
            title: "Neutral UTF-16 BOM holder",
            description: "Clean neutral description",
          });
          const bomHeadComment = store.createIssueComment(bomHeadIssue.id, { body: "placeholder" });
          db.run(
            "UPDATE multiremi_conversation_log SET body_md = CHAR(65279, 65279) || ?, created_at = ? WHERE id = ?",
            [bomHeadRest, "2026-11-15T02:00:00.000Z", bomHeadComment.id],
          );
          const persistedBomHead = db.query("SELECT body_md FROM multiremi_conversation_log WHERE id = ?").get(bomHeadComment.id) as { body_md: string };
          expect(persistedBomHead.body_md.codePointAt(0)).toBe(0xfeff);
          expect(persistedBomHead.body_md.codePointAt(1)).toBe("b".codePointAt(0));
          setUpdatedAt(db, bomHeadIssue.id, "2026-11-15T02:00:00.000Z");

          const previousLimit = process.env.MULTIREMI_PG_REPLY_MAX_BYTES;
          const previousEnforce = process.env.MULTIREMI_PG_REPLY_ENFORCE;
          const replyExceptions = DB_REPLY_TRANSITION_EXCEPTIONS as Set<string>;
          const wasCompatExempt = replyExceptions.has("GET /api/issues/search");
          replyExceptions.delete("GET /api/issues/search");
          process.env.MULTIREMI_PG_REPLY_MAX_BYTES = "4096";
          process.env.MULTIREMI_PG_REPLY_ENFORCE = "1";
          resetDbReplyLimitForTest();

          const reviewResults = new Map<string, { issues: MultiremiIssueSearchResult[]; total: number }>();
          const compatResults = new Map<string, { issues: Array<{ id: string; match_source: string; matched_comment_snippet?: string; matched_snippet?: string }>; total: number }>();

          try {
            const reviewApp = new Hono();
            reviewApp.use("*", createRequestMetricsMiddleware({
              enabled: false,
              slowRequestMs: 500,
              summaryIntervalMs: 60_000,
              summaryTopRoutes: 10,
              bufferCapacity: 256,
              role: "all",
            }));
            reviewApp.get("/api/review-fixture", (c) => {
              expect(postgresReplyMaxBytes()).toBe(4096);
              expect(currentDbReplyPolicy()).toMatchObject({ limitBytes: 4096, enforced: true, exempt: false });
              const q = c.req.query("q") ?? "";
              return c.json(store.searchIssues({ q, workspaceId: "local", limit: 10 }));
            });

            const app = createMultiremiApp({ store });

            for (const q of ["needle", "café", "\u0000needle", "bomhead"]) {
              const reviewMeasured = await measureSqlAsync(db, async () => {
                const resp = await reviewApp.request(`/api/review-fixture?q=${encodeURIComponent(q)}`);
                expect(resp.status).toBe(200);
                return await resp.json() as { issues: MultiremiIssueSearchResult[]; total: number };
              });
              expect(reviewMeasured.writes).toBe(0);
              expect(reviewMeasured.statements.some((sql) => sql.includes("HEX(CAST('A' AS BLOB))"))).toBe(true);
              reviewResults.set(q, reviewMeasured.result);

              const compatResp = await app.request(`/api/issues/search?q=${encodeURIComponent(q)}&workspace_id=local&limit=10`);
              expect(compatResp.status).toBe(200);
              expect(compatResp.headers.get("X-Total-Count")).toBe("1");
              compatResults.set(
                q,
                await compatResp.json() as {
                  issues: Array<{ id: string; match_source: string; matched_comment_snippet?: string; matched_snippet?: string }>;
                  total: number;
                },
              );
            }
          } finally {
            if (previousLimit === undefined) delete process.env.MULTIREMI_PG_REPLY_MAX_BYTES;
            else process.env.MULTIREMI_PG_REPLY_MAX_BYTES = previousLimit;
            if (previousEnforce === undefined) delete process.env.MULTIREMI_PG_REPLY_ENFORCE;
            else process.env.MULTIREMI_PG_REPLY_ENFORCE = previousEnforce;
            if (wasCompatExempt) replyExceptions.add("GET /api/issues/search");
            resetDbReplyLimitForTest();
          }

          for (const q of ["needle", "café", "\u0000needle"]) {
            const expected = legacySearchIssuesOracle(store, db, { q, workspaceId: "local", limit: 10 });
            const reviewActual = reviewResults.get(q)!;
            const compatActual = compatResults.get(q)!;
            expect(reviewActual).toEqual(expected);
            expect(reviewActual.total).toBe(1);
            expect(reviewActual.issues[0]?.id).toBe(needleIssue.id);
            expect(reviewActual.issues[0]?.matchSource).toBe("comment");
            expect(compatActual.total).toBe(1);
            expect(compatActual.issues[0]?.id).toBe(needleIssue.id);
            expect(compatActual.issues[0]?.match_source).toBe("comment");
            expect(compatActual.issues[0]?.matched_comment_snippet).toBe(expected.issues[0]?.matchedCommentSnippet);
            expect(compatActual.issues[0]?.matched_snippet).toBe(expected.issues[0]?.matchedSnippet);
          }

          const bomExpected = legacySearchIssuesOracle(store, db, { q: "bomhead", workspaceId: "local", limit: 10 });
          const bomReviewActual = reviewResults.get("bomhead")!;
          const bomCompatActual = compatResults.get("bomhead")!;
          expect(bomReviewActual).toEqual(bomExpected);
          expect(bomReviewActual.total).toBe(1);
          expect(bomReviewActual.issues[0]?.id).toBe(bomHeadIssue.id);
          expect(bomReviewActual.issues[0]?.matchSource).toBe("comment");
          expect(bomReviewActual.issues[0]?.matchedCommentSnippet?.codePointAt(0)).toBe(0xfeff);
          expect(bomCompatActual.total).toBe(1);
          expect(bomCompatActual.issues[0]?.matched_comment_snippet?.codePointAt(0)).toBe(0xfeff);
        } finally {
          db.close();
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("enforces exact 6-read single-batch boundaries for SQLite persisted-NUL ASCII fallback and 1999->2000 short-comment continuation", () => {
    const f = fixture();

    // 1. SQLite persisted-NUL mixed field + comment hit under ASCII query:
    //    1 candidate probe read (detects has_nul=1) + 5 fallback reads = 6 business reads, 0 writes.
    if (backend === "SQLite") {
      const nulBoundWs = f.store.createWorkspace({ name: "NUL 6-read boundary", slug: "nul-6-read" });
      const titleHit = f.createIssue({
        workspaceId: nulBoundWs.id,
        title: "NULSIX-600 title hit",
        description: "Clean description",
      });
      setUpdatedAt(f.db, titleHit.id, "2026-11-16T02:00:00.000Z");

      const nulCommentHit = f.createIssue({
        workspaceId: nulBoundWs.id,
        title: "Neutral persisted NUL comment holder",
        description: "Clean description",
      });
      f.store.createIssueComment(nulCommentHit.id, { body: "\u0000NULSIX-600 comment hit" });
      setUpdatedAt(f.db, nulCommentHit.id, "2026-11-16T01:00:00.000Z");

      const expected = legacySearchIssuesOracle(f.store, f.db, {
        q: "NULSIX-600",
        workspaceId: nulBoundWs.id,
        limit: 1,
      });
      const measured = measureSql(f.db, () => f.store.searchIssues({
        q: "NULSIX-600",
        workspaceId: nulBoundWs.id,
        limit: 1,
      }));
      expect(measured.result).toEqual(expected);
      expect(measured.result.total).toBe(2);
      expect(measured.result.issues.map((item) => item.id)).toEqual([titleHit.id]);
      expect(measured).toMatchObject({ reads: 6, writes: 0, txControl: 0 });
    }

    // 2. Direct non-ASCII fallback (`q="café"`) across 1999 -> 2000 short visible comments:
    //    - At 1999 rows (< ISSUE_SEARCH_COMMENT_BATCH_ROWS=2000): 5 business reads, 0 writes.
    //    - At 2000 rows (=== ISSUE_SEARCH_COMMENT_BATCH_ROWS): 1 extra empty continuation probe -> 6 business reads, 0 writes.
    const batchWs = f.store.createWorkspace({ name: "Batch 2000 boundary", slug: "batch-2000-boundary" });
    const batchTitleHit = f.createIssue({
      workspaceId: batchWs.id,
      title: "CAFÉ-B2000 title hit",
      description: "Clean description",
    });
    setUpdatedAt(f.db, batchTitleHit.id, "2026-11-17T02:00:00.000Z");

    const batchCommentHolder = f.createIssue({
      workspaceId: batchWs.id,
      title: "Neutral B2000 comment holder",
      description: "Clean description",
    });
    const firstMatch = f.store.createIssueComment(batchCommentHolder.id, { body: "CAFÉ-B2000 matching comment" });
    setCommentCreatedAt(f.db, firstMatch.id, "2026-11-17T01:00:00.000Z");
    setUpdatedAt(f.db, batchCommentHolder.id, "2026-11-17T01:00:00.000Z");

    const seedRow = f.db.query("SELECT session_id, seq FROM multiremi_conversation_log WHERE id = ?").get(firstMatch.id) as {
      session_id: string;
      seq: number;
    };
    const sessionId = seedRow.session_id;
    const baseSeq = Number(seedRow.seq);

    // Insert 1998 additional short visible comments (total 1999 visible comments on nonFieldMatchedIds).
    const insertShortComments = (startOffset: number, count: number) => {
      f.transaction(() => {
        const chunkSize = 200;
        for (let offset = 0; offset < count; offset += chunkSize) {
          const batchCount = Math.min(chunkSize, count - offset);
          const valuePlaceholders: string[] = [];
          const params: unknown[] = [];
          for (let j = 0; j < batchCount; j += 1) {
            const idx = startOffset + offset + j;
            valuePlaceholders.push("(?, ?, ?, 'message', 'shown', 'member', 's', '2026-11-17T00:00:00.000Z', '2026-11-17T00:00:00.000Z')");
            params.push(sessionId, baseSeq + idx, `msg_b2000_${idx}`);
          }
          f.db.run(
            `INSERT INTO multiremi_conversation_log (session_id, seq, id, kind, visibility, sender_type, body_md, created_at, updated_at)
             VALUES ${valuePlaceholders.join(", ")}`,
            params,
          );
        }
      });
    };

    insertShortComments(1, 1998);

    const at1999 = measureSql(f.db, () => f.store.searchIssues({
      q: "café-b2000",
      workspaceId: batchWs.id,
      limit: 1,
    }));
    expect(at1999.result.total).toBe(2);
    expect(at1999.result.issues.map((item) => item.id)).toEqual([batchTitleHit.id]);
    expect(at1999).toMatchObject({
      reads: 5,
      writes: 0,
      txControl: backend === "PostgreSQL" ? 1 : 0,
    });

    // Insert the 2000th short visible comment -> triggers 1 empty continuation probe (5 -> 6 reads).
    insertShortComments(1999, 1);

    const at2000 = measureSql(f.db, () => f.store.searchIssues({
      q: "café-b2000",
      workspaceId: batchWs.id,
      limit: 1,
    }));
    expect(at2000.result).toEqual(at1999.result);
    expect(at2000).toMatchObject({
      reads: 6,
      writes: 0,
      txControl: backend === "PostgreSQL" ? 1 : 0,
    });
  }, 30_000);
}, { isolation: "snapshot" });
