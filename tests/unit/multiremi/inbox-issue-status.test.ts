import {it,expect,spyOn} from 'bun:test';
import {pendingTurnBackendTests} from './pending-turn-test-backends.js';
import {StoreContext,createCommitEventQueue} from '@multiremi/store/context.js';
import {deriveIssueStatusWithinTransaction} from '@multiremi/store/inbox/issue-status.js';
import {foldAgentReadState,FOLD_AGENT_READ_STATE_MIGRATION} from '@multiremi/store/inbox/lane-migration.js';

pendingTurnBackendTests('MUL-506 Issue derivation and read progress',fixture=>{
  function setup(){const {store,db}=fixture(),agent=store.createAgent({name:'Owner',provider:'codex'});
    const issue=store.createIssue({title:'Derived',assigneeType:'agent',assigneeId:agent.id});
    const session=store.getOrCreateDefaultIssueSession(issue.id),ctx=new StoreContext(db,()=>store);
    const sent=store.sendMessage({session_id:session.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:agent.id},message_kind:'request',wake_requested:'now',body_md:'work'});
    const derive=()=>db.transaction(()=>{ctx.lockWorkspaceRuntimeLifecycle('local');deriveIssueStatusWithinTransaction(ctx,issue.id,createCommitEventQueue());})();
    return {store,db,agent,issue,session,ctx,sent,derive};}
  for(const [turnStatus,status] of [['running','in_progress'],['awaiting_human','in_progress'],['completed','in_review'],['failed','blocked'],['cancelled','todo']] as const){
    it(`derives ${status} from owner ${turnStatus}`,()=>{const f=setup();f.db.run("UPDATE multiremi_issues SET status='todo' WHERE id=?",[f.issue.id]);f.db.run('UPDATE multiremi_turns SET status=? WHERE id=?',[turnStatus,f.sent.turn_id!]);f.derive();expect(f.store.getIssue(f.issue.id)?.status).toBe(status);});}
  it('human and agent_dispatch pending become todo, platform pending preserves status',()=>{const f=setup();expect(f.store.getIssue(f.issue.id)?.status).toBe('todo');
    f.db.run("UPDATE multiremi_issues SET status='blocked' WHERE id=?",[f.issue.id]);f.db.run("UPDATE multiremi_conversation_log SET sender_type='platform',wake_reason='platform_to_owner' WHERE id=?",[f.sent.message.id]);f.db.run("UPDATE multiremi_turns SET wake_source='platform_to_owner' WHERE id=?",[f.sent.turn_id!]);f.derive();expect(f.store.getIssue(f.issue.id)?.status).toBe('blocked');
    f.db.run("UPDATE multiremi_conversation_log SET sender_type='agent',wake_reason='agent_dispatch' WHERE id=?",[f.sent.message.id]);f.derive();expect(f.store.getIssue(f.issue.id)?.status).toBe('todo');
    // Real writer path from the mixed-pending QA reproduction: do not replace
    // the merged-message trigger with a manually edited original trigger.
    const mergedIssue=f.store.createIssue({title:'Mixed pending',status:'blocked',assigneeType:'agent',assigneeId:f.agent.id});
    const mergedSession=f.store.getOrCreateDefaultIssueSession(mergedIssue.id);
    const base={session_id:mergedSession.id,to:{type:'agent' as const,ref:f.agent.id},wake_requested:'now' as const,body_md:'platform status'};
    const first=f.store.sendMessage({...base,sender:{type:'platform',id:null},message_kind:'status'});
    expect(f.store.getIssue(mergedIssue.id)?.status).toBe('blocked');
    const second=f.store.sendMessage({...base,sender:{type:'member',id:'mem_local_local'},message_kind:'request',body_md:'human starts work'});
    expect(second.turn_id).toBe(first.turn_id);
    expect(f.store.getIssue(mergedIssue.id)?.status).toBe('todo');});
  it('MUL-335: blocked parent transitions to todo on child to_parent_owner request (standalone or merged) while non-request preserves blocked',()=>{
    const f=setup();
    const childOwner=f.store.createAgent({name:'Child Owner',provider:'codex'});
    const parent1=f.store.createIssue({title:'Blocked parent standalone',status:'blocked',assigneeType:'agent',assigneeId:f.agent.id});
    const parent1Main=f.store.getOrCreateDefaultIssueSession(parent1.id);
    const child1=f.store.createIssue({title:'Child 1',parentIssueId:parent1.id,status:'in_progress',assigneeType:'agent',assigneeId:childOwner.id});
    const child1Main=f.store.getOrCreateDefaultIssueSession(child1.id);
    const child1Source=f.store.sendMessage({session_id:child1Main.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:childOwner.id},message_kind:'request',wake_requested:'now',body_md:'work child 1'});

    // Non-request to_parent_owner status/report keeps blocked parent blocked.
    const statusReport=f.store.sendMessage({session_id:child1Main.id,sender:{type:'agent',id:childOwner.id},source_turn_id:child1Source.turn_id,to:{type:'role',ref:'parent_owner'},message_kind:'report',wake_requested:'now',body_md:'FYI report'});
    expect(statusReport.wake_reason).toBe('to_parent_owner');
    expect(statusReport.message.session_id).toBe(parent1Main.id);
    expect(f.store.getIssue(parent1.id)?.status).toBe('blocked');

    // Direct child request on a blocked parent (no prior pending turn) moves parent to todo.
    const parent2=f.store.createIssue({title:'Blocked parent direct request',status:'blocked',assigneeType:'agent',assigneeId:f.agent.id});
    const parent2Main=f.store.getOrCreateDefaultIssueSession(parent2.id);
    const child2=f.store.createIssue({title:'Child 2',parentIssueId:parent2.id,status:'in_progress',assigneeType:'agent',assigneeId:childOwner.id});
    const child2Main=f.store.getOrCreateDefaultIssueSession(child2.id);
    const child2Source=f.store.sendMessage({session_id:child2Main.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:childOwner.id},message_kind:'request',wake_requested:'now',body_md:'work child 2'});
    const directReq=f.store.sendMessage({session_id:parent2Main.id,sender:{type:'agent',id:childOwner.id},source_turn_id:child2Source.turn_id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Child 2 needs parent action'});
    expect(directReq.wake_reason).toBe('to_parent_owner');
    expect(f.store.getIssue(parent2.id)?.status).toBe('todo');

    // Blocked parent with pending platform_to_owner turn stays blocked on platform/report, then becomes todo when a child request coalesces in.
    const parent3=f.store.createIssue({title:'Blocked parent merged pending',status:'blocked',assigneeType:'agent',assigneeId:f.agent.id});
    const parent3Main=f.store.getOrCreateDefaultIssueSession(parent3.id);
    const child3=f.store.createIssue({title:'Child 3',parentIssueId:parent3.id,status:'in_progress',assigneeType:'agent',assigneeId:childOwner.id});
    const child3Main=f.store.getOrCreateDefaultIssueSession(child3.id);
    const child3Source=f.store.sendMessage({session_id:child3Main.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:childOwner.id},message_kind:'request',wake_requested:'now',body_md:'work child 3'});
    const platformPending=f.store.sendMessage({session_id:parent3Main.id,sender:{type:'platform',id:null},to:{type:'agent',ref:f.agent.id},message_kind:'status',wake_requested:'now',body_md:'Child status notice'});
    expect(platformPending.wake_reason).toBe('platform_to_owner');
    expect(f.store.getIssue(parent3.id)?.status).toBe('blocked');
    const mergedReport=f.store.sendMessage({session_id:child3Main.id,sender:{type:'agent',id:childOwner.id},source_turn_id:child3Source.turn_id,to:{type:'role',ref:'parent_owner'},message_kind:'report',wake_requested:'now',body_md:'Non-request report coalesced'});
    expect(mergedReport.turn_id).toBe(platformPending.turn_id);
    expect(f.store.getIssue(parent3.id)?.status).toBe('blocked');
    const mergedReq=f.store.sendMessage({session_id:parent3Main.id,sender:{type:'agent',id:childOwner.id},source_turn_id:child3Source.turn_id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Child 3 requests parent coordination'});
    expect(mergedReq.wake_reason).toBe('to_parent_owner');
    expect(mergedReq.turn_id).toBe(platformPending.turn_id);
    expect(f.store.getIssue(parent3.id)?.status).toBe('todo');
  });
  it('MUL-335: re_ring pending successor derives todo when an unconsumed to_parent_owner request precedes a later platform status, while non-request report keeps blocked',()=>{
    const {store,db}=fixture();
    const parentRuntime=store.registerRuntime({name:'Parent re-ring rt',provider:'codex',workspaceId:'local'});
    const childRuntime=store.registerRuntime({name:'Child re-ring rt',provider:'codex',workspaceId:'local'});
    const parentOwner=store.createAgent({name:'Parent re-ring owner',provider:'codex',runtimeId:parentRuntime.id});
    const childOwner=store.createAgent({name:'Child re-ring owner',provider:'codex',runtimeId:childRuntime.id});

    for(const endKind of ['completed','failed'] as const){
      const parent=store.createIssue({title:`Parent re_ring ${endKind}`,status:'in_progress',assigneeType:'agent',assigneeId:parentOwner.id});
      const parentMain=store.getOrCreateDefaultIssueSession(parent.id);
      const child=store.createIssue({title:`Child re_ring ${endKind}`,parentIssueId:parent.id,status:'todo',assigneeType:'agent',assigneeId:childOwner.id});
      const childMain=store.getOrCreateDefaultIssueSession(child.id);
      const childSource=store.sendMessage({session_id:childMain.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:childOwner.id},message_kind:'request',wake_requested:'now',body_md:'work child'});

      const pStart=store.sendMessage({session_id:parentMain.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:parentOwner.id},message_kind:'request',wake_requested:'now',body_md:`Start ${endKind}`});
      const pRun=store.getTurn(pStart.turn_id!)!;
      expect(pRun.trigger_message_id).toBe(pStart.message.id);
      expect(store.claimTask(parentRuntime.id)?.id).toBe(pRun.current_attempt_id!);
      store.startTask(pRun.current_attempt_id!);
      expect(store.getIssue(parent.id)?.status).toBe('in_progress');

      // Child sends to_parent_owner request first (seq s1), then platform sends status second (seq s2); both delivered to running pRun without being consumed.
      const childReq=store.sendMessage({session_id:parentMain.id,sender:{type:'agent',id:childOwner.id},source_turn_id:childSource.turn_id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Unconsumed child request'});
      expect(childReq.wake_reason).toBe('to_parent_owner');
      expect(childReq.turn_id).toBe(pRun.id);
      const platStatus=store.sendMessage({session_id:parentMain.id,sender:{type:'platform',id:null},to:{type:'agent',ref:parentOwner.id},message_kind:'status',wake_requested:'now',body_md:'Later platform status'});
      expect(platStatus.wake_reason).toBe('platform_to_owner');
      expect(platStatus.turn_id).toBe(pRun.id);

      if(endKind==='completed'){
        store.completeTask(pRun.current_attempt_id!,{output:'Finished without reading s1/s2'});
      }else{
        store.failTask(pRun.current_attempt_id!,{error:'Failed without reading s1/s2'});
      }

      const successor=store.listTurns({workspace_id:'local',session_id:parentMain.id}).find(t=>t.status==='pending');
      expect(successor).toBeTruthy();
      expect(successor!.wake_source).toBe('re_ring');
      expect(successor!.trigger_message_id).toBe(platStatus.message.id);
      expect(store.getIssue(parent.id)?.status).toBe('todo');
      store.cancelTask(successor!.current_attempt_id!);
    }

    // Contrast: blocked parent whose re_ring unread window only has a non-request to_parent_owner report + platform status stays blocked.
    const blockedParent=store.createIssue({title:'Blocked parent re_ring report only',status:'in_progress',assigneeType:'agent',assigneeId:parentOwner.id});
    const blockedParentMain=store.getOrCreateDefaultIssueSession(blockedParent.id);
    const blockedChild=store.createIssue({title:'Child report only',parentIssueId:blockedParent.id,status:'todo',assigneeType:'agent',assigneeId:childOwner.id});
    const blockedChildMain=store.getOrCreateDefaultIssueSession(blockedChild.id);
    const blockedChildSource=store.sendMessage({session_id:blockedChildMain.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:childOwner.id},message_kind:'request',wake_requested:'now',body_md:'work blocked child'});

    const bpStart=store.sendMessage({session_id:blockedParentMain.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:parentOwner.id},message_kind:'request',wake_requested:'now',body_md:'Start blocked parent'});
    const bpRun=store.getTurn(bpStart.turn_id!)!;
    expect(bpRun.trigger_message_id).toBe(bpStart.message.id);
    expect(store.claimTask(parentRuntime.id)?.id).toBe(bpRun.current_attempt_id!);
    store.startTask(bpRun.current_attempt_id!);
    const nonReqReport=store.sendMessage({session_id:blockedChildMain.id,sender:{type:'agent',id:childOwner.id},source_turn_id:blockedChildSource.turn_id,to:{type:'role',ref:'parent_owner'},message_kind:'report',wake_requested:'now',body_md:'FYI non-request report'});
    expect(nonReqReport.wake_reason).toBe('to_parent_owner');
    expect(nonReqReport.turn_id).toBe(bpRun.id);
    const laterPlat=store.sendMessage({session_id:blockedParentMain.id,sender:{type:'platform',id:null},to:{type:'agent',ref:parentOwner.id},message_kind:'status',wake_requested:'now',body_md:'Later platform status'});
    expect(laterPlat.turn_id).toBe(bpRun.id);
    // Simulate parent already blocked before re-deriving with the non-work re_ring pending successor.
    db.run("UPDATE multiremi_issues SET status='blocked' WHERE id=?",[blockedParent.id]);
    store.failTask(bpRun.current_attempt_id!,{error:'Failed after non-request notices'});
    const blockedSucc=store.listTurns({workspace_id:'local',session_id:blockedParentMain.id}).find(t=>t.status==='pending');
    expect(blockedSucc).toBeTruthy();
    expect(blockedSucc!.wake_source).toBe('re_ring');
    expect(store.getIssue(blockedParent.id)?.status).toBe('blocked');
  });
  it('MUL-335: batched pending work-trigger check uses <= 2 turn/pending queries across 8 notification-only pending sessions',()=>{
    const {store,db}=fixture();
    const agent=store.createAgent({name:'Multi-session Owner',provider:'codex'});
    const issue=store.createIssue({title:'Multi-session notifications',status:'blocked',assigneeType:'agent',assigneeId:agent.id});
    const ctx=new StoreContext(db,()=>store);

    const sessions=[store.getOrCreateDefaultIssueSession(issue.id)];
    for(let i=1;i<8;i++){
      sessions.push(store.createIssueSession(issue.id,{title:`Side notice ${i}`,inheritMode:'none'}));
    }
    for(const sess of sessions){
      const sent=store.sendMessage({
        session_id:sess.id,
        sender:{type:'platform',id:null},
        to:{type:'agent',ref:agent.id},
        message_kind:'status',
        wake_requested:'now',
        body_md:`Status notice in ${sess.id}`,
      });
      expect(sent.wake_reason).toBe('platform_to_owner');
      expect(sent.turn_id).toBeTruthy();
    }
    expect(store.getIssue(issue.id)?.status).toBe('blocked');

    const countDeriveQueries=(targetIssueId:string)=>{
      const executedSql:string[]=[];
      const origQuery=db.query.bind(db);
      const querySpy=spyOn(db,'query').mockImplementation((sql:string)=>{
        executedSql.push(sql);
        return origQuery(sql);
      });
      let derived:{changed:boolean;previousStatus:string|null};
      try{
        derived=db.transaction(()=>{
          ctx.lockWorkspaceRuntimeLifecycle('local');
          return deriveIssueStatusWithinTransaction(ctx,targetIssueId,createCommitEventQueue());
        })();
      }finally{
        querySpy.mockRestore();
      }
      return {derived,executedSql};
    };

    const singleIssue=store.createIssue({title:'Single-session notification',status:'blocked',assigneeType:'agent',assigneeId:agent.id});
    const singleSession=store.getOrCreateDefaultIssueSession(singleIssue.id);
    store.sendMessage({
      session_id:singleSession.id,
      sender:{type:'platform',id:null},
      to:{type:'agent',ref:agent.id},
      message_kind:'status',
      wake_requested:'now',
      body_md:'Single status notice',
    });

    const singleRun=countDeriveQueries(singleIssue.id);
    const eightRun=countDeriveQueries(issue.id);
    expect(eightRun.derived.changed).toBe(false);
    expect(store.getIssue(issue.id)?.status).toBe('blocked');
    expect(eightRun.executedSql.length).toBe(singleRun.executedSql.length);

    const turnsAndPendingWorkQueries=eightRun.executedSql.filter((sql)=>
      sql.includes('AS trigger_sender')
      || sql.includes('WITH pending_checks')
      || sql.includes('multiremi_session_lanes')
      || sql.includes('delivery_turn_id'),
    );
    expect(turnsAndPendingWorkQueries.length).toBeLessThanOrEqual(2);
    expect(turnsAndPendingWorkQueries.filter((sql)=>sql.includes('WITH pending_checks'))).toHaveLength(1);
  });
  it('MUL-335: blocked Issue with 505 independent pending notification sessions avoids SQLITE_MAX_COMPOUND_SELECT and transitions to todo when 505th coalesces a request',()=>{
    const {store,db}=fixture();
    const agent=store.createAgent({name:'High-fanout Owner',provider:'codex'});
    const issue=store.createIssue({title:'505 pending sessions',status:'blocked',assigneeType:'agent',assigneeId:agent.id});

    const sessions=[store.getOrCreateDefaultIssueSession(issue.id)];
    for(let i=1;i<505;i++){
      sessions.push(store.createIssueSession(issue.id,{title:`Notice session ${i}`,inheritMode:'none'}));
    }
    const pendingTurnIds:string[]=[];
    for(let i=0;i<sessions.length;i++){
      const sent=store.sendMessage({
        session_id:sessions[i]!.id,
        sender:{type:'platform',id:null},
        to:{type:'agent',ref:agent.id},
        message_kind:'status',
        wake_requested:'now',
        body_md:`Platform status notice #${i+1}`,
      });
      expect(sent.wake_reason).toBe('platform_to_owner');
      expect(sent.turn_id).toBeTruthy();
      pendingTurnIds.push(sent.turn_id!);
    }
    expect(store.getIssue(issue.id)?.status).toBe('blocked');
    const pendingCountRow=db.query("SELECT COUNT(*) AS cnt FROM multiremi_turns WHERE issue_id=? AND status='pending'").get(issue.id) as {cnt:number};
    expect(Number(pendingCountRow.cnt)).toBe(505);

    const lastSession=sessions[504]!;
    const mergedReq=store.sendMessage({
      session_id:lastSession.id,
      sender:{type:'member',id:'mem_local_local'},
      to:{type:'agent',ref:agent.id},
      message_kind:'request',
      wake_requested:'now',
      body_md:'Work request coalesced into 505th pending session',
    });
    expect(mergedReq.wake_reason).toBe('human_sender');
    expect(mergedReq.turn_id).toBe(pendingTurnIds[504]);
    expect(store.getIssue(issue.id)?.status).toBe('todo');
    const afterCountRow=db.query("SELECT COUNT(*) AS cnt FROM multiremi_turns WHERE issue_id=? AND status='pending'").get(issue.id) as {cnt:number};
    expect(Number(afterCountRow.cnt)).toBe(505);
  },{timeout:120_000});
  // An owner question at the human stage needs a human: in_review until running work resumes.
  it('unanswered owner decision at the human stage parks the Issue in_review until work resumes',()=>{const f=setup();
    const runtime=f.store.registerRuntime({name:'Derivation native host',provider:'codex',daemonId:'derive-native'});
    const attempt=f.store.claimTask(runtime.id)!;f.store.startTask(attempt.id);
    const requested=f.store.getDaemonTurnBridge().rpc('turn.decision',{turn_id:f.sent.turn_id,attempt_id:attempt.id,wait_id:'derive-native-wait',dedupe_key:'derive-question',body_md:'Approve?',options:[],metadata:{kind:'question',questions:[{question:'Approve?'}]}},{runtimeId:runtime.id,daemonId:'derive-native',workspaceId:'local'});
    expect(requested.ok).toBe(true);const questionId=String(requested.message_id);
    expect(f.store.getIssue(f.issue.id)?.status).toBe('in_review');f.derive();expect(f.store.getIssue(f.issue.id)?.status).toBe('in_review');
    f.db.run("UPDATE multiremi_turns SET status='running' WHERE id=?",[f.sent.turn_id!]);f.derive();expect(f.store.getIssue(f.issue.id)?.status).toBe('in_progress');
    f.store.answerMessageDecision(questionId,{sender:{type:'member',id:'mem_local_local'},expected_route_revision:f.store.getQuestion(questionId)!.route_revision,body_md:'Approved',response:{answers:{'Approve?':'Approved'}}});
    expect(f.store.getMessage(questionId)?.resolved_at).not.toBeNull();expect(f.store.getIssue(f.issue.id)?.status).toBe('in_progress');});
  it('attempt mutations never derive Issue status',()=>{const f=setup();f.db.run("UPDATE multiremi_issues SET status='in_progress' WHERE id=?",[f.issue.id]);
    const before=f.store.getIssue(f.issue.id)!;for(const status of ['failed','lost','offered'])f.db.run('UPDATE multiremi_turn_attempts SET status=? WHERE turn_id=?',[status,f.sent.turn_id!]);expect(f.store.getIssue(f.issue.id)?.status).toBe(before.status);expect(f.store.getIssue(f.issue.id)?.updatedAt).toBe(before.updatedAt);});
  it('each child status transition sends its parent execution owner one status message',()=>{const f=setup();const owner=f.store.createAgent({name:'Parent execution owner',provider:'codex'}),parent=f.store.createIssue({title:'Parent',assigneeType:'agent',assigneeId:owner.id});f.store.updateIssue(f.issue.id,{parentIssueId:parent.id});
    f.db.run("UPDATE multiremi_turns SET status='running' WHERE id=?",[f.sent.turn_id!]);f.derive();const inbox=f.store.listReaderMessageInbox('agent',owner.id,'local').items;
    expect(inbox.filter(m=>m.message_kind==='status'&&m.to_ref==='parent_owner'&&m.metadata.child_issue_id===f.issue.id)).toHaveLength(1);f.derive();expect(f.store.listReaderMessageInbox('agent',owner.id,'local').items).toHaveLength(inbox.length);});
  it('folds maximum lane/read-state sequence and offset exactly once, survives removal',()=>{const f=setup();
    // Restore the historical schema before folding; PostgreSQL's final lane view retains column dependencies.
    f.db.exec('DROP VIEW IF EXISTS multiremi_agent_lane_records');
    f.db.run('DELETE FROM multiremi_schema_migrations WHERE id IN (?,?)',[FOLD_AGENT_READ_STATE_MIGRATION,'20261009_stable_execution_read_projection']);
    f.db.exec('ALTER TABLE multiremi_session_lanes DROP COLUMN cursor_offset');f.db.exec('ALTER TABLE multiremi_turns DROP COLUMN trigger_message_id');
    f.db.run('UPDATE multiremi_conversation_heads SET agent_read_state=? WHERE session_id=?',[JSON.stringify({[f.agent.id]:{seq:4,offset:19}}),f.session.id]);
    f.db.run("UPDATE multiremi_session_lanes SET cursor_seq=3 WHERE session_id=? AND reader_id=?",[f.session.id,f.agent.id]);foldAgentReadState(f.db);
    expect(f.store.getSessionAgentReadProgress(f.session.id,f.agent.id)).toEqual({seq:4,offset:19});
    f.db.exec('ALTER TABLE multiremi_conversation_heads DROP COLUMN agent_read_state');foldAgentReadState(f.db);
    expect(f.store.getSessionAgentReadProgress(f.session.id,f.agent.id)).toEqual({seq:4,offset:19});});
}, { isolation: "snapshot" });
