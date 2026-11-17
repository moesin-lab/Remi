import { EventEmitter } from 'node:events';
import { exchange, HttpPool } from './http';
import { WaitingBody } from './waiting-body';
import { UpstreamSocket } from './websocket';
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { ServerWebSocket } from 'bun';

export type BackendState = 'standby' | 'live' | 'draining' | 'down';
export interface Backend { id: string; url: string; state: BackendState }
interface Slot extends Backend {
  restore: BackendState; failures: number; successes: number; requests: number; inFlight: number;
  websockets: number; wsTotal: number; upstreamErrors: number; drained: boolean;
}
export interface EdgeOptions {
  hostname?: string; port?: number; controlSocket?: string; backends?: Backend[];
  holdMaxMs?: number; maxWaiting?: number; healthIntervalMs?: number;
  healthTimeoutMs?: number; failureThreshold?: number; riseThreshold?: number; wsBufferLimit?: number; wsMaxMessageBytes?: number; wsQueueLimit?: number; responseHeaderTimeoutMs?: number;
  log?: (line: string) => void;
}
interface Relay { upstream: UpstreamSocket; client?: ServerWebSocket<Relay>; slot: Slot; pending: (string | Buffer)[]; bytes: number; ended: boolean; earlyClose?: { code: number; reason: string }; blocked?: boolean; retryTimer?: ReturnType<typeof setTimeout> }
const hop = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
export function cleanHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  for (const name of (headers.get('connection') ?? '').split(',')) if (name.trim()) headers.delete(name.trim());
  for (const name of hop) headers.delete(name);
  return headers;
}
class Unavailable extends Error {}

/** Long-lived public listener. Slot lifecycle is controlled by the caller, never spawned here. */
export class Edge extends EventEmitter {
  private slots = new Map<string, Slot>();
  private held = false;
  private stopped = false;
  private httpPool = new HttpPool();
  private shutdown = new AbortController();
  private cursor = 0;
  private waiters = new Set<() => void>();
  private waiting = 0;
  private waitingBodyBudget = { bytes: 0, limit: 8 * 1024 * 1024 };
  private healthTimer: ReturnType<typeof setInterval>;
  private probing = false;
  private control?: ReturnType<typeof Bun.listen>;
  private relays = new Set<Relay>();
  private clients = new Set<ServerWebSocket<Relay>>();
  readonly server: Bun.Server<Relay>;
  readonly metrics = { requests: 0, upstreamErrors: 0, wsRelays: 0, errors: { '502': 0, '503': 0, '504': 0 }, holds: 0, holdMs: 0,
    holdDurationBuckets: { le10: 0, le100: 0, le1000: 0, le10000: 0, infinity: 0 } };
  private options: Required<Pick<EdgeOptions, 'holdMaxMs' | 'maxWaiting' | 'failureThreshold' | 'healthTimeoutMs' | 'healthIntervalMs' | 'riseThreshold' | 'responseHeaderTimeoutMs' | 'wsMaxMessageBytes' | 'wsQueueLimit' | 'wsBufferLimit'>> & EdgeOptions;

  constructor(options: EdgeOptions = {}) {
    super();
    this.options = { holdMaxMs: 60_000, maxWaiting: 4096, failureThreshold: 3, healthTimeoutMs: 1000, wsBufferLimit: 1024 * 1024, wsMaxMessageBytes: 4 * 1024 * 1024, wsQueueLimit: 64 * 1024 * 1024, healthIntervalMs: 1000, riseThreshold: 2, responseHeaderTimeoutMs: 30_000, ...options };
    for (const key of ['holdMaxMs', 'maxWaiting', 'failureThreshold', 'healthTimeoutMs', 'healthIntervalMs', 'riseThreshold', 'responseHeaderTimeoutMs', 'wsMaxMessageBytes', 'wsQueueLimit', 'wsBufferLimit'] as const) {
      if (!Number.isFinite(this.options[key]) || this.options[key] <= 0) throw new Error(`Invalid ${key}`);
    }
    if (!Number.isInteger(options.port ?? 16120) || (options.port ?? 16120) < 0 || (options.port ?? 16120) > 65535) throw new Error('Invalid port');
    for (const backend of options.backends ?? []) this.addBackend(backend);
    this.server = Bun.serve<Relay>({ hostname: options.hostname ?? '127.0.0.1', port: options.port ?? 16120,
      // Match the slot (Bun.serve default); never accept an unlimited upload.
      idleTimeout: 120, maxRequestBodySize: 128 * 1024 * 1024,
      fetch: (req, server) => this.handle(req, server),
      websocket: {
        open: client => { const r = client.data; r.client = client; this.clients.add(client); if (r.earlyClose) this.closeRelay(r, r.earlyClose.code, r.earlyClose.reason); else this.flush(r); },
        message: (client, data) => {
          const r = client.data;
          if (r.upstream.readyState !== WebSocket.OPEN) return;
          if (Buffer.byteLength(data) > this.options.wsMaxMessageBytes) { this.closeRelay(r, 1013, 'Backpressure limit'); return; }
          // Bun has no API to pause incoming client WS reads. Keep a separate
          // hard safety ceiling, well above valid frame sizes and the high-water mark.
          if (r.upstream.bufferedAmount + Buffer.byteLength(data) > this.options.wsQueueLimit) { this.closeRelay(r, 1013, 'Upstream queue exhausted'); return; }
          r.upstream.send(data);
        },
        drain: client => this.flush(client.data),
        close: (client, code, reason) => this.closeRelay(client.data, code, reason),
        backpressureLimit: this.options.wsBufferLimit, closeOnBackpressureLimit: false, maxPayloadLength: Math.max(16 * 1024 * 1024, this.options.wsMaxMessageBytes),
      },
    });
    this.healthTimer = setInterval(() => void this.probe(), options.healthIntervalMs ?? 1000);
    if (options.controlSocket) {
      try {
        // Never remove a live listener or a non-socket file. A killed process can
        // leave its socket inode behind; only refusal/missing endpoint plus an unchanged inode permits removal.
        try {
          const inode = lstatSync(options.controlSocket);
          if (!inode.isSocket()) throw new Error('Control path is not a socket');
          const probe = spawnSync(process.execPath, ['-e', `
            const s = require('node:net').connect(process.argv[1]);
            s.on('connect', () => process.exit(1));
            s.on('error', e => process.exit(['ECONNREFUSED', 'ENOENT'].includes(e.code) ? 0 : 1));
            setTimeout(() => process.exit(1), 1000);
          `, options.controlSocket], { timeout: 2000, stdio: 'ignore' });
          if (probe.status !== 0) throw new Error('Control socket is active or cannot be probed');
          const current = lstatSync(options.controlSocket);
          if (current.ino !== inode.ino || current.dev !== inode.dev) throw new Error('Control socket changed');
          unlinkSync(options.controlSocket);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const mask = process.umask(0o177);
        try {
          this.control = Bun.listen<{ buffer: string }>({ unix: options.controlSocket,
            socket: {
              open(socket) { socket.data = { buffer: '' }; },
              data: (socket, data) => {
                socket.data.buffer += data.toString();
                if (socket.data.buffer.length > 65536) { socket.end(); return; }
                let end: number;
                while ((end = socket.data.buffer.indexOf('\n')) >= 0) {
                  const line = socket.data.buffer.slice(0, end); socket.data.buffer = socket.data.buffer.slice(end + 1);
                  try { socket.write(JSON.stringify({ ok: true, result: this.command(JSON.parse(line)) }) + '\n'); }
                  catch (error) { socket.write(JSON.stringify({ ok: false, error: String(error) }) + '\n'); }
                }
              },
            },
          });
        } finally { process.umask(mask); }
        chmodSync(options.controlSocket, 0o600);
      } catch (error) { clearInterval(this.healthTimer); void this.server.stop(true); throw error; }
    }
  }
  private log(message: string) { (this.options?.log ?? console.log)(`edge: ${message}`); }
  private wake() { for (const wake of this.waiters) wake(); }
  addBackend(backend: Backend) {
    if (!backend.id || this.slots.has(backend.id)) throw new Error('Duplicate or empty backend id');
    const url = new URL(backend.url);
    if (url.protocol !== 'http:') throw new Error('Backend must use http');
    this.validateState(backend.state);
    this.slots.set(backend.id, { ...backend, restore: backend.state, failures: 0, successes: 0, requests: 0, inFlight: 0, websockets: 0, wsTotal: 0, upstreamErrors: 0, drained: false });
    this.log(`add ${backend.id} ${backend.state}`); this.wake();
  }
  private validateState(state: string) { if (!['standby', 'live', 'draining', 'down'].includes(state)) throw new Error('Invalid backend state'); }
  private slot(id: string) { const slot = this.slots.get(id); if (!slot) throw new Error(`Unknown backend ${id}`); return slot; }
  removeBackend(id: string) {
    const slot = this.slot(id);
    if (slot.inFlight || slot.websockets) throw new Error('Backend still has in-flight traffic');
    this.slots.delete(id); this.log(`remove ${id}`); this.wake();
  }
  setState(id: string, state: BackendState) {
    this.validateState(state); const slot = this.slot(id);
    slot.restore = state; slot.failures = 0; slot.successes = 0; this.transition(slot, state);
  }
  private transition(slot: Slot, state: BackendState) {
    if (slot.state !== state) { this.log(`${slot.id} ${slot.state} -> ${state}`); slot.state = state; slot.drained = false; }
    this.checkDrained(slot); this.wake();
  }
  private checkDrained(slot: Slot) {
    if (slot.state === 'draining' && !slot.inFlight && !slot.websockets && !slot.drained) {
      slot.drained = true; this.emit('drained', slot.id);
    }
  }
  hold() { this.held = true; this.log('hold'); }
  unhold() { this.held = false; this.log('unhold'); this.wake(); }
  status() { return { held: this.held, waiting: this.waiting, backends: [...this.slots.values()].map(s => ({ ...s })), metrics: structuredClone(this.metrics) }; }
  private command(command: { op: string; backend?: Backend; id?: string; state?: BackendState }) {
    switch (command.op) {
      case 'status': return this.status();
      case 'hold': return this.hold() ?? null;
      case 'unhold': return this.unhold() ?? null;
      case 'addBackend': this.addBackend(command.backend!); return null;
      case 'removeBackend': this.removeBackend(command.id!); return null;
      case 'setState': this.setState(command.id!, command.state!); return null;
      default: throw new Error('Unknown operation');
    }
  }
  private failed(slot: Slot) {
    slot.upstreamErrors++; this.metrics.upstreamErrors++; slot.failures++; slot.successes = 0;
    if (slot.failures >= this.options.failureThreshold && slot.state !== 'down') this.transition(slot, 'down');
  }
  private async probe() {
    if (this.probing || this.stopped) return;
    this.probing = true;
    try { await Promise.all([...this.slots.values()].map(async slot => {
      try {
        const response = await fetch(new URL('/readyz', slot.url), { signal: AbortSignal.timeout(this.options.healthTimeoutMs), redirect: 'manual' });
        void response.body?.cancel();
        if (response.status !== 200) throw new Error('Not ready');
        if (this.slots.get(slot.id) !== slot) return;
        slot.failures = 0;
        if (++slot.successes >= this.options.riseThreshold && slot.state === 'down' && slot.restore !== 'down') this.transition(slot, slot.restore);
      } catch { if (this.slots.get(slot.id) === slot) this.failed(slot); }
    })); } finally { this.probing = false; }
  }
  private async acquire(deadline: number, signal: AbortSignal, excluded = new Set<string>(), retry = false): Promise<Slot> {
    const select = () => {
      if (this.held || this.stopped) return;
      const live = [...this.slots.values()].filter(s => s.state === 'live' && !excluded.has(s.id));
      return live.length ? live[this.cursor++ % live.length] : undefined;
    };
    let slot = retry ? undefined : select(); if (slot) return slot;
    if (this.waiting >= this.options.maxWaiting || this.stopped) throw new Unavailable();
    this.waiting++; this.metrics.holds++; const start = performance.now();
    try {
      while (retry || !(slot = select())) {
        retry = false;
        if (Date.now() >= deadline || signal.aborted || this.stopped) throw new Unavailable();
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); this.waiters.delete(done); signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, Math.min(25, Math.max(0, deadline - Date.now())));
          this.waiters.add(done); signal.addEventListener('abort', done, { once: true });
        });
      }
      return slot;
    } finally {
      this.waiting--; const elapsed = performance.now() - start; this.metrics.holdMs += elapsed;
      const b = this.metrics.holdDurationBuckets;
      b.infinity++; if (elapsed <= 10000) b.le10000++; if (elapsed <= 1000) b.le1000++; if (elapsed <= 100) b.le100++; if (elapsed <= 10) b.le10++;
    }
  }
  private error(status: 502 | 503 | 504) {
    this.metrics.errors[status]++;
    return new Response(status === 503 ? 'Service unavailable' : 'Bad gateway', { status, headers: status === 503 ? { 'Retry-After': '1', Connection: 'close' } : {} });
  }
  private headers(req: Request, server: Bun.Server<Relay>) {
    const headers = cleanHeaders(req.headers); headers.delete('host'); headers.delete('forwarded');
    const ip = server.requestIP(req)?.address ?? '';
    headers.set('x-real-ip', ip); headers.set('x-forwarded-for', ip); headers.set('x-forwarded-proto', new URL(req.url).protocol.slice(0, -1));
    return headers;
  }
  private async handle(req: Request, server: Bun.Server<Relay>): Promise<Response | undefined> {
    const url = new URL(req.url);
    // Reject encoded separators/dots, including nested percent encoding, before
    // normalization can turn a private prefix into a different checked path.
    let path = url.pathname;
    try {
      let layers = 0;
      while (path.includes('%')) {
        if (++layers > 16 || /%(?:2e|2f|5c)/i.test(path)) return new Response('Not found', { status: 404 });
        const decoded = decodeURIComponent(path);
        if (decoded === path) break;
        path = decoded;
      }
      path = new URL('http://edge' + path.replaceAll('\\', '/').replace(/\/+/g, '/')).pathname;
    } catch { return new Response('Not found', { status: 404 }); }
    if (path === '/internal' || path.startsWith('/internal/')) return new Response('Not found', { status: 404 });
    const deadline = Date.now() + this.options.holdMaxMs;
    const headers = this.headers(req, server);
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') return this.upgrade(req, server, headers, deadline);
    const body = req.body ? new WaitingBody(req.body, this.waitingBodyBudget) : undefined;
    const admission = new AbortController();
    const signal = AbortSignal.any([req.signal, admission.signal]);
    let forwarded = req;
    let admitted = false;
    let retry = false;
    let safeRetries = 0; const excluded = new Set<string>();
    while (true) {
      let slot: Slot;
      try {
        const acquiring = this.acquire(deadline, signal, excluded, retry);
        slot = await (body ? Promise.race([acquiring, body.failed]) : acquiring);
      } catch { admission.abort(); body?.dispose(); return this.error(503); }
      if (body && !admitted) { forwarded = new Request(req, { body: body.admit(), signal }); admitted = true; }
      slot.requests++; this.metrics.requests++; slot.inFlight++;
      let sent = false; let finished = false;
      const finish = () => { if (!finished) { finished = true; slot.inFlight--; this.checkDrained(slot); } };
      try {
        const target = new URL(slot.url); target.pathname = url.pathname; target.search = url.search;
        const exchanging = exchange(target, forwarded, headers, {
          connectTimeoutMs: Math.max(1, Math.min(this.options.healthTimeoutMs, deadline - Date.now())),
          pool: this.httpPool, responseHeaderTimeoutMs: this.options.responseHeaderTimeoutMs,
          sent() { sent = true; }, done: finish,
          stopSignal: this.shutdown.signal,
          error: () => { if (!req.signal.aborted && !this.stopped) { slot.upstreamErrors++; this.metrics.upstreamErrors++; } },
        });
        const response = await (body ? Promise.race([exchanging, body.failed]) : exchanging);
        slot.failures = 0;
        body?.dispose();
        return response;
      } catch {
        finish();
        if (body?.exhausted) { admission.abort(); body.dispose(); return this.error(503); }
        if (req.signal.aborted || this.stopped) { body?.dispose(); return new Response(null, { status: 499 }); }
        this.failed(slot); retry = true;
        if (!sent) { excluded.add(slot.id); if (![...this.slots.values()].some(s => s.state === 'live' && !excluded.has(s.id))) excluded.clear(); if (Date.now() < deadline) { continue; } body?.dispose(); return this.error(503); }
        if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.body && safeRetries++ === 0) { if ([...this.slots.values()].some(s => s.state === 'live' && s.id !== slot.id)) excluded.add(slot.id); continue; }
        body?.dispose(); return this.error(502);
      }
    }
  }
  private async upgrade(req: Request, server: Bun.Server<Relay>, headers: Headers, deadline: number): Promise<Response | undefined> {
    for (const name of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol']) headers.delete(name);
    let retry = false;
    while (Date.now() < deadline && !req.signal.aborted) {
      let slot: Slot; try { slot = await this.acquire(deadline, req.signal, new Set(), retry); } catch { return this.error(503); }
      slot.requests++; this.metrics.requests++; slot.inFlight++;
      const incoming = new URL(req.url);
      const target = new URL(slot.url); target.pathname = incoming.pathname; target.search = incoming.search; target.protocol = 'ws:';
      const protocols = (req.headers.get('sec-websocket-protocol') ?? '').split(',').map(s => s.trim()).filter(Boolean);
      let finished = false;
      const finish = () => { if (!finished) { finished = true; slot.inFlight--; this.checkDrained(slot); } };
      const upstream = new UpstreamSocket(target, { headers: Object.fromEntries(headers), protocols, limit: this.options.wsMaxMessageBytes,
        rejection: { request: req, stopSignal: this.shutdown.signal, done: finish,
          error: () => { if (!req.signal.aborted && !this.stopped) { slot.upstreamErrors++; this.metrics.upstreamErrors++; } },
        },
      });
      const relay: Relay = { upstream, slot, pending: [], bytes: 0, ended: false };
      upstream.binaryType = 'arraybuffer';
      upstream.onoverflow = () => this.closeRelay(relay, 1013, 'Backpressure limit');
      upstream.onmessage = event => {
        const data = typeof event.data === 'string' ? event.data : Buffer.from(event.data as ArrayBuffer);
        relay.pending.push(data); relay.bytes += Buffer.byteLength(data);
        this.flush(relay);
        if (!relay.client || relay.blocked) upstream.pause();
      };
      const opened = await new Promise<boolean | Response>(resolve => {
        const done = (ok: boolean | Response) => { clearTimeout(timer); req.signal.removeEventListener('abort', abort); resolve(ok); };
        const abort = () => done(false);
        const timer = setTimeout(abort, Math.max(1, Math.min(this.options.healthTimeoutMs, deadline - Date.now())));
        req.signal.addEventListener('abort', abort, { once: true });
        upstream.onresponse = response => done(response);
        upstream.onopen = () => {
          // Install close ownership synchronously: 101 and a close frame may be
          // parsed in the same TCP callback, before this await resumes.
          upstream.onclose = event => { relay.earlyClose = event; if (relay.client) this.closeRelay(relay, event.code, event.reason); };
          done(true);
        }; upstream.onerror = () => done(false); upstream.onclose = () => done(false);
      });
      if (req.signal.aborted || this.stopped) { upstream.terminate(); finish(); return new Response(null, { status: 499 }); }
      if (opened instanceof Response) {
        slot.failures = 0; this.checkDrained(slot);
        return new Response(opened.body, { status: opened.status, statusText: opened.statusText, headers: cleanHeaders(opened.headers) });
      }
      if (!opened) {
        upstream.terminate(); this.failed(slot); retry = true; finish();
        continue;
      }
      slot.failures = 0;
      slot.websockets++; slot.wsTotal++; this.metrics.wsRelays++; this.relays.add(relay); finish();
      upstream.onclose = event => { relay.earlyClose = event; if (relay.client) this.closeRelay(relay, event.code, event.reason); };
      upstream.onerror = () => this.closeRelay(relay, 1011, 'Upstream error');
      const responseHeaders = new Headers(); if (upstream.protocol) responseHeaders.set('sec-websocket-protocol', upstream.protocol);
      if (server.upgrade(req, { data: relay, headers: responseHeaders })) return;
      this.closeRelay(relay, 1001, 'Client unavailable'); return this.error(502);
    }
    return this.error(503);
  }
  private flush(relay: Relay) {
    clearTimeout(relay.retryTimer); relay.retryTimer = undefined;
    if (!relay.client || relay.ended) return;
    relay.blocked = false;
    const pause = () => {
      relay.blocked = true; relay.upstream.pause();
      // Bun 1.3.14 can miss drain after send() returns -1 (accepted/queued).
      // Poll only congested relays, and use actual buffered bytes for admission.
      relay.retryTimer = setTimeout(() => this.flush(relay), 10);
      relay.retryTimer.unref();
    };
    while (relay.pending.length) {
      if (relay.client.getBufferedAmount() >= this.options.wsBufferLimit) { pause(); return; }
      const data = relay.pending.shift()!; relay.bytes -= Buffer.byteLength(data);
      const sent = relay.client.send(data);
      if (sent === 0) {
        relay.pending.unshift(data); relay.bytes += Buffer.byteLength(data);
        pause(); return;
      }
      // Positive and -1 both accept the entire message. Never enqueue it twice.
    }
    if (relay.client.getBufferedAmount() >= this.options.wsBufferLimit) { pause(); return; }
    relay.upstream.resume();
  }
  private closeRelay(relay: Relay, code: number, reason: string) {
    if (relay.ended) return; relay.ended = true;
    clearTimeout(relay.retryTimer); relay.retryTimer = undefined;
    relay.pending = []; relay.bytes = 0;
    // Reserved transport codes cannot appear in a close frame.
    const wireCode = code === 1005 ? 1000 : [1006, 1015].includes(code) ? 1011 : code;
    relay.client?.close(wireCode, reason);
    if (relay.client) {
      const client = relay.client;
      const timer = setTimeout(() => { client.terminate(); this.clients.delete(client); }, 100);
      timer.unref();
    }
    if (relay.upstream.readyState === WebSocket.OPEN) relay.upstream.close(wireCode, reason); else if (relay.upstream.readyState === WebSocket.CONNECTING) relay.upstream.close();
    if (this.relays.delete(relay)) { relay.slot.websockets--; this.checkDrained(relay.slot); }
  }
  stop() {
    this.stopped = true; this.shutdown.abort(); this.httpPool.stop(); clearInterval(this.healthTimer); this.wake();
    for (const relay of this.relays) this.closeRelay(relay, 1001, 'Edge stopping');
    this.control?.stop(true);
    if (this.control && this.options.controlSocket) { try { unlinkSync(this.options.controlSocket); } catch {} }
    for (const client of this.clients) client.terminate(); this.clients.clear();
    // Bun 1.3.14 can leave stop(true)'s promise pending after server-initiated
    // WS close, even after all sockets are gone. stop(true) closes the listener
    // synchronously; do not expose that unresolved runtime promise to supervisors.
    void this.server.stop(true);
  }
}
export const startEdge = (options?: EdgeOptions) => new Edge(options);
