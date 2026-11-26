import { expect,test } from 'bun:test';
import { createHash } from 'node:crypto';
import { fixtureDeliveryTuple } from '../../fixtures/root-authority.js';
import { serializeRootDeliveryTuple } from '@multiremi/worker/root-delivery-envelope.js';
import { runMigrations } from '@multiremi/store/migrations.js';
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import type { SqlDatabase } from '@multiremi/store/db/postgres.js';
import { RegisteredCredentialProofs } from '@multiremi/store/registered-credential-proof.js';
import { AccessTokensRepo } from '@multiremi/store/repos/access-tokens-repo.js';
import { RootManagement } from '@multiremi/store/root-management.js';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';
import { withSecurityWrite } from '@multiremi/store/security-write.js';

test('registered PAT proves only its current material and true human origin', async () => {
  const sqlite = openSqliteDatabase();
  try {
    const db = sqlite as unknown as SqlDatabase;
    runMigrations(db);
    const raw = 'synthetic-fixture-pat';
    const digest = createHash('sha256').update(raw).digest('hex');
    const expiry = Date.now()+600_000;
    db.run("INSERT INTO multiremi_users(id,name,email,created_at,updated_at) VALUES('usr_fixture','fixture','fixture@example.invalid','now','now')");
    db.query(`INSERT INTO multiremi_access_tokens(id,name,user_id,type,purpose,token_prefix,token_hash,expires_at,created_at)
      VALUES('token','fixture','usr_fixture','pat','personal','fixture',?,?,'now')`).run(digest,new Date(expiry).toISOString());
    const service = new RootManagement(db);
    const proofs = service.registeredCredentials;
    expect(proofs.verify(raw).kind).toBe('invalid');
    expect(proofs.verify(null).kind).toBe('absent');
    for (const [index,kind] of ['independent_identity','credential_family','credential'].entries()) {
      db.query(`INSERT INTO multiremi_authority_nodes VALUES(?,?,1,?,'user','usr_fixture','fixture',0,?,NULL,?)`).run(kind,index+1,kind,expiry,index===0?0:1);
    }
    db.run("INSERT INTO multiremi_authority_edges VALUES('credential_family',1,2,'independent_identity',1,1,'continuous')");
    db.run("INSERT INTO multiremi_authority_edges VALUES('credential',1,3,'credential_family',1,2,'continuous')");
    db.query("INSERT INTO multiremi_credential_families VALUES('family','credential_family',?,NULL,0)").run(expiry);
    db.query(`INSERT INTO multiremi_credential_version_bindings(credential_id,material_version,material_digest,credential_type,purpose,subject_type,subject_id,
      family_id,authority_node_id,authority_generation,authority_seq,expires_at_ms) VALUES('token',1,?,'pat','personal','user','usr_fixture','family','credential',1,3,?)`).run(digest,expiry);
    const proof = proofs.verify(raw);
    const tokens = new AccessTokensRepo(db);
    expect((await tokens.verifyAccessToken(raw))?.id).toBe('token');
    expect(await tokens.renewAccessTokenExpiry('token')).toBeNull();
    expect(db.query('SELECT token_hash FROM multiremi_access_tokens WHERE id=?').get('token')?.token_hash).toBe(digest);
    expect(proof.kind).toBe('dependent');
    const request = {action:'root.grant.create',use:'management',actualTarget:{type:'user',id:'usr_fixture'}};
    expect(service.resolveCurrent(proof,request)).toMatchObject({transport:'human',subject:{type:'user',id:'usr_fixture'},
      effectiveRoot:false,credentialOrigin:{credential:{id:'token',version:1},familyId:'family'}});
    expect(()=>withSecurityWrite(db,undefined,service.plan(proof,request),tx=>service.authorizeWrite(tx,proof,request))).toThrow('root_required');
    expect(()=>service.resolveCurrent(new RegisteredCredentialProofs(db).verify(raw),request)).toThrow('root_authority_revoked');
    const check = () => withSecurityWrite(db,undefined,proofs.plan(proof),tx=>proofs.requireCurrent(tx,proof));
    expect(check()).toMatchObject({subject:{type:'user',id:'usr_fixture'},type:'pat',purpose:'personal',attemptId:null,credential:{id:'token',version:1},familyId:'family'});
    db.run("UPDATE multiremi_access_tokens SET daemon_id='synthetic-daemon' WHERE id='token'");
    expect(check).toThrow('root_authority_revoked');
    db.run("UPDATE multiremi_access_tokens SET daemon_id=NULL,purpose='daemon' WHERE id='token'");
    db.run("UPDATE multiremi_credential_version_bindings SET purpose='daemon' WHERE credential_id='token'");
    expect(proofs.verify(raw).kind).toBe('invalid');
    db.run("UPDATE multiremi_access_tokens SET purpose='personal' WHERE id='token'");
    db.run("UPDATE multiremi_credential_version_bindings SET purpose='personal' WHERE credential_id='token'");
    db.run("UPDATE multiremi_authority_nodes SET subject_type='agent' WHERE kind='independent_identity'");
    expect(proofs.verify(raw).kind).toBe('invalid');
    db.run("UPDATE multiremi_authority_nodes SET subject_type='user',revoked_at_ms=1 WHERE kind='independent_identity'");
    expect(await tokens.verifyAccessToken(raw)).toBeNull();
    expect(await tokens.renewAccessTokenExpiry('token')).toBeNull();
    expect(check).toThrow('root_authority_revoked');
    expect(proofs.verify(raw).kind).toBe('invalid');
  } finally { sqlite.close(); }
});

pendingTurnBackendTests('registered supervisor task management',fixture=>{
  test('resolves the current agent and rejects self-assigned management authority and a replaced attempt',async()=>{
    const {db,store} = fixture();
    const agent = store.createAgent({name:'fixture supervisor',provider:'codex',role:'supervisor'});
    const task = store.createTask({agentId:agent.id,prompt:'fixture'});
    const token = await store.createTaskAccessToken(task,'local');
    const expiry = Date.parse(token.expiresAt!);
    const digest = createHash('sha256').update(token.token).digest('hex');
    db.run("UPDATE multiremi_security_state SET feature_activation=1,bootstrap_completed=1,minimum_enforcement_version='fixture'");
    db.query("UPDATE multiremi_turn_attempts SET status='running' WHERE id=?").run(task.id);
    for (const [index,kind] of ['credential_family','credential','grant'].entries()) {
      db.query(`INSERT INTO multiremi_authority_nodes VALUES(?,?,1,?,'agent',?,'system',0,?,NULL,?)`).run(kind,index+1,kind,agent.id,expiry,kind==='credential'?1:0);
    }
    db.run("INSERT INTO multiremi_authority_edges VALUES('credential',1,2,'credential_family',1,1,'continuous')");
    db.query("INSERT INTO multiremi_credential_families VALUES('family','credential_family',?,NULL,0)").run(expiry);
    db.query(`INSERT INTO multiremi_credential_version_bindings(credential_id,material_version,material_digest,credential_type,purpose,subject_type,subject_id,
      family_id,authority_node_id,authority_generation,authority_seq,expires_at_ms) VALUES(?,1,?,'task','task','agent',?,'family','credential',1,2,?)`).run(token.id,digest,agent.id,expiry);
    db.query(`INSERT INTO multiremi_root_grants(grant_id,subject_type,subject_id,generation,scope,authority_node_id,issuer_type,issuer_id,revision,reason,created_at_ms)
      VALUES('nominal','agent',?,1,'system','grant','deployment','fixture',0,'fixture',1)`).run(agent.id);
    db.query("INSERT INTO multiremi_root_subject_state VALUES('agent',?,1,'nominal')").run(agent.id);
    const service = new RootManagement(db);
    expect(service.registeredCredentials.verify(token.token).kind).toBe('invalid');
    const tuple = {...fixtureDeliveryTuple,attempt_id:task.id,material_expires_at:token.expiresAt!};
    db.query("UPDATE multiremi_turn_attempts SET status='accepted',runtime_id=? WHERE id=?").run(tuple.runtime_id,task.id);
    db.query(`INSERT INTO multiremi_usage_task_scopes(task_id,workspace_id,agent_id,runtime_id,active_run_id) VALUES(?,'local',?,?,?)
      ON CONFLICT(task_id) DO UPDATE SET runtime_id=excluded.runtime_id,active_run_id=excluded.active_run_id`).run(task.id,agent.id,tuple.runtime_id,tuple.consumer_id);
    db.query('INSERT INTO multiremi_usage_runs VALUES(?,?,0,0)').run(task.id,tuple.consumer_id);
    db.query("INSERT INTO multiremi_credential_materials VALUES(?,1,'family','credential',1,2,?)").run(token.id,expiry);
    db.query(`INSERT INTO multiremi_delivery_receipts(receipt_id,attempt_id,handoff_id,run_generation,consumer_id,receipt_version,delivery_version,material_version,
      credential_id,binding_json,envelope,envelope_digest,business_payload_json,start_deadline,lease_id,fence_term,ack_state,run_state)
      VALUES(?,?,?,1,?,1,1,1,?,?,'fixture','fixture','{}',?,'test-lease','test-fence','pending','pending_start')`)
      .run(tuple.receipt_id,task.id,tuple.handoff_id,tuple.consumer_id,token.id,serializeRootDeliveryTuple(tuple),token.expiresAt);
    const proof = service.registeredCredentials.verify(token.token);
    const accessTokens = new AccessTokensRepo(db);
    expect((await accessTokens.verifyAccessToken(token.token, ['task']))?.taskId).toBe(task.id);
    const request = {action:'root.grant.revoke',use:'management',actualTarget:{type:'grant',id:'nominal'}};
    expect(service.resolveCurrent(proof,request)).toMatchObject({transport:'task',subject:{type:'agent',id:agent.id},attemptId:task.id,
      recordedGrant:{grantId:'nominal'},effectiveRoot:false,reason:'attempt_not_eligible'});
    expect(()=>withSecurityWrite(db,undefined,service.plan(proof,request),tx=>service.authorizeWrite(tx,proof,request))).toThrow('root_required');
    const current = () => service.resolveCurrent(proof,request);
    db.run("UPDATE multiremi_delivery_receipts SET lease_id='different-lease'");
    expect(current).toThrow('root_authority_revoked');
    db.run("UPDATE multiremi_delivery_receipts SET lease_id='test-lease',fence_term='different-fence'");
    expect(current).toThrow('root_authority_revoked');
    db.run("UPDATE multiremi_delivery_receipts SET lease_id='',fence_term='test-fence'");
    expect(current).toThrow('root_authority_revoked');
    db.run("UPDATE multiremi_delivery_receipts SET lease_id='test-lease',run_generation=2");
    expect(current).toThrow('root_authority_revoked');
    db.run("UPDATE multiremi_delivery_receipts SET run_generation=1,start_deadline='2000-01-01T00:00:00Z'");
    expect(current).toThrow('root_authority_revoked');
    expect(await accessTokens.verifyAccessToken(token.token, ['task'])).toBeNull();
    db.query('UPDATE multiremi_delivery_receipts SET start_deadline=?').run(token.expiresAt);
    db.run('UPDATE multiremi_usage_runs SET complete=1');
    expect(current).toThrow('root_authority_revoked');
    db.run('UPDATE multiremi_usage_runs SET complete=0');
    db.query("UPDATE multiremi_turn_attempts SET status='running' WHERE id=?").run(task.id);
    expect(current).toThrow('root_authority_revoked');
    db.run("UPDATE multiremi_delivery_receipts SET run_state='running',ack_state='confirmed',execution_locator_json='{}'");
    db.run("UPDATE multiremi_delivery_receipts SET start_deadline='2000-01-01T00:00:00Z'");
    expect((await accessTokens.verifyAccessToken(token.token, ['task']))?.taskId).toBe(task.id);
    expect(service.resolveCurrent(proof,request).effectiveRoot).toBe(false);
    for (const phase of ['offered','waiting_local_directory','completed','failed','cancelled','lost']) {
      db.query('UPDATE multiremi_turn_attempts SET status=? WHERE id=?').run(phase,task.id);
      expect(current).toThrow('root_authority_revoked');
    }
    db.query("UPDATE multiremi_turn_attempts SET status='running' WHERE id=?").run(task.id);
    db.query('UPDATE multiremi_turns SET current_attempt_id=NULL WHERE current_attempt_id=?').run(task.id);
    expect(()=>service.resolveCurrent(proof,request)).toThrow('root_authority_revoked');
  });
});
