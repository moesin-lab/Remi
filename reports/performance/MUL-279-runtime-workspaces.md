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

The regression caps all observed query/prepare executions at 7 and 10
respectively (including room for the existing readiness probe), and elapsed
HTTP+JSON time at 2 seconds per route. It verifies directory membership,
foreign workspace isolation, stale heartbeat handling, archival filtering and
archive status. Existing budgets are unchanged.

## Validation boundary and outstanding investigation

The SQLite regression and related directory/Runtime tests passed. PostgreSQL
has not been run: this execution environment cannot access the Docker socket,
sudo fails and available SSH authentication to the stable host failed.
The new fixture supports `MULTIREMI_TEST_POSTGRES_URL` using an isolated DB;
it does not fall back to SQLite if an explicitly configured PG fails.

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
