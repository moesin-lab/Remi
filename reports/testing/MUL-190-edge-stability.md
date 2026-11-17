# MUL-190 Edge fixture stability

PR: https://github.com/moesin-lab/Remi/pull/106
Baseline: `cb68d30784c1d7166392f5ee4205bfb32469c1ab` (main, merged PR #95).
Revision reviewed independently: `1e8fc3db173591510973ccb17fd1ce4e647e7377`.
Environment: Linux x86_64, Bun 1.3.14 (0d9b296a), Node 22.23.2.

## Root cause and corrected evidence

Host listener discovery injects unrelated `GET /` requests into real Bun/Edge
fixtures. An upload-only handler previously read that request's missing body;
the resulting backend exception coincided with held POST `ECONNRESET`. Discovery
also adds backend hits and Edge hold waiters, corrupting exact test counters.
Captured initial diagnostics included:

```
Unexpected held-upload backend request: GET http://127.0.0.1:32167/
peer={"address":"127.0.0.1","family":"IPv4","port":64290}
ua=onepage-discovery
at tests/unit/edge/edge.test.ts:365:55

error: The socket connection was closed unexpectedly.
path: "http://127.0.0.1:32639/?mode=standby&mib=100"
code: "ECONNRESET"
at tests/unit/edge/edge.test.ts:372:30
```

The previous claim that 127.0.0.2 isolates these fixtures was false. Independent
review held 20 listeners there for four minutes: every listener received `GET /`
with `user-agent: persona-ports`, `Host: localhost:<port>`, from 127.0.0.1. It also
found main failed 4/15 interleaved Edge runs and PR head failed 5/15. Earlier local
10-seed and 100-combination passes did not establish a stability improvement and
are not acceptance evidence for the corrected fix. A different bind address
cannot identify which requests belong to a test.

A separate real race remains fixed: waiting=1 does not prove the delayed prefix
has reserved 4 MiB. Sending a 6 MiB overflow after a fixed 100 ms sleep could
admit it too soon. Cleanup also previously left a pending upload unobserved on
assertion failure, producing teardown ECONNRESET.

## Corrected oracle and acceptance boundaries

Counting backends now match a fresh per-test nonce header on all their test
requests (including HTTP and Upgrade). The public encoded-path test still
requires exactly 28 hits and the original encoded path/query on every response.
The private-path test calibrates its oracle with a real tagged public request,
then requires 404 for every private HTTP/Upgrade path and exactly zero tagged
backend hits. Untagged direct and proxied probes are explicitly exercised.

Raw TCP counting fixtures accumulate complete headers before matching the nonce;
connection assertions count distinct sockets that actually carry test traffic.
The hold child observes the original Edge handle/acquire methods using async
request context. It counts only nonce-matching calls that actually enter the
real wait queue and decrements when the original acquire settles. Total status
and the global byte reservation stay unfiltered. An explicit `persona-ports`
GET is held in each mode: total waiting must include it while the test's own
waiting count is zero. This request still traverses the production Edge and
later reaches the backend. No production routing or error handling is changed.

The upload test still waits for the complete real 4 MiB reservation before a
6 MiB overflow, requires 503 + Retry-After, zero rejected test upload bytes at
the backend, 200 with exactly 4 MiB on admission, and released reservation.
Cleanup aborts and awaits the pending upload; non-AbortError failures propagate.
The 128 MiB/413 body limit, 8 MiB global budget, 40 MiB held RSS ceiling and
80 MiB streaming ceiling remain unchanged. Loopback binding and NO_PROXY remain
local transport configuration, with no claim of scanner isolation.

## Verification and reproducibility

Run the full Edge suite in separate processes with explicit order seeds:

```bash
for seed in $(seq 190 219); do
  bun run test tests/unit/edge --randomize --seed "$seed"
done
bunx tsc --noEmit
npm run docs:test
npm run docs:check
```

Exact head SHA, per-run exit status/counts, full logs and the final repeated-run
result are published in the PR conversation and the MUL-190 review reply. PR
backend CI skips `tests/unit/edge` on pull_request, so green checks are not
substitutes for these local real-Bun runs. They cover the entire Edge suite,
including HTTP/SSE/WS handovers, streaming, slow TCP readers and stalled closure.
Full repository backend coverage, deployed behavior, macOS/Windows execution
and PostgreSQL integration remain unverified by this revision.
