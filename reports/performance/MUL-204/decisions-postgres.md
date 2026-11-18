# MUL-204: PostgreSQL decision-window timeout

Baseline: `902d5109e31b1e578f7ad46ab3af66bc642da85a` (task branch `agent/MUL-204`).
Measurements below are local diagnostics against real PostgreSQL 17.10, Bun 1.3.14,
Linux, loopback TCP, isolated databases created/dropped by the tests. They are not
GitHub runner or production timings. This container maps its sole UID to root;
the disposable PG process uses a local UID/stat shim to permit its normal startup
ownership checks. Database queries execute in the actual PostgreSQL server, not a
mock. The shim is outside the repository and is not used by Bun/the application.

## Measured cause

The unmodified window test exceeded its 15 s limit (15,371.34 ms in the focused
run). After teardown, its suspended token verification resumed, queried the
terminated worker, waited the bridge's 60 s deadline and became an unhandled
error. The focused run ended after 83.07 s with `1 error`, including:

```text
# Unhandled error between tests
error: postgres bridge timed out
  SQL: SELECT token.* FROM multiremi_access_tokens token ...
  at verifyAccessToken (.../access-tokens-repo.ts:291:12)
```

A separate diagnostic temporarily raised **only that local test copy's** budget
to 120 s and wrapped the PG database's `execute` with `performance.now()`/query
counts. The committed limit remains **15,000 ms**. Measured phase times:

| Phase | Baseline duration |
| --- | ---: |
| Workspace/agent/issue/token setup | 348.00 ms |
| Create 52 historical decision fixtures | 16,044.96 ms |
| Persist 52 historical owner answers | 124.05 ms |
| Read windows/history, real member revision, pending fixture | 2,171.05 ms |
| Three mixed-kind fixtures/answers and final read | 1,894.12 ms |
| Complete PostgreSQL test | 20,583.33 ms |

The 18 most expensive SQL groups alone accounted for **15,056 statements**
(a lower bound, not the full count). During the initial 52 seeds alone:

| Query group | Count | Bridge execution time |
| --- | ---: | ---: |
| Agent lookup by ID | 3,016 | 2,996.21 ms |
| Scoped turn lookup | 1,482 | 2,268.84 ms |
| Issue routing facts | 2,964 | 2,170.93 ms |
| Message lookup by ID | 1,534 | 1,835.99 ms |
| Session lookup | 1,586 | 1,649.82 ms |
| Conversation head/source workspace | 1,430 | 1,181.03 ms |

The historical helper repeatedly used `sendMessage`, which re-routes/reconciles
Questions and reads earlier decisions. Counts grow with accumulated rows. The
required 50-entry window boundary needs at least 52 answers; shrinking that
fixture would remove coverage. The dominant cost is repeatedly running the
business mutation pipeline to seed already historical data, rather than storing
answers or a slow PostgreSQL plan for the bounded answered-window query.

## Change and lifecycle fix

The first fixture still uses canonical `sendMessage`; later historical rows copy
its actual persisted shape with fresh IDs, sequence, timestamps and decision
metadata. Each insertion updates the conversation head/log version atomically.
The head is read afresh because the real member revision can append replies.
The real HTTP revision, read APIs, 52-answer boundary, refreshed answer timestamp,
complete histories, pending history and mixed-kind ordering assertions remain.
A complete PG window flow now has a **3,000-statement budget**.

All exercise calls were already awaited. The missing lifecycle boundary was that
Bun's test timeout stops waiting for the test promise without cancelling its
async body. The suite now observes each exercise's rejection immediately and
awaits the same promise in `afterEach`, before environment/clock cleanup and PG
`afterAll` termination. Its failure is therefore reported by the test/hook.
The production bridge also records closure and refuses subsequent queries
immediately, preserving the SQL context for the caller instead of waiting on a
terminated worker. Repeated `close()` is safe.

A real PG regression starts `AccessTokensRepo.verifyAccessToken`, closes the
connection while verification is suspended at SHA-256, and awaits the rejection
at the caller. It also checks a query on the closed handle and repeated close.
Explicitly configured unavailable PG now fails setup instead of silently skipping.

## Validation

Commands use the repo test runner and an explicitly configured
`MULTIREMI_TEST_POSTGRES_URL` pointing to the disposable PG admin database:

```sh
bun run test tests/unit/multiremi/multiremi-issue-decisions.test.ts
bun run test tests/unit/multiremi/multiremi-issue-decisions.test.ts -t 'windows recently'
bun run test tests/unit/multiremi/multiremi-postgres-store.test.ts -t 'runs transactions .* atomically|retries the same waiting Turn'
bunx tsc --noEmit
npm run docs:test
npm run docs:check
```

| Fixed run | PG window duration | Window SQL statements |
| --- | ---: | ---: |
| Full decision file, default budgets | 3,033.90 ms | 2,189 |
| Focused repetition 1 | 3,183.69 ms | 2,192 |
| Focused repetition 2 | 2,839.21 ms | 2,192 |
| Focused repetition 3 | 2,976.90 ms | 2,192 |

The three focused runs have a 2,976.90 ms median, about **85.5% below** the
20,583.33 ms profiled baseline. The full file passed **7 tests, 0 failures**;
PG transaction regressions passed **2 tests, 0 failures**. No unhandled errors;
the runner reported no residual HOME writes. TypeScript passed; docs tests
passed 13/13 and context validation passed.

A second, intentionally failing diagnostic temporarily changed the PG window's
budget to **1 ms**. The original test was reported as timed out, but its exercise
was drained: 2,192 statements, 3,154.62 ms, total run 9.19 s, **0 unhandled errors**
and no bridge timeout. The normal 15 s source was restored afterward.

Remaining acceptance: independent review, merge authorization, and a successful
complete **main** backend CI after merge. Local diagnostics and branch CI do not
substitute for that final main run. The broader production cost of sending many
historical decisions through the native Question mutation path is unchanged.
