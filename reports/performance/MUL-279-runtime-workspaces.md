# MUL-279: Runtime directory list query amplification

## Scope and evidence

Measured on 2026-11-19 with Bun 1.3.14, SQLite, baseline
`b9c643605` (stable was reported at `7ae5b48c6`). This is an isolated fixture,
not a copy of stable data and not a production latency claim.

`runtime-workspaces-cost.test.ts` seeds 24 directories, 8 local Runtimes and
6 foreign Runtimes. Three local Runtimes share the owning daemon; foreign
Runtimes deliberately reuse that daemon ID. Fixture creation is outside the
measurement. Each measurement includes HTTP handling and JSON decoding.

| Route | Before SQL | After SQL | Before ms | After ms |
| --- | ---: | ---: | ---: | ---: |
| `/api/runtime-workspaces` | 1396 | 6 | 53.80 | 30.67 |
| `/api/runtimes/:id/workspaces` | 1399 | 9 | 26.01 | 2.08 |

These are single local samples, not p95. The first route includes cold request
setup. Query counts are the reproducible signal; wall times are noisy.

## Cause and change

Each directory used to call `listRuntimes()` and hydrate every Runtime's
usage, execution groups, models and protocol status before filtering by
workspace and daemon. Non-human access checks could also hydrate that list.
The response needs only identity, visibility, liveness and capability metadata.

Lists now read these Runtime facts once within the requested workspace and
reuse access facts for the response. Individual directory responses also use
the lightweight workspace read. No cross-request cache is introduced.
The Runtime-specific list still uses its existing authorization lookup.

CPU remains approximately O(directories × workspace Runtimes), because each
directory filters the response-local Runtime facts. This fixes SQL query
amplification; it does not make per-response CPU constant time.

The regression caps all observed query/prepare executions at 7 and 10
respectively (including room for the existing readiness probe), and elapsed
HTTP+JSON time at 2 seconds per route. It verifies directory membership,
foreign workspace isolation, stale heartbeat handling, archival filtering and
archive status. Existing budgets are unchanged.

## Validation boundary and outstanding investigation

The SQLite regression and related directory/Runtime tests passed. The same
source tree has now also passed on a real isolated PostgreSQL 17 service in
[PR CI run 44473170285](https://github.com/moesin-lab/Remi/actions/runs/44473170285),
using Bun 1.3.14. CI checked out merge SHA
`685f700545ea642c5f1070107369abd04355e40b`; both that commit and reviewed head
`64b6976d436913ef0f11fec206bf1ae28f16a872` resolve to tree
`11a7ddbd28ba6beac2db85dcd0bc7403963bbb79` (verified with `git rev-parse`).
Thus the tested source is byte-for-byte identical to the reviewed head.

The workflow supplies `MULTIREMI_TEST_POSTGRES_URL` for every backend shard,
starts `pgvector/pgvector:pg17`, and executes:

```sh
bun run scripts/ci-backend.ts run --plan ci-backend/plan.json --shard 7 --out ci-backend/shard-7.json
```

The runner validates that explicit PG connection before running tests. The
fixture creates and drops its own databases; it never connects to stable.
Missing PG configuration selects SQLite locally, so the explicit CI environment
and the fixture's `dialect: postgres` output are both necessary evidence.
An explicit failing PG connection cannot fall back to SQLite.

[Backend shard 7](https://github.com/moesin-lab/Remi/actions/runs/44473170285/job/135387389565)
actually executes `runtime-workspaces-cost.test.ts`, with 2 pass / 0 fail /
0 skip. Its output, excluding fixture creation from route time:

```text
{"path":"/api/runtime-workspaces","directories":24,"runtimes":14,"statements":6,"elapsed_ms":10.551289000024553}
{"path":"/api/runtimes/rt_dirs_host/workspaces","directories":24,"runtimes":14,"statements":9,"elapsed_ms":4.928752000036184}
(pass) directory lists have bounded SQL cost and preserve daemon membership and liveness [564.65ms]
(pass) task directory visibility stays bound to the requesting task [314.11ms]
REMI_TEST_DB_FIXTURE_STATS {"fixture":"first-screen-hotspots-database","dialect":"postgres","templateBuilds":1,"clones":2,"freshFallbacks":0,"databaseCreates":3,"templateMs":1929.252026000002,"createMs":197.44840900000418,"scope":"file"}
```

Existing first-screen tests also actually execute with PG, using the same
command with shard indices 4 and 5 respectively:

| Suite | Shard | Pass | Fail | Skip |
| --- | ---: | ---: | ---: | ---: |
| first-screen-hotspots-query-count | 4 | 7 | 0 | 0 |
| issue-detail-first-screen-query-count | 4 | 16 | 0 | 0 |
| first-screen-hotspots-pr2-golden | 5 | 7 | 0 | 0 |

[Shard 4](https://github.com/moesin-lab/Remi/actions/runs/44473170285/job/135387389475)
and [shard 5](https://github.com/moesin-lab/Remi/actions/runs/44473170285/job/135387389454)
logs include `dialect: postgres` fixture statistics. The golden output explicitly
passes byte-for-byte wire equality and constant-query equality at scales 1, 2
and 3. All eight backend shards, coverage evidence and the aggregate build
passed. Existing query/byte/time budgets and goldens were not changed.
These CI route times are single isolated-fixture samples, not stable p95, and
there is still no measured PostgreSQL before/after comparison on stable data.

Local PG was not run: Docker access and SSH authentication were unavailable in
the prior execution; this round's local package installation also failed on
`/var/lib/apt/lists/lock` with permission denied. The PG claims above come from
the retrieved real CI logs, not a mock or an unexecuted local command.

The attached/read-only script [MUL-279-readonly.sql](MUL-279-readonly.sql)
checks `pg_stat_statements` availability before reading the top ten statements
by execution time and calls. It also reads current blockers and table scan
statistics, without creating an extension or resetting counters. On the stable
host use stdin, never `docker cp`:

```sh
docker exec -i <PG-container> psql -X -U multiremi -d multiremi < reports/performance/MUL-279-readonly.sql
```

PG aggregates do not identify the HTTP route by themselves. The resulting
SQL fingerprints still need to be mapped to repository callers and correlated
with the post-#125 route/frame measurements. Missing live evidence includes
SQL top tens, execution plans and the specific 3–5 second blocking stack.

Other MUL-279 requirements remain open: usage/report, inbox, snapshot,
capabilities, Runtime list timing under load, complete page request inventories,
frontend request reduction and readiness behavior under transient congestion.
No stable configuration, deployment or readiness behavior changed in this PR.
