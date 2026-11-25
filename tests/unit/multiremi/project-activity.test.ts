import { expect, it } from "bun:test";
import { createMultiremiApp, startMultiremiServer } from "@multiremi/api.js";
import { authenticateBrowserWebSocket } from "./helpers.js";
import type { ProjectActivityResponse } from "@multiremi/contracts/types.js";
import { listProjectActivity } from "@multiremi/store/project-activity.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";

pendingTurnBackendTests("Project activity", fixture => {
  function setup() {
    const { store, db } = fixture();
    const project = store.createProject({title:"No repository"});
    const other = store.createProject({title:"Other"});
    const agent = store.createAgent({name:"Ada",provider:"claude"});
    const issue = store.createIssue({title:"Build 100%",projectId:project.id});
    const task = store.createTask({issueId:issue.id,agentId:agent.id,prompt:"private input"});
    const app = createMultiremiApp({store});
    const url = `/api/projects/${project.id}/activity`;
    const read = async (query = "", headers?: Record<string,string>) => {
      const response = await app.request(`${url}?${query}`,{headers});
      expect(response.status).toBe(200);
      return await response.json() as ProjectActivityResponse;
    };
    return {store,db,project,other,agent,issue,task,app,url,read};
  }

  it("paginates authorized attempts, binds filters and keeps query count independent of page size", async () => {
    const { store,db,project,other,agent,task,app,url,read } = setup();
    const insert = db.prepare("INSERT INTO multiremi_turn_attempts(id,turn_id,attempt_no,status,created_at,updated_at) VALUES(?,?,?,'offered',?,?)");
    for (let index=1; index<=101; index++) insert.run(`retry-${index}`,task.turn_id!,index+1,task.createdAt,task.createdAt);
    const query = `q=%25&agent_id=${agent.id}&limit=30&from=${task.createdAt}`;
    let page = await read(query);
    const cursor = page.next_cursor!;
    const ids = page.items.map(item=>item.attempt_id);
    while(page.next_cursor) { page=await read(`${query}&cursor=${page.next_cursor}`); ids.push(...page.items.map(item=>item.attempt_id)); }
    expect(ids).toEqual([...new Set(ids)].sort().reverse());
    expect(ids).toHaveLength(102);
    expect((await read(`to=${task.createdAt}`)).items).toEqual([]);
    const token = await store.createTaskAccessToken(task,"local");
    const headers = {Authorization:`Bearer ${token.token}`};
    expect(await read("limit=1",headers)).toMatchObject({items:[{attempt_id:task.id,turn_id:task.turn_id,attempt_no:1}],has_more:false,next_cursor:null});
    for (const bad of ["cursor=invalid",`cursor=${cursor}`,"from=2026-02-30T00:00:00Z","view=active&status=failed","limit=101"]) expect((await app.request(`${url}?${bad}`)).status).toBe(400);
    expect((await app.request(`${url}?${query}&cursor=${cursor}`,{headers})).status).toBe(400);
    expect((await app.request(`/api/projects/${other.id}/activity?${query}&cursor=${cursor}`)).status).toBe(400);
    const counted = Object.create(db);
    let queries = 0;
    counted.query = (sql:string) => { queries++; return db.query(sql); };
    for (const limit of [1,30,100]) {
      queries=0;
      const result=listProjectActivity(counted,{projectId:project.id,workspaceId:"local",identity:"local",taskId:null,privateAgentOwner:null},{limit:String(limit)});
      expect(result.items).toHaveLength(limit);
      expect(queries).toBe(1);
    }
  });

  it("preserves non-ASCII titles and literal wildcards when folding ASCII search filters", async () => {
    const { store, issue, agent, project, task, read, app, url } = setup();
    store.updateIssue(issue.id, { title: "ÉTUDE 100%_" });
    const other = store.createIssue({ title: "ÉTUDE 100XY", projectId: project.id });
    store.createTask({ agentId: agent.id, issueId: other.id, prompt: "test" });
    const page = await read("q=ÉTUDE&limit=1");
    expect(page.has_more).toBe(true);
    const next = await read(`q=Étude&limit=1&cursor=${page.next_cursor}`);
    expect(next.items).toHaveLength(1);
    expect(next.items[0].attempt_id).not.toBe(page.items[0].attempt_id);
    expect((await read(`q=${encodeURIComponent("ÉTUDE 100%_")}`)).items.map(item => item.attempt_id)).toEqual([task.id]);
    expect((await app.request(`${url}?q=étude&limit=1&cursor=${page.next_cursor}`)).status).toBe(400);
  });

  it("only emits closed summary codes and bounded running step counts over HTTP", async () => {
    const { db,task,read } = setup();
    const unsafe = String.raw`private diagnostic C:\fixture\secret /fixture/access_token`;
    const update=db.prepare("UPDATE multiremi_turn_attempts SET status=?,progress_step=?,progress_total=?,failure_reason=?,error=?,progress_summary=?,wait_reason=? WHERE id=?");
    for (const [status,step,total,reason,expected] of [
      ["failed",3,5,"agent_error.context_overflow",{code:"context_overflow"}], ["failed",3,5,"offer_too_large",{code:"offer_too_large"}],
      ["failed",3,5,"agent_error.unknown",null], ["failed",3,5,unsafe,null], ["failed",3,5,"offer_too_large ",null],
      ["running",0,1,null,{code:"step_progress",step:0,total:1}], ["running",1000000,1000000,null,{code:"step_progress",step:1000000,total:1000000}],
      ["running",2,1,null,null], ["running",0,1000001,null,null], ["running",null,null,null,null], ["waiting_local_directory",null,null,null,{code:"needs_directory"}],
    ] as const) {
      update.run(status,step,total,reason,unsafe,unsafe,unsafe,task.id);
      const result=await read(`view=${status==="failed"?"history":"active"}`);
      expect(result.items[0]?.public_summary).toEqual(expected);
      expect(JSON.stringify(result)).not.toContain(unsafe);
    }
  });

  it("requires current ownership for each issue, session, workspace and agent", async () => {
    const {store,db,agent,task,project,other,issue,read,app} = setup();
    const child = store.createIssue({title:"Child",parentIssueId:issue.id,projectId:other.id});
    const childTask=store.createTask({agentId:agent.id,issueId:child.id,prompt:"test"});
    const chat=store.createChatSession({agentId:agent.id});
    const ids=async()=> (await read()).items.map(item=>item.attempt_id);
    expect(await ids()).toEqual([task.id]);
    db.run("UPDATE multiremi_issues SET project_id=NULL WHERE id=?",[child.id]);
    expect(await ids()).toEqual([task.id]);
    db.run("UPDATE multiremi_issues SET project_id=? WHERE id=?",[project.id,child.id]);
    expect(await ids()).toContain(childTask.id);
    db.run("UPDATE multiremi_turns SET issue_id=NULL WHERE id=?",[childTask.turn_id]);
    expect(await ids()).toEqual([task.id]);
    for(const [field,value] of [["workspace_id","other"],["chat_session_id",chat.id],["issue_session_id",childTask.issueSessionId]] as const) {
      const previous=db.query(`SELECT ${field} AS value FROM multiremi_turns WHERE id=?`).get(task.turn_id);
      db.run(`UPDATE multiremi_turns SET ${field}=? WHERE id=?`,[value,task.turn_id]);
      expect(await ids()).toEqual([]);
      db.run(`UPDATE multiremi_turns SET ${field}=? WHERE id=?`,[previous.value,task.turn_id]);
    }
    const foreign=store.createWorkspace({name:"Foreign"});
    const foreignProject=store.createProject({workspaceId:foreign.id,title:"Foreign"});
    const token=await store.createTaskAccessToken(task,"local");
    expect((await app.request(`/api/projects/${foreignProject.id}/activity`,{headers:{Authorization:`Bearer ${token.token}`}})).status).toBe(404);
    db.run("UPDATE multiremi_agents SET workspace_id=? WHERE id=?",[foreign.id,agent.id]);
    expect(await ids()).toEqual([]);
  });

  it("delivers project-only invalidation to the authenticated workspace socket for a new retry", async () => {
    const {store,project,task,read}=setup();
    const authToken=crypto.randomUUID();
    const server=startMultiremiServer({store,port:0,hostname:"127.0.0.1",backgroundJobs:false,authToken});
    const socket=new WebSocket(`ws://127.0.0.1:${server.port}/ws?workspace_id=local`);
    try {
      store.cancelTask(task.id);
      await authenticateBrowserWebSocket(socket,authToken);
      const changed=new Promise<unknown>((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(Error("no project frame")),2000);
        socket.addEventListener("message",event=>{
          const frame=JSON.parse(String(event.data));
          if(frame.type==="project:activity_changed"){clearTimeout(timeout);resolve(frame.payload);}
        });
      });
      const retried=store.retryTurnAsMember(task.turn_id!);
      expect(await changed).toEqual({workspace_id:"local",project_ids:[project.id]});
      expect((await read()).items).toMatchObject([{turn_id:task.turn_id,attempt_id:retried.current_attempt_id,attempt_no:2}]);
      expect((await read("view=history")).items).toMatchObject([{turn_id:task.turn_id,attempt_id:task.id,attempt_no:1}]);
    } finally {socket.close();await server.stop(true);}
  });

  it("publishes commit-only invalidations for progress, lifecycle, renames, bulk moves and removal", () => {
    const {store,issue,project,other,task,agent}=setup();
    const ids:string[][]=[];
    store.onWorkspaceEvent(event=>{ if(event.type==="project:activity_changed") ids.push(event.payload.project_ids as string[]); });
    store.appendTaskMessages(task.id,[{type:"assistant",content:"log only"}]);
    const chat = store.createChatSession({agentId:agent.id});
    const privateTask = store.createTask({agentId:agent.id,chatSessionId:chat.id,prompt:"private"});
    store.reportProgress(privateTask.id,"private",1,3);
    expect(ids).toEqual([]);
    expect(()=>fixture().transaction(()=>{store.reportProgress(task.id,"ignored",1,2);expect(ids).toEqual([]);throw Error("rollback");})).toThrow("rollback");
    expect(ids).toEqual([]);
    store.reportProgress(task.id,"ignored",1,2);
    expect(ids.pop()).toEqual([project.id]);
    store.updateAgent(agent.id,{name:"Renamed"});
    expect(ids.pop()).toEqual([project.id]);
    store.updateIssueSession(task.issueSessionId!,{title:"Named session"});
    expect(ids.pop()).toEqual([project.id]);
    store.updateIssue(issue.id,{title:"Renamed issue"});
    expect(ids.pop()).toEqual([project.id]);
    store.batchUpdateIssues({issueIds:[issue.id],updates:{projectId:other.id}});
    expect(ids.pop()).toEqual([project.id,other.id]);
    store.cancelTask(task.id);
    expect(ids.pop()).toEqual([other.id]);
    expect(store.deleteIssue(issue.id)).toBe(true);
    expect(ids.pop()).toEqual([other.id]);
  });
}, {isolation:"snapshot",file:import.meta.path});
