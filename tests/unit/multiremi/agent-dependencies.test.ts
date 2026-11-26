import { expect, it } from 'bun:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { AgentDependencies, agentDependencyDigest as digest, type AgentDependencyRef } from '@multiremi/store/agent-dependencies.js';
import { getGroupExecutionProfile } from '@multiremi/store/execution-groups.js';
import { beginMachineChallenge } from '@multiremi/store/machine-proof.js';
import { withSecurityWrite, type SecurityTx } from '@multiremi/store/security-write.js';
import type { StoreContext } from '@multiremi/store/context.js';
import { readWorkspacePromptSettings } from '@multiremi/prompts/workspace-settings.js';
import { runtimeConnectionSnapshot } from '@multiremi/contracts/runtime-connection.js';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';

pendingTurnBackendTests('agent dependency resolution', fixture => {
  it('resolves the execution configuration and rejects stale, incomplete or cyclic protected sources', () => {
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
      return withSecurityWrite(db, undefined, {expectedRevision: 0, workspaceIds: ['local'], numberKeys: [], domainTargets: targets}, run);
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
    record('runtime',host.id,'execute',digest({daemonId:host.daemonId,incarnation:'inc',provider:host.provider,runtimeMode:host.runtimeMode,metadata:host.metadata,models:host.models}));
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
    db.exec(`CREATE TABLE fixture_epochs(agent_id TEXT,workspace_id TEXT,config_epoch INTEGER);
      CREATE TABLE fixture_snapshots(agent_id TEXT,workspace_id TEXT,config_epoch INTEGER,kind TEXT,resource_id TEXT,use_kind TEXT,
        resource_version INTEGER,digest TEXT,dependencies_json TEXT);
      CREATE TABLE fixture_sources(agent_id TEXT,workspace_id TEXT,config_epoch INTEGER,runtime_id TEXT,trust_id TEXT,trust_generation INTEGER,
        incarnation TEXT,provider TEXT,profile_digest TEXT,provider_ref TEXT,checkpoint_policy_ref TEXT,input_policy_ref TEXT);
      CREATE VIEW multiremi_current_agent_config_epochs AS SELECT * FROM fixture_epochs;
      CREATE VIEW multiremi_current_agent_source_snapshots AS SELECT * FROM fixture_snapshots;
      CREATE VIEW multiremi_current_agent_execution_sources AS SELECT * FROM fixture_sources`);
    db.query("INSERT INTO fixture_epochs VALUES(?,'local',0)").run(agent.id);
    for (const {ref,dependencies} of entries.values()) {
      if (['profile','system-prompt'].includes(ref.kind)) continue;
      db.query("INSERT INTO fixture_snapshots VALUES(?,'local',0,?,?,?,?,?,?)").run(agent.id,ref.kind,ref.id,ref.use,ref.version,ref.digest,JSON.stringify(dependencies));
    }
    expect(resolve).toThrow('root_required');
    db.query("INSERT INTO fixture_sources VALUES(?,'local',0,?,'trust',1,'inc','claude',?,?,?,?)")
      .run(agent.id,runtime.id,profileDigest,JSON.stringify(provider),JSON.stringify(checkpointPolicy),JSON.stringify(inputPolicy));
    const manifest = resolve();
    expect(manifest.trustVersions).toEqual([{id:'trust',version:1}]);
    expect(manifest.refs).toContainEqual(indirect);
    expect(manifest.refs).toHaveLength(entries.size);
    expect(resolve()).toEqual(manifest);
    expect(() => resolveAgentDependencies(current,agent.id,['trust'])).toThrow('security_tx_invalid');
    expect(() => resolve(['unknown'])).toThrow('root_runtime_untrusted');
    expect(() => resolve(['trust','trust'])).toThrow();
    db.run("UPDATE fixture_sources SET incarnation='retired'");
    expect(resolve).toThrow('root_required');
    db.run("UPDATE fixture_sources SET incarnation='inc'");
    db.run("UPDATE fixture_epochs SET config_epoch=1");
    expect(resolve).toThrow('root_required');
    db.run("UPDATE fixture_epochs SET config_epoch=0");
    db.query("UPDATE fixture_snapshots SET dependencies_json=? WHERE kind='input-policy'").run(JSON.stringify([inputPolicy]));
    expect(resolve).toThrow('root_required');
    db.query("UPDATE fixture_snapshots SET dependencies_json=? WHERE kind='input-policy'").run(JSON.stringify([indirect]));
    db.run("UPDATE fixture_snapshots SET resource_version=1 WHERE kind='shared-source'");
    expect(resolve).toThrow('root_required');
    db.run("UPDATE fixture_snapshots SET resource_version=0 WHERE kind='shared-source'");
    db.run("UPDATE multiremi_authority_nodes SET revoked_at_ms=1 WHERE node_id='machine'");
    expect(resolve).toThrow('root_runtime_untrusted');
    db.run("UPDATE multiremi_authority_nodes SET revoked_at_ms=NULL WHERE node_id='machine'");
    expect(resolve().digest).toBe(manifest.digest);
    store.upsertSkillFile(skill.id!, {path:file.path,content:'changed'});
    expect(resolve).toThrow('root_required');
  });
});
