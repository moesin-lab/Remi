// Real child process implementing only the slot protocol for supervisor tests.
import { readFileSync } from 'node:fs';
const config = JSON.parse(readFileSync('behavior.json', 'utf8'));
if (config.immediateExit) process.exit(1);
let state = 'standby', healthy = true;
Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.MULTIREMI_PORT), async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path.startsWith('/internal/slot/')) {
    if (request.headers.get('authorization') !== 'Bearer ' + process.env.MULTIREMI_SLOT_CONTROL_TOKEN) return new Response('', { status: 401 });
    if (path.endsWith('/activate')) {
      if (config.activateFails) return new Response('', { status: 503 });
      state = 'active';
      if (config.unhealthyAfter) setTimeout(() => { healthy = false; }, config.unhealthyAfter);
      if (config.crashAfter) setTimeout(() => process.exit(1), config.crashAfter);
    }
    if (path.endsWith('/release')) {
      state = config.releaseFails ? 'draining' : 'released';
      if (config.releaseFails) return new Response('', { status: 503 });
    }
    if (path.endsWith('/exit')) setTimeout(() => process.exit(0), 10);
    return Response.json({ state: config.neverStandby ? 'starting' : state });
  }
  if (path === '/readyz') return Response.json({ term: config.noTerm ? null : '1' }, { status: state === 'active' && healthy && !config.neverReady ? 200 : 503 });
  return new Response(config.name, { status: state === 'active' ? 200 : 503 });
} });
