import type { SqlDatabase } from './db/postgres.js';
import { parseJson } from './helpers.js';

export interface IssueSessionHistoryFact {
  fact_type: 'session' | 'rotation' | 'handoff';
  id: string;
  issue_id: string;
  workspace_id: string | null;
  parent_session_id: string | null;
  is_default: number | null;
  inherit_mode: string | null;
  head_workspace_id: string | null;
  data: string | null;
}

/** Only owner identities and immutable move receipts; never read conversation bodies. */
export function issueSessionHistoryFactsSql(requireHeads = true): string {
  return `SELECT 'session' AS fact_type, s.id, s.issue_id, s.workspace_id, s.parent_session_id,
      s.is_default, s.inherit_mode, ${requireHeads ? 'h.workspace_id' : 'NULL'} AS head_workspace_id,
      NULL AS data
    FROM multiremi_issue_sessions s
    ${requireHeads ? 'LEFT JOIN multiremi_conversation_heads h ON h.session_id = s.id' : ''}
    WHERE s.issue_id = ? AND s.chat_id IS NULL
    UNION ALL
    SELECT CASE WHEN a.type = 'issue_main_session_rotated' THEN 'rotation' ELSE 'handoff' END AS fact_type,
      a.id, a.issue_id, a.workspace_id, NULL AS parent_session_id,
      NULL AS is_default, NULL AS inherit_mode, NULL AS head_workspace_id, a.data
    FROM multiremi_issue_activity a
    WHERE a.issue_id = ? AND a.type IN ('issue_main_session_rotated', 'issue_session_owner_transferred')`;
}

export function auditedIssueSessionHistory(
  facts: readonly IssueSessionHistoryFact[],
  requireHeads = true,
): { historicalWorkspaceIds: Map<string, string>; retiredSessionIds: Set<string>; sourceWorkspaceIds: Set<string> } {
  const sessions = new Map(facts.filter(fact => fact.fact_type === 'session').map(fact => [fact.id, fact]));
  const historicalWorkspaceIds = new Map<string, string>();
  const retiredSessionIds = new Set<string>();
  const sourceWorkspaceIds = new Set<string>();
  const transferredMains = new Map<string, IssueSessionHistoryFact>();
  for (const fact of facts) {
    if (fact.fact_type !== 'handoff') continue;
    const data = parseJson<Record<string, unknown> | null>(fact.data, null);
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || typeof data.sessionId !== 'string' || !data.sessionId || typeof data.chatId !== 'string' || !data.chatId
      || data.sessionId === data.chatId || typeof data.issueId !== 'string' || data.issueId !== fact.issue_id
      || typeof data.workspaceId !== 'string' || !data.workspaceId || data.workspaceId !== fact.workspace_id
      || data.isDefault !== true || data.parentSessionId !== null || data.inheritMode !== 'none'
      || data.headWorkspaceId !== null && data.headWorkspaceId !== data.workspaceId) continue;

    // A live, explicitly transferred Main keeps this Issue audit even after
    // its Chat projection and private conversation have been deleted. It only
    // proves the rotation's target identity; it grants no Chat-body access.
    transferredMains.set(data.sessionId, { fact_type: 'session', id: data.sessionId, issue_id: data.issueId,
      workspace_id: data.workspaceId, parent_session_id: null, is_default: 0, inherit_mode: 'none',
      head_workspace_id: data.headWorkspaceId as string | null, data: null });
  }

  const validParent = (session: IssueSessionHistoryFact, permitted: Set<string>, checkHeads: boolean, visited = new Set<string>()): boolean => {
    if (visited.has(session.id) || !permitted.has(session.id)) return false;
    if (checkHeads && session.head_workspace_id !== session.workspace_id) return false;
    if (!session.parent_session_id) return true;

    visited.add(session.id);
    const parent = sessions.get(session.parent_session_id);
    return !!parent && parent.workspace_id === session.workspace_id && validParent(parent, permitted, checkHeads, visited);
  };

  for (const fact of facts) {
    if (fact.fact_type !== 'rotation') continue;
    const data = parseJson<Record<string, unknown> | null>(fact.data, null);
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    const { previousSessionId, sessionId, previousWorkspaceId, workspaceId } = data;
    if (typeof previousSessionId !== 'string' || typeof sessionId !== 'string'
      || typeof previousWorkspaceId !== 'string' || typeof workspaceId !== 'string'
      || !previousSessionId || !sessionId || !previousWorkspaceId || !workspaceId
      || previousSessionId === sessionId || previousWorkspaceId === workspaceId) continue;

    const previous = sessions.get(previousSessionId), next = sessions.get(sessionId) ?? transferredMains.get(sessionId);
    if (!previous || !next || previous.workspace_id !== previousWorkspaceId || next.workspace_id !== workspaceId
      || previous.issue_id !== fact.issue_id || next.issue_id !== fact.issue_id
      || Number(previous.is_default) !== 0 || previous.parent_session_id || next.parent_session_id
      || previous.inherit_mode !== 'none' || next.inherit_mode !== 'none'
      || fact.workspace_id !== null && fact.workspace_id !== workspaceId) continue;

    // This receipt proves a real move even when an old independent side
    // Session lacks the identity evidence needed to grant historical reads.
    // Migrations preserve that source workspace rather than invent ownership.
    sourceWorkspaceIds.add(previousWorkspaceId);
    retiredSessionIds.add(previousSessionId);
    // A move back to a workspace also retires any older Issue-owned Sessions
    // already there. This identity snapshot denies execution; it cannot prove
    // when an unknown legacy side was created or grant access to its body.
    const retiredTargetIds = data.retiredTargetSessionIds;
    if (Array.isArray(retiredTargetIds) && retiredTargetIds.every(id => typeof id === 'string' && id)
      && new Set(retiredTargetIds).size === retiredTargetIds.length && !retiredTargetIds.includes(sessionId)
      && retiredTargetIds.every(id => sessions.get(id)?.workspace_id === workspaceId
        && Number(sessions.get(id)?.is_default) === 0)) {
      for (const id of retiredTargetIds as string[]) retiredSessionIds.add(id);
    }

    const recordedIds = data.previousSessionIds;
    let permitted: Set<string>;
    if (recordedIds !== undefined) {
      if (!Array.isArray(recordedIds) || recordedIds.some(id => typeof id !== 'string' || !id)
        || new Set(recordedIds).size !== recordedIds.length || !recordedIds.includes(previousSessionId)
        || recordedIds.some(id => sessions.get(id)?.workspace_id !== previousWorkspaceId)) continue;
      permitted = new Set(recordedIds as string[]);
    } else {
      // Earlier receipts named only Main. A stored parent chain can prove a
      // side Session; timestamps and a matching workspace cannot prove one.
      permitted = new Set([previousSessionId]);
      for (let changed = true; changed;) {
        changed = false;
        for (const session of sessions.values()) {
          if (session.workspace_id === previousWorkspaceId && session.parent_session_id
            && permitted.has(session.parent_session_id) && !permitted.has(session.id)) {
            permitted.add(session.id);
            changed = true;
          }
        }
      }
    }

    for (const id of permitted) {
      const session = sessions.get(id)!;
      if (Number(session.is_default) !== 0 || !validParent(session, permitted, false)) continue;
      retiredSessionIds.add(id);
      if ((!requireHeads || previous.head_workspace_id === previousWorkspaceId
        && (next.head_workspace_id === null || next.head_workspace_id === workspaceId))
        && validParent(session, permitted, requireHeads)) {
        historicalWorkspaceIds.set(id, previousWorkspaceId);
      }
    }
  }

  return { historicalWorkspaceIds, retiredSessionIds, sourceWorkspaceIds };
}

export function readAuditedIssueSessionHistory(db: SqlDatabase, issueId: string, requireHeads = true) {
  const facts = db.query(issueSessionHistoryFactsSql(requireHeads)).all(issueId, issueId) as IssueSessionHistoryFact[];
  return auditedIssueSessionHistory(facts, requireHeads);
}
