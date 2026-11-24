---
title: Edge L7 proxy
status: active
summary: Independent Bun edge listener, slot control and verification.
---

# Edge L7 proxy

[Edge](../../packages/edge/src/index.ts) owns a long-lived HTTP listener and routes each
request to a round-robin `live` backend. It does not start slots or modify deployment
routing. The internal updater supervisor embeds edge and configures trusted loopback
slots; see [dual-slot operations](../deploy/internal-slot-switch.md).

Run with Bun 1.3.14:

```bash
EDGE_BACKENDS='[{"id":"slot-a","url":"http://127.0.0.1:6120","state":"live"}]' \
EDGE_CONTROL_SOCKET=/tmp/remi-edge.sock bun apps/edge/main.ts
```

`EDGE_HOST` defaults to `127.0.0.1` for both the process entry and library
(set it explicitly for a public listener), `EDGE_PORT` to 16120, `EDGE_HOLD_MAX_MS` to 60000 and `EDGE_MAX_WAITING`
to 4096. An explicitly empty `EDGE_PORT` is rejected; `0` may be used to request an ephemeral port.
No TLS or third-party runtime dependency is added.

For embedding, import `startEdge` or `Edge` from
`packages/edge/src/index.ts`. Pass `backends`, `hostname`, `port`, `controlSocket`,
`holdMaxMs`, `maxWaiting`, `healthIntervalMs` (1000), `healthTimeoutMs` (1000),
`failureThreshold` (3), `riseThreshold` (2), `responseHeaderTimeoutMs` (30000),
`wsMaxMessageBytes` (4 MiB), `wsQueueLimit` (64 MiB upstream write queue ceiling), `wsBufferLimit` (1 MiB downstream high-water mark),
`wsStallTimeoutMs` (30000), and an optional `log`. Port and positive numeric limits are validated before listening.
The HTTP listener has a 120-second idle timeout and a 128 MiB request body limit,
matching the slot's Bun default. While awaiting admission, upload prefixes share
an 8 MiB global buffering budget (across all waiting uploads). Exhaustion cancels
the upload and returns 503 with `Retry-After: 1`; admission hands the buffered
prefix and remaining stream to the upstream. This explicitly bounds buffering
because Bun otherwise buffers unread bodies while the fetch handler awaits.
Call `stop()` to close the listener and terminate active connections. Bun 1.3.14 can
leave the promise returned by `server.stop(true)` pending after a server-initiated
WebSocket close; `Edge.stop()` therefore invokes it without exposing that promise.

`addBackend({id,url,state})`, `removeBackend(id)`, `setState(id,state)`, `hold()`,
`unhold()`, and `status()` are synchronous control operations. States are `standby`,
`live`, `draining`, `down`. Removing a backend with active HTTP/WS traffic fails;
listen for `edge.on('drained', id => …)` after setting `draining`.
Draining keeps existing streams and sockets alive and excludes new requests.
Health probes require exactly HTTP 200 from `/readyz`; recovery requires
`riseThreshold` consecutive successful probes and restores the
configured state, including standby, and never promotes it automatically.

The optional Unix socket is created under umask 0177 (mode 0600 from creation). Send UTF-8 JSON lines, each with an `op`:

```json
{"op":"addBackend","backend":{"id":"slot-b","url":"http://127.0.0.1:6121","state":"standby"}}
{"op":"hold"}
{"op":"setState","id":"slot-b","state":"live"}
{"op":"setState","id":"slot-a","state":"draining"}
{"op":"unhold"}
{"op":"status"}
{"op":"removeBackend","id":"slot-a"}
```

Each line receives `{ok:true,result:…}` or `{ok:false,error:…}`. On startup, an existing socket is probed: only a refused/missing endpoint with
an unchanged socket inode is removed. Active listeners and non-socket files are preserved. There is no public control route. Public
`/internal` and `/internal/*` return 404. Before HTTP forwarding or WebSocket
upgrade, edge checks the original pathname and each successive percent-decoded
layer, checking both the literal private prefix and its normalized form:
replace backslashes with slashes, collapse repeated slashes and resolve dot segments.
The literal check covers Hono routes where decoded dot segments remain literal. If any normalized layer has the private prefix, return 404.
Each valid `%XX` byte is decoded independently (hex digits are case insensitive);
malformed escapes remain literal and do not stop other escapes from decoding.
Changed layers strictly shorten the pathname, so decoding stops at a fixed point.
The API uses Hono's default, case-sensitive routing (`createMultiremiApp` in
[server.ts](../../packages/server/src/api/server.ts)): its tolerant `getPath`
decodes valid URI runs even beside malformed escapes, preserves reserved escapes
such as `%2F` and protects `%25` from recursive decoding. Peer routes are registered
under `/internal/peer/`, and the Bun handler separately recognizes literal
`/internal/slot/` paths before Hono. Edge checks the literal path plus every
successive byte-decoded layer before either HTTP or Upgrade admission. Thus any
path the server matches under `/internal/` is rejected with 404; edge additionally
blocks nested encodings, encoded separators and normalized dot/backslash variants.
`/INTERNAL/` remains public because the server's private prefix is case sensitive.
Public encoded names, dots, slashes and percent signs remain valid; the pathname
forwarded to the slot is unchanged by this check. Forwarding headers are overwritten from
the accepted client connection; `Forwarded` is removed. The API must explicitly
trust the edge's IP before using `X-Real-IP` for rate limiting.

HTTP uses streaming body transfer, chunk decoding, bounded header parsing and
response backpressure. Bodyless requests reuse fully framed HTTP/1.1 connections
with Content-Length when the upstream allows keep-alive (up to 8 idle connections
per origin, expired after 1 second). Only GET/HEAD/OPTIONS lease pooled sockets;
other methods connect afresh to avoid stale-connection failures on requests that
cannot safely be replayed. Uploads, chunked and EOF-delimited responses
close their upstream connections. Response headers must arrive within
`responseHeaderTimeoutMs`; the timer does not limit SSE or response body duration. Client
HTTP keep-alive is independent of slot connections. Connection failure before any
bytes are sent retries within the hold budget without consuming uploads. After
sending, only bodyless GET/HEAD/OPTIONS retry once; other failures return 502.
Response body failures after headers are delivered terminate the response stream;
they cannot be replaced by a new HTTP status or replayed. Client cancellation does not affect backend health or edge failure counters.
Successful HTTP responses and WS handshakes reset consecutive passive failures.
Upstream 5xx responses
are forwarded and counted separately from edge-generated errors.

WebSocket upstream uses a bounded RFC 6455 TCP client because Bun 1.3.14's native
client drops outbound close reasons. It validates the handshake, masks client
frames, handles ping/pong and fragmented messages, and negotiates no extensions.
WebSocket forwards cookie, authorization, query and offered subprotocols. Only a
successful upstream handshake permits client upgrade. Transport failures and invalid handshakes retry within
the hold budget. Application rejection responses (including 401/403/421/426) pass
through with their status, end-to-end headers and streaming body, without retry
or health penalties. Message size is limited separately from backpressure.
The slot's `DAEMON_WS_MAX_PAYLOAD_BYTES` and Bun `maxPayloadLength` are 4 MiB
(see [protocol constants](../../packages/contracts/src/daemon-protocol.ts) and
[server configuration](../../packages/server/src/api/server.ts)). Edge's default
4 MiB message limit covers that slot limit in both directions, including continuous
64 × 4 MiB downstream messages. Downstream backpressure pauses upstream TCP reads when `getBufferedAmount()` reaches the high-water mark. A queued
`send()` result of -1 is accepted, not replayed. Client drain schedules recovery
on a subsequent event-loop turn: resuming synchronously (or in a microtask) inside
Bun 1.3.14's native writable callback can lose writable-event registration after
a partial large-frame write. A 25 ms timer fallback runs only while congested
because Bun may also miss drain notifications. The upstream TCP connection uses
Node's built-in stream adapter (provided by Bun), so pause suspends application
`data` delivery even for chunks delivered in the current native read turn. This
avoids repeatedly concatenating an unread buffer and starving downstream I/O and
timers. Close/stop cancels that timer. Upstream writes resume on TCP drain;
reaching the downstream high-water mark pauses the relay. If buffered bytes make
no progress for `wsStallTimeoutMs`, edge closes both sides with 1013
(`Downstream stalled`) and terminates the downstream socket after 100 ms, so a
non-reading client cannot retain a relay indefinitely. Buffer decreases reset the
progress deadline. A peer that refuses all reads may observe transport closure
instead of receiving the queued 1013 frame before forced teardown.
Bun ServerWebSocket exposes no input pause API: a client that produces faster
than its upstream consumes accumulates an outgoing write queue. A separate
`wsQueueLimit` hard safety ceiling closes with 1013 on sustained upstream overload;
normal backpressure and valid 4 MiB frames do not hit this ceiling.
Messages exceeding `wsMaxMessageBytes` close with 1013. Application close codes/reasons pass through, including a close immediately after
the upstream 101 handshake (without retry or health penalty); reserved transport
codes 1006/1015 map to 1011 because they cannot be sent in a close frame.

`status()` exposes per-backend attempts, active HTTP, active/total WebSockets,
consecutive health failures, upstream errors, edge-generated 502/503/504 counters,
held-request counts, total hold time and cumulative duration buckets (milliseconds).
Cumulative request, upstream-error and WS relay totals survive backend removal.
State changes log with `edge:`. Status has no user-facing API/CLI route: the local
Unix protocol and process API are the supervisor/operations interface.

Run the real local fake-backend regression and acceptance checks with:

```bash
bun run test tests/unit/edge/edge.test.ts
bunx tsc --noEmit
npm run docs:test
npm run docs:check
```

The suite includes 20 handovers under concurrent HTTP/SSE/WS, hold limits, handshake
recovery, close codes, forwarding headers, private paths, health/draining, Unix
control, 64 × 4 MiB, 64 × 1 MiB and 192 × 512 KiB messages to a slow TCP reader
with per-frame content checks, bounded closure for a stalled reader and cleared
congestion timers (all using a real Bun backend and isolated edge process), and 100 MiB streaming with
RSS sampling in an isolated edge subprocess. The memory source yields every MiB
to let native I/O progress; upload and download share one peak and the unchanged
80 MiB growth ceiling, with no GC during measurement. These tests are local transport
evidence; they do not establish behavior for a deployed supervisor/Compose stack.

Transport fixtures bind explicitly to loopback (`127.0.0.2` on Linux,
`127.0.0.1` elsewhere); this does not isolate them from host port scanners.
The helper adds only this local address to the HTTP proxy bypass. Counting
backends identify their test's requests with a random nonce header, including
HTTP and Upgrade traffic, without changing the encoded paths. Raw TCP fixtures
identify complete request headers and count only connections carrying that nonce.
The hold child observes the real acquire lifecycle in request context and reports
the matching waiters separately from total waiters; unrelated requests still
traverse the real Edge. Explicit untagged probes exercise these boundaries.
Held-upload tests wait for the real child process's 4 MiB byte reservation before
sending the 6 MiB overflow, and include delayed body delivery. Assertion cleanup
aborts and awaits the pending upload; unexpected transport errors remain failures.
