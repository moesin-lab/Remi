import { bootstrap } from './fixtures/root-kernel-bootstrap.js';
import { JwtMaterials } from '@multiremi/store/jwt-materials.js';
import { expect, it } from 'bun:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { AgentDependencies, agentDependencyDigest, runtimeExecutionFields, type AgentDependencyRef } from '@multiremi/store/agent-dependencies.js';
import { getGroupExecutionProfile } from '@multiremi/store/execution-groups.js';
import { beginMachineChallenge } from '@multiremi/store/machine-proof.js';
import { executionTrustNodeId } from '@multiremi/store/agent-source-approvals.js';
import { assertUnrevokedAncestry } from '@multiremi/store/authority-provenance.js';
import { withSecurityWrite, type SecurityTx } from '@multiremi/store/security-write.js';
import type { StoreContext } from '@multiremi/store/context.js';
import { readWorkspacePromptSettings } from '@multiremi/prompts/workspace-settings.js';
import { runtimeConnectionSnapshot } from '@multiremi/contracts/runtime-connection.js';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';

pendingTurnBackendTests('agent dependency resolution', fixture => {
  it('resolves the execution configuration and rejects stale, incomplete or cyclic protected sources', async () => {
    const {store} = fixture();
    const ctx = (store as unknown as {ctx: StoreContext}).ctx;
    const db = ctx.db;
    const runtime = store.registerRuntime({ name: 'Worker', provider: 'claude', workspaceId: 'local', daemonId: 'worker', metadata: {agent_plugin_protocol: 1} });
    const profile = store.saveExecutionProfile('local', {name: 'gateway', provider: 'claude', profile: {name: 'gateway', model: 'model', base_url: 'https://example.test', auth_mode: 'env', env_key: 'REMI_CLAUDE_TEST'}});
    const group = store.saveExecutionGroup('local', {name: 'worker', provider: 'claude', profile_id: profile.id, runtime_ids: [runtime.id]});
    const agent = store.createAgent({name: 'Reviewer', instructions: 'review', provider: 'claude', executionGroupId: group.id});
    const skill = store.createSkill({name: 'check', content: '# check', files: [{path: 'rules.txt', content: 'original'}]});
    store.setAgentSkills(agent.id, [skill.id!]);
    const plugin = store.importAgentPlugin({provider: 'claude', manifest: {name: 'proof', version: '1.0.0'}, files: [{path: 'skills/proof/SKILL.md', content: '# proof'}]});
    store.createAgentPluginBinding(agent.id, {pluginId: plugin.id});
    const targets = [`management:agent:${agent.id}`, `management:runtime:${runtime.id}`, `machine:${runtime.id}`, 'authority:machine'].sort();
    function transaction<T>(run: (tx: SecurityTx) => T) {
      return withSecurityWrite(db, undefined, {expectedRevision: Number(db.query('SELECT security_revision FROM multiremi_security_state').get().security_revision), workspaceIds: ['local'], numberKeys: [], domainTargets: targets}, run);
    }
    const expiry = Date.now() + 3_600_000;
    const tokenHash = createHash('sha256').update('test-daemon').digest('hex');
    db.query("INSERT INTO multiremi_authority_nodes VALUES('machine',100,1,'machine_registration','daemon','worker','system',1,?,NULL,0)").run(expiry);
    db.query("INSERT INTO multiremi_authority_nodes VALUES('trust-node',101,1,'runtime_trust','runtime',?,'system',1,?,NULL,1)").run(runtime.id, expiry);
    db.run("INSERT INTO multiremi_authority_edges VALUES('trust-node',1,101,'machine',1,100,'continuous')");
    db.query("INSERT INTO multiremi_access_tokens(id,name,type,workspace_id,daemon_id,token_hash,token_prefix,created_at) VALUES('token','test','daemon','local','worker',?,'test','now')").run(tokenHash);
    const pem = (type: 'ed25519' | 'rsa') => (type === 'rsa' ? generateKeyPairSync('rsa', {modulusLength: 3072}) : generateKeyPairSync('ed25519')).publicKey.export({format:'pem',type:'spki'});
    db.query(`INSERT INTO multiremi_machine_enrollments(incarnation,deployment_id,consumer_id,runtime_id,daemon_id,credential_id,credential_digest,
      authority_node_id,generation,signing_spki,recipient_spki,recipient_key_id,key_expires_at_ms,isolation_verified_at_ms,immutable_carrier_verified_at_ms,attestation_expires_at_ms,attestation_id)
      VALUES('inc','deploy','consumer',?,'worker','token',?,'machine',1,?,?,'key',?,1,1,?,'evidence')`).run(runtime.id,tokenHash,pem('ed25519'),pem('rsa'),expiry,expiry);
    const challenge = transaction(tx => beginMachineChallenge(db,tx,'test-daemon',runtime.id,'root.runtime-trust.grant',runtime.id));
    db.query('UPDATE multiremi_machine_challenges SET consumed_at_ms=1,proof_digest=? WHERE challenge_id=?').run('verified',challenge.id);
    db.query("INSERT INTO multiremi_runtime_trusts VALUES('trust',?,1,'inc',?,'trust-node','{}',NULL)").run(runtime.id,challenge.id);

    const contents=new Map<string,string>();
    const digest=(value:unknown)=>{
      const fingerprint=agentDependencyDigest(value);
      contents.set(fingerprint,JSON.stringify(value));
      return fingerprint;
    };
    const entries = new Map<string,{ref: AgentDependencyRef; dependencies: AgentDependencyRef[]}>();
    function record(kind: string, id: string, use: string, hash: string, version = 0) {
      const ref = {kind,id,use,digest:hash,version};
      entries.set(JSON.stringify([kind,id,use]), {ref,dependencies:[]});
      return ref;
    }
    const {skills,root: _projection,...configuration} = store.getAgent(agent.id,{includeFiles:true})!;
    record('agent',agent.id,'configuration',digest(configuration));
    record('agent',agent.id,'instructions',digest(agent.instructions));
    const workspace = store.getWorkspace('local')!;
    record('workspace','local','configuration',digest({context:workspace.context,settings:workspace.settings,repos:workspace.repos}));
    record('workspace','local','prompt',digest(readWorkspacePromptSettings(workspace)));
    record('system-prompt','local','prompt',digest(store.getSystemPrompt('local')));
    record('agent',agent.id,'skills',digest(skills));
    record('skill',skill.id!,'materialize',digest(skills[0]));
    const file = skills[0]!.files![0]!;
    record('skill-file',file.id!,'materialize',digest(file));
    const plugins = store.resolveAgentPluginSnapshot(agent.id);
    record('agent',agent.id,'plugins',digest(plugins));
    const binding = store.listAgentPluginBindings(agent.id)[0]!;
    record('plugin-binding',plugins[0]!.bindingId,'configure',digest({plugin:plugins[0],versionPolicy:binding.versionPolicy,versionId:binding.versionId}));
    record('plugin',plugin.id,'load',digest(plugin));
    record('plugin-version',plugins[0]!.versionId,'materialize',`sha256:${plugins[0]!.digest}`);
    record('execution-group',group.id,'route',digest(store.getExecutionGroup(group.id)));
    record('profile',profile.id,'configure',digest(getGroupExecutionProfile(db,group.id,'local')),profile.revision);
    const host = store.getRuntime(runtime.id)!;
    record('runtime',host.id,'execute',digest({...runtimeExecutionFields(host),incarnation:'inc'}));
    const profileDigest = digest(runtimeConnectionSnapshot(store.getAgentExecutionProfile(host.id,agent),agent.model));
    record('runtime',host.id,'effective-profile',profileDigest);
    record('runtime-env',JSON.stringify([host.id,profile.profile.env_key]),'connect',digest('protected host setting'));
    const provider = record('provider-trust','provider','execute',digest('provider'));
    const checkpointPolicy = record('checkpoint-policy','checkpoint','restore',digest('checkpoint'));
    const inputPolicy = record('input-policy','input','accept',digest('input'));
    const indirect = record('shared-source','repository','read',digest('pinned revision'));
    const inputChildren = entries.get(JSON.stringify(['input-policy','input','accept']))!.dependencies;
    inputChildren.push(indirect);
    let current: SecurityTx;
    const {resolveAgentDependencies} = new AgentDependencies(ctx);
    const resolve = (ids = ['trust']) => transaction(tx => { current = tx; return resolveAgentDependencies(tx,agent.id,ids); });
    expect(resolve).toThrow('root_required');
    const {service,passwordProof,signing}=await bootstrap(db,store.resolveAgentDependencies);
    const compact=service.issueIndependentDashboardSession(passwordProof,(Math.floor(Date.now()/1000)+300)*1000,
      (tx,source,claims)=>new JwtMaterials(db).issue(tx,source,claims,signing));
    const registered=service.registeredCredentials.verifyJwt(compact,signing);
    const sources=[...entries.values()].filter(({ref})=>!['profile','system-prompt'].includes(ref.kind)).map(({ref,dependencies})=>({ref,dependencies,
      content:ref.kind==='plugin-version' ? db.query('SELECT artifact_json FROM multiremi_agent_plugin_versions WHERE id=?').get(ref.id).artifact_json : contents.get(ref.digest)!}));
    const executions=[{trustId:'trust',profileDigest,provider,checkpointPolicy,inputPolicy}];
    const action={action:'root.agent-configuration.approve',use:'write',actualTarget:{type:'agent',id:agent.id}};
    const approve=(complete:boolean)=>{
      const plan=service.planAgentGrant(passwordProof,agent.id,['trust']);
      return withSecurityWrite(db,undefined,plan,tx=>service.approveAgentConfiguration(tx,service.authorizeWrite(tx,passwordProof,action),agent.id,null,
        {sources:complete?sources:sources.filter(source=>source.ref.kind!=='provider-trust'),executions}));
    };
    expect(()=>approve(false)).toThrow('root_required');
    expect(db.query('SELECT agent_id FROM multiremi_agent_config_epochs').all()).toEqual([]);
    const approved=approve(true);
    expect(service.previewAgentGrant(registered,agent.id,['trust'])).toEqual(approved);
    const grantPlan=service.planAgentGrant(registered,agent.id,['trust']);
    const grantUse={action:'root.grant.create',use:'management',actualTarget:action.actualTarget};
    const result=withSecurityWrite(db,undefined,grantPlan,tx=>service.grant(tx,service.authorizeWrite(tx,registered,grantUse),{
      subject:{type:'agent',id:agent.id},runtime_trust_ids:['trust'],accepted_dependency_digest:approved.digest,expected_revision:grantPlan.expectedRevision,idempotency_key:'grant',reason:'reviewed'}));
    expect(result.grant.subject.id).toBe(agent.id);
    const trustSources = [provider,checkpointPolicy].map(ref=>executionTrustNodeId(result.grant.id,'trust',ref));
    const checkSource = (id:string) => withSecurityWrite(db,undefined,{expectedRevision:result.security_revision,workspaceIds:[],numberKeys:[],domainTargets:[`authority:${id}`]},
      tx=>assertUnrevokedAncestry(db,tx,{nodeId:id,generation:result.grant.generation}));
    for (const id of trustSources) {
      expect(checkSource(id)).toBeGreaterThan(Date.now());
      expect(db.query('SELECT parent_id FROM multiremi_authority_edges WHERE child_id=? AND dependency=\'continuous\'').all(id).map(row=>row.parent_id).sort()).toEqual([result.grant.authority_node_id,'trust-node'].sort());
    }
    const manifest = resolve();
    expect(manifest.trustVersions).toEqual([{id:'trust',version:1}]);
    expect(manifest.refs).toContainEqual(indirect);
    expect(manifest.refs).toHaveLength(entries.size);
    expect(resolve()).toEqual(manifest);
    expect(() => resolveAgentDependencies(current,agent.id,['trust'])).toThrow('security_tx_invalid');
    expect(() => resolve(['unknown'])).toThrow('root_runtime_untrusted');
    expect(() => resolve(['trust','trust'])).toThrow();
    db.run("UPDATE multiremi_agent_execution_sources SET incarnation='retired'");
    expect(resolve).toThrow('root_required');
    db.run("UPDATE multiremi_agent_execution_sources SET incarnation='inc'");
    db.run("UPDATE multiremi_agent_config_epochs SET config_epoch=1");
    expect(resolve).toThrow('root_required');
    db.run("UPDATE multiremi_agent_config_epochs SET config_epoch=0");
    db.query("UPDATE multiremi_agent_source_snapshots SET dependencies_json=? WHERE kind='input-policy'").run(JSON.stringify([inputPolicy]));
    expect(resolve).toThrow('root_required');
    db.query("UPDATE multiremi_agent_source_snapshots SET dependencies_json=? WHERE kind='input-policy'").run(JSON.stringify([indirect]));
    db.run("UPDATE multiremi_agent_source_snapshots SET resource_version=1 WHERE kind='shared-source'");
    expect(resolve).toThrow('root_required');
    db.run("UPDATE multiremi_agent_source_snapshots SET resource_version=0 WHERE kind='shared-source'");
    db.run("UPDATE multiremi_authority_nodes SET revoked_at_ms=1 WHERE node_id='machine'");
    for (const id of trustSources) expect(()=>checkSource(id)).toThrow('root_authority_revoked');
    expect(resolve).toThrow('root_runtime_untrusted');
    db.run("UPDATE multiremi_authority_nodes SET revoked_at_ms=NULL WHERE node_id='machine'");
    expect(resolve().digest).toBe(manifest.digest);
    store.upsertSkillFile(skill.id!, {path:file.path,content:'changed'});
    expect(resolve).toThrow('root_required');
    const write={action:'skill-file.update',use:'write',actualTarget:{type:'skill-file',id:file.id!}};
    const writePlan=service.plan(registered,write);
    expect(()=>withSecurityWrite(db,undefined,writePlan,tx=>service.guardProtectedMutation(tx,null,write,0))).toThrow('root_required');
    expect(()=>withSecurityWrite(db,undefined,writePlan,tx=>service.guardProtectedMutation(tx,service.authorizeWrite(tx,registered,write),write,1))).toThrow('authority_revision_conflict');
    withSecurityWrite(db,undefined,writePlan,tx=>{
      service.guardProtectedMutation(tx,service.authorizeWrite(tx,registered,write),write,0);
      store.upsertSkillFile(skill.id!,{path:file.path,content:'approved change'});
    });
    expect(Number(db.query('SELECT config_epoch FROM multiremi_current_agent_config_epochs WHERE agent_id=?').get(agent.id).config_epoch)).toBe(1);
    expect(db.query('SELECT revoked_at_ms FROM multiremi_authority_nodes WHERE node_id=?').get(result.grant.authority_node_id).revoked_at_ms).toBeTruthy();
  });
});
