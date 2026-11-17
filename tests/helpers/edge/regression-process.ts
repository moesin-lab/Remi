import { Edge } from '../../../packages/edge/src/index';
const edge = new Edge({ wsStallTimeoutMs: Number(process.argv[3] ?? 30000), port: 0, holdMaxMs: 5000, healthIntervalMs: 100000,
  backends: [{ id: 'b', url: process.argv[2], state: 'live' }], log: () => {} });
let baseline = process.memoryUsage().rss; let peak = baseline;
// Retain observed relays to check that timers clear even after removal from Edge.
const observed = new Set<{ upstream: { readyState: number }; retryTimer?: ReturnType<typeof setTimeout>; client?: { close(code: number, reason: string): void } }>();
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
  process.send?.({ baseline, peak, closeCalls, activeRelays: relays.size, activeUpstreams: [...observed].filter(r => r.upstream.readyState !== 3).length, relayTimers: [...observed].filter(r => r.retryTimer !== undefined).length, status: edge.status() });
});
console.log(edge.server.url.href);
