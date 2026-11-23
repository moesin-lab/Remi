# MUL-327 / MUL-279 / MUL-331: `IssuesRepo.searchIssues` workspace-scoped SQL pushdown

## Scope and evidence

Measured on 2026-11-23 with Bun 1.3.14 on isolated in-memory SQLite fixtures against base commit `d69bc1d46` (branch `agent/MUL-331`). These measurements are isolated local fixture samples, not production PostgreSQL latency or p95 claims.

### 1. Paired before/after SQL budget fixture (`tests/unit/multiremi/issue-search-sql-budget.test.ts`)

Fixture scales (each local issue has 2 comments; each foreign issue has 1 comment):
- **Small**: 15 target-workspace (`local`) issues + 25 foreign-workspace issues = **40 total issues**.
- **Large**: 120 target-workspace (`local`) issues + 180 foreign-workspace issues = **300 total issues**.

Before-change numbers are measured on the same database via the verbatim pre-MUL-331 oracle (`listIssues({ includeArchived: true })` + per-issue `multiremi_issue_message_records` lookup). Every case asserts deep field-for-field equality (`total`, `issues[]`, `labels`, `matchSource`, `matchedDescriptionSnippet`, `matchedCommentSnippet`, `matchedSnippet`, sort order).

| Scenario (`workspaceId="local"`, `limit=5`) | Scale (total issues) | Before SQL (reads/writes) | After SQL (reads/writes) | Before ms (SQLite) | After ms (SQLite) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Miss (`q="no-match-anywhere"`, `includeCommentBodies=true`) | 40 | 42 / 0 | 1 / 0 | — | — |
| Miss (`q="no-match-anywhere"`, `includeCommentBodies=true`) | 300 | 302 / 0 | 1 / 0 | 2.85 | 0.60 |
| Title hit (`q="titlehit"`, `includeCommentBodies=true`) | 300 | 302 / 0 | 3 / 0 | 2.60 | 0.90 |
| Comment hit (`q="commenthit"`, `includeCommentBodies=true`) | 40 | 42 / 0 | 4 / 0 | — | — |
| Comment hit (`q="commenthit"`, `includeCommentBodies=true`) | 300 | 302 / 0 | 4 / 0 | 2.74 | 1.07 |
| Multi-term comment hit (`q="token commenthit"`, `includeCommentBodies=true`) | 300 | 302 / 0 | 4 / 0 | — | — |
| Title hit (`q="titlehit"`, `includeCommentBodies=false`) | 300 | — | 3 / 0 | — | — |
| HTTP `GET /api/issues/search?q=commenthit&workspace_id=local&limit=5` | 300 | — | 6 / 0 | — | 16.55 |

SQL query count is constant `O(1)` between 40-issue and 300-issue fixtures (1 read on miss, 3 reads when the current page has no comment matches, 4 reads when the current page includes comment matches; 0 writes in all cases).

### 2. Store N+1 benchmark (`tests/manual/bench-store-n-plus-one.ts`)

Command:

```sh
bun run tests/manual/bench-store-n-plus-one.ts "IssuesRepo.searchIssues(includeCommentBodies=true)"
```

Observed output (SQLite):

```text
IssuesRepo.searchIssues(includeCommentBodies=true): 0=1 SQL/0.218ms; 50=1 SQL/0.25ms; 200=1 SQL/0.357ms; 500=1 SQL/0.518ms
```

Previously this case executed `O(N)` statements (1 `listIssues` + 1 label batch + `N` per-issue comment queries = `N + 2` queries, e.g., 502 queries at `N = 500`).

## Root cause and change

Previously `packages/server/src/store/repos/issues-repo.ts` (`searchIssues` / `searchIssueCommentSnippet`):
1. Called `this.listIssues({ includeArchived: true })` without a `workspaceId`, loading and hydrating labels for every issue across **all workspaces**.
2. When `includeCommentBodies !== false`, ran a synchronous `SELECT body FROM multiremi_issue_message_records WHERE issue_id = ? ORDER BY created_at DESC` for **every issue row across all workspaces** (N+1 round-trips over the synchronous PG bridge).

With this change:
1. **Workspace & closed/archived pushdown**: Queries filter `i.workspace_id = ?` in SQL. When `!includeClosed`, SQL strips all 25 ECMAScript `WhiteSpace + LineTerminator` code points (`TRIM(COALESCE(i.status, 'todo'), <25 chars>)` on SQLite, `BTRIM(COALESCE(i.status, 'todo'), <25 chars>)` on PostgreSQL) before `NOT IN ('done', 'cancelled')`, matching `normalizeIssueStatus`'s JS `.trim()`, and gates archived exemption on `(TYPEOF(i.archived_at) = 'text' AND i.archived_at <> '')` on SQLite / `(i.archived_at IS NOT NULL AND i.archived_at <> '')` on PostgreSQL, matching `nullableString(row.archived_at)` and preserving the exact legacy rule (`if (!includeClosed && CLOSED_ISSUE_STATUSES.has(issue.status) && !issue.archivedAt) return false`).
2. **Portable literal-substring & Unicode ASCII-folding alignment**: Multi-word whitespace-separated terms are lowercased, deduplicated, escaped for `\`, `%`, `_`, and matched with `LOWER(...) LIKE ? ESCAPE '\'` across effective issue key (`issue_key` / `MUL-<issue_number>` / `id`), `title`, `description`, and comment `body_md`. Before `LOWER(...)`, columns conditionally normalize the only two non-ASCII Unicode code points whose ECMAScript `.toLowerCase()` produces ASCII or uncased characters (`U+212A` `'K'` -> `'k'` when any term contains `'k'`, and `U+0130` `'İ'` -> `'i\u0307'` when any term contains `'i'` or `'\u0307'`) so SQLite (`LOWER` is ASCII-only) and PostgreSQL (`en_US.utf8` `LOWER('İ')` drops `\u0307`) match JS `searchMatch()` identically in both directions (including standalone `"\u0307"` / `"\u0307stan"` queries against `"İstanbul"`). `buildIssueSearchResult` also requires `matchedCommentSnippet !== null` before assigning `matchSource = "comment"`. Rare queries containing non-ASCII cased letters (e.g. `café` matching `CAFÉ`) or `> 50` distinct terms fall back to a workspace-scoped, set-based scan (still `O(1)` SQL queries, 2–4 reads, zero N+1).
3. **Materialized CTE + `UNION ALL` base-table comment lookup (zero PG17 stale-stats Nested Loop)**: When `includeCommentBodies` is enabled, comment matching runs in a `matched_comments AS MATERIALIZED (...)` CTE over `multiremi_issues i JOIN multiremi_issue_sessions s ON s.issue_id = i.id JOIN multiremi_conversation_log l ON l.session_id = s.id` (`s.chat_id IS NULL AND l.kind = 'message' AND l.visibility = 'shown' AND l.deleted_at IS NULL`) and combines with `issue_matches` via `UNION ALL` instead of `LEFT JOIN`, preventing PostgreSQL 12+ from inlining a single-reference CTE into a correlated Nested Loop when table statistics are stale (`reltuples = 0` after bulk inserts). JS merges both branches by `id` (`matchRank = Math.min(...)`, `hasCommentMatch = a || b`), keeping `miss = 1 SQL` and preserving `matchedCommentSnippet` on key/title/description hits.
4. **Page-only hydration, candidate & comment tie-breaking contracts**: Candidate ordering aligns with baseline `listIssues({ includeArchived: true })` (`ORDER BY updated_at DESC`) + stable JS sort via `compareIssueSearchCandidates`: `matchRank ASC`, `Date.parse(right.updatedAt) - Date.parse(left.updatedAt)` (falling through on `0` / `NaN`), raw `updated_at` code-unit `DESC` (handling equal-instant timezone variants such as `+02:00` vs `Z`), SQLite `i.rowid ASC` (preserving table-scan order on identical `updated_at` text), and `id ASC` fallback. `offset`/`limit` slicing computes `total` and page IDs (`<= 50`), and only the returned page fetches full `multiremi_issues` rows, labels (`hydrateIssues`), and the latest matching comment body (`ROW_NUMBER() OVER (PARTITION BY s.issue_id ORDER BY l.created_at DESC, l.seq DESC, l.id DESC) = 1`) for `extractSearchSnippet`. **Comment tie-breaking contract**: when multiple matching comments for the same issue have an identical `created_at`, both the SQL pushdown path and the non-ASCII fallback path deterministically order by `l.created_at DESC, l.seq DESC, l.id DESC` (picking the highest session sequence number first).

## Validation boundary

- **Verified locally on SQLite**:
  - `tests/unit/multiremi/issue-search-sql-budget.test.ts` (SQLite backend: equivalence against legacy oracle, multi-workspace isolation, `includeClosed` true/false + archived closed visibility + all 25 ECMAScript whitespace-padded closed statuses + SQLite BLOB/empty-string `archived_at`, `includeCommentBodies` true/false, `%`/`_`/`\`/quotes/Chinese/non-ASCII-cased/`Kelvin`/`İstanbul`/`\u0307`/`\u0307stan` queries, multi-session latest matching comment snippet, deterministic equal-`created_at` `seq DESC` tie-breaking, equal-`Date.parse(updatedAt)` timezone variant & identical-timestamp `rowid ASC` tie-breaking across `limit=1` paging, real `multiremi_chat_sessions` FK parent for chat-session exclusion, `offset`/`limit`/`total`, `O(1)` query budget, HTTP `/api/issues/search`, dialect-specific SQL assertions, and `translateSqliteToPg` verification preserving `AS MATERIALIZED`, `UNION ALL`, and `ESCAPE '\'`).
  - `tests/unit/multiremi/multiremi-store-issues.test.ts`, `multiremi-api-search-inbox.test.ts`, `multiremi-cli-issue.test.ts`, `multiremi-issue-sessions.test.ts`, `native-workspace-context.test.ts`, `workspace-request-context.test.ts`.
  - `./node_modules/.bin/tsc --noEmit`, `npm run docs:test`, `npm run docs:check`, `git diff --check`.
- **Not verified locally (pending PR CI PostgreSQL shard / live deployment)**:
  - Real PostgreSQL 17 execution: `MULTIREMI_TEST_POSTGRES_URL` is not configured in this devbox, so the PostgreSQL dialect block of `tests/unit/multiremi/issue-search-sql-budget.test.ts` was skipped locally and will execute automatically on real PostgreSQL 17 in PR CI.
  - Production/stable PostgreSQL `EXPLAIN ANALYZE` plans, bridge reply bytes under production data skew, and p50/p95 latency remain unmeasured until deployed and sampled.
  - Because this change uses `LIKE '%...%'` substring scans scoped to the target workspace, CPU/scan work inside the target workspace still scales with the number of issues and shown comments in that workspace (though foreign workspaces are excluded and SQL round-trips are reduced from `O(N_all_issues)` to `O(1)`).
