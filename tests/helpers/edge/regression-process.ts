import { Edge } from '../../../packages/edge/src/index';
import { testHostname } from './hostname';
import { trafficHeader } from './traffic';
import { AsyncLocalStorage } from 'node:async_hooks';
const edge = new Edge({ hostname: testHostname, wsStallTimeoutMs: Number(process.argv[3] ?? 30000), port: 0, holdMaxMs: 5000, healthIntervalMs: 100000,
  backends: [{ id: 'b', url: process.argv[2], state: 'live' }], log: () => {} });
// Observe the real acquire lifecycle in request context. Scanners still traverse
// the real Edge; only the per-test waiter oracle excludes their traffic.
const nonce = process.argv[4];
const context = new AsyncLocalStorage<boolean>();
const internals = edge as unknown as {
  handle(req: Request, server: unknown): Promise<Response | undefined>;
  acquire(...args: unknown[]): Promise<unknown>;
  waiting: number;
};
let ownWaiting = 0;
const handle = internals.handle.bind(edge);
internals.handle = (req, server) => context.run(!!nonce && req.headers.get(trafficHeader) === nonce, () => handle(req, server));
const acquire = internals.acquire.bind(edge);
internals.acquire = (...args) => {
  const before = internals.waiting;
  const result = acquire(...args);
  const counted = context.getStore() && internals.waiting > before;
  if (counted) ownWaiting++;
  return result.finally(() => { if (counted) ownWaiting--; });
};
let baseline = process.memoryUsage().rss; let peak = baseline;
// Retain observed relays to check that timers clear even after removal from Edge.
const observed = new Set<{ retryTimer?: ReturnType<typeof setTimeout>; client?: { close(code: number, reason: string): void } }>();
const clients = new WeakSet<object>();
const closeCalls: { code: number; reason: string }[] = [];
const relays = (edge as unknown as { relays: typeof observed }).relays;
const timer = setInterval(() => {
  peak = Math.max(peak, process.memoryUsage().rss);
  for (const relay of relays) {
    observed.add(relay);
    const client = relay.client;
    if (client && !clients.has(client)) {
      clients.add(client);
      // Observe the real downstream close call, like the in-process spy. A
      // completely non-reading peer need not receive its queued close frame.
      const close = client.close.bind(client);
      client.close = (code, reason) => { closeCalls.push({ code, reason }); close(code, reason); };
    }
  }
}, 2);
process.on('message', message => {
  if (message === 'hold') edge.hold();
  if (message === 'standby') { edge.unhold(); edge.setState('b', 'standby'); }
  if (message === 'live') { edge.setState('b', 'live'); edge.unhold(); }
  if (message === 'start') { Bun.gc(true); baseline = process.memoryUsage().rss; peak = baseline; }
  if (message === 'stop') { clearInterval(timer); edge.stop(); process.exit(0); }
  process.send?.({ ownWaiting, waitingBytes: (edge as unknown as { waitingBodyBudget: { bytes: number } }).waitingBodyBudget.bytes, baseline, peak, closeCalls, activeRelays: relays.size, relayTimers: [...observed].filter(r => r.retryTimer !== undefined).length, status: edge.status() });
});
console.log(edge.server.url.href);
