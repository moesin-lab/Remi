# MUL-190 Edge fixture stability

Baseline: `cb68d30784c1d7166392f5ee4205bfb32469c1ab` (main, merged PR #95).
Initial reproduction used the reviewed PR head `58d483d57448466bcd51c01bd1ced4fdea031fb0`.
Environment: Linux x86_64, Bun 1.3.14 (0d9b296a), Node 22.23.2.

## Failure evidence

Initial Edge suite: 34/34; seeds 190–194: 34/34 each; target pair: 40/40 runs.
A full backend run (`bun run test --randomize --seed 190`) was interrupted with
exit 130 after a non-Edge 500-task snapshot timeout. It did not reach Edge and is
not a full-suite pass. Other test processes ran on the host (load approximately
13, substantial available memory); no shared process was stopped.

After adding delayed upload diagnostics, Edge seed 193 failed at the held-upload
POST fetch with `ECONNRESET`. A simultaneous unexpected backend `GET /` raised a
TypeError reading its missing body. Repeated target runs captured the source:

```
Unexpected held-upload backend request: GET http://127.0.0.1:32167/
peer={"address":"127.0.0.1","family":"IPv4","port":64290}
ua=onepage-discovery
at tests/unit/edge/edge.test.ts:365:55
```

Another same-process repetition (run 81) captured that discovery GET followed by:

```
error: The socket connection was closed unexpectedly.
path: "http://127.0.0.1:32639/?mode=standby&mib=100"
code: "ECONNRESET"
at tests/unit/edge/edge.test.ts:372:30
```

Loopback-only binding on 127.0.0.1 did not isolate the fixture: 100 repeats yielded
298 pass / 2 fail, including private-path counter `Expected: 0; Received: 1`.
Read-only inspection of the host discovery implementation confirmed it enumerates
listeners and probes GET `/` with `onepage-discovery` on wildcard, LAN and
127.0.0.1/::1 listeners. Discovery can hit both backend and edge, adding hold
waiters as well as backend hits. Binding to 127.0.0.2 excludes these listeners
from that discovery; Linux supports this address without configuring an alias.
The original public encoded-path failure itself was not captured, but this
same extra GET also increments its exact 28-hit oracle.

The first alternative (giving backend GET `/` a 404 response) still left a held
edge waiter from discovery: target run 81 expected waiting=0, received=1. That
alternative was removed. No request filtering or counter exemptions remain.

Separately, delaying a 4 MiB upload by 200 ms reproduced the budget test's fixed
100 ms sleep race: waiting=1 does not prove the prefix reserved 4 MiB. Its 6 MiB
"overflow" can be accepted before that reservation, making the test wait for the
hold deadline. Earlier historical logs also show an assertion failure followed
by teardown-generated unhandled ECONNRESET from an unobserved pending upload.
That historical sample predates the reviewed SHA; it is supporting evidence.

## Change and acceptance boundaries

All real Edge/Bun/TCP fixture endpoints and subprocesses share a Linux-only
127.0.0.2 address (other platforms retain 127.0.0.1). Only that address is added
to NO_PROXY/no_proxy. Production proxy/routing code is unchanged.

The child reports actual waiting-body bytes. The test reserves the complete
4 MiB delayed prefix before a 6 MiB overflow, still requires 503 + Retry-After,
zero rejected upload bytes at the backend, 200 with exactly 4 MiB on admission,
and a released reservation. Pending uploads are aborted/awaited on assertion
cleanup; non-AbortError failures still propagate. The 128 MiB/413 body limit,
8 MiB global budget, 40 MiB held RSS ceiling and 80 MiB streaming ceiling remain.

Public paths/query are asserted against their original encoded strings for
HTTP and Upgrade, with case labels; exactly 28 backend hits remain required.
Every nested private test path still requires 404 and zero backend hits.

## Final verification

Final command logs are attached with this report.

- `bun run test tests/unit/edge --randomize --seed <190..199>`: 34 pass / 0 fail per seed (340 tests total).
- `bun run test tests/unit/edge -t 'bounds held uploads|preserves public encoded|nested encoded private' --rerun-each 100`: 300 pass / 0 fail / no errors; 105.11 s. Maximum held-upload RSS growth 32,612,352 bytes (<40 MiB).
- Mixed 7-file run (Edge, CLI fetch replacement, updater, slot unit and real slot lifecycle/deadline integration), seed 193: 120 pass / 3 skip / 0 fail; 112.43 s. PostgreSQL cases skipped because no test URL was configured.
- `bunx tsc --noEmit`, `npm run docs:test`, `npm run docs:check`: typecheck exit 0; docs 13 pass / 0 fail; development context validation passed.
 The repeated Edge and mixed
runs include real HTTP/SSE/WS handovers, 100 MiB streaming, the large-frame slow
reader cases and stalled closure. They do not establish deployed behavior,
non-Linux discovery isolation or PostgreSQL acceptance. Full backend coverage
remains unverified; only the repeated Edge suite and selected combinations are
used for this issue's stability evidence.
