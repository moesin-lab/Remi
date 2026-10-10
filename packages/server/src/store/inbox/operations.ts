import { inboxVisibilitySql, type InboxAccess } from './inbox-visibility.js';
import type { SendMessageInput, UnifiedMessage, MultiremiTurn, MultiremiTurnAttempt } from '@multiremi/contracts/unified-model.js';
import type { MultiremiWorkspaceMember } from '@multiremi/contracts/types.js';
import type { StoreContext } from '../context.js';
import { createCommitEventQueue } from '../context.js';
import { afterCommit } from '../db/postgres.js';
import { createId,nowIso } from '@multiremi/ids.js';
import { getMessage,messageFromRow,sendMessageWithinTransaction } from './send-message.js';
import { deriveIssueStatusWithinTransaction } from './issue-status.js';
import { createReplacementAttemptWithinTransaction } from '../turn-attempts.js';
import { notifyTurnChanged } from '../turn-execution-records.js';
import { mintQuestionCardToken,hashQuestionCardToken,type QuestionCardCredential } from '../question-card-token.js';
import { patchDecisionRecord } from './decision-records.js';
import { lockLane } from './lane-machine.js';
import { IssueDecisionError } from '../repos/issues-repo.js';
import { ActiveIssueRunError, ChatIssueTaskConflictError, TaskSessionArchivedError } from '../repos/tasks-repo.js';
import { dependencyGateEnabled, IssueDependencyError } from '../repos/issue-dependencies.js';
import { Questions } from './questions.js';
import { isHistoricalIssueQuestionRecord } from '@multiremi/contracts';

type InboxQuery = {access?:InboxAccess;limit?:number;cursor?:{created_at:string;id:string};visible?:(sessionId:string)=>boolean;
  visibleMessage?:(message:Pick<UnifiedMessage,'id'|'session_id'|'reply_to_id'|'kind'|'task_id'|'metadata'>)=>boolean};
type MessageVisibility = InboxQuery['visibleMessage'];

export class InboxOperations {
  constructor(private ctx:StoreContext){}
  private transaction<T>(fn:(events:ReturnType<typeof createCommitEventQueue>)=>T):T {
    const events=createCommitEventQueue();
    const write=()=>fn(events);
    const result=this.ctx.db.inTransaction?write():this.ctx.db.transaction(write)();
    afterCommit(this.ctx.db,()=>this.ctx.emitCommitEvents(events));return result;
  }
  listMessages(sessionId:string,input:{from?:number;to?:number;limit?:number;thread?:string;unread_by?:string;message_kind?:string}={}):UnifiedMessage[]{
    const params:unknown[]=[sessionId,input.from??0,input.to??Number.MAX_SAFE_INTEGER];
    const extra=input.thread?' AND (id=? OR reply_to_id=?)':'';if(input.thread)params.push(input.thread,input.thread);
    if(input.message_kind)params.push(input.message_kind);
    if(input.unread_by)params.push(input.unread_by,input.unread_by);
    const scope=this.ctx.db.dialect==='postgres'?"m.metadata::jsonb ->> 'execution_scope'":"json_extract(m.metadata,'$.execution_scope')";
    const unread=input.unread_by?` AND m.to_agent_id=? AND seq>COALESCE((SELECT cursor_seq FROM multiremi_session_lanes WHERE session_id=m.session_id AND reader_type='agent' AND reader_id=? AND execution_scope=COALESCE(${scope},'')),0)`:'';
    params.push(Math.min(Math.max(input.limit??100,1),1000));
    return this.ctx.db.query(`SELECT m.* FROM multiremi_conversation_log m WHERE session_id=? AND seq>? AND seq<=?
      AND kind='message' AND visibility='shown' AND deleted_at IS NULL${extra}${input.message_kind?' AND message_kind=?':''}${unread} ORDER BY seq LIMIT ?`).all(...params).map(messageFromRow);
  }
  editMessage(id:string,input:{body_md:string}):UnifiedMessage {
    return this.transaction(()=>{
      const message=getMessage(this.ctx,id);if(!message||message.deleted_at)throw new Error('Message not found');
      this.lockMessage(message);
      this.assertUnread(message);
      this.ctx.conversationLog().updateConversationLogWithinTransaction(message.session_id,message.seq,{fields:{body_md:input.body_md}});
      this.ctx.conversationLog().appendWithinTransaction({sessionId:message.session_id,kind:'message_edited',authorType:message.sender_type,authorId:message.sender_id,metadata:{message_id:id}});
      return getMessage(this.ctx,id)!;
    });
  }
  private assertUnread(message:UnifiedMessage):void {
      if (message.metadata.question || message.metadata.human_request || message.metadata.decision_record)
        throw new IssueDecisionError(409,'Original questions and their history are immutable; use question close');
      if(message.metadata.issue_delivery || message.metadata.issue_delivery_response)
        throw new IssueDecisionError(409,'Formal deliveries and acceptance records are immutable; submit a new delivery');
      if(this.ctx.db.query(`SELECT 1 FROM multiremi_turns WHERE session_id=? AND input_to_seq>=? LIMIT 1`).get(message.session_id,message.seq)
        ||this.ctx.db.query(`SELECT 1 FROM multiremi_session_lanes WHERE session_id=? AND reader_type='agent'
          AND (cursor_seq>=? OR cursor_seq=? AND cursor_offset>0) LIMIT 1`).get(message.session_id,message.seq,message.seq-1))throw new Error('A consumed message cannot be edited or deleted');
  }
  deleteMessage(id:string):UnifiedMessage {
    return this.transaction(events=>{
      const message=getMessage(this.ctx,id);if(!message)throw new Error('Message not found');this.lockMessage(message);
      if(!message.deleted_at){this.assertUnread(message);this.ctx.conversationLog().updateConversationLogWithinTransaction(message.session_id,message.seq,{fields:{deleted_at:nowIso()}});
        this.ctx.conversationLog().appendWithinTransaction({sessionId:message.session_id,kind:'message_deleted',authorType:message.sender_type,authorId:message.sender_id,metadata:{message_id:id}});}
      const issue=this.ctx.issueSessions().getIssueSession(message.session_id);if(issue?.issueId && !issue.chatId)deriveIssueStatusWithinTransaction(this.ctx,issue.issueId,events);
      return getMessage(this.ctx,id)!;
    });
  }
  resolveMessage(id:string,actor:{type:string;id:string|null},resolved=true):UnifiedMessage {
    return this.transaction(events=>{
      const message=getMessage(this.ctx,id);if(!message)throw new Error('Message not found');this.lockMessage(message);
      if(message.message_kind==='decision'||message.metadata.human_request||message.metadata.human_response)
        throw new IssueDecisionError(409,'Decision and human request messages require an answer through the response state machine');
      this.ctx.conversationLog().updateConversationLogWithinTransaction(message.session_id,message.seq,{fields:{resolved_at:resolved?nowIso():null,resolved_by_type:resolved?actor.type:null,resolved_by_id:resolved?actor.id:null}});
      const session=this.ctx.issueSessions().getIssueSession(message.session_id);if(session?.issueId && !session.chatId)deriveIssueStatusWithinTransaction(this.ctx,session.issueId,events);
      return getMessage(this.ctx,id)!;
    });
  }
  reactMessage(id:string,input:{emoji:string;actorType?:string;actorId?:string;remove?:boolean}) {
    return this.transaction(()=>{const message=getMessage(this.ctx,id);if(!message||message.deleted_at)throw new Error('Message not found');this.lockMessage(message);
      const emoji=input.emoji.trim();if(!emoji)throw new Error('Reaction is required');
      const type=input.actorType??'member',actor=input.actorId??'local';
      if(input.remove)this.ctx.db.run('DELETE FROM multiremi_comment_reactions WHERE comment_id=? AND emoji=? AND actor_type=? AND actor_id=?',[id,emoji,type,actor]);
      else this.ctx.db.run('INSERT INTO multiremi_comment_reactions(id,comment_id,workspace_id,emoji,actor_type,actor_id,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',[createId('rct'),id,this.ctx.db.query('SELECT workspace_id FROM multiremi_conversation_heads WHERE session_id=?').get(message.session_id)?.workspace_id,emoji,type,actor,nowIso()]);
      return this.ctx.db.query('SELECT * FROM multiremi_comment_reactions WHERE comment_id=? ORDER BY created_at,id').all(id);});
  }
  private lockMessage(message:UnifiedMessage):void {
    const issueSession=this.ctx.issueSessions().getIssueSession(message.session_id),chat=this.ctx.chat().getChatSession(message.session_id);
    const workspace=issueSession?.workspaceId??chat?.workspaceId??this.ctx.db.query('SELECT workspace_id FROM multiremi_autopilots WHERE session_id=?').get(message.session_id)?.workspace_id??this.ctx.db.query('SELECT workspace_id FROM multiremi_conversation_heads WHERE session_id=?').get(message.session_id)?.workspace_id;
    if(!workspace)throw new Error('Conversation not found');this.ctx.lockWorkspaceRuntimeLifecycle(workspace);
    this.ctx.db.run('UPDATE multiremi_conversation_log SET revision=revision WHERE id=?',[message.id]);
  }
  listMessageInbox(memberId:string,workspaceId:string,input:InboxQuery={}) {
    const member=this.ctx.workspaces().getWorkspaceMember(memberId);if(!member||member.workspaceId!==workspaceId||member.archivedAt)throw new Error('Member belongs to another workspace');
    return this.listReaderMessageInbox('member',memberId,workspaceId,input);
  }
  listReaderMessageInbox(type:'member'|'agent',readerId:string,workspaceId:string,input:InboxQuery={}) {
    const scope=type==='member'?"''":this.ctx.db.dialect==='postgres'?"COALESCE(m.metadata::jsonb ->> 'execution_scope','')":"COALESCE(json_extract(m.metadata,'$.execution_scope'),'')";
    const json=(key:string)=>this.ctx.db.dialect==='postgres'?`m.metadata::jsonb #>> '{${key.replaceAll('.',',')}}'`:`json_extract(m.metadata,'$.${key}')`;
    const from=`FROM multiremi_conversation_log m
      JOIN multiremi_conversation_heads h ON h.session_id=m.session_id
      LEFT JOIN multiremi_session_lanes l ON l.session_id=m.session_id AND l.reader_type=? AND l.reader_id=? AND l.execution_scope=${scope}
      LEFT JOIN multiremi_issue_sessions s ON s.id=m.session_id LEFT JOIN multiremi_chat_sessions c ON c.id=COALESCE(s.chat_id,m.session_id)
      LEFT JOIN multiremi_autopilots a ON a.session_id=m.session_id
      WHERE m.${type==='member'?'to_member_id':'to_agent_id'}=? AND COALESCE(s.workspace_id,c.workspace_id,a.workspace_id,h.workspace_id)=? AND m.kind='message'
        AND m.seq>COALESCE(l.cursor_seq,0) AND m.visibility='shown' AND m.deleted_at IS NULL`;
    const params=[type,readerId,readerId,workspaceId];
    const attention=`CASE WHEN m.resolved_at IS NULL AND m.wake_applied<>'inbox_only' AND (
      m.message_kind='decision' OR m.message_kind='request' AND m.sender_type='member'
      OR m.message_kind='status' AND ${json('lifecycle_event')} IN ('task_failed','task_cancelled')
      OR m.message_kind IN ('report','final') AND ${json('message_outcome')} IN ('failed','blocked','cancelled')) THEN 1 ELSE 0 END`;
    if (input.access) {
      const guard=inboxVisibilitySql(this.ctx.db,input.access,{from,params});
      const filtered=from+' AND '+guard.where;
      const binds=[...guard.cteParams,...params,...guard.params];
      const counts=this.ctx.db.query(`${guard.cte} SELECT COUNT(*) AS unread_count,COALESCE(SUM(${attention}),0) AS attention_count ${filtered}`).get(...binds);
      const n=Math.min(input.limit??100,1000),cursor=input.cursor;
      const extra=cursor?' AND (m.created_at<? OR m.created_at=? AND m.id<?)':'';
      const rows=this.ctx.db.query(`${guard.cte} SELECT m.* ${filtered}${extra} ORDER BY m.created_at DESC,m.id DESC LIMIT ?`)
        .all(...binds,...(cursor?[cursor.created_at,cursor.created_at,cursor.id]:[]),n+1);
      const page=rows.slice(0,n).map(messageFromRow);
      return {items:page,unread_count:Number(counts.unread_count),attention_count:Number(counts.attention_count),
        next_cursor:rows.length>n?{created_at:page.at(-1)!.created_at,id:page.at(-1)!.id}:null};
    }
    let unread_count=0,attention_count=0;
    let countCursor:InboxQuery['cursor'];
    for(;;){
      const extra=countCursor?' AND (m.created_at<? OR m.created_at=? AND m.id<?)':'';
      const rows=this.ctx.db.query(`SELECT m.id,m.session_id,m.kind,m.task_id,m.reply_to_id,m.metadata,m.created_at,${attention} AS attention ${from}${extra}
        ORDER BY m.created_at DESC,m.id DESC LIMIT 1000`).all(...params,...(countCursor?[countCursor.created_at,countCursor.created_at,countCursor.id]:[]));
      for(const row of rows){
        if(input.visible&&!input.visible(row.session_id))continue;
        if(input.visibleMessage&&!input.visibleMessage({...row,metadata:JSON.parse(row.metadata??'{}')}))continue;
        unread_count++;attention_count+=Number(row.attention);
      }
      if(rows.length<1000)break;
      countCursor=rows.at(-1) as {created_at:string;id:string};
    }
    const n=Math.min(input.limit??100,1000),items:UnifiedMessage[]=[];
    let cursor=input.cursor;
    for(;;){
      const extra=cursor?' AND (m.created_at<? OR m.created_at=? AND m.id<?)':'';
      const rows=this.ctx.db.query(`SELECT m.* ${from}${extra} ORDER BY m.created_at DESC,m.id DESC LIMIT ?`)
        .all(...params,...(cursor?[cursor.created_at,cursor.created_at,cursor.id]:[]),n+1);
      for(const row of rows){if(input.visible&&!input.visible(row.session_id))continue;const message=messageFromRow(row);
        if(!input.visibleMessage||input.visibleMessage(message))items.push(message);}
      if(rows.length<n+1||items.length>n)break;
      cursor=rows.at(-1) as {created_at:string;id:string};
    }
    const page=items.slice(0,n);
    return {items:page,unread_count,attention_count,next_cursor:items.length>n?{created_at:page.at(-1)!.created_at,id:page.at(-1)!.id}:null};
  }
  private visibleReadSeq(type:'member'|'agent',readerId:string,sessionId:string,toSeq:number,visibleMessage:NonNullable<MessageVisibility>,scope?:string,allMessages=false):number {
    const scopeSql=this.ctx.db.dialect==='postgres'?"COALESCE(metadata::jsonb ->> 'execution_scope','')":"COALESCE(json_extract(metadata,'$.execution_scope'),'')";
    let upper=toSeq;
    for(;;){
      const rows=this.ctx.db.query(`SELECT id,seq,session_id,kind,task_id,reply_to_id,metadata FROM multiremi_conversation_log WHERE session_id=?${allMessages?'':` AND ${type==='member'?'to_member_id':'to_agent_id'}=?`}
        AND kind='message' AND visibility='shown' AND deleted_at IS NULL AND seq<=?${scope===undefined?'':` AND ${scopeSql}=?`} ORDER BY seq DESC LIMIT 1000`)
        .all(sessionId,...(allMessages?[]:[readerId]),upper,...(scope===undefined?[]:[scope]));
      const visible=rows.find(row=>visibleMessage({...row,metadata:JSON.parse(row.metadata??'{}')}));
      if(visible)return Number(visible.seq);
      if(rows.length<1000)return 0;
      upper=Number(rows.at(-1)!.seq)-1;
    }
  }
  readAgentMessageInbox(agentId:string,workspaceId:string,sessionId?:string,toSeq?:number,visible?:(sessionId:string)=>boolean,visibleMessage?:MessageVisibility):number {
    return this.transaction(()=>{
      const agent=this.ctx.agents().getAgent(agentId);if(!agent||agent.workspaceId!==workspaceId||agent.archivedAt)throw new Error('Agent belongs to another workspace');
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      const json=this.ctx.db.dialect==='postgres'?"m.metadata::jsonb ->> 'execution_scope'":"json_extract(m.metadata,'$.execution_scope')";
      const sessions=this.ctx.db.query(`SELECT DISTINCT m.session_id,COALESCE(${json},'') AS scope FROM multiremi_conversation_log m
        JOIN multiremi_conversation_heads h ON h.session_id=m.session_id WHERE m.to_agent_id=? AND h.workspace_id=?${sessionId?' AND m.session_id=?':''}`)
        .all(agentId,workspaceId,...(sessionId?[sessionId]:[])).filter(row=>!visible||visible(row.session_id));
      if(sessionId){const head=this.ctx.conversationLog().getConversationLogHead(sessionId)?.headSeq??0;
        if(toSeq!==undefined&&(!Number.isSafeInteger(toSeq)||toSeq<0||toSeq>head))throw new Error('Inbox read cursor must be within the log');}
      const readSessions=new Set<string>();
      for(const row of sessions){const head=this.ctx.conversationLog().getConversationLogHead(row.session_id)?.headSeq??0;
        const seq=visibleMessage?this.visibleReadSeq('agent',agentId,row.session_id,toSeq??head,visibleMessage,row.scope):toSeq??head,at=nowIso();
        if(visibleMessage&&!seq)continue;
        readSessions.add(row.session_id);
        lockLane(this.ctx,row.session_id,agentId,row.scope);
        this.ctx.db.run(`INSERT INTO multiremi_session_lanes(session_id,reader_type,reader_id,execution_scope,cursor_seq,created_at,updated_at)
          VALUES(?,'agent',?,?,?,?,?) ON CONFLICT(session_id,reader_type,reader_id,execution_scope) DO UPDATE SET
          cursor_seq=CASE WHEN multiremi_session_lanes.cursor_seq<excluded.cursor_seq THEN excluded.cursor_seq ELSE multiremi_session_lanes.cursor_seq END,
          cursor_offset=CASE WHEN multiremi_session_lanes.cursor_seq<=excluded.cursor_seq THEN 0 ELSE multiremi_session_lanes.cursor_offset END,updated_at=excluded.updated_at`,[row.session_id,agentId,row.scope,seq,at,at]);}
      this.ctx.emitWorkspaceEvent({type:sessionId?'inbox:read':'inbox:batch-read',workspaceId,actorType:'system',actorId:null,payload:{index_only:true}});
      return sessionId?Number(this.ctx.db.query("SELECT MIN(cursor_seq) AS seq FROM multiremi_session_lanes WHERE session_id=? AND reader_type='agent' AND reader_id=?").get(sessionId,agentId)?.seq??0):readSessions.size;
    });
  }
  readMessageInbox(memberId:string,sessionId:string,toSeq?:number,visibleMessage?:MessageVisibility):number {
    return this.transaction(()=>{
      const member=this.ctx.workspaces().getWorkspaceMember(memberId);if(!member||member.archivedAt)throw new Error('Member not found');
      this.ctx.lockWorkspaceRuntimeLifecycle(member.workspaceId);
      const cursor=this.readMemberConversation(member,sessionId,toSeq,visibleMessage);
      this.ctx.emitWorkspaceEvent({type:'inbox:read',workspaceId:member.workspaceId,actorType:'system',actorId:null,payload:{index_only:true}});
      return cursor;
    });
  }
  private readMemberConversation(member:MultiremiWorkspaceMember,sessionId:string,toSeq?:number,visibleMessage?:MessageVisibility):number {
    const session=this.ctx.issueSessions().getIssueSession(sessionId),chat=this.ctx.chat().getChatSession(sessionId),auto=this.ctx.db.query('SELECT workspace_id FROM multiremi_autopilots WHERE session_id=?').get(sessionId);
    if((session?.workspaceId??chat?.workspaceId??auto?.workspace_id??this.ctx.db.query('SELECT workspace_id FROM multiremi_conversation_heads WHERE session_id=?').get(sessionId)?.workspace_id)!==member.workspaceId)throw new Error('Inbox conversation belongs to another workspace');
    const head=this.ctx.conversationLog().getConversationLogHead(sessionId)?.headSeq??0;
    if(toSeq!==undefined&&(!Number.isSafeInteger(toSeq)||toSeq<0||toSeq>head))throw new Error('Inbox read cursor must be within the log');
    const seq=visibleMessage?this.visibleReadSeq('member',member.id,sessionId,toSeq??head,visibleMessage,undefined,!!chat):toSeq??head,at=nowIso();
    if(visibleMessage&&!seq)return Number(this.ctx.db.query("SELECT cursor_seq FROM multiremi_session_lanes WHERE session_id=? AND reader_type='member' AND reader_id=?").get(sessionId,member.id)?.cursor_seq??0);
    this.ctx.db.run(`INSERT INTO multiremi_session_lanes(session_id,reader_type,reader_id,execution_scope,cursor_seq,created_at,updated_at)
      VALUES(?,'member',?,'',?,?,?) ON CONFLICT(session_id,reader_type,reader_id,execution_scope)
      DO UPDATE SET cursor_seq=CASE WHEN multiremi_session_lanes.cursor_seq<excluded.cursor_seq THEN excluded.cursor_seq ELSE multiremi_session_lanes.cursor_seq END,updated_at=excluded.updated_at`,[sessionId,member.id,seq,at,at]);
    const cursor=Number(this.ctx.db.query("SELECT cursor_seq FROM multiremi_session_lanes WHERE session_id=? AND reader_type='member' AND reader_id=?").get(sessionId,member.id).cursor_seq);
    if(chat&&(chat.creatorId??'local')===(member.userId??member.id))this.ctx.db.run(`UPDATE multiremi_chat_sessions SET unread_since=NULL WHERE id=? AND NOT EXISTS (
      SELECT 1 FROM multiremi_conversation_log WHERE session_id=? AND kind='message' AND sender_type<>'member'
        AND visibility='shown' AND deleted_at IS NULL AND seq>?)`,[sessionId,sessionId,cursor]);
    return cursor;
  }
  readAllMessageInbox(memberId:string,workspaceId:string,visible?:(sessionId:string)=>boolean,visibleMessage?:MessageVisibility):number {
    return this.transaction(()=>{
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      const member=this.ctx.workspaces().getWorkspaceMember(memberId);
      if(!member||member.workspaceId!==workspaceId||member.archivedAt)throw new Error('Member belongs to another workspace');
      const sessions=this.ctx.db.query(`SELECT DISTINCT m.session_id FROM multiremi_conversation_log m
        JOIN multiremi_conversation_heads h ON h.session_id=m.session_id LEFT JOIN multiremi_issue_sessions s ON s.id=m.session_id LEFT JOIN multiremi_chat_sessions c ON c.id=COALESCE(s.chat_id,m.session_id)
        LEFT JOIN multiremi_autopilots a ON a.session_id=m.session_id WHERE m.to_member_id=? AND COALESCE(s.workspace_id,c.workspace_id,a.workspace_id,h.workspace_id)=?`).all(memberId,workspaceId).filter(row=>!visible||visible(row.session_id));
      let conversationsRead=0;
      for(const row of sessions){
        const head=this.ctx.conversationLog().getConversationLogHead(row.session_id)?.headSeq??0;
        const seq=visibleMessage?this.visibleReadSeq('member',memberId,row.session_id,head,visibleMessage):head;
        if(visibleMessage&&!seq)continue;
        this.readMemberConversation(member,row.session_id,seq);conversationsRead++;
      }
      this.ctx.emitWorkspaceEvent({type:'inbox:batch-read',workspaceId,actorType:'system',actorId:null,payload:{index_only:true}});
      return conversationsRead;
    });
  }
  getTurn(id:string):MultiremiTurn|null {
    const row=this.ctx.db.query('SELECT * FROM multiremi_turns WHERE id=?').get(id);return row?{...row,holds_workspace:!!row.holds_workspace} as MultiremiTurn:null;
  }
  listTurns(input:{workspace_id:string;issue_id?:string;session_id?:string;agent_id?:string;status?:string;limit?:number;cursor?:{created_at:string;id:string};visibility?:{userId:string|null;admin:boolean;attemptId?:string;coordinatingSessionId?:string}}):MultiremiTurn[]{
    const params:unknown[]=[input.workspace_id],conditions=['multiremi_turns.workspace_id=?'];
    for(const key of ['issue_id','session_id','agent_id','status'] as const)if(input[key]){conditions.push(`multiremi_turns.${key}=?`);params.push(input[key]);}
    if(input.cursor){conditions.push('(multiremi_turns.created_at<? OR multiremi_turns.created_at=? AND multiremi_turns.id<?)');params.push(input.cursor.created_at,input.cursor.created_at,input.cursor.id);}
    if (input.visibility) {
      const { userId, admin, attemptId, coordinatingSessionId } = input.visibility;
      // Actual Session ownership wins over damaged execution pointers. A deleted
      // Chat's persisted pointer remains private and cannot grant another creator access.
      const ownerChat = `COALESCE((SELECT s.chat_id FROM multiremi_issue_sessions s WHERE s.id=multiremi_turns.session_id),
        multiremi_turns.chat_session_id,(SELECT c.id FROM multiremi_chat_sessions c WHERE c.id=multiremi_turns.session_id))`;
      const actor = attemptId ? "multiremi_turns.current_attempt_id=?" : userId ? "COALESCE(c.creator_id,'local')=?" : "1=1";
      const agent = userId && !admin && !attemptId
        ? " AND EXISTS (SELECT 1 FROM multiremi_agents a WHERE a.id=c.agent_id AND a.workspace_id=c.workspace_id AND (a.visibility<>'private' OR a.owner_id=?))" : "";
      const coordinated = coordinatingSessionId ? "multiremi_turns.session_id=? OR " : "";
      conditions.push(`(${coordinated}${ownerChat} IS NULL OR EXISTS (SELECT 1 FROM multiremi_chat_sessions c
        WHERE c.id=${ownerChat} AND c.workspace_id=multiremi_turns.workspace_id AND ${actor}${agent}))`);
      if (coordinatingSessionId) params.push(coordinatingSessionId);
      if (attemptId || userId) params.push(attemptId ?? userId);
      if (agent) params.push(userId);
    }
    // Lists never transfer historical input bodies through the synchronous PG
    // bridge. Turn get --input remains the explicit full-input read.
    const fields = 'id,session_id,seq,agent_id,execution_scope,status,wake_source,wake_seq,trigger_message_id,input_from_seq,input_to_seq,waiting_on_message_id,reply_message_id,wrap_up_requested_at,current_attempt_id,chat_session_id,delegation_id,delegated_by_agent_id,delegation_return_turn_id,delegated_from_issue_session_id,delegation_skip_reason,continued_from_turn_id,holds_workspace,priority,requesting_user_name,requesting_user_profile_description,issue_id,workspace_id,created_at,started_at,ended_at,ended_reason';
    const attemptFields = ["id", "status", "runtime_id", "provider", "error", "failure_reason",
      "progress_summary", "progress_step", "progress_total"] as const;
    params.push(Math.min(input.limit ?? 100, 1000));
    return this.ctx.db.query(`SELECT ${fields.split(",").map(field => `multiremi_turns.${field}`).join(",")},NULL AS legacy_prompt,
      ${attemptFields.map(field => `current_attempt.${field} AS attempt_${field}`).join(",")}
      FROM multiremi_turns LEFT JOIN multiremi_turn_attempts current_attempt ON current_attempt.id=multiremi_turns.current_attempt_id
      WHERE ${conditions.join(" AND ")} ORDER BY multiremi_turns.created_at DESC,multiremi_turns.id DESC LIMIT ?`).all(...params).map(row => {
      const turn = { ...row, holds_workspace: !!row.holds_workspace } as MultiremiTurn;
      turn.current_attempt = row.attempt_id == null ? null : {
        id: row.attempt_id, status: row.attempt_status, runtime_id: row.attempt_runtime_id, provider: row.attempt_provider,
        error: row.attempt_error, failure_reason: row.attempt_failure_reason, progress_summary: row.attempt_progress_summary,
        progress_step: row.attempt_progress_step == null ? null : Number(row.attempt_progress_step),
        progress_total: row.attempt_progress_total == null ? null : Number(row.attempt_progress_total),
      };
      for (const field of attemptFields) delete (turn as unknown as Record<string, unknown>)[`attempt_${field}`];
      return turn;
    });
  }
  listTurnAttempts(id:string):MultiremiTurnAttempt[]{
    return this.ctx.db.query('SELECT * FROM multiremi_turn_attempts WHERE turn_id=? ORDER BY attempt_no').all(id).map(row=>({...row,
      event_count:row.event_count==null?null:Number(row.event_count),tool_call_count:row.tool_call_count==null?null:Number(row.tool_call_count),
      usage:JSON.parse(row.usage??'[]'),plugin_snapshot:JSON.parse(row.plugin_snapshot??'[]'),fallback_switched:!!row.fallback_switched,
      projection_truncated:!!row.projection_truncated,codex_profile:row.codex_profile?JSON.parse(row.codex_profile):null,
      claude_profile:row.claude_profile?JSON.parse(row.claude_profile):null,type_histogram:row.type_histogram?JSON.parse(row.type_histogram):null,
      model:row.model?JSON.parse(row.model):null,trace_ref:row.trace_ref?JSON.parse(row.trace_ref):null} as MultiremiTurnAttempt));
  }
  getTurnTrace(id:string){const turn=this.getTurn(id);if(!turn?.current_attempt_id)throw new Error('Turn not found');
    return {turn_id:id,attempt_id:turn.current_attempt_id,trace:this.ctx.taskTraces().getTaskTrace(turn.current_attempt_id)};}
  getTurnInput(id:string){const turn=this.getTurn(id);if(!turn)throw new Error('Turn not found');
    const from=turn.input_from_seq??0,to=turn.input_to_seq??turn.wake_seq,messages:UnifiedMessage[]=[];
    let after=from;
    for(;;){const page=this.listMessages(turn.session_id,{from:after,to,limit:1000});messages.push(...page);if(page.length<1000)break;after=page.at(-1)!.seq;}
    return {from_seq:from,to_seq:to,messages,legacy_prompt:turn.legacy_prompt};}
  cancelTurn(id:string):MultiremiTurn {
    return this.transaction(()=>{const turn=this.getTurn(id);if(!turn?.current_attempt_id)throw new Error('Turn not found');
      if(['completed','failed','cancelled'].includes(turn.status))return turn;
      this.ctx.lockWorkspaceRuntimeLifecycle(turn.workspace_id);lockLane(this.ctx,turn.session_id,turn.agent_id,turn.execution_scope);
      const to=turn.input_to_seq??turn.wake_seq;
      // Cancelling discards this turn's input; it must not ring itself again.
      this.ctx.db.run(`UPDATE multiremi_session_lanes SET cursor_seq=CASE WHEN cursor_seq<? THEN ? ELSE cursor_seq END,
        cursor_offset=CASE WHEN cursor_seq<=? THEN 0 ELSE cursor_offset END WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=?`,[to,to,to,turn.session_id,turn.agent_id,turn.execution_scope]);
      this.ctx.tasks().cancelTask(turn.current_attempt_id);return this.getTurn(id)!;});
  }
  wrapUpTurn(id:string):MultiremiTurn {
    return this.transaction(()=>{const turn=this.getTurn(id);if(!turn)throw new Error('Turn not found');this.ctx.lockWorkspaceRuntimeLifecycle(turn.workspace_id);
      lockLane(this.ctx,turn.session_id,turn.agent_id,turn.execution_scope);
      if(!['running','awaiting_human'].includes(turn.status))throw new Error('Only a running turn can wrap up');
      this.ctx.db.run('UPDATE multiremi_turns SET wrap_up_requested_at=COALESCE(wrap_up_requested_at,?) WHERE id=?',[nowIso(),id]);notifyTurnChanged(this.ctx.db,id);
      const task=turn.current_attempt_id?this.ctx.tasks().getTask(turn.current_attempt_id):null;if(task)afterCommit(this.ctx.db,()=>this.ctx.emitWorkspaceEvent({type:'daemon:task_input',workspaceId:turn.workspace_id,actorType:'system',actorId:null,payload:{runtime_id:task.runtimeId,task_id:task.id}}));
      return this.getTurn(id)!;});
  }
  retryTurn(id:string,cold=false):MultiremiTurn {
    return this.transaction(events=>{const turn=this.getTurn(id);if(!turn)throw new Error('Turn not found');this.ctx.lockWorkspaceRuntimeLifecycle(turn.workspace_id);lockLane(this.ctx,turn.session_id,turn.agent_id,turn.execution_scope);
      const result=createReplacementAttemptWithinTransaction(this.ctx.db,id,{previousStatus:'cancelled',reason:'manual_retry',cold,allowCancelledTurn:true});
      if(cold)this.ctx.db.run(`UPDATE multiremi_session_lanes SET provider_session_id=NULL,runtime_id=NULL,provider=NULL,work_dir=NULL,execution_fingerprint=NULL
        WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=?`,[turn.session_id,turn.agent_id,turn.execution_scope]);
      const task=this.ctx.tasks().getTask(result.attempt_id);if(task)events.enqueuedTasks.push(task);return this.getTurn(id)!;});
  }
  retryTurnAsMember(id:string,cold=false,authorizeConversation?:(sessionId:string)=>void):MultiremiTurn {
    return this.transaction(events=>{
      const initial=this.getTurn(id);
      if(!initial)throw new IssueDecisionError(404,'Turn not found');
      this.ctx.lockWorkspaceRuntimeLifecycle(initial.workspace_id);

      const turn=this.getTurn(id);
      if(!turn || turn.workspace_id!==initial.workspace_id || !turn.current_attempt_id)throw new IssueDecisionError(404,'Turn not found');
      if(['pending','running','awaiting_human'].includes(turn.status))throw new ActiveIssueRunError('This turn already has an active run');
      if(!['failed','cancelled'].includes(turn.status))throw new IssueDecisionError(409,'Only failed or cancelled turns can be retried');

      const scoped=this.ctx.issueSessions().getIssueSessionWithOwnerScope(turn.session_id);
      const chat=scoped
        ?scoped.session.chatId?this.ctx.chat().getChatSession(scoped.session.chatId):null
        :this.ctx.chat().getChatSession(turn.session_id);
      const agent=this.ctx.agents().getAgent(turn.agent_id);
      if(!agent || agent.archivedAt || agent.workspaceId!==turn.workspace_id)throw new IssueDecisionError(409,'Retry agent is unavailable');
      if(scoped){
        if(scoped.ownerWorkspaceId!==turn.workspace_id || scoped.session.workspaceId!==turn.workspace_id
          || scoped.session.issueId!==turn.issue_id
          || turn.chat_session_id && turn.chat_session_id!==scoped.session.chatId)throw new ChatIssueTaskConflictError('Retry conversation owner changed');
        if(scoped.session.status==='archived')throw new TaskSessionArchivedError('Session is archived');
        this.ctx.db.run('UPDATE multiremi_issue_sessions SET updated_at=updated_at WHERE id=?',[turn.session_id]);
      }else if(!chat || turn.issue_id || chat.agentId!==turn.agent_id || turn.chat_session_id && turn.chat_session_id!==chat.id){
        throw new ChatIssueTaskConflictError('Retry conversation owner not found');
      }
      if(chat && (chat.workspaceId!==turn.workspace_id || chat.status==='archived')){
        if(chat.status==='archived')throw new TaskSessionArchivedError('Chat session is archived');
        throw new ChatIssueTaskConflictError('Retry conversation belongs to another workspace');
      }
      authorizeConversation?.(turn.session_id);

      const issue=turn.issue_id?this.ctx.issues().getIssue(turn.issue_id):null;
      if(turn.issue_id && (!issue || issue.workspaceId!==turn.workspace_id))throw new ChatIssueTaskConflictError('Retry Issue belongs to another workspace');
      if(!chat && issue?.archivedAt)throw new TaskSessionArchivedError('Issue is archived');
      // Public Issue recovery keeps the existing any-active-run exclusion.
      // A projected private Session has its own work axis, independent of the Issue.
      const active=chat
        ?this.ctx.db.query("SELECT 1 FROM multiremi_turns WHERE session_id=? AND status IN ('pending','running','awaiting_human') LIMIT 1").get(turn.session_id)
        :this.ctx.db.query("SELECT 1 FROM multiremi_turns WHERE issue_id=? AND status IN ('pending','running','awaiting_human') LIMIT 1").get(turn.issue_id);
      if(active)throw new ActiveIssueRunError('This conversation already has an active run');
      if(issue && dependencyGateEnabled() && issue.status==='backlog'){
        const unmet=this.ctx.issues().listUnmetPrerequisites(issue.id);
        if(unmet.length)throw new IssueDependencyError('dependencies_unmet',`${issue.key} is waiting on unfinished prerequisites`,{unmet});
      }

      lockLane(this.ctx,turn.session_id,turn.agent_id,turn.execution_scope);
      const previous=this.ctx.db.query('SELECT status,failure_reason FROM multiremi_turn_attempts WHERE id=? AND turn_id=?').get(turn.current_attempt_id,id);
      if(!previous)throw new IssueDecisionError(404,'Current attempt not found');
      if(!['failed','cancelled','lost'].includes(previous.status))throw new IssueDecisionError(409,'Only a terminal current attempt can be retried');
      this.ctx.db.run("UPDATE multiremi_turns SET wake_source='human_sender' WHERE id=?",[id]);
      const result=createReplacementAttemptWithinTransaction(this.ctx.db,id,{
        previousStatus:previous.status==='lost'?'lost':turn.status as 'failed'|'cancelled',
        reason:previous.failure_reason??'manual_retry',cold,allowCancelledTurn:true,turnStatus:'pending',
      });
      this.ctx.db.run('UPDATE multiremi_turns SET max_attempts=CASE WHEN max_attempts<? THEN ? ELSE max_attempts END WHERE id=?',
        [result.attempt_no,result.attempt_no,id]);
      if(cold)this.ctx.db.run(`UPDATE multiremi_session_lanes SET provider_session_id=NULL,runtime_id=NULL,provider=NULL,work_dir=NULL,execution_fingerprint=NULL
        WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=?`,[turn.session_id,turn.agent_id,turn.execution_scope]);
      if(issue && !chat)deriveIssueStatusWithinTransaction(this.ctx,issue.id,events);
      const task=this.ctx.tasks().getTask(result.attempt_id);
      if(task)events.enqueuedTasks.push(task);
      return this.getTurn(id)!;
    });
  }
  issueMessageCardToken(id:string,recipient:string|null):string {
    return this.transaction(()=>{const message=getMessage(this.ctx,id);if(!message||message.message_kind!=='decision')throw new Error('Decision not found');this.lockMessage(message);
      const token=mintQuestionCardToken();const changed=this.ctx.db.run(`UPDATE multiremi_conversation_log SET card_token_hash=?,card_token_recipient=?,card_token_consumed_at=NULL WHERE id=? AND resolved_at IS NULL AND card_token_consumed_at IS NULL`,[hashQuestionCardToken(token),recipient,id]);
      if(!changed.changes)throw new Error('Decision is settled');return token;});
  }
  answerMessageDecision(id:string,input:{sender:SendMessageInput['sender'];body_md:string;credential?:QuestionCardCredential;response?:Record<string,unknown>;source_turn_id?:string;expected_route_revision?:number;expected_answer_revision?:number;revise?:boolean;reason?:string}) {
    return this.transaction(events=>{const message=getMessage(this.ctx,id);if(!message||message.message_kind!=='decision')throw new Error('Decision not found');this.lockMessage(message);
      if (message.metadata.question || message.metadata.human_request || isHistoricalIssueQuestionRecord(message.metadata.decision_record)) return new Questions(this.ctx).answer(id, { expected_route_revision: input.expected_route_revision!, response: input.response ?? { answer: input.body_md }, body_md: input.body_md, revise: input.revise, reason: input.reason, expected_answer_revision: input.expected_answer_revision }, input.sender, input.source_turn_id, input.credential);
      // Retain the carrier of old status-only choices without inventing a Q.
      const key=message.metadata.decision_record?'decision_record':'message_choice';
      if(input.sender.type==='member'?message.to_member_id!==input.sender.id:input.sender.type!=='agent'||message.to_agent_id!==input.sender.id)throw new IssueDecisionError(403,'Decision requires its recipient');
      if(!patchDecisionRecord(this.ctx,id,key,{status:'answered',answer:input.body_md,responded_at:nowIso()},'pending',input.credential))throw new IssueDecisionError(409,'Decision is settled');
      return sendMessageWithinTransaction(this.ctx,{session_id:message.session_id,sender:input.sender,to:message.sender_type==='agent'&&message.sender_id?{type:'agent',ref:message.sender_id}:{type:'none'},
        body_md:input.body_md,message_kind:'reply',wake_requested:'now',reply_to_id:id,source_turn_id:input.source_turn_id,
        metadata:input.response?{human_response:input.response}:undefined},events);});
  }
}
