import { expect } from 'bun:test';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { RootMachineKeys } from '@daemon/agent-runtime/root-machine-keys.js';
import type { StoreContext } from '@multiremi/store/context.js';
import { beginMachineChallenge, verifyMachineChallenge } from '@multiremi/store/machine-proof.js';
import { agentDependencyDigest } from '@multiremi/store/agent-dependencies.js';
import type { AgentConfigurationApproval } from '@multiremi/store/agent-source-approvals.js';
import { readWorkspacePromptSettings } from '@multiremi/prompts/workspace-settings.js';
import { runtimeConnectionSnapshot } from '@multiremi/contracts/runtime-connection.js';
import type { MachineChallenge } from '@shared/machine-challenge.js';
import { bootstrap } from './fixtures/root-kernel-bootstrap.js';
import { PreparedRootDelivery, RootReceiptStore, rootBusinessPayloadDigest } from '@multiremi/store/root-receipts.js';
import { retryAdmittedTurn } from '@multiremi/store/attempt-admission.js';
import { fixtureDeliveryTuple } from '../../fixtures/root-authority.js';
import { JwtMaterials } from '@multiremi/store/jwt-materials.js';
import { withSecurityWrite } from '@multiremi/store/security-write.js';
import type { PendingTurnTestFixture } from './pending-turn-test-backends.js';

const hash = (input:string) => createHash('sha256').update(input).digest('hex');

export async function prepareRecoveryFixture(fixture: PendingTurnTestFixture) {
  const signingKeys = generateKeyPairSync('ed25519');
  const recipientKeys = generateKeyPairSync('rsa', {modulusLength:3072});
  const machine = new RootMachineKeys(recoveryIdentity(), recipientKeys.privateKey, signingKeys.privateKey);
  const result = await prepareEnrolledRecoveryFixture(fixture, signingKeys.publicKey.export({type:'spki',format:'pem'}).toString(),
    recipientKeys.publicKey.export({type:'spki',format:'pem'}).toString(), async challenge=>machine.answerChallenge(challenge));
  const decryptionKey = await crypto.subtle.importKey('jwk', recipientKeys.privateKey.export({format:'jwk'}), {name:'RSA-OAEP',hash:'SHA-256'}, false, ['decrypt']);
  return { ...result, machine, decryptionKey };
}

export function recoveryIdentity() {
  return { runtimeId:'rt_auth', daemonId:'daemon', consumerId:'consumer', incarnation:'inc', recipientKeyId:'key',
    deploymentId:'deploy', credentialId:'machine-token', credentialDigest:hash('machine-token'), keyExpiresAtMs:Date.now()+300000 };
}

export async function prepareRecoveryAdmission(fixture: PendingTurnTestFixture, signer: string, recipient: string,
  sign: (challenge: MachineChallenge) => Promise<ReturnType<RootMachineKeys['answerChallenge']>>) {
    const {store} = fixture;
    const db = (store as unknown as {ctx:StoreContext}).ctx.db;
    const {service,passwordProof,created,signing}=await bootstrap(db, store.resolveAgentDependencies);
    const runtime=store.registerRuntime({id:'rt_auth',name:'test',provider:'codex',workspaceId:'local',daemonId:'daemon'});
    const agent=store.createAgent({name:'admitted',provider:'codex',runtimeId:runtime.id});
    const issue=fixture.createIssue({title:'admission',assigneeType:'agent',assigneeId:agent.id});
    const previous=store.createTask({agentId:agent.id,issueId:issue.id,prompt:'previous',runtimeId:runtime.id});
    const turnId=db.query('SELECT turn_id FROM multiremi_turn_attempts WHERE id=?').get(previous.id).turn_id;
    const target={turnId,previousAttemptId:previous.id,attemptId:'tsk_admitted'};
    const execution={attemptId:target.attemptId,runtimeId:'rt_auth',daemonId:'daemon',incarnation:'inc',configEpoch:0,executionDigest:hash('execution'),
      providerTrust:{id:'provider',version:1},checkpointTrust:null};
    const parent=created.grant.authority_node_id;
    const nodes=(id:string,kind:string,type:string,subject:string,parents:string[])=>{
      const seq=Number(db.query('SELECT MAX(issued_seq) AS maximum FROM multiremi_authority_nodes').get().maximum)+1;
      db.query(`INSERT INTO multiremi_authority_nodes VALUES(?,?,1,?,?,?,'system',2,9999999999999,NULL,?)`).run(id,seq,kind,type,subject,parents.length);
      for (const source of parents) db.query(`INSERT INTO multiremi_authority_edges SELECT ?,1,?,node_id,generation,issued_seq,'continuous'
        FROM multiremi_authority_nodes WHERE node_id=?`).run(id,seq,source);
    };
    nodes('machine','machine_registration','daemon','daemon',[]);
    nodes('runtime-trust','runtime_trust','runtime',execution.runtimeId,['machine',parent]);
    db.query("INSERT INTO multiremi_access_tokens(id,name,type,workspace_id,daemon_id,token_hash,token_prefix,created_at) VALUES('machine-token','test','daemon','local','daemon',?,'test','now')").run(hash('machine-token'));
    db.query(`INSERT INTO multiremi_machine_enrollments VALUES('inc','deploy','consumer','rt_auth','daemon','machine-token',?,'machine',1,?,?,'key',9999999999999,1,NULL,1,9999999999999,'test')`)
      .run(hash('machine-token'),signer,recipient);
    const challenge=withSecurityWrite(db,undefined,{expectedRevision:1,workspaceIds:[],numberKeys:[],domainTargets:['authority:machine','machine:rt_auth']},
      tx=>beginMachineChallenge(db,tx,'machine-token','rt_auth','root.runtime-trust.grant','rt_auth'));
    const proof = await sign(challenge);
    withSecurityWrite(db,undefined,{expectedRevision:1,workspaceIds:[],numberKeys:[],domainTargets:['authority:machine','machine:rt_auth']},
      tx=>verifyMachineChallenge(db,tx,'machine-token',challenge.id,challenge.purpose,challenge.targetId,proof));
    db.query(`INSERT INTO multiremi_runtime_trusts VALUES('trust','rt_auth',1,'inc',?,'runtime-trust','{}',NULL)`).run(challenge.id);
    const sources: Array<AgentConfigurationApproval['sources'][number]> = [];
    function record(kind:string,id:string,use:string,value:unknown) {
      const ref = {kind,id,use,version:0,digest:agentDependencyDigest(value)};
      sources.push({ref,content:JSON.stringify(value),dependencies:[]});
      return ref;
    }
    const {skills,root:_root,...configuration} = store.getAgent(agent.id,{includeFiles:true})!;
    record('agent',agent.id,'configuration',configuration);
    record('agent',agent.id,'instructions',agent.instructions);
    record('agent',agent.id,'skills',skills);
    record('agent',agent.id,'plugins',store.resolveAgentPluginSnapshot(agent.id));
    const workspace = store.getWorkspace('local')!;
    record('workspace','local','configuration',{context:workspace.context,settings:workspace.settings,repos:workspace.repos});
    record('workspace','local','prompt',readWorkspacePromptSettings(workspace));
    const host = store.getRuntime(runtime.id)!;
    record('runtime',runtime.id,'execute',{daemonId:host.daemonId,incarnation:'inc',provider:host.provider,runtimeMode:host.runtimeMode,metadata:host.metadata,models:host.models});
    const profile = runtimeConnectionSnapshot(store.getAgentExecutionProfile(runtime.id,agent),agent.model);
    const {digest:profileDigest} = record('runtime',runtime.id,'effective-profile',profile);
    const provider = record('provider-trust','provider','execute','provider');
    const checkpointPolicy = record('checkpoint-policy','checkpoint','restore','checkpoint');
    const inputPolicy = record('input-policy','input','accept','input');
    const actualTarget = {type:'agent',id:agent.id};
    const approvalUse = {action:'root.agent-configuration.approve',use:'write',actualTarget};
    const plan = service.planAgentGrant(passwordProof,agent.id,['trust']);
    const approved = withSecurityWrite(db,undefined,plan,tx=>service.approveAgentConfiguration(tx,service.authorizeWrite(tx,passwordProof,approvalUse),agent.id,null,
      {sources,executions:[{trustId:'trust',profileDigest,provider,checkpointPolicy,inputPolicy}]}));
    const human = service.issueIndependentDashboardSession(passwordProof,(Math.floor(Date.now()/1000)+1800)*1000,
      (tx,source,claims)=>new JwtMaterials(db).issue(tx,source,claims,signing));
    const dashboard = service.registeredCredentials.verifyJwt(human,signing);
    const grantPlan = service.planAgentGrant(dashboard,agent.id,['trust']);
    const grantUse = {action:'root.grant.create',use:'management',actualTarget};
    const {grant} = withSecurityWrite(db,undefined,grantPlan,tx=>service.grant(tx,service.authorizeWrite(tx,dashboard,grantUse),{
      subject:{type:'agent',id:agent.id},runtime_trust_ids:['trust'],accepted_dependency_digest:approved.digest,
      expected_revision:grantPlan.expectedRevision,idempotency_key:'recovery-grant',reason:'approved recovery fixture'}));
    nodes('provider','provider_trust','agent',agent.id,['runtime-trust',grant.authority_node_id]);
    const inputs={manifest:{id:'manifest',version:1},sourcePolicy:{id:'explicit',version:1},
      entries:[{source:{id:'password',version:1},purpose:'instruction' as const,snapshot:'previous',author:{type:'user' as const,id:'usr_auth'}}],providerState:{sessionId:null,securityDomainId:'domain',checkpointDigest:null}};
    const directProof = await store.rootManagement.verifyIndependentPassword('usr_auth', 'test-dashboard-password');
    db.query("UPDATE multiremi_turn_attempts SET status='lost' WHERE id=?").run(previous.id);
    db.query("UPDATE multiremi_turns SET status='failed' WHERE id=?").run(turnId);
    expect(retryAdmittedTurn(store,turnId,previous.id,directProof,execution,()=>({execution,inputs})).current_attempt_id).toBe(target.attemptId);
    return {db,store,target,execution,runtime,human,signing,grant,approved,turnId,service};
}

export async function prepareEnrolledRecoveryFixture(fixture: PendingTurnTestFixture, signer: string, recipient: string,
  sign: (challenge: MachineChallenge) => Promise<ReturnType<RootMachineKeys['answerChallenge']>>) {
    const {db,store,target,execution,runtime,human,signing,grant,approved,turnId,service} = await prepareRecoveryAdmission(fixture,signer,recipient,sign);
    const manifest=JSON.parse(db.query('SELECT manifest_json FROM multiremi_attempt_eligibility WHERE attempt_id=?').get(target.attemptId).manifest_json);

    const task=store.getTask(target.attemptId)!;
    const expiresAt=new Date(Date.now()+300000).toISOString();

    expect(store.claimTask(execution.runtimeId,{supportsPromptPolicy:true,policyProtocol:'adopt',offerGeneration:'test-offer',rootMachineCredentialId:'machine-token'})?.id).toBe(task.id);
    const policy = store.systemPromptsRepo();
    expect(store.recordTaskOffered(task.id, runtime.id, undefined, 'test-offer')).toBe(true);
    const reportPolicy = { offer_generation: 'test-offer', content_hash: policy.getAttemptSystemPrompt(task.id)!.contentHash,
      receipt_id: 'policy-receipt' };
    expect(policy.adoptOffer({ ...reportPolicy, attempt_id: task.id, workspace_id: 'local', runtime_id: runtime.id, daemon_id: 'daemon' })).toBe(true);
    const business={turn_id:turnId, input:{policy_receipt:reportPolicy}};
    const tuple={...fixtureDeliveryTuple,business_payload_digest:rootBusinessPayloadDigest(business),attempt_id:task.id,consumer_id:'consumer',handoff_id:null,handoff_generation:0,runtime_id:'rt_auth',daemon_id:'daemon',incarnation:'inc',
      recipient_key_id:'key',recipient_key_fingerprint:`sha256:${createHash('sha256').update(createPublicKey(recipient).export({type:'spki',format:'der'})).digest('hex')}`,
      grant_id:grant.id,grant_generation:grant.generation,execution_config_epoch:approved.configEpoch,execution_digest:execution.executionDigest,input_revision:1,input_digest:manifest.digest,checkpoint_digest:null,material_expires_at:expiresAt};
    const algorithm={name:'RSA-OAEP',hash:'SHA-256'};
    const enc=await crypto.subtle.importKey('jwk',createPublicKey(recipient).export({format:'jwk'}),algorithm,false,['encrypt']);
    const candidate=await PreparedRootDelivery.prepare(tuple,business,enc);
    db.query(`INSERT INTO multiremi_live_terms(scope,term,holder,updated_at) VALUES('background_jobs',1,'test','now')
      ON CONFLICT(scope) DO UPDATE SET term=1,holder='test'`).run();
    const lease={...execution,leaseId:'one',fenceTerm:'1',consumerId:'consumer',runGeneration:1,expiresAtMs:Date.now()+180000,state:'dispatched' as const};
    const offerLease={lease_id:'one',fence_term:'1',start_deadline:new Date(lease.expiresAtMs).toISOString()};

    const delivery = new RootReceiptStore(db, service).commitFirstOffer(candidate, offerLease);
    return { delivery, human, signing, reportPolicy };
}
