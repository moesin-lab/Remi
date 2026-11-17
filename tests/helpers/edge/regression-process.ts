export {};
// Optional source path is used only by the before/after memory benchmark.
const { Edge } = await import(process.argv[4] ?? '../../../packages/edge/src/index');
const edge = new Edge({ wsStallTimeoutMs: Number(process.argv[3] ?? 30000), port: 0, holdMaxMs: 5000, healthIntervalMs: 100000,
  backends: [{ id: 'b', url: process.argv[2], state: 'live' }], log: () => {} });
let baseline = process.memoryUsage().rss; let peak = baseline;
let concatBytes = 0;
let started = performance.now();
let lastSecond = -1;
let timeline: { second: number; rss: number; external: number; arrayBuffers: number }[] = [];
const concat = Buffer.concat;
Buffer.concat = ((...args: Parameters<typeof Buffer.concat>) => {
  const result = concat(...args); concatBytes += result.length; return result;
}) as typeof Buffer.concat;
let maxima = { heapUsed: 0, external: 0, arrayBuffers: 0, parser: 0, pending: 0, downstream: 0, upstream: 0, readable: 0 };
function sample() {
  const memory = process.memoryUsage(); peak = Math.max(peak, memory.rss);
  const second = Math.floor((performance.now() - started) / 1000);
  if (second !== lastSecond && timeline.length < 120) { lastSecond = second; timeline.push({ second, rss: memory.rss, external: memory.external, arrayBuffers: memory.arrayBuffers }); }
  for (const key of ['heapUsed', 'external', 'arrayBuffers'] as const) maxima[key] = Math.max(maxima[key], memory[key]);
  for (const r of relays as unknown as Set<{ bytes: number; client?: { getBufferedAmount(): number }; upstream: { buffer: Buffer; fragmentBytes: number; networkReadBytes?: () => number; framePayload?: Buffer; sparePayload?: Buffer; bufferedAmount: number } }>) {
    maxima.parser = Math.max(maxima.parser, r.upstream.buffer.length + r.upstream.fragmentBytes + (r.upstream.framePayload?.length ?? 0) + (r.upstream.sparePayload?.length ?? 0));
    maxima.pending = Math.max(maxima.pending, r.bytes);
    maxima.downstream = Math.max(maxima.downstream, r.client?.getBufferedAmount() ?? 0);
    maxima.readable = Math.max(maxima.readable, r.upstream.networkReadBytes?.() ?? 0);
    maxima.upstream = Math.max(maxima.upstream, r.upstream.bufferedAmount);
  }
}

// Retain observed relays to check that timers clear even after removal from Edge.
const observed = new Set<{ retryTimer?: ReturnType<typeof setTimeout>; client?: { close(code: number, reason: string): void } }>();
const clients = new WeakSet<object>();
const closeCalls: { code: number; reason: string }[] = [];
const relays = (edge as unknown as { relays: typeof observed }).relays;
const timer = setInterval(() => {
  sample();
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
  if (message === 'start') { Bun.gc(true); baseline = process.memoryUsage().rss; peak = baseline; concatBytes = 0; started = performance.now(); lastSecond = -1; timeline = []; for (const key of Object.keys(maxima) as (keyof typeof maxima)[]) maxima[key] = 0; }
  if (message === 'gc') Bun.gc(true);
  sample();
  if (message === 'stop') { clearInterval(timer); edge.stop(); process.exit(0); }
  process.send?.({ baseline, peak, memory: process.memoryUsage(), concatBytes, maxima, timeline, closeCalls, activeRelays: relays.size, relayTimers: [...observed].filter(r => r.retryTimer !== undefined).length, status: edge.status() });
});
console.log(edge.server.url.href);
