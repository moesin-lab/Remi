// Test-release-only wrapper around the REAL API. Never load in a base image.
import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export function installFault(mode, releaseId) {
  if (process.env.MUL172_ISOLATED !== '1' || !['never-ready', 'activate-crash', 'crash-after-30s'].includes(mode)
    || !/^[a-zA-Z0-9_-]{1,100}$/.test(releaseId)) throw new Error('Phase A faults require an isolated candidate and explicit release');
  const control = join(process.env.REMI_SUPERVISOR_CONTROL || '/remi-control', 'api');
  const record = event => {
    const path = join(control, `mul172-fault-${releaseId}.json`), temp = path + '.' + process.pid + '.tmp';
    writeFileSync(temp, JSON.stringify({ releaseId, mode, pid: process.pid, ...event }) + '\n', { mode: 0o600 });
    renameSync(temp, path);
  };
  const original = Bun.serve.bind(Bun);
  let armedAt = null, denied = false;
  Bun.serve = options => {
    if (typeof options.fetch !== 'function') throw new Error('Phase A requires a real API fetch handler');
    const handler = options.fetch;
    return original({ ...options, async fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path === '/internal/slot/activate' && request.method === 'POST' && mode === 'activate-crash') {
        record({ event: 'activate_exit', at: Date.now() }); process.exit(86);
      }
      const response = await handler.call(this, request, server);
      if (path === '/readyz' && response?.status === 200) {
        if (mode === 'never-ready') {
          if (!denied) { denied = true; record({ event: 'active_ready_denied', at: Date.now() }); }
          return Response.json({ error: 'mul172_injected_not_ready' }, { status: 503 });
        }
        // Edge overwrites this header; supervisor's direct loopback probe lacks
        // it. Start only after the candidate receives a public edge request.
        if (mode === 'crash-after-30s' && armedAt === null && request.headers.has('x-real-ip')) {
          armedAt = Date.now(); record({ event: 'crash_armed', at: armedAt });
          setTimeout(() => { record({ event: 'public_live_exit', armedAt, at: Date.now() }); process.exit(87); }, 30000);
        }
      }
      return response;
    } });
  };
}
