import { afterAll, expect, test } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import type { SqlDatabase, SqlStatement } from "@multiremi/store/db/postgres.js";
import { openHotspotDatabase, useMigratedHotspotDatabases } from "../../fixtures/multiremi/first-screen-hotspots-database.js";

useMigratedHotspotDatabases();
const resources: Array<Awaited<ReturnType<typeof openHotspotDatabase>>> = [];
afterAll(async () => { for (const resource of resources) await resource.dispose(); });

test("directory lists have bounded SQL cost and preserve daemon membership and liveness", async () => {
  const resource = await openHotspotDatabase();
  resources.push(resource);
  let statements: string[] = [];
  const db = new Proxy(resource.db, {
    get(target, property) {
      if (property === "query" || property === "prepare") return (sql: string) => {
        const statement = target[property](sql);
        return new Proxy(statement, {
          get(target, property) {
            const value = target[property as keyof SqlStatement];
            if (["get", "all", "run", "values"].includes(String(property))) return (...args: unknown[]) => {
              statements.push(sql);
              return (value as (...args: unknown[]) => unknown).apply(target, args);
            };
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as SqlDatabase;
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  const foreign = store.createWorkspace({ name: "Other tenant", slug: "directory-cost-foreign" });
  const host = store.registerRuntime({ id: "rt_dirs_host", name: "host", daemonId: "directories", provider: "codex", metadata: { runtime_workspaces: 1 } });
  for (let index = 0; index < 7; index++) store.registerRuntime({ id: `rt_dirs_peer_${index}`, name: "peer", daemonId: index < 2 ? "directories" : `other_${index}`, provider: "codex" });
  for (let index = 0; index < 6; index++) store.registerRuntime({ id: `rt_dirs_foreign_${index}`, name: "foreign", workspaceId: foreign.id, daemonId: "directories", provider: "codex", metadata: { runtime_workspaces: 1 } });
  const app = createMultiremiApp({ store });
  for (let index = 0; index < 24; index++) store.runtimeWorkspaces.create(host.id, { name: `Directory ${index}`, root_path: `/tmp/directory-cost/${index}` });
  for (const path of ["/api/runtime-workspaces", `/api/runtimes/${host.id}/workspaces`]) {
    statements = [];
    const start = performance.now();
    const response = await app.request(path);
    const body = await response.json();
    const elapsed = performance.now() - start;
    console.info(JSON.stringify({ path, directories: 24, runtimes: 14, statements: statements.length, elapsed_ms: elapsed }));
    expect(response.status).toBe(200);
    expect(body.workspaces).toHaveLength(24);
    for (const item of body.workspaces) {
      expect([...item.runtime_ids].sort()).toEqual([host.id, "rt_dirs_peer_0", "rt_dirs_peer_1"].sort());
      expect(item.status).toBe("available");
    }
    // Includes auth/scope and a possible readiness probe; independent of directory count.
    expect(statements.length).toBeLessThanOrEqual(path === "/api/runtime-workspaces" ? 7 : 10);
    expect(elapsed).toBeLessThan(2_000);
  }
  // A different tenant's same daemon ID must not make these directories available.
  db.query("UPDATE multiremi_runtimes SET last_heartbeat_at=? WHERE workspace_id='local'").run("2000-01-01T00:00:00Z");
  const offline = await app.request("/api/runtime-workspaces");
  expect((await offline.json()).workspaces.every((item: { status: string }) => item.status === "unavailable")).toBe(true);
  const directory = store.runtimeWorkspaces.list("local")[0]!;
  store.runtimeWorkspaces.archive(directory.id);
  const archived = await app.request("/api/runtime-workspaces?archived=true");
  expect((await archived.json()).workspaces.find((item: { id: string }) => item.id === directory.id)?.status).toBe("archived");
  const current = await app.request("/api/runtime-workspaces");
  expect((await current.json()).workspaces).toHaveLength(23);
}, 60_000);

test("task directory visibility stays bound to the requesting task", async () => {
  const resource = await openHotspotDatabase();
  resources.push(resource);
  const store = new MultiremiStore(resource.db);
  store.ensureLocalWorkspace();
  const runtime = store.registerRuntime({ name: "task host", daemonId: "task-directories", provider: "codex" });
  const bound = store.runtimeWorkspaces.create(runtime.id, { name: "Bound", root_path: "/tmp/task-bound" });
  store.runtimeWorkspaces.create(runtime.id, { name: "Hidden", root_path: "/tmp/task-hidden" });
  const agent = store.createAgent({ name: "Directory task", provider: "codex" });
  const app = createMultiremiApp({ store, authToken: "directory-cost-master" });
  for (const runtimeWorkspaceId of [bound.id, null]) {
    const task = store.createTask({ agentId: agent.id, prompt: "Inspect files", runtimeWorkspaceId });
    const credential = await store.createTaskAccessToken(task, "local");
    const response = await app.request("/api/runtime-workspaces", { headers: { Authorization: `Bearer ${credential.token}` } });
    expect(response.status).toBe(200);
    expect((await response.json()).workspaces.map((item: { id: string }) => item.id)).toEqual(runtimeWorkspaceId ? [bound.id] : []);
  }
}, 60_000);
