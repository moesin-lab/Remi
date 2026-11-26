import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyDaemonTaskOfferPayload } from '@multiremi/contracts/root-delivery.js';
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import { startMultiremiServer } from '@multiremi/api.js';
import { DaemonProtocolClient, type DaemonProtocolLane } from '@multiremi/worker/daemon-protocol-client.js';
import { DAEMON_MIN_CLI_VERSION } from '@multiremi/contracts/daemon-protocol.js';
import { RootReceiptClient } from '@multiremi/worker/root-receipt-client.js';
import { RootMachineKeys } from '@daemon/agent-runtime/root-machine-keys.js';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { runtimeConnectionSnapshot } from '@multiremi/contracts/runtime-connection.js';
import { readWorkspacePromptSettings } from '@multiremi/prompts/workspace-settings.js';
import { agentDependencyDigest } from '@multiremi/store/agent-dependencies.js';
import { executionTrustNodeId, type AgentConfigurationApproval } from '@multiremi/store/agent-source-approvals.js';
import { beginMachineChallenge } from '@multiremi/store/machine-proof.js';
import type { SqlDatabase } from '@multiremi/store/db/postgres.js';
import { withSecurityWrite } from '@multiremi/store/security-write.js';
import { bootstrap } from './fixtures/root-kernel-bootstrap.js';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';

pendingTurnBackendTests('production root attempt inputs', fixture => {
  it.each(['admission','first WS offer','retry WS offer','forged source','concurrent dispatch'])('admits frozen inputs for %s', async scenario => {
    const { store, createIssue } = fixture();
    const { db } = store as unknown as { db: SqlDatabase };
    const runtime = store.registerRuntime({ name: 'worker', provider: 'codex', workspaceId: 'local', daemonId: 'worker' });
    const agent = store.createAgent({ name: 'reviewer', provider: 'codex', runtimeId: runtime.id });
    const issue = createIssue({ title: 'inputs', assigneeType: 'agent', assigneeId: agent.id });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const { input: login } = await bootstrap(db, store.resolveAgentDependencies);
    const service = store.rootManagement;
    const proof = await service.verifyIndependentPassword(login.userId, 'test-dashboard-password');
    const expiry = Date.now() + 3_600_000;
    const hash = createHash('sha256').update('test-daemon').digest('hex');
    db.query("INSERT INTO multiremi_authority_nodes VALUES('machine',100,1,'machine_registration','daemon','worker','system',1,?,NULL,0)").run(expiry);
    db.query("INSERT INTO multiremi_authority_nodes VALUES('trust-node',101,1,'runtime_trust','runtime',?,'system',1,?,NULL,1)").run(runtime.id, expiry);
    db.run("INSERT INTO multiremi_authority_edges VALUES('trust-node',1,101,'machine',1,100,'continuous')");
    db.query("INSERT INTO multiremi_access_tokens(id,name,type,workspace_id,daemon_id,token_hash,token_prefix,created_at) VALUES('token','test','daemon','local','worker',?,'test','now')").run(hash);
    const signerKeys=generateKeyPairSync('ed25519');
    const recipientKeys=generateKeyPairSync('rsa',{modulusLength:3072});
    const signing=signerKeys.publicKey.export({format:'pem',type:'spki'});
    const recipient=recipientKeys.publicKey.export({format:'pem',type:'spki'});
    db.query(`INSERT INTO multiremi_machine_enrollments(incarnation,deployment_id,consumer_id,runtime_id,daemon_id,credential_id,credential_digest,
      authority_node_id,generation,signing_spki,recipient_spki,recipient_key_id,key_expires_at_ms,isolation_verified_at_ms,immutable_carrier_verified_at_ms,attestation_expires_at_ms,attestation_id)
      VALUES('inc','deploy','consumer',?,'worker','token',?,'machine',1,?,?,'key',?,1,1,?,'evidence')`).run(runtime.id, hash, signing, recipient, expiry, expiry);
    const machinePlan = service.plan(proof, { action: 'root.runtime-trust.grant', use: 'management', actualTarget: { type: 'runtime', id: runtime.id } });
    const challenge = withSecurityWrite(db, undefined, { ...machinePlan, domainTargets: [...machinePlan.domainTargets, `machine:${runtime.id}`].sort() },
      tx => beginMachineChallenge(db, tx, 'test-daemon', runtime.id, 'root.runtime-trust.grant', runtime.id));
    db.query('UPDATE multiremi_machine_challenges SET consumed_at_ms=1,proof_digest=? WHERE challenge_id=?').run('fixture', challenge.id);
    db.query("INSERT INTO multiremi_runtime_trusts VALUES('trust',?,1,'inc',?,'trust-node','{}',NULL)").run(runtime.id, challenge.id);

    const sources: AgentConfigurationApproval['sources'][number][] = [];
    function approve(kind: string, id: string, use: string, value: unknown) {
      const ref = { kind, id, use, version: 1, digest: agentDependencyDigest(value) };
      sources.push({ ref, content: JSON.stringify(value), dependencies: [] });
      return ref;
    }
    const { root: _projection, skills, ...configuration } = store.getAgent(agent.id, {includeFiles: true})!;
    const workspace = store.getWorkspace('local')!;
    approve('agent', agent.id, 'configuration', configuration);
    approve('agent', agent.id, 'instructions', agent.instructions);
    approve('agent', agent.id, 'skills', skills);
    approve('agent', agent.id, 'plugins', store.resolveAgentPluginSnapshot(agent.id));
    approve('workspace', workspace.id, 'configuration', {context: workspace.context, settings: workspace.settings, repos: workspace.repos});
    approve('workspace', workspace.id, 'prompt', readWorkspacePromptSettings(workspace));
    const host = store.getRuntime(runtime.id)!;
    approve('runtime', host.id, 'execute', {daemonId: host.daemonId, incarnation: 'inc', provider: host.provider, runtimeMode: host.runtimeMode, metadata: host.metadata, models: host.models});
    const profile = approve('runtime', host.id, 'effective-profile', runtimeConnectionSnapshot(store.getAgentExecutionProfile(host.id, agent), agent.model));
    const execution = { trustId: 'trust', profileDigest: profile.digest, provider: approve('provider-trust','provider','execute','test provider'),
      checkpointPolicy: approve('checkpoint-policy','checkpoint','restore','test checkpoint policy'), inputPolicy: approve('input-policy','inputs','accept','test input policy') };
    const scope = {type:'agent', id:agent.id};
    const action = { action:'root.agent-configuration.approve', use:'write', actualTarget:scope };
    const configPlan = service.planAgentGrant(proof, agent.id, ['trust']);
    const approved = withSecurityWrite(db, undefined, configPlan, tx => service.approveAgentConfiguration(tx,service.authorizeWrite(tx,proof,action),agent.id,null,{sources,executions:[execution]}));
    const plan = service.planAgentGrant(proof, agent.id, ['trust']);
    const taskInput = { agentId: agent.id, issueId: issue.id, prompt: 'original instruction' };
    const submit = () => store.createAdmittedTask(taskInput, proof, {messages: [], includeSubmittedPrompt: true});
    expect(submit).toThrow();
    expect(db.query("SELECT 1 FROM multiremi_authority_nodes WHERE kind='provider_trust' AND subject_id=?").get(agent.id)).toBeNull();
    const grant = withSecurityWrite(db, undefined, plan, tx => service.grant(tx,service.authorizeWrite(tx,proof,{action:'root.grant.create',use:'management',actualTarget:scope}),
      {subject:{type:'agent',id:agent.id},runtime_trust_ids:['trust'],accepted_dependency_digest:approved.digest,expected_revision:plan.expectedRevision,idempotency_key:'grant',reason:'reviewed'}));
    const providerId = executionTrustNodeId(grant.grant.id,'trust',execution.provider);
    const task = submit();
    expect(task.issueSessionId).toBe(session.id);
    const message = db.query(`SELECT m.* FROM multiremi_turns t JOIN multiremi_conversation_log m ON m.id=t.trigger_message_id WHERE t.id=?`).get(task.id);
    const approvedInputs = (id: string) => JSON.parse(db.query('SELECT manifest_snapshot FROM multiremi_attempt_input_approvals WHERE attempt_id=?').get(id).manifest_snapshot);
    const source = {id:message.id, version:Number(message.revision)};
    const author = db.query('SELECT user_id FROM multiremi_workspace_members WHERE id=?').get(message.sender_id);
    const manifest = approvedInputs(task.id);
    expect(manifest.inputs.entries).toEqual([{source,snapshot:taskInput.prompt,purpose:'instruction',author:{type:'user',id:author.user_id}}]);
    expect(manifest.inputs.sourcePolicy).toEqual({id:'inputs',version:1});
    expect(manifest.execution.providerTrust).toEqual({id:providerId,version:grant.grant.generation});
    const turnId=task.id;
    let attemptId=task.id;
    if (scenario==='retry WS offer') {
      db.query("UPDATE multiremi_turn_attempts SET status='lost' WHERE id=?").run(task.id);
      db.query("UPDATE multiremi_turns SET status='failed' WHERE id=?").run(turnId);
      attemptId=store.retryAdmittedTurn(turnId,task.id,proof,{messages:[source]}).current_attempt_id!;
    }
    if (scenario==='forged source') {
      db.run("INSERT INTO multiremi_live_terms(scope,term,holder,updated_at) VALUES('background_jobs',1,'test','now') ON CONFLICT(scope) DO UPDATE SET term=1");
      expect(store.claimTask(runtime.id,{supportsPromptPolicy:true,policyProtocol:'adopt',offerGeneration:'source-check',rootMachineCredentialId:'token'})?.id).toBe(attemptId);
      const offer=()=>store.rootReceipts.firstTaskOffer(attemptId,runtime.id,'worker','token','1',()=>{});
      const rejectsWithoutIssuing=async()=>{
        await expect(offer()).rejects.toThrow('root_input_unapproved');
        for (const [table,key] of [['delivery_receipts','attempt_id'],['current_task_leases','attempt_id'],['usage_runs','task_id'],['access_tokens','task_id']]) {
          expect(db.query(`SELECT 1 FROM multiremi_${table} WHERE ${key}=?`).get(attemptId)).toBeNull();
        }
      };
      for (const [column,value] of [['sender_id','unknown'],['revision',source.version+1],['body_md','edited instruction']] as const) {
        const update=db.query(`UPDATE multiremi_conversation_log SET ${column}=? WHERE id=?`);
        update.run(value,message.id);
        try {await rejectsWithoutIssuing();} finally {update.run(message[column],message.id);}
      }
      const original=db.query('SELECT manifest_json FROM multiremi_attempt_eligibility WHERE attempt_id=?').get(attemptId).manifest_json;
      const snapshot=db.query('SELECT manifest_snapshot FROM multiremi_attempt_input_approvals WHERE attempt_id=?').get(attemptId).manifest_snapshot;
      const altered=JSON.parse(snapshot);
      altered.inputs.entries.push({...altered.inputs.entries[0],source:{id:providerId,version:grant.grant.generation},author:{type:'agent',id:agent.id}});
      const forged=JSON.stringify(altered);
      const digest=`sha256:${createHash('sha256').update(forged).digest('hex')}`;
      const approvalUpdate=db.query('UPDATE multiremi_attempt_input_approvals SET manifest_digest=?,manifest_snapshot=? WHERE attempt_id=?');
      const eligibilityUpdate=db.query('UPDATE multiremi_attempt_eligibility SET manifest_json=? WHERE attempt_id=?');
      approvalUpdate.run(digest,forged,attemptId);
      eligibilityUpdate.run(JSON.stringify({...JSON.parse(original),digest}),attemptId);
      try {await rejectsWithoutIssuing();} finally {
        approvalUpdate.run(JSON.parse(original).digest,snapshot,attemptId);
        eligibilityUpdate.run(original,attemptId);
      }
      const delivered=await offer();
      db.query("UPDATE multiremi_conversation_log SET sender_id='unknown' WHERE id=?").run(message.id);
      await expect(offer()).rejects.toThrow('root_input_unapproved');
      db.query('UPDATE multiremi_conversation_log SET sender_id=? WHERE id=?').run(message.sender_id,message.id);
      expect(await offer()).toEqual(delivered);
      return;
    }
    if (scenario==='concurrent dispatch') {
      db.run("INSERT INTO multiremi_live_terms(scope,term,holder,updated_at) VALUES('background_jobs',1,'test','now') ON CONFLICT(scope) DO UPDATE SET term=1");
      expect(store.claimTask(runtime.id,{supportsPromptPolicy:true,policyProtocol:'adopt',offerGeneration:'race',rootMachineCredentialId:'token'})?.id).toBe(attemptId);
      const dir=mkdtempSync(join(tmpdir(),'first-offer-'));
      const file=join(dir,'store.sqlite');
      const postgres=fixture().databaseUrl;
      const barrier=new SharedArrayBuffer(4);
      const workers:Worker[]=[];
      try {
        if (!postgres) db.query('VACUUM INTO ?').run(file);
        const compete=()=>new Promise((resolve,reject)=>{
          const worker=new Worker(new URL('./fixtures/root-first-offer-worker.ts',import.meta.url));
          workers.push(worker);
          worker.onmessage=({data})=>data.error ? reject(new Error(data.error)) : resolve(data.delivery);
          worker.onerror=event=>reject(new Error(event.message));
          worker.postMessage({file,postgres,barrier,attemptId,runtimeId:runtime.id});
        });
        const [left,right]=await Promise.all([compete(),compete()]);
        expect(left).toEqual(right);
        const sqlite=postgres ? null : openSqliteDatabase(file);
        const counts:SqlDatabase=sqlite ?? db;
        try {
          for (const [table,key] of [['delivery_receipts','attempt_id'],['current_task_leases','attempt_id'],['usage_runs','task_id'],['access_tokens','task_id']]) {
            expect(Number(counts.query(`SELECT COUNT(*) AS n FROM multiremi_${table} WHERE ${key}=?`).get(attemptId).n)).toBe(1);
          }
        } finally {sqlite?.close();}
      } finally {await Promise.all(workers.map(worker=>worker.terminate()));rmSync(dir,{recursive:true,force:true});}
      return;
    }
    if (scenario==='first WS offer' || scenario==='retry WS offer') {
      for (const credential of [undefined,null,'different-machine']) {
        expect(store.claimTask(runtime.id,{supportsPromptPolicy:true,policyProtocol:'adopt',rootMachineCredentialId:credential})).toBeNull();
      }
      expect(store.getTask(attemptId)?.status).toBe('queued');
      const server=startMultiremiServer({store,port:0,hostname:'127.0.0.1',authToken:'test-master',backgroundJobs:true});
      const receive=async(resume=false)=>{
        const offered=Promise.withResolvers<Record<string,unknown>>();
        const client=new DaemonProtocolClient({serverUrl:`http://127.0.0.1:${server.port}`,token:'test-daemon',daemonId:'worker',cliVersion:DAEMON_MIN_CLI_VERSION,
          caps:['root.delivery','prompt.policy.adopt.v1'],onFrame(frame){if(frame.type==='task.offer') offered.resolve(frame.payload);}});
        const lane:DaemonProtocolLane={runtime:()=>({runtime_id:runtime.id,provider:'codex',max_concurrency:1,active_task_ids:[],capabilities:{root_delivery_protocol:1,root_carrier_modes:['immutable_run_env']}}),
          heartbeat:()=>({active_task_count:0}),async onHeartbeatAck(){},onRuntimeConfirmed(){client.send({t:'runtime.ready',rt:runtime.id,p:{active_task_ids:[]}});},async probeUpgrade(){},async onTerminal(){}};
        const timeout=setTimeout(()=>offered.reject(new Error(`missing task.offer (${store.getTask(attemptId)?.status})`)),5000);
        try {
          client.addLane(lane);client.startLane(lane);
          const frame=await offered.promise;
          const classified=classifyDaemonTaskOfferPayload(frame);
          if (classified.kind!=='root') throw new Error('expected root offer');
          const delivery=classified.payload.root_delivery;
          const tuple=delivery.tuple;
          const input=delivery.frozen_business_payload.input;
          if (!input || typeof input!=='object' || !('policy_offer' in input) || !input.policy_offer || typeof input.policy_offer!=='object') throw new Error('missing policy');
          const identity={...input.policy_offer};
          for (const key of ['receipt_id','content_hash','offer_generation']) {
            await expect(client.rpc('task.offer_adopt',{...identity,[key]:'tampered'},runtime.id)).rejects.toMatchObject({code:'policy_offer_mismatch'});
          }
          expect(await client.rpc('task.offer_adopt',identity,runtime.id)).toMatchObject({grant:resume?'replay':'first',state:'adopted',...identity});
          if (resume) {
            const keys=new RootMachineKeys({runtimeId:runtime.id,daemonId:'worker',consumerId:tuple.consumer_id,incarnation:'inc',recipientKeyId:'key',deploymentId:'deploy',
              credentialId:'token',credentialDigest:hash,keyExpiresAtMs:expiry},recipientKeys.privateKey,signerKeys.privateKey);
            const recovery=new RootReceiptClient(client,{async answerChallenge(challenge){return keys.answerChallenge(challenge);}});
            const locator={runtime_id:runtime.id,daemon_id:'worker',incarnation:'inc',execution_id:'process',birth_token_id:'birth',launch_identity:'launch',carrier_mode:'immutable_run_env' as const,started_at:null};
            await recovery.acknowledge(tuple,delivery.envelope_digest,locator);
            const start=async(seq:number)=>client.event({t:'task.start',seq,rt:runtime.id,p:{...identity,task_id:tuple.attempt_id,usage_run_id:tuple.consumer_id,
              root_receipt_id:tuple.receipt_id,execution_locator:locator,machine_proof:await recovery.proof(tuple,'start')}});
            expect(await start(1)).toMatchObject({ok:true,execution_authorized:true});
            const request={turn_id:turnId,attempt_id:tuple.attempt_id,wait_id:'root-first-native-wait',body_md:'Choose direction',dedupe_key:'root-first-question',options:[{label:'A',value:'A'}],
              metadata:{kind:'question',questions:[{fieldKey:'direction',question:{question:'Choose direction',options:[{label:'A'}]}}]}};
            const question=await client.rpc('turn.decision',request,runtime.id).catch(error=>{throw new Error('first question',{cause:error});});
            const original=store.getQuestion(String(question.message_id));
            expect(original).toMatchObject({route_revision:1,status:'pending'});
            expect((await recovery.status(tuple,delivery.envelope_digest)).allowed_recovery_action).toBe('reattach_running');
            store.reconcileQuestionWaits(runtime.id,[],'token');
            expect(store.getTask(attemptId)?.status).toBe('awaiting_human');
            expect(store.getQuestion(String(question.message_id))?.wait_status).toBe('waiting');
            expect((await recovery.status(tuple,delivery.envelope_digest)).allowed_recovery_action).toBe('reattach_running');
            expect(await client.rpc('turn.decision',request,runtime.id)).toMatchObject({message_id:question.message_id});
            expect(store.getQuestion(String(question.message_id))).toEqual(original);
            const answered=store.answerQuestion(String(question.message_id),{expected_route_revision:1,response:{answer:'A'}},{type:'member',id:'mem_local_local'});
            expect(answered.question.status).toBe('answered');
            const saved=store.getQuestion(String(question.message_id));
            expect(await start(2)).toMatchObject({ok:true,code:'start_replayed'});
            expect(store.getQuestion(String(question.message_id))).toEqual(saved);
            expect(Number(db.query('SELECT COUNT(*) AS n FROM multiremi_conversation_log WHERE dedupe_key=?').get(request.dedupe_key).n)).toBe(1);
          }
          return frame;
        } finally {clearTimeout(timeout);client.stopLane(lane);}
      };
      try {
        const first=await receive();
        expect(first).toMatchObject({attempt_id:attemptId,turn_id:turnId});
        expect(first).not.toHaveProperty('access_token');
        expect(await receive(true)).toEqual(first);
      } finally {await server.stop(true);}
      return;
    }
    db.query("UPDATE multiremi_turn_attempts SET status='lost' WHERE id=?").run(task.id);
    db.query("UPDATE multiremi_turns SET status='failed' WHERE id=?").run(task.id);
    const retry = () => store.retryAdmittedTurn(task.id, task.id, proof, {messages:[source]});
    const rejectRetry = () => {
      expect(retry).toThrow();
      expect(store.getTurn(task.id)?.current_attempt_id).toBe(task.id);
      expect(db.query('SELECT attempt_id FROM multiremi_attempt_input_approvals').all()).toHaveLength(1);
    };
    expect(() => store.retryAdmittedTurn(task.id, task.id, proof, {messages:[{...source,version:source.version+1}]})).toThrow();
    expect(() => store.retryAdmittedTurn(task.id, task.id, proof, {messages:[]})).toThrow();
    db.query('UPDATE multiremi_authority_nodes SET revoked_at_ms=1 WHERE node_id=?').run(providerId);
    rejectRetry();
    db.query('UPDATE multiremi_authority_nodes SET revoked_at_ms=NULL WHERE node_id=?').run(providerId);
    db.query("UPDATE multiremi_agent_source_snapshots SET resource_version=2 WHERE agent_id=? AND kind='input-policy'").run(agent.id);
    rejectRetry();
    db.query("UPDATE multiremi_agent_source_snapshots SET resource_version=1 WHERE agent_id=? AND kind='input-policy'").run(agent.id);
    db.query("UPDATE multiremi_conversation_log SET sender_id='unknown' WHERE id=?").run(message.id);
    rejectRetry();
    db.query('UPDATE multiremi_conversation_log SET sender_id=? WHERE id=?').run(message.sender_id, message.id);
    db.query("UPDATE multiremi_turn_attempts SET session_id='unverified-checkpoint' WHERE id=?").run(task.id);
    rejectRetry();
    db.query('UPDATE multiremi_turn_attempts SET session_id=NULL WHERE id=?').run(task.id);
    expect(store.getTurn(task.id)?.current_attempt_id).toBe(task.id);
    const retried = retry();
    expect(approvedInputs(retried.current_attempt_id!).inputs.entries).toEqual(manifest.inputs.entries);
    expect(db.query("SELECT attempt_id FROM multiremi_attempt_eligibility WHERE eligibility='root' AND attempt_id IN (?,?)").all(task.id,retried.current_attempt_id)).toHaveLength(2);
  }, 30_000);
});
