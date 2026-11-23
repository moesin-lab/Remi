import { createResponsibleTestAutopilot } from './helpers.js';
import { createResponsibleTestIssue } from './helpers.js';
import {it,expect} from 'bun:test';
import {pendingTurnBackendTests} from './pending-turn-test-backends.js';
pendingTurnBackendTests('MUL-506 message operations and dispatch',fixture=>{
  function setup(){const {store,db}=fixture();const a=store.createAgent({name:'A',provider:'codex'}),b=store.createAgent({name:'B',provider:'codex'});
    const issue=createResponsibleTestIssue(store, {title:'Conversation',assigneeType:'agent',assigneeId:a.id}),session=store.getOrCreateDefaultIssueSession(issue.id);
    const send=(body:string,to=b.id)=>store.sendMessage({session_id:session.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:to},message_kind:'request',wake_requested:'now',body_md:body});
    return {store,db,a,b,issue,session,send};}
  it('stores pair-limit downgrades and resumes the chain after a new member message',()=>{const f=setup();let source=f.send('start',f.a.id).turn_id!,sender=f.a.id,target=f.b.id;
    for(let i=0;i<10;i++){f.db.run("UPDATE multiremi_turns SET status='completed' WHERE id=?",[source]);
      const result=f.store.sendMessage({session_id:f.session.id,sender:{type:'agent',id:sender},source_turn_id:source,to:{type:'agent',ref:target},body_md:`dispatch ${i}`,message_kind:'request',wake_requested:'now'});
      expect(result.wake_reason).toBe('agent_dispatch');expect(result.turn_id).toBeTruthy();source=result.turn_id!;[sender,target]=[target,sender];}
    f.db.run("UPDATE multiremi_turns SET status='completed' WHERE id=?",[source]);
    const limited=f.store.sendMessage({session_id:f.session.id,sender:{type:'agent',id:sender},source_turn_id:source,to:{type:'agent',ref:target},body_md:'limit',message_kind:'request',wake_requested:'now'});
    expect(limited.wake_applied).toBe('next_turn');expect(limited.wake_reason).toBe('pair_round_trip_limit');expect(limited.turn_id).toBeUndefined();expect(f.store.getMessage(limited.message.id)?.body_md).toBe('limit');
    f.store.sendMessage({session_id:f.session.id,sender:{type:'member',id:'mem_local_local'},to:{type:'none'},message_kind:'request',wake_requested:'inbox_only',body_md:'intervene'});
    const resumed=f.store.sendMessage({session_id:f.session.id,sender:{type:'agent',id:sender},source_turn_id:source,to:{type:'agent',ref:target},body_md:'resume',message_kind:'request',wake_requested:'now'});
    expect(resumed.wake_reason).toBe('agent_dispatch');});
  it('plain agent dispatch without an Issue source is stored without a new turn',()=>{const f=setup();const result=f.store.sendMessage({session_id:f.session.id,sender:{type:'agent',id:f.a.id},to:{type:'agent',ref:f.b.id},body_md:'no source',message_kind:'request',wake_requested:'now'});
    expect(result.wake_reason).toBe('no_issue_target');expect(result.turn_id).toBeUndefined();expect(f.store.getMessage(result.message.id)).toBeTruthy();});
  it('member inbox count ignores pagination and reads only its own lane',()=>{const f=setup();const source=f.send('work',f.a.id);
    for(const kind of ['decision','status'] as const)f.store.sendMessage({session_id:f.session.id,sender:{type:'agent',id:f.a.id},source_turn_id:source.turn_id,to:{type:'member',ref:'mem_local_local'},body_md:kind,message_kind:kind,wake_requested:'now'});
    const inbox=f.store.listMessageInbox('mem_local_local','local',{limit:1});expect(inbox.items).toHaveLength(1);expect(inbox.unread_count).toBe(2);expect(inbox.attention_count).toBe(1);
    expect(f.store.readAllMessageInbox('mem_local_local','local')).toBe(1);expect(f.store.listMessageInbox('mem_local_local','local').unread_count).toBe(0);expect(f.store.getSessionAgentReadProgress(f.session.id,f.a.id).seq).toBe(0);
    expect(()=>f.store.readMessageInbox('mem_local_local',f.session.id,999)).toThrow();});
  it('edits and tombstones messages, and reactions are idempotent',()=>{const f=setup();const sent=f.send('draft');
    expect(f.store.editMessage(sent.message.id,{body_md:'edited'}).body_md).toBe('edited');expect(f.store.reactMessage(sent.message.id,{emoji:'👍',actorId:'mem_local_local'})).toHaveLength(1);
    expect(f.store.reactMessage(sent.message.id,{emoji:'👍',actorId:'mem_local_local'})).toHaveLength(1);expect(f.store.reactMessage(sent.message.id,{emoji:'👍',actorId:'mem_local_local',remove:true})).toHaveLength(0);
    expect(f.store.deleteMessage(sent.message.id).deleted_at).toBeTruthy();expect(f.store.listMessages(f.session.id)).toHaveLength(0);});
  it('Chat pending inputs merge into one turn and remain ordered in the log',()=>{const f=setup();const chat=f.store.createChatSession({agentId:f.a.id,workspaceId:'local',creatorId:'local'});
    const first=f.store.sendChatMessage(chat.id,{body:'first'}),second=f.store.sendChatMessage(chat.id,{body:'second'});
    expect(second.task.id).toBe(first.task.id);expect(f.store.listTurns({workspace_id:'local',session_id:chat.id})).toHaveLength(1);expect(f.store.listMessages(chat.id).map(m=>m.body_md)).toEqual(['first','second']);});
  it('questions and permission answers work after physically dropping the three old tables',()=>{const f=setup();for(const table of ['multiremi_task_human_requests','multiremi_issue_decisions','multiremi_task_steer_messages'])f.db.exec(`DROP TABLE ${table}`);
    const runtime=f.store.registerRuntime({name:'Permission host',provider:'codex',daemonId:'permission-host'});
    f.store.updateAgent(f.a.id,{runtimeId:runtime.id});
    const sent=f.send('work',f.a.id),turn=f.store.getTurn(sent.turn_id!)!,attemptId=turn.current_attempt_id!;
    expect(f.store.claimTask(runtime.id)?.id).toBe(attemptId);f.store.startTask(attemptId);
    const result=f.store.getDaemonTurnBridge().rpc('turn.decision',{turn_id:turn.id,attempt_id:attemptId,
      wait_id:`permission_${attemptId}`,dedupe_key:`permission:${attemptId}`,body_md:'May I run?',
      options:[{label:'Allow',value:'allow'}],metadata:{kind:'permission',permission:'run',
        options:[{optionId:'allow',name:'Allow',kind:'allow_once'}]},timeout_ms:50},
      {runtimeId:runtime.id,daemonId:runtime.daemonId!,workspaceId:'local'});
    expect(result.ok).toBe(true);
    const request=f.store.getQuestion(String(result.message_id))!;
    // The asker executes this root, so the request waits at the human stage for any active member.
    expect(request).toMatchObject({stage:'human',current_handler:null});
    expect(f.store.getMessage(request.id)?.message_kind).toBe('decision');
    expect(()=>f.store.respondTaskHumanRequest(request.id,{response:{option_id:'forged'},respondedBy:'mem_local_local',expectedRouteRevision:request.route_revision})).toThrow('invalid human response');
    expect(f.store.respondTaskHumanRequest(request.id,{response:{option_id:'allow'},respondedBy:'mem_local_local',expectedRouteRevision:request.route_revision})?.status).toBe('responded');
    expect(f.store.getQuestion(request.id)?.answer_revision).toBe(1);});
  it('Autopilot inputs use one canonical message and independent run lanes',()=>{const f=setup();
    const auto=createResponsibleTestAutopilot(f.store, {title:'Runs',assigneeId:f.a.id,executionMode:'run_only'});
    const one=f.store.runAutopilot(auto.id,{prompt:'one'}),two=f.store.runAutopilot(auto.id,{prompt:'two'});
    // Each run_only run executes in a Chat of its own; the automation log keeps only the triggers.
    expect(one.chatSessionId).toBeTruthy();expect(two.chatSessionId).not.toBe(one.chatSessionId);
    expect(f.store.listMessages(`auto_${auto.id}`).filter(m=>m.message_kind==='request').map(m=>m.body_md)).toEqual(['one','two']);
    expect(f.store.listTurns({workspace_id:'local',session_id:`auto_${auto.id}`})).toHaveLength(0);
    for(const run of [one,two]){const task=f.store.getTask(run.taskId!)!;
      const turn=f.store.listTurns({workspace_id:'local',session_id:run.chatSessionId!}).find(t=>t.current_attempt_id===task.id);
      expect(turn?.trigger_message_id).toBeTruthy();
      expect(f.store.listMessages(run.chatSessionId!).filter(m=>m.message_kind==='request').map(m=>m.body_md)).toEqual([run===one?'one':'two']);}
    const issueAuto=createResponsibleTestAutopilot(f.store, {title:'Issue run',assigneeId:f.b.id,executionMode:'create_issue'}),run=f.store.runAutopilot(issueAuto.id,{prompt:'Issue request'});
    expect(f.store.listMessages(f.store.getOrCreateDefaultIssueSession(run.issueId!).id)).toHaveLength(1);
    expect(f.store.listMessages(`auto_${issueAuto.id}`)[0]?.message_kind).toBe('request');
    expect(f.store.listMessages(`auto_${issueAuto.id}`)[0]?.body_md).toBe('Issue request');
  });

  it('MUL-335: child request to ancestor parent owner Main session uses default coordinator lane without dlg_ scope or reverse delegation',()=>{
    const {store}=fixture();
    const coordinatorRuntime=store.registerRuntime({name:'Coordinator runtime',provider:'codex',workspaceId:'local'});
    const workerRuntime=store.registerRuntime({name:'Worker runtime',provider:'codex',workspaceId:'local'});
    const coordinator=store.createAgent({name:'Coordinator',provider:'codex',runtimeId:coordinatorRuntime.id});
    const dev1=store.createAgent({name:'Dev 1',provider:'codex',runtimeId:workerRuntime.id});
    const dev2=store.createAgent({name:'Dev 2',provider:'codex',runtimeId:workerRuntime.id});
    const bystander=store.createAgent({name:'Bystander',provider:'codex',runtimeId:workerRuntime.id});

    const parent=createResponsibleTestIssue(store,{title:'Parent MUL-327',status:'in_progress',assigneeType:'agent',assigneeId:coordinator.id});
    const parentMain=store.getOrCreateDefaultIssueSession(parent.id);
    const parentAux=store.createIssueSession(parent.id,{title:'Auxiliary parent session'});
    const child1=createResponsibleTestIssue(store,{title:'Child MUL-328',parentIssueId:parent.id,status:'todo',assigneeType:'agent',assigneeId:dev1.id});
    const child1Session=store.getOrCreateDefaultIssueSession(child1.id);
    const child2=createResponsibleTestIssue(store,{title:'Child MUL-329',parentIssueId:parent.id,status:'todo',assigneeType:'agent',assigneeId:dev2.id});
    const child2Session=store.getOrCreateDefaultIssueSession(child2.id);
    const unassignedMid=createResponsibleTestIssue(store,{title:'Unassigned mid',parentIssueId:parent.id,status:'in_progress'});
    const grandchild=createResponsibleTestIssue(store,{title:'Grandchild',parentIssueId:unassignedMid.id,status:'todo',assigneeType:'agent',assigneeId:dev1.id});
    const grandchildSession=store.getOrCreateDefaultIssueSession(grandchild.id);

    const child1Source=store.sendMessage({session_id:child1Session.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:dev1.id},message_kind:'request',wake_requested:'now',body_md:'start child 1'});
    const grandchildSource=store.sendMessage({session_id:grandchildSession.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:dev1.id},message_kind:'request',wake_requested:'now',body_md:'start grandchild'});
    expect(store.listTurns({workspace_id:'local',session_id:parentMain.id})).toHaveLength(0);

    // 1. Direct repro: child sends --to issue-owner --kind request to idle parent Main session.
    const reportReq=store.sendMessage({
      session_id:parentMain.id,
      sender:{type:'agent',id:dev1.id},
      source_turn_id:child1Source.turn_id,
      to:{type:'role',ref:'issue_owner'},
      message_kind:'request',
      wake_requested:'now',
      body_md:'Child 1 ready for review',
    });
    expect(reportReq.wake_applied).toBe('now');
    expect(reportReq.wake_reason).toBe('to_parent_owner');
    expect(reportReq.message.metadata.execution_scope).toBe('');
    expect(reportReq.turn_id).toBeTruthy();

    const parentTurn=store.getTurn(reportReq.turn_id!)!;
    expect(parentTurn).toMatchObject({
      session_id:parentMain.id,
      agent_id:coordinator.id,
      execution_scope:'',
      delegation_id:null,
      delegated_by_agent_id:null,
      delegated_from_issue_session_id:null,
      wake_source:'to_parent_owner',
    });

    // Claim & start coordinator turn; concurrent child status notice must share the same running lane (no dual running turns).
    expect(store.claimTask(coordinatorRuntime.id)?.id).toBe(parentTurn.current_attempt_id!);
    store.startTask(parentTurn.current_attempt_id!);

    const statusNotice=store.sendMessage({
      session_id:child2Session.id,
      sender:{type:'platform',id:null},
      to:{type:'role',ref:'parent_owner'},
      message_kind:'status',
      wake_requested:'now',
      body_md:'Child 2 moved to in_review',
    });
    expect(statusNotice.wake_applied).toBe('now');
    expect(statusNotice.wake_reason).toBe('platform_to_owner');
    expect(statusNotice.message.session_id).toBe(parentMain.id);
    expect(statusNotice.turn_id).toBe(parentTurn.id);
    expect(store.listTurns({workspace_id:'local',session_id:parentMain.id}).filter(t=>['pending','running'].includes(t.status))).toHaveLength(1);

    // Direct --to <parent-owner>, --to parent-owner from child, and grandchild -> grandparent all join the same default lane.
    for(const upward of [
      {session_id:parentMain.id,source_turn_id:child1Source.turn_id,to:{type:'agent' as const,ref:coordinator.id},body_md:'Direct parent owner id'},
      {session_id:child1Session.id,source_turn_id:child1Source.turn_id,to:{type:'role' as const,ref:'parent_owner' as const},body_md:'Parent owner role'},
      {session_id:parentMain.id,source_turn_id:grandchildSource.turn_id,to:{type:'role' as const,ref:'issue_owner' as const},body_md:'Grandchild to grandparent issue_owner'},
      {session_id:parentMain.id,source_turn_id:grandchildSource.turn_id,to:{type:'agent' as const,ref:coordinator.id},body_md:'Grandchild to grandparent owner id'},
    ]){
      const res=store.sendMessage({
        session_id:upward.session_id,
        sender:{type:'agent',id:dev1.id},
        source_turn_id:upward.source_turn_id,
        to:upward.to,
        message_kind:'request',
        wake_requested:'now',
        body_md:upward.body_md,
      });
      expect(res.wake_applied).toBe('now');
      expect(res.wake_reason).toBe('to_parent_owner');
      expect(res.message.session_id).toBe(parentMain.id);
      expect(res.message.metadata.execution_scope).toBe('');
      expect(res.turn_id).toBe(parentTurn.id);
    }
    expect(store.listTurns({workspace_id:'local',session_id:parentMain.id}).filter(t=>['pending','running'].includes(t.status))).toHaveLength(1);

    // Completing the coordinator turn must NOT send any reverse delegation completion report to child1.
    const child1MessagesBefore=store.listMessages(child1Session.id).length;
    store.completeTask(parentTurn.current_attempt_id!,{output:'Coordinator reviewed children'});
    expect(store.getTask(parentTurn.current_attempt_id!)?.delegationReturnTaskId).toBeNull();
    expect(store.listMessages(child1Session.id)).toHaveLength(child1MessagesBefore);

    // When a pending platform_to_owner turn already exists on parentMain, a child request coalesces into it.
    const pendingPlatform=store.listTurns({workspace_id:'local',session_id:parentMain.id}).find(t=>t.status==='pending');
    expect(pendingPlatform?.execution_scope).toBe('');
    const coalesced=store.sendMessage({
      session_id:parentMain.id,
      sender:{type:'agent',id:dev1.id},
      source_turn_id:child1Source.turn_id,
      to:{type:'role',ref:'issue_owner'},
      message_kind:'request',
      wake_requested:'now',
      body_md:'Follow-up while parent turn is pending',
    });
    expect(coalesced.wake_reason).toBe('to_parent_owner');
    expect(coalesced.message.metadata.execution_scope).toBe('');
    expect(coalesced.turn_id).toBe(pendingPlatform!.id);
    expect(store.listTurns({workspace_id:'local',session_id:parentMain.id}).filter(t=>['pending','running'].includes(t.status))).toHaveLength(1);

    // 2. Negative boundaries: downward, sibling, non-owner on parent, explicit scope, and non-default parent session stay agent_dispatch with dlg_* scope.
    const downward=store.sendMessage({
      session_id:child2Session.id,
      sender:{type:'agent',id:coordinator.id},
      source_turn_id:parentTurn.id,
      to:{type:'role',ref:'issue_owner'},
      message_kind:'request',
      wake_requested:'now',
      body_md:'Parent dispatching child 2',
    });
    expect(downward.wake_reason).toBe('agent_dispatch');
    expect(String(downward.message.metadata.execution_scope)).toStartWith('dlg_');
    expect(store.getTurn(downward.turn_id!)!).toMatchObject({delegated_by_agent_id:coordinator.id,delegated_from_issue_session_id:parentMain.id});

    const sibling=store.sendMessage({
      session_id:child2Session.id,
      sender:{type:'agent',id:dev1.id},
      source_turn_id:child1Source.turn_id,
      to:{type:'role',ref:'issue_owner'},
      message_kind:'request',
      wake_requested:'now',
      body_md:'Child 1 dispatching sibling child 2',
    });
    expect(sibling.wake_reason).toBe('agent_dispatch');
    expect(String(sibling.message.metadata.execution_scope)).toStartWith('dlg_');
    expect(store.getTurn(sibling.turn_id!)!).toMatchObject({delegated_by_agent_id:dev1.id,delegated_from_issue_session_id:child1Session.id});

    const nonOwnerOnParent=store.sendMessage({
      session_id:parentMain.id,
      sender:{type:'agent',id:dev1.id},
      source_turn_id:child1Source.turn_id,
      to:{type:'agent',ref:bystander.id},
      message_kind:'request',
      wake_requested:'now',
      body_md:'Child 1 dispatching non-owner on parent',
    });
    expect(nonOwnerOnParent.wake_reason).toBe('agent_dispatch');
    expect(String(nonOwnerOnParent.message.metadata.execution_scope)).toStartWith('dlg_');
    expect(store.getTurn(nonOwnerOnParent.turn_id!)!).toMatchObject({delegated_by_agent_id:dev1.id});

    const explicitScope=store.sendMessage({
      session_id:parentMain.id,
      sender:{type:'agent',id:dev1.id},
      source_turn_id:child1Source.turn_id,
      to:{type:'role',ref:'issue_owner'},
      message_kind:'request',
      wake_requested:'now',
      execution_scope:'dlg_explicit_scope',
      body_md:'Child 1 with explicit custom scope',
    });
    expect(explicitScope.wake_reason).toBe('agent_dispatch');
    expect(explicitScope.message.metadata.execution_scope).toBe('dlg_explicit_scope');
    expect(store.getTurn(explicitScope.turn_id!)!).toMatchObject({execution_scope:'dlg_explicit_scope',delegated_by_agent_id:dev1.id});

    const nonDefaultParentSession=store.sendMessage({
      session_id:parentAux.id,
      sender:{type:'agent',id:dev1.id},
      source_turn_id:child1Source.turn_id,
      to:{type:'agent',ref:coordinator.id},
      message_kind:'request',
      wake_requested:'now',
      body_md:'Child 1 targeting auxiliary parent session',
    });
    expect(nonDefaultParentSession.wake_reason).toBe('agent_dispatch');
    expect(String(nonDefaultParentSession.message.metadata.execution_scope)).toStartWith('dlg_');
    expect(store.getTurn(nonDefaultParentSession.turn_id!)!).toMatchObject({delegated_by_agent_id:dev1.id});
  });

}, { isolation: "snapshot", file: import.meta.path });
