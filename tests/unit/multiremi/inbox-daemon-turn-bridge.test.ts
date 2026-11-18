import { createResponsibleTestIssue } from './helpers.js';
import {it,expect,spyOn} from 'bun:test';
import {pendingTurnBackendTests} from './pending-turn-test-backends.js';
import {IssuesRepo} from '@multiremi/store/repos/issues-repo.js';
pendingTurnBackendTests('MUL-506 DaemonTurnBridge',fixture=>{
  function setup(){const {store,db}=fixture();const agent=store.createAgent({name:'Daemon worker',provider:'codex'});
    store.registerRuntime({id:'rt_inbox_bridge',daemonId:'daemon_inbox_bridge',name:'Bridge runtime',provider:'codex',workspaceId:'local'});
    const issue=store.createIssue({title:'Bridge',assigneeType:'agent',assigneeId:agent.id,responsibleMemberId:'mem_local_local'}),session=store.getOrCreateDefaultIssueSession(issue.id);
    const sent=store.sendMessage({session_id:session.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:agent.id},message_kind:'request',wake_requested:'now',body_md:'start'});
    const attempt=store.claimTask('rt_inbox_bridge')!;store.startTask(attempt.id);
    const bridge=store.getDaemonTurnBridge(),scope={runtimeId:'rt_inbox_bridge',daemonId:'daemon_inbox_bridge',workspaceId:'local'},offer=bridge.offerInput(store.getTaskWithAgent(attempt.id)!);
    return {store,db,agent,issue,session,sent,attempt,bridge,scope,offer};}
  for(const mode of ['read','limit','legacy'] as const)it(`MUL-63 folded input completion: ${mode}`,()=>{
    const f=setup();
    const folded=f.store.sendMessage({session_id:f.session.id,sender:{type:'member',id:'mem_local_local'},to:{type:'none'},message_kind:'status',wake_requested:'inbox_only',body_md:'folded context'});
    const offer=f.bridge.offerInput(f.store.getTaskWithAgent(f.attempt.id)!);
    const scope={...f.scope,inputUnread:mode!=='legacy'};
    const payload={turn_id:f.sent.turn_id!,attempt_id:f.attempt.id,input_to_seq:offer.input_to_seq,reply:{body_md:'preserved reply',message_kind:'final' as const}};
    // A suffix read cannot bridge the earlier unread trigger.
    f.store.recordSessionAgentRangeRead(f.session.id,f.agent.id,{seq:folded.message.seq,offset:0},{seq:offer.input_to_seq+1,offset:0},f.attempt.id);
    if(mode!=='legacy') {
      const rejected=f.bridge.complete({payload,completionFields:null},scope);
      expect(rejected).toMatchObject({ok:false,code:'input_unread',read_to_seq:0,required_to_seq:offer.input_to_seq});
      expect(rejected.read_command).toBe(`remi message list ${f.session.id} --from 0 --to ${offer.input_to_seq}`);
      expect(f.store.getTurn(f.sent.turn_id!)?.status).toBe('running');
      if(mode==='read')f.store.recordSessionAgentRangeRead(f.session.id,f.agent.id,{seq:1,offset:0},{seq:offer.input_to_seq+1,offset:0},f.attempt.id);
    }
    const done=f.bridge.complete({payload:{...payload,input_unread_fallback:mode==='limit'},completionFields:null},scope);
    expect(done.ok).toBe(true);
    const turn=f.store.getTurn(f.sent.turn_id!)!;
    expect(turn.status).toBe('completed');
    expect(f.store.getMessage(String(done.reply_message_id))?.body_md).toBe('preserved reply');
    expect(turn.input_to_seq??0).toBe(mode==='read'?offer.input_to_seq:0);
    if(mode!=='read')expect(f.store.getMessage(String(done.reply_message_id))?.metadata.task_result).toMatchObject({input_unread:{read_to_seq:0,required_to_seq:offer.input_to_seq}});
  });
  it('MUL-63 completion beyond offered remains invalid even with fallback',()=>{
    const f=setup();
    expect(f.bridge.complete({payload:{turn_id:f.sent.turn_id!,attempt_id:f.attempt.id,input_to_seq:f.offer.input_to_seq+1,input_unread_fallback:true,reply:{body_md:'invalid',message_kind:'final'}},completionFields:null},{...f.scope,inputUnread:true})).toMatchObject({ok:false,code:'invalid_report'});
  });
  it('checks current attempt/runtime and confirms input contiguously',()=>{const f=setup();const payload={turn_id:f.sent.turn_id,attempt_id:f.attempt.id,input_to_seq:f.offer.input_to_seq,message_ids:f.offer.input_messages.map(m=>m.id)};
    expect(f.bridge.rpc('turn.input',{...payload,attempt_id:'wrong'},f.scope).ok).toBe(false);
    expect(f.bridge.rpc('turn.input',{...payload,message_ids:[]},f.scope).ok).toBe(false);
    expect(f.bridge.rpc('turn.input',payload,f.scope).ok).toBe(true);expect(f.bridge.rpc('turn.input',payload,f.scope).ok).toBe(true);
    expect(f.store.getTurn(f.sent.turn_id!)?.input_to_seq).toBe(f.offer.input_to_seq);},120_000);
  for(const partial of [false,true])it(`MUL-178 inline acknowledgement preserves an ahead ${partial?'partial':'complete'} body receipt`,()=>{
    const f=setup();
    const later=f.store.sendMessage({session_id:f.session.id,sender:{type:'member',id:'mem_local_local'},to:{type:'none'},message_kind:'status',wake_requested:'inbox_only',body_md:'x'.repeat(10000)});
    f.store.recordSessionAgentRangeRead(f.session.id,f.agent.id,{seq:1,offset:0},
      {seq:later.message.seq+(partial?0:1),offset:partial?50:0},f.attempt.id);
    const receipt=()=>f.db.query('SELECT input_read_seq,input_read_offset FROM multiremi_turn_attempts WHERE id=?').get(f.attempt.id);
    const before=receipt();
    expect(f.bridge.rpc('turn.input',{turn_id:f.sent.turn_id,attempt_id:f.attempt.id,input_to_seq:f.offer.input_to_seq,message_ids:f.offer.input_messages.map(m=>m.id)},f.scope).ok).toBe(true);
    expect(receipt()).toEqual(before);
  });
  it('decision/permission waits, member reply resumes, wrap-up is a marker',()=>{const f=setup();
    const requested=f.bridge.rpc('turn.decision',{turn_id:f.sent.turn_id,attempt_id:f.attempt.id,wait_id:'bridge-permission-native-wait',dedupe_key:'permission',body_md:'Permit?',options:[{label:'Yes',value:'yes'}],metadata:{kind:'permission',options:[{optionId:'yes',name:'Yes',kind:'allow_once'}]}},f.scope);
    expect(requested.ok).toBe(true);expect(f.store.getTurn(f.sent.turn_id!)?.status).toBe('awaiting_human');
    const message=requested.message as any,revision=f.store.getQuestion(message.id)!.route_revision;
    f.store.answerMessageDecision(message.id,{sender:{type:'member',id:'mem_local_local'},expected_route_revision:revision,body_md:'Yes',response:{option_id:'yes'}});
    expect(()=>f.store.answerMessageDecision(message.id,{sender:{type:'member',id:'mem_local_local'},expected_route_revision:revision,body_md:'Again'})).toThrow('settled');
    expect(f.store.getTurn(f.sent.turn_id!)?.status).toBe('running');expect(f.bridge.rpc('turn.decision.get',{turn_id:f.sent.turn_id,attempt_id:f.attempt.id,message_id:message.id},f.scope).status).toBe('resolved');
    const before=f.store.getSessionAgentReadProgress(f.session.id,f.agent.id);f.store.wrapUpTurn(f.sent.turn_id!);expect(f.bridge.snapshot(f.scope,new Set([f.attempt.id])).wrapUps).toHaveLength(1);expect(f.store.getSessionAgentReadProgress(f.session.id,f.agent.id)).toEqual(before);},120_000);
  it('only a full range read by this attempt permits omitted input IDs',()=>{const f=setup();
    const receipt={turn_id:f.sent.turn_id,attempt_id:f.attempt.id,input_to_seq:f.offer.input_to_seq,message_ids:[]};
    expect(f.bridge.rpc('turn.input',receipt,f.scope).code).toBe('input_gap');
    f.store.recordSessionAgentRangeRead(f.session.id,f.agent.id,{seq:1,offset:0},{seq:f.sent.message.seq,offset:1},f.attempt.id);
    expect(f.bridge.rpc('turn.input',receipt,f.scope).code).toBe('input_gap');
    f.store.recordSessionAgentRangeRead(f.session.id,f.agent.id,{seq:1,offset:0},{seq:f.offer.input_to_seq+1,offset:0},f.attempt.id);
    expect(f.bridge.rpc('turn.input',{...receipt,message_ids:['foreign']},f.scope).code).toBe('input_gap');
    expect(f.bridge.rpc('turn.input',receipt,f.scope).ok).toBe(true);
    expect(f.store.getTurn(f.sent.turn_id!)?.input_to_seq).toBe(f.offer.input_to_seq);
  });
  it('completes atomically, re-rings unread interrupt, completion replay is idempotent',()=>{const f=setup();const later=f.store.sendMessage({session_id:f.session.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:f.agent.id},message_kind:'request',wake_requested:'now',body_md:'interrupt'});
    const input={payload:{turn_id:f.sent.turn_id!,attempt_id:f.attempt.id,input_to_seq:f.offer.input_to_seq,reply:{body_md:'done',message_kind:'final' as const}},completionFields:null};
    const done=f.bridge.complete(input,f.scope);expect(done.ok).toBe(true);expect(f.store.getMessage(String(done.reply_message_id))?.message_kind).toBe('final');
    expect(f.store.listTurns({workspace_id:'local',session_id:f.session.id}).filter(t=>t.status==='pending')).toHaveLength(1);expect(later.message.seq).toBeGreaterThan(f.store.getTurn(f.sent.turn_id!)!.input_to_seq!);
    expect(f.bridge.complete(input,f.scope)).toEqual(done);},120_000);
  it('rejects stale completion until an offered interrupt has been consumed',()=>{const f=setup();
    const later=f.store.sendMessage({session_id:f.session.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:f.agent.id},message_kind:'request',wake_requested:'now',body_md:'new directive'});
    const snapshot=f.bridge.snapshot(f.scope,new Set([f.attempt.id]));
    expect(snapshot.messages.map(m=>m.message.id)).toEqual([later.message.id]);
    const input={payload:{turn_id:f.sent.turn_id!,attempt_id:f.attempt.id,input_to_seq:f.offer.input_to_seq,reply:{body_md:'old answer',message_kind:'final' as const}},completionFields:null};
    expect(f.bridge.complete(input,f.scope)).toEqual({ok:false,code:'turn_input_pending',retryable:false});
    expect(f.store.getTurn(f.sent.turn_id!)?.status).toBe('running');
    expect(f.store.getTurn(f.sent.turn_id!)?.reply_message_id).toBeNull();
    const offer=f.bridge.offerInput(f.store.getTaskWithAgent(f.attempt.id)!);
    expect(f.bridge.rpc('turn.input',{turn_id:f.sent.turn_id,attempt_id:f.attempt.id,input_to_seq:offer.input_to_seq,message_ids:offer.input_messages.map(m=>m.id)},f.scope).ok).toBe(true);
    expect(f.bridge.complete({...input,payload:{...input.payload,input_to_seq:offer.input_to_seq,reply:{body_md:'new answer',message_kind:'final'}}},f.scope).ok).toBe(true);
    expect(f.store.getTurn(f.sent.turn_id!)?.input_to_seq).toBe(offer.input_to_seq);
    expect(f.store.listTurns({workspace_id:'local',session_id:f.session.id})).toHaveLength(1);
  },120_000);
  it('reply write failure completes without a reply pointer',()=>{const f=setup();const write=spyOn(IssuesRepo.prototype,'createIssueCommentWithinTransaction').mockImplementation(()=>{throw new Error('injected reply write failure');});
    try{expect(f.bridge.complete({payload:{turn_id:f.sent.turn_id!,attempt_id:f.attempt.id,input_to_seq:f.offer.input_to_seq,reply:{body_md:'done',message_kind:'reply'}},completionFields:null},f.scope).ok).toBe(true);
      expect(f.store.getTurn(f.sent.turn_id!)?.status).toBe('completed');expect(f.store.getTurn(f.sent.turn_id!)?.reply_message_id).toBeNull();}finally{write.mockRestore();}},120_000);
  it('MUL-191 snapshots duplicate live lanes without aborting the runtime downlink',()=>{
    const f=setup();
    // Model two current live attempts on a legacy/inconsistent lane. The bulk
    // upsert must visit that lane once (PostgreSQL rejects duplicate targets).
    f.store.registerRuntime({id:f.scope.runtimeId,daemonId:f.scope.daemonId,name:'Bridge runtime',provider:'codex',workspaceId:'local',maxConcurrency:2});
    const peerIssue=createResponsibleTestIssue(f.store,{title:'Duplicate lane',assigneeType:'agent',assigneeId:f.agent.id});
    const peerSession=f.store.getOrCreateDefaultIssueSession(peerIssue.id);
    const peer=f.store.sendMessage({session_id:peerSession.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:f.agent.id},message_kind:'request',wake_requested:'now',body_md:'peer start'});
    const attempt=f.store.claimTask(f.scope.runtimeId)!;f.store.startTask(attempt.id);
    f.db.run('UPDATE multiremi_turns SET session_id=?,seq=seq+1 WHERE id=?',[f.session.id,peer.turn_id!]);
    f.store.wrapUpTurn(f.sent.turn_id!);f.store.wrapUpTurn(peer.turn_id!);
    const interrupt=f.store.sendMessage({session_id:f.session.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:f.agent.id},message_kind:'request',wake_requested:'now',body_md:'shared interrupt'});
    const before=f.store.getSessionAgentReadProgress(f.session.id,f.agent.id);
    const snapshot=f.bridge.snapshot(f.scope,new Set([f.attempt.id,attempt.id]));
    expect(snapshot.wrapUps.map(row=>row.attempt_id).sort()).toEqual([f.attempt.id,attempt.id].sort());
    for(const id of [f.attempt.id,attempt.id]) {
      expect(snapshot.messages.filter(row=>row.attempt_id===id).map(row=>row.message.id)).toContain(interrupt.message.id);
      expect(Number(f.db.query('SELECT projection_to_seq FROM multiremi_turn_attempts WHERE id=?').get(id)!.projection_to_seq)).toBeGreaterThanOrEqual(interrupt.message.seq);
    }
    expect(Number(f.db.query("SELECT COUNT(*) AS n FROM multiremi_session_lanes WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope='' ").get(f.session.id,f.agent.id)!.n)).toBe(1);
    expect(f.store.getSessionAgentReadProgress(f.session.id,f.agent.id)).toEqual(before);
  });
  it('snapshots only new now input for the current lane and folds large bodies',()=>{const f=setup();
    const send=(body:string,wake:'now'|'next_turn',to=f.agent.id)=>f.store.sendMessage({session_id:f.session.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:to},message_kind:'request',wake_requested:wake,body_md:body});
    send('later','next_turn');const other=f.store.createAgent({name:'Other',provider:'codex'});send('other','now',other.id);
    const long=send('x'.repeat(20000),'now'),snapshot=f.bridge.snapshot(f.scope,new Set([f.attempt.id]));
    expect(snapshot.messages.map(m=>m.message.id)).toEqual([long.message.id]);
    expect(snapshot.messages[0]!.message.body_md.length).toBeLessThan(9000);
    expect(snapshot.messages[0]!.message.body_md).toContain('还有 12000 字没看');
    expect(f.store.getMessage(long.message.id)?.body_md.length).toBe(20000);
    const offer=f.bridge.offerInput(f.store.getTaskWithAgent(f.attempt.id)!);
    const receipt={turn_id:f.sent.turn_id,attempt_id:f.attempt.id,input_to_seq:offer.input_to_seq,message_ids:offer.input_messages.map(m=>m.id)};
    expect(f.bridge.rpc('turn.input',receipt,f.scope).code).toBe('input_gap');
    f.store.recordSessionAgentRangeRead(f.session.id,f.agent.id,{seq:1,offset:0},{seq:offer.input_to_seq+1,offset:0});
    expect(f.bridge.rpc('turn.input',receipt,f.scope).ok).toBe(true);
    expect(f.store.getTurn(f.sent.turn_id!)?.input_to_seq).toBe(offer.input_to_seq);
  },120_000);

  it('cold retry replaces the attempt and trace binding without changing Issue status',()=>{const f=setup();
    f.store.cancelTurn(f.sent.turn_id!);const before=f.store.getIssue(f.issue.id)!;
    f.db.run("UPDATE multiremi_session_lanes SET provider_session_id='old',work_dir='/old',execution_fingerprint='old' WHERE session_id=? AND reader_id=?",[f.session.id,f.agent.id]);
    const replacement=f.store.retryTurn(f.sent.turn_id!,true);
    expect(replacement.id).toBe(f.sent.turn_id!);expect(replacement.current_attempt_id).not.toBe(f.attempt.id);
    expect(f.store.listTurnAttempts(replacement.id)).toHaveLength(2);expect(f.store.getTurnTrace(replacement.id).attempt_id).toBe(replacement.current_attempt_id!);
    expect(f.store.getIssue(f.issue.id)?.status).toBe(before.status);expect(f.store.getIssue(f.issue.id)?.updatedAt).toBe(before.updatedAt);
    expect(f.db.query("SELECT provider_session_id,work_dir,execution_fingerprint FROM multiremi_session_lanes WHERE session_id=? AND reader_id=? AND execution_scope='' ").get(f.session.id,f.agent.id)).toMatchObject({provider_session_id:null,work_dir:null,execution_fingerprint:null});
    expect(f.bridge.rpc('turn.input',{turn_id:replacement.id,attempt_id:f.attempt.id,input_to_seq:f.offer.input_to_seq,message_ids:[]},f.scope).code).toBe('stale_attempt');
  },120_000);

}, { isolation: "snapshot" });
