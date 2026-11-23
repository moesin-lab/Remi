import { memoizeRequestRead } from "../request-read-cache.js";
import { readTurnRow } from "@multiremi/store/execution-reads.js";
import { acquireTransactionLock } from '../request-read-cache.js';
import type { MessageHeader, SendMessageInput, SendMessageResult, UnifiedMessage } from '@multiremi/contracts/unified-model.js';
import { isHistoricalIssueQuestionRecord } from '@multiremi/contracts';
import type { CreateTaskInput } from '@multiremi/contracts/types.js';
import type { CommitEventQueue, StoreContext } from '../context.js';
import { createId, nowIso } from '@multiremi/ids.js';
import { clampEnvelopeBody } from '../envelope-body.js';
import { countDelegationPairHops, pairRoundTripLimit, DelegationRoundTripLimitError, type TaskSessionContinuation } from '../repos/tasks-repo.js';
import { resolveWake } from './wake-policy.js';
import { deriveIssueStatusWithinTransaction } from './issue-status.js';
import { questionMetadataText } from './question-indexes.js';
import { lockLane } from './lane-machine.js';
import { deliverToRunningTurn, ensurePendingTurn } from './lane-machine.js';
import { dependencyGateEnabled } from '../repos/issue-dependencies.js';
import { parseJson } from '../helpers.js';
import { toConversationLogEntry } from '../repos/conversation-log-repo.js';
import type { MultiremiAgent } from '@multiremi/contracts/types.js';
import { afterCommit } from '../db/postgres.js';

export function getMessage(ctx:StoreContext,id:string):UnifiedMessage|null {
  const row=memoizeRequestRead(ctx.db, ['multiremi_conversation_log'], `message-row:${id}`,
    () => ctx.db.query("SELECT * FROM multiremi_conversation_log WHERE id=? AND kind='message'").get(id));
  return row ? messageFromRow(row) : null;
}

/**
 * Messages per batched read. Rows are whole messages (body and metadata), and a
 * PostgreSQL result crosses the synchronous bridge as one reply, so batches stay
 * small like the turn-card reads.
 */
const MESSAGE_BATCH_SIZE = 50;

/** {@link getMessage} for many ids, keyed by id. Ids without a message row are absent. */
export function getMessages(ctx:StoreContext,ids:readonly string[]):Map<string,UnifiedMessage> {
  const result=new Map<string,UnifiedMessage>();
  const unique=[...new Set(ids.filter(Boolean))];
  for(let offset=0;offset<unique.length;offset+=MESSAGE_BATCH_SIZE){
    const batch=unique.slice(offset,offset+MESSAGE_BATCH_SIZE);
    for(const row of ctx.db.query(`SELECT * FROM multiremi_conversation_log WHERE id IN (${batch.map(()=>'?').join(',')}) AND kind='message'`).all(...batch) as Record<string,any>[])
      result.set(String(row.id),messageFromRow(row));
  }
  return result;
}

export function messageFromRow(row: Record<string, any>): UnifiedMessage {
  const entry=toConversationLogEntry(row);
  const {author_type,author_id,parent_id,...base}=entry;
  return {...base,metadata:parseJson(row.metadata,{}),kind:'message',sender_type:row.sender_type,sender_id:row.sender_id,
    to_type:row.to_type,to_ref:row.to_ref,to_agent_id:row.to_agent_id,to_member_id:row.to_member_id,
    message_kind:row.message_kind,wake_requested:row.wake_requested,wake_applied:row.wake_applied,wake_reason:row.wake_reason,
    reply_to_id:row.reply_to_id,dedupe_key:row.dedupe_key,options:parseJson(row.options,null),
    card_token_hash:row.card_token_hash,card_token_recipient:row.card_token_recipient,card_token_consumed_at:row.card_token_consumed_at};
}

const PLAIN_JSON_ASCII_ID = /^[A-Za-z0-9_.:-]+$/;

function deliveryTurnMatchSql(ctx: StoreContext, column: string, turnId: string): { sql: string; params: string[] } {
  const exact = `${questionMetadataText(ctx.db, column, 'delivery_turn_id')}=?`;
  if (ctx.db.dialect === 'postgres' && PLAIN_JSON_ASCII_ID.test(turnId)) {
    return {
      sql: `CASE WHEN strpos(${column},?)>0 THEN ${exact} ELSE FALSE END`,
      params: [turnId, turnId],
    };
  }
  return { sql: exact, params: [turnId] };
}

export function countMessageDelegationPairHops(ctx:StoreContext,sourceId:string,targetId:string,limit=pairRoundTripLimit()):number {
  const source=readTurnRow(ctx.db, sourceId);
  if(!source)return 0;
  const lastMember=ctx.db.query(`SELECT id, seq, created_at FROM multiremi_conversation_log
    WHERE session_id=? AND kind='message' AND sender_type='member' AND deleted_at IS NULL
    ORDER BY seq DESC LIMIT 1`).get(source.session_id) as { id: string; seq: number; created_at: string } | null;

  interface HopStep {
    turnId: string;
    beforeCreatedAt: string | null;
    beforeSessionId: string | null;
    beforeSessionSeq: number | null;
    excludeTaskId: string | null;
  }
  const steps = new Map<string, HopStep>();
  let stepSeq = 0;
  const enqueueStep = (
    turnId: string | null,
    beforeCreatedAt: string | null,
    beforeSessionId: string | null,
    beforeSessionSeq: number | null,
    excludeTaskId: string | null,
  ): string | null => {
    if (!turnId) return null;
    const key = `step:${++stepSeq}`;
    steps.set(key, { turnId, beforeCreatedAt, beforeSessionId, beforeSessionSeq, excludeTaskId });
    return key;
  };
  const prevReqSeqByTurn = new Map<string, number>();

  const findParentRequestTrigger = (
    turn: any,
    counterpart: string,
    step: HopStep,
  ): { id: string; session_id: string; seq: number; created_at: string; task_id: string; sender_id: string; metadata: string | null } | null => {
    const clauses: string[] = [
      'session_id=?',
      "kind='message'",
      'deleted_at IS NULL',
      "sender_type='agent'",
      'sender_id=?',
      'to_agent_id=?',
      "wake_applied='now'",
      "wake_reason='to_parent_owner'",
      "message_kind='request'",
      'task_id IS NOT NULL',
      'task_id<>?',
    ];
    const params: Array<string | number> = [turn.session_id, counterpart, turn.agent_id, turn.id];

    if (step.excludeTaskId) {
      clauses.push('task_id<>?');
      params.push(step.excludeTaskId);
    }
    const prevReqSeq = prevReqSeqByTurn.get(turn.id);
    if (prevReqSeq !== undefined) {
      clauses.push('seq<?');
      params.push(prevReqSeq);
    }
    if (step.beforeSessionId === turn.session_id && step.beforeSessionSeq !== null) {
      clauses.push('seq<=?');
      params.push(step.beforeSessionSeq);
    } else if (step.beforeCreatedAt !== null) {
      clauses.push('created_at<=?');
      params.push(step.beforeCreatedAt);
    }
    if (lastMember) {
      if (turn.session_id === source.session_id) {
        clauses.push('seq>?');
        params.push(Number(lastMember.seq));
      } else {
        clauses.push('created_at>=?');
        params.push(lastMember.created_at);
      }
    }

    const matchBranches: string[] = [];
    const matchParams: Array<string | number> = [];
    if (turn.trigger_message_id) {
      matchBranches.push('id=?');
      matchParams.push(turn.trigger_message_id);
    }
    const delivery = deliveryTurnMatchSql(ctx, 'metadata', turn.id);
    matchBranches.push(delivery.sql);
    matchParams.push(...delivery.params);

    const covered = ctx.db.query(`SELECT MAX(
        CASE
          WHEN prev.status='completed' THEN COALESCE(prev.input_to_seq,0)
          WHEN COALESCE(prev.input_to_seq,0)>COALESCE(prev_m.seq,0) THEN COALESCE(prev.input_to_seq,0)
          ELSE COALESCE(prev_m.seq,0)
        END
      ) AS seq
      FROM multiremi_turns prev
      LEFT JOIN multiremi_conversation_log prev_m ON prev_m.id=prev.trigger_message_id
      WHERE prev.session_id=? AND prev.agent_id=? AND prev.execution_scope=?
        AND prev.status IN ('completed','failed','cancelled') AND prev.seq<?`)
      .get(turn.session_id, turn.agent_id, turn.execution_scope, turn.seq);
    const priorCoveredSeq = Number(covered?.seq ?? 0);
    let floorSeq = Math.max(priorCoveredSeq, turn.input_from_seq != null ? Number(turn.input_from_seq) : 0);
    if (turn.status === 'pending') {
      const lane = ctx.db.query(`SELECT cursor_seq FROM multiremi_session_lanes
        WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=?`)
        .get(turn.session_id, turn.agent_id, turn.execution_scope);
      floorSeq = Math.max(floorSeq, Number(lane?.cursor_seq ?? 0));
    }
    const ceilSeq = Math.max(Number(turn.input_to_seq ?? 0), Number(turn.wake_seq ?? 0));
    if (ceilSeq > floorSeq) {
      const scopeSql = ctx.db.dialect === 'postgres'
        ? "COALESCE(metadata::jsonb->>'execution_scope','')"
        : "COALESCE(json_extract(metadata,'$.execution_scope'),'')";
      matchBranches.push(`(seq>? AND seq<=? AND ${scopeSql}=?)`);
      matchParams.push(floorSeq, ceilSeq, turn.execution_scope);
    }

    clauses.push(`(${matchBranches.join(' OR ')})`);
    params.push(...matchParams);

    const row = (ctx.db.query(`SELECT id, session_id, seq, created_at, task_id, sender_id, metadata
      FROM multiremi_conversation_log
      WHERE ${clauses.join(' AND ')}
      ORDER BY seq DESC LIMIT 1`).get(...params) as {
        id: string; session_id: string; seq: number; created_at: string; task_id: string; sender_id: string; metadata: string | null;
      } | null) ?? null;
    if (row && lastMember && turn.session_id !== source.session_id) {
      const reqMeta = parseJson(row.metadata, {}) as Record<string, unknown>;
      if (
        reqMeta.source_session_id === source.session_id
        && typeof reqMeta.source_session_seq === 'number'
        && reqMeta.source_session_seq < Number(lastMember.seq)
      ) {
        return null;
      }
    }
    return row;
  };

  const resolveNode = (step: HopStep) => {
    const turn = readTurnRow(ctx.db, step.turnId);
    if (!turn) return null;
    const trigger = turn.trigger_message_id
      ? ctx.db.query('SELECT id, session_id, seq, created_at, task_id, metadata FROM multiremi_conversation_log WHERE id=?').get(turn.trigger_message_id) as {
          id: string; session_id: string; seq: number; created_at: string; task_id: string | null; metadata: string | null;
        } | null
      : null;
    const trigMeta = trigger ? parseJson(trigger.metadata, {}) as Record<string, unknown> : {};
    const trigSrcSession = typeof trigMeta.source_session_id === 'string'
      ? trigMeta.source_session_id
      : (trigger?.session_id ?? null);
    const trigSrcSeq = typeof trigMeta.source_session_seq === 'number'
      ? trigMeta.source_session_seq
      : (trigger ? Number(trigger.seq) : null);

    if (turn.delegation_id && turn.delegated_by_agent_id) {
      if (lastMember) {
        if (turn.session_id === source.session_id) {
          if (trigger && trigger.session_id === source.session_id) {
            if (Number(trigger.seq) <= Number(lastMember.seq)) return null;
          } else if (turn.created_at <= lastMember.created_at) {
            return null;
          }
        } else if (trigSrcSession === source.session_id && trigSrcSeq !== null) {
          if (trigSrcSeq < Number(lastMember.seq)) return null;
        } else if (turn.created_at < lastMember.created_at) {
          return null;
        }
      }
      return {
        id: turn.id,
        agentId: turn.agent_id,
        workspaceId: turn.workspace_id,
        createdAt: turn.created_at,
        delegationId: turn.delegation_id,
        delegatedByAgentId: turn.delegated_by_agent_id,
        parentTaskId: enqueueStep(trigger?.task_id ?? null, trigger?.created_at ?? null, trigSrcSession, trigSrcSeq, turn.id),
      };
    }

    if (!turn.delegation_id && !turn.delegated_by_agent_id) {
      const counterpart = turn.agent_id === source.agent_id ? targetId : source.agent_id;
      const parentReq = counterpart ? findParentRequestTrigger(turn, counterpart, step) : null;
      if (parentReq) {
        prevReqSeqByTurn.set(turn.id, Number(parentReq.seq));
        const reqMeta = parseJson(parentReq.metadata, {}) as Record<string, unknown>;
        const reqSrcSession = typeof reqMeta.source_session_id === 'string'
          ? reqMeta.source_session_id
          : parentReq.session_id;
        const reqSrcSeq = typeof reqMeta.source_session_seq === 'number'
          ? reqMeta.source_session_seq
          : Number(parentReq.seq);
        return {
          id: `parent_req:${parentReq.id}`,
          agentId: turn.agent_id,
          workspaceId: turn.workspace_id,
          createdAt: parentReq.created_at,
          delegationId: `parent_req:${parentReq.id}`,
          delegatedByAgentId: parentReq.sender_id,
          parentTaskId: enqueueStep(parentReq.task_id, parentReq.created_at, reqSrcSession, reqSrcSeq, turn.id),
        };
      }
    }

    return {
      id: turn.id,
      agentId: turn.agent_id,
      workspaceId: turn.workspace_id,
      createdAt: turn.created_at,
      delegationId: turn.delegation_id ?? null,
      delegatedByAgentId: turn.delegated_by_agent_id ?? null,
      parentTaskId: enqueueStep(trigger?.task_id ?? null, trigger?.created_at ?? null, trigSrcSession, trigSrcSeq, turn.id),
    };
  };

  const initialNode = resolveNode({ turnId: source.id, beforeCreatedAt: null, beforeSessionId: null, beforeSessionSeq: null, excludeTaskId: null });
  if (!initialNode) return 0;
  return countDelegationPairHops(
    initialNode,
    targetId,
    (stepKey) => {
      const step = steps.get(stepKey);
      return step ? resolveNode(step) : null;
    },
    null,
    2 * limit,
  );
}

export function sendMessageWithinTransaction(ctx:StoreContext,input:SendMessageInput,events:CommitEventQueue,
  createInput:Partial<CreateTaskInput>={}, authorizeRecipient?:(agent:MultiremiAgent)=>void, authorizeConversation?:(sessionId:string,targetAgent:MultiremiAgent|null)=>void, continuation?:TaskSessionContinuation):SendMessageResult {
  if(!ctx.db.inTransaction)throw new Error('sendMessageWithinTransaction requires a transaction');
  let sessionId=input.session_id;
  const originalSession=ctx.issueSessions().getIssueSession(sessionId);
  const originalChat=ctx.chat().getChatSession(sessionId);
  const auto=memoizeRequestRead(ctx.db, ['multiremi_autopilots'], `autopilot-workspace:${sessionId}`,
    () => ctx.db.query('SELECT workspace_id FROM multiremi_autopilots WHERE session_id=?').get(sessionId));
  const workspaceId=originalSession?.workspaceId??originalChat?.workspaceId??auto?.workspace_id
    ??ctx.db.query('SELECT workspace_id FROM multiremi_conversation_heads WHERE session_id=?').get(sessionId)?.workspace_id
    ??ctx.db.query('SELECT workspace_id FROM multiremi_turns WHERE session_id=? LIMIT 1').get(sessionId)?.workspace_id
    ??(sessionId.startsWith('auto_orphan_')&&createInput.id?createInput.workspaceId:null);
  if(!workspaceId)throw new Error('Message conversation not found');
  ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
  if (originalSession) {
    const current = ctx.issueSessions().getIssueSessionWithOwnerScope(sessionId);
    if (!current || current.ownerWorkspaceId !== workspaceId || current.session.workspaceId !== workspaceId) {
      throw new Error("Message conversation owner not found in this workspace");
    }
  }
  const existing=input.id?getMessage(ctx,input.id):null;
  // Adding a recipient to an existing comment must preserve its reply link.
  if(existing && input.reply_to_id===undefined)input={...input,reply_to_id:existing.reply_to_id};
  const issue=originalSession && !originalSession.chatId && originalSession.issueId ? ctx.issues().getIssue(originalSession.issueId) : null;
  let source=input.source_turn_id?readTurnRow(ctx.db, input.source_turn_id):null;
  if(input.source_turn_id&&!source)throw new Error('Source turn not found');
  if(source&&(source.workspace_id!==workspaceId||input.sender.type==='agent'&&source.agent_id!==input.sender.id))throw new Error('Source turn does not belong to the sender workspace');
  if(input.sender.type==='agent'){
    const sender=ctx.agents().getAgent(input.sender.id??'');
    if(!sender||sender.workspaceId!==workspaceId)throw new Error('Message sender belongs to another workspace');
  } else if(input.sender.type==='member'&&input.sender.id!==null){
    const sender=ctx.workspaces().getWorkspaceMember(input.sender.id??'');
    if(!sender||sender.workspaceId!==workspaceId||sender.archivedAt)throw new Error('Message sender is not an active workspace member');
  }
  const reply=input.reply_to_id?getMessage(ctx,input.reply_to_id):null;
  if(input.reply_to_id&&(!reply||reply.session_id!==input.session_id))throw new Error('Reply target must be a message in this conversation');
  let recipientType:'agent'|'member'|'none'='none',recipientId:string|null=null;
  let targetIssue=issue;
  let roleScope:string|undefined;
  // A role reaches only the Issue's execution owner. Without one the message stays
  // readable without a recipient; it never falls back to a guessed person.
  const owner=(ownerIssue:typeof issue)=>{
    if(!ownerIssue)return;
    const responsibility=ctx.resolveIssueResponsibility(ownerIssue.id);
    if(responsibility.executionOwner){recipientType='agent';recipientId=responsibility.executionOwner.id;return;}
    recipientType='none';recipientId=null;
    input={...input,metadata:{...input.metadata,responsibility_unresolved:responsibility.unresolved}};
  };
  if(input.to.type==='agent'||input.to.type==='member'){recipientType=input.to.type;recipientId=input.to.ref;}
  else if(input.to.type==='role'){
    if(input.to.ref==='issue_owner')owner(issue ?? (originalSession?.issueId ? ctx.issues().getIssue(originalSession.issueId) : null));
    else if(input.to.ref==='parent_owner'){
      targetIssue=issue?.parentIssueId?ctx.issues().getIssue(issue.parentIssueId):null;
      if(!targetIssue||targetIssue.workspaceId!==workspaceId)throw new Error('Parent issue not found');
      owner(targetIssue);
      sessionId=ctx.issueSessions().getOrCreateDefaultIssueSessionWithinTransaction(targetIssue.id).id;
    } else if(input.to.ref==='delegator'){
      const dispatch=source?.trigger_message_id?getMessage(ctx,source.trigger_message_id):null;
      const origin=dispatch?.task_id?readTurnRow(ctx.db, dispatch.task_id):null;
      const delegator=reply?.sender_type==='agent'?reply.sender_id:dispatch?.sender_type==='agent'?dispatch.sender_id:source?.delegated_by_agent_id;
      if(delegator){recipientType='agent';recipientId=delegator;
        sessionId=origin&&origin.agent_id===delegator?origin.session_id:source?.delegated_from_issue_session_id??sessionId;
        roleScope=origin&&origin.agent_id===delegator?origin.execution_scope:undefined;
        const returnSession=ctx.issueSessions().getIssueSession(sessionId);targetIssue=returnSession && !returnSession.chatId && returnSession.issueId ? ctx.issues().getIssue(returnSession.issueId) : null;}

    } else if(input.to.ref==='leader'){
      owner(issue);
    } else if(input.to.ref==='relay'){recipientType='agent';recipientId=originalChat?.agentId??null;}
  }
  if(sessionId!==input.session_id||input.to.type==='role'&&input.to.ref==='parent_owner'){
    const finalSession=ctx.issueSessions().getIssueSession(sessionId);
    const finalChat=ctx.chat().getChatSession(sessionId);
    const finalWorkspace=finalSession?.workspaceId??finalChat?.workspaceId
      ??ctx.db.query('SELECT workspace_id FROM multiremi_autopilots WHERE session_id=?').get(sessionId)?.workspace_id
      ??ctx.db.query('SELECT workspace_id FROM multiremi_conversation_heads WHERE session_id=?').get(sessionId)?.workspace_id;
    if(finalWorkspace!==workspaceId||targetIssue&&targetIssue.workspaceId!==workspaceId
      ||finalSession && (finalSession.chatId ? ctx.chat().getChatSession(finalSession.chatId)?.workspaceId : finalSession.issueId ? ctx.issues().getIssue(finalSession.issueId)?.workspaceId : null)!==workspaceId)throw new Error('Message conversation not found');
  }
  const targetAgent=recipientType==='agent'&&recipientId?ctx.agents().getAgent(recipientId):null;
  const member=recipientType==='member'&&recipientId?ctx.workspaces().getWorkspaceMember(recipientId):null;
  if(targetAgent&&targetAgent.workspaceId!==workspaceId||member&&member.workspaceId!==workspaceId)throw new Error('Message recipient belongs to another workspace');
  if(targetAgent)authorizeRecipient?.(targetAgent);
  authorizeConversation?.(sessionId,targetAgent);
  // Serializing before dedupe makes a repeated message an idempotent result across PG instances.
  const table=originalSession||sessionId.startsWith('ises_')?'multiremi_issue_sessions':originalChat?'multiremi_chat_sessions':null;
  if(table)acquireTransactionLock(ctx.db, `${table==='multiremi_issue_sessions'?'session':'chat'}:${sessionId}`,
    () => { ctx.db.run(`UPDATE ${table} SET updated_at=updated_at WHERE id=?`,[sessionId]); });
  if(!ctx.conversationLog().getConversationLogHead(sessionId))ctx.conversationLog().ensureConversationLogHead(sessionId,{bodyMd:''});
  ctx.db.run('UPDATE multiremi_conversation_heads SET workspace_id=COALESCE(workspace_id,?),updated_at=updated_at WHERE session_id=?',[workspaceId,sessionId]);
  const duplicate=input.dedupe_key?ctx.db.query('SELECT id FROM multiremi_conversation_log WHERE session_id=? AND dedupe_key=?').get(sessionId,input.dedupe_key):null;
  if(duplicate){const message=getMessage(ctx,duplicate.id)!;const delivery=message.metadata.delivery_turn_id;
    const turn=ctx.db.query('SELECT id FROM multiremi_turns WHERE id=? OR trigger_message_id=?').get(typeof delivery==='string'?delivery:null,message.id);
    return {message,wake_applied:message.wake_applied,wake_reason:message.wake_reason,...(turn?{turn_id:turn.id}:{})};}
  // A person or timer writing into an archived Chat reopens it in the same transaction as the message.
  if(originalChat?.status==='archived'&&sessionId===input.session_id&&(input.sender.type==='member'||input.sender.type==='timer')){
    ctx.db.run("UPDATE multiremi_chat_sessions SET status='active',updated_at=? WHERE id=? AND status='archived'",[nowIso(),sessionId]);
    const reopened=ctx.chat().getChatSession(sessionId)!;
    ctx.emitChatEvent(reopened,'chat:session_updated',{title:reopened.title,status:reopened.status,pinned:reopened.pinned,
      project_id:reopened.projectId,updated_at:reopened.updatedAt});
  }
  const decisionTurn=input.message_kind==='reply'&&reply?.message_kind==='decision'&&reply.task_id
    ?ctx.db.query("SELECT * FROM multiremi_turns WHERE id=? AND status IN ('running','awaiting_human')").get(reply.task_id):null;
  const unmet=dependencyGateEnabled()&&targetIssue?.status==='backlog'?ctx.issues().listUnmetPrerequisites(targetIssue.id):[];
  let force=createInput.dependencyForce??createInput.dependency_force;
  if (!force && unmet.length && input.sender.type === 'member' && recipientType === 'agent' && policyWantsWork(input) && targetIssue) {
    const mention = /mention:\/\/(agent|squad)\/([^\s)]+)/.exec(input.body_md);
    const mentionedAgent = mention?.[1] === 'squad' ? ctx.squads().getSquad(mention[2]!)?.leaderId : mention?.[2];
    const actor = ctx.workspaces().getWorkspaceMember(input.sender.id!);
    force = { source: mentionedAgent === recipientId ? 'mention' : 'comment', actorMemberId: actor?.userId ?? input.sender.id! };
    createInput = { ...createInput, dependencyForce: force };
  }
  const sourceSession=source?ctx.issueSessions().getIssueSession(source.session_id):null;
  // A Chat-owned Session may project an Issue for coordination. That allows an
  // explicit dispatch on its private axis without participating in Issue status.
  const finalSession = ctx.issueSessions().getIssueSession(sessionId);
  const dispatchIssue = targetIssue ?? (finalSession?.chatId && finalSession.issueId
    ? ctx.issues().getIssue(finalSession.issueId) : null);
  const limit=pairRoundTripLimit();
  const hops=source&&recipientId?countMessageDelegationPairHops(ctx,source.id,recipientId,limit):0;
  const isLeader=recipientId&&input.sender.id?!!ctx.db.query(`SELECT 1 FROM multiremi_squads s JOIN multiremi_squad_members m ON m.squad_id=s.id
    WHERE s.leader_id=? AND m.member_id=? AND m.member_type='agent' AND s.workspace_id=? AND s.archived_at IS NULL`).get(recipientId,input.sender.id,workspaceId):false;
  // The direct parent's execution owner, whatever the rest of the chain resolves to.
  const parentAgent=issue?ctx.resolveIssueResponsibility(issue.id).chain[1]?.executionOwner??null:null;
  // Recognize a descendant Issue agent sending a request to an ancestor Issue's
  // default coordination session so it stays on the parent's default lane.
  const ancestorParentAgent=input.sender.type==='agent'&&input.message_kind==='request'&&recipientType==='agent'&&recipientId
    &&source?.issue_id&&dispatchIssue&&source.issue_id!==dispatchIssue.id
    &&finalSession&&!finalSession.chatId&&finalSession.isDefault&&finalSession.issueId===dispatchIssue.id
    &&!input.execution_scope&&!roleScope&&!(input.to.type==='role'&&input.to.ref==='delegator')
    ?ctx.resolveIssueResponsibility(source.issue_id).chain.slice(1)
        .find((node)=>node.issueId===dispatchIssue.id)?.executionOwner??null
    :null;
  const isParentOwner=input.message_kind==='request'
    ?Boolean(recipientType==='agent'&&recipientId&&ancestorParentAgent?.id===recipientId)
    :parentAgent?.id===recipientId;
  const policy=resolveWake(input.sender,input.to,input.wake_requested,input.message_kind,{
    recipientType,recipientId,recipientAvailable:recipientType==='agent'?!!targetAgent&&!targetAgent.archivedAt:recipientType==='member'?!!member&&!member.archivedAt:false,
    // Structural platform reports retain main's dependency exemption. Agent
    // requests still downgrade, and HTTP callers cannot supply a platform sender.
    dependenciesMet:input.sender.type==='platform'||!!force||unmet.length===0,
    sourceSideSession:!!sourceSession&&sourceSession.inheritMode!=='none',sourceHasIssue:input.sender.type==='agent'?!!source?.issue_id:undefined,
    targetHasIssue:!!dispatchIssue,pairHops:hops,pairLimit:limit,
    isReplyToDelegator:reply?.sender_type==='agent'&&reply.sender_id===recipientId||source?.delegated_by_agent_id===recipientId,isLeader:!!isLeader,isParentOwner,
  });
  const header:MessageHeader={sender_type:input.sender.type,sender_id:input.sender.id,to_type:input.to.type,
    to_ref:input.to.type==='none'?null:input.to.ref,to_agent_id:recipientType==='agent'?recipientId:null,to_member_id:recipientType==='member'?recipientId:null,
    message_kind:input.message_kind,wake_requested:input.wake_requested,wake_applied:policy.applied,wake_reason:policy.reason,
    reply_to_id:sessionId===input.session_id?input.reply_to_id??null:null,dedupe_key:input.dedupe_key??null,options:input.options??null,
    card_token_hash:null,card_token_recipient:null,card_token_consumed_at:null};
  const body=input.sender.type==='platform'&&['status','report'].includes(input.message_kind)?clampEnvelopeBody(input.body_md):input.body_md;
  let scope=decisionTurn?.execution_scope??input.execution_scope??roleScope??'';
  let delegatedLane:any=null;
  if(policy.reason==='agent_dispatch'&&source&&sourceSession&&dispatchIssue){
    delegatedLane=ctx.db.query(`SELECT * FROM multiremi_turns WHERE issue_id=? AND session_id=? AND agent_id=?
      AND delegated_by_agent_id=? AND delegated_from_issue_session_id=? ORDER BY created_at DESC,id DESC LIMIT 1`)
      .get(dispatchIssue.id,sessionId,recipientId,input.sender.id,source.session_id);
    scope=input.execution_scope??delegatedLane?.execution_scope??createInput.delegationId??createId('dlg');
  }
  // Freeze the resolved scope in the initial row; an insert followed by a scope patch
  // can let Hub observers see the patch before the new message itself.
  const metadata:Record<string,any>={...input.metadata,execution_scope:scope};
  if (
    input.sender.type === 'agent'
    && input.message_kind === 'request'
    && source
    && source.session_id !== sessionId
    && (policy.reason === 'agent_dispatch' || policy.reason === 'to_parent_owner')
  ) {
    metadata.source_session_id = source.session_id;
    metadata.source_session_seq = Number(ctx.conversationLog().getConversationLogHead(source.session_id)?.headSeq ?? 0);
  }
  if(input.message_kind==='decision'){
    const key=metadata.human_request?'human_request':metadata.question?'question':isHistoricalIssueQuestionRecord(metadata.decision_record)?'decision_record':'message_choice';
    metadata[key]={status:'pending',...(metadata[key] as object)};
  }
  if(existing&&(existing.session_id!==sessionId||existing.sender_type!==input.sender.type||existing.sender_id!==input.sender.id))throw new Error('Cannot readdress a message owned by another sender');
  let entry;
  if(existing){
    if(existing.to_agent_id&&existing.to_agent_id!==recipientId)throw new Error('A routed message cannot change recipient');
    ctx.db.run(`UPDATE multiremi_conversation_log SET to_type=?,to_ref=?,to_agent_id=?,to_member_id=?,message_kind=?,reply_to_id=?,
      wake_requested=?,wake_applied=?,wake_reason=?,dedupe_key=?,options=?,task_id=COALESCE(?,task_id) WHERE id=?`,
      [header.to_type,header.to_ref,header.to_agent_id,header.to_member_id,header.message_kind,header.reply_to_id,header.wake_requested,header.wake_applied,header.wake_reason,
        header.dedupe_key,header.options?JSON.stringify(header.options):null,source?.id??null,existing.id]);
    ctx.conversationLog().updateConversationLogWithinTransaction(sessionId,existing.seq,{deferEmit:true,fields:{metadata:{...existing.metadata,...metadata,pending_completion:false}}});
    ctx.db.run("UPDATE multiremi_conversation_log SET visibility='shown' WHERE id=?",[existing.id]);
    entry=ctx.conversationLog().getConversationLogEntryById(existing.id)!;
  }else{
  entry=ctx.conversationLog().appendWithinTransaction({sessionId,id:input.id??createId(sessionId.startsWith('ises_')?'cmt':'msg'),kind:'message',authorType:input.sender.type,
    authorId:input.sender.id,taskId:source?.id??null,bodyMd:body,parentId:header.reply_to_id,messageHeader:header,visibility:input.visibility,deferEmit:true,
    metadata:{...metadata,...(input.execution_scope?{execution_scope:input.execution_scope}:{})}});
  }
  let message=getMessage(ctx,entry.id)!;
  ctx.conversationLog().publishMessageWithinTransaction(sessionId,message.seq,Boolean(existing && existing.visibility === "shown"));
  if(recipientType==='member'&&recipientId){
    const at=entry.created_at;
    ctx.db.run(`INSERT INTO multiremi_session_lanes(session_id,reader_type,reader_id,execution_scope,created_at,updated_at)
      VALUES(?,'member',?,'',?,?) ON CONFLICT DO NOTHING`,[sessionId,recipientId,at,at]);
  }
  if(input.attachment_ids?.length){
    for(const id of input.attachment_ids){const attachment=ctx.issues().getAttachment(id);
      if(!attachment||attachment.workspaceId!==workspaceId)throw new Error('Attachment belongs to another workspace');
      if(attachment.commentId&&attachment.commentId!==message.id||attachment.chatMessageId&&attachment.chatMessageId!==message.id)throw new Error('Attachment already belongs to another message');}
    const attachmentSession=ctx.issueSessions().getIssueSession(message.session_id),attachmentChat=ctx.chat().getChatSession(attachmentSession?.chatId ?? message.session_id);
    if(attachmentSession && !attachmentSession.chatId && attachmentSession.issueId)ctx.issues().linkAttachmentsToComment(message.id,attachmentSession.issueId,input.attachment_ids);else if(attachmentChat)ctx.issues().linkAttachmentsToChatMessage(attachmentChat.id,message.id,input.attachment_ids);else throw new Error('Automation attachments require an Issue or Chat');
  }
  if(recipientType==='agent'&&recipientId){
    // A downgraded message remains discoverable, but only now contributes a wake hint.
    if(policy.applied==='now'){
      ctx.db.run(`INSERT INTO multiremi_session_lanes(session_id,reader_type,reader_id,execution_scope,created_at,updated_at)
        VALUES(?,'agent',?,?,?,?) ON CONFLICT DO NOTHING`,[sessionId,recipientId,scope,entry.created_at,entry.created_at]);
      ctx.db.run(`UPDATE multiremi_session_lanes SET wake_hint_seq=CASE WHEN wake_hint_seq<? THEN ? ELSE wake_hint_seq END
        WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=?`,[entry.seq,entry.seq,sessionId,recipientId,scope]);
    }
  }
  if(policy.reason==='pair_round_trip_limit'&&source?.current_attempt_id&&targetIssue&&recipientId){
    const sourceTask=ctx.tasks().getTask(source.current_attempt_id)!;
    ctx.tasks().recordDelegationRoundTripLimitedWithinTransaction(new DelegationRoundTripLimitError(sourceTask,recipientId,targetIssue.id,hops,limit),[],events);
  }
  if(input.message_kind==='decision'&&source){
    lockLane(ctx,source.session_id,source.agent_id,source.execution_scope);
    ctx.db.run("UPDATE multiremi_turns SET status='awaiting_human',waiting_on_message_id=? WHERE id=? AND status IN ('pending','running','awaiting_human')",[message.id,source.id]);
  }
  const resumedIssues=new Set<string>();
  if(input.message_kind==='reply'&&reply?.message_kind==='decision'){
    ctx.db.run('UPDATE multiremi_conversation_log SET resolved_at=COALESCE(resolved_at,?) WHERE id=?',[message.created_at,reply.id]);
    const waiting=ctx.db.query("SELECT * FROM multiremi_turns WHERE waiting_on_message_id=? AND status='awaiting_human'").all(reply.id);
    for(const turn of waiting){lockLane(ctx,turn.session_id,turn.agent_id,turn.execution_scope);
      ctx.db.run("UPDATE multiremi_turns SET status='running',waiting_on_message_id=NULL WHERE id=? AND status='awaiting_human'",[turn.id]);
      const resumed=ctx.tasks().getTask(turn.current_attempt_id);
      if(resumed)afterCommit(ctx.db,()=>ctx.notifyTaskEvent('task:running',resumed));
      if(turn.issue_id && !ctx.issueSessions().getIssueSession(turn.session_id)?.chatId && !turn.chat_session_id)resumedIssues.add(turn.issue_id);}
  }
  let turnInput=createInput;
  if(input.to.type==='role'&&input.to.ref==='delegator'&&source?.delegation_id){
    turnInput={...createInput,delegationId:source.delegation_id,delegatedByAgentId:recipientId,delegatedFromIssueSessionId:sessionId};
  }
  if(policy.reason==='agent_dispatch'&&source?.issue_id&&sourceSession){
    turnInput={...createInput,delegationId:delegatedLane?.delegation_id??createInput.delegationId??scope,delegatedByAgentId:input.sender.id,
      delegatedFromIssueSessionId:sourceSession.id,parentTaskId:null};
  }
  if (source?.issue_creation_restricted) {
    turnInput = { ...turnInput, issueCreationRestricted: true };
  }
  // Decision answers are input for the waiting work unit, including cross-Issue answers.
  const turnId=decisionTurn
    ?deliverToRunningTurn(ctx,decisionTurn,message)
    :ensurePendingTurn(ctx,message,{...input,execution_scope:scope,session_id:sessionId},events,turnInput,continuation);
  if (turnId && source?.issue_creation_restricted) {
    ctx.db.run('UPDATE multiremi_turns SET issue_creation_restricted=1 WHERE id=?', [turnId]);
  }
  if(turnId){ctx.conversationLog().updateConversationLogWithinTransaction(sessionId,message.seq,{deferEmit:true,fields:{metadata:{...message.metadata,delivery_turn_id:turnId}}});message=getMessage(ctx,message.id)!;}
  if(policy.applied!==input.wake_requested&&targetIssue)ctx.appendIssueActivity(targetIssue.id,{actorType:'system',actorId:null,type:'wake_downgraded',
    body:policy.reason,data:{message_id:message.id,requested:input.wake_requested,applied:policy.applied,reason:policy.reason}},events);
  if(turnId&&force&&targetIssue&&unmet.length)ctx.issues().recordDependencyForceStarted(targetIssue.id,{
    source:force.source,status:'todo',previousStatus:targetIssue.status,unmet,actorType:'member',actorId:force.actorMemberId,
    commentId:force.commentId??message.id,taskId:ctx.db.query('SELECT current_attempt_id FROM multiremi_turns WHERE id=?').get(turnId)?.current_attempt_id,agentId:recipientId,
    assigneeDispatched:recipientId === ctx.resolveIssueResponsibility(targetIssue.id).executionOwner?.id,
  },events);
  const affected=new Set(turnId||input.message_kind==='decision'||reply?.message_kind==='decision'?[targetIssue?.id,source?.issue_id]:[]);
  for(const id of resumedIssues)affected.add(id);
  for(const id of affected)if(id)deriveIssueStatusWithinTransaction(ctx,id,events);
  // Cross-conversation inbox caches need a workspace signal even without a log subscription.
  events.workspace.push({type:'inbox:new',workspaceId,actorType:'system',actorId:null,payload:{index_only:true}});
  return {message,wake_applied:policy.applied,wake_reason:policy.reason,...(turnId?{turn_id:turnId}:{})};
}

function policyWantsWork(input: SendMessageInput): boolean {
  return input.wake_requested === 'now' && input.message_kind === 'request' && input.to.type !== 'none';
}
