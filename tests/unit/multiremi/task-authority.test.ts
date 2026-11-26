import { createMultiremiApp, startMultiremiServer } from '@multiremi/api.js';
import { createHub } from '@multiremi/api/hub/hub-core.js';
import { createLocalHubTransport } from '@multiremi/api/hub/hub-transport.js';
import { authenticateBrowserWebSocket, nextWebSocketMessage } from './helpers.js';
import { deltaTraceEvent } from '../../helpers/turn-trace.js';
import type { MultiremiStore } from '@multiremi/store/store.js';
import { expect, it } from 'bun:test';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { RootMachineKeys } from '@daemon/agent-runtime/root-machine-keys.js';
import { RootReceiptClient } from '@multiremi/worker/root-receipt-client.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import type { RaceInput } from './fixtures/root-issuer-race.js';
import type { SqlDatabase } from '@multiremi/store/db/postgres.js';
import { beginMachineChallenge } from '@multiremi/store/machine-proof.js';
import { PreparedRootDelivery, RootReceiptStore, rootBusinessPayloadDigest } from '@multiremi/store/root-receipts.js';
import { DaemonProtocolClient, type DaemonProtocolLane } from '@multiremi/worker/daemon-protocol-client.js';
import { DAEMON_MIN_CLI_VERSION } from '@multiremi/contracts/daemon-protocol.js';
import { planVerifiedAttemptWrite } from '@multiremi/store/attempt-admission.js';
import { PreparedAgentPat } from '@multiremi/store/durable-delegation.js';
import { bootstrap } from './fixtures/root-kernel-bootstrap.js';
import { fixtureDeliveryTuple } from '../../fixtures/root-authority.js';
import { prepareRunInstallation, acknowledgeRunEnvironment } from '@multiremi/worker/root-run-installation.js';
import { JwtMaterials } from '@multiremi/store/jwt-materials.js';
import { RootManagement } from '@multiremi/store/root-management.js';
import { withSecurityWrite } from '@multiremi/store/security-write.js';
import { readAttemptEligibility, readCurrentTaskLease, writeCurrentTaskLease } from '@multiremi/store/task-authority.js';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';

const hash = (input:string) => createHash('sha256').update(input).digest('hex');

async function raceIssuers(db:SqlDatabase,databaseUrl:string|undefined,inputs:[RaceInput,RaceInput],verify:(result:string[],database:SqlDatabase)=>void) {
  const directory=mkdtempSync(join(tmpdir(),'root-issuer-race-'));
  const database=databaseUrl??join(directory,'fixture.sqlite');
  const workers:Worker[]=[];
  try {
    if (!databaseUrl) db.query('VACUUM INTO ?').run(database);
    const barrier=new SharedArrayBuffer(4);
    const results=await Promise.all(inputs.map(input=>new Promise<string>((resolve,reject)=>{
      const worker=new Worker(new URL('./fixtures/root-issuer-race.ts',import.meta.url).href);
      workers.push(worker);
      worker.onmessage=event=>resolve(event.data);
      worker.onerror=event=>reject(new Error(event.message));
      worker.postMessage({database,backend:db.dialect,barrier,input});
    })));
    const copy=databaseUrl?null:openSqliteDatabase(database);
    try { verify(results,copy ? copy as unknown as SqlDatabase : db); } finally { copy?.close(); }
  } finally { await Promise.all(workers.map(worker=>worker.terminate())); rmSync(directory,{recursive:true,force:true}); }
}

function rootClient(store: MultiremiStore, signing: { domainId: string; keyEpoch: string; secret: string }) {
  const master = 'isolated-master-token';
  const { request } = createMultiremiApp({ store, authToken: master });
  return async (path: string, token = master, body?: object, method = body ? 'POST' : 'GET') => {
    const env = { JWT_SECRET: signing.secret, MULTIREMI_JWT_SIGNING_DOMAIN: signing.domainId, MULTIREMI_JWT_KEY_EPOCH: signing.keyEpoch };
    const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    try {
      return await request(path, { method, headers: {
        authorization: 'Bearer ' + token, ...(body && { 'content-type': 'application/json' }),
      }, ...(body && { body: JSON.stringify(body) }) });
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
}

pendingTurnBackendTests('task and mutation authority', fixture=>{
  it('resolves registered dashboard material on a generic target and rechecks its origin for mutations',async()=>{
    const {db,store}=fixture();
    const {service,passwordProof,signing,input}=await bootstrap(db);
    const compact=service.issueIndependentDashboardSession(passwordProof,(Math.floor(Date.now()/1000)+300)*1000,
      (tx,source,claims)=>new JwtMaterials(db).issue(tx,source,claims,signing));
    const proof=service.registeredCredentials.verifyJwt(compact,signing);
    const api = rootClient(store, signing);
    const context = await api('/api/root/context', compact);
    expect(context.status).toBe(200);
    expect(await context.json()).toMatchObject({ effective_root: true, transport_identity: 'human', authenticated_subject: { type: 'user', id: input.userId } });
    expect((await api('/api/root/grants')).status).toBe(403);
    for (const role of ['normal', 'maintainer', 'supervisor'] as const) {
      const agent = store.createAgent({ name: 'Legacy ' + role, provider: 'codex', role });
      const task = store.createTask({ agentId: agent.id, prompt: 'ordinary task' });
      const token = await store.createTaskAccessToken(task, 'local');
      expect(store.getAgent(agent.id)?.role).toBe(role);
      expect((await api('/api/workspaces/local', token.token)).status).toBe(200);
      expect((await api('/api/root/grants', token.token)).status).toBe(403);
    }
    expect(await (await api('/api/root/context')).json()).toMatchObject({ effective_root: false, transport_identity: 'master', authenticated_subject: null });
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
    const subject = {type:'user',id:'usr_second'} as const;
    db.run("INSERT INTO multiremi_users(id,name,email,created_at,updated_at) VALUES('usr_second','test','second@example.invalid','now','now')");
    db.run("INSERT INTO multiremi_password_credentials SELECT 'usr_second','second@example.invalid',password_hash,updated_at FROM multiremi_password_credentials WHERE user_id='usr_auth'");
    db.run("INSERT INTO multiremi_authority_nodes VALUES('identity2',100,1,'independent_identity','user','usr_second','system',0,9999999999999,NULL,0)");
    db.run("INSERT INTO multiremi_authority_nodes VALUES('password2',101,1,'password','user','usr_second','system',0,9999999999999,NULL,1)");
    db.run("INSERT INTO multiremi_authority_edges VALUES('password2',1,101,'identity2',1,100,'continuous')");
    db.run("INSERT INTO multiremi_password_authority_versions SELECT 'usr_second',1,verifier_digest,'password2','identity2' FROM multiremi_password_authority_versions WHERE user_id='usr_auth'");
    const recipient=await service.verifyIndependentPassword(subject.id,'test-dashboard-password');
    const createUse={action:'root.grant.create',use:'management',actualTarget:subject};
    const rejected = await api('/api/root/grants', compact, { subject: { type: 'agent', id: 'agt_fixture' } });
    expect(await rejected.json()).toMatchObject({ error: { code: 'root_required' } });
    for (const [credential, bearer] of [[proof, compact], [patProof, 'fixture-pat']] as const) {
      const origin=service.resolveCurrent(credential,createUse).credentialOrigin!;
      const createPlan=service.plan(credential,createUse);
      const request={subject,expected_revision:createPlan.expectedRevision,idempotency_key:origin.credential.id,reason:'delegate'};
      const granted = await api('/api/root/grants', bearer, request);
      expect(granted.status).toBe(200);
      const result = await granted.json();
      expect(await (await api('/api/root/grants?status=active&subject_id=' + subject.id, bearer)).json()).toMatchObject({ grants: [{ id: result.grant.id, effective: true }] });
      expect(result.grant).toMatchObject({origin_family_id:registered.family_id,issuer:{type:'user',id:'usr_auth'}});
      expect(db.query('SELECT proof_node_id FROM multiremi_root_management_events WHERE revision_after=?').get(result.security_revision)?.proof_node_id).toBe(origin.node.nodeId);
      expect(service.resolveCurrent(recipient,use).effectiveRoot).toBe(true);
      const revokeUse={action:'root.grant.revoke',use:'management',actualTarget:{type:'grant',id:result.grant.id}};
      const revoked = await api('/api/root/grants/' + result.grant.id + '/revoke', bearer,
        { expected_revision: result.security_revision, idempotency_key: 'revoke', reason: 'withdraw' });
      expect(revoked.status).toBe(200);
      expect(await (await api('/api/root/audit?limit=1&action=' + revokeUse.action, bearer)).json()).toMatchObject({ entries: [{ credential_id: origin.credential.id, target_id: result.grant.id }] });
      expect(service.resolveCurrent(recipient,use).effectiveRoot).toBe(false);
    }
    const familyUse={action:'root.credential-family.revoke',use:'management',actualTarget:{type:'credential_family',id:registered.family_id}};
    const familyPlan=service.plan(proof,familyUse);
    const other = store.createWorkspace({ id: 'ws_socket_root', name: 'Socket workspace', slug: 'root-socket' });
    const privateAgent = store.createAgent({ name: 'Socket target', provider: 'codex', workspaceId: other.id, visibility: 'private' });
    const task = store.createTask({ agentId: privateAgent.id, workspaceId: other.id, prompt: 'socket check' });
    const hub = createHub({ transport: createLocalHubTransport(), scheduleFlush: () => {} });
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: '127.0.0.1', authToken: 'isolated-master-token', liveHub: hub });
    const socket = new WebSocket('ws://127.0.0.1:' + server.port + '/api/trace/ws?workspace_id=local');
    try {
      await authenticateBrowserWebSocket(socket, 'fixture-pat');
      const ack = nextWebSocketMessage(socket);
      socket.send(JSON.stringify({ type: 'stream.subscribe', payload: { stream: 'trace', id: task.id, from_seq: 0 } }));
      expect(await ack).toMatchObject({ type: 'stream.ack', payload: { id: task.id } });
      const data = nextWebSocketMessage(socket);
      hub.append(task.id, [deltaTraceEvent(1, 'visible before revocation')]);
      hub.flushNow();
      expect(await data).toMatchObject({ type: 'stream.data', payload: { id: task.id } });
      const revokedFamily = await api('/api/root/credential-families/' + registered.family_id + '/revoke', compact,
        { expected_revision: familyPlan.expectedRevision, idempotency_key: 'family', reason: 'withdraw', reason_code: 'operator_security_revoke' });
      expect(revokedFamily.status).toBe(200);
      expect((await api('/api/root/grants', compact)).status).toBe(401);
      expect((await api('/api/root/grants', 'fixture-pat')).status).toBe(401);
      const rejected = nextWebSocketMessage(socket);
      hub.append(task.id, [deltaTraceEvent(2, 'must not leave the server')]);
      hub.flushNow();
      expect(await rejected).toMatchObject({ type: 'stream.error', payload: { id: task.id, code: 'forbidden' } });
    } finally {
      socket.close();
      server.stop(true);
      hub.shutdown();
    }
    expect(()=>service.resolveCurrent(proof,use)).toThrow('root_authority_revoked');
    expect(()=>service.resolveCurrent(patProof,use)).toThrow('credential_version_conflict');
  });

  it('binds registered management trust changes to the dashboard proof and current machine', async()=>{
    const {db,store}=fixture();
    const {service,passwordProof,signing}=await bootstrap(db);
    const compact=service.issueIndependentDashboardSession(passwordProof,(Math.floor(Date.now()/1000)+300)*1000,
      (tx,source,claims)=>new JwtMaterials(db).issue(tx,source,claims,signing));
    const proof=service.registeredCredentials.verifyJwt(compact,signing);
    store.registerRuntime({id:'rt_management',name:'test',provider:'codex',workspaceId:'local',daemonId:'daemon'});
    const signature=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'});
    const recipient=generateKeyPairSync('rsa',{modulusLength:3072}).publicKey;
    db.run("INSERT INTO multiremi_authority_nodes VALUES('machine',100,1,'machine_registration','daemon','daemon','system',1,9999999999999,NULL,0)");
    db.query("INSERT INTO multiremi_access_tokens(id,name,type,workspace_id,daemon_id,token_hash,token_prefix,created_at) VALUES('machine-token','test','daemon','local','daemon',?,'test','now')").run(hash('machine-token'));
    db.query(`INSERT INTO multiremi_machine_enrollments VALUES('inc','deploy','consumer','rt_management','daemon','machine-token',?,'machine',1,?,?,'key',9999999999999,1,NULL,1,9999999999999,'test')`)
      .run(hash('machine-token'),signature,recipient.export({type:'spki',format:'pem'}));
    const grantUse={action:'root.runtime-trust.grant',use:'management',actualTarget:{type:'runtime',id:'rt_management'}};
    const plan=service.plan(proof,grantUse);
    const challenge=withSecurityWrite(db,undefined,{...plan,domainTargets:[...plan.domainTargets,'machine:rt_management'].sort()},
      tx=>beginMachineChallenge(db,tx,'machine-token','rt_management',grantUse.action,'rt_management'));
    db.query('UPDATE multiremi_machine_challenges SET consumed_at_ms=1,proof_digest=? WHERE challenge_id=?').run('verified',challenge.id);
    const api = rootClient(store, signing);
    const grant = (response: string) => api('/api/root/runtime-trust', compact, {
      runtime_id:'rt_management',daemon_id:'daemon',incarnation:'inc',recipient_key_id:'key',
      recipient_key_fingerprint:`sha256:${createHash('sha256').update(recipient.export({type:'spki',format:'der'})).digest('hex')}`,
      reason:'trust',expected_revision:plan.expectedRevision,idempotency_key:'grant',challenge_id:challenge.id,challenge_response:response});
    expect((await grant('wrong')).status).toBe(401);
    const granted = await grant('verified');
    expect(granted.status).toBe(200);
    const result = await granted.json();
    expect(await (await api('/api/root/runtime-trust/rt_management', compact)).json()).toMatchObject({ active_trust: { id: result.trust.id, effective: true } });
    expect(await (await api('/api/root/runtime-trust?runtime_id=rt_management', compact)).json()).toMatchObject({ trusts: [{ id: result.trust.id, effective: true }] });
    expect(result.trust.issuer).toEqual({type:'user',id:'usr_auth'});
    const candidate=store.createAgent({name:'grant review',provider:'codex',runtimeId:'rt_management'});
    const review=()=>service.reviewAgentGrantRuntimeTrusts(proof,candidate.id,[result.trust.id]);
    expect(review()).toMatchObject({agentId:candidate.id,workspaceId:'local',checkedRevision:result.security_revision,
      runtimeTrusts:[{id:result.trust.id,version:result.trust.generation,runtimeId:'rt_management',daemonId:'daemon',incarnation:'inc'}]});
    expect(()=>service.reviewAgentGrantRuntimeTrusts(proof,candidate.id,[])).toThrow('Expected distinct runtime trust IDs');
    expect(()=>service.reviewAgentGrantRuntimeTrusts(proof,candidate.id,['unknown'])).toThrow('root_runtime_untrusted');
    const unrelated=store.createAgent({name:'different provider',provider:'claude'});
    expect(()=>service.reviewAgentGrantRuntimeTrusts(proof,unrelated.id,[result.trust.id])).toThrow('root_runtime_untrusted');
    expect(()=>service.reviewAgentGrantRuntimeTrusts({kind:'invalid'},candidate.id,[result.trust.id])).toThrow();
    const dependencyDigest=hash('frozen fixture policy');
    const kernel=new RootManagement(db,(_tx,agentId)=>({agentId,configEpoch:1,digest:dependencyDigest,
      trustVersions:[{id:result.trust.id,version:result.trust.generation}],refs:[{kind:'policy',id:'shared',version:2,digest:hash('policy'),use:'instruction'}]}));
    const registered=kernel.registeredCredentials.verifyJwt(compact,signing);
    const createUse={action:'root.grant.create',use:'management',actualTarget:{type:'agent',id:candidate.id}};
    const mutation={action:'policy.update',use:'write',actualTarget:{type:'policy',id:'shared'}};
    const grantPlan=kernel.planAgentGrant(registered,candidate.id,[result.trust.id]);
    const checkGrant=(acceptedDigest:string)=>withSecurityWrite(db,undefined,{...grantPlan,domainTargets:[...grantPlan.domainTargets,'management:policy:shared'].sort()},tx=>{
      const created=kernel.grant(tx,kernel.authorizeWrite(tx,registered,createUse),{subject:{type:'agent',id:candidate.id},reason:'approve policy',
        expected_revision:grantPlan.expectedRevision,idempotency_key:'agent-creation',runtime_trust_ids:[result.trust.id],accepted_dependency_digest:acceptedDigest});
      expect(created.grant.subject).toEqual({type:'agent',id:candidate.id});
      expect(db.query('SELECT resource_version FROM multiremi_agent_grant_protected_refs WHERE grant_id=?').get(created.grant.id).resource_version).toBe(2);
      kernel.guardProtectedMutation(tx,kernel.authorizeWrite(tx,registered,mutation),mutation,2);
      expect(Number(db.query('SELECT config_epoch FROM multiremi_agent_grant_dependencies WHERE grant_id=?').get(created.grant.id).config_epoch)).toBe(2);
      expect(db.query('SELECT revoked_at_ms FROM multiremi_authority_nodes WHERE node_id=?').get(created.grant.authority_node_id).revoked_at_ms).toBeTruthy();
      throw new Error('fixture rollback');
    });
    expect(()=>checkGrant(hash('stale'))).toThrow('authority_revision_conflict');
    expect(()=>checkGrant(dependencyDigest)).toThrow('fixture rollback');
    expect(db.query('SELECT grant_id FROM multiremi_agent_grant_dependencies WHERE agent_id=?').get(candidate.id)).toBeNull();
    const revokeUse={action:'root.runtime-trust.revoke',use:'management',actualTarget:{type:'runtime_trust',id:result.trust.id}};
    const response = await api('/api/root/runtime-trust/' + result.trust.id + '/revoke', compact,
      { reason:'retire',expected_revision:result.security_revision,idempotency_key:'revoke',reason_code:'operator_security_revoke' });
    expect(response.status).toBe(200);
    const revoked = await response.json();
    expect(revoked.trust.status).toBe('revoked');
    expect(review).toThrow('root_runtime_untrusted');
    const origin=service.resolveCurrent(proof,revokeUse).credentialOrigin!;
    expect(db.query('SELECT proof_node_id FROM multiremi_root_management_events WHERE action IN (?,?)').all(grantUse.action,revokeUse.action))
      .toEqual([{proof_node_id:origin.node.nodeId},{proof_node_id:origin.node.nodeId}]);
  }, 60_000);

  it.each(['expired lease','preempted fence','revoked source','durable delegation','concurrent first offer','concurrent security termination'] as const)('recovers one admitted run and rejects copies after %s', async(failure)=>{
    const {store}=fixture();
    const db=(store as unknown as {db:SqlDatabase}).db;
    const dependency=hash('protected instructions');
    const trustVersions=[{id:'trust',version:1}];
    const {service,passwordProof,created,signing}=await bootstrap(db,(_tx,agentId)=>({agentId,configEpoch:1,digest:dependency,trustVersions,
      refs:[{kind:'instructions',id:'policy',version:1,digest:dependency,use:'instruction'}]}));
    const api = rootClient(store, signing);
    const runtime=store.registerRuntime({id:'rt_auth',name:'test',provider:'codex',workspaceId:'local',daemonId:'daemon'});
    const agent=store.createAgent({name:'admitted',provider:'codex',runtimeId:runtime.id});
    const issue=fixture().createIssue({title:'admission',assigneeType:'agent',assigneeId:agent.id});
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
    db.query(`INSERT INTO multiremi_agent_grant_dependencies VALUES('grant-agent',1,?,1,?,?,NULL)`).run(agent.id,dependency,JSON.stringify(trustVersions));
    db.query(`INSERT INTO multiremi_agent_grant_protected_refs VALUES('grant-agent','instructions','policy',1,?,'instruction')`).run(dependency);
    expect(()=>store.createTask({id:'tsk_unadmitted',agentId:agent.id,prompt:'ordinary entry'})).toThrow('root_invoker_untrusted');
    expect(store.getTask('tsk_unadmitted')).toBeNull();
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
    const retry=()=>{
      const {plan,write}=planVerifiedAttemptWrite(service,passwordProof,{...target,agentId:agent.id},execution,()=>({execution,inputs}));
      return store.withAttemptAdmission(plan.fenceTerm,plan,write,()=>store.retryTurnAsMember(turnId));
    };
    expect(retry).toThrow('authority_revision_conflict');
    db.query("UPDATE multiremi_turn_attempts SET status='lost' WHERE id=?").run(previous.id);
    db.query("UPDATE multiremi_turns SET status='failed' WHERE id=?").run(turnId);
    expect(retry().current_attempt_id).toBe(target.attemptId);
    const manifest=JSON.parse(db.query('SELECT manifest_json FROM multiremi_attempt_eligibility WHERE attempt_id=?').get(target.attemptId).manifest_json);

    const task=store.getTask(target.attemptId)!;
    await expect(store.createTaskAccessToken(task,'local')).rejects.toThrow('root_authority_revoked');
    const expiresAt=new Date(Date.now()+300000).toISOString();

    const business={turn_id:turnId};
    const tuple={...fixtureDeliveryTuple,business_payload_digest:rootBusinessPayloadDigest(business),attempt_id:task.id,consumer_id:'consumer',handoff_id:null,handoff_generation:0,runtime_id:'rt_auth',daemon_id:'daemon',incarnation:'inc',
      recipient_key_id:'key',recipient_key_fingerprint:`sha256:${createHash('sha256').update(createPublicKey(recipient).export({type:'spki',format:'der'})).digest('hex')}`,
      grant_id:'grant-agent',grant_generation:1,execution_config_epoch:1,execution_digest:execution.executionDigest,input_revision:1,input_digest:manifest.digest,checkpoint_digest:null,material_expires_at:expiresAt};
    const algorithm={name:'RSA-OAEP',hash:'SHA-256'};
    const enc=await crypto.subtle.importKey('jwk',recipientKeys.publicKey.export({format:'jwk'}),algorithm,false,['encrypt']);
    const dec=await crypto.subtle.importKey('jwk',recipientKeys.privateKey.export({format:'jwk'}),algorithm,false,['decrypt']);
    const candidate=await PreparedRootDelivery.prepare(tuple,business,enc);
    const use={action:'issue.read',use:'read',actualTarget:{type:'issue',id:issue.id}};
    db.query(`INSERT INTO multiremi_live_terms(scope,term,holder,updated_at) VALUES('background_jobs',1,'test','now')
      ON CONFLICT(scope) DO UPDATE SET term=1,holder='test'`).run();
    const lease={...execution,leaseId:'one',fenceTerm:'1',consumerId:'consumer',runGeneration:1,expiresAtMs:Date.now()+60000,state:'dispatched' as const};
    const offerLease={lease_id:'one',fence_term:'1',start_deadline:new Date(lease.expiresAtMs).toISOString()};
    const offerPlan=service.planFirstOffer(candidate);
    if (failure==='concurrent first offer') {
      db.query("UPDATE multiremi_turn_attempts SET status='accepted' WHERE id=?").run(task.id);
      const offer={action:'offer' as const,tuple,business,publicKey:recipientKeys.publicKey.export({format:'jwk'})};
      await raceIssuers(db,fixture().databaseUrl,[offer,offer],(results,database)=>{
        expect(results[1]).toBe(results[0]);
        const receipt=database.query('SELECT envelope_digest,lease_id,material_version,start_deadline FROM multiremi_delivery_receipts WHERE attempt_id=?').get(task.id);
        expect(JSON.parse(results[0]!)).toEqual([receipt.envelope_digest,receipt.lease_id,Number(receipt.material_version),receipt.start_deadline]);
        for (const table of ['multiremi_current_task_leases','multiremi_delivery_receipts','multiremi_credential_materials','multiremi_credential_version_bindings']) {
          expect(Number(database.query(`SELECT COUNT(*) AS total FROM ${table}`).get().total)).toBe(1);
        }
        expect(Number(database.query('SELECT COUNT(*) AS total FROM multiremi_access_tokens WHERE task_id=?').get(task.id).total)).toBe(1);
        expect(Number(database.query('SELECT COUNT(*) AS total FROM multiremi_usage_runs WHERE task_id=?').get(task.id).total)).toBe(1);
      });
      return;
    }
    expect(()=>withSecurityWrite(db,'1',offerPlan,tx=>service.issue(tx,candidate))).toThrow('credential_version_conflict');
    const receipts=new RootReceiptStore(db,service);
    expect(()=>receipts.commitFirstOffer(candidate,offerLease)).toThrow('stale_execution');
    expect(store.claimTask(execution.runtimeId,{supportsPromptPolicy:true})?.id).toBe(task.id);
    const initialIssue=fixture().createIssue({title:'direct creation',assigneeType:'agent',assigneeId:agent.id});
    const initialSession=store.getOrCreateDefaultIssueSession(initialIssue.id);
    const initialExecution={...execution,attemptId:'tsk_initial'};
    const initialTarget={turnId:initialExecution.attemptId,attemptId:initialExecution.attemptId,previousAttemptId:null,agentId:agent.id,workspaceId:agent.workspaceId,sessionId:initialSession.id};
    const initial=planVerifiedAttemptWrite(service,passwordProof,initialTarget,initialExecution,()=>({execution:initialExecution,inputs:{...inputs,manifest:{id:'initial_manifest',version:1}}}));
    const createdTask=store.withAttemptAdmission(initial.plan.fenceTerm,initial.plan,initial.write,()=>store.createTask({id:initialExecution.attemptId,agentId:agent.id,issueId:initialIssue.id,issueSessionId:initialSession.id,runtimeId:runtime.id,prompt:'direct'}));
    expect(db.query('SELECT eligibility FROM multiremi_attempt_eligibility WHERE attempt_id=?').get(createdTask.id)?.eligibility).toBe('root');
    const wrongRecipient=await PreparedRootDelivery.prepare({...tuple,recipient_key_id:'retired'},business,enc);
    expect(()=>receipts.commitFirstOffer(wrongRecipient,offerLease)).toThrow();
    expect(db.query('SELECT run_id FROM multiremi_usage_runs WHERE task_id=?').get(task.id)).toBeNull();
    expect(db.query('SELECT id FROM multiremi_access_tokens WHERE token_hash=?').get(candidate.tokenHash)).toBeNull();
    expect(db.query('SELECT family_id FROM multiremi_credential_families WHERE family_id=?').get(candidate.familyId)).toBeNull();
    const firstOffer=receipts.commitFirstOffer(candidate,offerLease);
    const resend=await PreparedRootDelivery.prepare({...tuple,receipt_id:'other-receipt'},business,enc);
    expect(receipts.commitFirstOffer(resend,{...offerLease,lease_id:'other-lease'})).toEqual(firstOffer);
    expect(()=>receipts.commitFirstOffer(wrongRecipient,offerLease)).toThrow('receipt_conflict');
    expect(db.query('SELECT id FROM multiremi_access_tokens WHERE id=?').get(resend.credentialId)).toBeNull();
    expect(Number(db.query('SELECT lease_version FROM multiremi_current_task_leases WHERE attempt_id=?').get(task.id).lease_version)).toBe(1);
    const repo=store.rootReceipts;
    const local={runtime_id:tuple.runtime_id,daemon_id:tuple.daemon_id,consumer_id:tuple.consumer_id,incarnation:tuple.incarnation,
      recipient_key_id:tuple.recipient_key_id,recipient_key_fingerprint:tuple.recipient_key_fingerprint};
    const originalSocket={};
    let connection=repo.bindConnection(originalSocket,'machine-token')!;
    const found=repo.findReceipt({attempt_id:task.id},local.runtime_id,local.consumer_id);
    expect(found).toBe(tuple.receipt_id);
    expect(repo.findReceipt({attempt_id:task.id},local.runtime_id,'unrelated')).toBeNull();
    const recoveryPlan=repo.planRecovery(found!);
    function signedChallenge(action:Parameters<typeof repo.challenge>[3]) {
      const challenge=store.withSecurityWrite('1',recoveryPlan,tx=>repo.challenge(tx,connection,tuple.runtime_id,action,tuple.receipt_id));
      return signChallenge(challenge);
    }
    const machineKeys = new RootMachineKeys({runtimeId:local.runtime_id, daemonId:local.daemon_id, consumerId:local.consumer_id,
      incarnation:local.incarnation, recipientKeyId:local.recipient_key_id, deploymentId:'test', credentialId:'daemon-token',
      credentialDigest:createHash('sha256').update('machine-token').digest('hex'), keyExpiresAtMs:Date.parse(expiresAt)}, recipientKeys.privateKey, signingKeys.privateKey);
    expect(machineKeys.publicBinding().recipientSpki).toBe(recipient);
    function signChallenge(challenge: ReturnType<typeof repo.challenge>) {
      expect(()=>machineKeys.answerChallenge({...challenge,targetId:'wrong-target'})).toThrow();
      return {id:challenge.id,proof:machineKeys.answerChallenge(challenge)};
    }
    function authenticate(action:Parameters<typeof repo.challenge>[3]) {
      const signed=signedChallenge(action);
      return store.withSecurityWrite('1',recoveryPlan,tx=>repo.authenticate(tx,connection,signed.id,action,tuple.receipt_id,signed.proof));
    }
    let statusProof=authenticate('status'), replayProof=authenticate('replay'), ackProof=authenticate('install_ack');
    const status=()=>store.withSecurityWrite('1',recoveryPlan,tx=>repo.status(tx,statusProof,tuple.receipt_id));
    const replay=()=>store.withSecurityWrite('1',recoveryPlan,tx=>repo.replay(tx,replayProof,{receipt_id:tuple.receipt_id,expected_receipt_version:1,
      expected_delivery_version:1,run_lease_id:'one',fence_term:'1'}));
    const delivery=replay();
    expect(replay()).toEqual(delivery);
    const installed=await prepareRunInstallation(delivery,status(),local,dec,'launch',{});
    installed.verify(acknowledgeRunEnvironment(installed.challenge,installed.env));
    const token={id:candidate.credentialId,token:installed.env.MULTIREMI_TOKEN};
    const taskProof=service.registeredCredentials.verify(token.token);
    expect((await store.verifyAccessToken(token.token))?.id).toBe(token.id);
    expect(service.resolveCurrent(taskProof,use)).toMatchObject({effectiveRoot:true,transport:'task',subject:{type:'agent',id:agent.id}});
    const mutation={...use,action:'issue.update',use:'write'};
    const updateTitle=(raw:string,title:string)=>{
      const proof=store.rootManagement.registeredCredentials.verify(raw);
      const planned=store.rootManagement.plan(proof,mutation);
      return store.withAuthorizedMutation(proof,mutation,{...planned,workspaceIds:[issue.workspaceId]},(tx,actor)=>{
        store.rootManagement.requireMutationActor(tx,actor,mutation);
        return store.updateIssue(issue.id,{title}).title;
      });
    };
    expect(updateTitle(token.token,'before recovery')).toBe('before recovery');
    const locator={runtime_id:tuple.runtime_id,daemon_id:tuple.daemon_id,incarnation:tuple.incarnation,execution_id:'process',birth_token_id:'birth',
      launch_identity:'launch',carrier_mode:'immutable_run_env' as const,started_at:null};
    const acknowledge=()=>store.withSecurityWrite('1',recoveryPlan,tx=>repo.acknowledge(tx,ackProof,{tuple,envelope_digest:delivery.envelope_digest,
      execution_locator:locator,installed_at:new Date().toISOString()}));
    repo.releaseConnection(originalSocket);
    expect(status).toThrow('root_authority_revoked');
    expect(acknowledge).toThrow('root_authority_revoked');
    expect(repo.bindConnection({},token.token)).toBeNull();
    const server=startMultiremiServer({store,port:0,hostname:'127.0.0.1',authToken:'test-master',backgroundJobs:false});
    const client=new DaemonProtocolClient({serverUrl:`http://127.0.0.1:${server.port}`,token:'machine-token',daemonId:local.daemon_id,
      cliVersion:DAEMON_MIN_CLI_VERSION,caps:['root.delivery']});
    let confirmConnection: (()=>void) | undefined;
    const lane:DaemonProtocolLane={runtime:()=>({runtime_id:local.runtime_id,provider:'codex',max_concurrency:1,active_task_ids:[task.id],
      capabilities:{root_delivery_protocol:1,root_carrier_modes:['immutable_run_env']}}),heartbeat:()=>({active_task_count:1}),
      async onHeartbeatAck(){},onRuntimeConfirmed(){confirmConnection?.();},async probeUpgrade(){},async onTerminal(){}};
    const connect=()=>new Promise<void>(resolve=>{confirmConnection=resolve;client.startLane(lane);});
    client.addLane(lane);
    try {
      await connect();
      const rpc=(action:string,payload:Record<string,unknown>)=>client.rpc(`delivery.receipt.${action}`,payload,local.runtime_id);
      const wireProof=async(action:string)=>{
        const issued=await rpc('challenge', {action,attempt_id:task.id,consumer_id:local.consumer_id});
        expect(issued.ok).toBe(true);
        return signChallenge(issued.challenge as ReturnType<typeof repo.challenge>).proof;
      };
      const staleProof=await wireProof('status');
      client.stopLane(lane);
      await connect();
      await expect(rpc('status',{execution_key:{attempt_id:task.id},machine_proof:staleProof})).rejects.toMatchObject({code:'authority_revoked'});
      const query={execution_key:{attempt_id:task.id},machine_proof:await wireProof('status')};
      expect(await rpc('status',query)).toMatchObject({ok:true,ack_state:'pending',allowed_recovery_action:'replay_envelope'});
      await expect(rpc('status',query)).rejects.toMatchObject({code:'authority_revoked'});
      const recovery = new RootReceiptClient(client, {async answerChallenge(challenge) { return machineKeys.answerChallenge(challenge); }});
      const pending = await recovery.status(tuple,delivery.envelope_digest);
      expect(await recovery.replay(tuple,pending)).toMatchObject({ok:true,replay:true,envelope:delivery.envelope});
      let seq = 0;
      const startEvent = (payload: Record<string, unknown>, runtimeId = local.runtime_id, sequence = ++seq) => client.event({
        t: 'task.start', seq: sequence, rt: runtimeId, p: {task_id: task.id, usage_run_id: tuple.consumer_id, ...payload},
      });
      const rootStart = {root_receipt_id: tuple.receipt_id, execution_locator: locator};
      await expect(startEvent({...rootStart, machine_proof: await wireProof('start')})).rejects.toMatchObject({code:'stale_execution'});
      const installAck = () => recovery.acknowledge(tuple,delivery.envelope_digest,locator);
      expect(await installAck()).toMatchObject({ok:true,idempotent_replay:false});
      expect(await installAck()).toMatchObject({ok:true,idempotent_replay:true});
      await expect(startEvent({})).rejects.toMatchObject({code:'authority_revoked'});
      await expect(startEvent({...rootStart, machine_proof: await wireProof('status')})).rejects.toMatchObject({code:'authority_revoked'});
      const signedStart = {...rootStart, machine_proof: await wireProof('start')};
      await expect(startEvent({...signedStart, root_receipt_id:'different-receipt'})).rejects.toMatchObject({code:'authority_revoked'});
      await expect(startEvent({...signedStart, usage_run_id:'different-consumer'})).rejects.toMatchObject({code:'authority_revoked'});
      await expect(startEvent({...signedStart, task_id:previous.id})).rejects.toThrow();
      await expect(startEvent(signedStart, 'other-runtime')).rejects.toThrow();
      await expect(startEvent({...signedStart, execution_locator:{...locator,birth_token_id:'different'}})).rejects.toMatchObject({code:'stale_execution'});
      const currentLease = () => db.query('SELECT lease_version,expires_at_ms FROM multiremi_current_task_leases WHERE attempt_id=?').get(task.id);
      const beforeStart = Date.now();
      expect(await startEvent({...signedStart, lease_expires_at_ms:1})).toMatchObject({ok:true,execution_authorized:true});
      const running = currentLease();
      expect(Number(running.expires_at_ms)).toBeGreaterThan(beforeStart);
      expect(Number(running.expires_at_ms)).toBeLessThanOrEqual(Date.now()+60_000);
      await expect(startEvent(signedStart, local.runtime_id, seq)).rejects.toMatchObject({code:'authority_revoked'});
      expect(await startEvent({...rootStart, machine_proof:await wireProof('start')}, local.runtime_id, seq)).toMatchObject({ok:true,code:'start_replayed'});
      expect(currentLease()).toEqual(running);
      const pendingReplay = {...rootStart, machine_proof:await wireProof('start')};
      db.query('UPDATE multiremi_current_task_leases SET expires_at_ms=1 WHERE attempt_id=?').run(task.id);
      await expect(startEvent(pendingReplay)).rejects.toMatchObject({code:'authority_revoked'});
      db.query('UPDATE multiremi_current_task_leases SET expires_at_ms=? WHERE attempt_id=?').run(running.expires_at_ms,task.id);
    } finally {client.stopLane(lane); await server.stop(true);}
    connection=repo.bindConnection({},'machine-token')!;
    statusProof=authenticate('status');
    replayProof=authenticate('replay');
    ackProof=authenticate('install_ack');
    expect(status().allowed_recovery_action).toBe('reattach_running');
    expect(acknowledge().idempotent_replay).toBe(true);
    const startProof=authenticate('start');
    expect(()=>store.startTaskFromDaemon(task.id,{runtimeId:tuple.runtime_id,daemonId:tuple.daemon_id,workspaceId:'local'},tuple.consumer_id)).toThrow('root_authority_revoked');
    const start=(birthToken:string)=>store.withSecurityWrite('1',recoveryPlan,tx=>store.startRootTaskFromDaemon(tx,startProof,tuple.receipt_id,
      {...locator,birth_token_id:birthToken},lease.expiresAtMs));
    expect(()=>start('different')).toThrow('stale_execution');
    expect(start('birth')).toBe('replayed');
    if (failure==='concurrent security termination') {
      const use={action:'credential.pat.create' as const,actualTarget:{type:'agent',id:agent.id},use:'write',requestDigest:hash('race'),expiresAtMs:Date.now()+120000,idempotencyKey:'race'};
      const input={agentId:agent.id,attemptId:task.id,raw:token.token,use};
      await raceIssuers(db,fixture().databaseUrl,[{...input,action:'pat'},{...input,action:'revoke'}],(results,database)=>{
        expect([...results].sort()).toEqual(['authority_revision_conflict','committed']);
        const committedPat=results[0]==='committed';
        expect(Number(database.query('SELECT COUNT(*) AS total FROM multiremi_delegated_pats').get().total)).toBe(Number(committedPat));
        if (committedPat) {
          const root=new RootManagement(database);
          const revision=Number(database.query('SELECT security_revision FROM multiremi_security_state').get().security_revision);
          withSecurityWrite(database,undefined,{expectedRevision:revision,workspaceIds:['local'],numberKeys:[],domainTargets:[`attempt:${task.id}`]},
            tx=>root.revokeAttemptDelegations(tx,task.id,'security_compromised'));
        }
        expect(database.query('SELECT attempt_id FROM multiremi_attempt_security_revocations').all()).toEqual([{attempt_id:task.id}]);
        expect(database.query(`SELECT d.node_id FROM multiremi_durable_delegations d JOIN multiremi_authority_nodes n ON n.node_id=d.node_id WHERE n.revoked_at_ms IS NULL`).all()).toEqual([]);
      });
      return;
    }
    if (failure==='durable delegation') {
      const beneficiary={type:'agent' as const,id:agent.id};
      const use={action:'credential.pat.create' as const,use:'write',actualTarget:beneficiary,idempotencyKey:'issue-pat',requestDigest:hash('personal'),expiresAtMs:Date.now()+60000};
      const issuePat=(candidate:PreparedAgentPat,rollback:boolean)=>{
        const plan=service.plan(taskProof,use);
        return withSecurityWrite(db,plan.fenceTerm,{...plan,domainTargets:[...plan.domainTargets,`credential:${candidate.credentialId}`].sort()},tx=>{
          const actor=service.authorizeWrite(tx,taskProof,use);
          const issued=service.issue(tx,{kind:'delegated-pat',actor,use,beneficiary,candidate});
          expect(candidate.takeCommittedToken()).toBeNull();
          if (rollback) throw new Error('rollback PAT');
          return issued;
        });
      };
      const candidate=PreparedAgentPat.prepare();
      expect(()=>issuePat(candidate,true)).toThrow('rollback PAT');
      expect(candidate.takeCommittedToken()).toBeNull();
      const issued=issuePat(candidate,false);
      const raw=candidate.takeCommittedToken()!;
      expect(candidate.takeCommittedToken()).toBeNull();
      expect(()=>issuePat(PreparedAgentPat.prepare(),false)).toThrow('credential_version_conflict');
      expect(issued.subject).toEqual(beneficiary);
      const patProof=service.registeredCredentials.verify(raw);
      expect(service.resolveCurrent(patProof,use)).toMatchObject({subject:beneficiary,transport:'agent_pat',effectiveRoot:true});
      expect(await store.verifyAccessToken(raw)).toBeNull();
      const peer=store.createAgent({name:'delegation target',provider:'codex',runtimeId:execution.runtimeId});
      const childDigest=hash('shared fixture for child grant');
      const childKernel=new RootManagement(db,(_tx,agentId)=>({agentId,configEpoch:1,digest:childDigest,trustVersions:[{id:'trust',version:1}],
        refs:[{kind:'policy',id:'policy',version:1,digest:childDigest,use:'instruction'}]}));
      const target={type:'agent' as const,id:peer.id};
      const childUse={action:'root.grant.create',use:'management',actualTarget:target};
      const childProof=childKernel.registeredCredentials.verify(token.token);
      const childPlan=childKernel.planAgentGrant(childProof,peer.id,['trust']);
      const child=withSecurityWrite(db,childPlan.fenceTerm,childPlan,tx=>childKernel.grant(tx,childKernel.authorizeWrite(tx,childProof,childUse),{
        subject:target,runtime_trust_ids:['trust'],accepted_dependency_digest:childDigest,expires_at:new Date(use.expiresAtMs).toISOString(),
        idempotency_key:'child',expected_revision:childPlan.expectedRevision,reason:'shared config'})).grant;
      const sourceFamily=db.query('SELECT family_id FROM multiremi_credential_materials WHERE credential_id=?').get(token.id).family_id;
      expect(child).toMatchObject({issuer:beneficiary,origin_attempt_id:task.id,origin_family_id:sourceFamily});
      db.query('UPDATE multiremi_usage_runs SET complete=1 WHERE task_id=? AND run_id=?').run(task.id,tuple.consumer_id);
      expect(service.registeredCredentials.verify(token.token).kind).toBe('invalid');
      expect(service.resolveCurrent(patProof,use).effectiveRoot).toBe(true);
      const childStatus=()=>service.listRootGrants(patProof,{limit:100,cursor:'',subjectType:'agent',subjectId:peer.id,status:''}).grants.find(grant=>grant.id===child.id);
      expect(childStatus()?.effective).toBe(true);
      const childOrigin=db.query(`SELECT node_id FROM multiremi_durable_delegations WHERE beneficiary_id=? AND action='root.grant.create'`).get(peer.id).node_id;
      const revokeUse={action:'root.delegation.revoke',use:'management',actualTarget:{type:'durable_delegation',id:childOrigin}};
      const revokePlan=service.plan(patProof,revokeUse);
      withSecurityWrite(db,undefined,revokePlan,tx=>service.revokeDurableDelegation(tx,service.authorizeWrite(tx,patProof,revokeUse),childOrigin,
        {expected_revision:revokePlan.expectedRevision,idempotency_key:'retire-child',reason:'retire',reason_code:'operator_security_revoke'}));
      expect(childStatus()?.effective).toBe(false);
      expect(service.resolveCurrent(patProof,use).effectiveRoot).toBe(true);
      const revision=service.plan(patProof,use).expectedRevision;
      withSecurityWrite(db,undefined,{expectedRevision:revision,workspaceIds:['local'],numberKeys:[],domainTargets:[`attempt:${task.id}`]},
        tx=>service.revokeAttemptDelegations(tx,task.id,'security_compromised'));
      expect(service.registeredCredentials.verify(raw).kind).toBe('invalid');
      expect(()=>service.resolveCurrent(patProof,use)).toThrow('root_authority_revoked');
      return;
    }
    expect(Number(db.query('SELECT COUNT(*) AS total FROM multiremi_usage_runs WHERE task_id=?').get(task.id).total)).toBe(1);
    const plan=receipts.planRecovery(tuple.receipt_id);
    expect(()=>withSecurityWrite(db,'1',plan,tx=>writeCurrentTaskLease(db,tx,1,lease))).toThrow('authority_revision_conflict');
    expect(withSecurityWrite(db,'1',plan,tx=>readCurrentTaskLease(db,tx,target.attemptId)?.state)).toBe('running');
    expect(()=>withSecurityWrite(db,undefined,plan,tx=>readCurrentTaskLease(db,tx,target.attemptId))).toThrow('security_tx_invalid');
    db.query("UPDATE multiremi_delivery_receipts SET start_deadline='2000-01-01T00:00:00Z' WHERE receipt_id=?").run(tuple.receipt_id);
    expect(status().allowed_recovery_action).toBe('reattach_running');
    expect(replay().envelope).toBe(delivery.envelope);
    expect(service.resolveCurrent(taskProof,use).effectiveRoot).toBe(true);
    const other = store.createWorkspace({ id: 'ws_root_read', name: 'Isolated workspace', slug: 'root-read' });
    const privateAgent = store.createAgent({ name: 'Private Agent', provider: 'codex', workspaceId: other.id, visibility: 'private' });
    expect((await api('/api/workspaces/' + other.id, token.token)).status).toBe(200);
    expect((await api('/api/agents/' + privateAgent.id, token.token)).status).toBe(200);
    expect((await api('/api/workspaces/' + other.id, token.token, { name: 'Renamed workspace' }, 'PATCH')).status).toBe(200);
    expect(store.getWorkspace(other.id)?.name).toBe('Renamed workspace');
    const platform = await api('/api/multiremi/platform/operations', token.token, { kind: 'check_updates', requestId: 'root-task-platform' });
    expect(platform.status).toBe(202);
    const operation = (await platform.json()).operation;
    expect(operation.requestedBy).toBe(agent.id);
    expect((await api('/api/multiremi/platform/operations/' + operation.id + '/cancel', token.token, {})).status).toBe(200);
    const removable = store.createWorkspace({ id: 'ws_root_delete', name: 'Removable workspace', slug: 'root-delete' });
    expect((await api('/api/workspaces/' + removable.id, token.token, undefined, 'DELETE')).status).toBe(204);
    expect(store.getWorkspace(removable.id)).toBeNull();
    const revokeUse={action:'root.grant.revoke',use:'management',actualTarget:{type:'grant',id:'grant-agent'}};
    const revoke=()=>{
      const revokePlan=service.plan(taskProof,revokeUse);
      return withSecurityWrite(db,revokePlan.fenceTerm,revokePlan,tx=>service.revokeGrant(tx,service.authorizeWrite(tx,taskProof,revokeUse),'grant-agent',
        {expected_revision:revokePlan.expectedRevision,idempotency_key:'task-revoke',reason:'retire'}));
    };
    const reconnected=new RootManagement(db);
    const recoveredProof=reconnected.registeredCredentials.verify(installed.env.MULTIREMI_TOKEN);
    expect(reconnected.resolveCurrent(recoveredProof,use).effectiveRoot).toBe(true);
    expect(updateTitle(installed.env.MULTIREMI_TOKEN,'after recovery')).toBe('after recovery');
    if (failure==='expired lease') db.run("UPDATE multiremi_current_task_leases SET expires_at_ms=1 WHERE attempt_id='tsk_admitted'");
    if (failure==='preempted fence') db.run("UPDATE multiremi_live_terms SET term=2 WHERE scope='background_jobs'");
    if (failure==='revoked source') db.run("UPDATE multiremi_authority_nodes SET revoked_at_ms=1 WHERE node_id='provider'");
    expect(()=>service.resolveCurrent(taskProof,use)).toThrow('root_authority_revoked');
    expect(()=>reconnected.resolveCurrent(recoveredProof,use)).toThrow('root_authority_revoked');
    expect(await store.verifyAccessToken(token.token)).toBeNull();
    expect(()=>updateTitle(installed.env.MULTIREMI_TOKEN,'stale write')).toThrow();
    expect(store.getIssue(issue.id)?.title).toBe('after recovery');
    for (const recover of [status,replay,acknowledge]) expect(recover).toThrow();
    expect(()=>receipts.commitFirstOffer(resend,offerLease)).toThrow();
    expect(()=>start('birth')).toThrow();
    expect(service.resolveCurrent(passwordProof,use).effectiveRoot).toBe(true);
    expect(revoke).toThrow();
    const revokeHttp=()=>api('/api/root/grants/grant-agent/revoke',token.token,{
      expected_revision:service.plan(taskProof,revokeUse).expectedRevision,idempotency_key:'task-revoke',reason:'retire'});
    expect((await revokeHttp()).status).toBe(401);
    expect((await api('/api/workspaces/' + other.id, token.token, { name: 'Expired credential write' }, 'PATCH')).status).toBe(401);
    expect((await api('/api/workspaces/' + other.id, token.token, undefined, 'DELETE')).status).toBe(401);
    expect(store.getWorkspace(other.id)?.name).toBe('Renamed workspace');
    if (failure==='expired lease') {
      expect(db.query("SELECT revoked_at_ms FROM multiremi_root_grants WHERE grant_id='grant-agent'").get().revoked_at_ms).toBeNull();
      db.query('UPDATE multiremi_current_task_leases SET expires_at_ms=? WHERE attempt_id=?').run(lease.expiresAtMs,task.id);
      const response=await revokeHttp();
      expect(response.status).toBe(200);
      const revoked=await response.json();
      expect(db.query('SELECT proof_node_id,actor_grant_id FROM multiremi_root_management_events WHERE revision_after=? AND action=?').get(revoked.security_revision,revokeUse.action))
        .toMatchObject({proof_node_id:candidate.materialNodeId,actor_grant_id:'grant-agent'});
    }
  }, 60_000);

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
