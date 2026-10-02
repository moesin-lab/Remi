import { execFileSync } from 'node:child_process';

// Credentials stay in memory; this probe never prints headers or response bodies.
const token = execFileSync(process.execPath, ['scripts/local-profile.mjs', 'stable', 'token'], { encoding: 'utf8' }).trim();
for (const [port, path, auth] of [[16120, '/readyz', false], [13000, '/login', false], [13000, '/api/me', true], [13000, '/api/workspaces', true]]) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: auth ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  if (path === '/api/me' && !response.headers.has('set-cookie')) throw new Error('Missing authenticated session cookie');
  console.log(`${path}: OK`);
}
await new Promise((resolve, reject) => {
  const ws = new WebSocket('ws://127.0.0.1:16120/ws?workspace_id=local');
  const timer = setTimeout(() => { ws.close(); reject(new Error('WebSocket auth timeout')); }, 15000);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', payload: { token } }));
  ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket connection failed')); };
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === 'auth_ack') ws.send(JSON.stringify({ type: 'ping' }));
    if (message.type === 'pong') { clearTimeout(timer); ws.close(); resolve(); }
  };
});
console.log('WebSocket authenticated round trip: OK');
