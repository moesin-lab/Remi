import { runtimeConnectionSnapshot } from '@multiremi/contracts/runtime-connection.js';
import { readWorkspacePromptSettings } from '@multiremi/prompts/workspace-settings.js';
import { agentDependencyDigest, runtimeExecutionFields } from '@multiremi/store/agent-dependencies.js';
import type { MultiremiAgent, MultiremiSkillFile } from '@multiremi/contracts/types.js';
import type { AgentConfigurationApproval } from '@multiremi/store/agent-source-approvals.js';
import { createHash } from 'node:crypto';
import type { SqlDatabase } from '@multiremi/store/db/postgres.js';
import { bootstrapAuthorizationDigest, RootManagement } from '@multiremi/store/root-management.js';
import type { ResolveAgentDependencies } from '@multiremi/store/agent-grant-dependencies.js';
import { createMultiremiApp } from '@multiremi/api.js';
import type { MultiremiStore } from '@multiremi/store/store.js';

const hash=(input:string)=>createHash('sha256').update(input).digest('hex');

export function agentApproval(store: MultiremiStore, agent: MultiremiAgent, file?: MultiremiSkillFile) {
  const sources: AgentConfigurationApproval['sources'][number][] = [];
  function approve(kind: string, id: string, use: string, value: unknown) {
    const ref = { kind, id, use, version: 1, digest: agentDependencyDigest(value) };
    sources.push({ ref, content: JSON.stringify(value), dependencies: [] });
    return ref;
  }
  const { root: _projection, skills, ...configuration } = store.getAgent(agent.id, {includeFiles: true})!;
  const workspace = store.getWorkspace(agent.workspaceId ?? 'local')!;
  approve('agent', agent.id, 'configuration', configuration);
  approve('agent', agent.id, 'instructions', agent.instructions);
  const instruction = sources[sources.length - 1]!;
  if (file?.id) instruction.dependencies = [approve('skill-file', file.id, 'materialize', file)];
  approve('agent', agent.id, 'skills', skills);
  approve('agent', agent.id, 'plugins', store.resolveAgentPluginSnapshot(agent.id));
  approve('workspace', workspace.id, 'configuration', {context: workspace.context, settings: workspace.settings, repos: workspace.repos});
  approve('workspace', workspace.id, 'prompt', readWorkspacePromptSettings(workspace));
  const host = store.getRuntime(agent.runtimeId!)!;
  approve('runtime', host.id, 'execute', {...runtimeExecutionFields(host), incarnation: 'inc'});
  const profile = approve('runtime', host.id, 'effective-profile', runtimeConnectionSnapshot(store.getAgentExecutionProfile(host.id, agent), agent.model));
  const execution = { trustId: 'trust', profileDigest: profile.digest, provider: approve('provider-trust','provider','execute','test provider'),
    checkpointPolicy: approve('checkpoint-policy','checkpoint','restore','test checkpoint policy'), inputPolicy: approve('input-policy','inputs','accept','test input policy') };
  return { sources, executions: [execution] };
}

export function rootClient(store: MultiremiStore, signing: { domainId: string; keyEpoch: string; secret: string }) {
  const master = 'isolated-master-token';
  const { request } = createMultiremiApp({ store, authToken: master });
  return async (path: string, token = master, body?: object, method = body ? 'POST' : 'GET', headers?: HeadersInit) => {
    const env = { JWT_SECRET: signing.secret, MULTIREMI_JWT_SIGNING_DOMAIN: signing.domainId, MULTIREMI_JWT_KEY_EPOCH: signing.keyEpoch };
    const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    Object.assign(process.env, env);
    const requestHeaders = new Headers(headers);
    requestHeaders.set('Authorization', `Bearer ${token}`);
    if (body) requestHeaders.set('Content-Type', 'application/json');
    try {
      return await request(path, { method, headers: requestHeaders, ...(body && { body: JSON.stringify(body) }) });
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
}

export async function bootstrap(db:SqlDatabase, resolve?: ResolveAgentDependencies) {
    const service = new RootManagement(db,resolve);
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
