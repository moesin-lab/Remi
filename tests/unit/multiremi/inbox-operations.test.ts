import { createResponsibleTestAutopilot } from './helpers.js';
import { createResponsibleTestIssue } from './helpers.js';
import {it,expect,spyOn} from 'bun:test';
import {pendingTurnBackendTests} from './pending-turn-test-backends.js';
import {StoreContext} from '@multiremi/store/context.js';
import {acknowledgeInput} from '@multiremi/store/inbox/lane-machine.js';
import {countMessageDelegationPairHops} from '@multiremi/store/inbox/send-message.js';
pendingTurnBackendTests('MUL-506 message operations and dispatch',(fixture,backend)=>{
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
  },{timeout:30_000});

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
  },{timeout:30_000});

  it('MUL-335: sweepIdleLanes successor counts unread child request at L=1 across pending/running/ACK, while prior-ACKed request before failed/cancelled turn stays 0 hops',()=>{
    const prevLimit=process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT;
    process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT='1';
    try{
      const {store,db}=fixture();
      const ctx=new StoreContext(db,()=>store);
      const makePair=(tag:string)=>{
        const parentRuntime=store.registerRuntime({name:`Parent rt ${tag}`,provider:'codex',workspaceId:'local'});
        const childRuntime=store.registerRuntime({name:`Child rt ${tag}`,provider:'codex',workspaceId:'local'});
        const parentAgent=store.createAgent({name:`Parent ${tag}`,provider:'codex',runtimeId:parentRuntime.id});
        const childAgent=store.createAgent({name:`Child ${tag}`,provider:'codex',runtimeId:childRuntime.id});
        return {parentRuntime,childRuntime,parentAgent,childAgent};
      };

      // ① Unread child request + platform status, archive before parent ends, restore, then sweepIdleLanes rings
      //    with wake_source='platform_to_owner' (NOT 're_ring'): must count 2 hops in pending, running, and after ACK.
      {
        const {parentRuntime,childRuntime,parentAgent,childAgent}=makePair('sweep-unread');
        const parent=createResponsibleTestIssue(store,{title:'Sweep Unread Parent',status:'in_progress',assigneeType:'agent',assigneeId:parentAgent.id});
        const parentMain=store.getOrCreateDefaultIssueSession(parent.id);
        const child=createResponsibleTestIssue(store,{title:'Sweep Unread Child',parentIssueId:parent.id,status:'in_progress',assigneeType:'agent',assigneeId:childAgent.id});
        const childMain=store.getOrCreateDefaultIssueSession(child.id);

        const pStart=store.sendMessage({session_id:parentMain.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:parentAgent.id},message_kind:'request',wake_requested:'now',body_md:'Start parent'});
        expect(pStart.message.metadata.source_session_id).toBeUndefined();
        expect(pStart.message.metadata.source_session_seq).toBeUndefined();
        const p0=store.getTurn(pStart.turn_id!)!;
        expect(store.claimTask(parentRuntime.id)?.id).toBe(p0.current_attempt_id!);
        store.startTask(p0.current_attempt_id!);

        const headBeforeD1=store.getConversationLogHead(parentMain.id)!.headSeq;
        const d1=store.sendMessage({session_id:childMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:p0.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Dispatch 1'});
        expect(d1.message.metadata.source_session_id).toBe(parentMain.id);
        expect(d1.message.metadata.source_session_seq).toBe(headBeforeD1);
        const c1=store.getTurn(d1.turn_id!)!;
        expect(store.claimTask(childRuntime.id)?.id).toBe(c1.current_attempt_id!);
        store.startTask(c1.current_attempt_id!);

        const req1=store.sendMessage({session_id:parentMain.id,sender:{type:'agent',id:childAgent.id},source_turn_id:c1.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Unread child request'});
        expect(req1.wake_reason).toBe('to_parent_owner');
        expect(req1.turn_id).toBe(p0.id);
        const plat=store.sendMessage({session_id:parentMain.id,sender:{type:'platform',id:null},to:{type:'agent',ref:parentAgent.id},message_kind:'status',wake_requested:'now',body_md:'Later platform status'});
        expect(plat.message.metadata.source_session_id).toBeUndefined();
        expect(plat.turn_id).toBe(p0.id);
        store.completeTask(c1.current_attempt_id!,{output:'Child done'});

        // Archive agent briefly while P0 completes so reRingAfterTurnEnd skips creating a re_ring successor.
        db.run('UPDATE multiremi_agents SET archived_at=? WHERE id=?',[new Date().toISOString(),parentAgent.id]);
        store.completeTask(p0.current_attempt_id!,{output:'P0 ended without reading req1'});
        expect(store.listTurns({workspace_id:'local',session_id:parentMain.id}).filter(t=>t.status==='pending')).toHaveLength(0);

        // Restore agent and let sweepIdleIssueLanes ring after 60s idle.
        db.run('UPDATE multiremi_agents SET archived_at=NULL WHERE id=?',[parentAgent.id]);
        const swept=store.sweepIdleIssueLanes(Date.now()+120_000);
        expect(swept.rang).toBeGreaterThanOrEqual(1);
        const pSucc=store.listTurns({workspace_id:'local',session_id:parentMain.id}).find(t=>t.status==='pending')!;
        expect(pSucc).toBeTruthy();
        expect(pSucc.wake_source).toBe('platform_to_owner');
        expect(pSucc.trigger_message_id).not.toBe(req1.message.id);
        expect(store.getMessage(pSucc.trigger_message_id!)?.message_kind).toBe('status');

        // Stage A: pending successor still counts 2 hops.
        expect(countMessageDelegationPairHops(ctx,pSucc.id,childAgent.id,1)).toBe(2);

        // Stage B: running successor before ACK counts 2 hops.
        expect(store.claimTask(parentRuntime.id)?.id).toBe(pSucc.current_attempt_id!);
        store.startTask(pSucc.current_attempt_id!);
        expect(countMessageDelegationPairHops(ctx,pSucc.id,childAgent.id,1)).toBe(2);

        // Stage C: running successor after ACK across req1 + status still counts 2 hops and blocks dispatch.
        const fromSeq=Number(store.getSessionAgentReadProgress(parentMain.id,parentAgent.id).seq);
        const headSeq=store.getConversationLogHead(parentMain.id)!.headSeq;
        db.transaction(()=>{acknowledgeInput(ctx,pSucc.id,fromSeq,headSeq);})();
        expect(countMessageDelegationPairHops(ctx,pSucc.id,childAgent.id,1)).toBe(2);
        const blocked=store.sendMessage({session_id:childMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:pSucc.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Must hit limit after sweep+ACK'});
        expect(blocked.wake_applied).toBe('next_turn');
        expect(blocked.wake_reason).toBe('pair_round_trip_limit');
        expect(blocked.turn_id).toBeUndefined();
      }

      // ② Previous turn T1 ACKs covering child request, then receives platform status and fails/cancels:
      //    successor T2 must have 0 hops across pending, running, warm ACK, and cold ACK, and blocked stays blocked.
      for(const endKind of ['failed','cancelled'] as const){
        const {parentRuntime,childRuntime,parentAgent,childAgent}=makePair(`acked-${endKind}`);
        const parent=createResponsibleTestIssue(store,{title:`Acked ${endKind} Parent`,status:'in_progress',assigneeType:'agent',assigneeId:parentAgent.id});
        const parentMain=store.getOrCreateDefaultIssueSession(parent.id);
        const child=createResponsibleTestIssue(store,{title:`Acked ${endKind} Child`,parentIssueId:parent.id,status:'in_progress',assigneeType:'agent',assigneeId:childAgent.id});
        const childMain=store.getOrCreateDefaultIssueSession(child.id);

        const pStart=store.sendMessage({session_id:parentMain.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:parentAgent.id},message_kind:'request',wake_requested:'now',body_md:`Start ${endKind}`});
        const t1=store.getTurn(pStart.turn_id!)!;
        expect(store.claimTask(parentRuntime.id)?.id).toBe(t1.current_attempt_id!);
        store.startTask(t1.current_attempt_id!);

        const d1=store.sendMessage({session_id:childMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:t1.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Dispatch 1'});
        const c1=store.getTurn(d1.turn_id!)!;
        expect(store.claimTask(childRuntime.id)?.id).toBe(c1.current_attempt_id!);
        store.startTask(c1.current_attempt_id!);

        const req1=store.sendMessage({session_id:parentMain.id,sender:{type:'agent',id:childAgent.id},source_turn_id:c1.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Child request consumed by T1'});
        expect(req1.turn_id).toBe(t1.id);
        store.completeTask(c1.current_attempt_id!,{output:'Child done'});

        // T1 acknowledges input covering req1 (and c1's completion notices) before receiving later platform status.
        const ackedToSeq=store.getConversationLogHead(parentMain.id)!.headSeq;
        expect(ackedToSeq).toBeGreaterThanOrEqual(req1.message.seq);
        db.transaction(()=>{acknowledgeInput(ctx,t1.id,0,ackedToSeq);})();
        const plat=store.sendMessage({session_id:parentMain.id,sender:{type:'platform',id:null},to:{type:'agent',ref:parentAgent.id},message_kind:'status',wake_requested:'now',body_md:'Platform status after ACK'});
        expect(plat.turn_id).toBe(t1.id);

        if(endKind==='failed'){
          db.run("UPDATE multiremi_issues SET status='blocked' WHERE id=?",[parent.id]);
          store.failTask(t1.current_attempt_id!,{error:'T1 failed after consuming req1'});
        }else{
          db.run("UPDATE multiremi_issues SET status='blocked' WHERE id=?",[parent.id]);
          store.cancelTask(t1.current_attempt_id!);
        }

        const t2=store.listTurns({workspace_id:'local',session_id:parentMain.id}).find(t=>t.status==='pending')!;
        expect(t2).toBeTruthy();
        expect(t2.id).not.toBe(t1.id);
        expect(store.getMessage(t2.trigger_message_id!)?.sender_type).toBe('platform');
        if(endKind==='failed')expect(t2.trigger_message_id).toBe(plat.message.id);
        // Blocked parent must NOT falsely escalate to todo because req1 was already ACKed by T1.
        expect(store.getIssue(parent.id)?.status).toBe('blocked');

        // Stage A: T2 pending -> 0 hops.
        expect(countMessageDelegationPairHops(ctx,t2.id,childAgent.id,1)).toBe(0);

        // Stage B: T2 running before ACK -> 0 hops.
        expect(store.claimTask(parentRuntime.id)?.id).toBe(t2.current_attempt_id!);
        store.startTask(t2.current_attempt_id!);
        expect(countMessageDelegationPairHops(ctx,t2.id,childAgent.id,1)).toBe(0);

        // Stage C: T2 running after warm ACK -> 0 hops.
        db.transaction(()=>{acknowledgeInput(ctx,t2.id,ackedToSeq,plat.message.seq);})();
        expect(countMessageDelegationPairHops(ctx,t2.id,childAgent.id,1)).toBe(0);

        // Stage D: T2 cold ACK (input_from_seq = 0 after cursor reset) -> still 0 hops, dispatch allowed.
        db.run('UPDATE multiremi_turns SET input_from_seq=0,input_to_seq=? WHERE id=?',[plat.message.seq,t2.id]);
        expect(countMessageDelegationPairHops(ctx,t2.id,childAgent.id,1)).toBe(0);
        const allowed=store.sendMessage({session_id:childMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:t2.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:`Fresh dispatch after ${endKind}`});
        expect(allowed.wake_applied).toBe('now');
        expect(allowed.wake_reason).toBe('agent_dispatch');
        expect(allowed.turn_id).toBeTruthy();
      }
    }finally{
      if(prevLimit===undefined)delete process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT;
      else process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT=prevLimit;
    }
  },{timeout:30_000});

  it('MUL-335: frozen same-millisecond clock enforces causal ordering for parallel sibling children (L=2) and member intervention cutoff (L=1)',()=>{
    const prevLimit=process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT;
    const isoSpy=spyOn(Date.prototype,'toISOString').mockReturnValue('2026-11-23T08:00:00.005Z');
    try{
      const {store,db}=fixture();
      const ctx=new StoreContext(db,()=>store);
      const makePair=(tag:string)=>{
        const parentRuntime=store.registerRuntime({name:`Parent clk ${tag}`,provider:'codex',workspaceId:'local'});
        const childRuntime=store.registerRuntime({name:`Child clk ${tag}`,provider:'codex',workspaceId:'local'});
        const parentAgent=store.createAgent({name:`Parent clk ${tag}`,provider:'codex',runtimeId:parentRuntime.id});
        const childAgent=store.createAgent({name:`Child clk ${tag}`,provider:'codex',runtimeId:childRuntime.id});
        return {parentRuntime,childRuntime,parentAgent,childAgent};
      };

      // ③ Frozen same-ms clock under L=2 with parallel sibling children A & B sharing childAgent:
      //    - B dispatched BEFORE A replies => 2 hops (allowed)
      //    - A replies BEFORE B dispatched => 4 hops (blocked)
      process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT='2';
      for(const order of ['dispatch_b_before_a_reply','a_reply_before_dispatch_b'] as const){
        const {parentRuntime,childRuntime,parentAgent,childAgent}=makePair(order);
        const parent=createResponsibleTestIssue(store,{title:`Parent ${order}`,status:'in_progress',assigneeType:'agent',assigneeId:parentAgent.id});
        const parentMain=store.getOrCreateDefaultIssueSession(parent.id);
        const childA=createResponsibleTestIssue(store,{title:`Child A ${order}`,parentIssueId:parent.id,status:'in_progress',assigneeType:'agent',assigneeId:childAgent.id});
        const childAMain=store.getOrCreateDefaultIssueSession(childA.id);
        const childB=createResponsibleTestIssue(store,{title:`Child B ${order}`,parentIssueId:parent.id,status:'in_progress',assigneeType:'agent',assigneeId:childAgent.id});
        const childBMain=store.getOrCreateDefaultIssueSession(childB.id);

        const pStart=store.sendMessage({session_id:parentMain.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:parentAgent.id},message_kind:'request',wake_requested:'now',body_md:'Start P0'});
        const p0=store.getTurn(pStart.turn_id!)!;
        expect(store.claimTask(parentRuntime.id)?.id).toBe(p0.current_attempt_id!);
        store.startTask(p0.current_attempt_id!);

        const dispA=store.sendMessage({session_id:childAMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:p0.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Dispatch A'});
        const turnA=store.getTurn(dispA.turn_id!)!;
        expect(store.claimTask(childRuntime.id)?.id).toBe(turnA.current_attempt_id!);
        store.startTask(turnA.current_attempt_id!);

        let turnB:NonNullable<ReturnType<typeof store.getTurn>>;
        if(order==='dispatch_b_before_a_reply'){
          const dispB=store.sendMessage({session_id:childBMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:p0.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Dispatch B before A replies'});
          turnB=store.getTurn(dispB.turn_id!)!;
          store.sendMessage({session_id:parentMain.id,sender:{type:'agent',id:childAgent.id},source_turn_id:turnA.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'A replies after B dispatched'});
          store.completeTask(turnA.current_attempt_id!,{output:'A done'});
          expect(store.claimTask(childRuntime.id)?.id).toBe(turnB.current_attempt_id!);
          store.startTask(turnB.current_attempt_id!);
        }else{
          store.sendMessage({session_id:parentMain.id,sender:{type:'agent',id:childAgent.id},source_turn_id:turnA.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'A replies before B dispatched'});
          store.completeTask(turnA.current_attempt_id!,{output:'A done'});

          const dispB=store.sendMessage({session_id:childBMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:p0.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Dispatch B after A replies'});
          turnB=store.getTurn(dispB.turn_id!)!;
          expect(store.claimTask(childRuntime.id)?.id).toBe(turnB.current_attempt_id!);
          store.startTask(turnB.current_attempt_id!);
        }

        store.sendMessage({session_id:parentMain.id,sender:{type:'agent',id:childAgent.id},source_turn_id:turnB.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'B replies'});
        store.completeTask(turnB.current_attempt_id!,{output:'B done'});

        const expectedHops=order==='dispatch_b_before_a_reply'?2:4;
        expect(countMessageDelegationPairHops(ctx,p0.id,childAgent.id,2)).toBe(expectedHops);
        const nextDisp=store.sendMessage({session_id:childBMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:p0.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:`Next dispatch (${order})`});
        if(order==='dispatch_b_before_a_reply'){
          expect(nextDisp.wake_applied).toBe('now');
          expect(nextDisp.wake_reason).toBe('agent_dispatch');
          expect(nextDisp.turn_id).toBeTruthy();
        }else{
          expect(nextDisp.wake_applied).toBe('next_turn');
          expect(nextDisp.wake_reason).toBe('pair_round_trip_limit');
          expect(nextDisp.turn_id).toBeUndefined();
        }
      }

      // ④ Frozen same-ms clock under L=1 for member intervention cutoff:
      //    - dispatch -> member intervenes -> child replies => 1 hop (allowed)
      //    - member intervenes -> dispatch -> child replies => 2 hops (blocked)
      process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT='1';
      for(const order of ['dispatch_before_member','member_before_dispatch'] as const){
        const {parentRuntime,childRuntime,parentAgent,childAgent}=makePair(order);
        const parent=createResponsibleTestIssue(store,{title:`Parent ${order}`,status:'in_progress',assigneeType:'agent',assigneeId:parentAgent.id});
        const parentMain=store.getOrCreateDefaultIssueSession(parent.id);
        const child=createResponsibleTestIssue(store,{title:`Child ${order}`,parentIssueId:parent.id,status:'in_progress',assigneeType:'agent',assigneeId:childAgent.id});
        const childMain=store.getOrCreateDefaultIssueSession(child.id);

        const pStart=store.sendMessage({session_id:parentMain.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:parentAgent.id},message_kind:'request',wake_requested:'now',body_md:'Start P0'});
        const p0=store.getTurn(pStart.turn_id!)!;
        expect(store.claimTask(parentRuntime.id)?.id).toBe(p0.current_attempt_id!);
        store.startTask(p0.current_attempt_id!);

        let childTurn:NonNullable<ReturnType<typeof store.getTurn>>;
        if(order==='dispatch_before_member'){
          const disp=store.sendMessage({session_id:childMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:p0.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Dispatch before member'});
          childTurn=store.getTurn(disp.turn_id!)!;
          store.sendMessage({session_id:parentMain.id,sender:{type:'member',id:'mem_local_local'},to:{type:'none'},message_kind:'request',wake_requested:'inbox_only',body_md:'Member intervenes after dispatch'});
        }else{
          store.sendMessage({session_id:parentMain.id,sender:{type:'member',id:'mem_local_local'},to:{type:'none'},message_kind:'request',wake_requested:'inbox_only',body_md:'Member intervenes before dispatch'});
          const disp=store.sendMessage({session_id:childMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:p0.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Dispatch after member'});
          childTurn=store.getTurn(disp.turn_id!)!;
        }

        expect(store.claimTask(childRuntime.id)?.id).toBe(childTurn.current_attempt_id!);
        store.startTask(childTurn.current_attempt_id!);
        store.sendMessage({session_id:parentMain.id,sender:{type:'agent',id:childAgent.id},source_turn_id:childTurn.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Child replies'});
        store.completeTask(childTurn.current_attempt_id!,{output:'Child done'});

        const expectedHops=order==='dispatch_before_member'?1:2;
        expect(countMessageDelegationPairHops(ctx,p0.id,childAgent.id,1)).toBe(expectedHops);
        const secondDisp=store.sendMessage({session_id:childMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:p0.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:`Second dispatch (${order})`});
        if(order==='dispatch_before_member'){
          expect(secondDisp.wake_applied).toBe('now');
          expect(secondDisp.wake_reason).toBe('agent_dispatch');
          expect(secondDisp.turn_id).toBeTruthy();
        }else{
          expect(secondDisp.wake_applied).toBe('next_turn');
          expect(secondDisp.wake_reason).toBe('pair_round_trip_limit');
          expect(secondDisp.turn_id).toBeUndefined();
        }
      }

      // ⑤ Finding #1 (cross-sibling same-ms member intervention under L=1):
      //    Sibling A sends request to parent Main (running parent turn or merged into platform pending turn),
      //    same-ms member intervenes in sibling B Main, parent dispatches B, then B replies to parent:
      //    sibling A's request has source_session_id = childAMain !== childBMain and created_at === lastMember.created_at,
      //    so it must NOT be counted as hop 2 (hops === 1, wake_applied === 'now', creates delivery turn).
      process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT='1';
      for(const mode of ['running_parent','merged_platform_pending'] as const){
        const {parentRuntime,childRuntime,parentAgent,childAgent}=makePair(`sibling-cutoff-${mode}`);
        const parent=createResponsibleTestIssue(store,{title:`Parent ${mode}`,status:'in_progress',assigneeType:'agent',assigneeId:parentAgent.id});
        const parentMain=store.getOrCreateDefaultIssueSession(parent.id);
        const childA=createResponsibleTestIssue(store,{title:`Child A ${mode}`,parentIssueId:parent.id,status:'in_progress',assigneeType:'agent',assigneeId:childAgent.id});
        const childAMain=store.getOrCreateDefaultIssueSession(childA.id);
        const childB=createResponsibleTestIssue(store,{title:`Child B ${mode}`,parentIssueId:parent.id,status:'in_progress',assigneeType:'agent',assigneeId:childAgent.id});
        const childBMain=store.getOrCreateDefaultIssueSession(childB.id);

        const aStart=store.sendMessage({session_id:childAMain.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:childAgent.id},message_kind:'request',wake_requested:'now',body_md:`Start A (${mode})`});
        const turnA=store.getTurn(aStart.turn_id!)!;
        expect(store.claimTask(childRuntime.id)?.id).toBe(turnA.current_attempt_id!);
        store.startTask(turnA.current_attempt_id!);

        let parentTurn:NonNullable<ReturnType<typeof store.getTurn>>;
        if(mode==='running_parent'){
          const pStart=store.sendMessage({session_id:parentMain.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:parentAgent.id},message_kind:'request',wake_requested:'now',body_md:'Start running parent'});
          parentTurn=store.getTurn(pStart.turn_id!)!;
          expect(store.claimTask(parentRuntime.id)?.id).toBe(parentTurn.current_attempt_id!);
          store.startTask(parentTurn.current_attempt_id!);
          const reqA=store.sendMessage({session_id:parentMain.id,sender:{type:'agent',id:childAgent.id},source_turn_id:turnA.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Sibling A request into running parent'});
          expect(reqA.wake_reason).toBe('to_parent_owner');
          expect(reqA.turn_id).toBe(parentTurn.id);
        }else{
          const plat=store.sendMessage({session_id:parentMain.id,sender:{type:'platform',id:null},to:{type:'agent',ref:parentAgent.id},message_kind:'status',wake_requested:'now',body_md:'Platform status creates pending parent'});
          const reqA=store.sendMessage({session_id:parentMain.id,sender:{type:'agent',id:childAgent.id},source_turn_id:turnA.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Sibling A request coalesced into pending parent'});
          expect(reqA.wake_reason).toBe('to_parent_owner');
          expect(reqA.turn_id).toBe(plat.turn_id);
          parentTurn=store.getTurn(plat.turn_id!)!;
          expect(store.claimTask(parentRuntime.id)?.id).toBe(parentTurn.current_attempt_id!);
          store.startTask(parentTurn.current_attempt_id!);
        }
        store.completeTask(turnA.current_attempt_id!,{output:'Child A done'});

        // Same-ms member intervention in sibling B's Main session before parent dispatches B.
        store.sendMessage({session_id:childBMain.id,sender:{type:'member',id:'mem_local_local'},to:{type:'none'},message_kind:'request',wake_requested:'inbox_only',body_md:'Member intervenes in child B Main'});
        const dispB=store.sendMessage({session_id:childBMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:parentTurn.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Parent dispatches sibling B'});
        expect(dispB.wake_reason).toBe('agent_dispatch');
        const turnB=store.getTurn(dispB.turn_id!)!;
        store.completeTask(parentTurn.current_attempt_id!,{output:'Parent dispatched B'});
        for(const pending of store.listTurns({workspace_id:'local',session_id:parentMain.id}).filter(t=>t.status==='pending')){
          store.cancelTask(pending.current_attempt_id!);
        }

        expect(store.claimTask(childRuntime.id)?.id).toBe(turnB.current_attempt_id!);
        store.startTask(turnB.current_attempt_id!);
        expect(countMessageDelegationPairHops(ctx,turnB.id,parentAgent.id,1)).toBe(1);
        const reqB=store.sendMessage({session_id:parentMain.id,sender:{type:'agent',id:childAgent.id},source_turn_id:turnB.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Sibling B replies to parent'});
        expect(reqB.wake_applied).toBe('now');
        expect(reqB.wake_reason).toBe('to_parent_owner');
        expect(reqB.turn_id).toBeTruthy();
        expect(reqB.turn_id).not.toBe(parentTurn.id);
      }

      // ⑥ Finding #2 (pre-upgrade legacy dispatch row without metadata.source_session_id/source_session_seq under L=1):
      //    Parent dispatches child at T0 (legacy row missing source_session_*), same-ms member intervenes in parent Main,
      //    child replies, then parent dispatches child again => baseline created_at <= lastMember.created_at cutoff (hops === 1, allowed).
      process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT='1';
      {
        const {parentRuntime,childRuntime,parentAgent,childAgent}=makePair('legacy-cutoff');
        const parent=createResponsibleTestIssue(store,{title:'Legacy Parent',status:'in_progress',assigneeType:'agent',assigneeId:parentAgent.id});
        const parentMain=store.getOrCreateDefaultIssueSession(parent.id);
        const child=createResponsibleTestIssue(store,{title:'Legacy Child',parentIssueId:parent.id,status:'in_progress',assigneeType:'agent',assigneeId:childAgent.id});
        const childMain=store.getOrCreateDefaultIssueSession(child.id);

        const pStart=store.sendMessage({session_id:parentMain.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:parentAgent.id},message_kind:'request',wake_requested:'now',body_md:'Start legacy P0'});
        const p0=store.getTurn(pStart.turn_id!)!;
        expect(store.claimTask(parentRuntime.id)?.id).toBe(p0.current_attempt_id!);
        store.startTask(p0.current_attempt_id!);

        const disp=store.sendMessage({session_id:childMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:p0.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Legacy dispatch before member'});
        const childTurn=store.getTurn(disp.turn_id!)!;
        // Strip source_session_id/source_session_seq to simulate a pre-upgrade baseline writer row.
        const rawMeta=JSON.parse(String(db.query('SELECT metadata FROM multiremi_conversation_log WHERE id=?').get(disp.message.id).metadata??'{}'));
        delete rawMeta.source_session_id;
        delete rawMeta.source_session_seq;
        db.run('UPDATE multiremi_conversation_log SET metadata=? WHERE id=?',[JSON.stringify(rawMeta),disp.message.id]);

        store.sendMessage({session_id:parentMain.id,sender:{type:'member',id:'mem_local_local'},to:{type:'none'},message_kind:'request',wake_requested:'inbox_only',body_md:'Same-ms member intervention after legacy dispatch'});
        expect(store.claimTask(childRuntime.id)?.id).toBe(childTurn.current_attempt_id!);
        store.startTask(childTurn.current_attempt_id!);
        store.sendMessage({session_id:parentMain.id,sender:{type:'agent',id:childAgent.id},source_turn_id:childTurn.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Child replies after upgrade'});
        store.completeTask(childTurn.current_attempt_id!,{output:'Legacy child done'});

        expect(countMessageDelegationPairHops(ctx,p0.id,childAgent.id,1)).toBe(1);
        const secondDisp=store.sendMessage({session_id:childMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:p0.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Second dispatch after legacy cutoff must succeed'});
        expect(secondDisp.wake_applied).toBe('now');
        expect(secondDisp.wake_reason).toBe('agent_dispatch');
        expect(secondDisp.turn_id).toBeTruthy();
      }
    }finally{
      isoSpy.mockRestore();
      if(prevLimit===undefined)delete process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT;
      else process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT=prevLimit;
    }
  },{timeout:30_000});

  it('MUL-335: receiver-side legacy vs new same-ms cutoff, deleted member comment tombstone, and 1ms wall-clock rollback',()=>{
    const prevLimit=process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT;
    process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT='1';
    let fakeIso='2026-11-23T08:10:00.005Z';
    const isoSpy=spyOn(Date.prototype,'toISOString').mockImplementation(()=>fakeIso);
    try{
      const {store,db}=fixture();
      const ctx=new StoreContext(db,()=>store);
      const makePair=(tag:string)=>{
        const parentRuntime=store.registerRuntime({name:`Parent p2 ${tag}`,provider:'codex',workspaceId:'local'});
        const childRuntime=store.registerRuntime({name:`Child p2 ${tag}`,provider:'codex',workspaceId:'local'});
        const parentAgent=store.createAgent({name:`Parent p2 ${tag}`,provider:'codex',runtimeId:parentRuntime.id});
        const childAgent=store.createAgent({name:`Child p2 ${tag}`,provider:'codex',runtimeId:childRuntime.id});
        return {parentRuntime,childRuntime,parentAgent,childAgent};
      };

      // ① Receiver-side legacy cross-session dispatch vs new writer in session B at same ms (both orders):
      //    - Legacy row (no source_session_id/source_session_seq) falls back to created_at <= MAX(member.created_at) => 1 hop in both orders.
      //    - New writer records source_session_* on all agent request dispatches (including same-session) => member_before_dispatch = 2 hops (blocked), dispatch_before_member = 1 hop (allowed).
      for(const writer of ['legacy','new'] as const){
        for(const order of ['member_before_dispatch','dispatch_before_member'] as const){
          fakeIso='2026-11-23T08:10:00.005Z';
          const {parentRuntime,childRuntime,parentAgent,childAgent}=makePair(`rx-${writer}-${order}`);
          const parent=createResponsibleTestIssue(store,{title:`Parent ${writer} ${order}`,status:'in_progress',assigneeType:'agent',assigneeId:parentAgent.id});
          const parentMain=store.getOrCreateDefaultIssueSession(parent.id);
          const childB=createResponsibleTestIssue(store,{title:`Child B ${writer} ${order}`,parentIssueId:parent.id,status:'in_progress',assigneeType:'agent',assigneeId:childAgent.id});
          const childBMain=store.getOrCreateDefaultIssueSession(childB.id);

          const pStart=store.sendMessage({session_id:parentMain.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:parentAgent.id},message_kind:'request',wake_requested:'now',body_md:'Start parent'});
          const p0=store.getTurn(pStart.turn_id!)!;
          expect(store.claimTask(parentRuntime.id)?.id).toBe(p0.current_attempt_id!);
          store.startTask(p0.current_attempt_id!);

          let c1Turn:NonNullable<ReturnType<typeof store.getTurn>>;
          let c1MsgId:string;
          if(order==='member_before_dispatch'){
            store.sendMessage({session_id:childBMain.id,sender:{type:'member',id:'mem_local_local'},to:{type:'none'},message_kind:'request',wake_requested:'inbox_only',body_md:'Member in B before dispatch'});
            const disp=store.sendMessage({session_id:childBMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:p0.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Cross-session dispatch to B'});
            c1MsgId=disp.message.id;
            c1Turn=store.getTurn(disp.turn_id!)!;
          }else{
            const disp=store.sendMessage({session_id:childBMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:p0.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Cross-session dispatch to B'});
            c1MsgId=disp.message.id;
            c1Turn=store.getTurn(disp.turn_id!)!;
            store.sendMessage({session_id:childBMain.id,sender:{type:'member',id:'mem_local_local'},to:{type:'none'},message_kind:'request',wake_requested:'inbox_only',body_md:'Member in B after dispatch'});
          }
          if(writer==='legacy'){
            const rawMeta=JSON.parse(String(db.query('SELECT metadata FROM multiremi_conversation_log WHERE id=?').get(c1MsgId).metadata??'{}'));
            delete rawMeta.source_session_id;
            delete rawMeta.source_session_seq;
            db.run('UPDATE multiremi_conversation_log SET metadata=? WHERE id=?',[JSON.stringify(rawMeta),c1MsgId]);
          }

          // Advance wall clock to T1; child dispatches parentAgent inside session B (same-session dispatch must also carry watermark).
          fakeIso='2026-11-23T08:10:01.000Z';
          expect(store.claimTask(childRuntime.id)?.id).toBe(c1Turn.current_attempt_id!);
          store.startTask(c1Turn.current_attempt_id!);
          const headBeforeSameSession=store.getConversationLogHead(childBMain.id)!.headSeq;
          const sameSessionDisp=store.sendMessage({session_id:childBMain.id,sender:{type:'agent',id:childAgent.id},source_turn_id:c1Turn.id,to:{type:'agent',ref:parentAgent.id},message_kind:'request',wake_requested:'now',body_md:'Same-session dispatch to parent agent in B'});
          expect(sameSessionDisp.wake_reason).toBe('agent_dispatch');
          expect(sameSessionDisp.message.metadata.source_session_id).toBe(childBMain.id);
          expect(sameSessionDisp.message.metadata.source_session_seq).toBe(headBeforeSameSession);
          const pInB=store.getTurn(sameSessionDisp.turn_id!)!;
          store.completeTask(c1Turn.current_attempt_id!,{output:'Child done'});
          store.completeTask(p0.current_attempt_id!,{output:'Parent done'});
          let claimedParentAttempt:ReturnType<typeof store.claimTask>=null;
          for(let i=0;i<8;i++){
            const next=store.claimTask(parentRuntime.id);
            if(!next)break;
            if(next.id===pInB.current_attempt_id){
              claimedParentAttempt=next;
              break;
            }
            store.cancelTask(next.id);
          }
          expect(claimedParentAttempt?.id).toBe(pInB.current_attempt_id!);
          store.startTask(pInB.current_attempt_id!);

          const expectBlocked=writer==='new'&&order==='member_before_dispatch';
          expect(countMessageDelegationPairHops(ctx,pInB.id,childAgent.id,1)).toBe(expectBlocked?2:1);
          const nextDisp=store.sendMessage({session_id:childBMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:pInB.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:`Next dispatch (${writer}/${order})`});
          if(expectBlocked){
            expect(nextDisp.wake_applied).toBe('next_turn');
            expect(nextDisp.wake_reason).toBe('pair_round_trip_limit');
            expect(nextDisp.turn_id).toBeUndefined();
          }else{
            expect(nextDisp.wake_applied).toBe('now');
            expect(nextDisp.wake_reason).toBe('agent_dispatch');
            expect(nextDisp.turn_id).toBeTruthy();
          }
        }
      }

      // ② Deleted member comment via public store.deleteIssueComment retains tombstone cutoff (both new and legacy rows).
      for(const writer of ['new','legacy'] as const){
        fakeIso='2026-11-23T08:20:00.000Z';
        const {parentRuntime,childRuntime,parentAgent,childAgent}=makePair(`deleted-member-${writer}`);
        const parent=createResponsibleTestIssue(store,{title:`Deleted Member Parent ${writer}`,status:'in_progress',assigneeType:'agent',assigneeId:parentAgent.id});
        const parentMain=store.getOrCreateDefaultIssueSession(parent.id);
        const child=createResponsibleTestIssue(store,{title:`Deleted Member Child ${writer}`,parentIssueId:parent.id,status:'in_progress',assigneeType:'agent',assigneeId:childAgent.id});
        const childMain=store.getOrCreateDefaultIssueSession(child.id);

        const pStart=store.sendMessage({session_id:parentMain.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:parentAgent.id},message_kind:'request',wake_requested:'now',body_md:'Start parent'});
        const p0=store.getTurn(pStart.turn_id!)!;
        expect(store.claimTask(parentRuntime.id)?.id).toBe(p0.current_attempt_id!);
        store.startTask(p0.current_attempt_id!);

        const disp1=store.sendMessage({session_id:childMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:p0.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Dispatch 1'});
        const c1=store.getTurn(disp1.turn_id!)!;
        if(writer==='legacy'){
          const rawMeta=JSON.parse(String(db.query('SELECT metadata FROM multiremi_conversation_log WHERE id=?').get(disp1.message.id).metadata??'{}'));
          delete rawMeta.source_session_id;
          delete rawMeta.source_session_seq;
          db.run('UPDATE multiremi_conversation_log SET metadata=? WHERE id=?',[JSON.stringify(rawMeta),disp1.message.id]);
        }

        // Member posts comment in parentMain, child replies, then member comment is soft-deleted via public API.
        fakeIso='2026-11-23T08:20:01.000Z';
        const memberComment=store.sendMessage({session_id:parentMain.id,sender:{type:'member',id:'mem_local_local'},to:{type:'none'},message_kind:'request',wake_requested:'inbox_only',body_md:'Member intervention to be deleted'});

        fakeIso='2026-11-23T08:20:02.000Z';
        expect(store.claimTask(childRuntime.id)?.id).toBe(c1.current_attempt_id!);
        store.startTask(c1.current_attempt_id!);
        const childReq=store.sendMessage({session_id:parentMain.id,sender:{type:'agent',id:childAgent.id},source_turn_id:c1.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Child replies after member comment'});
        expect(childReq.wake_reason).toBe('to_parent_owner');
        if(writer==='legacy'){
          const rawMeta=JSON.parse(String(db.query('SELECT metadata FROM multiremi_conversation_log WHERE id=?').get(childReq.message.id).metadata??'{}'));
          delete rawMeta.source_session_id;
          delete rawMeta.source_session_seq;
          db.run('UPDATE multiremi_conversation_log SET metadata=? WHERE id=?',[JSON.stringify(rawMeta),childReq.message.id]);
        }
        store.completeTask(c1.current_attempt_id!,{output:'Child done'});

        store.deleteIssueComment(memberComment.message.id);
        expect(countMessageDelegationPairHops(ctx,p0.id,childAgent.id,1)).toBe(1);
        const disp2=store.sendMessage({session_id:childMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:p0.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:`Dispatch 2 after deleted member comment (${writer})`});
        expect(disp2.wake_applied).toBe('now');
        expect(disp2.wake_reason).toBe('agent_dispatch');
        expect(disp2.turn_id).toBeTruthy();
      }

      // ③ 1ms wall-clock rollback: child to_parent_owner request carrying valid source_session_seq
      //    still counts 2 hops and hits pair_round_trip_limit at L=1 (both child->parent and parent->child directions).
      {
        fakeIso='2026-11-23T08:30:00.005Z';
        const {parentRuntime,childRuntime,parentAgent,childAgent}=makePair('rollback-child-source');
        const parent=createResponsibleTestIssue(store,{title:'Rollback Parent (child source)',status:'in_progress',assigneeType:'agent',assigneeId:parentAgent.id});
        const parentMain=store.getOrCreateDefaultIssueSession(parent.id);
        const child=createResponsibleTestIssue(store,{title:'Rollback Child (child source)',parentIssueId:parent.id,status:'in_progress',assigneeType:'agent',assigneeId:childAgent.id});
        const childMain=store.getOrCreateDefaultIssueSession(child.id);

        const pStart=store.sendMessage({session_id:parentMain.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:parentAgent.id},message_kind:'request',wake_requested:'now',body_md:'Start parent at .005Z'});
        const p0=store.getTurn(pStart.turn_id!)!;
        expect(store.claimTask(parentRuntime.id)?.id).toBe(p0.current_attempt_id!);
        store.startTask(p0.current_attempt_id!);

        const cStart=store.sendMessage({session_id:childMain.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:childAgent.id},message_kind:'request',wake_requested:'now',body_md:'Member starts child at .005Z'});
        const c1=store.getTurn(cStart.turn_id!)!;
        expect(store.claimTask(childRuntime.id)?.id).toBe(c1.current_attempt_id!);
        store.startTask(c1.current_attempt_id!);

        // Wall clock rolls back by 1ms to .004Z (< lastMemberMaxAt .005Z).
        fakeIso='2026-11-23T08:30:00.004Z';
        const req1=store.sendMessage({session_id:parentMain.id,sender:{type:'agent',id:childAgent.id},source_turn_id:c1.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Child request at .004Z rollback'});
        expect(req1.wake_reason).toBe('to_parent_owner');
        expect(req1.message.metadata.source_session_id).toBe(childMain.id);
        expect(req1.message.metadata.source_session_seq).toBeGreaterThanOrEqual(cStart.message.seq);
        store.completeTask(c1.current_attempt_id!,{output:'Child c1 done'});

        const disp2=store.sendMessage({session_id:childMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:p0.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Parent dispatches c2 at .004Z rollback'});
        expect(disp2.wake_reason).toBe('agent_dispatch');
        const c2=store.getTurn(disp2.turn_id!)!;
        expect(store.claimTask(childRuntime.id)?.id).toBe(c2.current_attempt_id!);
        store.startTask(c2.current_attempt_id!);

        // From c2 (in childMain), walking c2 -> p0 (via req1 at .004Z) must NOT drop req1 on SQL created_at prefilter => 2 hops blocked.
        expect(countMessageDelegationPairHops(ctx,c2.id,parentAgent.id,1)).toBe(2);
        const blockedReq=store.sendMessage({session_id:parentMain.id,sender:{type:'agent',id:childAgent.id},source_turn_id:c2.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Child c2 request must hit L=1 despite 1ms clock rollback'});
        expect(blockedReq.wake_applied).toBe('next_turn');
        expect(blockedReq.wake_reason).toBe('pair_round_trip_limit');
        expect(blockedReq.turn_id).toBeUndefined();
      }

      {
        fakeIso='2026-11-23T08:31:00.005Z';
        const {parentRuntime,childRuntime,parentAgent,childAgent}=makePair('rollback-parent-source');
        const parent=createResponsibleTestIssue(store,{title:'Rollback Parent (parent source)',status:'in_progress',assigneeType:'agent',assigneeId:parentAgent.id});
        const parentMain=store.getOrCreateDefaultIssueSession(parent.id);
        const child=createResponsibleTestIssue(store,{title:'Rollback Child (parent source)',parentIssueId:parent.id,status:'in_progress',assigneeType:'agent',assigneeId:childAgent.id});
        const childMain=store.getOrCreateDefaultIssueSession(child.id);

        const pStart=store.sendMessage({session_id:parentMain.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:parentAgent.id},message_kind:'request',wake_requested:'now',body_md:'Start parent at .005Z'});
        const p0=store.getTurn(pStart.turn_id!)!;
        expect(store.claimTask(parentRuntime.id)?.id).toBe(p0.current_attempt_id!);
        store.startTask(p0.current_attempt_id!);

        // Wall clock rolls back by 1ms to .004Z.
        fakeIso='2026-11-23T08:31:00.004Z';
        const d1=store.sendMessage({session_id:childMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:p0.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Dispatch c1 at .004Z rollback'});
        const c1=store.getTurn(d1.turn_id!)!;
        expect(store.claimTask(childRuntime.id)?.id).toBe(c1.current_attempt_id!);
        store.startTask(c1.current_attempt_id!);
        store.sendMessage({session_id:parentMain.id,sender:{type:'agent',id:childAgent.id},source_turn_id:c1.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Child request at .004Z rollback'});
        store.completeTask(c1.current_attempt_id!,{output:'Child c1 done'});

        expect(countMessageDelegationPairHops(ctx,p0.id,childAgent.id,1)).toBe(2);
        const blockedDisp=store.sendMessage({session_id:childMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:p0.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Parent dispatch 2 must hit L=1 despite 1ms clock rollback'});
        expect(blockedDisp.wake_applied).toBe('next_turn');
        expect(blockedDisp.wake_reason).toBe('pair_round_trip_limit');
        expect(blockedDisp.turn_id).toBeUndefined();
      }
    }finally{
      isoSpy.mockRestore();
      if(prevLimit===undefined)delete process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT;
      else process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT=prevLimit;
    }
  },{timeout:30_000});

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

  it('MUL-335: soft-deleting a delivered/ACKed child to_parent_owner request preserves round-trip hops while deleting an undelivered/unACKed request does not miscount',()=>{
    const prevLimit=process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT;
    process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT='1';
    try{
      const {store,db}=fixture();
      const ctx=new StoreContext(db,()=>store);
      const makePair=(tag:string)=>{
        const parentRuntime=store.registerRuntime({name:`Parent del ${tag}`,provider:'codex',workspaceId:'local'});
        const childRuntime=store.registerRuntime({name:`Child del ${tag}`,provider:'codex',workspaceId:'local'});
        const parentAgent=store.createAgent({name:`Parent del ${tag}`,provider:'codex',runtimeId:parentRuntime.id});
        const childAgent=store.createAgent({name:`Child del ${tag}`,provider:'codex',runtimeId:childRuntime.id});
        return {parentRuntime,childRuntime,parentAgent,childAgent};
      };

      // ① Delivered to running parent turn -> ACKed -> soft-deleted via store.deleteIssueComment => still 2 hops & blocked.
      // ② Delivered to running parent turn -> before ACK -> soft-deleted via store.deleteMessage => still 2 hops & blocked.
      for(const mode of ['after_ack_delete_comment','before_ack_delete_message'] as const){
        const {parentRuntime,childRuntime,parentAgent,childAgent}=makePair(mode);
        const parent=createResponsibleTestIssue(store,{title:`Parent ${mode}`,status:'in_progress',assigneeType:'agent',assigneeId:parentAgent.id});
        const parentMain=store.getOrCreateDefaultIssueSession(parent.id);
        const child=createResponsibleTestIssue(store,{title:`Child ${mode}`,parentIssueId:parent.id,status:'in_progress',assigneeType:'agent',assigneeId:childAgent.id});
        const childMain=store.getOrCreateDefaultIssueSession(child.id);

        const pStart=store.sendMessage({session_id:parentMain.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:parentAgent.id},message_kind:'request',wake_requested:'now',body_md:`Start ${mode}`});
        const p0=store.getTurn(pStart.turn_id!)!;
        expect(store.claimTask(parentRuntime.id)?.id).toBe(p0.current_attempt_id!);
        store.startTask(p0.current_attempt_id!);

        const d1=store.sendMessage({session_id:childMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:p0.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Dispatch 1'});
        const c1=store.getTurn(d1.turn_id!)!;
        expect(store.claimTask(childRuntime.id)?.id).toBe(c1.current_attempt_id!);
        store.startTask(c1.current_attempt_id!);

        const req1=store.sendMessage({session_id:parentMain.id,sender:{type:'agent',id:childAgent.id},source_turn_id:c1.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:`Child request (${mode})`});
        expect(req1.wake_reason).toBe('to_parent_owner');
        expect(req1.turn_id).toBe(p0.id);
        store.completeTask(c1.current_attempt_id!,{output:'Child done'});

        if(mode==='after_ack_delete_comment'){
          const headSeq=store.getConversationLogHead(parentMain.id)!.headSeq;
          db.transaction(()=>{acknowledgeInput(ctx,p0.id,0,headSeq);})();
          store.deleteIssueComment(req1.message.id);
        }else{
          expect(store.deleteMessage(req1.message.id).deleted_at).toBeTruthy();
        }
        expect(db.query('SELECT deleted_at FROM multiremi_conversation_log WHERE id=?').get(req1.message.id)?.deleted_at).toBeTruthy();

        expect(countMessageDelegationPairHops(ctx,p0.id,childAgent.id,1)).toBe(2);
        const blocked=store.sendMessage({session_id:childMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:p0.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:`Dispatch 2 (${mode})`});
        expect(blocked.wake_applied).toBe('next_turn');
        expect(blocked.wake_reason).toBe('pair_round_trip_limit');
        expect(blocked.turn_id).toBeUndefined();
      }

      // ③ Triggered new parent turn directly -> before ACK -> soft-deleted via store.deleteMessage => still 2 hops & blocked.
      {
        const {parentRuntime,childRuntime,parentAgent,childAgent}=makePair('direct-trigger-delete');
        const parent=createResponsibleTestIssue(store,{title:'Parent direct trigger delete',status:'in_progress',assigneeType:'agent',assigneeId:parentAgent.id});
        const parentMain=store.getOrCreateDefaultIssueSession(parent.id);
        const child=createResponsibleTestIssue(store,{title:'Child direct trigger delete',parentIssueId:parent.id,status:'in_progress',assigneeType:'agent',assigneeId:childAgent.id});
        const childMain=store.getOrCreateDefaultIssueSession(child.id);

        const pStart=store.sendMessage({session_id:parentMain.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:parentAgent.id},message_kind:'request',wake_requested:'now',body_md:'Start P0'});
        const p0=store.getTurn(pStart.turn_id!)!;
        expect(store.claimTask(parentRuntime.id)?.id).toBe(p0.current_attempt_id!);
        store.startTask(p0.current_attempt_id!);

        const d1=store.sendMessage({session_id:childMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:p0.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Dispatch 1'});
        const c1=store.getTurn(d1.turn_id!)!;
        db.transaction(()=>{acknowledgeInput(ctx,p0.id,0,store.getConversationLogHead(parentMain.id)!.headSeq);})();
        store.completeTask(p0.current_attempt_id!,{output:'P0 done'});

        expect(store.claimTask(childRuntime.id)?.id).toBe(c1.current_attempt_id!);
        store.startTask(c1.current_attempt_id!);
        for(let i=0;i<8;i++){
          const pending=store.listTurns({workspace_id:'local',session_id:parentMain.id}).find(t=>t.status==='pending');
          if(!pending)break;
          store.cancelTask(pending.current_attempt_id!);
        }
        const req1=store.sendMessage({session_id:parentMain.id,sender:{type:'agent',id:childAgent.id},source_turn_id:c1.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Direct trigger request'});
        expect(req1.wake_reason).toBe('to_parent_owner');
        const p1=store.getTurn(req1.turn_id!)!;
        expect(p1.trigger_message_id).toBe(req1.message.id);
        store.completeTask(c1.current_attempt_id!,{output:'Child done'});

        expect(store.deleteMessage(req1.message.id).deleted_at).toBeTruthy();
        expect(store.claimTask(parentRuntime.id)?.id).toBe(p1.current_attempt_id!);
        store.startTask(p1.current_attempt_id!);
        expect(countMessageDelegationPairHops(ctx,p1.id,childAgent.id,1)).toBe(2);
        const blocked=store.sendMessage({session_id:childMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:p1.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Dispatch 2 after direct trigger delete'});
        expect(blocked.wake_applied).toBe('next_turn');
        expect(blocked.wake_reason).toBe('pair_round_trip_limit');
        expect(blocked.turn_id).toBeUndefined();
      }

      // ④ Interval-merged via re_ring:
      //    - Control: soft-deleted BEFORE successor ACKs (and not trigger/delivery of successor) => 0 hops, NOT miscounted.
      //    - Positive: soft-deleted AFTER successor ACKs covering its seq => 2 hops, blocked.
      for(const ackBeforeDelete of [false,true] as const){
        const {parentRuntime,childRuntime,parentAgent,childAgent}=makePair(`rering-del-${ackBeforeDelete}`);
        const parent=createResponsibleTestIssue(store,{title:`Parent rering ${ackBeforeDelete}`,status:'in_progress',assigneeType:'agent',assigneeId:parentAgent.id});
        const parentMain=store.getOrCreateDefaultIssueSession(parent.id);
        const child=createResponsibleTestIssue(store,{title:`Child rering ${ackBeforeDelete}`,parentIssueId:parent.id,status:'in_progress',assigneeType:'agent',assigneeId:childAgent.id});
        const childMain=store.getOrCreateDefaultIssueSession(child.id);

        const pStart=store.sendMessage({session_id:parentMain.id,sender:{type:'member',id:'mem_local_local'},to:{type:'agent',ref:parentAgent.id},message_kind:'request',wake_requested:'now',body_md:'Start P0'});
        const p0=store.getTurn(pStart.turn_id!)!;
        expect(store.claimTask(parentRuntime.id)?.id).toBe(p0.current_attempt_id!);
        store.startTask(p0.current_attempt_id!);
        db.transaction(()=>{acknowledgeInput(ctx,p0.id,0,pStart.message.seq);})();

        const d1=store.sendMessage({session_id:childMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:p0.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Dispatch 1'});
        const c1=store.getTurn(d1.turn_id!)!;
        expect(store.claimTask(childRuntime.id)?.id).toBe(c1.current_attempt_id!);
        store.startTask(c1.current_attempt_id!);

        const req1=store.sendMessage({session_id:parentMain.id,sender:{type:'agent',id:childAgent.id},source_turn_id:c1.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Child request during P0'});
        expect(req1.turn_id).toBe(p0.id);
        store.completeTask(c1.current_attempt_id!,{output:'Child done'});
        const plat=store.sendMessage({session_id:parentMain.id,sender:{type:'platform',id:null},to:{type:'agent',ref:parentAgent.id},message_kind:'status',wake_requested:'now',body_md:'Later platform status'});
        expect(plat.turn_id).toBe(p0.id);

        if(!ackBeforeDelete){
          // Soft-delete req1 BEFORE P0 finishes (so P1 never receives or ACKs req1).
          expect(store.deleteMessage(req1.message.id).deleted_at).toBeTruthy();
        }
        store.completeTask(p0.current_attempt_id!,{output:'P0 done without ACKing req1'});
        const p1=store.listTurns({workspace_id:'local',session_id:parentMain.id}).find(t=>t.status==='pending')!;
        expect(p1).toBeTruthy();
        expect(p1.id).not.toBe(p0.id);
        expect(p1.trigger_message_id).toBe(plat.message.id);
        expect(store.claimTask(parentRuntime.id)?.id).toBe(p1.current_attempt_id!);
        store.startTask(p1.current_attempt_id!);

        if(ackBeforeDelete){
          const fromSeq=Number(store.getSessionAgentReadProgress(parentMain.id,parentAgent.id).seq);
          db.transaction(()=>{acknowledgeInput(ctx,p1.id,fromSeq,plat.message.seq);})();
          store.deleteIssueComment(req1.message.id);
          expect(countMessageDelegationPairHops(ctx,p1.id,childAgent.id,1)).toBe(2);
          const blocked=store.sendMessage({session_id:childMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:p1.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Blocked after re_ring ACK + delete'});
          expect(blocked.wake_applied).toBe('next_turn');
          expect(blocked.wake_reason).toBe('pair_round_trip_limit');
          expect(blocked.turn_id).toBeUndefined();
        }else{
          expect(countMessageDelegationPairHops(ctx,p1.id,childAgent.id,1)).toBe(0);
          const allowed=store.sendMessage({session_id:childMain.id,sender:{type:'agent',id:parentAgent.id},source_turn_id:p1.id,to:{type:'role',ref:'issue_owner'},message_kind:'request',wake_requested:'now',body_md:'Allowed because deleted before successor ACK'});
          expect(allowed.wake_applied).toBe('now');
          expect(allowed.wake_reason).toBe('agent_dispatch');
          expect(allowed.turn_id).toBeTruthy();
        }
      }
    }finally{
      if(prevLimit===undefined)delete process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT;
      else process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT=prevLimit;
    }
  },{timeout:30_000});

  it('MUL-335: same-session completion comment [@worker] replay after transient dispatch failure preserves round-trip cutoff across all three member timings',()=>{
    const prevLimit=process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT;
    process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT='1';
    try{
      const {store,db}=fixture();
      const ctx=new StoreContext(db,()=>store);
      const rejectWorkerAttempt=(workerId:string):(()=>void)=>{
        const condition=`(SELECT agent_id FROM multiremi_turns WHERE id=NEW.turn_id) = '${workerId}'`;
        if(backend==='PostgreSQL'){
          db.run(`CREATE OR REPLACE FUNCTION mul335_reject_attempt() RETURNS trigger AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'injected dispatch attempt failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`);
          db.run('CREATE TRIGGER mul335_reject_attempt BEFORE INSERT ON multiremi_turn_attempts FOR EACH ROW EXECUTE FUNCTION mul335_reject_attempt()');
          return ()=>db.exec('DROP TRIGGER IF EXISTS mul335_reject_attempt ON multiremi_turn_attempts; DROP FUNCTION IF EXISTS mul335_reject_attempt()');
        }
        db.exec(`CREATE TRIGGER mul335_reject_attempt BEFORE INSERT ON multiremi_turn_attempts FOR EACH ROW WHEN ${condition}
          BEGIN SELECT RAISE(ABORT, 'injected dispatch attempt failure'); END`);
        return ()=>db.exec('DROP TRIGGER IF EXISTS mul335_reject_attempt');
      };

      for(const mode of ['no_member','member_before_dispatch','member_after_dispatch'] as const){
        const leaderRuntime=store.registerRuntime({name:`Leader replay ${mode}`,provider:'codex',workspaceId:'local'});
        const workerRuntime=store.registerRuntime({name:`Worker replay ${mode}`,provider:'codex',workspaceId:'local'});
        const leader=store.createAgent({name:`Leader replay ${mode}`,provider:'codex',runtimeId:leaderRuntime.id});
        const worker=store.createAgent({name:`Worker replay ${mode}`,provider:'codex',runtimeId:workerRuntime.id});
        const team=store.createSquad({name:`Replay squad ${mode}`,leaderId:leader.id,memberIds:[worker.id]});
        const issue=createResponsibleTestIssue(store,{title:`Replay cutoff ${mode}`,status:'in_progress',assigneeType:'squad',assigneeId:team.id});
        const session=store.getOrCreateDefaultIssueSession(issue.id);

        const leaderTask=store.createSessionTask(session.id,{agentId:leader.id,prompt:'Lead initial round'});
        expect(store.claimTask(leaderRuntime.id)?.id).toBe(leaderTask.id);
        store.startTask(leaderTask.id);

        const undo=rejectWorkerAttempt(worker.id);
        const origWarn=console.warn;
        console.warn=()=>{};
        try{
          store.completeTask(leaderTask.id,{output:`[@Worker](mention://agent/${worker.id}) Please verify`});
        }finally{
          console.warn=origWarn;
          undo();
        }

        const reply=store.listIssueComments(issue.id).find(c=>c.taskId===leaderTask.id)!;
        expect(reply).toBeTruthy();
        const eventRow=db.query("SELECT id FROM multiremi_system_events WHERE resource = 'issue_comment' AND resource_id = ?").get(reply.id)!;
        const event=store.getSystemEvent(String(eventRow.id))!;
        expect(event.status).toBe('pending');
        expect(store.listTasksForIssue(issue.id).filter(t=>t.agentId===worker.id)).toHaveLength(0);

        if(mode==='member_before_dispatch'){
          store.sendMessage({session_id:session.id,sender:{type:'member',id:'mem_local_local'},to:{type:'none'},message_kind:'request',wake_requested:'inbox_only',body_md:'Member speaks before delayed replay'});
        }

        store.dispatchPendingSystemEvents(new Date(Date.parse(event.availableAt)));
        const workerTasks=store.listTasksForIssue(issue.id).filter(t=>t.agentId===worker.id);
        expect(workerTasks).toHaveLength(1);
        const workerTask=workerTasks[0]!;
        expect(workerTask).toMatchObject({wakeSource:'agent_dispatch',triggerCommentId:reply.id});

        const replyMsg=store.getMessage(reply.id)!;
        expect(replyMsg.metadata.source_session_id).toBe(session.id);
        expect(typeof replyMsg.metadata.source_session_seq).toBe('number');
        expect(typeof replyMsg.metadata.target_session_seq).toBe('number');

        if(mode==='member_after_dispatch'){
          store.sendMessage({session_id:session.id,sender:{type:'member',id:'mem_local_local'},to:{type:'none'},message_kind:'request',wake_requested:'inbox_only',body_md:'Member speaks after delayed replay'});
        }

        const workerTurn=store.listTurns({workspace_id:'local',session_id:session.id}).find(t=>t.current_attempt_id===workerTask.id)!;
        expect(workerTurn).toBeTruthy();
        expect(store.claimTask(workerRuntime.id)?.id).toBe(workerTask.id);
        store.startTask(workerTask.id);

        const backToLeader=store.sendMessage({
          session_id:session.id,
          sender:{type:'agent',id:worker.id},
          source_turn_id:workerTurn.id,
          to:{type:'agent',ref:leader.id},
          message_kind:'request',
          wake_requested:'now',
          body_md:'Worker dispatches back to leader',
        });
        expect(backToLeader.wake_applied).toBe('now');
        expect(backToLeader.wake_reason).toBe('agent_dispatch');
        const leaderTurn2=store.getTurn(backToLeader.turn_id!)!;
        store.completeTask(workerTask.id,{output:'Worker done'});

        let claimedLeader2:ReturnType<typeof store.claimTask>=null;
        for(let i=0;i<8;i++){
          const next=store.claimTask(leaderRuntime.id);
          if(!next)break;
          if(next.id===leaderTurn2.current_attempt_id){
            claimedLeader2=next;
            break;
          }
          store.cancelTask(next.id);
        }
        expect(claimedLeader2?.id).toBe(leaderTurn2.current_attempt_id!);
        store.startTask(leaderTurn2.current_attempt_id!);

        const expectBlocked=mode!=='member_after_dispatch';
        expect(countMessageDelegationPairHops(ctx,leaderTurn2.id,worker.id,1)).toBe(expectBlocked?2:1);
        const secondDispatch=store.sendMessage({
          session_id:session.id,
          sender:{type:'agent',id:leader.id},
          source_turn_id:leaderTurn2.id,
          to:{type:'agent',ref:worker.id},
          message_kind:'request',
          wake_requested:'now',
          body_md:`Leader second dispatch (${mode})`,
        });
        if(expectBlocked){
          expect(secondDispatch.wake_applied).toBe('next_turn');
          expect(secondDispatch.wake_reason).toBe('pair_round_trip_limit');
          expect(secondDispatch.turn_id).toBeUndefined();
        }else{
          expect(secondDispatch.wake_applied).toBe('now');
          expect(secondDispatch.wake_reason).toBe('agent_dispatch');
          expect(secondDispatch.turn_id).toBeTruthy();
        }
      }
    }finally{
      if(prevLimit===undefined)delete process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT;
      else process.env.MULTIREMI_AGENT_PAIR_ROUND_TRIP_LIMIT=prevLimit;
    }
  },{timeout:30_000});

}, { isolation: "snapshot" });
