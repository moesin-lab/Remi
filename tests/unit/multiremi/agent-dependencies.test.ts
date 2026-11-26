import { expect, it } from 'bun:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { RootMachineKeys } from '@daemon/agent-runtime/root-machine-keys.js';
import { planFrozenAgentDependencies, agentDependencyDigest } from '@multiremi/store/agent-dependencies.js';
import type { StoreContext } from '@multiremi/store/context.js';
import { JwtMaterials } from '@multiremi/store/jwt-materials.js';
import { beginMachineChallenge, verifyMachineChallenge } from '@multiremi/store/machine-proof.js';
import { machineEnrollmentPayload } from '@multiremi/store/machine-enrollment.js';
import { bootstrapAuthorizationDigest, RootManagement } from '@multiremi/store/root-management.js';
import { withSecurityWrite, type SecurityTx } from '@multiremi/store/security-write.js';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

async function bootstrapRoot(ctx: StoreContext, service: RootManagement) {
  const db = ctx.db;
  const password = 'local-test-password';
  const verifier = await Bun.password.hash(password,{algorithm:'argon2id',memoryCost:19456,timeCost:2});
  db.run("INSERT INTO multiremi_users(id,name,email,created_at,updated_at) VALUES('usr_test','test','test@example.invalid','now','now')");
  db.query("INSERT INTO multiremi_password_credentials(user_id,login_email,password_hash,updated_at) VALUES('usr_test','test@example.invalid',?,'now')").run(verifier);
  db.run("INSERT INTO multiremi_authority_nodes VALUES('identity',1,1,'independent_identity','user','usr_test','system',0,9999999999999,NULL,0)");
  db.run("INSERT INTO multiremi_authority_nodes VALUES('password',2,1,'password','user','usr_test','system',0,9999999999999,NULL,1)");
  db.run("INSERT INTO multiremi_authority_edges VALUES('password',1,2,'identity',1,1,'continuous')");
  db.query("INSERT INTO multiremi_password_authority_versions VALUES('usr_test',1,?,'password','identity')").run(hash(verifier));
  const signing = {domainId:'test-dashboard',keyEpoch:'1',secret:'local-test-signing-secret'};
  const bootstrap = {userId:'usr_test',deploymentId:'test',authorization:'once',reason:'test',expectedRevision:0,
    dashboardSigningDomain:{domainId:signing.domainId,keyEpoch:signing.keyEpoch,keyDigest:hash(signing.secret)}};
  db.query(`INSERT INTO multiremi_root_bootstrap_authorizations(authorization_digest,deployment_id,user_id,reason,expires_at_ms)
    VALUES(?,'test','usr_test','test',?)`).run(bootstrapAuthorizationDigest(bootstrap),Date.now()+600_000);
  const proof = await service.verifyIndependentPassword('usr_test',password);
  service.bootstrapHuman(proof,bootstrap);
  db.run("UPDATE multiremi_security_state SET feature_activation=1,minimum_enforcement_version='test'");
  const compact = service.issueIndependentDashboardSession(proof,(Math.floor(Date.now()/1000)+300)*1000,
    (tx,source,claims) => new JwtMaterials(db).issue(tx,source,claims,signing));
  return service.registeredCredentials.verifyJwt(compact,signing);
}

function trustRuntime(ctx: StoreContext, service: RootManagement, proof: Awaited<ReturnType<typeof bootstrapRoot>>, runtimeId: string, daemon: string) {
  const db = ctx.db;
  const expires = Date.now()+600_000;
  const keys = new RootMachineKeys({deploymentId:daemon,credentialId:daemon,credentialDigest:hash(daemon),keyExpiresAtMs:expires,
    runtimeId,daemonId:daemon,consumerId:daemon,incarnation:daemon,recipientKeyId:daemon},
    generateKeyPairSync('rsa',{modulusLength:3072}).privateKey,generateKeyPairSync('ed25519').privateKey);
  const binding = keys.publicBinding();
  const seq = Number(db.query('SELECT MAX(issued_seq) AS seq FROM multiremi_authority_nodes').get().seq)+1;
  const issuer = generateKeyPairSync('ed25519');
  const host = generateKeyPairSync('ed25519');
  const origin = `deployment-${daemon}`;
  db.query("INSERT INTO multiremi_authority_nodes VALUES(?,?,1,'deployment_origin','deployment',?,'system',1,?,NULL,0)").run(origin,seq,daemon,expires);
  db.query('INSERT INTO multiremi_machine_deployment_roots VALUES(?,?,?,?)').run(daemon,origin,
    issuer.publicKey.export({type:'spki',format:'pem'}),host.publicKey.export({type:'spki',format:'pem'}));
  db.query("INSERT INTO multiremi_access_tokens(id,name,type,workspace_id,daemon_id,token_hash,token_prefix,created_at) VALUES(?,'test','daemon','local',?,?,'test','now')").run(daemon,daemon,hash(daemon));
  const report = {id:daemon,isolationVerifiedAtMs:Date.now(),immutableCarrierVerifiedAtMs:Date.now(),expiresAtMs:expires};
  const deploymentProof = sign(null,machineEnrollmentPayload('deployment',binding,report,0),issuer.privateKey).toString('base64url');
  const signature = sign(null,machineEnrollmentPayload('attestation',binding,report,0),host.privateKey).toString('base64url');
  const state = db.query('SELECT security_revision FROM multiremi_security_state WHERE singleton=1').get();
  withSecurityWrite(db,undefined,{expectedRevision:Number(state.security_revision),workspaceIds:['local'],numberKeys:[],domainTargets:[`authority:${origin}`,`machine:${runtimeId}`]},
    tx => service.enrollMachine(tx,deploymentProof,{...report,signature},binding,0));
  const action = 'root.runtime-trust.grant';
  const use = {action,use:'management',actualTarget:{type:'runtime',id:runtimeId}};
  const plan = service.plan(proof,use);
  const machinePlan = {...plan,domainTargets:[...plan.domainTargets,`machine:${runtimeId}`].sort()};
  const challenge = withSecurityWrite(db,undefined,machinePlan,tx => beginMachineChallenge(db,tx,daemon,runtimeId,action,runtimeId));
  const reply = keys.answerChallenge(challenge);
  const verified = withSecurityWrite(db,undefined,machinePlan,tx => verifyMachineChallenge(db,tx,daemon,challenge.id,action,runtimeId,reply));
  return withSecurityWrite(db,undefined,plan,tx => service.grantRuntimeTrust(tx,service.authorizeWrite(tx,proof,use),{
    runtime_id:runtimeId,daemon_id:binding.daemonId,incarnation:binding.incarnation,recipient_key_id:binding.recipientKeyId,
    recipient_key_fingerprint:reply.recipient_key_fingerprint,challenge_id:challenge.id,challenge_response:verified.proofDigest,
    expected_revision:plan.expectedRevision,idempotency_key:'trust',reason:'signed runtime',
  }));
}

pendingTurnBackendTests('agent dependency resolution', fixture => {
  it('freezes current dependencies at grant and rechecks every signed runtime under the frozen lock plan', async () => {
    const {store} = fixture();
    const ctx = (store as unknown as {ctx:StoreContext}).ctx;
    const {db} = ctx;
    const runtime = store.registerRuntime({name:'Worker',provider:'claude',workspaceId:'local',daemonId:'worker',metadata:{agent_plugin_protocol:1}});
    const second = store.registerRuntime({name:'Second',provider:'claude',workspaceId:'local',daemonId:'second',metadata:{agent_plugin_protocol:1}});
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
    const group = store.saveExecutionGroup('local',{name:'worker',provider:'claude',profile_id:profile.id,runtime_ids:[runtime.id,second.id]});
    const agent = store.createAgent({name:'Reviewer',instructions:'review',provider:'claude',executionGroupId:group.id});
    const skill = store.createSkill({name:'check',content:'# check',files:[{path:'rules.txt',content:'original'}]});
    store.setAgentSkills(agent.id,[skill.id!]);
    const plugin = store.importAgentPlugin({provider:'claude',manifest:{name:'proof',version:'1.0.0'},files:[{path:'skills/proof/SKILL.md',content:'# proof'}]});
    const binding = store.createAgentPluginBinding(agent.id,{pluginId:plugin.id});
    const service = store.rootManagement;
    const proof = await bootstrapRoot(ctx,service);
    const other = trustRuntime(ctx,service,proof,second.id,'second');
    const issued = trustRuntime(ctx,service,proof,runtime.id,'worker');
    const trustId = issued.trust.id;
    const targets = [`management:agent:${agent.id}`,`management:runtime:${runtime.id}`].sort();
    const plan = {expectedRevision:issued.security_revision,workspaceIds:['local'],numberKeys:[],domainTargets:targets};
    const {resolveAgentDependencies} = store;
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
    const ids = [trustId,other.trust.id];
    const grantPlan = service.planAgentGrant(proof,agent.id,ids);
    const preview = withSecurityWrite(db,undefined,grantPlan,tx => resolveAgentDependencies(tx,agent.id,ids));
    const create = {action:'root.grant.create',use:'management',actualTarget:{type:'agent',id:agent.id}};
    const grant = (accepted:string) => withSecurityWrite(db,undefined,grantPlan,tx => service.grant(tx,service.authorizeWrite(tx,proof,create),{
      subject:{type:'agent',id:agent.id},runtime_trust_ids:ids,accepted_dependency_digest:accepted,
      expected_revision:grantPlan.expectedRevision,idempotency_key:'agent',reason:'reviewed both runtimes',
    }));
    expect(() => grant(digest)).toThrow('authority_revision_conflict');
    const created = grant(preview.digest);
    const scope = planFrozenAgentDependencies(db,created.grant.id,created.grant.generation,agent.id);
    expect(scope).toEqual({workspaceIds:['local'],domainTargets:[...targets,`management:runtime:${second.id}`].sort()});
    const frozenPlan = {...plan,...scope,expectedRevision:created.security_revision};
    const replay = (domainTargets = frozenPlan.domainTargets) => withSecurityWrite(db,undefined,{...frozenPlan,domainTargets},tx => resolveAgentDependencies(tx,agent.id,ids));
    expect(replay()).toEqual(preview);
    for (const omitted of [`management:agent:${agent.id}`,`management:runtime:${second.id}`]) {
      expect(() => replay(frozenPlan.domainTargets.filter(target => target !== omitted))).toThrow('security_target_unplanned');
    }
    expect(db.query(`SELECT resource_version,use_kind FROM multiremi_agent_grant_protected_refs WHERE grant_id=? AND kind='runtime-trust'
      AND resource_id=? ORDER BY use_kind`).all(created.grant.id,other.trust.id)).toEqual(['checkpoint-origin','execute','provider'].map(use_kind=>({resource_version:other.trust.generation,use_kind})));
    db.query('UPDATE multiremi_authority_nodes SET revoked_at_ms=1 WHERE node_id=(SELECT authority_node_id FROM multiremi_machine_enrollments WHERE incarnation=?)').run('second');
    expect(replay).toThrow('root_runtime_untrusted');
    const mutation = {action:'runtime-trust.update',use:'write',actualTarget:{type:'runtime-trust',id:other.trust.id}};
    const mutationPlan = service.plan(proof,mutation);
    const guard = (version:number) => withSecurityWrite(db,undefined,mutationPlan,tx => service.guardProtectedMutation(tx,service.authorizeWrite(tx,proof,mutation),mutation,version));
    expect(() => guard(other.trust.generation+1)).toThrow('authority_revision_conflict');
    guard(other.trust.generation);
    expect(Number(db.query('SELECT config_epoch FROM multiremi_agent_grant_dependencies WHERE grant_id=?').get(created.grant.id).config_epoch)).toBe(preview.configEpoch+1);
  });
});
