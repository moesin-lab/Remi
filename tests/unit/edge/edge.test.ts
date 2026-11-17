import { afterEach, expect, test } from 'bun:test';
import { UpstreamSocket } from '../../../packages/edge/src/websocket';
import { Hono } from 'hono';
import { Edge } from '../../../packages/edge/src/index';
import { connect } from 'node:net';
import { statSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const stop of cleanups.splice(0).reverse()) await stop(); });
function backend(handler: (req: Request) => Response | Promise<Response> = () => new Response('ok')) {
  const server = Bun.serve({ port: 0, fetch: handler }); cleanups.push(() => server.stop(true)); return server;
}
function edge(options: ConstructorParameters<typeof Edge>[0] = {}) {
  const e = new Edge({ port: 0, log: () => {}, healthIntervalMs: 100000, holdMaxMs: 300, ...options }); cleanups.push(() => e.stop()); return e;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(predicate: () => boolean) { for (let i = 0; i < 200; i++) { if (predicate()) return; await sleep(5); } throw new Error('Timed out'); }
function wsBackend() {
  const s = Bun.serve({ port: 0, fetch(req, server) {
    if (req.headers.get('upgrade')) {
      if (new URL(req.url).searchParams.has('fail')) return new Response('no', { status: 503 });
      if (server.upgrade(req)) return;
    }
    return new Response('ok');
  }, websocket: { message(ws, message) {
    const text = message.toString(); if (text.startsWith('close:')) ws.close(Number(text.slice(6)), 'restart'); else ws.send(message);
  } } }); cleanups.push(() => { void s.stop(true); }); return s;
}
function open(url: string) { return new Promise<WebSocket>((resolve, reject) => { const ws = new WebSocket(url); ws.onopen = () => resolve(ws); ws.onerror = reject; }); }
function echo(ws: WebSocket, data: string) { return new Promise<string>((resolve, reject) => { ws.onmessage = e => resolve(e.data); ws.onerror = reject; ws.send(data); }); }

test('round robin, stripped hop headers, authoritative IP and private routes', async () => {
  const a = backend(req => Response.json(Object.fromEntries(req.headers), { headers: { connection: 'x-secret', 'x-secret': 'hidden' } }));
  const b = backend(() => new Response('second'));
  const e = edge({ backends: [{ id: 'a', url: a.url.href, state: 'live' }, { id: 'b', url: b.url.href, state: 'live' }] });
  const response = await fetch(e.server.url, { headers: { 'x-real-ip': 'fake', 'x-forwarded-for': 'fake', 'x-forwarded-proto': 'https', forwarded: 'fake', connection: 'x-remove', 'x-remove': 'secret' } });
  const headers = await response.json(); expect(headers['x-real-ip']).not.toBe('fake'); expect(headers['x-forwarded-for']).toBe(headers['x-real-ip']); expect(headers['x-forwarded-proto']).toBe('http'); expect(headers.forwarded).toBeUndefined(); expect(headers['x-remove']).toBeUndefined(); expect(response.headers.get('x-secret')).toBeNull();
  expect(await (await fetch(e.server.url)).text()).toBe('second');
  for (const path of ['/internal/test', '/internal', '/%69nternal/test', '//internal/test', '/foo/%2e%2e%2finternal/test']) expect((await fetch(e.server.url.href.replace(/\/$/, '') + path)).status).toBe(404);
});

test('hold release, bounded queue, deadline and disconnected waiter cleanup', async () => {
  const b = backend(); const e = edge({ maxWaiting: 1, holdMaxMs: 80 });
  const pending = fetch(e.server.url); await until(() => e.status().waiting === 1);
  const overflow = await fetch(e.server.url); expect(overflow.status).toBe(503); expect(overflow.headers.get('retry-after')).toBe('1');
  e.addBackend({ id: 'b', url: b.url.href, state: 'live' }); expect(await (await pending).text()).toBe('ok');
  e.hold(); const timeout = await fetch(e.server.url); expect(timeout.status).toBe(503); expect(e.status().waiting).toBe(0); e.unhold();
  expect((await fetch(e.server.url)).status).toBe(200); expect(e.status().metrics.holds).toBe(2);
});

test('connection refused retries POST without consuming upload', async () => {
  const dead = backend(); const url = dead.url.href; await dead.stop(true);
  const good = backend(async req => new Response(await req.text()));
  const e = edge({ backends: [{ id: 'dead', url, state: 'live' }, { id: 'good', url: good.url.href, state: 'live' }] });
  const res = await fetch(e.server.url, { method: 'POST', body: 'once-only' }); expect(res.status).toBe(200); expect(await res.text()).toBe('once-only'); expect(e.status().backends[0].failures).toBe(1);
});

test('health restores standby and draining without promotion; drained waits for body', async () => {
  let healthy = false; let end!: () => void;
  const b = backend(req => new URL(req.url).pathname === '/readyz' ? new Response('', { status: healthy ? 200 : 503 }) : new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('start')); end = () => c.close(); } })));
  const e = edge({ healthIntervalMs: 15, failureThreshold: 2, backends: [{ id: 'b', url: b.url.href, state: 'standby' }] });
  await until(() => e.status().backends[0].state === 'down'); healthy = true; await until(() => e.status().backends[0].state === 'standby');
  e.setState('b', 'live'); const response = await fetch(e.server.url); const body = response.text();
  const drained: string[] = []; e.on('drained', id => drained.push(id)); e.setState('b', 'draining'); expect(drained).toEqual([]); expect(() => e.removeBackend('b')).toThrow();
  end(); await body; await until(() => drained.length === 1); e.removeBackend('b');
});

test('WS handshake hold recovers and close codes pass in both directions', async () => {
  const b = wsBackend(); const unavailable = backend(); const deadUrl = unavailable.url.href; await unavailable.stop(true);
  const e = edge({ holdMaxMs: 2000, backends: [{ id: 'bad', url: deadUrl, state: 'live' }, { id: 'good', url: b.url.href, state: 'standby' }] });
  const pending = open(e.server.url.href.replace('http:', 'ws:')); await sleep(60); e.setState('good', 'live');
  const ws = await pending; expect(await echo(ws, 'hello')).toBe('hello');
  e.setState('good', 'draining'); expect(e.status().backends[1].websockets).toBe(1);
  const closed = new Promise<CloseEvent>(resolve => ws.onclose = resolve); ws.send('close:4001'); const event = await closed; expect(event.code).toBe(4001); expect(event.reason).toBe('restart');
  await until(() => e.status().backends[1].websockets === 0);
  e.setState('good', 'live'); const ws2 = await open(e.server.url.href.replace('http:', 'ws:')); const closed2 = new Promise<CloseEvent>(resolve => ws2.onclose = resolve); ws2.send('close:1012'); expect((await closed2).code).toBe(1012);
});

test('Unix JSON lines control is private and mode 0600', async () => {
  const path = `/tmp/remi-edge-${crypto.randomUUID()}.sock`; const e = edge({ controlSocket: path }); expect(statSync(path).mode & 0o777).toBe(0o600);
  const results = await new Promise<any[]>(resolve => { const socket = connect(path); let buffer = ''; socket.on('connect', () => socket.write('{"op":"hold"}\n{"op":"status"}\n')); socket.on('data', data => { buffer += data; const lines = buffer.trim().split('\n'); if (lines.length === 2) { socket.end(); resolve(lines.map(l => JSON.parse(l))); } }); });
  expect(results[1].result.held).toBe(true); expect((await fetch(new URL('/internal/status', e.server.url))).status).toBe(404);
});

test('20 live handovers under concurrent HTTP, SSE and WS have zero failures', async () => {
  const e = edge({ holdMaxMs: 2000 });
  const make = (id: string) => {
    const s = Bun.serve({ port: 0, fetch(req, server) {
      if (req.headers.get('upgrade') && server.upgrade(req)) return;
      if (new URL(req.url).pathname === '/sse') return new Response(new ReadableStream({ async start(c) { c.enqueue(new TextEncoder().encode('data: start\n\n')); await sleep(10); c.enqueue(new TextEncoder().encode('data: end\n\n')); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
      return new Response(id);
    }, websocket: { message(ws, data) { ws.send(data); } } }); cleanups.push(() => s.stop(true)); e.addBackend({ id, url: s.url.href, state: 'standby' }); return s;
  };
  make('0'); e.setState('0', 'live'); let running = true; let failures = 0; let requests = 0;
  const workers = Array.from({ length: 4 }, (_, i) => (async () => { while (running) { try { const r = await fetch(new URL(i % 2 ? '/sse' : '/', e.server.url)); if (r.status !== 200) failures++; await r.text(); requests++; } catch { failures++; } } })());
  for (let i = 1; i <= 20; i++) {
    const ws = await open(e.server.url.href.replace('http:', 'ws:')); expect(await echo(ws, `before-${i}`)).toBe(`before-${i}`);
    e.hold(); make(String(i)); e.setState(String(i), 'live'); e.setState(String(i - 1), 'draining'); e.unhold();
    expect(await echo(ws, `after-${i}`)).toBe(`after-${i}`); ws.close(1000);
    await until(() => { const s = e.status().backends.find(b => b.id === String(i - 1))!; return s.inFlight === 0 && s.websockets === 0; }); e.removeBackend(String(i - 1));
  }
  running = false; await Promise.all(workers); expect(requests).toBeGreaterThan(20); expect(failures).toBe(0); expect(e.status().metrics.errors).toEqual({ '502': 0, '503': 0, '504': 0 });
}, 15000);

test('100 MiB upload/download stream with bounded RSS growth', async () => {
  const total = 100 * 1024 * 1024; const chunk = new Uint8Array(64 * 1024).fill(97);
  const generate = () => { let bytes = 0; return new ReadableStream<Uint8Array>({ async pull(c) {
    // Bound the synthetic producer's uninterrupted work and let native I/O
    // progress every MiB, keeping the original RSS ceiling and measured peak.
    if (bytes && bytes % (1024 * 1024) === 0) await sleep(1);
    if (bytes === total) c.close(); else { c.enqueue(chunk); bytes += chunk.length; }
  } }); };
  const b = backend(async req => {
    if (new URL(req.url).pathname === '/warmup') return new Response('ok');
    if (req.method === 'POST') { let bytes = 0; for await (const part of req.body!) bytes += part.length; return new Response(String(bytes)); }
    return new Response(generate());
  });
  let receive: ((data: {baseline: number; peak?: number}) => void) | undefined;
  const child = Bun.spawn([process.execPath, 'tests/helpers/edge/memory-process.ts', b.url.href], {
    stdout: 'pipe', stderr: 'inherit', ipc(data) { receive?.(data as { baseline: number; peak?: number }); },
  });
  cleanups.push(async () => { child.send('stop'); await child.exited; });
  const reader = child.stdout.getReader(); const line = await reader.read(); const url = new TextDecoder().decode(line.value).trim(); reader.releaseLock();
  const query = (message: string) => new Promise<{ baseline: number; peak?: number }>(resolve => { receive = resolve; child.send(message); });
  await fetch(new URL('/warmup', url)).then(r => r.text()); await query('start');
  const upload = await fetch(url, { method: 'POST', body: generate() }); expect(await upload.text()).toBe(String(total)); const uploadMemory = await query('sample');
  const download = await fetch(url); let bytes = 0; for await (const part of download.body!) bytes += part.length; expect(bytes).toBe(total);
  const { baseline, peak } = await query('report');
  console.log(`100MiB isolated edge: RSS baseline=${baseline}, upload peak=${uploadMemory.peak}, peak=${peak}, growth=${peak! - baseline}`);
  expect(peak! - baseline).toBeLessThan(80 * 1024 * 1024);
}, 20000);

test('client abort removes hold waiter', async () => {
  const e = edge({ holdMaxMs: 2000 }); const controller = new AbortController();
  const pending = fetch(e.server.url, { signal: controller.signal }).catch(() => null);
  await until(() => e.status().waiting === 1); controller.abort(); await pending; await until(() => e.status().waiting === 0);
});

test('sent GET retries once, sent POST never replays', async () => {
  let attempts = 0;
  const raw = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data(socket) { attempts++; if (attempts % 2) socket.end(); else socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok'); } } });
  cleanups.push(() => raw.stop(true));
  const e = edge({ backends: [{ id: 'raw', url: `http://127.0.0.1:${raw.port}`, state: 'live' }] });
  const response = await fetch(e.server.url); expect(response.status).toBe(200); expect(await response.text()).toBe('ok'); expect(attempts).toBe(2);
  expect((await fetch(e.server.url, { method: 'POST', body: 'do not replay' })).status).toBe(502); expect(attempts).toBe(3);
});

test('WS forwards auth, cookies, query, protocol and client close', async () => {
  let receivedHeaders: Headers | undefined; let receivedUrl = ''; let closeCode = 0; let closeReason = '';
  const b = Bun.serve({ port: 0, fetch(req, server) {
    receivedHeaders = req.headers; receivedUrl = req.url;
    if (server.upgrade(req, { headers: { 'sec-websocket-protocol': 'edge-test' } })) return;
    return new Response('no', { status: 400 });
  }, websocket: { message(ws, message) { ws.send(message); }, close(_ws, code, reason) { closeCode = code; closeReason = reason; } } });
  cleanups.push(() => { void b.stop(true); });
  const e = edge({ backends: [{ id: 'b', url: b.url.href, state: 'live' }] });
  const ws = await new Promise<UpstreamSocket>((resolve, reject) => { const ws = new UpstreamSocket(new URL(e.server.url.href.replace('http:', 'ws:') + '?token=abc'), { protocols: ['edge-test'], headers: { cookie: 'session=x', authorization: 'Bearer x' }, limit: 1048576 }); ws.onopen = () => resolve(ws); ws.onerror = reject; });
  expect(ws.protocol).toBe('edge-test'); expect(receivedHeaders!.get('cookie')).toBe('session=x'); expect(receivedHeaders!.get('authorization')).toBe('Bearer x'); expect(receivedUrl).toContain('?token=abc');
  ws.close(4001, 'client done'); await until(() => closeCode !== 0); expect(closeCode).toBe(4001); expect(closeReason).toBe('client done');
});

test('HTTP informational headers, fragmented chunk framing and EOF failures', async () => {
  let truncated = false;
  const raw = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data(socket) {
    if (truncated) { socket.end('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort'); return; }
    socket.write('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3;ext=yes\r\na');
    setTimeout(() => { socket.write('bc\r'); setTimeout(() => socket.end('\n2\r\nde\r\n0\r\n\r\n'), 5); }, 5);
  } } }); cleanups.push(() => raw.stop(true));
  const e = edge({ backends: [{ id: 'raw', url: `http://127.0.0.1:${raw.port}`, state: 'live' }] });
  expect(await (await fetch(e.server.url)).text()).toBe('abcde');
  truncated = true;
  // Bun's fetch tolerates EOF before Content-Length; verify it cannot invent
  // bytes and that edge records the upstream failure after headers were sent.
  const response = await fetch(e.server.url); const text = await response.text().catch(() => '');
  expect(text.length).toBeLessThan(10);
  await until(() => e.status().backends[0].inFlight === 0); expect(e.status().backends[0].upstreamErrors).toBeGreaterThan(0);
});

test('WS binary relay and oversized frame closes with backpressure code', async () => {
  const b = wsBackend(); const e = edge({ wsMaxMessageBytes: 65536, backends: [{ id: 'b', url: b.url.href, state: 'live' }] });
  const ws = await open(e.server.url.href.replace('http:', 'ws:')); ws.binaryType = 'arraybuffer';
  const received = new Promise<ArrayBuffer>(resolve => ws.onmessage = event => resolve(event.data)); ws.send(new Uint8Array([0, 1, 255])); expect([...new Uint8Array(await received)]).toEqual([0, 1, 255]);
  const closed = new Promise<CloseEvent>(resolve => ws.onclose = resolve); ws.send(new Uint8Array(128 * 1024)); expect((await closed).code).toBe(1013);
});

test('cumulative counters survive backend removal and stop cancels upstream HTTP', async () => {
  const b = backend(() => new Response('upstream error', { status: 500 }));
  const e = edge({ backends: [{ id: 'b', url: b.url.href, state: 'live' }] });
  expect((await fetch(e.server.url)).status).toBe(500);
  await until(() => e.status().backends[0].inFlight === 0);
  e.removeBackend('b');
  expect(e.status().metrics.requests).toBe(1);
  expect(e.status().metrics.upstreamErrors).toBe(1);
  let disconnected = false;
  const raw = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: {
    data(socket) { socket.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n'); },
    close() { disconnected = true; },
  } });
  cleanups.push(() => raw.stop(true));
  e.addBackend({ id: 'stream', url: `http://127.0.0.1:${raw.port}`, state: 'live' });
  const response = await fetch(e.server.url);
  const body = response.text().catch(() => '');
  e.stop(); await until(() => disconnected); await body;
  expect(e.status().backends[0].inFlight).toBe(0);
});

test('WS application rejection preserves status, headers and body without retries or health failures', async () => {
  let attempts = 0;
  const b = backend(req => {
    attempts++;
    const status = Number(new URL(req.url).pathname.slice(1));
    return new Response(`rejected:${status}`, { status, headers: { 'www-authenticate': 'Bearer', 'x-rejection': String(status) } });
  });
  const e = edge({ holdMaxMs: 1000, failureThreshold: 1, backends: [{ id: 'b', url: b.url.href, state: 'live' }] });
  for (const status of [401, 403, 426, 421, 503]) {
    const response = await fetch(new URL(`/${status}`, e.server.url), { headers: { connection: 'Upgrade', upgrade: 'websocket' } });
    expect(response.status).toBe(status);
    expect(await response.text()).toBe(`rejected:${status}`);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(response.headers.get('x-rejection')).toBe(String(status));
  }
  expect(attempts).toBe(5); expect(e.status().backends[0].state).toBe('live');
  expect(e.status().backends[0].failures).toBe(0); expect(e.status().metrics.upstreamErrors).toBe(0);
});

test('server contract permits 2 and 4 MiB frames in both relay directions', async () => {
  const b = Bun.serve({ port: 0, fetch(req, server) { if (server.upgrade(req)) return; return new Response('no'); },
    websocket: { maxPayloadLength: 4 * 1024 * 1024, closeOnBackpressureLimit: false,
      message(ws, data) { ws.send(data); } },
  });
  cleanups.push(() => { void b.stop(true); });
  const e = edge({ backends: [{ id: 'b', url: b.url.href, state: 'live' }] });
  const ws = await open(e.server.url.href.replace('http:', 'ws:')); ws.binaryType = 'arraybuffer';
  for (const size of [2, 4]) {
    const payload = new Uint8Array(size * 1024 * 1024).fill(size);
    const received = new Promise<ArrayBuffer>((resolve, reject) => { ws.onmessage = event => resolve(event.data); ws.onclose = () => reject(new Error('Unexpected close')); });
    ws.send(payload); const result = new Uint8Array(await received);
    expect(result.byteLength).toBe(payload.byteLength); expect(result.every(v => v === size)).toBe(true);
  }
  ws.onclose = null; ws.close(); expect(e.status().metrics.upstreamErrors).toBe(0);
});

test('client aborts before HTTP headers and during WS handshake do not affect backend health', async () => {
  let attempts = 0;
  const raw = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() { attempts++; } } });
  cleanups.push(() => raw.stop(true));
  const e = edge({ holdMaxMs: 1000, healthTimeoutMs: 1000, backends: [{ id: 'b', url: `http://127.0.0.1:${raw.port}`, state: 'live' }] });
  for (const upgrade of [false, true]) for (let i = 0; i < 3; i++) {
    const before = attempts; const controller = new AbortController();
    const pending = fetch(e.server.url, { signal: controller.signal, headers: upgrade ? { connection: 'Upgrade', upgrade: 'websocket' } : {} }).catch(() => null);
    await until(() => attempts > before); controller.abort(); await pending;
    await until(() => e.status().backends[0].inFlight === 0);
  }
  expect(attempts).toBe(6); expect(e.status().backends[0].state).toBe('live');
  expect(e.status().backends[0].failures).toBe(0); expect(e.status().metrics.upstreamErrors).toBe(0);
});

test('successful HTTP resets consecutive passive failures and header timeout is bounded', async () => {
  let fail = true;
  const raw = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data(socket) {
    if (fail) socket.end(); else socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
  } } });
  cleanups.push(() => raw.stop(true));
  const e = edge({ backends: [{ id: 'b', url: `http://127.0.0.1:${raw.port}`, state: 'live' }] });
  expect((await fetch(e.server.url, { method: 'POST', body: 'x' })).status).toBe(502);
  expect(e.status().backends[0].failures).toBe(1); fail = false;
  expect(await (await fetch(e.server.url)).text()).toBe('ok'); expect(e.status().backends[0].failures).toBe(0);
  const silent = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  cleanups.push(() => silent.stop(true));
  const timed = edge({ responseHeaderTimeoutMs: 30, backends: [{ id: 'b', url: `http://127.0.0.1:${silent.port}`, state: 'live' }] });
  expect((await fetch(timed.server.url, { method: 'POST', body: 'x' })).status).toBe(502);
});

test('validates listener port and health interval before starting', () => {
  for (const port of [NaN, -1, 65536, 1.5]) expect(() => edge({ port })).toThrow('Invalid port');
  for (const healthIntervalMs of [0, -1, NaN, Infinity]) expect(() => edge({ healthIntervalMs })).toThrow('Invalid healthIntervalMs');
  for (const wsStallTimeoutMs of [0, -1, NaN, Infinity]) expect(() => edge({ wsStallTimeoutMs })).toThrow('Invalid wsStallTimeoutMs');
});

test('control socket restarts after SIGKILL but never replaces an active listener or file', async () => {
  const path = `/tmp/remi-edge-${crypto.randomUUID()}.sock`;
  const child = Bun.spawn([process.execPath, '-e', `import {Edge} from './packages/edge/src/index'; new Edge({port:0, controlSocket:process.argv[1]}); console.log('ready');`, path], { stdout: 'pipe', stderr: 'inherit' });
  const reader = child.stdout.getReader(); await reader.read(); reader.releaseLock();
  child.kill('SIGKILL'); await child.exited;
  const e = edge({ controlSocket: path }); expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(() => edge({ controlSocket: path })).toThrow('active');
  e.hold(); expect(e.status().held).toBe(true);
  const file = path + '.txt'; writeFileSync(file, 'preserve'); cleanups.push(() => unlinkSync(file));
  expect(() => edge({ controlSocket: file })).toThrow('not a socket'); expect(readFileSync(file, 'utf8')).toBe('preserve');
});

test('HTTP keep-alive reuses a fully framed upstream connection', async () => {
  let connections = 0; let requests = 0;
  const raw = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: {
    open() { connections++; },
    data(socket, bytes) { requests++; expect(bytes.toString().toLowerCase()).toContain('connection: keep-alive'); socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'); },
  } });
  cleanups.push(() => raw.stop(true));
  const e = edge({ backends: [{ id: 'b', url: `http://127.0.0.1:${raw.port}`, state: 'live' }] });
  for (let i = 0; i < 5; i++) expect(await (await fetch(e.server.url)).text()).toBe('ok');
  expect(requests).toBe(5); expect(connections).toBe(1);
});

test('health recovery needs consecutive rise probes and a failure resets the rise count', async () => {
  let healthy = false;
  const b = backend(() => new Response('', { status: healthy ? 200 : 503 }));
  const e = edge({ failureThreshold: 1, riseThreshold: 2, backends: [{ id: 'b', url: b.url.href, state: 'standby' }] });
  // Invoke the real probe deterministically instead of racing the interval.
  const probe = () => (e as unknown as { probe(): Promise<void> }).probe();
  await probe(); expect(e.status().backends[0].state).toBe('down');
  healthy = true; await probe(); expect(e.status().backends[0].state).toBe('down');
  healthy = false; await probe(); healthy = true; await probe(); expect(e.status().backends[0].state).toBe('down');
  await probe(); expect(e.status().backends[0].state).toBe('standby');
});

test('WS slow downstream resumes via drain without disconnecting or losing messages', async () => {
  const count = 20; const size = 2 * 1024 * 1024;
  const b = Bun.serve({ port: 0, fetch(req, server) { if (server.upgrade(req)) return; return new Response('no'); }, websocket: {
    maxPayloadLength: 4 * 1024 * 1024, backpressureLimit: 64 * 1024 * 1024, closeOnBackpressureLimit: false,
    message(ws) { for (let i = 0; i < count; i++) ws.send(new Uint8Array(size).fill(i)); },
  } });
  cleanups.push(() => { void b.stop(true); });
  const e = edge({ wsBufferLimit: 65536, backends: [{ id: 'b', url: b.url.href, state: 'live' }] });
  await new Promise<void>((resolve, reject) => {
    const ws = new UpstreamSocket(new URL(e.server.url.href.replace('http:', 'ws:')), { headers: {}, protocols: [], limit: 4 * 1024 * 1024 });
    cleanups.push(() => ws.terminate());
    let received = 0;
    ws.onopen = () => { ws.pause(); ws.send('start'); setTimeout(() => ws.resume(), 100); };
    ws.onmessage = event => {
      const data = new Uint8Array(event.data as ArrayBuffer);
      expect(data.byteLength).toBe(size); expect(data[0]).toBe(received++);
      if (received === count) { ws.onclose = undefined; ws.close(); resolve(); }
    };
    ws.onerror = () => reject(new Error('Relay error')); ws.onclose = () => reject(new Error('Relay closed under backpressure'));
  });
});

test('rejected upgrade body streams and remains in flight until drained', async () => {
  let end!: () => void;
  const b = backend(() => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('protocol:')); end = () => { controller.enqueue(new TextEncoder().encode('upgrade required')); controller.close(); };
  } }), { status: 426, headers: { 'content-type': 'text/plain' } }));
  const e = edge({ backends: [{ id: 'b', url: b.url.href, state: 'live' }] });
  const response = await fetch(e.server.url, { headers: { connection: 'Upgrade', upgrade: 'websocket' } });
  expect(response.status).toBe(426); expect(e.status().backends[0].inFlight).toBe(1);
  e.setState('b', 'draining'); let drained = false; e.on('drained', () => drained = true);
  const body = response.text(); expect(drained).toBe(false); end();
  expect(await body).toBe('protocol:upgrade required'); await until(() => drained);
});

async function regressionProcess(url: string, wsStallTimeoutMs = 30000) {
  type Report = { baseline: number; peak: number; closeCalls: { code: number; reason: string }[]; relayTimers: number; activeRelays: number; status: ReturnType<Edge['status']> };
  let receive: ((data: Report) => void) | undefined;
  const child = Bun.spawn([process.execPath, 'tests/helpers/edge/regression-process.ts', url, String(wsStallTimeoutMs)], {
    stdout: 'pipe', stderr: 'inherit', ipc(data) { receive?.(data as Report); },
  });
  cleanups.push(async () => { child.send('stop'); await child.exited; });
  const reader = child.stdout.getReader(); const line = await reader.read(); reader.releaseLock();
  return { url: new TextDecoder().decode(line.value).trim(),
    query: (message: string): Promise<Report> => new Promise(resolve => { receive = resolve; child.send(message); }) };
}

test('isolated edge bounds held uploads with a global byte budget and slot body limit', async () => {
  let received = 0;
  const b = backend(async req => { let count = 0; for await (const bytes of req.body!) count += bytes.length; received += count; return new Response(String(count)); });
  const child = await regressionProcess(b.url.href);
  for (const mode of ['hold', 'standby']) {
    await child.query(mode); await child.query('start');
    for (const mib of [25, 50, 100]) {
      const response = await fetch(child.url, { keepalive: false, method: 'POST', body: new Uint8Array(mib * 1024 * 1024) });
      expect(response.status).toBe(503); expect(response.headers.get('retry-after')).toBe('1'); await response.text();
    }
    const report = await child.query('report');
    console.log(`held uploads ${mode}: RSS growth=${report.peak - report.baseline}`);
    expect(report.status.waiting).toBe(0); expect(received).toBe(0);
    expect(report.peak - report.baseline).toBeLessThan(40 * 1024 * 1024);
    // A buffered prefix within budget survives admission, and its reservation
    // is released so the second hold cycle has the full budget again.
    const pending = fetch(child.url, { keepalive: false, method: 'POST', body: new Uint8Array(4 * 1024 * 1024) });
    await sleep(100); expect((await child.query('report')).status.waiting).toBe(1);
    const overflow = await fetch(child.url, { keepalive: false, method: 'POST', body: new Uint8Array(6 * 1024 * 1024) });
    expect(overflow.status).toBe(503); await overflow.text();
    expect((await child.query('report')).status.waiting).toBe(1);
    await child.query('live'); expect(await (await pending).text()).toBe(String(4 * 1024 * 1024));
    received = 0;
  }
  // Bun rejects a declared body beyond the same 128 MiB default used by slot.
  const response = await new Promise<string>(resolve => {
    const socket = connect(Number(new URL(child.url).port), '127.0.0.1', () => {
      socket.write('POST / HTTP/1.1\r\nHost: edge\r\nContent-Length: 135266304\r\n\r\n');
    });
    socket.once('data', bytes => { resolve(bytes.toString()); socket.destroy(); });
  });
  expect(response).toContain('413');
}, 20000);

test('isolated edge rejects nested encoded private paths for HTTP and WS', async () => {
  let attempts = 0;
  const b = backend(() => { attempts++; return new Response('must not reach backend'); });
  const child = await regressionProcess(b.url.href);
  for (const path of [
    '/internal', '/internal/x', '/internal/%252e%252e/api', '/internal/%2e%2e%2fapi',
    '/internal/%25252E%25252e%255capi', '/internal/%25%32%65%25%32%65%252fapi',
    '/%69nternal/x', '/%2569nternal/x', '/internal%2Fx', '/internal%5Cx',
    '/%2Finternal//x', '/%255Cinternal%255Cx', '/api/%2e%2e%2finternal/x',
    '/api/%252e%252E%255Cinternal/x', '/api%2f.%2f..%2finternal/x',
    '/' + '%'.concat('25'.repeat(20), '69nternal/x'),
  ]) {
    for (const upgrade of [false, true]) {
      const response = await fetch(child.url.replace(/\/$/, '') + path, { headers: upgrade ? {
        connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      } : {} });
      expect(response.status).toBe(404);
    }
  }
  expect(attempts).toBe(0);
});

test('isolated edge preserves public encoded paths and literal percent signs for HTTP and Upgrade', async () => {
  let attempts = 0;
  const app = new Hono();
  app.all('*', c => { attempts++; return c.json({ path: new URL(c.req.url).pathname, query: new URL(c.req.url).search }); });
  const b = backend(req => app.fetch(req));
  const child = await regressionProcess(b.url.href);
  for (const path of ['/api/name%2Etxt', '/api/a%2Fb', '/api/100%25', '/api/a%5Cb',
    '/api/%ZZ', '/api/a%252Fb', '/api/' + '%'.concat('25'.repeat(20), '2Etxt')]) {
    for (const upgrade of [false, true]) {
      const headers: HeadersInit = upgrade ? { connection: 'Upgrade', upgrade: 'websocket',
        'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } : {};
      const direct = await fetch(b.url.origin + path + '?keep=%2F', { headers });
      const proxied = await fetch(new URL(child.url).origin + path + '?keep=%2F', { headers });
      expect(direct.status).toBe(200); expect(proxied.status).toBe(200);
      expect(await proxied.text()).toBe(await direct.text());
    }
  }
  expect(attempts).toBe(28);
});

test('isolated edge relays an immediate Bun backend WS close after 101', async () => {
  let attempts = 0; let code = 4001;
  const b = Bun.serve({ port: 0, fetch(req, server) { attempts++; if (server.upgrade(req)) return; return new Response('no'); },
    websocket: { open(ws) { ws.close(code, 'restart'); }, message() {} } });
  cleanups.push(() => { void b.stop(true); });
  const child = await regressionProcess(b.url.href);
  for (code of [4001, 1012]) {
    const result = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const ws = new UpstreamSocket(new URL(child.url.replace('http:', 'ws:')), { headers: {}, protocols: [], limit: 4 * 1024 * 1024 });
      ws.onclose = resolve; ws.onerror = () => reject(new Error('Unexpected WS error'));
    });
    expect(result).toEqual({ code, reason: 'restart' });
  }
  expect(attempts).toBe(2);
  const { status } = await child.query('report');
  expect(status.backends[0].failures).toBe(0); expect(status.backends[0].state).toBe('live');
  expect(status.metrics.errors).toEqual({ '502': 0, '503': 0, '504': 0 });
  expect(status.metrics.wsRelays).toBe(2);
});

test.each([[64, 4 * 1024 * 1024], [64, 1024 * 1024], [192, 512 * 1024]])(
  'isolated WS streams %i x %i bytes to a slow steady TCP reader without hanging', async (count, size) => {
  const b = Bun.serve({ port: 0, fetch(req, server) { if (server.upgrade(req)) return; return new Response('no'); }, websocket: {
    maxPayloadLength: 4 * 1024 * 1024, backpressureLimit: 4 * 1024 * 1024, closeOnBackpressureLimit: false,
    message(ws) {
      let sent = 0;
      const producer = setInterval(() => {
        if (ws.getBufferedAmount() >= 4 * 1024 * 1024) return;
        if (ws.send(new Uint8Array(size).fill(sent)) !== 0 && ++sent === count) clearInterval(producer);
      }, 1);
      cleanups.push(() => clearInterval(producer));
    },
  } });
  cleanups.push(() => { void b.stop(true); });
  const child = await regressionProcess(b.url.href, 1500);
  await new Promise<void>((resolve, reject) => {
    const socket = connect(Number(new URL(child.url).port), '127.0.0.1'); cleanups.push(() => socket.destroy());
    let head = Buffer.alloc(0); let upgraded = false; let frameHeader = Buffer.alloc(0);
    let remaining = 0; let received = 0; let resume: ReturnType<typeof setTimeout>;
    cleanups.push(() => clearTimeout(resume));
    socket.on('connect', () => socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'));
    socket.on('error', reject); socket.on('end', () => reject(new Error(`Early EOF after ${received} frames`)));
    socket.on('data', data => {
      let bytes: Buffer = typeof data === 'string' ? Buffer.from(data) : data;
      try {
        // Read normally, but yield after each TCP chunk so the sender must buffer.
        socket.pause(); resume = setTimeout(() => socket.resume(), 1);
        if (!upgraded) {
          head = Buffer.concat([head, bytes]); const boundary = head.indexOf('\r\n\r\n');
          if (boundary < 0) return;
          expect(head.subarray(0, boundary).toString()).toStartWith('HTTP/1.1 101');
          bytes = head.subarray(boundary + 4); head = Buffer.alloc(0); upgraded = true;
          socket.write(Buffer.from([0x81, 0x81, 0, 0, 0, 0, 0x78]));
        }
        while (bytes.length) {
          if (!remaining) {
            const take = Math.min(10 - frameHeader.length, bytes.length);
            frameHeader = Buffer.concat([frameHeader, bytes.subarray(0, take)]); bytes = bytes.subarray(take);
            if (frameHeader.length < 10) return;
            expect(frameHeader[0]).toBe(0x82); expect(frameHeader[1]).toBe(127);
            expect(Number(frameHeader.readBigUInt64BE(2))).toBe(size);
            frameHeader = Buffer.alloc(0); remaining = size;
          }
          const take = Math.min(remaining, bytes.length);
          expect(bytes.subarray(0, take).every(value => value === received)).toBe(true);
          remaining -= take; bytes = bytes.subarray(take);
          if (!remaining && ++received === count) { socket.destroy(); resolve(); return; }
        }
      } catch (error) { reject(error); }
    });
  });
  for (let i = 0; i < 200; i++) {
    const report = await child.query('report');
    if (!report.activeRelays) {
      expect(report.relayTimers).toBe(0); expect(report.status.metrics.upstreamErrors).toBe(0);
      return;
    }
    await sleep(5);
  }
  throw new Error('Relay or congestion timer leaked after client close');
}, 30000);

test('standalone edge rejects an empty EDGE_PORT instead of binding an ephemeral port', async () => {
  for (const port of ['', '   ']) {
    const child = Bun.spawn([process.execPath, 'apps/edge/main.ts'], { env: { ...process.env, EDGE_PORT: port }, stdout: 'pipe', stderr: 'pipe' });
    expect(await child.exited).not.toBe(0); expect(await new Response(child.stderr).text()).toContain('Invalid EDGE_PORT');
    expect(await new Response(child.stdout).text()).not.toContain('listening');
  }
});

test('bodyless POST uses a fresh upstream connection and avoids stale keep-alive failures', async () => {
  let connections = 0; let requests = 0;
  const raw = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: {
    open() { connections++; },
    data(socket, bytes) {
      requests++;
      // Advertise keep-alive but close the first connection immediately afterward.
      const response = 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok';
      if (bytes.toString().startsWith('GET ')) socket.end(response); else socket.write(response);
    },
  } });
  cleanups.push(() => raw.stop(true));
  const e = edge({ backends: [{ id: 'b', url: `http://127.0.0.1:${raw.port}`, state: 'live' }] });
  expect(await (await fetch(e.server.url)).text()).toBe('ok');
  const post = await fetch(e.server.url, { method: 'POST' });
  expect(post.status).toBe(200); expect(await post.text()).toBe('ok');
  expect(connections).toBe(2); expect(requests).toBe(2);
  expect(e.status().backends[0].failures).toBe(0); expect(e.status().metrics.upstreamErrors).toBe(0);
});

test('isolated WS stalled TCP reader closes with 1013 within a bounded time and clears timers', async () => {
  const size = 1024 * 1024;
  let sent = 0; let backendClose: { code: number; reason: string } | undefined;
  let producer: ReturnType<typeof setInterval> | undefined;
  const b = Bun.serve({ port: 0, fetch(req, server) { if (server.upgrade(req)) return; return new Response('no'); }, websocket: {
    maxPayloadLength: 4 * size, backpressureLimit: 4 * size, closeOnBackpressureLimit: false,
    message(ws) {
      producer = setInterval(() => {
        if (ws.getBufferedAmount() < 4 * size && ws.send(new Uint8Array(size)) !== 0) sent++;
      }, 1);
    },
    close(_ws, code, reason) { clearInterval(producer); backendClose = { code, reason }; },
  } });
  cleanups.push(() => { clearInterval(producer); void b.stop(true); });
  const child = await regressionProcess(b.url.href, 250);
  const socket = connect(Number(new URL(child.url).port), '127.0.0.1'); cleanups.push(() => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    let head = '';
    socket.on('error', reject);
    socket.on('connect', () => socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'));
    socket.on('data', data => {
      head += data.toString();
      if (!head.includes('\r\n\r\n')) return;
      expect(head).toStartWith('HTTP/1.1 101');
      socket.pause(); // Stop consuming completely after the handshake.
      socket.write(Buffer.from([0x81, 0x80, 0, 0, 0, 0]));
      resolve();
    });
  });
  await until(() => backendClose !== undefined);
  const report = await child.query('report');
  expect(report.closeCalls).toContainEqual({ code: 1013, reason: 'Downstream stalled' });
  expect(report.status.backends[0].websockets).toBe(0);
  expect(report.activeRelays).toBe(0); expect(report.relayTimers).toBe(0);
  socket.removeAllListeners('data');
  const ended = new Promise<void>((resolve, reject) => { socket.once('end', resolve); socket.once('error', reject); });
  socket.resume(); await ended;
  // Close stops the producer even when it has buffered outgoing messages.
  await sleep(100); const finalSent = sent; await sleep(100); expect(sent).toBe(finalSent);
  expect((await child.query('report')).relayTimers).toBe(0);

}, 5000);
