import { startEdge, type Backend } from '../../packages/edge/src/index';

const port = process.env.EDGE_PORT;
if (port !== undefined && !port.trim()) throw new Error('Invalid EDGE_PORT');

const edge = startEdge({
  hostname: process.env.EDGE_HOST ?? '127.0.0.1',
  port: Number(port ?? 16120),
  controlSocket: process.env.EDGE_CONTROL_SOCKET,
  backends: JSON.parse(process.env.EDGE_BACKENDS ?? '[]') as Backend[],
  holdMaxMs: Number(process.env.EDGE_HOLD_MAX_MS ?? 60000),
  maxWaiting: Number(process.env.EDGE_MAX_WAITING ?? 4096),
});
console.log(`edge: listening ${edge.server.url}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void edge.stop());
