import { expect, it } from 'bun:test';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import type { SqlDatabase } from '@multiremi/store/db/postgres.js';
import { beginMachineChallenge } from '@multiremi/store/machine-proof.js';
import { createReplacementAttemptWithinTransaction } from '@multiremi/store/turn-attempts.js';
import { withAttemptAdmission } from '@multiremi/store/attempt-admission.js';
import type { InputManifest } from '@multiremi/store/root-authority-contract.js';
import { fixtureDeliveryTuple } from '../../fixtures/root-authority.js';
import { serializeRootDeliveryTuple } from '@multiremi/worker/root-delivery-envelope.js';
import { JwtMaterials } from '@multiremi/store/jwt-materials.js';
import { bootstrapAuthorizationDigest, RootManagement } from '@multiremi/store/root-management.js';
import { withSecurityWrite } from '@multiremi/store/security-write.js';
import { readAttemptEligibility, readCurrentTaskLease, writeCurrentTaskLease } from '@multiremi/store/task-authority.js';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';

const hash = (input:string) => createHash('sha256').update(input).digest('hex');

async function bootstrap(db:SqlDatabase) {
    const service = new RootManagement(db);
    const password = 'test-dashboard-password';
    const verifier = await Bun.password.hash(password,{algorithm:'argon2id',memoryCost:19456,timeCost:2});
    db.run("INSERT INTO multiremi_users(id,name,email,created_at,updated_at) VALUES('usr_auth','test','auth@example.invalid','now','now')");
    db.query("INSERT INTO multiremi_password_credentials(user_id,login_email,password_hash,updated_at) VALUES('usr_auth','auth@example.invalid',?,'now')").run(verifier);
    db.run("INSERT INTO multiremi_authority_nodes VALUES('identity',1,1,'independent_identity','user','usr_auth','system',0,9999999999999,NULL,0)");
    db.run("INSERT INTO multiremi_authority_nodes VALUES('password',2,1,'password','user','usr_auth','system',0,9999999999999,NULL,1)");
    db.run("INSERT INTO multiremi_authority_edges VALUES('password',1,2,'identity',1,1,'continuous')");
    db.query("INSERT INTO multiremi_password_authority_versions VALUES('usr_auth',1,?,'password','identity')").run(hash(verifier));
    const signing={domainId:'test-dashboard',keyEpoch:'1',secret:'local-test-signing-secret'};
    const input={userId:'usr_auth',deploymentId:'test',authorization:'test-once',reason:'isolated test',expectedRevision:0,
      dashboardSigningDomain:{domainId:signing.domainId,keyEpoch:signing.keyEpoch,keyDigest:hash(signing.secret)}};
    db.query(`INSERT INTO multiremi_root_bootstrap_authorizations(authorization_digest,deployment_id,user_id,reason,expires_at_ms)
      VALUES(?,?,?,?,?)`).run(bootstrapAuthorizationDigest(input),input.deploymentId,input.userId,input.reason,Date.now()+60000);
    const passwordProof=await service.verifyIndependentPassword(input.userId,password);
    const created=service.bootstrapHuman(passwordProof,input);
    db.run("UPDATE multiremi_security_state SET feature_activation=1,minimum_enforcement_version='fixture'");
    return {service,passwordProof,signing,input,created};
}

pendingTurnBackendTests('task and mutation authority', fixture=>{
  it('resolves registered dashboard material on a generic target and rechecks its origin for mutations',async()=>{
    const {db,store}=fixture();
    const {service,passwordProof,signing,input}=await bootstrap(db);
    const compact=service.issueIndependentDashboardSession(passwordProof,(Math.floor(Date.now()/1000)+300)*1000,
      (tx,source,claims)=>new JwtMaterials(db).issue(tx,source,claims,signing));
    const proof=service.registeredCredentials.verifyJwt(compact,signing);
    const use={use:'write',action:'issue.update',actualTarget:{type:'issue',id:'isolated'}};
    expect(service.resolveCurrent(proof,{...use,use:'read'})).toMatchObject({effectiveRoot:true,scope:'system',subject:{id:input.userId,type:'user'}});
    const plan=service.plan(proof,use);
    const storeProof=store.rootManagement.registeredCredentials.verifyJwt(compact,signing);
    expect(store.withAuthorizedMutation(storeProof,use,plan,(tx,verified)=>
      store.rootManagement.requireMutationActor(tx,verified,use).credentialOrigin?.credential.id)).toBe(service.resolveCurrent(proof,use).credentialOrigin?.credential.id);
    const actor=withSecurityWrite(db,undefined,plan,tx=>{
      const verified=service.authorizeWrite(tx,proof,use);
      expect(service.requireMutationActor(tx,verified,use).credentialOrigin?.credential.version).toBe(1);
      return verified;
    });
    expect(()=>withSecurityWrite(db,undefined,plan,tx=>service.requireMutationActor(tx,actor,use))).toThrow('root_required');
    const expires=Date.now()+300000;
    const registered= db.query('SELECT family_id,authority_node_id FROM multiremi_jwt_materials WHERE compact_digest=?').get(hash(compact));
    const family=db.query('SELECT authority_node_id FROM multiremi_credential_families WHERE family_id=?').get(registered.family_id);
    const next=Number(db.query('SELECT MAX(issued_seq) AS maximum FROM multiremi_authority_nodes').get().maximum)+1;
    db.query(`INSERT INTO multiremi_authority_nodes VALUES('pat',?,1,'credential','user','usr_auth','system',1,?,NULL,1)`).run(next,expires);
    db.query("INSERT INTO multiremi_authority_edges SELECT 'pat',1,?,node_id,generation,issued_seq,'continuous' FROM multiremi_authority_nodes WHERE node_id=?").run(next,family.authority_node_id);
    const patExpires=Math.min(expires,Number(db.query('SELECT max_expires_at_ms FROM multiremi_credential_families WHERE family_id=?').get(registered.family_id).max_expires_at_ms));
    db.query(`INSERT INTO multiremi_access_tokens(id,name,user_id,type,purpose,token_prefix,token_hash,expires_at,created_at) VALUES('pat','test','usr_auth','pat','personal','test',?,?,'now')`).run(hash('fixture-pat'),new Date(patExpires).toISOString());
    db.query(`INSERT INTO multiremi_credential_version_bindings VALUES('pat',1,?,'pat','personal','user','usr_auth',?,'pat',1,?,?)`)
      .run(hash('fixture-pat'),registered.family_id,next,patExpires);
    const patProof=service.registeredCredentials.verify('fixture-pat');
    expect(service.resolveCurrent(patProof,use)).toMatchObject({effectiveRoot:true,credentialOrigin:{credential:{id:'pat',version:1}}});
    db.run("UPDATE multiremi_authority_nodes SET revoked_at_ms=1 WHERE node_id='password'");
    expect(()=>service.resolveCurrent(proof,use)).toThrow('root_authority_revoked');
    expect(()=>service.resolveCurrent(patProof,use)).toThrow('root_authority_revoked');
  });

  it('consumes one admission on the real replacement insert and fences delayed lease updates', async()=>{
    const {db,store}=fixture();
    const {service,passwordProof,created}=await bootstrap(db);
    const agent=store.createAgent({name:'admitted',provider:'codex'});
    const issue=fixture().createIssue({title:'admission',assigneeType:'agent',assigneeId:agent.id});
    const previous=store.createTask({agentId:agent.id,issueId:issue.id,prompt:'previous'});
    const turnId=db.query('SELECT turn_id FROM multiremi_turn_attempts WHERE id=?').get(previous.id).turn_id;
    const target={turnId,previousAttemptId:previous.id,attemptId:'tsk_admitted'};
    const execution={attemptId:target.attemptId,runtimeId:'rt_auth',daemonId:'daemon',incarnation:'inc',configEpoch:1,executionDigest:hash('execution'),
      providerTrust:{id:'provider',version:1},checkpointTrust:null};
    const parent=created.grant.authority_node_id;
    const nodes=(id:string,kind:string,type:string,subject:string,parents:string[])=>{
      const seq=Number(db.query('SELECT MAX(issued_seq) AS maximum FROM multiremi_authority_nodes').get().maximum)+1;
      db.query(`INSERT INTO multiremi_authority_nodes VALUES(?,?,1,?,?,?,'system',2,9999999999999,NULL,?)`).run(id,seq,kind,type,subject,parents.length);
      for (const source of parents) db.query(`INSERT INTO multiremi_authority_edges SELECT ?,1,?,node_id,generation,issued_seq,'continuous'
        FROM multiremi_authority_nodes WHERE node_id=?`).run(id,seq,source);
    };
    nodes('grant-agent','grant','agent',agent.id,[parent,'password']);
    db.query(`INSERT INTO multiremi_root_grants(grant_id,subject_type,subject_id,generation,scope,authority_node_id,issuer_type,issuer_id,revision,reason,created_at_ms)
      VALUES('grant-agent','agent',?,1,'system','grant-agent','user','usr_auth',2,'fixture',1)`).run(agent.id);
    db.query("INSERT INTO multiremi_root_subject_state VALUES('agent',?,1,'grant-agent')").run(agent.id);
    expect(()=>store.createTask({id:'tsk_unadmitted',agentId:agent.id,prompt:'ordinary entry'})).toThrow('root_invoker_untrusted');
    expect(store.getTask('tsk_unadmitted')).toBeNull();
    db.query(`INSERT INTO multiremi_root_management_events(actor_user_id,proof_node_id,actor_grant_id,actor_generation,action,target_id,idempotency_key,
      payload_digest,reason,revision_before,revision_after,created_at_ms,result_json) VALUES('usr_auth','password',?,1,'root.grant.create',?,'fixture','fixture','fixture',1,2,1,'{}')`).run(created.grant.id,agent.id);
    nodes('machine','machine_registration','daemon','daemon',[]);
    nodes('runtime-trust','runtime_trust','runtime',execution.runtimeId,['machine',parent]);
    nodes('provider','provider_trust','agent',agent.id,['runtime-trust','grant-agent']);
    store.registerRuntime({id:execution.runtimeId,name:'test',provider:'codex',workspaceId:'local',daemonId:'daemon'});
    const signer=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'});
    const recipient=generateKeyPairSync('rsa',{modulusLength:3072}).publicKey.export({type:'spki',format:'pem'});
    db.query("INSERT INTO multiremi_access_tokens(id,name,type,workspace_id,daemon_id,token_hash,token_prefix,created_at) VALUES('machine-token','test','daemon','local','daemon',?,'test','now')").run(hash('machine-token'));
    db.query(`INSERT INTO multiremi_machine_enrollments VALUES('inc','deploy','consumer','rt_auth','daemon','machine-token',?,'machine',1,?,?,'key',9999999999999,1,NULL,1,9999999999999,'test')`)
      .run(hash('machine-token'),signer,recipient);
    const challenge=withSecurityWrite(db,undefined,{expectedRevision:1,workspaceIds:[],numberKeys:[],domainTargets:['authority:machine','machine:rt_auth']},
      tx=>beginMachineChallenge(db,tx,'machine-token','rt_auth','root.runtime-trust.grant','rt_auth'));
    db.query('UPDATE multiremi_machine_challenges SET consumed_at_ms=1 WHERE challenge_id=?').run(challenge.id);
    db.query(`INSERT INTO multiremi_runtime_trusts VALUES('trust','rt_auth',1,'inc',?,'runtime-trust','{}',NULL)`).run(challenge.id);
    db.query("UPDATE multiremi_turn_attempts SET status='lost' WHERE id=?").run(previous.id);
    const plan=service.planAttemptAdmission(passwordProof,target,execution);
    let manifest!:InputManifest;
    withAttemptAdmission(db,undefined,plan,{attemptId:target.attemptId,kernel:service,resolveInvocation(tx){
      const invocation=service.verifyDirectRetryInvocation(tx,passwordProof,target);
      const actor=service.authorizeWrite(tx,passwordProof,{action:'attempt.inputs.approve',use:'write',actualTarget:{type:'attempt',id:target.attemptId}});
      manifest=service.approveAttemptInputs(tx,actor,invocation,execution,{manifest:{id:'manifest',version:1},sourcePolicy:{id:'explicit',version:1},
        entries:[],providerState:{sessionId:null,securityDomainId:'domain',checkpointDigest:null}});
      return {subject:{type:'agent',id:agent.id},invocation};
    },resolveExecution(){return {execution,manifest};}},()=>createReplacementAttemptWithinTransaction(db,turnId,{id:target.attemptId,
      previousStatus:'lost',reason:'trusted retry',execution:{runtimeId:'rt_auth'}}));
    db.run("INSERT INTO multiremi_usage_runs VALUES('tsk_admitted','consumer',0,0)");
    const task=store.getTask(target.attemptId)!;
    const token=await store.createTaskAccessToken(task,'local');
    const expiry=Date.parse(token.expiresAt!);
    nodes('task-family','credential_family','agent',agent.id,['grant-agent','runtime-trust']);
    nodes('task-material','credential','agent',agent.id,['task-family']);
    db.query("INSERT INTO multiremi_credential_families VALUES('family','task-family',?,NULL,0)").run(expiry);
    db.query(`INSERT INTO multiremi_credential_version_bindings SELECT ?,1,?,'task','task','agent',?,'family',node_id,generation,issued_seq,?
      FROM multiremi_authority_nodes WHERE node_id='task-material'`).run(token.id,hash(token.token),agent.id,expiry);
    db.query(`INSERT INTO multiremi_credential_materials SELECT ?,1,'family',node_id,generation,issued_seq,?
      FROM multiremi_authority_nodes WHERE node_id='task-material'`).run(token.id,expiry);
    db.query(`INSERT INTO multiremi_usage_task_scopes(task_id,workspace_id,agent_id,runtime_id,active_run_id) VALUES(?,'local',?,'rt_auth','consumer')
      ON CONFLICT(task_id) DO UPDATE SET runtime_id='rt_auth',active_run_id='consumer'`).run(task.id,agent.id);
    const tuple={...fixtureDeliveryTuple,attempt_id:task.id,consumer_id:'consumer',handoff_id:null,runtime_id:'rt_auth',daemon_id:'daemon',incarnation:'inc',
      recipient_key_id:'key',recipient_key_fingerprint:`sha256:${createHash('sha256').update(createPublicKey(recipient).export({type:'spki',format:'der'})).digest('hex')}`,
      grant_id:'grant-agent',grant_generation:1,execution_config_epoch:1,execution_digest:execution.executionDigest,input_revision:1,input_digest:manifest.digest,checkpoint_digest:null,material_expires_at:token.expiresAt!};
    db.query(`INSERT INTO multiremi_delivery_receipts(receipt_id,attempt_id,run_generation,consumer_id,receipt_version,delivery_version,material_version,credential_id,
      binding_json,envelope,envelope_digest,business_payload_json,start_deadline,lease_id,fence_term,ack_state,run_state) VALUES(?,?,1,'consumer',1,1,1,?,?,'fixture',
      'fixture','{}',?,'one','1','pending','pending_start')`).run(tuple.receipt_id,task.id,token.id,serializeRootDeliveryTuple(tuple),token.expiresAt);
    db.query("UPDATE multiremi_turn_attempts SET status='accepted' WHERE id=?").run(task.id);
    const taskProof=service.registeredCredentials.verify(token.token);
    const use={action:'issue.read',use:'read',actualTarget:{type:'issue',id:issue.id}};
    expect(service.resolveCurrent(taskProof,use)).toMatchObject({effectiveRoot:true,transport:'task',subject:{type:'agent',id:agent.id}});
    db.query(`INSERT INTO multiremi_live_terms(scope,term,holder,updated_at) VALUES('background_jobs',1,'test','now')
      ON CONFLICT(scope) DO UPDATE SET term=1,holder='test'`).run();
    const lease={...execution,leaseId:'one',fenceTerm:'1',consumerId:'consumer',runGeneration:1,expiresAtMs:Date.now()+60000,state:'dispatched' as const};
    withSecurityWrite(db,'1',plan,tx=>{
      expect(readAttemptEligibility(db,tx,target.attemptId)).toMatchObject({eligibility:'root',grant_id:'grant-agent',runtime_trust_id:'trust'});
      expect(writeCurrentTaskLease(db,tx,0,lease)).toBe(1);
      expect(writeCurrentTaskLease(db,tx,1,{...lease,state:'running'})).toBe(2);
    });
    expect(()=>withSecurityWrite(db,'1',plan,tx=>writeCurrentTaskLease(db,tx,1,lease))).toThrow('authority_revision_conflict');
    expect(withSecurityWrite(db,'1',plan,tx=>readCurrentTaskLease(db,tx,target.attemptId)?.state)).toBe('running');
    expect(()=>withSecurityWrite(db,undefined,plan,tx=>readCurrentTaskLease(db,tx,target.attemptId))).toThrow('security_tx_invalid');
    expect(service.resolveCurrent(taskProof,use).effectiveRoot).toBe(false);
    db.query("UPDATE multiremi_turn_attempts SET status='running' WHERE id=?").run(task.id);
    db.query("UPDATE multiremi_delivery_receipts SET run_state='running',ack_state='confirmed',execution_locator_json='{}',start_deadline='2000-01-01T00:00:00Z' WHERE receipt_id=?").run(tuple.receipt_id);
    expect(service.resolveCurrent(taskProof,use).effectiveRoot).toBe(true);
    db.run("UPDATE multiremi_current_task_leases SET expires_at_ms=1 WHERE attempt_id='tsk_admitted'");
    expect(service.resolveCurrent(taskProof,use).effectiveRoot).toBe(false);
  });

  it('keeps ordinary attempts ineligible and refuses lease writes without the active fence',()=>{
    const {db,store}=fixture();
    const agent=store.createAgent({name:'ordinary',provider:'codex'});
    const task=store.createTask({agentId:agent.id,prompt:'ordinary'});
    const plan={expectedRevision:0,workspaceIds:[],numberKeys:[],domainTargets:[`attempt:${task.id}`]};
    withSecurityWrite(db,undefined,plan,tx=>{
      expect(readAttemptEligibility(db,tx,task.id)?.eligibility??'none').toBe('none');
      expect(readCurrentTaskLease(db,tx,task.id)).toBeFalsy();
    });
    const lease={attemptId:task.id,leaseId:'lease',fenceTerm:'1',consumerId:'consumer',runGeneration:0,runtimeId:'runtime',daemonId:'daemon',
      incarnation:'incarnation',expiresAtMs:Date.now()+60000,state:'dispatched' as const};
    expect(()=>withSecurityWrite(db,undefined,plan,tx=>writeCurrentTaskLease(db,tx,0,lease))).toThrow('security_tx_invalid');
    db.query(`INSERT INTO multiremi_live_terms(scope,term,holder,updated_at) VALUES('background_jobs',1,'test','now')
      ON CONFLICT(scope) DO UPDATE SET term=1,holder='test'`).run();
    expect(()=>withSecurityWrite(db,'1',plan,tx=>writeCurrentTaskLease(db,tx,0,lease))).toThrow('authority_revision_conflict');
  });
},{isolation:'snapshot'});
