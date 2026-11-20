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
