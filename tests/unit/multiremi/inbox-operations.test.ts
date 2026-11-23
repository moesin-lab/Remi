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

    // Explicit custom execution_scope + role parent_owner stays agent_dispatch with full delegation lineage.
    const child2Source=store.sendMessage({session_id:child2Session.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:dev2.id},message_kind:'request',wake_requested:'now',body_md:'start child 2'});
    const explicitParentOwnerScope=store.sendMessage({
      session_id:child2Session.id,
      sender:{type:'agent',id:dev2.id},
      source_turn_id:child2Source.turn_id,
      to:{type:'role',ref:'parent_owner'},
      message_kind:'request',
      wake_requested:'now',
      execution_scope:'dlg_custom',
      body_md:'Child 2 role parent_owner with custom scope',
    });
    expect(explicitParentOwnerScope.wake_reason).toBe('agent_dispatch');
    expect(explicitParentOwnerScope.message.session_id).toBe(parentMain.id);
    expect(explicitParentOwnerScope.message.metadata.execution_scope).toBe('dlg_custom');
    expect(store.getTurn(explicitParentOwnerScope.turn_id!)!).toMatchObject({
      execution_scope:'dlg_custom',
      delegation_id:'dlg_custom',
      delegated_by_agent_id:dev2.id,
      delegated_from_issue_session_id:child2Session.id,
    });

    // Non-request ordinary report directly to parent Main keeps baseline main semantics (next_turn / agent_pair_not_privileged) and never creates a turn when idle.
    const idleParent=createResponsibleTestIssue(store,{title:'Idle Parent for report check',status:'in_progress',assigneeType:'agent',assigneeId:coordinator.id});
    const idleParentMain=store.getOrCreateDefaultIssueSession(idleParent.id);
    const idleChild=createResponsibleTestIssue(store,{title:'Idle Child for report check',parentIssueId:idleParent.id,status:'todo',assigneeType:'agent',assigneeId:dev1.id});
    const idleChildMain=store.getOrCreateDefaultIssueSession(idleChild.id);
    const idleChildSource=store.sendMessage({session_id:idleChildMain.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:dev1.id},message_kind:'request',wake_requested:'now',body_md:'start idle child'});
    for(const reportTo of [{type:'role' as const,ref:'issue_owner' as const},{type:'agent' as const,ref:coordinator.id}]){
      const directReport=store.sendMessage({
        session_id:idleParentMain.id,
        sender:{type:'agent',id:dev1.id},
        source_turn_id:idleChildSource.turn_id,
        to:reportTo,
        message_kind:'report',
        wake_requested:'now',
        body_md:'Direct non-request report to parent Main',
      });
      expect(directReport.wake_applied).toBe('next_turn');
      expect(directReport.wake_reason).toBe('agent_pair_not_privileged');
      expect(directReport.turn_id).toBeUndefined();
    }
    // Contrast: non-request report on child's own session to parent_owner keeps baseline now / to_parent_owner.
    const childOwnReport=store.sendMessage({
      session_id:idleChildMain.id,
      sender:{type:'agent',id:dev1.id},
      source_turn_id:idleChildSource.turn_id,
      to:{type:'role',ref:'parent_owner'},
      message_kind:'report',
      wake_requested:'now',
      body_md:'Child-session report to parent_owner',
    });
    expect(childOwnReport.wake_applied).toBe('now');
    expect(childOwnReport.wake_reason).toBe('to_parent_owner');
    expect(childOwnReport.message.session_id).toBe(idleParentMain.id);
  });

  it('MUL-335: pair_round_trip_limit counts parent to_parent_owner turns in memory without persisting reverse delegation',()=>{
    const prevLimit=process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT;
    process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT='1';
    try{
      const {store}=fixture();
      const parentRuntime=store.registerRuntime({name:'Parent rt',provider:'codex',workspaceId:'local'});
      const childRuntime=store.registerRuntime({name:'Child rt',provider:'codex',workspaceId:'local'});
      const parentAgent=store.createAgent({name:'Parent Coord',provider:'codex',runtimeId:parentRuntime.id});
      const childAgent=store.createAgent({name:'Child Worker',provider:'codex',runtimeId:childRuntime.id});
      const parent=createResponsibleTestIssue(store,{title:'Parent P',status:'in_progress',assigneeType:'agent',assigneeId:parentAgent.id});
      const parentMain=store.getOrCreateDefaultIssueSession(parent.id);
      const child=createResponsibleTestIssue(store,{title:'Child C',parentIssueId:parent.id,status:'todo',assigneeType:'agent',assigneeId:childAgent.id});
      const childMain=store.getOrCreateDefaultIssueSession(child.id);

      // 1. Parent runs and dispatches child (hop 1: C delegated by P).
      const parentTask0=store.createTask({agentId:parentAgent.id,issueId:parent.id,issueSessionId:parentMain.id,prompt:'Coordinate P'});
      expect(store.claimTask(parentRuntime.id)?.id).toBe(parentTask0.id);
      store.startTask(parentTask0.id);
      const dispatch1=store.sendMessage({
        session_id:childMain.id,
        sender:{type:'agent',id:parentAgent.id},
        source_turn_id:parentTask0.id,
        to:{type:'role',ref:'issue_owner'},
        message_kind:'request',
        wake_requested:'now',
        body_md:'First dispatch to child',
      });
      expect(dispatch1.wake_reason).toBe('agent_dispatch');
      store.completeTask(parentTask0.id,{output:'Dispatched'});

      // 2. Child runs and sends --to issue-owner --kind request to Parent Main (to_parent_owner, no persisted delegation fields).
      const childTurn1=store.getTurn(dispatch1.turn_id!)!;
      expect(store.claimTask(childRuntime.id)?.id).toBe(childTurn1.current_attempt_id!);
      store.startTask(childTurn1.current_attempt_id!);
      const upwardReq=store.sendMessage({
        session_id:parentMain.id,
        sender:{type:'agent',id:childAgent.id},
        source_turn_id:childTurn1.id,
        to:{type:'role',ref:'issue_owner'},
        message_kind:'request',
        wake_requested:'now',
        body_md:'Child asks parent to coordinate',
      });
      expect(upwardReq.wake_applied).toBe('now');
      expect(upwardReq.wake_reason).toBe('to_parent_owner');
      const parentTurn1=store.getTurn(upwardReq.turn_id!)!;
      expect(parentTurn1).toMatchObject({
        execution_scope:'',
        delegation_id:null,
        delegated_by_agent_id:null,
        delegated_from_issue_session_id:null,
      });
      store.completeTask(childTurn1.current_attempt_id!,{output:'Child reported'});

      // 3. Parent runs on parentTurn1 and attempts to dispatch child again: L=1 => 2 hops => pair_round_trip_limit.
      expect(store.claimTask(parentRuntime.id)?.id).toBe(parentTurn1.current_attempt_id!);
      store.startTask(parentTurn1.current_attempt_id!);
      const dispatch2=store.sendMessage({
        session_id:childMain.id,
        sender:{type:'agent',id:parentAgent.id},
        source_turn_id:parentTurn1.id,
        to:{type:'role',ref:'issue_owner'},
        message_kind:'request',
        wake_requested:'now',
        body_md:'Second dispatch should hit pair limit',
      });
      expect(dispatch2.wake_applied).toBe('next_turn');
      expect(dispatch2.wake_reason).toBe('pair_round_trip_limit');
      expect(dispatch2.turn_id).toBeUndefined();

      // Completing parentTurn1 must still NOT send any reverse delegation return bell to childMain.
      const childMsgsBefore=store.listMessages(childMain.id).length;
      store.completeTask(parentTurn1.current_attempt_id!,{output:'Waiting on human'});
      expect(store.getTask(parentTurn1.current_attempt_id!)?.delegationReturnTaskId).toBeNull();
      expect(store.listMessages(childMain.id)).toHaveLength(childMsgsBefore);

      // Direct trigger path (no prior platform_to_owner pending turn): child already in_progress sends to_parent_owner directly.
      const parentDirect=createResponsibleTestIssue(store,{title:'Parent Direct',status:'in_progress',assigneeType:'agent',assigneeId:parentAgent.id});
      const parentDirectMain=store.getOrCreateDefaultIssueSession(parentDirect.id);
      const childDirect=createResponsibleTestIssue(store,{title:'Child Direct',parentIssueId:parentDirect.id,status:'in_progress',assigneeType:'agent',assigneeId:childAgent.id});
      const childDirectMain=store.getOrCreateDefaultIssueSession(childDirect.id);
      const pd0=store.createTask({agentId:parentAgent.id,issueId:parentDirect.id,issueSessionId:parentDirectMain.id,prompt:'Coord direct'});
      expect(store.claimTask(parentRuntime.id)?.id).toBe(pd0.id);
      store.startTask(pd0.id);
      const dd1=store.sendMessage({session_id:childDirectMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:pd0.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Direct dispatch 1'});
      const cd1=store.getTurn(dd1.turn_id!)!;
      expect(store.claimTask(childRuntime.id)?.id).toBe(cd1.current_attempt_id!);
      store.startTask(cd1.current_attempt_id!);
      // Complete pd0 after cd1 is already running so parentDirectMain is completely idle when directUp arrives.
      store.completeTask(pd0.id,{output:'Dispatched direct'});
      for(const pending of store.listTurns({workspace_id:'local',session_id:parentDirectMain.id}).filter(t=>t.status==='pending')){
        expect(store.claimTask(parentRuntime.id)?.id).toBe(pending.current_attempt_id!);
        store.startTask(pending.current_attempt_id!);
        store.completeTask(pending.current_attempt_id!,{output:'Drained status notice'});
      }
      const directUp=store.sendMessage({session_id:parentDirectMain.id,sender:{type:'agent',id:childAgent.id},source_turn_id:cd1.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Direct upward request'});
      const pd1=store.getTurn(directUp.turn_id!)!;
      expect(pd1.trigger_message_id).toBe(directUp.message.id);
      expect(pd1).toMatchObject({execution_scope:'',delegation_id:null,delegated_by_agent_id:null});
      store.completeTask(cd1.current_attempt_id!,{output:'Child direct done'});
      expect(store.claimTask(parentRuntime.id)?.id).toBe(pd1.current_attempt_id!);
      store.startTask(pd1.current_attempt_id!);
      const dd2=store.sendMessage({session_id:childDirectMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:pd1.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Direct dispatch 2 hits limit'});
      expect(dd2.wake_applied).toBe('next_turn');
      expect(dd2.wake_reason).toBe('pair_round_trip_limit');
      expect(dd2.turn_id).toBeUndefined();
    }finally{
      if(prevLimit===undefined)delete process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT;
      else process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT=prevLimit;
    }
  });

  it('MUL-335: member-started running P0 enforces pair_round_trip_limit for L=1 and L=2 (resetting on member intervention) and ignores non-request parent_owner reports',()=>{
    const prevLimit=process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT;
    try{
      const {store}=fixture();
      const makePair=(tag:string)=>{
        const parentRuntime=store.registerRuntime({name:`Parent rt ${tag}`,provider:'codex',workspaceId:'local'});
        const childRuntime=store.registerRuntime({name:`Child rt ${tag}`,provider:'codex',workspaceId:'local'});
        const parentAgent=store.createAgent({name:`Parent ${tag}`,provider:'codex',runtimeId:parentRuntime.id});
        const childAgent=store.createAgent({name:`Child ${tag}`,provider:'codex',runtimeId:childRuntime.id});
        return {parentRuntime,childRuntime,parentAgent,childAgent};
      };

      const runContinuousParentLoop=(limitVal:number)=>{
        process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT=String(limitVal);
        const {parentRuntime,childRuntime,parentAgent,childAgent}=makePair(`loop-${limitVal}`);
        const parent=createResponsibleTestIssue(store,{title:`Running P0 L=${limitVal}`,status:'in_progress',assigneeType:'agent',assigneeId:parentAgent.id});
        const parentMain=store.getOrCreateDefaultIssueSession(parent.id);
        const child=createResponsibleTestIssue(store,{title:`Running Child L=${limitVal}`,parentIssueId:parent.id,status:'todo',assigneeType:'agent',assigneeId:childAgent.id});
        const childMain=store.getOrCreateDefaultIssueSession(child.id);

        // Member starts P0 and P0 stays running across rounds.
        const startP0=store.sendMessage({
          session_id:parentMain.id,
          sender:{type:'member',id:'mem_local_local'},
          to:{type:'agent',ref:parentAgent.id},
          message_kind:'request',
          wake_requested:'now',
          body_md:'Member starts coordinator P0',
        });
        const p0=store.getTurn(startP0.turn_id!)!;
        expect(store.claimTask(parentRuntime.id)?.id).toBe(p0.current_attempt_id!);
        store.startTask(p0.current_attempt_id!);

        for(let round=1;round<=limitVal;round++){
          const disp=store.sendMessage({
            session_id:childMain.id,
            sender:{type:'agent',id:parentAgent.id},
            source_turn_id:p0.id,
            to:{type:'role',ref:'issue_owner'},
            message_kind:'request',
            wake_requested:'now',
            body_md:`Round ${round} dispatch`,
          });
          expect(disp.wake_applied).toBe('now');
          expect(disp.wake_reason).toBe('agent_dispatch');
          const childTurn=store.getTurn(disp.turn_id!)!;
          expect(store.claimTask(childRuntime.id)?.id).toBe(childTurn.current_attempt_id!);
          store.startTask(childTurn.current_attempt_id!);

          const upward=store.sendMessage({
            session_id:parentMain.id,
            sender:{type:'agent',id:childAgent.id},
            source_turn_id:childTurn.id,
            to:{type:'role',ref:'issue_owner'},
            message_kind:'request',
            wake_requested:'now',
            body_md:`Round ${round} child request into running P0`,
          });
          expect(upward.wake_applied).toBe('now');
          expect(upward.wake_reason).toBe('to_parent_owner');
          expect(upward.turn_id).toBe(p0.id);
          store.completeTask(childTurn.current_attempt_id!,{output:`Child round ${round} done`});
        }

        // Dispatch (limitVal + 1) from the still-running P0 must hit pair_round_trip_limit.
        const blocked=store.sendMessage({
          session_id:childMain.id,
          sender:{type:'agent',id:parentAgent.id},
          source_turn_id:p0.id,
          to:{type:'role',ref:'issue_owner'},
          message_kind:'request',
          wake_requested:'now',
          body_md:`Blocked dispatch at L=${limitVal}`,
        });
        expect(blocked.wake_applied).toBe('next_turn');
        expect(blocked.wake_reason).toBe('pair_round_trip_limit');
        expect(blocked.turn_id).toBeUndefined();

        // Member intervention in parentMain resets the pair counter even in the same millisecond.
        store.sendMessage({
          session_id:parentMain.id,
          sender:{type:'member',id:'mem_local_local'},
          to:{type:'none'},
          message_kind:'request',
          wake_requested:'inbox_only',
          body_md:`Member intervenes at L=${limitVal}`,
        });
        const resumed=store.sendMessage({
          session_id:childMain.id,
          sender:{type:'agent',id:parentAgent.id},
          source_turn_id:p0.id,
          to:{type:'role',ref:'issue_owner'},
          message_kind:'request',
          wake_requested:'now',
          body_md:`Resumed dispatch after member intervention at L=${limitVal}`,
        });
        expect(resumed.wake_applied).toBe('now');
        expect(resumed.wake_reason).toBe('agent_dispatch');
        expect(resumed.turn_id).toBeTruthy();
      };

      runContinuousParentLoop(1);
      runContinuousParentLoop(2);

      // re_ring successor turn (triggered by a later platform status after an unconsumed to_parent_owner request)
      // must also count the unconsumed child request hop at L=1.
      process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT='1';
      {
        const {parentRuntime,childRuntime,parentAgent,childAgent}=makePair('re-ring');
        const parent=createResponsibleTestIssue(store,{title:'ReRing Parent L=1',status:'in_progress',assigneeType:'agent',assigneeId:parentAgent.id});
        const parentMain=store.getOrCreateDefaultIssueSession(parent.id);
        const child=createResponsibleTestIssue(store,{title:'ReRing Child L=1',parentIssueId:parent.id,status:'in_progress',assigneeType:'agent',assigneeId:childAgent.id});
        const childMain=store.getOrCreateDefaultIssueSession(child.id);
        const pStart=store.sendMessage({session_id:parentMain.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:parentAgent.id},message_kind:'request',wake_requested:'now',body_md:'Start re_ring parent'});
        const p0=store.getTurn(pStart.turn_id!)!;
        expect(store.claimTask(parentRuntime.id)?.id).toBe(p0.current_attempt_id!);
        store.startTask(p0.current_attempt_id!);
        const d1=store.sendMessage({session_id:childMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:p0.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Dispatch for re_ring'});
        const c1=store.getTurn(d1.turn_id!)!;
        expect(store.claimTask(childRuntime.id)?.id).toBe(c1.current_attempt_id!);
        store.startTask(c1.current_attempt_id!);
        const req1=store.sendMessage({session_id:parentMain.id,sender:{type:'agent',id:childAgent.id},source_turn_id:c1.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Unconsumed request before platform status'});
        expect(req1.turn_id).toBe(p0.id);
        const plat=store.sendMessage({session_id:parentMain.id,sender:{type:'platform',id:null},to:{type:'agent',ref:parentAgent.id},message_kind:'status',wake_requested:'now',body_md:'Later platform status'});
        expect(plat.turn_id).toBe(p0.id);
        store.completeTask(c1.current_attempt_id!,{output:'Child done'});
        store.completeTask(p0.current_attempt_id!,{output:'Parent done without reading req1'});
        const pSucc=store.listTurns({workspace_id:'local',session_id:parentMain.id}).find(t=>t.status==='pending')!;
        expect(pSucc.wake_source).toBe('re_ring');
        expect(store.claimTask(parentRuntime.id)?.id).toBe(pSucc.current_attempt_id!);
        store.startTask(pSucc.current_attempt_id!);
        const d2=store.sendMessage({session_id:childMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:pSucc.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Second dispatch from re_ring successor hits L=1'});
        expect(d2.wake_applied).toBe('next_turn');
        expect(d2.wake_reason).toBe('pair_round_trip_limit');
        expect(d2.turn_id).toBeUndefined();
      }

      // Non-request --to parent-owner --kind report (both standalone idle trigger and merged into pending platform turn)
      // must NEVER count as delegation hops or trigger pair_round_trip_limit at L=1.
      process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT='1';
      for(const mode of ['standalone','merged_platform'] as const){
        const {parentRuntime,childRuntime,parentAgent,childAgent}=makePair(`report-${mode}`);
        const parent=createResponsibleTestIssue(store,{title:`Report non-hop ${mode}`,status:'in_progress',assigneeType:'agent',assigneeId:parentAgent.id});
        const parentMain=store.getOrCreateDefaultIssueSession(parent.id);
        const child=createResponsibleTestIssue(store,{title:`Child report ${mode}`,parentIssueId:parent.id,status:'in_progress',assigneeType:'agent',assigneeId:childAgent.id});
        const childMain=store.getOrCreateDefaultIssueSession(child.id);

        const pStart=store.createTask({agentId:parentAgent.id,issueId:parent.id,issueSessionId:parentMain.id,prompt:`Start ${mode}`});
        expect(store.claimTask(parentRuntime.id)?.id).toBe(pStart.id);
        store.startTask(pStart.id);
        const firstDisp=store.sendMessage({
          session_id:childMain.id,
          sender:{type:'agent',id:parentAgent.id},
          source_turn_id:pStart.id,
          to:{type:'role',ref:'issue_owner'},
          message_kind:'request',
          wake_requested:'now',
          body_md:'Initial dispatch',
        });
        expect(firstDisp.wake_reason).toBe('agent_dispatch');
        const cTurn=store.getTurn(firstDisp.turn_id!)!;
        expect(store.claimTask(childRuntime.id)?.id).toBe(cTurn.current_attempt_id!);
        store.startTask(cTurn.current_attempt_id!);
        store.completeTask(pStart.id,{output:'Parent finished first round'});
        for(const pending of store.listTurns({workspace_id:'local',session_id:parentMain.id}).filter(t=>t.status==='pending')){
          store.cancelTask(pending.current_attempt_id!);
        }

        let expectedParentTurnId:string|undefined;
        if(mode==='merged_platform'){
          const plat=store.sendMessage({
            session_id:parentMain.id,
            sender:{type:'platform',id:null},
            to:{type:'agent',ref:parentAgent.id},
            message_kind:'status',
            wake_requested:'now',
            body_md:'Platform status creates pending parent turn',
          });
          expectedParentTurnId=plat.turn_id;
        }

        const reportMsg=store.sendMessage({
          session_id:childMain.id,
          sender:{type:'agent',id:childAgent.id},
          source_turn_id:cTurn.id,
          to:{type:'role',ref:'parent_owner'},
          message_kind:'report',
          wake_requested:'now',
          body_md:`Ordinary report (${mode})`,
        });
        expect(reportMsg.wake_applied).toBe('now');
        expect(reportMsg.wake_reason).toBe('to_parent_owner');
        expect(reportMsg.message.session_id).toBe(parentMain.id);
        if(mode==='merged_platform')expect(reportMsg.turn_id).toBe(expectedParentTurnId);
        const parentNextTurn=store.getTurn(reportMsg.turn_id!)!;
        store.completeTask(cTurn.current_attempt_id!,{output:'Child finished'});

        expect(store.claimTask(parentRuntime.id)?.id).toBe(parentNextTurn.current_attempt_id!);
        store.startTask(parentNextTurn.current_attempt_id!);
        const secondDisp=store.sendMessage({
          session_id:childMain.id,
          sender:{type:'agent',id:parentAgent.id},
          source_turn_id:parentNextTurn.id,
          to:{type:'role',ref:'issue_owner'},
          message_kind:'request',
          wake_requested:'now',
          body_md:`Second dispatch after non-request report (${mode}) must succeed`,
        });
        expect(secondDisp.wake_applied).toBe('now');
        expect(secondDisp.wake_reason).toBe('agent_dispatch');
        expect(secondDisp.turn_id).toBeTruthy();
      }
    }finally{
      if(prevLimit===undefined)delete process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT;
      else process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT=prevLimit;
    }
  });

  it('MUL-335: sibling request via another issue child parent_owner role and grandchild --to delegator preserve delegation semantics',()=>{
    const {store}=fixture();
    const rtA=store.registerRuntime({name:'RT A',provider:'codex',workspaceId:'local'});
    const rtB=store.registerRuntime({name:'RT B',provider:'codex',workspaceId:'local'});
    const rtC=store.registerRuntime({name:'RT C',provider:'codex',workspaceId:'local'});
    const agentA=store.createAgent({name:'Agent A',provider:'codex',runtimeId:rtA.id});
    const agentB=store.createAgent({name:'Agent B',provider:'codex',runtimeId:rtB.id});
    const agentC=store.createAgent({name:'Agent C',provider:'codex',runtimeId:rtC.id});

    // Sibling A -> B_child's parent_owner (= B, not an ancestor of A) must stay agent_dispatch with dlg_* lineage.
    const issueA=createResponsibleTestIssue(store,{title:'Sibling A',status:'in_progress',assigneeType:'agent',assigneeId:agentA.id});
    const issueAMain=store.getOrCreateDefaultIssueSession(issueA.id);
    const issueB=createResponsibleTestIssue(store,{title:'Sibling B',status:'in_progress',assigneeType:'agent',assigneeId:agentB.id});
    const issueBMain=store.getOrCreateDefaultIssueSession(issueB.id);
    const issueBChild=createResponsibleTestIssue(store,{title:'B Child',parentIssueId:issueB.id,status:'todo',assigneeType:'agent',assigneeId:agentC.id});
    const issueBChildMain=store.getOrCreateDefaultIssueSession(issueBChild.id);

    const aTurn=store.sendMessage({session_id:issueAMain.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:agentA.id},message_kind:'request',wake_requested:'now',body_md:'start A'});
    const crossViaParentOwner=store.sendMessage({
      session_id:issueBChildMain.id,
      sender:{type:'agent',id:agentA.id},
      source_turn_id:aTurn.turn_id,
      to:{type:'role',ref:'parent_owner'},
      message_kind:'request',
      wake_requested:'now',
      body_md:'Sibling A reaching B via B_child parent_owner',
    });
    expect(crossViaParentOwner.wake_applied).toBe('now');
    expect(crossViaParentOwner.wake_reason).toBe('agent_dispatch');
    expect(crossViaParentOwner.message.session_id).toBe(issueBMain.id);
    expect(String(crossViaParentOwner.message.metadata.execution_scope)).toStartWith('dlg_');
    expect(store.getTurn(crossViaParentOwner.turn_id!)!).toMatchObject({
      session_id:issueBMain.id,
      agent_id:agentB.id,
      delegated_by_agent_id:agentA.id,
      delegated_from_issue_session_id:issueAMain.id,
    });

    // Grandchild --to delegator: Parent(A) -> Child(B, dlg_outer) -> Grandchild(C, dlg_inner).
    const root=createResponsibleTestIssue(store,{title:'Root',status:'in_progress',assigneeType:'agent',assigneeId:agentA.id});
    const rootMain=store.getOrCreateDefaultIssueSession(root.id);
    const mid=createResponsibleTestIssue(store,{title:'Mid',parentIssueId:root.id,status:'todo',assigneeType:'agent',assigneeId:agentB.id});
    const midMain=store.getOrCreateDefaultIssueSession(mid.id);
    const leaf=createResponsibleTestIssue(store,{title:'Leaf',parentIssueId:mid.id,status:'todo',assigneeType:'agent',assigneeId:agentC.id});
    const leafMain=store.getOrCreateDefaultIssueSession(leaf.id);

    const rootSource=store.sendMessage({session_id:rootMain.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:agentA.id},message_kind:'request',wake_requested:'now',body_md:'start root'});
    const outerDispatch=store.sendMessage({
      session_id:midMain.id,
      sender:{type:'agent',id:agentA.id},
      source_turn_id:rootSource.turn_id,
      to:{type:'role',ref:'issue_owner'},
      message_kind:'request',
      wake_requested:'now',
      body_md:'Root dispatches Mid',
    });
    const outerTurn=store.getTurn(outerDispatch.turn_id!)!;
    expect(outerTurn.execution_scope).toStartWith('dlg_');

    const innerDispatch=store.sendMessage({
      session_id:leafMain.id,
      sender:{type:'agent',id:agentB.id},
      source_turn_id:outerTurn.id,
      to:{type:'role',ref:'issue_owner'},
      message_kind:'request',
      wake_requested:'now',
      body_md:'Mid dispatches Leaf from dlg_outer',
    });
    const innerTurn=store.getTurn(innerDispatch.turn_id!)!;
    expect(innerTurn.execution_scope).toStartWith('dlg_');

    // Grandchild --to delegator --kind request must stay agent_dispatch (not to_parent_owner colliding with delegator lineage on dlg_outer).
    const delegatorReq=store.sendMessage({
      session_id:leafMain.id,
      sender:{type:'agent',id:agentC.id},
      source_turn_id:innerTurn.id,
      to:{type:'role',ref:'delegator'},
      message_kind:'request',
      wake_requested:'now',
      body_md:'Leaf requests delegator Mid',
    });
    expect(delegatorReq.wake_applied).toBe('now');
    expect(delegatorReq.wake_reason).toBe('agent_dispatch');
    expect(delegatorReq.message.session_id).toBe(midMain.id);
    expect(delegatorReq.message.metadata.execution_scope).not.toBe(outerTurn.execution_scope);
    expect(store.getTurn(delegatorReq.turn_id!)!).toMatchObject({
      agent_id:agentB.id,
      delegated_by_agent_id:agentC.id,
      delegated_from_issue_session_id:leafMain.id,
    });

    // Grandchild --to delegator --kind reply still resumes Mid's dlg_outer lane as member_to_delegator.
    const delegatorReply=store.sendMessage({
      session_id:leafMain.id,
      sender:{type:'agent',id:agentC.id},
      source_turn_id:innerTurn.id,
      to:{type:'role',ref:'delegator'},
      message_kind:'reply',
      wake_requested:'now',
      body_md:'Leaf replies to delegator Mid',
    });
    expect(delegatorReply.wake_applied).toBe('now');
    expect(delegatorReply.wake_reason).toBe('member_to_delegator');
    expect(delegatorReply.message.session_id).toBe(midMain.id);
    expect(delegatorReply.message.metadata.execution_scope).toBe(outerTurn.execution_scope);
    expect(delegatorReply.turn_id).toBe(outerTurn.id);
  });

}, { isolation: "snapshot", file: import.meta.path });
