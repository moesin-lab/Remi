import { expect, it, spyOn } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import type { MultiremiIssueSearchResult } from "@multiremi/contracts/types.js";
import type { MultiremiStore } from "@multiremi/store.js";
import { translateSqliteToPg, type SqlDatabase, type SqlStatement } from "@multiremi/store/db/postgres.js";
import {
  clampSearchLimit,
  extractSearchSnippet,
  normalizeSearchQuery,
  searchMatch,
  searchRank,
} from "@multiremi/store/helpers.js";
import { pendingTurnBackendTests, type PendingTurnTestFixture } from "./pending-turn-test-backends.js";
import { seedHistoricalIssueFacts } from "./helpers.js";

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

function measureSql<T>(db: SqlDatabase, fn: () => T): {
  result: T;
  reads: number;
  writes: number;
  total: number;
  elapsedMs: number;
  statements: string[];
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const statements: string[] = [];
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const wrapped = new WeakSet<object>();
  const wrap = (statement: SqlStatement, text: string): SqlStatement => {
    if (wrapped.has(statement)) return statement;
    const proxy = new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (["get", "all", "run", "values"].includes(String(key))) {
          return (...args: unknown[]) => {
            statements.push(text);
            calls.push({ sql: text, params: args });
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
    statements.push(text);
    calls.push({ sql: text, params: args });
    return run(text, ...args);
  });
  const execSpy = spyOn(db, "exec").mockImplementation((text) => {
    statements.push(text);
    calls.push({ sql: text, params: [] });
    exec(text);
  });
  const startedAt = performance.now();
  try {
    const result = fn();
    const elapsedMs = performance.now() - startedAt;
    const writes = statements.filter((text) => SQL_WRITE_RE.test(text)).length;
    return { result, reads: statements.length - writes, writes, total: statements.length, elapsedMs, statements, calls };
  } finally {
    querySpy.mockRestore();
    prepareSpy.mockRestore();
    runSpy.mockRestore();
    execSpy.mockRestore();
  }
}

async function measureSqlAsync<T>(db: SqlDatabase, fn: () => Promise<T>): Promise<{ result: T; reads: number; writes: number; total: number; elapsedMs: number }> {
  const statements: string[] = [];
  const wrapped = new WeakSet<object>();
  const wrap = (statement: SqlStatement, text: string): SqlStatement => {
    if (wrapped.has(statement)) return statement;
    const proxy = new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (["get", "all", "run", "values"].includes(String(key))) {
          return (...args: unknown[]) => {
            statements.push(text);
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
    statements.push(text);
    return run(text, ...args);
  });
  const execSpy = spyOn(db, "exec").mockImplementation((text) => {
    statements.push(text);
    exec(text);
  });
  const startedAt = performance.now();
  try {
    const result = await fn();
    const elapsedMs = performance.now() - startedAt;
    const writes = statements.filter((text) => SQL_WRITE_RE.test(text)).length;
    return { result, reads: statements.length - writes, writes, total: statements.length, elapsedMs };
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

  it("matches legacy tie-breaking for equal Date.parse(updatedAt) timezone variants and identical timestamps across limit=1 paging", () => {
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

    if (backend === "SQLite") {
      // Identical updated_at text: SQLite baseline ORDER BY updated_at DESC preserves rowid ASC
      // even when the earlier-inserted row has a lexicographically larger id.
      f.db.run(
        `INSERT INTO multiremi_issues (id, issue_number, issue_key, title, description, status, workspace_id, created_at, updated_at)
         VALUES ('iss_zz_rowid_first', 9901, 'MUL-9901', 'ROWIDTIE-777 first inserted', NULL, 'todo', 'local', '2026-10-17T00:00:00.000Z', '2026-10-17T00:00:00.000Z')`,
      );
      f.db.run(
        `INSERT INTO multiremi_issues (id, issue_number, issue_key, title, description, status, workspace_id, created_at, updated_at)
         VALUES ('iss_aa_rowid_second', 9902, 'MUL-9902', 'ROWIDTIE-777 second inserted', NULL, 'todo', 'local', '2026-10-17T00:00:00.000Z', '2026-10-17T00:00:00.000Z')`,
      );
      const rowidPage0Expected = legacySearchIssuesOracle(f.store, f.db, { q: "ROWIDTIE-777", workspaceId: "local", limit: 1, offset: 0 });
      const rowidPage0Actual = f.store.searchIssues({ q: "ROWIDTIE-777", workspaceId: "local", limit: 1, offset: 0 });
      const rowidPage1Expected = legacySearchIssuesOracle(f.store, f.db, { q: "ROWIDTIE-777", workspaceId: "local", limit: 1, offset: 1 });
      const rowidPage1Actual = f.store.searchIssues({ q: "ROWIDTIE-777", workspaceId: "local", limit: 1, offset: 1 });
      expect(rowidPage0Actual).toEqual(rowidPage0Expected);
      expect(rowidPage1Actual).toEqual(rowidPage1Expected);
      expect(rowidPage0Actual.issues.map((item) => item.id)).toEqual(["iss_zz_rowid_first"]);
      expect(rowidPage1Actual.issues.map((item) => item.id)).toEqual(["iss_aa_rowid_second"]);
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
          const updatedAt = `2026-11-${String(1 + (i % 20)).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00.000Z`;
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
    expect(largeMissBefore.reads).toBeGreaterThanOrEqual(300);

    // Candidate query with comment bodies materializes workspace_issues once + matched_comments via UNION ALL
    expect(largeMissAfter.statements[0]).toContain("workspace_issues AS MATERIALIZED");
    expect(largeMissAfter.statements[0]).toContain("matched_comments AS MATERIALIZED");
    expect(largeMissAfter.statements[0]).toContain("UNION ALL");
    if (backend === "PostgreSQL") {
      expect(largeMissAfter.statements[0]).toContain("BTRIM(");
      expect(largeMissAfter.statements[0]).not.toContain("TYPEOF(");
      expect(largeMissAfter.statements[0]).not.toContain("i.rowid");
      expect(largeMissAfter.statements[0]).toContain("ROW_NUMBER() OVER (ORDER BY i.updated_at DESC, i.ctid ASC) AS issue_ord");
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

    // Explicitly verify translateSqliteToPg preserves the PostgreSQL LATERAL + ROW_NUMBER(i.ctid) candidate shape
    // even when this test runs on SQLite locally without MULTIREMI_TEST_POSTGRES_URL.
    const pgCandidateTemplate = `WITH workspace_issues AS MATERIALIZED (
      SELECT i.id, i.updated_at, ROW_NUMBER() OVER (ORDER BY i.updated_at DESC, i.ctid ASC) AS issue_ord,
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
    expect(translatedPgCandidate).toContain("ROW_NUMBER() OVER (ORDER BY i.updated_at DESC, i.ctid ASC) AS issue_ord");
    expect(translatedPgCandidate).toContain("CROSS JOIN LATERAL");
    expect(translatedPgCandidate).toContain("LIMIT 1");
    expect(translatedPgCandidate).toContain("ESCAPE '\\'");

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
}, { isolation: "snapshot" });
