import { expect, it } from 'bun:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { RootMachineKeys } from '@daemon/agent-runtime/root-machine-keys.js';
import { AgentDependencies, agentDependencyDigest } from '@multiremi/store/agent-dependencies.js';
import type { StoreContext } from '@multiremi/store/context.js';
import { beginMachineChallenge, verifyMachineChallenge } from '@multiremi/store/machine-proof.js';
import { machineEnrollmentPayload } from '@multiremi/store/machine-enrollment.js';
import { bootstrapAuthorizationDigest, RootManagement } from '@multiremi/store/root-management.js';
import { withSecurityWrite, type SecurityTx } from '@multiremi/store/security-write.js';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

async function trustRuntime(ctx: StoreContext, runtimeId: string) {
  const db = ctx.db;
  const service = new RootManagement(db);
  const password = 'local-test-password';
  const verifier = await Bun.password.hash(password,{algorithm:'argon2id',memoryCost:19456,timeCost:2});
  db.run("INSERT INTO multiremi_users(id,name,email,created_at,updated_at) VALUES('usr_test','test','test@example.invalid','now','now')");
  db.query("INSERT INTO multiremi_password_credentials(user_id,login_email,password_hash,updated_at) VALUES('usr_test','test@example.invalid',?,'now')").run(verifier);
  db.run("INSERT INTO multiremi_authority_nodes VALUES('identity',1,1,'independent_identity','user','usr_test','system',0,9999999999999,NULL,0)");
  db.run("INSERT INTO multiremi_authority_nodes VALUES('password',2,1,'password','user','usr_test','system',0,9999999999999,NULL,1)");
  db.run("INSERT INTO multiremi_authority_edges VALUES('password',1,2,'identity',1,1,'continuous')");
  db.query("INSERT INTO multiremi_password_authority_versions VALUES('usr_test',1,?,'password','identity')").run(hash(verifier));
  const bootstrap = {userId:'usr_test',deploymentId:'test',authorization:'once',reason:'test',expectedRevision:0};
  db.query(`INSERT INTO multiremi_root_bootstrap_authorizations(authorization_digest,deployment_id,user_id,reason,expires_at_ms)
    VALUES(?,'test','usr_test','test',?)`).run(bootstrapAuthorizationDigest(bootstrap),Date.now()+600_000);
  const proof = await service.verifyIndependentPassword('usr_test',password);
  service.bootstrapHuman(proof,bootstrap);
  db.run("UPDATE multiremi_security_state SET feature_activation=1,minimum_enforcement_version='test'");
  const expires = Date.now()+600_000;
  const keys = new RootMachineKeys({runtimeId,daemonId:'worker',consumerId:'consumer',incarnation:'inc',recipientKeyId:'key',
    deploymentId:'test', credentialId:'token', credentialDigest:hash('test-daemon'), keyExpiresAtMs:expires},
    generateKeyPairSync('rsa',{modulusLength:3072}).privateKey,generateKeyPairSync('ed25519').privateKey);
  const binding = keys.publicBinding();
  const issuer = generateKeyPairSync('ed25519');
  const host = generateKeyPairSync('ed25519');
  db.query("INSERT INTO multiremi_authority_nodes VALUES('deployment',100,1,'deployment_origin','deployment','test','system',1,?,NULL,0)").run(expires);
  db.query("INSERT INTO multiremi_machine_deployment_roots VALUES('test','deployment',?,?)").run(
    issuer.publicKey.export({type:'spki',format:'pem'}),host.publicKey.export({type:'spki',format:'pem'}));
  db.query("INSERT INTO multiremi_access_tokens(id,name,type,workspace_id,daemon_id,token_hash,token_prefix,created_at) VALUES('token','test','daemon','local','worker',?,'test','now')").run(hash('test-daemon'));
  const report = {id:'test-attestation',isolationVerifiedAtMs:Date.now(),immutableCarrierVerifiedAtMs:Date.now(),expiresAtMs:expires};
  const deploymentProof = sign(null,machineEnrollmentPayload('deployment',binding,report,0),issuer.privateKey).toString('base64url');
  const signature = sign(null,machineEnrollmentPayload('attestation',binding,report,0),host.privateKey).toString('base64url');
  withSecurityWrite(db,undefined,{expectedRevision:1,workspaceIds:['local'],numberKeys:[],domainTargets:['authority:deployment',`machine:${runtimeId}`]},
    tx => service.enrollMachine(tx,deploymentProof,{...report,signature},binding,0));
  const action = 'root.runtime-trust.grant';
  const use = {action,use:'management',actualTarget:{type:'runtime',id:runtimeId}};
  const plan = service.plan(proof,use);
  const machinePlan = {...plan,domainTargets:[...plan.domainTargets,`machine:${runtimeId}`].sort()};
  const challenge = withSecurityWrite(db,undefined,machinePlan,tx => beginMachineChallenge(db,tx,'test-daemon',runtimeId,action,runtimeId));
  const reply = keys.answerChallenge(challenge);
  const verified = withSecurityWrite(db,undefined,machinePlan,tx => verifyMachineChallenge(db,tx,'test-daemon',challenge.id,action,runtimeId,reply));
  return withSecurityWrite(db,undefined,plan,tx => service.grantRuntimeTrust(tx,service.authorizeWrite(tx,proof,use),{
    runtime_id:runtimeId,daemon_id:binding.daemonId,incarnation:binding.incarnation,recipient_key_id:binding.recipientKeyId,
    recipient_key_fingerprint:reply.recipient_key_fingerprint,challenge_id:challenge.id,challenge_response:verified.proofDigest,
    expected_revision:plan.expectedRevision,idempotency_key:'trust',reason:'signed runtime',
  }));
}

pendingTurnBackendTests('agent dependency resolution', fixture => {
  it('previews a first grant from current configuration and signed runtime trust on the migrated schema', async () => {
    const {store} = fixture();
    const ctx = (store as unknown as {ctx:StoreContext}).ctx;
    const {db} = ctx;
    const runtime = store.registerRuntime({name:'Worker',provider:'claude',workspaceId:'local',daemonId:'worker',metadata:{agent_plugin_protocol:1}});
    const previousKey = process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
    process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32,1).toString('base64');
    let profile;
    try {
      profile = store.saveExecutionProfile('local',{name:'gateway',provider:'claude',api_key:'unit-test-key',
        profile:{name:'gateway',model:'model',base_url:'https://example.test',auth_mode:'api_key',env_key:''}});
    } finally {
      if (previousKey === undefined) delete process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY;
      else process.env.MULTIREMI_PROVIDER_ENCRYPTION_KEY = previousKey;
    }
    const group = store.saveExecutionGroup('local',{name:'worker',provider:'claude',profile_id:profile.id,runtime_ids:[runtime.id]});
    const agent = store.createAgent({name:'Reviewer',instructions:'review',provider:'claude',executionGroupId:group.id});
    const skill = store.createSkill({name:'check',content:'# check',files:[{path:'rules.txt',content:'original'}]});
    store.setAgentSkills(agent.id,[skill.id!]);
    const plugin = store.importAgentPlugin({provider:'claude',manifest:{name:'proof',version:'1.0.0'},files:[{path:'skills/proof/SKILL.md',content:'# proof'}]});
    const binding = store.createAgentPluginBinding(agent.id,{pluginId:plugin.id});
    const issued = await trustRuntime(ctx,runtime.id);
    const trustId = issued.trust.id;
    const targets = [`management:agent:${agent.id}`,`management:runtime:${runtime.id}`].sort();
    const plan = {expectedRevision:issued.security_revision,workspaceIds:['local'],numberKeys:[],domainTargets:targets};
    const {resolveAgentDependencies} = new AgentDependencies(ctx);
    let previousTx: SecurityTx;
    const resolve = (ids = [trustId]) => withSecurityWrite(db,undefined,plan,tx => {
      previousTx = tx;
      return resolveAgentDependencies(tx,agent.id,ids);
    });
    const snapshot = resolve();
    const {digest,...manifest} = snapshot;
    expect(digest).toBe(agentDependencyDigest(manifest));
    expect(snapshot.trustVersions).toEqual([{id:trustId,version:issued.trust.generation}]);
    expect(snapshot.refs.map(ref => ref.kind)).toEqual(expect.arrayContaining(['agent','workspace','skill','skill-file','system-prompt','plugin','plugin-binding','plugin-version','profile','execution-group','profile-credential','runtime','runtime-trust']));
    expect(snapshot.refs.find(ref => ref.kind === 'profile')).toMatchObject({id:profile.id,version:profile.revision});
    expect(snapshot.refs.find(ref => ref.kind === 'plugin-version')?.digest).toBe(`sha256:${plugin.activeVersion!.artifactDigest}`);
    expect(snapshot.refs.filter(ref => ref.kind === 'runtime-trust').map(ref => ref.use)).toEqual(['checkpoint-origin','execute','provider']);
    expect(JSON.stringify(snapshot)).not.toContain('unit-test-key');
    expect(resolve()).toEqual(snapshot);
    expect(() => resolveAgentDependencies(previousTx,agent.id,[trustId])).toThrow('security_tx_invalid');
    expect(() => resolve(['missing'])).toThrow('root_runtime_untrusted');
    expect(() => resolve([trustId,trustId])).toThrow();
    store.upsertSkillFile(skill.id!,{path:'rules.txt',content:'changed'});
    const changed = resolve();
    expect(changed.digest).not.toBe(digest);
    expect(changed.refs.find(ref => ref.kind === 'skill-file')?.digest).not.toBe(snapshot.refs.find(ref => ref.kind === 'skill-file')?.digest);
    store.updateAgentPluginBinding(agent.id,binding.id,{connectionId:'unresolved'});
    expect(resolve).toThrow('root_required');
    store.updateAgentPluginBinding(agent.id,binding.id,{connectionId:null});
    store.updateAgent(agent.id,{executable:'/unversioned/provider'});
    expect(resolve).toThrow('root_required');
    store.updateAgent(agent.id,{executable:null});
    expect(resolve().trustVersions).toEqual(snapshot.trustVersions);
    db.run("UPDATE multiremi_authority_nodes SET revoked_at_ms=1 WHERE node_id=(SELECT authority_node_id FROM multiremi_machine_enrollments WHERE incarnation='inc')");
    expect(resolve).toThrow('root_runtime_untrusted');
  });
});
