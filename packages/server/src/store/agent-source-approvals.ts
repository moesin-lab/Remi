import { createHash } from 'node:crypto';
import type { SqlDatabase } from './db/postgres.js';
import { agentDependencyDigest, type AgentDependencyRef } from './agent-dependencies.js';
import { SecurityAbort } from './security-write.js';

export interface AgentConfigurationApproval {
  readonly sources: readonly {
    ref: AgentDependencyRef; content: string; dependencies: readonly AgentDependencyRef[];
  }[];
  readonly executions: readonly {
    trustId: string; profileDigest: string; provider: AgentDependencyRef; checkpointPolicy: AgentDependencyRef; inputPolicy: AgentDependencyRef;
  }[];
}

export function executionTrustNodeId(grantId: string, trustId: string, reference: AgentDependencyRef): string {
  return agentDependencyDigest(['execution-trust-v1', grantId, trustId, reference]);
}

export function expandAgentSourceApprovals(db: SqlDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_agent_config_epochs (
    agent_id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, config_epoch INTEGER NOT NULL CHECK(config_epoch>=0),
    approval_node_id TEXT NOT NULL REFERENCES multiremi_authority_nodes(node_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_agent_source_snapshots (
    agent_id TEXT NOT NULL,workspace_id TEXT NOT NULL,config_epoch INTEGER NOT NULL,kind TEXT NOT NULL,resource_id TEXT NOT NULL,use_kind TEXT NOT NULL,
    resource_version INTEGER NOT NULL,digest TEXT NOT NULL,dependencies_json TEXT NOT NULL,
    PRIMARY KEY(agent_id,config_epoch,kind,resource_id,use_kind)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS multiremi_agent_execution_sources (
    agent_id TEXT NOT NULL,workspace_id TEXT NOT NULL,config_epoch INTEGER NOT NULL,runtime_id TEXT NOT NULL,trust_id TEXT NOT NULL,trust_generation INTEGER NOT NULL,
    incarnation TEXT NOT NULL,provider TEXT NOT NULL,profile_digest TEXT NOT NULL,provider_ref TEXT NOT NULL,checkpoint_policy_ref TEXT NOT NULL,input_policy_ref TEXT NOT NULL,
    PRIMARY KEY(agent_id,config_epoch,trust_id)
  )`);
  const view=db.dialect==='postgres'?'CREATE OR REPLACE VIEW':'CREATE VIEW IF NOT EXISTS';
  db.exec(`${view} multiremi_current_agent_config_epochs AS SELECT agent_id,workspace_id,config_epoch,approval_node_id FROM multiremi_agent_config_epochs`);
  db.exec(`${view} multiremi_current_agent_source_snapshots AS SELECT s.* FROM multiremi_agent_source_snapshots s JOIN multiremi_agent_config_epochs e
    ON e.agent_id=s.agent_id AND e.workspace_id=s.workspace_id AND e.config_epoch=s.config_epoch`);
  db.exec(`${view} multiremi_current_agent_execution_sources AS SELECT s.* FROM multiremi_agent_execution_sources s JOIN multiremi_agent_config_epochs e
    ON e.agent_id=s.agent_id AND e.workspace_id=s.workspace_id AND e.config_epoch=s.config_epoch`);
}

export function storeAgentConfigurationApproval(db: SqlDatabase, agentId: string, workspaceId: string, epoch: number, approval: AgentConfigurationApproval): void {
  if (!approval.sources.length || approval.sources.length>1024 || !approval.executions.length || approval.executions.length>1024) throw new SecurityAbort('root_required');
  const insert=db.query(`INSERT INTO multiremi_agent_source_snapshots(agent_id,workspace_id,config_epoch,kind,resource_id,use_kind,resource_version,digest,dependencies_json)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  for (const source of approval.sources) {
    const {ref,content,dependencies}=source;
    if (!ref.kind || !ref.id || !ref.use || !Number.isSafeInteger(ref.version) || ref.version<0 || typeof content!=='string' || dependencies.length>1024) throw new SecurityAbort('root_required');
    const digest=ref.kind==='plugin-version' ? `sha256:${createHash('sha256').update(content).digest('hex')}` : agentDependencyDigest(JSON.parse(content));
    if (ref.digest!==digest) throw new SecurityAbort('authority_revision_conflict');
    insert.run(agentId,workspaceId,epoch,ref.kind,ref.id,ref.use,ref.version,digest,JSON.stringify(dependencies));
  }
  for (const source of approval.executions) {
    const trusted=db.query(`SELECT t.runtime_id,t.generation,t.incarnation,r.provider FROM multiremi_runtime_trusts t JOIN multiremi_runtimes r ON r.id=t.runtime_id
      WHERE t.trust_id=? AND r.workspace_id=? AND t.revoked_at_ms IS NULL`).get(source.trustId,workspaceId);
    if (!trusted) throw new SecurityAbort('root_runtime_untrusted');
    db.query(`INSERT INTO multiremi_agent_execution_sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(agentId,workspaceId,epoch,trusted.runtime_id,source.trustId,trusted.generation,
      trusted.incarnation,trusted.provider,source.profileDigest,JSON.stringify(source.provider),JSON.stringify(source.checkpointPolicy),JSON.stringify(source.inputPolicy));
  }
}
