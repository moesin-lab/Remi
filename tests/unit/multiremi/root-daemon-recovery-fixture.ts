import { expect } from 'bun:test';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { RootMachineKeys } from '@daemon/agent-runtime/root-machine-keys.js';
import type { SqlDatabase } from '@multiremi/store/db/postgres.js';
import { beginMachineChallenge } from '@multiremi/store/machine-proof.js';
import { PreparedRootDelivery, RootReceiptStore, rootBusinessPayloadDigest } from '@multiremi/store/root-receipts.js';
import { retryAdmittedTurn } from '@multiremi/store/attempt-admission.js';
import { fixtureDeliveryTuple } from '../../fixtures/root-authority.js';
import { JwtMaterials } from '@multiremi/store/jwt-materials.js';
import { bootstrapAuthorizationDigest, RootManagement } from '@multiremi/store/root-management.js';
import { withSecurityWrite } from '@multiremi/store/security-write.js';
import type { PendingTurnTestFixture } from './pending-turn-test-backends.js';

const hash = (input:string) => createHash('sha256').update(input).digest('hex');

async function bootstrap(db:SqlDatabase, service: RootManagement) {
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

export async function prepareRecoveryFixture(fixture: PendingTurnTestFixture) {
  const { db, store } = fixture;
    const {service,passwordProof,created,signing}=await bootstrap(db, new RootManagement(db));
    const runtime=store.registerRuntime({id:'rt_auth',name:'test',provider:'codex',workspaceId:'local',daemonId:'daemon'});
    const agent=store.createAgent({name:'admitted',provider:'codex',runtimeId:runtime.id});
    const issue=fixture.createIssue({title:'admission',assigneeType:'agent',assigneeId:agent.id});
    const previous=store.createTask({agentId:agent.id,issueId:issue.id,prompt:'previous',runtimeId:runtime.id});
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
    db.query(`INSERT INTO multiremi_root_management_events(actor_user_id,proof_node_id,actor_grant_id,actor_generation,action,target_id,idempotency_key,
      payload_digest,reason,revision_before,revision_after,created_at_ms,result_json) VALUES('usr_auth','password',?,1,'root.grant.create',?,'fixture','fixture','fixture',1,2,1,'{}')`).run(created.grant.id,agent.id);
    nodes('machine','machine_registration','daemon','daemon',[]);
    nodes('runtime-trust','runtime_trust','runtime',execution.runtimeId,['machine',parent]);
    nodes('provider','provider_trust','agent',agent.id,['runtime-trust','grant-agent']);
    const signingKeys=generateKeyPairSync('ed25519');
    const signer=signingKeys.publicKey.export({type:'spki',format:'pem'});
    const recipientKeys=generateKeyPairSync('rsa',{modulusLength:3072});
    const recipient=recipientKeys.publicKey.export({type:'spki',format:'pem'});
    db.query("INSERT INTO multiremi_access_tokens(id,name,type,workspace_id,daemon_id,token_hash,token_prefix,created_at) VALUES('machine-token','test','daemon','local','daemon',?,'test','now')").run(hash('machine-token'));
    db.query(`INSERT INTO multiremi_machine_enrollments VALUES('inc','deploy','consumer','rt_auth','daemon','machine-token',?,'machine',1,?,?,'key',9999999999999,1,NULL,1,9999999999999,'test')`)
      .run(hash('machine-token'),signer,recipient);
    const challenge=withSecurityWrite(db,undefined,{expectedRevision:1,workspaceIds:[],numberKeys:[],domainTargets:['authority:machine','machine:rt_auth']},
      tx=>beginMachineChallenge(db,tx,'machine-token','rt_auth','root.runtime-trust.grant','rt_auth'));
    db.query('UPDATE multiremi_machine_challenges SET consumed_at_ms=1 WHERE challenge_id=?').run(challenge.id);
    db.query(`INSERT INTO multiremi_runtime_trusts VALUES('trust','rt_auth',1,'inc',?,'runtime-trust','{}',NULL)`).run(challenge.id);
    const inputs={manifest:{id:'manifest',version:1},sourcePolicy:{id:'explicit',version:1},
      entries:[],providerState:{sessionId:null,securityDomainId:'domain',checkpointDigest:null}};
    const directProof = await store.rootManagement.verifyIndependentPassword('usr_auth', 'test-dashboard-password');
    db.query("UPDATE multiremi_turn_attempts SET status='lost' WHERE id=?").run(previous.id);
    db.query("UPDATE multiremi_turns SET status='failed' WHERE id=?").run(turnId);
    expect(retryAdmittedTurn(store,turnId,previous.id,directProof,execution,()=>({execution,inputs})).current_attempt_id).toBe(target.attemptId);
    const manifest=JSON.parse(db.query('SELECT manifest_json FROM multiremi_attempt_eligibility WHERE attempt_id=?').get(target.attemptId).manifest_json);

    const task=store.getTask(target.attemptId)!;
    const expiresAt=new Date(Date.now()+300000).toISOString();

    const business={turn_id:turnId};
    const tuple={...fixtureDeliveryTuple,business_payload_digest:rootBusinessPayloadDigest(business),attempt_id:task.id,consumer_id:'consumer',handoff_id:null,handoff_generation:0,runtime_id:'rt_auth',daemon_id:'daemon',incarnation:'inc',
      recipient_key_id:'key',recipient_key_fingerprint:`sha256:${createHash('sha256').update(createPublicKey(recipient).export({type:'spki',format:'der'})).digest('hex')}`,
      grant_id:'grant-agent',grant_generation:1,execution_config_epoch:1,execution_digest:execution.executionDigest,input_revision:1,input_digest:manifest.digest,checkpoint_digest:null,material_expires_at:expiresAt};
    const algorithm={name:'RSA-OAEP',hash:'SHA-256'};
    const enc=await crypto.subtle.importKey('jwk',recipientKeys.publicKey.export({format:'jwk'}),algorithm,false,['encrypt']);
    const dec=await crypto.subtle.importKey('jwk',recipientKeys.privateKey.export({format:'jwk'}),algorithm,false,['decrypt']);
    const candidate=await PreparedRootDelivery.prepare(tuple,business,enc);
    db.query(`INSERT INTO multiremi_live_terms(scope,term,holder,updated_at) VALUES('background_jobs',1,'test','now')
      ON CONFLICT(scope) DO UPDATE SET term=1,holder='test'`).run();
    const lease={...execution,leaseId:'one',fenceTerm:'1',consumerId:'consumer',runGeneration:1,expiresAtMs:Date.now()+60000,state:'dispatched' as const};
    const offerLease={lease_id:'one',fence_term:'1',start_deadline:new Date(lease.expiresAtMs).toISOString()};

    expect(store.claimTask(execution.runtimeId,{supportsPromptPolicy:true,policyProtocol:'adopt',offerGeneration:'test-offer'})?.id).toBe(task.id);
    const policy = store.systemPromptsRepo();
    expect(store.recordTaskOffered(task.id, runtime.id, undefined, 'test-offer')).toBe(true);
    const reportPolicy = { offer_generation: 'test-offer', content_hash: policy.getAttemptSystemPrompt(task.id)!.contentHash,
      receipt_id: 'policy-receipt' };
    expect(policy.adoptOffer({ ...reportPolicy, attempt_id: task.id, workspace_id: 'local', runtime_id: runtime.id, daemon_id: 'daemon' })).toBe(true);
    const delivery = new RootReceiptStore(db, service).commitFirstOffer(candidate, offerLease);
    const human = service.issueIndependentDashboardSession(passwordProof, (Math.floor(Date.now()/1000)+300)*1000,
      (tx, source, claims) => new JwtMaterials(db).issue(tx, source, claims, signing));
    const machine = new RootMachineKeys({runtimeId:runtime.id, daemonId:'daemon', consumerId:'consumer',
      incarnation:'inc', recipientKeyId:'key', deploymentId:'deploy', credentialId:'machine-token',
      credentialDigest:hash('machine-token'), keyExpiresAtMs:Date.parse(expiresAt)}, recipientKeys.privateKey, signingKeys.privateKey);
    return { delivery, machine, decryptionKey: dec, human, signing, reportPolicy };
}
