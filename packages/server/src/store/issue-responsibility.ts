import { createHash } from 'node:crypto';
import type { IssueResponsibility, IssueResponsibleActor } from '@multiremi/contracts';
import type { StoreContext } from './context.js';
import { nullableString } from './helpers.js';

/** A refused execution-owner or done-rule decision; routes surface `code` with `status`. */
export class IssueResponsibilityError extends Error {
  constructor(public code: string, message: string, public status: 403 | 404 | 409 = 409) { super(message); }
}

type IssueFacts = { id: string; workspaceId: string; parentIssueId: string | null; assigneeType: string | null; assigneeId: string | null };
interface ResponsibilityReads {
  issue(id: string): IssueFacts | null;
  squad(id: string): { leaderId: string | null; workspaceId: string; archivedAt: string | null } | null;
  agent(id: string): { id: string; name: string; workspaceId: string; archivedAt: string | null } | null;
}

/** One read of the ancestor/owner graph; UNION terminates even a malformed parent cycle. */
export function resolveIssueResponsibilityInBatch(ctx: StoreContext, issueId: string): IssueResponsibility {
  const rows = ctx.db.query(`WITH RECURSIVE ancestors AS (
      SELECT id,workspace_id,parent_issue_id,assignee_type,assignee_id FROM multiremi_issues WHERE id=?
      UNION
      SELECT i.id,i.workspace_id,i.parent_issue_id,i.assignee_type,i.assignee_id
      FROM multiremi_issues i JOIN ancestors child ON child.parent_issue_id=i.id)
    SELECT i.*, s.id AS squad_id,s.workspace_id AS squad_workspace,s.leader_id,s.archived_at AS squad_archived,
      a.id AS agent_id,a.name AS agent_name,a.workspace_id AS agent_workspace,a.archived_at AS agent_archived
    FROM ancestors i LEFT JOIN multiremi_squads s ON i.assignee_type='squad' AND s.id=i.assignee_id
    LEFT JOIN multiremi_agents a ON a.id=CASE WHEN i.assignee_type='agent' THEN i.assignee_id
      WHEN i.assignee_type='squad' THEN s.leader_id ELSE NULL END`).all(issueId);
  const issues = new Map<string, IssueFacts>();
  const squads = new Map<string, NonNullable<ReturnType<ResponsibilityReads['squad']>>>();
  const agents = new Map<string, NonNullable<ReturnType<ResponsibilityReads['agent']>>>();
  for (const row of rows) {
    issues.set(row.id, { id: row.id, workspaceId: row.workspace_id, parentIssueId: row.parent_issue_id,
      assigneeType: row.assignee_type, assigneeId: row.assignee_id });
    if (row.squad_id) squads.set(row.squad_id, { workspaceId: String(row.squad_workspace ?? 'local'), leaderId: nullableString(row.leader_id), archivedAt: nullableString(row.squad_archived) });
    if (row.agent_id) agents.set(row.agent_id, { id: String(row.agent_id), name: String(row.agent_name), workspaceId: String(row.agent_workspace ?? 'local'), archivedAt: nullableString(row.agent_archived) });
  }
  return resolveIssueResponsibility(ctx, issueId, {
    issue: id => issues.get(id) ?? null, squad: id => squads.get(id) ?? null, agent: id => agents.get(id) ?? null,
  });
}

/** The only responsibility resolver: no sender-team, runnable-member or workspace-owner fallback, and no designated human. */
export function resolveIssueResponsibility(ctx: StoreContext, issueId: string, reads?: ResponsibilityReads): IssueResponsibility {
  const result: IssueResponsibility = { issueId, workspaceId: null, executionOwner: null, rootIssueId: null, chain: [], unresolved: [], revision: '' };
  const facts: unknown[] = [];
  const seen = new Set<string>();
  // Only current execution-owner facts participate. Labels, usage, prompts,
  // Agent Skills and the deprecated responsible_member_id column cannot change
  // the route or its revision.
  const readIssue = reads?.issue ?? ((id: string): IssueFacts | null => {
    const row = ctx.db.query('SELECT id,workspace_id,parent_issue_id,assignee_type,assignee_id FROM multiremi_issues WHERE id=?').get(id);
    return row ? { id: row.id, workspaceId: row.workspace_id, parentIssueId: row.parent_issue_id,
      assigneeType: row.assignee_type, assigneeId: row.assignee_id } : null;
  });
  let issue = readIssue(issueId);
  const fail = (id: string, reason: IssueResponsibility['unresolved'][number]['reason']) => result.unresolved.push({issueId: id, reason});
  const owner = (item: IssueFacts): IssueResponsibleActor | null => {
    let id: string | null = null;
    if (item.assigneeType === 'agent') id = item.assigneeId;
    else if (item.assigneeType === 'squad' && item.assigneeId) {
      const team = reads ? reads.squad(item.assigneeId) : ctx.squads().getSquad(item.assigneeId);
      facts.push(['team', item.assigneeId, team?.leaderId, team?.archivedAt]);
      if (!team || team.archivedAt || team.workspaceId !== item.workspaceId) { fail(item.id, 'team_unavailable'); return null; }
      id = team.leaderId;
      if (!id) { fail(item.id, 'leader_missing'); return null; }
    }
    if (!id) { fail(item.id, 'execution_owner_missing'); return null; }
    const agent = reads ? reads.agent(id) : ctx.agents().getAgentLite(id);
    facts.push(['agent', id, agent?.workspaceId, agent?.archivedAt]);
    if (!agent || agent.archivedAt || agent.workspaceId !== item.workspaceId) { fail(item.id, 'agent_unavailable'); return null; }
    return {type:'agent', id:agent.id, issueId:item.id, name:agent.name};
  };
  if (!issue) fail(issueId, 'issue_missing');
  while (issue) {
    if (seen.has(issue.id)) { fail(issue.id, 'parent_cycle'); break; }
    seen.add(issue.id);
    result.workspaceId ??= issue.workspaceId;
    if (issue.workspaceId !== result.workspaceId) { fail(issue.id, 'workspace_mismatch'); break; }
    facts.push(['issue', issue.id, issue.parentIssueId, issue.assigneeType, issue.assigneeId]);
    result.chain.push({issueId:issue.id, executionOwner:owner(issue)});
    if (!issue.parentIssueId) { result.rootIssueId = issue.id; break; }
    const parentId: string = issue.parentIssueId;
    issue = readIssue(parentId);
    if (!issue) fail(parentId, 'parent_missing');
  }
  result.executionOwner = result.chain[0]?.executionOwner ?? null;
  result.revision = createHash('sha256').update(JSON.stringify(facts)).digest('hex');
  return result;
}
