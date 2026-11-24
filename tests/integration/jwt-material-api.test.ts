import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MultiremiStore } from '@multiremi/store.js';
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import type { SqlDatabase } from '@multiremi/store/db/postgres.js';
import { expandJwtMaterials } from '@multiremi/store/jwt-material-schema.js';
import { compactJwtDigest, JwtMaterials } from '@multiremi/store/jwt-materials.js';
import { withSecurityWrite } from '@multiremi/store/security-write.js';
import { ApiChild, freePort, twoProcessChildEnv } from '../helpers/two-process.js';
import { authenticateBrowserWebSocket, nextWebSocketMessage, waitWebSocketOpen } from '../unit/multiremi/helpers.js';

// Explicit synthetic source graphs test the transport/registrar contract. This
// does not establish a production password issuer or positive root authority.
const directory = mkdtempSync(join(tmpdir(), 'mul15-jwt-api-'));
const children: ApiChild[] = [];
const sockets: WebSocket[] = [];
const signing = { domainId: 'isolated-api', keyEpoch: 'fixture-epoch', secret: 'synthetic-api-jwt-key' };
let sqlite: ReturnType<typeof openSqliteDatabase>;
let db: SqlDatabase;
let taskId: string;
let jwt: string;
let controlJwt: string;
let controlPat: string;
let legacyJwt: string;

beforeAll(async () => {
  const sqliteFile = join(directory, 'store.sqlite');
  sqlite = openSqliteDatabase(sqliteFile);
  db = sqlite as unknown as SqlDatabase;
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  const agent = store.createAgent({ name: 'JWT fixture target', workspaceId: 'local', provider: 'codex', visibility: 'private' });
  taskId = store.createTask({ agentId: agent.id, workspaceId: 'local', prompt: 'Synthetic JWT transport' }).id;
  controlPat = (await store.createAccessToken({ name: 'control', type: 'pat', workspaceId: 'local' })).token;
  expandJwtMaterials(db);
  db.run('INSERT INTO multiremi_jwt_signing_domains VALUES(?,?,?)', signing.domainId, signing.keyEpoch, compactJwtDigest(signing.secret));
  const exp = Math.floor(Date.now() / 1000) + 600;
  let seq = 0;
  function issue(prefix: string): string {
    let previous: { id: string; seq: number } | undefined;
    for (const [name, kind] of [['identity', 'independent_identity'], ['password', 'password'],
      ['family', 'credential_family'], ['material', 'jwt_material']]) {
      const id = `${prefix}-${name}`;
      const currentSeq = ++seq;
      db.run("INSERT INTO multiremi_authority_nodes VALUES(?,?,1,?,'user','local','system',0,?,NULL,?)", id, currentSeq, kind, exp * 1000, previous ? 1 : 0);
      if (previous) db.run("INSERT INTO multiremi_authority_edges VALUES(?,1,?,?,1,?,'continuous')", id, currentSeq, previous.id, previous.seq);
      previous = { id, seq: currentSeq };
    }
    db.run('INSERT INTO multiremi_credential_families VALUES(?,?,?,NULL,0)', `${prefix}-family`, `${prefix}-family`, exp * 1000);
    return withSecurityWrite(db, undefined, { expectedRevision: 0, workspaceIds: [], numberKeys: [],
      domainTargets: [`authority:${prefix}-material`, `jwt:${prefix}-jwt`] }, tx => new JwtMaterials(db).issue(tx, {
      credentialId: `${prefix}-jwt`, materialVersion: 1, expectedVersion: 0, subjectType: 'user', subjectId: 'local',
      purpose: 'dashboard', familyId: `${prefix}-family`, nodeId: `${prefix}-material`, generation: 1,
    }, { exp }, signing));
  }
  jwt = issue('observer');
  controlJwt = issue('control');
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 'local', exp })).toString('base64url');
  legacyJwt = `${header}.${payload}.${createHmac('sha256', signing.secret).update(`${header}.${payload}`).digest('base64url')}`;
  const master = randomUUID();
  for (let index = 0; index < 2; index++) {
    const port = await freePort();
    const child = new ApiChild(port, { ...twoProcessChildEnv(), NODE_ENV: 'test', MULTIREMI_PORT: String(port),
      MULTIREMI_TEST_ROOT_API_SQLITE_FILE: sqliteFile, MULTIREMI_DATABASE_URL: undefined, MULTIREMI_TOKEN: master,
      JWT_SECRET: signing.secret, MULTIREMI_JWT_SIGNING_DOMAIN: signing.domainId, MULTIREMI_JWT_KEY_EPOCH: signing.keyEpoch,
      MULTIREMI_ALLOW_PASSWORD_LOGIN: '1', MULTIREMI_BACKGROUND_JOBS: '0',
    }, join(import.meta.dir, '../helpers/root-api-child.ts'));
    children.push(child);
    await child.waitEvent('prepared');
    child.start();
    await child.ready();
  }
}, 30_000);
afterAll(async () => {
  for (const socket of sockets) socket.close();
  await Promise.all(children.map(child => child.stop()));
  sqlite?.close();
  rmSync(directory, { recursive: true, force: true });
});
function socketAt(child: ApiChild) {
  const socket = new WebSocket(`${child.url.replace('http:', 'ws:')}/api/trace/ws?workspace_id=local`);
  sockets.push(socket);
  return socket;
}
async function subscribe(socket: WebSocket) {
  const ack = nextWebSocketMessage(socket);
  socket.send(JSON.stringify({ type: 'stream.subscribe', payload: { stream: 'trace', id: taskId, from_seq: 0 } }));
  expect(await ack).toMatchObject({ type: 'stream.ack' });
}
function closed(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket close deadline exceeded')), 3000);
    socket.addEventListener('close', event => { clearTimeout(timer); resolve(event); }, { once: true });
  });
}

test('two real APIs enforce activation and current ancestry for HTTP, cookie and WS without broadcasts', async () => {
  const [first, second] = children as [ApiChild, ApiChild];
  expect(first.process.pid).not.toBe(second.process.pid);
  const legacySocket = socketAt(second);
  await authenticateBrowserWebSocket(legacySocket, legacyJwt);
  expect((await fetch(`${first.url}/api/agents`, { headers: { Authorization: `Bearer ${legacyJwt}` } })).status).toBe(200);
  expect((await fetch(`${first.url}/api/config`).then(response => response.json())).jwt_registration_required).toBe(false);
  db.run("UPDATE multiremi_security_state SET feature_activation=1,bootstrap_completed=1,minimum_enforcement_version='isolated-test'");
  expect((await fetch(`${first.url}/api/config`).then(response => response.json())).jwt_registration_required).toBe(true);
  for (const child of children) for (const path of ['/api/agents', '/api/multiremi/agents']) {
    expect((await fetch(`${child.url}${path}`, { headers: { Authorization: `Bearer ${jwt}` } })).status).toBe(200);
    expect((await fetch(`${child.url}${path}`, { headers: { Cookie: `multimira_auth=${jwt}` } })).status).toBe(200);
    expect((await fetch(`${child.url}${path}`, { headers: { Authorization: `Bearer ${legacyJwt}` } })).status).toBe(401);
    for (const Authorization of ['Bearer invalid', 'Bearer', 'Basic invalid', '']) {
      expect((await fetch(`${child.url}${path}`, { headers: { Authorization, Cookie: `multimira_auth=${jwt}` } })).status).toBe(401);
    }
  }
  const legacyClosed = closed(legacySocket);
  legacySocket.send(JSON.stringify({ type: 'ping' }));
  expect((await legacyClosed).code).toBe(1008);
  const observer = socketAt(second);
  await authenticateBrowserWebSocket(observer, jwt);
  await subscribe(observer);
  const control = socketAt(second);
  await authenticateBrowserWebSocket(control, controlJwt);
  await subscribe(control);
  const observerFrame = nextWebSocketMessage(observer);
  const controlFrame = nextWebSocketMessage(control);
  await second.call('trace', { taskId, seq: 1, marker: 'before-revoke' });
  expect(JSON.stringify(await observerFrame)).toContain('before-revoke');
  expect(JSON.stringify(await controlFrame)).toContain('before-revoke');
  const revokedMessages: string[] = [];
  observer.addEventListener('message', event => revokedMessages.push(String(event.data)));
  const observerClosed = closed(observer);
  db.run("UPDATE multiremi_authority_nodes SET revoked_at_ms=1 WHERE node_id='observer-identity'");
  const controlNext = nextWebSocketMessage(control);
  await second.call('trace', { taskId, seq: 2, marker: 'after-revoke' });
  expect((await observerClosed).code).toBe(1008);
  expect(JSON.stringify(await controlNext)).toContain('after-revoke');
  expect(revokedMessages.some(message => message.includes('after-revoke'))).toBe(false);
  for (const child of children) {
    expect((await fetch(`${child.url}/api/agents`, { headers: { Authorization: `Bearer ${jwt}` } })).status).toBe(401);
    expect((await fetch(`${child.url}/api/agents`, { headers: { Authorization: `Bearer ${controlJwt}` } })).status).toBe(200);
    expect((await fetch(`${child.url}/api/agents`, { headers: { Authorization: `Bearer ${controlPat}` } })).status).toBe(200);
  }
  const denied = socketAt(first);
  await waitWebSocketOpen(denied);
  const denial = nextWebSocketMessage(denied);
  denied.send(JSON.stringify({ type: 'auth', payload: { token: legacyJwt } }));
  expect(await denial).toEqual({ error: 'invalid token' });
  for (const path of ['/auth/password', '/api/cli-token', '/api/tokens', '/api/tokens/current/renew', '/api/multiremi/tokens']) {
    expect((await fetch(`${first.url}${path}`, { method: 'POST', headers: {
      Authorization: `Bearer ${controlJwt}`, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ email: 'fixture@example.invalid', password: 'synthetic-password' }) })).status).toBe(503);
  }
}, 30_000);
