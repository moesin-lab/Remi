import { EventEmitter } from 'node:events';
import { exchange } from './http';
import { UpstreamSocket } from './websocket';
import { chmodSync, unlinkSync } from 'node:fs';
import type { ServerWebSocket } from 'bun';

export type BackendState = 'standby' | 'live' | 'draining' | 'down';
export interface Backend { id: string; url: string; state: BackendState }
interface Slot extends Backend {
  restore: BackendState; failures: number; requests: number; inFlight: number;
  websockets: number; wsTotal: number; upstreamErrors: number; drained: boolean;
}
export interface EdgeOptions {
  hostname?: string; port?: number; controlSocket?: string; backends?: Backend[];
  holdMaxMs?: number; maxWaiting?: number; healthIntervalMs?: number;
  healthTimeoutMs?: number; failureThreshold?: number; wsBufferLimit?: number;
  log?: (line: string) => void;
}
interface Relay { upstream: UpstreamSocket; client?: ServerWebSocket<Relay>; slot: Slot; pending: (string | Buffer)[]; bytes: number; ended: boolean; timer?: ReturnType<typeof setInterval> }
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
  private shutdown = new AbortController();
  private cursor = 0;
  private waiters = new Set<() => void>();
  private waiting = 0;
  private healthTimer: ReturnType<typeof setInterval>;
  private probing = false;
  private control?: ReturnType<typeof Bun.listen>;
  private relays = new Set<Relay>();
  private clients = new Set<ServerWebSocket<Relay>>();
  readonly server: Bun.Server<Relay>;
  readonly metrics = { requests: 0, upstreamErrors: 0, wsRelays: 0, errors: { '502': 0, '503': 0, '504': 0 }, holds: 0, holdMs: 0,
    holdDurationBuckets: { le10: 0, le100: 0, le1000: 0, le10000: 0, infinity: 0 } };
  private options: Required<Pick<EdgeOptions, 'holdMaxMs' | 'maxWaiting' | 'failureThreshold' | 'healthTimeoutMs' | 'wsBufferLimit'>> & EdgeOptions;

  constructor(options: EdgeOptions = {}) {
    super();
    this.options = { holdMaxMs: 60_000, maxWaiting: 4096, failureThreshold: 3, healthTimeoutMs: 1000, wsBufferLimit: 1024 * 1024, ...options };
    for (const key of ['holdMaxMs', 'maxWaiting', 'failureThreshold', 'healthTimeoutMs', 'wsBufferLimit'] as const) {
      if (!Number.isFinite(this.options[key]) || this.options[key] <= 0) throw new Error(`Invalid ${key}`);
    }
    for (const backend of options.backends ?? []) this.addBackend(backend);
    this.server = Bun.serve<Relay>({ hostname: options.hostname ?? '127.0.0.1', port: options.port ?? 16120,
      idleTimeout: 0, maxRequestBodySize: Number.MAX_SAFE_INTEGER,
      fetch: (req, server) => this.handle(req, server),
      websocket: {
        open: client => { const r = client.data; r.client = client; this.clients.add(client); this.flush(r); },
        message: (client, data) => {
          const r = client.data;
          if (r.upstream.readyState !== WebSocket.OPEN) return;
          if (Buffer.byteLength(data) > this.options.wsBufferLimit) { this.closeRelay(r, 1013, 'Backpressure limit'); return; }
          r.upstream.send(data);
          if (r.upstream.bufferedAmount > this.options.wsBufferLimit) this.closeRelay(r, 1013, 'Backpressure limit');
        },
        drain: client => this.flush(client.data),
        close: (client, code, reason) => this.closeRelay(client.data, code, reason),
        backpressureLimit: this.options.wsBufferLimit, closeOnBackpressureLimit: true,
      },
    });
    this.healthTimer = setInterval(() => void this.probe(), options.healthIntervalMs ?? 1000);
    if (options.controlSocket) {
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
    this.slots.set(backend.id, { ...backend, restore: backend.state, failures: 0, requests: 0, inFlight: 0, websockets: 0, wsTotal: 0, upstreamErrors: 0, drained: false });
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
    slot.restore = state; slot.failures = 0; this.transition(slot, state);
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
    slot.upstreamErrors++; this.metrics.upstreamErrors++; slot.failures++;
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
        if (slot.state === 'down' && slot.restore !== 'down') this.transition(slot, slot.restore);
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
    return new Response(status === 503 ? 'Service unavailable' : 'Bad gateway', { status, headers: status === 503 ? { 'Retry-After': '1' } : {} });
  }
  private headers(req: Request, server: Bun.Server<Relay>) {
    const headers = cleanHeaders(req.headers); headers.delete('host'); headers.delete('forwarded');
    const ip = server.requestIP(req)?.address ?? '';
    headers.set('x-real-ip', ip); headers.set('x-forwarded-for', ip); headers.set('x-forwarded-proto', 'http');
    return headers;
  }
  private async handle(req: Request, server: Bun.Server<Relay>): Promise<Response | undefined> {
    const url = new URL(req.url);
    let path: string; try { path = new URL('http://edge' + decodeURIComponent(url.pathname).replaceAll('\\', '/').replace(/\/+/g, '/')).pathname; } catch { return new Response('Not found', { status: 404 }); }
    if (path === '/internal' || path.startsWith('/internal/')) return new Response('Not found', { status: 404 });
    const deadline = Date.now() + this.options.holdMaxMs;
    const headers = this.headers(req, server);
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') return this.upgrade(req, server, headers, deadline);
    let retry = false;
    let safeRetries = 0; const excluded = new Set<string>();
    while (true) {
      let slot: Slot;
      try { slot = await this.acquire(deadline, req.signal, excluded, retry); } catch { return this.error(503); }
      slot.requests++; this.metrics.requests++; slot.inFlight++;
      let sent = false; let finished = false;
      const finish = () => { if (!finished) { finished = true; slot.inFlight--; this.checkDrained(slot); } };
      try {
        const target = new URL(slot.url); target.pathname = url.pathname; target.search = url.search;
        const response = await exchange(target, req, headers, {
          connectTimeoutMs: Math.max(1, Math.min(this.options.healthTimeoutMs, deadline - Date.now())),
          sent() { sent = true; }, done: finish,
          stopSignal: this.shutdown.signal,
          error: () => { slot.upstreamErrors++; this.metrics.upstreamErrors++; },
        });
        return response;
      } catch {
        finish(); this.failed(slot); retry = true;
        if (req.signal.aborted) return this.error(502);
        if (!sent) { excluded.add(slot.id); if (![...this.slots.values()].some(s => s.state === 'live' && !excluded.has(s.id))) excluded.clear(); if (Date.now() < deadline) { continue; } return this.error(503); }
        if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.body && safeRetries++ === 0) { if ([...this.slots.values()].some(s => s.state === 'live' && s.id !== slot.id)) excluded.add(slot.id); continue; }
        return this.error(502);
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
      const upstream = new UpstreamSocket(target, { headers: Object.fromEntries(headers), protocols, limit: this.options.wsBufferLimit });
      const relay: Relay = { upstream, slot, pending: [], bytes: 0, ended: false };
      upstream.binaryType = 'arraybuffer';
      upstream.onoverflow = () => this.closeRelay(relay, 1013, 'Backpressure limit');
      upstream.onmessage = event => {
        const data = typeof event.data === 'string' ? event.data : Buffer.from(event.data as ArrayBuffer);
        relay.pending.push(data); relay.bytes += Buffer.byteLength(data);
        if (relay.bytes > this.options.wsBufferLimit) this.closeRelay(relay, 1013, 'Backpressure limit'); else this.flush(relay);
      };
      const opened = await new Promise<boolean>(resolve => {
        const done = (ok: boolean) => { clearTimeout(timer); req.signal.removeEventListener('abort', abort); resolve(ok); };
        const abort = () => done(false);
        const timer = setTimeout(abort, Math.max(1, Math.min(this.options.healthTimeoutMs, deadline - Date.now())));
        req.signal.addEventListener('abort', abort, { once: true });
        upstream.onopen = () => done(true); upstream.onerror = () => done(false); upstream.onclose = () => done(false);
      });
      slot.inFlight--;
      if (!opened || relay.ended || upstream.readyState !== WebSocket.OPEN) {
        upstream.terminate(); this.failed(slot); retry = true; this.checkDrained(slot);
        continue;
      }
      slot.websockets++; slot.wsTotal++; this.metrics.wsRelays++; this.relays.add(relay);
      upstream.onclose = event => this.closeRelay(relay, event.code, event.reason);
      upstream.onerror = () => this.closeRelay(relay, 1011, 'Upstream error');
      relay.timer = setInterval(() => this.flush(relay), 10);
      const responseHeaders = new Headers(); if (upstream.protocol) responseHeaders.set('sec-websocket-protocol', upstream.protocol);
      if (server.upgrade(req, { data: relay, headers: responseHeaders })) return;
      this.closeRelay(relay, 1001, 'Client unavailable'); return this.error(502);
    }
    return this.error(503);
  }
  private flush(relay: Relay) {
    if (!relay.client || relay.ended) return;
    while (relay.pending.length) {
      const data = relay.pending.shift()!; relay.bytes -= Buffer.byteLength(data);
      const sent = relay.client.send(data);
      if (sent === 0) { this.closeRelay(relay, 1013, 'Backpressure limit'); return; }
      if (sent === -1) return;
    }
  }
  private closeRelay(relay: Relay, code: number, reason: string) {
    if (relay.ended) return; relay.ended = true;
    clearInterval(relay.timer); relay.pending = []; relay.bytes = 0;
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
    this.stopped = true; this.shutdown.abort(); clearInterval(this.healthTimer); this.wake();
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
