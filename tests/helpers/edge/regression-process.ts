import { Edge } from '../../../packages/edge/src/index';
const edge = new Edge({ port: 0, holdMaxMs: 5000, healthIntervalMs: 100000,
  backends: [{ id: 'b', url: process.argv[2], state: 'live' }], log: () => {} });
let baseline = process.memoryUsage().rss; let peak = baseline;
const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 2);
process.on('message', message => {
  if (message === 'hold') edge.hold();
  if (message === 'standby') { edge.unhold(); edge.setState('b', 'standby'); }
  if (message === 'live') { edge.setState('b', 'live'); edge.unhold(); }
  if (message === 'start') { Bun.gc(true); baseline = process.memoryUsage().rss; peak = baseline; }
  if (message === 'stop') { clearInterval(timer); edge.stop(); process.exit(0); }
  process.send?.({ baseline, peak, status: edge.status() });
});
console.log(edge.server.url.href);
