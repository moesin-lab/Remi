# MUL-279: batch usage-report lifecycle aggregation

## Diagnosis and scope

Base: `1565ee296b3e73733afc2eb0cd221680271272d8` (includes merged PR #154).
Measured on 2026-11-20 in the Linux execution container, Bun 1.3.14, SQLite.

`UsageAccountingRepo.report` independently queried summary, day, agent and
Runtime lifecycle metrics. Each SQL repeated the scoped attempt/turn query,
including frozen scope, Issue, Chat and latest Autopilot joins. Under the
synchronous PG bridge, these are four separate main-thread waits.

The change materializes the filtered current-attempt lifecycle rows once and
returns the four aggregates with UNION ALL in one statement. Consumption,
pricing, cursor semantics, snapshot isolation and timezone expressions remain
unchanged. This removes three bridge round trips; aggregation still scans the
materialized rows for each view. Memory and CPU are not constant in history
size. No cross-request cache or stable configuration change is introduced.

## Same-database comparison

Both implementations ran against the **same database connection and rows**.
The baseline repository class was extracted with:

```sh
git show 1565ee296:packages/server/src/store/repos/usage-accounting-repo.ts > tests/unit/multiremi/mul279-before.ts
```

A temporary variant of `usage-report-cost.test.ts` instantiated this class with
the same StoreContext, temporarily replaced `store.getUsageReport` for the old
HTTP call, then restored the current implementation. Both paths were warmed
once before measurement; seeding was excluded. The empty fixture was measured,
then 24 completed tasks belonging to one agent/Runtime were added to that same
database and measured. Complete decoded responses were equal after excluding
`as_of`. Temporary baseline and comparison files were removed after execution.

| Tasks | Before queries | After queries | Before HTTP+JSON ms | After HTTP+JSON ms |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 9 | 6 | 107.97 | 106.49 |
| 24 | 9 | 6 | 136.07 | 122.01 |

These counts observe `db.query` entry calls, excluding transaction `exec` and
`run`; they are **not** the production per-route SQL counter (the prior stable
16-SQL/1.5s sample uses a different counter/dataset). Timing is a single shared
machine sample, not p95. The reliable improvement here is three fewer queries.
The fresh HTTP budget test separately measured 10 before / 7 after at both
scales; the additional readiness query explains the cold/warm difference.

## Validation

```sh
bun run test tests/unit/multiremi/usage-report-cost.test.ts tests/unit/multiremi/store-usage-accounting.test.ts tests/unit/multiremi/usage-day-model.test.ts tests/unit/multiremi/usage-day-model-api.test.ts tests/unit/multiremi/store-usage-repo.test.ts
bunx tsc --noEmit
```

49 pass / 0 fail, 308 expectations across five files. Typecheck passed.
The temporary same-database comparison passed with 30 expectations.
The new budget caps query entries at 8 and complete HTTP+JSON at 2 seconds,
covering empty and 24-task lifecycle views. Running it before the source change
failed at 10 queries, as intended. Existing budgets were not changed.

The new test uses `openHotspotDatabase`, so an explicit
`MULTIREMI_TEST_POSTGRES_URL` selects real isolated PG and connection failure
cannot silently fall back. The backend CI runner requires that URL. Actual PG
execution, full CI and independent review are still pending at report creation;
SQLite execution must not be reported as PG verification.

## Production boundary

Owner reported #144 and #147 deployed at `aa9a924a9`. The lower-load observation
had 0 5xx, but event-loop lag still reached 7974ms; it is not a matched-load
comparison. GitHub confirms #154 merged at 2026-11-20 15:49:39 UTC, with no
verified deployment evidence in this session. Docker socket access remains
permission denied. No live PG statistics, plans or stack profile were collected.

After #154 deployment, collect the same minute columns (req, slow, 5xx,
db_busy, db_queries, lag_max) plus readyz latency while several agents run;
record deployed SHA, active-agent count and route mix. This change does not
claim to resolve the remaining inbox/snapshot latency, frontend request count,
3–8s blocking stack or readiness behavior. MUL-279 stays open; MUL-284 stays
in_review pending specific live acceptance of #144.

## Reproducible review follow-up

`tests/manual/compare-usage-lifecycle.ts` retains the comparison instead of
depending on deleted temporary test files. It extracts the pinned baseline
above using `git show`, imports it as a temporary module, and removes that
module on exit. Run from the task worktree after fetching the baseline object:

```sh
bun run tests/manual/compare-usage-lifecycle.ts > /tmp/usage-comparison.json
# Requires an admin URL for a disposable local/test PG, never the stable URL:
MULTIREMI_TEST_POSTGRES_URL=postgres://... \
  bun run tests/manual/compare-usage-lifecycle.ts > /tmp/usage-comparison-pg.json
```

Each implementation runs on the same connection and rows after warmup. The
read clock is fixed at 2026-10-05T12:00:00Z, and **the complete report including
as_of** is compared. Cases cover local empty data with foreign-workspace
consumption present, completed/failed/cancelled tasks, a replacement attempt
that is still active, queued work at the final scale, consumption on either
side of Shanghai midnight, explicit inclusive since/exclusive until, UTC,
Shanghai and Los Angeles timezones, a populated project scope, Runtime scope,
foreign-workspace isolation, costs in USD/CNY, tokens and day/model detail.
This is a finite equivalence fixture, not exhaustive coverage of all histories.

The default large scale has 240 original local tasks, a replacement attempt,
one queued local task, a foreign task and 6,000 additional consumption rows.
The extra rows deliberately concentrate on one failed attempt; this skew is
synthetic and is not a copy of stable's distribution. Sizes can be overridden
with `MUL279_TASKS` (at least 24) and `MUL279_UNITS` (nonnegative). Output includes
all old/new SQL and SQLite EXPLAIN QUERY PLAN or PG EXPLAIN (ANALYZE, BUFFERS,
FORMAT JSON) for the large UTC and project-filtered cases. Plans run after timing, with transaction
local jit=off on PG, matching the report's JIT policy.

The harness measures Store report duration and actual prepared statement
get/all executions; it excludes transaction exec/run. These are distinct from
the original HTTP query-entry measurement and the stable route SQL counter.
The new script is manual; the existing 8-query/2-second HTTP budget remains
unchanged and continues to run in backend CI. PG requires the explicitly
configured test database to work and never falls back to SQLite.

The 60,000-extra-row run with populated project scope was stopped after more
than five minutes without a complete result. It is not a passed scale check;
no latency or equality conclusion is claimed for that unfinished run. The
smaller default keeps the reproducible manual check practical while preserving
the observed project-filter bottleneck. A PG dataset matching stable's size
and distribution remains required before closing the review evidence gap.

### Recorded SQLite follow-up, 2026-11-20 UTC

Linux execution container, Bun 1.3.14. The command above completed with 18/18
full-response comparisons equal, including the fixed `as_of`. Raw SQL, plans,
statement execution times and scope inputs are retained in
[`MUL-279-usage-comparison-sqlite.json`](MUL-279-usage-comparison-sqlite.json).

| Fixture / scope | Old executions | New executions | Old Store report ms | New Store report ms |
| --- | ---: | ---: | ---: | ---: |
| Empty local, UTC (foreign consumption present) | 8 | 5 | 107.01 | 116.51 |
| 24 original tasks + active replacement, UTC | 8 | 5 | 117.54 | 120.39 |
| 240 original tasks + replacement + queued task, 6,000 extra units, UTC | 8 | 5 | 252.90 | 247.09 |
| Same large dataset, populated project filter | 8 | 5 | 5216.46 | 5282.88 |

These are single sequential samples on a shared machine, not a speedup claim.
The project-filtered consumption statement alone took 5055.58ms before and
5127.67ms after; the new lifecycle statement took 1.42ms. SQLite's project plan
shows repeated correlated `scope_unit` searches using the task-first primary
key (`sqlite_autoindex_multiremi_usage_units_1 (task_id=?)`) across the expanded
task subqueries. No project-specific composite access appears at those
searches. This identifies a reproducible local consumption/filter cost that
#156 does not address; an index search is not proof that little work is done.
It does not establish PG's chosen plan, scanned-tuple count, or the source of
stable's event-loop stalls. PG plans are still required before choosing a
materialization/filter/index change.

Re-ran the five test files listed above: 49 pass, 0 fail, 308 expectations.
`bunx tsc --noEmit`, `npm run docs:test` (13 pass), `npm run docs:check`, and
`git diff --check` passed. Existing budgets were not changed.

CI observation at 2026-11-20T16:41:59.958Z for original head `e743f885a`:
[run 44768649264](https://github.com/moesin-lab/Remi/actions/runs/44768649264)
was still in progress, backend shards 0/1/3/4/5/7 succeeded, 2/6 were running;
`runtime-platform (macos-latest)` was cancelled, so the observed check summary
was failure. This is not a complete green CI record and no individual PG test
log was retrieved. The current CLI's SCM check summary was used because the
container's `gh` binary is an unrelated host lookup program. Local PG binaries
are unavailable; attempted package preparation failed on the container's UID
mapping (`setgroups` / `seteuid` not permitted). No PG execution is claimed.
PG scale evidence, full CI and independent re-review remain open.

## Interpreting the owner's cumulative PG hotspots

The owner confirmed pg_stat_statements is unavailable. No restart or extension
change is proposed here. Table counters cannot supply a top-ten statement
ranking, statement latency, or unique route attribution. In particular,
correlated subqueries can execute many scans inside one SQL request; seq_scan
is not an HTTP request counter. An index existing also does not prove PG will
choose it, especially on a 13-row or 35-row table.

| Table | Confirmed source candidates at this PR base | What remains to measure |
| --- | --- | --- |
| usage_units | `UsageAccountingRepo.report`: report extent, run observations, unit facts, and optional project/Runtime EXISTS predicates | Exact selected range and all report plans on representative PG; #156 does not change these consumption reads |
| turns / turn_attempts | Execution-record projection used by reporting, task scheduler/claims, Inbox and task snapshots | PG plans and per-source attribution; totals do not isolate any one consumer |
| conversation_log | Session window reads in `ConversationLogRepo`, turn execution projection and task reply lookup | Window/range and projection plans; session/visibility/seq and task indexes alone are not evidence of their use |
| feishu_bot_chat_bindings | Feishu card/candidate queries, Chat exclusion predicates, task binding/visibility lookups and Inbox | Candidate-row counts and correlated plan loops; cannot infer a 4.9-million-tick bot poll from the table counter |
| scm_sync_cursors | `ScmPollingScheduler.runOnceInternal`: default 10-second tick, enabled poll/hybrid connections × repository bindings × five streams, `getSyncCursor` before `pollIsDue`; lease/cursor writes also reread it | Fixed-window query count per scm.poll and plans before choosing batched reads; the lookup already matches its three-column primary key |

For the next PG collection, sample table counters twice over the same fixed
window without resetting shared statistics. Record deployed SHA, load/active
agents and route mix, then compare deltas. Join this with frame/route SQL
attribution and sampled pg_stat_activity during the lag; an idle snapshot
after recovery cannot identify the SQL or bridge stage that stalled earlier.
Any additional index must use the B1 additive expand mechanism. No schema,
polling cadence, stable configuration or live data changed in this follow-up.
