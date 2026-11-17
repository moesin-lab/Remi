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

`EDGE_HOST` defaults to `0.0.0.0` for the process entry (the library defaults to
loopback), `EDGE_PORT` to 16120, `EDGE_HOLD_MAX_MS` to 60000 and `EDGE_MAX_WAITING`
to 4096. No TLS or third-party runtime dependency is added.

For embedding, import `startEdge` or `Edge` from
`packages/edge/src/index.ts`. Pass `backends`, `hostname`, `port`, `controlSocket`,
`holdMaxMs`, `maxWaiting`, `healthIntervalMs` (1000), `healthTimeoutMs` (1000),
`failureThreshold` (3), `wsBufferLimit` (1 MiB per direction), and an optional `log`.
Call `stop()` to close the listener and terminate active connections. Bun 1.3.14 can
leave the promise returned by `server.stop(true)` pending after a server-initiated
WebSocket close; `Edge.stop()` therefore invokes it without exposing that promise.

`addBackend({id,url,state})`, `removeBackend(id)`, `setState(id,state)`, `hold()`,
`unhold()`, and `status()` are synchronous control operations. States are `standby`,
`live`, `draining`, `down`. Removing a backend with active HTTP/WS traffic fails;
listen for `edge.on('drained', id => …)` after setting `draining`.
Draining keeps existing streams and sockets alive and excludes new requests.
Health probes require exactly HTTP 200 from `/readyz`; recovery restores the
configured state, including standby, and never promotes it automatically.

The optional Unix socket is mode 0600. Send UTF-8 JSON lines, each with an `op`:

```json
{"op":"addBackend","backend":{"id":"slot-b","url":"http://127.0.0.1:6121","state":"standby"}}
{"op":"hold"}
{"op":"setState","id":"slot-b","state":"live"}
{"op":"setState","id":"slot-a","state":"draining"}
{"op":"unhold"}
{"op":"status"}
{"op":"removeBackend","id":"slot-a"}
```

Each line receives `{ok:true,result:…}` or `{ok:false,error:…}`. An existing socket
path is never unlinked on startup. There is no public control route. Public
`/internal` and `/internal/*` return 404. Forwarding headers are overwritten from
the accepted client connection; `Forwarded` is removed. The API must explicitly
trust the edge's IP before using `X-Real-IP` for rate limiting.

HTTP uses a dedicated upstream TCP connection per request, with streaming body
transfer, chunk decoding, bounded header parsing and response backpressure. Client
HTTP keep-alive is independent of slot connections. Connection failure before any
bytes are sent retries within the hold budget without consuming uploads. After
sending, only bodyless GET/HEAD/OPTIONS retry once; other failures return 502.
Response body failures after headers are delivered terminate the response stream;
they cannot be replaced by a new HTTP status or replayed. Upstream 5xx responses
are forwarded and counted separately from edge-generated errors.

WebSocket upstream uses a bounded RFC 6455 TCP client because Bun 1.3.14's native
client drops outbound close reasons. It validates the handshake, masks client
frames, handles ping/pong and fragmented messages, and negotiates no extensions.
WebSocket forwards cookie, authorization, query and offered subprotocols. Only a
successful upstream handshake permits client upgrade. Failed handshakes retry in
the hold budget. Both relay directions use bounded buffers; exceeding the limit
closes with 1013. Application close codes/reasons pass through; reserved transport
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
