import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
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
  it("binds filters, scopes and stable tie breaks before limiting rows", async () => {
    const { store, issue, agent } = setup();
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "sensitive prompt" });
    const copy = db!.prepare(`INSERT INTO multiremi_tasks(id,agent_id,issue_id,prompt,created_at,updated_at) VALUES(?,?,?,'secret',?,?)`);
    for (let index = 0; index < 101; index++) copy.run(`t${index}`, agent.id, issue.id, task.createdAt, task.createdAt);
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
      counted.query = (sql: string) => { queries++; return db!.query(sql); };
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
    }
  });

  it("prefers a direct task target and omits private chat and foreign workspace rows", async () => {
    const {store,issue} = setup();
    configureRepositoryWikiAutomation(store, {workspaceId:"local"});
    const app = createMultiremiApp({store});
    const response = await app.request("/api/workspaces/local/repos/r1/wiki/build", {method:"POST"});
    expect(response.status).toBe(202);
    const {task_id} = await response.json();
    expect(store.listRepositoryActivity(scope, {}).items[0]).toMatchObject({task_id,issue:null,relation:"direct"});
    db!.run("UPDATE multiremi_tasks SET issue_id=? WHERE id=?", [issue.id,task_id]);
    expect(store.listRepositoryActivity({...scope,repository:other}, {}).items).toEqual([]);
    expect(activityRepositories(db!,"local","task",task_id)).toEqual([repository.id]);
    expect(store.listRepositoryActivity({...scope,workspaceId:"foreign"}, {}).items).toEqual([]);
    db!.exec("PRAGMA foreign_keys=OFF");
    db!.run("UPDATE multiremi_tasks SET chat_session_id='private' WHERE id=?", [task_id]);
    expect(store.listRepositoryActivity(scope, {}).items).toEqual([]);
    expect(activityRepositories(db!,"local","task",task_id)).toEqual([]);
  });
});
