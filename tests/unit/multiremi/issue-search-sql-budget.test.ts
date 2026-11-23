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

function measureSql<T>(db: SqlDatabase, fn: () => T): { result: T; reads: number; writes: number; total: number; elapsedMs: number; statements: string[] } {
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
    const result = fn();
    const elapsedMs = performance.now() - startedAt;
    const writes = statements.filter((text) => /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(text)).length;
    return { result, reads: statements.length - writes, writes, total: statements.length, elapsedMs, statements };
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
    const writes = statements.filter((text) => /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(text)).length;
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
  // Chat-owned session linked to this issue_id (chat_id IS NOT NULL)
  db.run(
    `INSERT INTO multiremi_issue_sessions (id, chat_id, issue_id, workspace_id, title, status, is_default, created_at, updated_at)
     VALUES ('chat_sess_leak', 'chat_1', ?, 'local', 'Chat projection', 'active', 0, '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z')`,
    [nonVisibleCommentIssue.id],
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

  // 10. Foreign workspace data with identical tokens (must stay isolated)
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

    // Every emitted SQL statement translates cleanly for PostgreSQL (numbered $N placeholders, intact ESCAPE '\').
    for (const sql of [...largeMissAfter.statements, ...largeCommentAfter.statements, ...largeMultiTermAfter.statements]) {
      const pgSql = translateSqliteToPg(sql);
      expect(pgSql).not.toContain("?");
      if (sql.includes("LIKE")) {
        expect(pgSql).toContain("ESCAPE '\\'");
      }
    }

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
