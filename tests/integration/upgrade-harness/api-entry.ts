/** Real API/store plus authenticated test controls, compiled separately for each ref. */
import { startMultiremiServer } from '@multiremi/api.js';
import { MultiremiStore } from '@multiremi/store.js';
import { openMultiremiDatabase } from '@multiremi/store/db/postgres.js';
import { readFileSync } from 'node:fs';
import { version } from '../../../package.json';
if (process.env.NODE_ENV !== 'test' || process.env.MULTIREMI_UPGRADE_HARNESS !== '1') throw new Error('Test-only API requires explicit harness opt-in');
const db = openMultiremiDatabase();
const store = new MultiremiStore(db);
store.ensureLocalWorkspace();
const server = startMultiremiServer({ store, scheduler: null, backgroundJobs: false, hostname: '0.0.0.0', port: 6120,
  authToken: process.env.FIXTURE_ADMIN_TOKEN!, platformUpdaterToken: process.env.FIXTURE_UPDATER_TOKEN! });
// A separate loopback-in-network control server avoids adding routes to production API code.
Bun.serve({ hostname: '0.0.0.0', port: 6121, async fetch(request) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.FIXTURE_ADMIN_TOKEN}`) return new Response('unauthorized', { status: 401 });
  const path = new URL(request.url).pathname;
  if (path === '/version') return Response.json({ version, sha: JSON.parse(readFileSync(new URL('../../../harness-provenance.json', import.meta.url), 'utf8')).sha });
  if (path === '/token' && request.method === 'POST') return Response.json(await store.createAccessToken({ name: 'isolated harness', type: 'daemon', workspaceId: 'local', daemonId: 'upgrade-harness' }));
  if (path === '/task' && request.method === 'POST') {
    const agent = store.createAgent({ name: 'Fake ACP upgrade', provider: 'codex' });
    const chat = store.createChatSession({ agentId: agent.id });
    const task = store.sendChatMessage(chat.id, { body: 'Exercise isolated upgrade' }).task;
    return Response.json({ id: task.id, turnId: store.getTurnForAttempt(task.id)!.id });
  }
  if (path.startsWith('/attempts/')) {
    const turnId = decodeURIComponent(path.slice('/attempts/'.length));
    return Response.json(db.query('SELECT id,turn_id,attempt_no,status,failure_reason FROM multiremi_turn_attempts WHERE turn_id=? ORDER BY attempt_no').all(turnId));
  }
  if (path.startsWith('/task/')) return Response.json(store.getTask(path.slice('/task/'.length)));
  if (path === '/runtimes') return Response.json(store.listRuntimes());
  return new Response('missing', { status: 404 });
} });
console.log(`Isolated API listening at ${server.port}; source ${process.env.HARNESS_SOURCE_SHA}`);
