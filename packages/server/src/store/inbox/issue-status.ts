import type { CommitEventQueue, StoreContext } from '../context.js';
import { afterCommit } from '../db/postgres.js';
import { nowIso } from '@multiremi/ids.js';
import { questionMetadataText } from './question-indexes.js';

const PLAIN_JSON_ASCII_ID = /^[A-Za-z0-9_.:-]+$/;

function pendingTurnsHaveWorkTrigger(ctx: StoreContext, pendingTurns: any[], turns: any[]): boolean {
  if (pendingTurns.length === 0) return false;

  const coveredSeqFor = (pending: any): number => {
    let maxCovered = 0;
    const pendingSeq = Number(pending.seq ?? 0);
    for (const prev of turns) {
      if (
        prev.session_id !== pending.session_id
        || prev.agent_id !== pending.agent_id
        || prev.execution_scope !== pending.execution_scope
        || !['completed', 'failed', 'cancelled'].includes(prev.status)
        || Number(prev.seq ?? 0) >= pendingSeq
      ) {
        continue;
      }
      const prevInputTo = Number(prev.input_to_seq ?? 0);
      const prevCovered = prev.status === 'completed'
        ? prevInputTo
        : Math.max(prevInputTo, Number(prev.trigger_seq ?? 0));
      if (prevCovered > maxCovered) maxCovered = prevCovered;
    }
    return maxCovered;
  };

  const rows = pendingTurns.map((pending) => [
    String(pending.id),
    String(pending.session_id),
    String(pending.agent_id),
    String(pending.execution_scope ?? ''),
    coveredSeqFor(pending),
  ]);

  // Bind serialized JSON as TEXT first on PostgreSQL so Bun.SQL sends the raw
  // array string rather than encoding a JSONB string scalar.
  const pendingChecksCte = ctx.db.dialect === 'postgres'
    ? `SELECT
        batch.elem->>0 AS turn_id,
        batch.elem->>1 AS session_id,
        batch.elem->>2 AS agent_id,
        batch.elem->>3 AS execution_scope,
        (batch.elem->>4)::bigint AS covered_seq
      FROM jsonb_array_elements(CAST(CAST(? AS TEXT) AS JSONB)) AS batch(elem)`
    : `SELECT
        CAST(json_extract(value, '$[0]') AS TEXT) AS turn_id,
        CAST(json_extract(value, '$[1]') AS TEXT) AS session_id,
        CAST(json_extract(value, '$[2]') AS TEXT) AS agent_id,
        CAST(json_extract(value, '$[3]') AS TEXT) AS execution_scope,
        CAST(json_extract(value, '$[4]') AS INTEGER) AS covered_seq
      FROM json_each(?)`;

  const scopeSql = (alias: string) => ctx.db.dialect === 'postgres'
    ? `COALESCE(${alias}.metadata::jsonb->>'execution_scope','')`
    : `COALESCE(json_extract(${alias}.metadata,'$.execution_scope'),'')`;
  const workTriggerSql = (alias: string) =>
    `(${alias}.wake_reason IN ('human_sender','agent_dispatch') OR (${alias}.wake_reason='to_parent_owner' AND ${alias}.message_kind='request'))`;
  const allPlainAsciiTurnIds = pendingTurns.every((t) => PLAIN_JSON_ASCII_ID.test(String(t.id)));
  const exactDeliverySql = `${questionMetadataText(ctx.db, 'merged.metadata', 'delivery_turn_id')}=p.turn_id`;
  const deliveryMatchSql = ctx.db.dialect === 'postgres' && allPlainAsciiTurnIds
    ? `CASE WHEN strpos(merged.metadata,p.turn_id)>0 THEN ${exactDeliverySql} ELSE FALSE END`
    : exactDeliverySql;

  const hit = ctx.db.query(`WITH pending_checks AS (
      ${pendingChecksCte}
    )
    SELECT 1
    FROM pending_checks p
    LEFT JOIN multiremi_session_lanes sl
      ON sl.session_id=p.session_id AND sl.reader_type='agent' AND sl.reader_id=p.agent_id AND sl.execution_scope=p.execution_scope
    WHERE EXISTS (
      SELECT 1 FROM multiremi_conversation_log u
      WHERE u.session_id=p.session_id
        AND u.seq>(CASE WHEN p.covered_seq>COALESCE(sl.cursor_seq,0) THEN p.covered_seq ELSE COALESCE(sl.cursor_seq,0) END)
        AND u.kind='message' AND u.deleted_at IS NULL
        AND u.to_agent_id=p.agent_id AND u.wake_applied='now'
        AND ${scopeSql('u')}=p.execution_scope
        AND ${workTriggerSql('u')}
    ) OR EXISTS (
      SELECT 1 FROM multiremi_conversation_log merged
      WHERE merged.session_id=p.session_id
        AND merged.seq>p.covered_seq
        AND merged.kind='message' AND merged.deleted_at IS NULL
        AND ${workTriggerSql('merged')}
        AND ${deliveryMatchSql}
    )
    LIMIT 1`).get(JSON.stringify(rows));

  return Boolean(hit);
}

/** Only turns and unanswered owner decisions participate; attempts are deliberately absent. */
export function deriveIssueStatusWithinTransaction(ctx:StoreContext,issueId:string,events:CommitEventQueue): {changed:boolean;previousStatus:string|null} {
  if(!ctx.db.inTransaction)throw new Error('Issue derivation requires a transaction');
  if(!ctx.db.run('UPDATE multiremi_issues SET id=id WHERE id=?',[issueId]).changes)return {changed:false,previousStatus:null};
  const issue=ctx.issues().getIssue(issueId);
  if(!issue||['done','cancelled'].includes(issue.status))return {changed:false,previousStatus:issue?.status??null};
  const owner=ctx.resolveIssueResponsibility(issueId).executionOwner;
  const turns=ctx.db.query(`SELECT t.*,m.sender_type AS trigger_sender,m.wake_reason AS trigger_reason,m.message_kind AS trigger_kind,m.seq AS trigger_seq
    FROM multiremi_turns t LEFT JOIN multiremi_conversation_log m ON m.id=t.trigger_message_id
    LEFT JOIN multiremi_issue_sessions owned_session ON owned_session.id=t.session_id
    WHERE t.issue_id=? AND COALESCE(owned_session.chat_id,t.chat_session_id) IS NULL
      AND (owned_session.id IS NULL OR owned_session.issue_id=t.issue_id) ORDER BY t.created_at DESC,t.seq DESC,t.id DESC`).all(issueId);
  const active=turns.filter(t=>['running','awaiting_human','pending'].includes(t.status));
  const decision=owner?ctx.db.query(`SELECT 1 FROM multiremi_conversation_log d JOIN multiremi_issue_sessions s ON s.id=d.session_id
    WHERE s.issue_id=? AND s.chat_id IS NULL AND d.kind='message' AND d.message_kind='decision' AND d.sender_type='agent' AND d.sender_id=?
      AND d.deleted_at IS NULL AND d.resolved_at IS NULL AND NOT EXISTS(SELECT 1 FROM multiremi_conversation_log r
      WHERE r.reply_to_id=d.id AND r.message_kind='reply' AND r.deleted_at IS NULL) LIMIT 1`).get(issueId,owner.id):null;
  let status:string|null=null;
  let last=turns[0];
  // in_review means a human must act or read: a question at the human stage, or a finished round.
  const humanQuestion=!active.some(t=>t.status==='running')&&ctx.issues().countPendingIssueDecisions(issueId)>0;
  if(active.some(t=>t.status==='running'))status='in_progress';
  else if(humanQuestion)status='in_review';
  // A question still waiting on a Leader is execution, not review.
  else if(active.some(t=>t.status==='awaiting_human')||decision)status='in_progress';
  else if(active.some(t=>t.status==='pending')){
    const pendingTurns=active.filter(t=>t.status==='pending');
    const hasDirectWorkTrigger=pendingTurns.some(t=>t.trigger_sender==='member'||t.trigger_reason==='agent_dispatch'||(t.trigger_reason==='to_parent_owner'&&t.trigger_kind==='request')||['human_sender','agent_dispatch'].includes(t.wake_source));
    if(hasDirectWorkTrigger||pendingTurnsHaveWorkTrigger(ctx,pendingTurns,turns))status='todo';
  }else{
    // Intake completion belongs to the business round, including unassigned intake work.
    const latest=issue.issueKind==='intake'
      ? turns.toSorted((a,b)=>String(b.ended_at??b.created_at).localeCompare(String(a.ended_at??a.created_at)))[0]
      : turns.find(t=>t.agent_id===owner?.id);
    if(issue.issueKind==='intake')last=latest??last;
    status=latest?.status==='completed'?'in_review':latest?.status==='failed'?'blocked':latest?.status==='cancelled'?'todo':null;
    // A finished round derives only in_review; closing it follows the done rule.
  }
  if(!status)return {changed:false,previousStatus:issue.status};
  // A parent legitimately parks at in_review while a human answers, even with open children.
  status=ctx.issues().holdParentStatusForOpenChildren(issueId,status,{exempt:humanQuestion,deferredEvents:events});
  if(status===issue.status)return {changed:false,previousStatus:issue.status};
  const at=nowIso();
  const completedAt=status==='done'?at:null;
  ctx.db.run('UPDATE multiremi_issues SET status=?,completed_at=?,archived_at=NULL,updated_at=? WHERE id=?',[status,completedAt,at,issueId]);
  const updated=ctx.issues().getIssue(issueId)!;
  const actorId=issue.issueKind==='intake'?last?.agent_id??null:owner?.id??last?.agent_id??null;
  const {event,dependencyCheckEventId}=ctx.autopilots().enqueueIssueStatusChangedEvent({issue:updated,previousStatus:issue.status,
    actorType:'agent',actorId,automationSourceTaskId:last?.current_attempt_id??null});
  const changes:import('../repos/tasks-repo.js').ChildStatusChangeCollector=[];
  ctx.issues().notifyChildStatusChangeWithinTransaction(issue,updated,last?.current_attempt_id??'',changes,events,{statusChangeEventId:event?.id,taskTerminalStatus:['completed','failed','cancelled'].includes(last?.status)?last.status:undefined});
  if(last)changes.push({previous:issue,issue:updated,taskId:last.current_attempt_id,dependencyCheckEventId,taskTerminalStatus:['completed','failed','cancelled'].includes(last.status)?last.status:undefined});
  if(changes.length)afterCommit(ctx.db,()=>ctx.tasks().runCollectedChildStatusChanges(changes));
  events.workspace.push({type:'issue:updated',workspaceId:issue.workspaceId,actorType:'agent',actorId,
    payload:{issue:{id:issueId,status,completed_at:completedAt,archived_at:null,updated_at:at},status_changed:true,prev_status:issue.status}});
  return {changed:true,previousStatus:issue.status};
}
