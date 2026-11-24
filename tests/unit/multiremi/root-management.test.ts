import { afterEach, beforeEach, expect, test } from 'bun:test';
import { constants, createHash, generateKeyPairSync, privateDecrypt, sign } from 'node:crypto';
import { beginMachineChallenge,machineSignaturePayload,verifyMachineChallenge,requireCurrentMachine,bindMachineConnection,releaseMachineConnection,type MachineConnection } from '@multiremi/store/machine-proof.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SqlDatabase } from '@multiremi/store/db/postgres.js';
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import { invalidatingDatabase } from '@multiremi/store/request-read-cache.js';
import { liveTermDatabase } from '@multiremi/store/live-term-fence.js';
import { runMigrations } from '@multiremi/store/migrations.js';
import type { AuthorityUse, CredentialProof } from '@multiremi/store/root-authority-contract.js';
import type { RevokeCredentialFamilyRequest } from '@multiremi/contracts/root-authority.js';
import { bootstrapAuthorizationDigest, RootManagement } from '@multiremi/store/root-management.js';
import { JwtMaterials } from '@multiremi/store/jwt-materials.js';
import { afterSecurityCommit, withSecurityWrite } from '@multiremi/store/security-write.js';

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
  db = liveTermDatabase(invalidatingDatabase(sqlite as unknown as SqlDatabase));
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

test('direct retry invocation binds the fresh actor and primary turn to one proposed replacement in its transaction',()=>{
  enable();
  db.run("INSERT INTO multiremi_workspaces(id,name,slug,created_at,updated_at) VALUES('local','fixture','fixture','now','now')");
  db.run("INSERT INTO multiremi_agents(id,name,provider,created_at,updated_at) VALUES('agt_fixture','fixture','codex','now','now')");
  db.run("INSERT INTO multiremi_issues(id,title,created_at,updated_at) VALUES('iss_fixture','fixture','now','now')");
  db.run("INSERT INTO multiremi_issue_sessions(id,issue_id,created_at,updated_at) VALUES('ises_fixture','iss_fixture','now','now')");
  db.run(`INSERT INTO multiremi_turns(id,session_id,seq,agent_id,execution_scope,status,current_attempt_id,workspace_id,created_at)
    VALUES('turn_fixture','ises_fixture',1,'agt_fixture','fixture-scope','failed','tsk_previous','local','now')`);
  db.run(`INSERT INTO multiremi_turn_attempts(id,turn_id,attempt_no,status,created_at,updated_at) VALUES('tsk_previous','turn_fixture',1,'lost','now','now')`);
  const target = {turnId:'turn_fixture',previousAttemptId:'tsk_previous',attemptId:'tsk_new'};
  const base = service.planDirectRetry(proof,target);
  const plan = {...base,domainTargets:[...base.domainTargets,'attempt:tsk_other'].sort()};
  const handle = withSecurityWrite(db,undefined,plan,tx=>{
    const verified = service.verifyDirectRetryInvocation(tx,proof,target);
    expect(service.requireDirectRetryInvocation(tx,verified,target)).toMatchObject({actorId:'usr_test',agentId:'agt_fixture',
      workspaceId:'local',sessionId:'ises_fixture',sessionOwnerType:'issue',sessionOwnerId:'iss_fixture',executionScope:'fixture-scope',grantGeneration:1});
    return verified;
  });
  expect(()=>withSecurityWrite(db,undefined,plan,tx=>service.requireDirectRetryInvocation(tx,handle,target))).toThrow('root_authority_revoked');
  expect(()=>withSecurityWrite(db,undefined,plan,tx=>{
    const verified = service.verifyDirectRetryInvocation(tx,proof,target);
    service.requireDirectRetryInvocation(tx,verified,{...target,attemptId:'tsk_other'});
  })).toThrow('authority_revision_conflict');
  db.run("UPDATE multiremi_authority_nodes SET revoked_at_ms=1 WHERE node_id='actor-grant'");
  expect(()=>withSecurityWrite(db,undefined,plan,tx=>service.verifyDirectRetryInvocation(tx,proof,target))).toThrow('root_authority_revoked');
});

test('catching a rejected management target still rolls back the outer write', () => {
  enable();
  let notified = false;
  expect(()=>withSecurityWrite(db,undefined,service.plan(proof,grant),tx=>{
    const actor = service.authorizeWrite(tx,proof,grant);
    afterSecurityCommit(db,tx,()=>{ notified = true; });
    db.run('UPDATE multiremi_security_state SET security_revision=99 WHERE singleton=1');
    expect(()=>service.grant(tx,actor,{subject:{type:'agent',id:'agt_fixture'},expected_revision:0,idempotency_key:'fixture',reason:'fixture'})).toThrow('root_required');
  })).toThrow('root_required');
  expect(db.query('SELECT security_revision FROM multiremi_security_state').get().security_revision).toBe(0);
  expect(notified).toBe(false);
});

test('fresh independent password login issues just one registered self dashboard session with a revocable family', () => {
  const signing = {domainId:'fixture-dashboard',keyEpoch:'1',secret:'synthetic-session-signing-key'};
  const dashboardSigningDomain = {domainId:signing.domainId,keyEpoch:signing.keyEpoch,keyDigest:checksum(signing.secret)};
  const input = {deploymentId:'fixture-deployment',authorization:'one-use-fixture-bootstrap',userId:'usr_test',reason:'fixture',expectedRevision:0,dashboardSigningDomain};
  db.run('DELETE FROM multiremi_root_subject_state');
  db.run('DELETE FROM multiremi_root_grants');
  db.query(`INSERT INTO multiremi_root_bootstrap_authorizations(authorization_digest,deployment_id,user_id,reason,expires_at_ms)
    VALUES(?,?,?,?,?)`).run(bootstrapAuthorizationDigest(input),input.deploymentId,input.userId,input.reason,Date.now()+60_000);
  expect(()=>service.bootstrapHuman(proof,{...input,dashboardSigningDomain:{...dashboardSigningDomain,keyEpoch:'2'}})).toThrow('root_required');
  expect(()=>service.bootstrapHuman(proof,{...input,dashboardSigningDomain:undefined})).toThrow('root_required');
  db.exec("CREATE TRIGGER reject_domain_audit BEFORE INSERT ON multiremi_root_management_events BEGIN SELECT RAISE(ABORT,'audit rejected'); END");
  expect(()=>service.bootstrapHuman(proof,input)).toThrow();
  expect(db.query('SELECT domain_id FROM multiremi_jwt_signing_domains').all()).toEqual([]);
  expect(db.query('SELECT grant_id FROM multiremi_root_grants').all()).toEqual([]);
  db.exec('DROP TRIGGER reject_domain_audit');
  service.bootstrapHuman(proof,input);
  expect(db.query('SELECT domain_id,key_epoch FROM multiremi_jwt_signing_domains').get()).toEqual({domain_id:signing.domainId,key_epoch:'1'});
  expect(db.query('SELECT feature_activation FROM multiremi_security_state').get().feature_activation).toBe(0);
  enable();
  db.run("UPDATE multiremi_root_subject_state SET active_grant_id=NULL WHERE subject_id='usr_test'");
  const materials = new JwtMaterials(db);
  const expiry = (Math.floor(Date.now()/1000)+300)*1000;
  expect(()=>service.issueIndependentDashboardSession(proof,expiry,()=>'unregistered')).toThrow('credential_version_conflict');
  expect(()=>service.issueIndependentDashboardSession(proof,expiry,(tx,source,claims)=>
    materials.issue(tx,source,{...claims,root:true},signing))).toThrow('credential_version_conflict');
  expect(db.query("SELECT node_id FROM multiremi_authority_nodes WHERE kind='jwt_material'").all()).toEqual([]);
  const issue = () => service.issueIndependentDashboardSession(proof,expiry,(tx,source,claims)=>materials.issue(tx,source,claims,signing));
  const compact = issue();
  const row = db.query(`SELECT m.subject_id,m.family_id,m.material_version,m.purpose,m.authority_node_id,f.authority_node_id AS family_node
    FROM multiremi_jwt_materials m JOIN multiremi_credential_families f ON f.family_id=m.family_id WHERE m.compact_digest=?`).get(checksum(compact));
  expect(row).toMatchObject({subject_id:'usr_test',material_version:1,purpose:'dashboard'});
  expect(db.query('SELECT parent_id FROM multiremi_authority_edges WHERE child_id=?').get(row.authority_node_id).parent_id).toBe(row.family_node);
  expect(db.query('SELECT parent_id FROM multiremi_authority_edges WHERE child_id=?').get(row.family_node).parent_id).toBe('password');
  expect(issue).toThrow('credential_version_conflict');
  expect(db.query('SELECT COUNT(*) AS total FROM multiremi_jwt_materials').get().total).toBe(1);
  expect(materials.validate(compact,signing)?.userId).toBe('usr_test');
  db.run("UPDATE multiremi_authority_nodes SET revoked_at_ms=1 WHERE node_id='password'");
  expect(materials.validate(compact,signing)).toBeNull();
});

test('trust grant binds live daemon credential, enrollment, two key proofs and single-use nonce, then revokes atomically', () => {
  enable();
  const receiver = generateKeyPairSync('rsa',{ modulusLength: 3072 });
  const signer = generateKeyPairSync('ed25519');
  const bearer = 'synthetic-daemon-material';
  const expiry = Date.now()+600_000;
  db.run("INSERT INTO multiremi_workspaces(id,name,slug,created_at,updated_at) VALUES('local','fixture','fixture','now','now')");
  db.run("INSERT INTO multiremi_runtimes(id,name,provider,daemon_id,workspace_id,created_at,updated_at) VALUES('rt_test','fixture','test','daemon-test','local','now','now')");
  db.query(`INSERT INTO multiremi_access_tokens(id,workspace_id,daemon_id,name,type,token_hash,token_prefix,created_at)
    VALUES('daemon-credential','local','daemon-test','test','daemon',?,'test','now')`).run(checksum(bearer));
  db.run("INSERT INTO multiremi_authority_nodes VALUES('registration',7,1,'machine_registration','daemon','daemon-test','system',0,9999999999999,NULL,0)");
  db.query(`INSERT INTO multiremi_machine_enrollments VALUES('incarnation','deployment','consumer','rt_test','daemon-test','daemon-credential',?,'registration',1,?,?,'key-id',?,1,NULL,1,?,'synthetic-attestation')`)
    .run(checksum(bearer),signer.publicKey.export({ type:'spki',format:'pem' }),receiver.publicKey.export({ type:'spki',format:'pem' }),expiry,expiry);
  const targets = ['authority:registration','machine:rt_test'];
  const plan = {expectedRevision:0,workspaceIds:[],numberKeys:[],domainTargets:targets};
  const action = 'root.runtime-trust.grant';
  const owner = {};
  expect(bindMachineConnection(db,owner,'synthetic-task-material')).toBeNull();
  const connection = bindMachineConnection(db,owner,bearer);
  if (!connection) throw new Error('Fixture daemon connection was not bound');
  const challenge = withSecurityWrite(db,undefined,plan,tx=>beginMachineChallenge(db,tx,connection,'rt_test',action,'rt_test'));
  const nonce = privateDecrypt({ key:receiver.privateKey,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING },Buffer.from(challenge.encryptedNonce,'base64url')).toString('base64url');
  const signedAt = new Date().toISOString();
  const machine = { consumer_id:'consumer',runtime_id:'rt_test',daemon_id:'daemon-test',incarnation:'incarnation',recipient_key_id:'key-id',
    recipient_key_fingerprint:`sha256:${createHash('sha256').update(receiver.publicKey.export({type:'spki',format:'der'})).digest('hex')}`,
    nonce,signature:sign(null,machineSignaturePayload(challenge,nonce,signedAt),signer.privateKey).toString('base64url'),signed_at:signedAt };
  const verify = (presented: typeof machine,token: string | MachineConnection=connection) => withSecurityWrite(db,undefined,plan,tx=>verifyMachineChallenge(db,tx,token,challenge.id,action,'rt_test',presented));
  expect(()=>verify(machine,bindMachineConnection(db,{},bearer)!)).toThrow('root_authority_revoked');
  expect(()=>verify(machine,'synthetic-task-material')).toThrow('root_authority_revoked');
  expect(()=>verify({...machine,signature:'invalid'})).toThrow('root_authority_revoked');
  expect(()=>verify({...machine,incarnation:'another'})).toThrow('root_authority_revoked');
  const verified = verify(machine);
  expect(withSecurityWrite(db,undefined,plan,tx=>requireCurrentMachine(db,tx,verified,action,'rt_test'))).toBe(verified);
  expect(()=>withSecurityWrite(db,undefined,plan,tx=>requireCurrentMachine(db,tx,verified,'receipt.replay','rt_test'))).toThrow('root_authority_revoked');
  expect(()=>verify(machine)).toThrow('root_authority_revoked');
  releaseMachineConnection(owner);
  expect(()=>withSecurityWrite(db,undefined,plan,tx=>requireCurrentMachine(db,tx,verified,action,'rt_test'))).toThrow('root_authority_revoked');
  const request = {runtime_id:'rt_test',daemon_id:machine.daemon_id,incarnation:machine.incarnation,recipient_key_id:machine.recipient_key_id,
    recipient_key_fingerprint:machine.recipient_key_fingerprint,reason:'fixture trust',expected_revision:0,idempotency_key:'trust',challenge_id:challenge.id,challenge_response:verified.proofDigest};
  const use = {action,actualTarget:{type:'runtime',id:'rt_test'},use:'management'};
  const trust = () => withSecurityWrite(db,undefined,service.plan(proof,use),tx=>service.grantRuntimeTrust(tx,service.authorizeWrite(tx,proof,use),request));
  db.exec("CREATE TRIGGER refuse_trust_event BEFORE INSERT ON multiremi_root_management_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
  expect(trust).toThrow('security_state_unavailable');
  expect(db.query('SELECT * FROM multiremi_runtime_trusts').all()).toEqual([]);
  db.exec('DROP TRIGGER refuse_trust_event');
  const granted = trust();
  expect(granted.trust).toMatchObject({generation:1,effective:true,immutable_env_carrier_verified:true});
  expect(trust()).toMatchObject({replayed:true,trust:{id:granted.trust.id,effective:true}});
  db.run("UPDATE multiremi_access_tokens SET revoked_at='retired' WHERE id='daemon-credential'");
  expect(trust()).toMatchObject({replayed:true,trust:{effective:false}});
  const revokeUse = { action:'root.runtime-trust.revoke',actualTarget:{type:'runtime_trust',id:granted.trust.id},use:'management' };
  const revoked = withSecurityWrite(db,undefined,service.plan(proof,revokeUse),tx=>service.revokeRuntimeTrust(tx,service.authorizeWrite(tx,proof,revokeUse),granted.trust.id,
    {expected_revision:1,idempotency_key:'revoke-trust',reason:'fixture revoke'}));
  expect(revoked).toMatchObject({security_revision:2,affected_authority_count:1,trust:{effective:false,status:'revoked'}});
  expect(trust()).toMatchObject({replayed:true,trust:{effective:false,status:'revoked'}});
});

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
  const second = create(2,'second-grant').grant;
  expect(second).toMatchObject({generation:2,effective:true});
  expect(()=>create(3,'still-active')).toThrow('authority_revision_conflict');
  db.query(`INSERT INTO multiremi_authority_edges SELECT node_id,generation,issued_seq,'family-node',1,5,'continuous'
    FROM multiremi_authority_nodes WHERE node_id=?`).run(second.authority_node_id);
  db.query('UPDATE multiremi_authority_nodes SET continuous_parent_count=continuous_parent_count+1 WHERE node_id=?').run(second.authority_node_id);
  db.run("UPDATE multiremi_authority_nodes SET revoked_at_ms=1 WHERE node_id='family-node'");
  const third = create(3,'independent-reauthorization').grant;
  expect(third).toMatchObject({generation:3,effective:true});
  expect(third.authority_node_id).not.toBe(second.authority_node_id);
  expect(create(2,'second-grant')).toMatchObject({replayed:true,grant:{id:second.id,effective:false}});
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
