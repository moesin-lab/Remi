import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MultiremiStore } from '@multiremi/store.js';
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import type { SqlDatabase } from '@multiremi/store/db/postgres.js';
import { compactJwtDigest } from '@multiremi/store/jwt-materials.js';
import { bootstrapAuthorizationDigest } from '@multiremi/store/root-management.js';
import { ApiChild, freePort, twoProcessChildEnv } from '../helpers/two-process.js';
import { authenticateBrowserWebSocket, nextWebSocketMessage, waitWebSocketOpen } from '../unit/multiremi/helpers.js';

// Isolated enrollment records establish trusted password sources. Actual HTTP
// password verification, source/family issuance, signing and registration then
// run through production code on the same Store database proxy.
const directory = mkdtempSync(join(tmpdir(), 'mul15-jwt-api-'));
const children: ApiChild[] = [];
const sockets: WebSocket[] = [];
const signing = { domainId: 'isolated-api', keyEpoch: 'fixture-epoch', secret: 'synthetic-api-jwt-key' };
const password = 'synthetic-password-for-isolated-api';
const userIds: Record<string, string> = {};
let sqlite: ReturnType<typeof openSqliteDatabase>;
let db: SqlDatabase;
let taskId: string;
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
  const exp = Math.floor(Date.now() / 1000) + 600;
  let seq = 0;
  for (const name of ['observer', 'control', 'bootstrap']) {
    const account = await store.configurePasswordAccount({ email: `${name}@example.invalid`, password, name });
    userIds[name] = account.user.id;
    const hash = db.query('SELECT password_hash FROM multiremi_password_credentials WHERE user_id=?').get(account.user.id).password_hash;
    const identitySeq = ++seq;
    db.run("INSERT INTO multiremi_authority_nodes VALUES(?,?,1,'independent_identity','user',?,'system',0,?,NULL,0)",
      `${name}-identity`, identitySeq, account.user.id, exp * 1000);
    db.run("INSERT INTO multiremi_authority_nodes VALUES(?,?,1,'password','user',?,'system',0,?,NULL,1)",
      `${name}-password`, ++seq, account.user.id, exp * 1000);
    db.run("INSERT INTO multiremi_authority_edges VALUES(?,1,?,?,1,?,'continuous')", `${name}-password`, seq, `${name}-identity`, identitySeq);
    db.run('INSERT INTO multiremi_password_authority_versions VALUES(?,1,?,?,?)', account.user.id, compactJwtDigest(hash), `${name}-password`, `${name}-identity`);
  }
  await store.configurePasswordAccount({ email: 'unenrolled@example.invalid', password, name: 'Unenrolled control' });
  const bootstrap = { deploymentId: 'fixture-deployment', authorization: 'one-use-synthetic-authorization', userId: userIds.bootstrap!,
    reason: 'isolated signing domain enrollment', expectedRevision: 0,
    dashboardSigningDomain: { domainId: signing.domainId, keyEpoch: signing.keyEpoch, keyDigest: compactJwtDigest(signing.secret) } };
  db.run(`INSERT INTO multiremi_root_bootstrap_authorizations(authorization_digest,deployment_id,user_id,reason,expires_at_ms)
    VALUES(?,?,?,?,?)`, bootstrapAuthorizationDigest(bootstrap), bootstrap.deploymentId, bootstrap.userId, bootstrap.reason, Date.now() + 60_000);
  const proof = await store.rootManagement.verifyIndependentPassword(bootstrap.userId, password);
  store.rootManagement.bootstrapHuman(proof, bootstrap);
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
async function login(child: ApiChild, name: string, value = password) {
  return fetch(`${child.url}/auth/password`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${name}@example.invalid`, password: value }) });
}

test('real password issuance binds registered JWTs used by two APIs and revokes HTTP/cookie/WS without broadcasts', async () => {
  const [first, second] = children as [ApiChild, ApiChild];
  expect(first.process.pid).not.toBe(second.process.pid);
  const legacySocket = socketAt(second);
  await authenticateBrowserWebSocket(legacySocket, legacyJwt);
  expect((await fetch(`${first.url}/api/agents`, { headers: { Authorization: `Bearer ${legacyJwt}` } })).status).toBe(200);
  expect((await fetch(`${first.url}/api/config`).then(response => response.json())).jwt_registration_required).toBe(false);
  db.run("UPDATE multiremi_security_state SET feature_activation=1,minimum_enforcement_version='isolated-test'");
  expect((await fetch(`${first.url}/api/config`).then(response => response.json())).jwt_registration_required).toBe(true);
  expect((await login(first, 'observer', 'incorrect-password')).status).toBe(401);
  expect((await login(first, 'unknown')).status).toBe(401);
  expect((await login(first, 'unenrolled')).status).toBe(401);
  db.run("UPDATE multiremi_jwt_signing_domains SET key_epoch='unregistered-epoch'");
  expect((await login(first, 'observer')).status).toBe(401);
  db.run('UPDATE multiremi_jwt_signing_domains SET key_epoch=?', signing.keyEpoch);
  expect(db.query('SELECT COUNT(*) AS n FROM multiremi_jwt_materials').get().n).toBe(0);
  const observerLogin = await login(first, 'observer');
  expect(observerLogin.status).toBe(200);
  const observerSession = await observerLogin.json();
  const jwt = observerSession.token;
  expect(observerSession.user.id).toBe(userIds.observer);
  expect(observerLogin.headers.get('set-cookie')).toContain('multimira_auth=');
  const controlLogin = await login(second, 'control');
  expect(controlLogin.status).toBe(200);
  const controlJwt = (await controlLogin.json()).token;
  const registered = db.query('SELECT subject_id,family_id,material_version,purpose FROM multiremi_jwt_materials WHERE compact_digest=?').get(compactJwtDigest(jwt));
  expect(registered).toMatchObject({ subject_id: userIds.observer, material_version: 1, purpose: 'dashboard' });
  expect(db.query('SELECT grant_id FROM multiremi_root_grants WHERE subject_id=?').all(userIds.observer)).toEqual([]);
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
    expect((await fetch(`${child.url}/api/agents`, { headers: { Cookie: `multimira_auth=${jwt}` } })).status).toBe(401);
    expect((await fetch(`${child.url}/api/agents`, { headers: { Authorization: `Bearer ${controlJwt}` } })).status).toBe(200);
    expect((await fetch(`${child.url}/api/agents`, { headers: { Authorization: `Bearer ${controlPat}` } })).status).toBe(200);
  }
  expect((await login(first, 'observer')).status).toBe(401);
  const denied = socketAt(first);
  await waitWebSocketOpen(denied);
  const denial = nextWebSocketMessage(denied);
  denied.send(JSON.stringify({ type: 'auth', payload: { token: legacyJwt } }));
  expect(await denial).toEqual({ error: 'invalid token' });
  const tokensBefore = db.query('SELECT COUNT(*) AS n FROM multiremi_access_tokens').get().n;
  const instructions = await fetch(`${first.url}/api/multiremi/install/daemon`, { method: 'POST', headers: {
    Authorization: `Bearer ${controlJwt}`, 'Content-Type': 'application/json',
  }, body: JSON.stringify({ workspace_id: 'local', createToken: false }) });
  expect(instructions.status).toBe(200);
  expect(db.query('SELECT COUNT(*) AS n FROM multiremi_access_tokens').get().n).toBe(tokensBefore);
  for (const path of ['/api/cli-token', '/api/tokens', '/api/tokens/current/renew', '/api/multiremi/tokens', '/api/multiremi/install/daemon']) {
    expect((await fetch(`${first.url}${path}`, { method: 'POST', headers: {
      Authorization: `Bearer ${controlJwt}`, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ workspace_id: 'local' }) })).status).toBe(503);
  }
  db.run('ALTER TABLE multiremi_password_credentials RENAME TO isolated_unavailable_password_credentials');
  try {
    const unavailable = await login(first, 'control');
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: 'authentication state unavailable' });
  } finally {
    db.run('ALTER TABLE isolated_unavailable_password_credentials RENAME TO multiremi_password_credentials');
  }
}, 30_000);
