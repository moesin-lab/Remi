import { Edge } from '../../../packages/edge/src/index';
const edge = new Edge({ port: 0, backends: [{ id: 'b', url: process.argv[2], state: 'live' }], log: () => {} });
let baseline = 0; let peak = 0;
const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 2);
process.on('message', message => {
  if (message === 'start') { Bun.gc(true); baseline = process.memoryUsage().rss; peak = baseline; process.send?.({ baseline }); }
  if (message === 'report') process.send?.({ baseline, peak });
  if (message === 'stop') { clearInterval(timer); edge.stop(); process.exit(0); }
});
console.log(edge.server.url.href);
