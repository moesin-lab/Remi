import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp, startMultiremiServer } from "@multiremi/api.js";
import { activityRepositories, readRepositoryActivity } from "@multiremi/store/repository-activity.js";
import { configureRepositoryWikiAutomation, createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const repository = { id: "r1", name: "code", url: "https://github.com/acme/code.git", source: "github" };
const other = { ...repository, id: "r2", name: "other", url: "https://github.com/acme/other.git" };
const scope = { workspaceId: "local", repository, taskId: null };

function setup() {
  const store = createLocalStore();
  store.updateWorkspaceRepositories("local", [repository, other]);
  const project = store.createProject({ title: "Product", resources: [repository, other].map(repo => ({resourceType: "github_repo", resourceRef: {url: repo.url}})) });
  const issue = store.createIssue({ title: "Fix 100%", projectId: project.id });
  const agent = store.createAgent({ name: "Ada", provider: "claude" });
  return { store, project, issue, agent };
}

describe("repository activity", () => {
  it("returns public summaries over HTTP without inspecting either repository's missing default branch", async () => {
    const { store, issue, agent } = setup();
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Test summaries" });
    const inspections: string[] = [];
    const app = createMultiremiApp({ store, inspectGitRemoteRepository: async (url) => {
      inspections.push(url);
      return { default_branch: "main", branches: ["main"] };
    } });
    const update = db!.prepare(`UPDATE multiremi_turn_attempts SET status='failed',error=?,progress_summary=?,wait_reason=?,failure_reason=? WHERE id=?`);
    for (const [detail, marker] of [
      [String.raw`C:\Example\Team checkout\fixture.txt`, "[path]"],
      [String.raw`\\fileserver\private share\fixture.txt`, "[path]"],
      ["/private/team checkout/fixture.txt", "[path]"],
      ["access_token=\"fixture credential\"", "[redacted]"],
    ] as const) {
      update.run(String.raw`ENOENT C:\Example\Team\checkout\fixture.txt`, `Checking ${detail}`, `Waiting ${detail}`, `Failed ${detail}`, task.id);
      const response = await app.request("/api/workspaces/local/repos/r1/activity?view=history");
      expect(response.status).toBe(200);
      expect((await response.json()).items[0]).toMatchObject({ task_id: task.id, progress_summary: `Checking ${marker}`,
        wait_reason: `Waiting ${marker}`, failure_reason: `Failed ${marker}`, error_summary: `Failed ${marker}` });
    }
    update.run("private raw diagnostic", "Checking files", null, null, task.id);
    const response = await app.request("/api/workspaces/local/repos/r1/activity?view=history");
    expect((await response.json()).items[0]).toMatchObject({ progress_summary: "Checking files", error_summary: null });
    expect(inspections).toEqual([]);
    expect((await app.request("/api/workspaces/local/repos")).status).toBe(200);
    expect(inspections.sort()).toEqual([repository.url, other.url].sort());
  });

  it("binds filters, scopes and stable tie breaks before limiting rows", async () => {
    const { store, issue, agent } = setup();
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "sensitive prompt" });
    const copy = db!.prepare(`INSERT INTO multiremi_turn_attempts(id,turn_id,attempt_no,status,created_at,updated_at) VALUES(?,?,?,'offered',?,?)`);
    for (let index = 0; index < 101; index++) copy.run(`t${index}`, task.turn_id!, index + 2, task.createdAt, task.createdAt);
    const params = { q: "%", agent_id: agent.id, limit: "30" };
    const page = store.listRepositoryActivity(scope, params);
    expect(page.items).toHaveLength(30);
    expect(page.items[0]).toMatchObject({ relation: "project_context", issue: { id: issue.id }, worktree: null });
    const found = [...page.items];
    let cursor = page.next_cursor;
    while (cursor) {
      const next = store.listRepositoryActivity(scope, { ...params, cursor });
      found.push(...next.items);
      cursor = next.next_cursor;
    }
    expect(new Set(found.map(item => item.task_id)).size).toBe(102);
    expect(found.length).toBe(102);
    expect(JSON.stringify(found)).not.toContain("sensitive prompt");
    const invalid: Record<string, string>[] = [{cursor:"broken"}, {view:"active",status:"failed"}, {q:"x",cursor:page.next_cursor!}];
    for (const bad of invalid) {
      expect(() => store.listRepositoryActivity(scope, bad)).toThrow();
    }
    expect(() => store.listRepositoryActivity({...scope, repository:other}, {...params, cursor:page.next_cursor!})).toThrow();
    const app = createMultiremiApp({store});
    const token = await store.createTaskAccessToken(task, "local");
    const response = await app.request("/api/workspaces/local/repos/r1/activity", {headers:{Authorization:`Bearer ${token.token}`}});
    expect(response.status).toBe(200);
    expect((await response.json()).items.map((item: {task_id:string}) => item.task_id)).toEqual([task.id]);
    expect((await app.request("/api/workspaces/local/repos/missing/activity")).status).toBe(404);
    expect((await app.request("/api/workspaces/local/repos/r1/activity?cursor=broken")).status).toBe(400);
    for (const size of [1,30,100]) {
      const times: number[] = [];
      let bytes = 0;
      let queries = 0;
      const counted = Object.create(db!);
      let plan = "";
      counted.query = (sql: string) => {
        queries++;
        const statement = db!.query(sql);
        return { all: (...args: string[]) => {
          if (!plan && sql.includes("WITH candidates")) {
            plan = db!.query(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => (row as {detail:string}).detail).join(" | ");
          }
          return statement.all(...args);
        } };
      };
      for (let sample = 0; sample < 31; sample++) {
        queries = 0;
        const start = performance.now();
        const result = readRepositoryActivity(counted, scope, {limit:String(size)});
        bytes = Buffer.byteLength(JSON.stringify(result));
        if (sample) times.push(performance.now() - start);
        expect(result.items).toHaveLength(size);
        expect(queries).toBe(4);
      }
      times.sort((left,right) => left-right);
      console.info(`SQLite activity ${size} rows, ${queries} queries, ${bytes} bytes, p50=${times[14]!.toFixed(2)}ms p95=${times[28]!.toFixed(2)}ms`);
      if (size === 1) console.info(`SQLite activity plan ${plan}`);
    }
  });

  it("prefers a direct task target and omits private chat and foreign workspace rows", async () => {
    const {store,issue,agent} = setup();
    configureRepositoryWikiAutomation(store, {workspaceId:"local"});
    const app = createMultiremiApp({store});
    const response = await app.request("/api/workspaces/local/repos/r1/wiki/build", {method:"POST"});
    expect(response.status).toBe(202);
    const wiki = await response.json();
    expect(store.getTask(wiki.task_id)?.chatSessionId).toBeTruthy();
    expect(store.listRepositoryActivity(scope, {}).items).toEqual([]);
    const connection = store.createScmConnection({name:"SCM", workspaceId:"local", provider:"github", mode:"poll", repositoryIds:[repository.id]});
    const {event} = store.recordScmCanonicalEvent({workspaceId:"local", connectionId:connection.id, repositoryId:repository.id,
      type:"change.merged", subjectType:"change_request", subjectId:"1", logicalKey:"change.merged:1", fidelity:"inferred",
      payload:{number:1}, evidence:{source:"poll", dedupeKey:"poll:1"}});
    const task_id = store.createTask({agentId:agent.id, prompt:"Inspect change", assignmentSourceEventId:event.id}).id;
    expect(store.listRepositoryActivity(scope, {}).items[0]).toMatchObject({task_id,issue:null,relation:"direct"});
    db!.run("UPDATE multiremi_turns SET issue_id=? WHERE current_attempt_id=?", [issue.id,task_id]);
    expect(store.listRepositoryActivity({...scope,repository:other}, {}).items).toEqual([]);
    expect(activityRepositories(db!,"local","task",task_id)).toEqual([repository.id]);
    expect(store.listRepositoryActivity({...scope,workspaceId:"foreign"}, {}).items).toEqual([]);
    db!.exec("PRAGMA foreign_keys=OFF");
    db!.run("UPDATE multiremi_turns SET chat_session_id='private' WHERE current_attempt_id=?", [task_id]);
    expect(store.listRepositoryActivity(scope, {}).items).toEqual([]);
    expect(activityRepositories(db!,"local","task",task_id)).toEqual([]);
  });

  it("publishes committed lifecycle and relation changes and skips log frames", async () => {
    const {store, project, issue, agent} = setup();
    const server = startMultiremiServer({store, port:0, hostname:"127.0.0.1", backgroundJobs:false});
    const frames: string[][] = [];
    const inTransaction: boolean[] = [];
    const unsubscribe = store.onWorkspaceEvent(event => {
      if (event.type !== "repository:activity_changed") return;
      frames.push(event.payload.repository_ids as string[]);
      inTransaction.push(db!.inTransaction);
    });
    try {
      const task = store.createTask({agentId:agent.id,issueId:issue.id,prompt:"run"});
      expect(frames.at(-1)).toEqual(["r1","r2"]);
      frames.length = 0;
      store.appendTaskMessages(task.id,[{type:"text",content:"transcript"}]);
      expect(frames).toEqual([]);
      store.reportProgress(task.id,"ready");
      expect(frames).toEqual([["r1","r2"]]);
      expect(store.listRepositoryActivity(scope,{}).items[0]?.progress_summary).toBe("ready");
      const connection = store.createScmConnection({name:"GitHub",workspaceId:"local",provider:"github",mode:"poll",repositoryIds:[repository.id]});
      const timestamp = task.createdAt;
      for (const number of [1,2,3,4]) store.advanceScmEntitySnapshot({connectionId:connection.id,repositoryId:repository.id,entityType:"change_request",
        externalId:String(number),revisionAt:timestamp,revision:"v1",contentHash:`hash${number}`,payload:{number,title:issue.key,state:"open"}});
      const items = store.listRepositoryActivity(scope,{}).items;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({relation:"issue_pr",change_request_count:4});
      expect(items[0]!.change_requests).toHaveLength(3);
      expect(frames.at(-1)).toEqual(["r1"]);
      for (const pr of store.listScmChangeRequestsForIssue(issue.id)!) store.unlinkScmChangeRequestFromIssue(issue.id, pr.id);
      expect(store.listRepositoryActivity(scope,{}).items[0]).toMatchObject({relation:"project_context",change_requests:[]});
      expect(frames.at(-1)).toEqual(["r1"]);
      const runtime = store.registerRuntime({name:"test",provider:"claude"});
      const branch = `agent/${issue.key}`;
      store.reportIssueWorkspace({issueId:issue.id,runtimeId:runtime.id,rootPath:"/test",branchName:branch,status:"ready",repos:[{
        repoUrl:repository.url,repoName:"code",worktreePath:"/test/code",branchName:branch,baseRef:"main",status:"ready",dirty:false,error:null}]});
      expect(frames.at(-1)).toEqual(["r1"]);
      expect(store.listRepositoryActivity(scope,{}).items[0]?.worktree).toEqual({branch,status:"ready"});
      const reclaimed = { subject: { kind: "issue" as const, id: issue.id }, snapshot: null, unsavedWork: false };
      frames.length = 0;
      expect(() => store.reportSubjectReclaimed("unknown-runtime", reclaimed)).toThrow();
      expect(frames).toEqual([]);
      store.reportSubjectReclaimed(runtime.id, reclaimed);
      expect(frames).toEqual([["r1"]]);
      expect(store.listRepositoryActivity(scope,{}).items[0]?.worktree).toBeNull();
      const resource = store.listProjectResources(project.id).find(entry => entry.resourceRef.url === repository.url)!;
      store.deleteProjectResource(project.id,resource.id);
      expect(store.listRepositoryActivity(scope,{}).items).toEqual([]);
      frames.length = 0;
      const remaining = store.listProjectResources(project.id)[0]!;
      store.updateProjectResource(project.id,remaining.id,{resourceRef:{url:repository.url}});
      expect(frames).toHaveLength(1);
      expect(frames[0]!.sort()).toEqual(["r1","r2"]);
      expect(store.listRepositoryActivity(scope,{}).items).toHaveLength(1);
      frames.length = 0;
      store.updateIssueAndDispatch(issue.id, {title:"Updated", projectId:null});
      expect(frames).toContainEqual([repository.id]);
      expect(store.listRepositoryActivity(scope,{}).items).toEqual([]);
      expect(inTransaction).not.toContain(true);
    } finally {
      unsubscribe();
      await server.stop(true);
    }
  });
});
