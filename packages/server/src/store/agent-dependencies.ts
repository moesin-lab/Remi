import { createHash } from 'node:crypto';
import { ANTIGRAVITY_PIN, releaseRuntimeVersions } from '@acp/runtime-versions.js';
import type { RootRuntimeTrustRecord } from '@multiremi/contracts/root-authority.js';
import { runtimeConnectionSnapshot } from '@multiremi/contracts/runtime-connection.js';
import { readWorkspacePromptSettings } from '../prompts/workspace-settings.js';
import { grantAncestryIsCurrent } from './authority-provenance.js';
import type { StoreContext } from './context.js';
import { getExecutionGroup, getGroupExecutionProfile } from './execution-groups.js';
import { recordedMachineBindingIsCurrent } from './machine-proof.js';
import { WorkspacesRepo } from './repos/workspaces-repo.js';
import { SecurityAbort, withSecurityTarget, type SecurityTx } from './security-write.js';
import { tableExists } from './unified-model-migration.js';

export interface AgentDependencyRef {
  kind: string; id: string; version: number; digest: string; use: string;
}

function reject(): never { throw new SecurityAbort('root_required'); }

export function agentDependencyDigest(value: unknown): string {
  const json = JSON.stringify(value, (_name, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
  return `sha256:${createHash('sha256').update(json).digest('hex')}`;
}

function snapshotVersion(digest: string): number {
  return Number.parseInt(digest.slice(7, 15), 16) >>> 1;
}

export class AgentDependencies {
  constructor(private readonly ctx: StoreContext) {}

  readonly resolveAgentDependencies = (tx: SecurityTx, agentId: string, trustIds: readonly string[]) => {
    const ctx = this.ctx;
    const db = ctx.db;
    return withSecurityTarget(db, tx, `management:agent:${agentId}`, () => {
      if (!trustIds.length || new Set(trustIds).size !== trustIds.length || trustIds.some(id => typeof id !== 'string' || !id.trim())) reject();
      const agent = ctx.agents().getAgent(agentId, { includeFiles: true });
      if (!agent || agent.archivedAt || agent.model_policy_reason || agent.executable || agent.customArgs.length
        || (agent.mcpConfig != null && (typeof agent.mcpConfig !== 'object' || Array.isArray(agent.mcpConfig) || Object.keys(agent.mcpConfig).length))) reject();
      const workspace = ctx.workspaces().getWorkspace(agent.workspaceId) ?? reject();
      const workspaceEnv = new WorkspacesRepo(ctx).getWorkspaceEnv(workspace.id);
      const environment = {...workspaceEnv,...agent.customEnv};
      if (Object.keys(environment).some(name => !['LANG','LC_ALL','LC_CTYPE','TZ'].includes(name))) reject();
      const configEpoch = tableExists(db, 'multiremi_agent_grant_dependencies')
        ? Number(db.query('SELECT COALESCE(MAX(config_epoch),0) AS epoch FROM multiremi_agent_grant_dependencies WHERE agent_id=?').get(agentId).epoch) : 0;
      if (!Number.isSafeInteger(configEpoch) || configEpoch < 0) reject();

      const refs = new Map<string, AgentDependencyRef>();
      function add(kind: string, id: string, use: string, digest: string, version = snapshotVersion(digest)) {
        if (!id || !/^sha256:[a-f0-9]{64}$/.test(digest) || !Number.isSafeInteger(version) || version < 0) reject();
        const key = JSON.stringify([kind,id,use]);
        const prior = refs.get(key);
        if (prior && (prior.digest !== digest || prior.version !== version)) reject();
        refs.set(key, {kind,id,use,version,digest});
      }
      function observe(kind: string, id: string, use: string, value: unknown, version?: number) {
        add(kind,id,use,agentDependencyDigest(value),version);
      }

      const { skills, root: _projection, ...configuration } = agent;
      const plugins = ctx.agentPlugins().resolveAgentPluginSnapshot(agentId);
      observe('agent',agentId,'configuration',{configuration,skills,plugins,environment});
      const prompt = ctx.systemPrompts().getSystemPrompt(workspace.id);
      observe('system-prompt',workspace.id,'prompt',prompt,prompt.document.revision);
      observe('workspace',workspace.id,'instructions',{context:workspace.context,settings:workspace.settings,repos:workspace.repos,workspaceEnv,prompt:readWorkspacePromptSettings(workspace)});
      for (const skill of skills) {
        if (skill.id) observe('skill',skill.id,'materialize',skill);
        for (const file of skill.files ?? []) if (file.id) observe('skill-file',file.id,'materialize',file);
      }
      const bindings = new Map(ctx.agentPlugins().listAgentPluginBindings(agentId).map(binding => [binding.id,binding]));
      for (const plugin of plugins) {
        const binding = bindings.get(plugin.bindingId) ?? reject();
        const version = binding.resolvedVersion;
        if (!version || version.id !== plugin.versionId || plugin.connectionId || Object.keys(version.requirements).length) reject();
        observe('plugin-binding',binding.id,'configure',{plugin,versionPolicy:binding.versionPolicy,versionId:binding.versionId});
        observe('plugin',plugin.pluginId,'load',{provider:binding.plugin.provider,workspaceId:binding.plugin.workspaceId,
          archivedAt:binding.plugin.archivedAt,activeVersionId:binding.plugin.activeVersionId});
        const artifact = db.query('SELECT artifact_json FROM multiremi_agent_plugin_versions WHERE id=? AND plugin_id=? AND artifact_digest=?')
          .get(plugin.versionId,plugin.pluginId,plugin.digest);
        if (!artifact || createHash('sha256').update(artifact.artifact_json).digest('hex') !== plugin.digest) reject();
        add('plugin-version',plugin.versionId,'materialize',`sha256:${plugin.digest}`);
      }

      const group = agent.executionGroupId ? getExecutionGroup(db,agent.executionGroupId,workspace.id) ?? reject() : null;
      if (group) {
        if (group.provider !== agent.provider) reject();
        observe('execution-group',group.id,'route',group);
        if (group.profileId) {
          const profile = getGroupExecutionProfile(db,group.id,workspace.id) ?? reject();
          if (!group.profileRevision || profile.revision !== group.profileRevision) reject();
          observe(group.endpointId ? 'endpoint' : 'profile',group.profileId,'configure',profile,profile.revision);
        }
      }
      const trustVersions = [...trustIds].sort().map(id => {
        const row = db.query(`SELECT t.*,e.daemon_id,e.consumer_id,e.attestation_id,e.deployment_id,c.binding_digest,c.proof_digest
          FROM multiremi_runtime_trusts t JOIN multiremi_machine_enrollments e ON e.incarnation=t.incarnation AND e.runtime_id=t.runtime_id
          JOIN multiremi_machine_challenges c ON c.challenge_id=t.challenge_id AND c.incarnation=e.incarnation
          JOIN multiremi_authority_nodes n ON n.node_id=t.authority_node_id AND n.generation=t.generation
          WHERE t.trust_id=? AND t.revoked_at_ms IS NULL AND e.retired_at_ms IS NULL AND c.purpose='root.runtime-trust.grant'
          AND n.kind='runtime_trust' AND n.subject_type='runtime' AND n.subject_id=t.runtime_id`).get(id);
        if (!row) throw new SecurityAbort('root_runtime_untrusted');
        const trust = JSON.parse(row.record_json) as RootRuntimeTrustRecord;
        const runtime = ctx.runtimes().getRuntime(row.runtime_id);
        const version = Number(row.generation);
        if (!runtime || runtime.workspaceId !== workspace.id || runtime.daemonId !== row.daemon_id || !Number.isSafeInteger(version) || version < 1
          || trust.id !== id || trust.generation !== version || trust.runtime_id !== runtime.id || trust.workspace_id !== workspace.id
          || trust.daemon_id !== runtime.daemonId || trust.incarnation !== row.incarnation || trust.immutable_env_carrier_verified !== true
          || trust.status !== 'active' || trust.revoked_at !== null || (trust.expires_at !== null && !(Date.parse(trust.expires_at) > Date.now()))
          || !/^[a-f0-9]{64}$/.test(row.proof_digest) || (agent.runtimeId && agent.runtimeId !== runtime.id)
          || !(group ? group.runtimeIds.includes(runtime.id) : agent.runtimeId === runtime.id) || !ctx.runtimes().runtimeCanRunAgent(runtime,agent)
          || !recordedMachineBindingIsCurrent(db,tx,runtime.id,row.challenge_id,{...trust,consumer_id:row.consumer_id})
          || !grantAncestryIsCurrent(db,tx,runtime.id,{nodeId:row.authority_node_id,generation:version},'runtime')) throw new SecurityAbort('root_runtime_untrusted');
        observe('runtime',runtime.id,'execute',{daemonId:runtime.daemonId,provider:runtime.provider,runtimeMode:runtime.runtimeMode,metadata:runtime.metadata,models:runtime.models});
        observe('runtime-trust',id,'execute',{trust,authorityNodeId:row.authority_node_id,attestationId:row.attestation_id,
          deploymentId:row.deployment_id,challengeId:row.challenge_id,binding:row.binding_digest,proof:row.proof_digest},version);
        const provider = agent.provider;
        const release = provider === 'codex' || provider === 'claude' ? releaseRuntimeVersions(provider)
          : provider === 'antigravity' ? ANTIGRAVITY_PIN : null;
        if (!release && !(provider === 'grok' && typeof runtime.metadata.agent_version === 'string' && runtime.metadata.agent_version.trim())) reject();
        const configured = ctx.runtimes().getAgentExecutionProfile(runtime.id,agent);
        if (configured && !configured.model && !agent.model) reject();
        const profile = runtimeConnectionSnapshot(configured,agent.model);
        if (profile) {
          if (profile.auth_mode !== 'api_key' || !profile.credential_id) reject();
          const credential = group?.managed && group.profileId
            ? db.query('SELECT ciphertext FROM multiremi_execution_profile_credentials WHERE id=? AND profile_id=? AND workspace_id=?')
              .get(profile.credential_id,group.profileId,workspace.id)
            : db.query('SELECT ciphertext FROM multiremi_runtime_provider_credentials WHERE id=? AND runtime_id=?').get(profile.credential_id,runtime.id);
          if (!credential?.ciphertext) reject();
          observe('profile-credential',profile.credential_id,'connect',credential.ciphertext);
        }
        observe('runtime-trust',id,'provider',{agentId,provider,release,incarnation:trust.incarnation,profile,model:agent.model,fallbackModel:agent.fallbackModel},version);
        observe('runtime-trust',id,'checkpoint-origin',{workspaceId:workspace.id,agentId,provider:agent.provider,
          runtimeId:runtime.id,incarnation:trust.incarnation,consumerId:row.consumer_id,recipientKey:trust.recipient_key_fingerprint},version);
        return {id,version};
      });
      const manifest = {agentId,configEpoch,trustVersions,refs:[...refs.entries()].sort(([left],[right]) => left < right ? -1 : left > right ? 1 : 0).map(([,ref]) => ref)};
      return {...manifest,digest:agentDependencyDigest(manifest)};
    });
  };
}
