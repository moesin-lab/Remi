import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { SqlDatabase } from '@multiremi/store/db/postgres.js';
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import { runMigrations } from '@multiremi/store/migrations.js';
import { expandJwtMaterials } from '@multiremi/store/jwt-material-schema.js';
import { compactJwtDigest, JwtMaterials, JwtMaterialUnavailable } from '@multiremi/store/jwt-materials.js';
import { withSecurityWrite } from '@multiremi/store/security-write.js';
import { MultiremiStore } from '@multiremi/store.js';
import { createJwtBrowserClientGuard } from '@multiremi/api/realtime.js';
import type { MultiremiWebSocketClient } from '@multiremi/api/helpers/realtime-types.js';

let sqlite: ReturnType<typeof openSqliteDatabase>;
let db: SqlDatabase;
let materials: JwtMaterials;
const signing = { domainId: 'isolated-dashboard', keyEpoch: 'fixture-1', secret: 'synthetic-jwt-key-for-isolated-tests' };
const input = { credentialId: 'jwt-fixture', materialVersion: 1, expectedVersion: 0, subjectType: 'user',
  subjectId: 'fixture-user', purpose: 'dashboard', familyId: 'family', nodeId: 'material', generation: 1 } as const;
let exp: number;

// Explicit persisted source graphs exercise the registrar contract only. Real
// password verification and HTTP/WS issuance are covered by issuer integration.
beforeEach(() => {
  sqlite = openSqliteDatabase();
  db = sqlite as unknown as SqlDatabase;
  runMigrations(db);
  expandJwtMaterials(db);
  materials = new JwtMaterials(db);
  exp = Math.floor(Date.now() / 1000) + 600;
  const expires = (exp + 600) * 1000;
  for (const [id, seq, kind, parents] of [
    ['identity', 1, 'independent_identity', 0], ['password', 2, 'password', 1],
    ['family-node', 3, 'credential_family', 1], ['material', 4, 'jwt_material', 1],
    ['other-family-node', 5, 'credential_family', 0],
  ] as const) {
    db.run(`INSERT INTO multiremi_authority_nodes VALUES(?,?,1,?,'user','fixture-user','system',0,?,NULL,?)`, id, seq, kind, expires, parents);
  }
  for (const [child, childSeq, parent, parentSeq] of [
    ['password', 2, 'identity', 1], ['family-node', 3, 'password', 2], ['material', 4, 'family-node', 3],
  ] as const) db.run("INSERT INTO multiremi_authority_edges VALUES(?,1,?,?,1,?,'continuous')", child, childSeq, parent, parentSeq);
  db.run("INSERT INTO multiremi_credential_families VALUES('family','family-node',?,NULL,0)", expires);
  db.run("INSERT INTO multiremi_credential_families VALUES('other-family','other-family-node',?,NULL,0)", expires);
  db.run('INSERT INTO multiremi_jwt_signing_domains VALUES(?,?,?)', signing.domainId, signing.keyEpoch, compactJwtDigest(signing.secret));
});
afterEach(() => sqlite.close());

function issue(override = {}) {
  return withSecurityWrite(db, undefined, { expectedRevision: 0, workspaceIds: [], numberKeys: [],
    domainTargets: ['authority:material', 'jwt:jwt-fixture'] }, tx => materials.issue(tx, { ...input, ...override }, { exp }, signing));
}
function raceSecurityRevision(conflicts: number) {
  let attempts = 0;
  const errors: unknown[] = [];
  const racingDb = new Proxy(db, {
    get(target, key) {
      if (key === 'transaction') return <T>(callback: () => T) => () => {
        attempts++;
        // Commit another writer's revision after the pre-read, before the real
        // transaction takes its lock. It must survive that attempt's rollback.
        if (attempts <= conflicts) target.run('UPDATE multiremi_security_state SET security_revision=security_revision+1 WHERE singleton=1');
        try { return target.transaction(callback)(); }
        catch (error) { errors.push(error); throw error; }
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { materials: new JwtMaterials(racingDb), errors, get attempts() { return attempts; } };
}

function sign(claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${body}.${createHmac('sha256', signing.secret).update(`${header}.${body}`).digest('base64url')}`;
}

test('records the exact compact digest and current version with source binding in one transaction', () => {
  const token = issue();
  expect(materials.validate(token, signing)).toEqual({ userId: input.subjectId, digest: compactJwtDigest(token) });
  expect(materials.validateDigest(compactJwtDigest(token), signing)?.userId).toBe(input.subjectId);
  expect(db.query('SELECT credential_id,material_version,subject_id,purpose,family_id FROM multiremi_jwt_materials').get())
    .toEqual({ credential_id: input.credentialId, material_version: 1, subject_id: input.subjectId, purpose: 'dashboard', family_id: 'family' });
  expect(() => issue()).toThrow('credential_version_conflict');
  expect(db.query('SELECT count(*) AS n FROM multiremi_jwt_materials').get().n).toBe(1);
});

test('validateDigest retries a transient security revision conflict and accepts current material', () => {
  const digest = compactJwtDigest(issue());
  const race = raceSecurityRevision(1);
  expect(race.materials.validateDigest(digest, signing)).toEqual({ userId: input.subjectId, digest });
  expect(race.attempts).toBe(2);
  expect(race.errors).toEqual([expect.objectContaining({ code: 'authority_revision_conflict' })]);
  expect(db.query('SELECT security_revision FROM multiremi_security_state WHERE singleton=1').get().security_revision).toBe(1);
  expect(db.inTransaction).toBe(false);
});

test('validateDigest throws unavailable after three consecutive security revision conflicts', () => {
  const digest = compactJwtDigest(issue());
  const race = raceSecurityRevision(3);
  expect(() => race.materials.validateDigest(digest, signing)).toThrow(JwtMaterialUnavailable);
  expect(race.attempts).toBe(3);
  expect(race.errors).toEqual(Array.from({ length: 3 }, () => expect.objectContaining({ code: 'authority_revision_conflict' })));
  expect(db.query('SELECT security_revision FROM multiremi_security_state WHERE singleton=1').get().security_revision).toBe(3);
  expect(db.inTransaction).toBe(false);
  // The material is still valid; exhaustion reports contention, not revocation.
  expect(materials.validateDigest(digest, signing)).toEqual({ userId: input.subjectId, digest });
});

test('valid signatures cannot register on first use and changes to a registered compact are rejected', () => {
  expect(materials.validate(sign({ sub: input.subjectId, exp }), signing)).toBeNull();
  expect(db.query('SELECT count(*) AS n FROM multiremi_jwt_materials').get().n).toBe(0);
  const token = issue();
  const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
  for (const update of [{ sub: 'other-user' }, { exp: exp + 1 }, { purpose: 'cli' }, { material_version: 2 }, { iat: exp + 100 }]) {
    expect(materials.validate(sign({ ...claims, ...update }), signing)).toBeNull();
  }
  expect(materials.validate(`${token.slice(0, -3)}bad`, signing)).toBeNull();
});

for (const [name, sql] of [
  ['material revocation', 'UPDATE multiremi_jwt_materials SET revoked_at_ms=1'],
  ['family revocation', "UPDATE multiremi_credential_families SET revoked_at_ms=1 WHERE family_id='family'"],
  ['ancestor revocation', "UPDATE multiremi_authority_nodes SET revoked_at_ms=1 WHERE node_id='identity'"],
  ['ancestor expiry', "UPDATE multiremi_authority_nodes SET expires_at_ms=1 WHERE node_id='password'"],
  ['key epoch rotation', "UPDATE multiremi_jwt_signing_domains SET key_epoch='fixture-2'"],
  ['key replacement', "UPDATE multiremi_jwt_signing_domains SET key_digest='different'"],
  ['unrelated valid family', "UPDATE multiremi_jwt_materials SET family_id='other-family'"],
  ['agent-origin ancestry', "UPDATE multiremi_authority_nodes SET subject_type='agent' WHERE node_id='identity'"],
  ['missing continuous parent', "DELETE FROM multiremi_authority_edges WHERE child_id='password'"],
  ['wrong purpose', "UPDATE multiremi_jwt_materials SET purpose='cli'"],
  ['wrong subject', "UPDATE multiremi_jwt_materials SET subject_id='different'"],
  ['wrong signing domain', "UPDATE multiremi_jwt_materials SET key_epoch='different'"],
] as const) test(`re-reads primary state and rejects ${name}`, () => {
  const token = issue();
  db.run(sql);
  expect(materials.validate(token, signing)).toBeNull();
  expect(materials.validateDigest(compactJwtDigest(token), signing)).toBeNull();
});

test('unrelated family and missing or mismatched issuance domain roll back registration', () => {
  expect(() => issue({ familyId: 'other-family' })).toThrow('root_authority_revoked');
  db.run('DELETE FROM multiremi_jwt_signing_domains');
  expect(() => issue()).toThrow('root_authority_revoked');
  expect(db.query('SELECT count(*) AS n FROM multiremi_jwt_current').get().n).toBe(0);
});

test('current version supersedes earlier material and stale CAS cannot replace it', () => {
  const first = issue();
  db.run("INSERT INTO multiremi_authority_nodes SELECT 'next-material',6,1,kind,subject_type,subject_id,scope,revision,expires_at_ms,NULL,1 FROM multiremi_authority_nodes WHERE node_id='material'");
  db.run("INSERT INTO multiremi_authority_edges VALUES('next-material',1,6,'family-node',1,3,'continuous')");
  const second = withSecurityWrite(db, undefined, { expectedRevision: 0, workspaceIds: [], numberKeys: [],
    domainTargets: ['authority:next-material', 'jwt:jwt-fixture'] }, tx => materials.issue(tx,
      { ...input, nodeId: 'next-material', materialVersion: 2, expectedVersion: 1 }, { exp }, signing));
  expect(materials.validate(first, signing)).toBeNull();
  expect(materials.validateDigest(compactJwtDigest(first), signing)).toBeNull();
  expect(materials.validate(second, signing)?.userId).toBe(input.subjectId);
  expect(() => issue()).toThrow('credential_version_conflict');
});

test('expiry, future times and non-dashboard issuance cannot become dashboard authentication', () => {
  for (const claims of [{ exp: 1 }, { exp, nbf: exp + 60 }, { exp, iat: exp + 60 }, { exp: Number.MAX_SAFE_INTEGER }]) {
    expect(() => withSecurityWrite(db, undefined, { expectedRevision: 0, workspaceIds: [], numberKeys: [],
      domainTargets: ['authority:material', 'jwt:jwt-fixture'] }, tx => materials.issue(tx, input, claims, signing))).toThrow();
  }
  expect(materials.validate(issue({ purpose: 'cli' }), signing)).toBeNull();
});

test('final socket send checks current ancestry after an asynchronous projection completes', async () => {
  const token = issue();
  const store = new MultiremiStore(db);
  db.run("UPDATE multiremi_security_state SET feature_activation=1,bootstrap_completed=1,minimum_enforcement_version='fixture'");
  const env = { JWT_SECRET: process.env.JWT_SECRET, MULTIREMI_JWT_SIGNING_DOMAIN: process.env.MULTIREMI_JWT_SIGNING_DOMAIN,
    MULTIREMI_JWT_KEY_EPOCH: process.env.MULTIREMI_JWT_KEY_EPOCH };
  Object.assign(process.env, { JWT_SECRET: signing.secret, MULTIREMI_JWT_SIGNING_DOMAIN: signing.domainId, MULTIREMI_JWT_KEY_EPOCH: signing.keyEpoch });
  const sent: string[] = [];
  const closes: Array<number | undefined> = [];
  const client: MultiremiWebSocketClient = { data: { kind: 'browser', connectedAt: 'fixture', workspaceId: 'local',
    authenticated: true, userId: 'local', accessToken: null, jwtDigest: compactJwtDigest(token) },
    sendText: message => { sent.push(message); }, close: code => { closes.push(code); } };
  try {
    const wrap = createJwtBrowserClientGuard(store);
    const guarded = wrap(client);
    expect(wrap(client)).toBe(guarded);
    guarded.sendText('before');
    expect(sent).toEqual(['before']);
    let resume!: () => void;
    const projection = new Promise<void>(resolve => { resume = resolve; });
    const delivery = (async () => { await projection; guarded.sendText('after'); })();
    db.run("UPDATE multiremi_authority_nodes SET revoked_at_ms=1 WHERE node_id='identity'");
    resume();
    await delivery;
    expect(sent).toEqual(['before']);
    expect(closes).toEqual([1008]);
    db.run('DELETE FROM multiremi_security_state');
    guarded.sendText('unavailable');
    expect(sent).toEqual(['before']);
    expect(closes).toEqual([1008, 1011]);
  } finally {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('primary state unavailability raises an explicit unavailable failure', () => {
  const token = issue();
  expect(materials.isActive()).toBe(false);
  db.run('DELETE FROM multiremi_security_state');
  expect(() => materials.isActive()).toThrow(JwtMaterialUnavailable);
  expect(() => materials.validate(token, signing)).toThrow(JwtMaterialUnavailable);
});
