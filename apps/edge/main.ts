import { startEdge, type Backend } from '../../packages/edge/src/index';

const edge = startEdge({
  hostname: process.env.EDGE_HOST ?? '0.0.0.0',
  port: Number(process.env.EDGE_PORT ?? 16120),
  controlSocket: process.env.EDGE_CONTROL_SOCKET,
  backends: JSON.parse(process.env.EDGE_BACKENDS ?? '[]') as Backend[],
  holdMaxMs: Number(process.env.EDGE_HOLD_MAX_MS ?? 60000),
  maxWaiting: Number(process.env.EDGE_MAX_WAITING ?? 4096),
});
console.log(`edge: listening ${edge.server.url}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void edge.stop());
