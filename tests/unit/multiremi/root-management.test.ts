import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SqlDatabase } from '@multiremi/store/db/postgres.js';
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import { runMigrations } from '@multiremi/store/migrations.js';
import type { AuthorityUse, CredentialProof } from '@multiremi/store/root-authority-contract.js';
import type { RevokeCredentialFamilyRequest } from '@multiremi/contracts/root-authority.js';
import { RootManagement } from '@multiremi/store/root-management.js';
import { withSecurityWrite } from '@multiremi/store/security-write.js';

let sqlite: ReturnType<typeof openSqliteDatabase>;
let db: SqlDatabase;
let service: RootManagement;
let proof: CredentialProof;
const family = { action: 'root.credential-family.revoke', actualTarget: { type: 'credential_family', id: 'family' }, use: 'management' };
const grant = { action: 'root.grant.revoke', actualTarget: { type: 'grant', id: 'recipient-grant' }, use: 'management' };
const request = { expected_revision: 0, idempotency_key: 'test-revoke', reason: 'isolated test', reason_code: 'operator_security_revoke' } as const;
const passphrase = 'synthetic-test-password';
const checksum = (value: string) => createHash('sha256').update(value).digest('hex');

beforeEach(async () => {
  sqlite = openSqliteDatabase();
  db = sqlite as unknown as SqlDatabase;
  runMigrations(db);
  const passwordHash = await Bun.password.hash(passphrase, { algorithm: 'argon2id', memoryCost: 19456, timeCost: 2 });
  db.query(`INSERT INTO multiremi_users(id,name,email,created_at,updated_at) VALUES('usr_test','fixture','fixture@example.invalid','now','now')`).run();
  db.query(`INSERT INTO multiremi_password_credentials(user_id,login_email,password_hash,updated_at) VALUES('usr_test','fixture@example.invalid',?,'now')`).run(passwordHash);
  let seq = 0;
  function node(id: string, kind: string, subjectId: string, parents: number) {
    db.query(`INSERT INTO multiremi_authority_nodes VALUES(?,?,1,?,'user',?,'system',0,9999999999999,NULL,?)`).run(id, ++seq, kind, subjectId, parents);
  }
  node('identity', 'independent_identity', 'usr_test', 0);
  node('password', 'password', 'usr_test', 1);
  db.run("INSERT INTO multiremi_authority_edges VALUES('password',1,2,'identity',1,1,'continuous')");
  db.query("INSERT INTO multiremi_password_authority_versions VALUES('usr_test',1,?,'password','identity')").run(checksum(passwordHash));
  for (const [id, user] of [['actor-grant','usr_test'], ['recipient-grant','usr_recipient']]) {
    node(id, 'grant', user!, 0);
    db.query(`INSERT INTO multiremi_root_grants(grant_id,subject_type,subject_id,generation,scope,authority_node_id,
      issuer_type,issuer_id,revision,reason,created_at_ms) VALUES(?,'user',?,1,'system',?,'deployment','fixture',0,'seed',1)`).run(id, user, id);
    db.query("INSERT INTO multiremi_root_subject_state VALUES('user',?,1,?)").run(user, id);
  }
  node('family-node', 'credential_family', 'usr_test', 0);
  node('child', 'credential', 'usr_test', 1);
  db.run("INSERT INTO multiremi_authority_edges VALUES('child',1,6,'family-node',1,5,'continuous')");
  db.run("INSERT INTO multiremi_credential_families VALUES('family','family-node',9999999999999,NULL,0)");
  service = new RootManagement(db);
  proof = await service.verifyIndependentPassword('usr_test', passphrase);
});
afterEach(() => sqlite.close());

function enable() { db.run("UPDATE multiremi_security_state SET feature_activation=1,bootstrap_completed=1,minimum_enforcement_version='fixture'"); }

test('offline bootstrap binds the verified human, deployment and one-use authorization without activating root', () => {
  db.run('DELETE FROM multiremi_root_subject_state');
  db.run('DELETE FROM multiremi_root_grants');
  const input = { deploymentId: 'synthetic-deployment', authorization: 'synthetic-offline-ticket', userId: 'usr_test', reason: 'fixture enrollment', expectedRevision: 0 };
  db.query(`INSERT INTO multiremi_root_bootstrap_authorizations(authorization_digest,deployment_id,user_id,reason,expires_at_ms)
    VALUES(?,?,?,?,?)`).run(checksum(input.authorization),input.deploymentId,input.userId,input.reason,Date.now()+60_000);
  expect(() => service.bootstrapHuman(proof,{ ...input, deploymentId: 'another-deployment' })).toThrow('root_required');
  const created = service.bootstrapHuman(proof,input);
  expect(created.grant).toMatchObject({ generation: 1,effective: false,effective_reason_code: 'feature_disabled',issuer: { type: 'deployment',id: input.deploymentId } });
  expect(db.query('SELECT feature_activation,bootstrap_completed,security_revision FROM multiremi_security_state').get())
    .toEqual({ feature_activation: 0,bootstrap_completed: 1,security_revision: 1 });
  expect(() => service.bootstrapHuman(proof,{ ...input,expectedRevision: 1 })).toThrow('root_required');
  expect(db.query('SELECT grant_id,proof_node_id,revision_before,revision_after FROM multiremi_root_bootstrap_authorizations').get())
    .toEqual({ grant_id: created.grant.id,proof_node_id: 'password',revision_before: 0,revision_after: 1 });
});

test('explicit grant checks the target and actor and preserves generation and current effectiveness on replay', () => {
  enable();
  const subject = { type: 'user',id: 'usr_second' } as const;
  const use = { action: 'root.grant.create',use: 'management',actualTarget: subject };
  const input = { subject,reason: 'fixture grant',expected_revision: 0,idempotency_key: 'grant-request' };
  const create = (expected_revision: number, idempotency_key: string, issuer = proof) => withSecurityWrite(db,undefined,service.plan(issuer,use),tx =>
    service.grant(tx,service.authorizeWrite(tx,issuer,use),{ ...input,expected_revision,idempotency_key }));
  expect(() => create(0,'unknown')).toThrow('Management target not found');
  db.run("INSERT INTO multiremi_users(id,name,email,created_at,updated_at) VALUES('usr_second','test','second@example.invalid','now','now')");
  expect(() => create(0,'unverified')).toThrow('root_required');
  db.run("INSERT INTO multiremi_password_credentials SELECT 'usr_second','second@example.invalid',password_hash,updated_at FROM multiremi_password_credentials WHERE user_id='usr_test'");
  db.run("INSERT INTO multiremi_authority_nodes VALUES('identity2',7,1,'independent_identity','user','usr_second','system',0,9999999999999,NULL,0)");
  db.run("INSERT INTO multiremi_authority_nodes VALUES('password2',8,1,'password','user','usr_second','system',0,9999999999999,NULL,1)");
  db.run("INSERT INTO multiremi_authority_edges VALUES('password2',1,8,'identity2',1,7,'continuous')");
  db.run("INSERT INTO multiremi_password_authority_versions SELECT 'usr_second',1,verifier_digest,'password2','identity2' FROM multiremi_password_authority_versions WHERE user_id='usr_test'");
  const created = create(0,'grant-request');
  expect(created.grant).toMatchObject({ generation: 1,effective: true,subject });
  expect(db.query('SELECT parent_id FROM multiremi_authority_edges WHERE child_id=? ORDER BY parent_id').all(created.grant.authority_node_id))
    .toEqual([{ parent_id: 'actor-grant' },{ parent_id: 'password' }]);
  expect(create(0,'grant-request')).toMatchObject({ replayed: true,grant: { id: created.grant.id,effective: true } });
  const revokeUse = { action: 'root.grant.revoke',actualTarget: { type: 'grant',id: created.grant.id },use: 'management' };
  withSecurityWrite(db,undefined,service.plan(proof,revokeUse),tx => service.revokeGrant(tx,service.authorizeWrite(tx,proof,revokeUse),created.grant.id,
    { reason: 'fixture revoke',idempotency_key: 'revoke',expected_revision: 1 }));
  expect(create(0,'grant-request')).toMatchObject({ replayed: true,grant: { effective: false,status: 'revoked' } });
  expect(create(2,'second-grant').grant).toMatchObject({ generation: 2,effective: true });
  expect(create(0,'grant-request').grant.id).toBe(created.grant.id);
});
function revoke(use: AuthorityUse, input: RevokeCredentialFamilyRequest = request) {
  return withSecurityWrite(db, undefined, service.plan(proof, use), tx => {
    const actor = service.authorizeWrite(tx, proof, use);
    return use === grant ? service.revokeGrant(tx, actor, use.actualTarget.id, input) : service.revokeFamily(tx, actor, use.actualTarget.id, input);
  });
}

test('two independent SQLite writers with the same revision commit one revocation', async () => {
  enable();
  const directory = mkdtempSync(join(tmpdir(), 'root-management-'));
  const database = join(directory, 'race.sqlite');
  const workers: Worker[] = [];
  try {
    db.query('VACUUM INTO ?').run(database);
    const barrier = new SharedArrayBuffer(4);
    const results = await Promise.all(['first','second'].map(key => new Promise<string>((resolve, reject) => {
      const worker = new Worker(new URL('./fixtures/root-management-race-worker.ts', import.meta.url).href);
      workers.push(worker);
      worker.onmessage = event => resolve(event.data);
      worker.onerror = event => reject(new Error(event.message));
      worker.postMessage({ database, key, password: passphrase, barrier });
    })));
    expect(results.sort()).toEqual(['authority_revision_conflict','revoked']);
    const inspect = openSqliteDatabase(database);
    try {
      expect(inspect.query('SELECT revision_before,revision_after FROM multiremi_root_management_events').all())
        .toEqual([{ revision_before: 0, revision_after: 1 }]);
    } finally { inspect.close(); }
  } finally {
    for (const worker of workers) worker.terminate();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);

test('primary password and independent identity ancestry authorize a revisioned family revoke and one audit on retry', () => {
  expect(service.resolveCurrent(proof, family).reason).toBe('feature_disabled');
  expect(() => revoke(family)).toThrow('root_required');
  enable();
  expect(service.resolveCurrent(proof, family)).toMatchObject({ subject: { type: 'user', id: 'usr_test' }, effectiveRoot: true });
  expect(revoke(family)).toMatchObject({ security_revision: 1, affected_authority_count: 2, status: 'revoked' });
  expect(revoke(family)).toMatchObject({ replayed: true, security_revision: 1 });
  expect(() => revoke(family, { ...request, reason: 'changed' })).toThrow('authority_revision_conflict');
  expect(() => revoke(grant)).toThrow('authority_revision_conflict');
  expect(db.query('SELECT actor_user_id,proof_node_id,actor_generation FROM multiremi_root_management_events').all())
    .toEqual([{ actor_user_id: 'usr_test', proof_node_id: 'password', actor_generation: 1 }]);
});

test('grant revoke clears only its active generation and invalidates its authority node', () => {
  enable();
  expect(revoke(grant)).toMatchObject({ grant: { id: 'recipient-grant', effective: false, status: 'revoked', generation: 1 } });
  expect(db.query("SELECT active_grant_id FROM multiremi_root_subject_state WHERE subject_id='usr_recipient'").get().active_grant_id).toBeNull();
  expect(db.query("SELECT revoked_at_ms FROM multiremi_authority_nodes WHERE node_id='recipient-grant'").get().revoked_at_ms).toBeGreaterThan(0);
});

test('rejects incorrect or copied proof, stale password material, and a revoked identity ancestor', async () => {
  enable();
  expect(await service.verifyIndependentPassword('usr_test', 'wrong')).toEqual({ kind: 'invalid' });
  expect(() => service.resolveCurrent({ ...proof }, grant)).toThrow('root_authority_revoked');
  db.run("UPDATE multiremi_authority_nodes SET revoked_at_ms=1 WHERE node_id='identity'");
  expect(await service.verifyIndependentPassword('usr_test', passphrase)).toEqual({ kind: 'invalid' });
  expect(() => revoke(grant)).toThrow('root_authority_revoked');
  db.run("UPDATE multiremi_password_credentials SET password_hash='changed'");
  expect(() => revoke(grant)).toThrow('credential_version_conflict');
  expect(db.query('SELECT revision_after FROM multiremi_root_management_events').all()).toEqual([]);
});

test('a verified human without a grant and a mismatched action cannot perform the write', () => {
  enable();
  expect(() => service.resolveCurrent(proof, { ...grant, action: family.action })).toThrow('root_required');
  db.run("UPDATE multiremi_root_subject_state SET active_grant_id=NULL WHERE subject_id='usr_test'");
  expect(service.resolveCurrent(proof, grant).reason).toBe('no_grant');
  expect(() => revoke(grant)).toThrow('root_required');
});

test('missing or dependent password registration never acquires an independent proof', async () => {
  enable();
  db.run("UPDATE multiremi_authority_nodes SET kind='provisioned_identity' WHERE node_id='identity'");
  expect(await service.verifyIndependentPassword('usr_test', passphrase)).toEqual({ kind: 'invalid' });
  expect(() => revoke(grant)).toThrow('credential_version_conflict');
  db.run('DELETE FROM multiremi_password_authority_versions');
  expect(await service.verifyIndependentPassword('usr_test', passphrase)).toEqual({ kind: 'invalid' });
});

test('audit failure rolls back grant, node, subject pointer, and security revision together', () => {
  enable();
  db.exec("CREATE TRIGGER refuse_event BEFORE INSERT ON multiremi_root_management_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
  expect(() => revoke(grant)).toThrow();
  expect(db.query("SELECT revoked_at_ms FROM multiremi_authority_nodes WHERE node_id='recipient-grant'").get().revoked_at_ms).toBeNull();
  expect(db.query("SELECT active_grant_id FROM multiremi_root_subject_state WHERE subject_id='usr_recipient'").get().active_grant_id).toBe('recipient-grant');
  expect(db.query("SELECT revoked_at_ms FROM multiremi_root_grants WHERE grant_id='recipient-grant'").get().revoked_at_ms).toBeNull();
  expect(db.query('SELECT security_revision FROM multiremi_security_state').get().security_revision).toBe(0);
});

test('binds actor to transaction and target, and rolls back on a stale target generation', () => {
  enable();
  const plan = service.plan(proof, grant);
  const actor = withSecurityWrite(db, undefined, plan, tx => service.authorizeWrite(tx, proof, grant));
  expect(() => withSecurityWrite(db, undefined, plan, tx => service.revokeGrant(tx, actor, grant.actualTarget.id, request))).toThrow('root_required');
  expect(() => withSecurityWrite(db, undefined, { ...plan, domainTargets: [...plan.domainTargets,'management:grant:other'].sort() }, tx => {
    const fresh = service.authorizeWrite(tx, proof, grant);
    service.revokeGrant(tx, fresh, 'other', request);
  })).toThrow('root_required');
  db.run("UPDATE multiremi_root_subject_state SET active_grant_id=NULL,generation_counter=2 WHERE subject_id='usr_recipient'");
  expect(() => revoke(grant)).toThrow('authority_revision_conflict');
  expect(db.query("SELECT revoked_at_ms FROM multiremi_root_grants WHERE grant_id='recipient-grant'").get().revoked_at_ms).toBeNull();
  expect(db.query('SELECT security_revision FROM multiremi_security_state').get().security_revision).toBe(0);
});
