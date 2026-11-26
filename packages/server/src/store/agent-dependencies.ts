import { createHash } from 'node:crypto';
import { runtimeConnectionSnapshot } from '@multiremi/contracts/runtime-connection.js';
import { readWorkspacePromptSettings } from '../prompts/workspace-settings.js';
import type { StoreContext } from './context.js';
import { getExecutionGroup, getGroupExecutionProfile } from './execution-groups.js';
import { recordedMachineBindingIsCurrent } from './machine-proof.js';
import { grantAncestryIsCurrent } from './authority-provenance.js';
import { SecurityAbort, withSecurityTarget, type SecurityTx } from './security-write.js';
import type { SqlDatabase } from './db/postgres.js';

interface Resource { readonly kind: string; readonly id: string; readonly use: string }
export interface AgentDependencyRef extends Resource { readonly version: number; readonly digest: string }
interface Scope { agentId: string; workspaceId: string; configEpoch: number }

export interface AgentDependencyAuthority {
  readConfigEpoch(tx: SecurityTx, agentId: string, workspaceId: string): number | null;
  readProtectedSnapshot(tx: SecurityTx, scope: Readonly<Scope>, resource: Resource): {
    ref: AgentDependencyRef; dependencies: readonly AgentDependencyRef[];
  } | null;
  readExecutionSources(tx: SecurityTx, scope: Readonly<Scope>, execution: {
    runtimeId: string; trustId: string; trustVersion: number; incarnation: string; provider: string; profileDigest: string;
  }): { provider: AgentDependencyRef; checkpointPolicy: AgentDependencyRef; inputPolicy: AgentDependencyRef } | null;
}

function hasAuthorityView(db: SqlDatabase, name: string): boolean {
  return Boolean(db.dialect === 'postgres'
    ? db.query('SELECT viewname FROM pg_views WHERE schemaname=current_schema() AND viewname=?').get(name)
    : db.query("SELECT name FROM sqlite_master WHERE type='view' AND name=?").get(name));
}

class StoredAgentDependencyAuthority implements AgentDependencyAuthority {
  constructor(private readonly db: SqlDatabase) {}

  readConfigEpoch(tx: SecurityTx, agentId: string, workspaceId: string) {
    return withSecurityTarget(this.db, tx, `management:agent:${agentId}`, () => {
      if (!hasAuthorityView(this.db, 'multiremi_current_agent_config_epochs')) return null;
      const rows = this.db.query(`SELECT e.config_epoch,e.approval_node_id,n.generation FROM multiremi_current_agent_config_epochs e
        JOIN multiremi_authority_nodes n ON n.node_id=e.approval_node_id AND n.kind='agent_configuration' AND n.subject_type='agent' AND n.subject_id=e.agent_id
        WHERE e.agent_id=? AND e.workspace_id=? LIMIT 2`).all(agentId,workspaceId);
      if (rows.length!==1 || !grantAncestryIsCurrent(this.db,tx,agentId,{nodeId:rows[0].approval_node_id,generation:Number(rows[0].generation)},'agent')) return null;
      return Number(rows[0].config_epoch);
    });
  }

  readProtectedSnapshot(tx: SecurityTx, scope: Scope, resource: Resource) {
    return withSecurityTarget(this.db, tx, `management:agent:${scope.agentId}`, () => {
      if (!hasAuthorityView(this.db, 'multiremi_current_agent_source_snapshots')) return null;
      const rows = this.db.query(`SELECT resource_version,digest,dependencies_json FROM multiremi_current_agent_source_snapshots
        WHERE agent_id=? AND workspace_id=? AND config_epoch=? AND kind=? AND resource_id=? AND use_kind=? LIMIT 2`)
        .all(scope.agentId,scope.workspaceId,scope.configEpoch,resource.kind,resource.id,resource.use);
      if (rows.length !== 1) return null;
      return {ref: {kind:resource.kind,id:resource.id,use:resource.use,version:rows[0].resource_version,digest:rows[0].digest},
        dependencies: JSON.parse(rows[0].dependencies_json) as AgentDependencyRef[]};
    });
  }

  readExecutionSources(tx: SecurityTx, scope: Scope, execution: Parameters<AgentDependencyAuthority['readExecutionSources']>[2]) {
    return withSecurityTarget(this.db, tx, `management:runtime:${execution.runtimeId}`, () => {
      if (!hasAuthorityView(this.db, 'multiremi_current_agent_execution_sources')) return null;
      const rows = this.db.query(`SELECT provider_ref,checkpoint_policy_ref,input_policy_ref FROM multiremi_current_agent_execution_sources
        WHERE agent_id=? AND workspace_id=? AND config_epoch=? AND runtime_id=? AND trust_id=? AND trust_generation=?
        AND incarnation=? AND provider=? AND profile_digest=? LIMIT 2`).all(scope.agentId,scope.workspaceId,scope.configEpoch,
        execution.runtimeId,execution.trustId,execution.trustVersion,execution.incarnation,execution.provider,execution.profileDigest);
      if (rows.length !== 1) return null;
      return { provider: JSON.parse(rows[0].provider_ref) as AgentDependencyRef, checkpointPolicy: JSON.parse(rows[0].checkpoint_policy_ref) as AgentDependencyRef,
        inputPolicy: JSON.parse(rows[0].input_policy_ref) as AgentDependencyRef };
    });
  }
}

function reject(): never { throw new SecurityAbort('root_required'); }
function versioned(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function key(resource: Resource): string { return JSON.stringify([resource.kind, resource.id, resource.use]); }
export function agentDependencyDigest(value: unknown): string {
  const json = JSON.stringify(value, (_name, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
  return `sha256:${createHash('sha256').update(json).digest('hex')}`;
}

export function planFrozenAgentDependencies(db: SqlDatabase, grantId: string, generation: number, agentId: string) {
  const frozen = db.query(`SELECT d.agent_id,d.grant_generation,d.trust_versions_json,a.workspace_id
    FROM multiremi_agent_grant_dependencies d LEFT JOIN multiremi_agents a ON a.id=d.agent_id WHERE d.grant_id=?`).get(grantId);
  if (!frozen) return {workspaceIds:[],domainTargets:[]};
  if (frozen.agent_id !== agentId || Number(frozen.grant_generation) !== generation || !frozen.workspace_id) throw new SecurityAbort('root_authority_revoked');
  const trusts = JSON.parse(frozen.trust_versions_json);
  if (!Array.isArray(trusts) || !trusts.length) throw new SecurityAbort('root_runtime_untrusted');
  const lookup = db.query('SELECT runtime_id FROM multiremi_runtime_trusts WHERE trust_id=? AND generation=?');
  const targets = new Set([`management:agent:${agentId}`]);
  for (const trust of trusts) {
    if (!trust || typeof trust.id !== 'string' || !Number.isSafeInteger(trust.version)) throw new SecurityAbort('root_runtime_untrusted');
    const runtime = lookup.get(trust.id,trust.version);
    if (!runtime?.runtime_id) throw new SecurityAbort('root_runtime_untrusted');
    targets.add(`management:runtime:${runtime.runtime_id}`);
  }
  return {workspaceIds:[String(frozen.workspace_id)],domainTargets:[...targets].sort()};
}

export class AgentDependencies {
  private readonly authority: StoredAgentDependencyAuthority;
  constructor(private readonly ctx: StoreContext) { this.authority = new StoredAgentDependencyAuthority(ctx.db); }

  readonly resolveAgentDependencies = (tx: SecurityTx, agentId: string, trustIds: readonly string[]) => {
    const { ctx, authority } = this;
    return withSecurityTarget(ctx.db, tx, `management:agent:${agentId}`, () => {
      if (!trustIds.length || new Set(trustIds).size !== trustIds.length || trustIds.some(id => !id?.trim())) reject();
      const agent = ctx.agents().getAgent(agentId, { includeFiles: true });
      if (!agent || agent.archivedAt || agent.model_policy_reason) reject();
      const workspace = ctx.workspaces().getWorkspace(agent.workspaceId) ?? reject();
      const configEpoch = authority.readConfigEpoch(tx, agent.id, workspace.id) ?? reject();
      if (!versioned(configEpoch)) reject();
      const scope = { agentId, workspaceId: workspace.id, configEpoch };
      const refs = new Map<string, AgentDependencyRef>();
      const versions = new Map<string, number>();
      const visiting = new Set<string>();
      const edges = new Map<string, string[]>();
      function visit(resource: Resource, expectedDigest?: string, expectedVersion?: number): void {
        if (![resource.kind,resource.id,resource.use].every(part => typeof part === 'string' && part.trim())) reject();
        const identity = key(resource);
        if (visiting.has(identity) || visiting.size >= 32) reject();
        const cached = refs.get(identity);
        const entry = cached ? null : authority.readProtectedSnapshot(tx, scope, resource) ?? reject();
        const ref = cached ?? entry!.ref;
        if (key(ref) !== identity || !versioned(ref.version) || !/^sha256:[a-f0-9]{64}$/.test(ref.digest)
          || (expectedDigest !== undefined && ref.digest !== expectedDigest) || (expectedVersion !== undefined && ref.version !== expectedVersion)) reject();
        const resourceKey = JSON.stringify([ref.kind,ref.id]);
        if (versions.has(resourceKey) && versions.get(resourceKey) !== ref.version) reject();
        versions.set(resourceKey,ref.version);
        if (!entry) return;
        if (refs.size >= 1024 || !Array.isArray(entry.dependencies)) reject();
        refs.set(identity, { kind: ref.kind, id: ref.id, use: ref.use, version: ref.version, digest: ref.digest });
        visiting.add(identity);
        for (const child of entry.dependencies) pinned(child);
        edges.set(identity, entry.dependencies.map(key).sort());
        visiting.delete(identity);
      }
      function pinned(ref: AgentDependencyRef) {
        if (!ref || !versioned(ref.version) || !/^sha256:[a-f0-9]{64}$/.test(ref.digest)) reject();
        visit(ref, ref.digest, ref.version);
      }
      function observe(kind: string, id: string, use: string, value: unknown) {
        visit({ kind, id, use }, agentDependencyDigest(value));
      }
      function nativeRevision(kind: string, id: string, use: string, value: unknown, version: number) {
        if (!versioned(version)) reject();
        const ref = { kind, id, use, version, digest: agentDependencyDigest(value) };
        const prior = refs.get(key(ref));
        if (prior && (prior.digest !== ref.digest || prior.version !== version)) reject();
        refs.set(key(ref), ref);
      }
      const { skills, root: _projection, ...configuration } = agent;
      observe('agent', agentId, 'configuration', configuration);
      observe('agent', agentId, 'instructions', agent.instructions);
      observe('workspace', workspace.id, 'configuration', { context: workspace.context, settings: workspace.settings, repos: workspace.repos });
      observe('workspace', workspace.id, 'prompt', readWorkspacePromptSettings(workspace));
      const prompt = ctx.systemPrompts().getSystemPrompt(workspace.id);
      nativeRevision('system-prompt', workspace.id, 'prompt', prompt, prompt.document.revision);
      observe('agent', agentId, 'skills', skills);
      for (const skill of skills) {
        if (skill.id) observe('skill', skill.id, 'materialize', skill);
        for (const file of skill.files ?? []) if (file.id) observe('skill-file', file.id, 'materialize', file);
      }
      const plugins = ctx.agentPlugins().resolveAgentPluginSnapshot(agentId);
      const bindings = new Map(ctx.agentPlugins().listAgentPluginBindings(agentId).map(binding => [binding.id,binding]));
      observe('agent', agentId, 'plugins', plugins);
      for (const plugin of plugins) {
        const binding = bindings.get(plugin.bindingId) ?? reject();
        observe('plugin-binding', plugin.bindingId, 'configure', {plugin, versionPolicy: binding.versionPolicy, versionId: binding.versionId});
        visit({kind: 'plugin', id: plugin.pluginId, use: 'load'});
        const artifact = ctx.db.query('SELECT artifact_json FROM multiremi_agent_plugin_versions WHERE id=? AND plugin_id=? AND artifact_digest=?')
          .get(plugin.versionId, plugin.pluginId, plugin.digest);
        if (!artifact || createHash('sha256').update(artifact.artifact_json).digest('hex') !== plugin.digest) reject();
        visit({kind: 'plugin-version', id: plugin.versionId, use: 'materialize'}, `sha256:${plugin.digest}`);
        if (plugin.connectionId) visit({kind: 'plugin-connection', id: plugin.connectionId, use: 'connect'});
      }
      const group = agent.executionGroupId ? getExecutionGroup(ctx.db, agent.executionGroupId, workspace.id) ?? reject() : null;
      if (group) {
        if (group.provider !== agent.provider) reject();
        observe('execution-group', group.id, 'route', group);
        if (group.profileId) {
          const profile = getGroupExecutionProfile(ctx.db, group.id, workspace.id) ?? reject();
          if (!group.profileRevision || profile.revision !== group.profileRevision) reject();
          nativeRevision(group.endpointId ? 'endpoint' : 'profile', group.profileId, 'configure', profile, profile.revision);
        }
      }
      const executions = [...trustIds].sort().map(id => {
        const row = ctx.db.query(`SELECT t.generation,t.runtime_id,t.incarnation,t.authority_node_id,t.challenge_id,e.daemon_id
          FROM multiremi_runtime_trusts t JOIN multiremi_machine_enrollments e ON e.incarnation=t.incarnation AND e.runtime_id=t.runtime_id
          JOIN multiremi_machine_challenges c ON c.challenge_id=t.challenge_id AND c.incarnation=e.incarnation
          JOIN multiremi_authority_nodes n ON n.node_id=t.authority_node_id AND n.generation=t.generation
          WHERE t.trust_id=? AND t.revoked_at_ms IS NULL AND e.retired_at_ms IS NULL AND c.purpose='root.runtime-trust.grant'
          AND n.kind='runtime_trust' AND n.subject_type='runtime' AND n.subject_id=t.runtime_id`).get(id);
        if (!row) throw new SecurityAbort('root_runtime_untrusted');
        const runtime = ctx.runtimes().getRuntime(row.runtime_id);
        const version = Number(row.generation);
        if (!runtime || runtime.workspaceId !== workspace.id || runtime.daemonId !== row.daemon_id || !versioned(version) || version < 1
          || (agent.runtimeId && agent.runtimeId !== runtime.id) || !(group ? group.runtimeIds.includes(runtime.id) : agent.runtimeId === runtime.id)
          || !ctx.runtimes().runtimeCanRunAgent(runtime, agent)
          || !recordedMachineBindingIsCurrent(ctx.db, tx, runtime.id, row.challenge_id)
          || !grantAncestryIsCurrent(ctx.db, tx, runtime.id, {nodeId: row.authority_node_id, generation: version}, 'runtime')) {
          throw new SecurityAbort('root_runtime_untrusted');
        }
        observe('runtime', runtime.id, 'execute', { daemonId: runtime.daemonId, incarnation: row.incarnation, provider: runtime.provider,
          runtimeMode: runtime.runtimeMode, metadata: runtime.metadata, models: runtime.models });
        const configured = ctx.runtimes().getAgentExecutionProfile(runtime.id, agent);
        if (configured && !configured.model && !agent.model) reject();
        const profile = runtimeConnectionSnapshot(configured, agent.model);
        observe('runtime', runtime.id, 'effective-profile', profile);
        if (profile?.auth_mode === 'api_key') {
          if (!profile.credential_id) reject();
          visit({kind:'profile-credential',id:profile.credential_id,use:'connect'});
        } else if (profile?.env_key) {
          visit({kind:'runtime-env',id:JSON.stringify([runtime.id,profile.env_key]),use:'connect'});
        }
        const sources = authority.readExecutionSources(tx, scope, {runtimeId: runtime.id, trustId: id, trustVersion: version,
          incarnation: row.incarnation, provider: agent.provider, profileDigest: agentDependencyDigest(profile)}) ?? reject();
        for (const [kind, use, source] of [['provider-trust','execute',sources.provider], ['checkpoint-policy','restore',sources.checkpointPolicy], ['input-policy','accept',sources.inputPolicy]] as const) {
          if (source?.kind !== kind || source.use !== use) reject();
          pinned(source);
        }
        return { id, version, runtimeId: runtime.id, daemonId: runtime.daemonId, incarnation: String(row.incarnation), sources };
      });
      const trustVersions = executions.map(({ id, version }) => ({ id, version }));
      const manifest = { agentId, configEpoch, trustVersions, refs: [...refs.entries()].sort(([left],[right]) => left < right ? -1 : left > right ? 1 : 0).map(([,ref]) => ref) };
      return { ...manifest, digest: agentDependencyDigest({ ...manifest, executions, edges: Object.fromEntries(edges) }) };
    });
  }
}
