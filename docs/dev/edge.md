---
title: Edge L7 proxy
status: active
summary: Independent Bun edge listener, slot control and verification.
---

# Edge L7 proxy

[Edge](../../packages/edge/src/index.ts) owns a long-lived HTTP listener and routes each
request to a round-robin `live` backend. It does not start slots or modify deployment
routing. Supervisor integration and trusted proxy configuration belong to MUL-102 A4.

Run with Bun 1.3.14:

```bash
EDGE_BACKENDS='[{"id":"slot-a","url":"http://127.0.0.1:6120","state":"live"}]' \
EDGE_CONTROL_SOCKET=/tmp/remi-edge.sock bun apps/edge/main.ts
```

`EDGE_HOST` defaults to `127.0.0.1` for both the process entry and library
(set it explicitly for a public listener), `EDGE_PORT` to 16120, `EDGE_HOLD_MAX_MS` to 60000 and `EDGE_MAX_WAITING`
to 4096. No TLS or third-party runtime dependency is added.

For embedding, import `startEdge` or `Edge` from
`packages/edge/src/index.ts`. Pass `backends`, `hostname`, `port`, `controlSocket`,
`holdMaxMs`, `maxWaiting`, `healthIntervalMs` (1000), `healthTimeoutMs` (1000),
`failureThreshold` (3), `riseThreshold` (2), `responseHeaderTimeoutMs` (30000),
`wsMaxMessageBytes` (4 MiB), `wsQueueLimit` (64 MiB upstream queue ceiling), `wsBufferLimit` (1 MiB downstream high-water mark),
and an optional `log`. Port and positive numeric limits are validated before listening.
The HTTP listener has a 120-second idle timeout.
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
`/internal` and `/internal/*` return 404. Forwarding headers are overwritten from
the accepted client connection; `Forwarded` is removed. The API must explicitly
trust the edge's IP before using `X-Real-IP` for rate limiting.

HTTP uses streaming body transfer, chunk decoding, bounded header parsing and
response backpressure. Bodyless requests reuse fully framed HTTP/1.1 connections
with Content-Length when the upstream allows keep-alive (up to 8 idle connections
per origin, expired after 1 second). Uploads, chunked and EOF-delimited responses
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
or health penalties. Message size is limited separately from backpressure:
2–4 MiB messages are accepted by default. Downstream backpressure pauses upstream
TCP reads and resumes on the client drain event; upstream writes resume on TCP
drain, without per-relay polling or disconnecting at the high-water mark.
Bun ServerWebSocket exposes no input pause API: a client that produces faster
than its upstream consumes accumulates an outgoing write queue. A separate
`wsQueueLimit` hard safety ceiling closes with 1013 on sustained upstream overload;
normal backpressure and valid 4 MiB frames do not hit this ceiling.
Messages exceeding `wsMaxMessageBytes` close with 1013. Application close codes/reasons pass through; reserved transport
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
control and 100 MiB streaming with RSS sampling in an isolated edge subprocess. These tests are local transport
evidence; they do not establish behavior for a deployed supervisor/Compose stack.
