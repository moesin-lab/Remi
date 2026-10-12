import { attemptMessagesPath, requestMessageBody, turnApiPath } from "./unified-test-paths.js";
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore as createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

async function setup() {
  const store = createStore();
  const agent = store.createAgent({ name: "Shared Chat Agent", provider: "codex", visibility: "workspace" });
  store.createWorkspaceMember({ workspaceId: "local", userId: "alice", name: "Alice", role: "member" });
  store.createWorkspaceMember({ workspaceId: "local", userId: "bob", name: "Bob", role: "admin" });
  const alice = await store.createAccessToken({ name: "Alice", type: "pat", userId: "alice", workspaceId: "local" });
  const bob = await store.createAccessToken({ name: "Bob", type: "pat", userId: "bob", workspaceId: "local" });
  const chat = store.createChatSession({ agentId: agent.id, creatorId: "alice" });
  const task = store.sendChatMessage(chat.id, { content: "Alice private Chat input" }).task;
  store.appendTaskMessages(task.id, [{ type: "text", content: "Alice private transcript" }]);
  const app = createMultiremiApp({ store, authToken: "root-secret" });
  const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
  return { store, agent, chat, task, app, alice: headers(alice.token), bob: headers(bob.token), headers };
}

function taskIds(value: any): string[] {
  return value.turns ? value.turns.map((turn: any) => turn.current_attempt_id)
    : (Array.isArray(value) ? value : value.tasks).map((task: any) => task.id);
}

describe("Shared human Chat access and task capability boundaries", () => {
  it("shares historical Chat inputs and ordinary tasks across human task and Agent snapshots", async () => {
    const { store, agent, task, app, alice, bob } = await setup();
    const regularAgent = store.createAgent({ name: "Ordinary", provider: "codex", visibility: "workspace" });
    const regular = store.createTask({ agentId: regularAgent.id, prompt: "Ordinary workspace task" });
    for (const path of [
      "/api/turns",
      `/api/multiremi/agents/${agent.id}/tasks`,
      `/api/agents/${agent.id}/tasks`,
      "/api/multiremi/agent-task-snapshot",
      "/api/agent-task-snapshot",
    ]) {
      const owner = await app.request(path, { headers: alice });
      expect(owner.status, path).toBe(200);
      expect(taskIds(await owner.json()), path).toContain(task.id);
      const other = await app.request(path, { headers: bob });
      expect(other.status, path).toBe(200);
      const result = await other.json();
      expect(taskIds(result), path).toContain(task.id);
      if (!path.includes(`/agents/${agent.id}`)) expect(taskIds(result), path).toContain(regular.id);
    }
  });

  it("lets another human inspect, steer, and cancel a historical Chat task as the shared operator", async () => {
    const { store, task, app, alice, bob } = await setup();
    const paths = [turnApiPath(store, task.id), turnApiPath(store, task.id, "/trace"),
      turnApiPath(store, task.id, "?attempts=true"), turnApiPath(store, task.id, "?input=true"),
      attemptMessagesPath(store, task.id) + "?message_kind=decision"];
    for (const path of paths) {
      expect((await app.request(path, { headers: bob })).status, path).toBe(200);
      expect((await app.request(path, { headers: alice })).status, path).toBe(200);
    }
    expect((await app.request(attemptMessagesPath(store, task.id), { method: "POST", headers: bob,
      body: JSON.stringify({ body_md: "Shared steer", to: { type: "agent", ref: task.agentId } }) })).status).toBe(200);
    expect(store.getTask(task.id)?.status).toBe("queued");
    const turn=store.getTurnForAttempt(task.id)!;
    expect(store.listMessages(turn.session_id).find(message=>message.body_md==='Shared steer')).toMatchObject({sender_type:'member',sender_id:'mem_local_local'});
    expect((await app.request(turnApiPath(store, task.id, "?input=true"), { headers: bob })).status).toBe(200);
    expect((await app.request(turnApiPath(store, task.id, "/cancel"), { method: "POST", headers: bob })).status).toBe(200);
    expect(store.getTask(task.id)?.status).toBe("cancelled");
  });

  it("preserves ordinary task access and daemon routing boundaries", async () => {
    const { store, agent, app, bob, headers } = await setup();
    const ordinary = store.createTask({ agentId: agent.id, prompt: "Workspace work" });
    expect((await app.request(turnApiPath(store, ordinary.id), { headers: bob })).status).toBe(200);
    // #6: retained orphan turns are read-only; new input names a real conversation.
    expect((await app.request(attemptMessagesPath(store, ordinary.id), { method: "POST", headers: bob, body: JSON.stringify(requestMessageBody(store, { content: "Finish ordinary work" }, { type: "agent", ref: store.getTask(ordinary.id)!.agentId })) })).status).toBe(404);
    expect((await app.request(turnApiPath(store, ordinary.id, "/cancel"), { method: "POST", headers: bob })).status).toBe(200);
    const daemon = await store.createAccessToken({ name: "Daemon", type: "daemon", userId: "bob", workspaceId: "local" });
    expect((await app.request("/health", { headers: headers(daemon.token) })).status).toBe(200);
    expect((await app.request("/api/turns", { headers: headers(daemon.token) })).status).toBe(403);
  });

  it("keeps the executing task capability usable without granting other Runtime-owner tasks access", async () => {
    const { store, agent, task, app, headers } = await setup();
    // Daemon claim mints this token for the Runtime owner, who can differ from
    // the creator when a shared Runtime executes somebody else's Chat.
    const self = await store.createTaskAccessToken(task, "bob");
    const other = store.createTask({ agentId: agent.id, prompt: "Unrelated task" });
    const foreign = await store.createTaskAccessToken(other, "bob");
    const sameOwner = await store.createTaskAccessToken(other, "alice");
    for (const path of [turnApiPath(store, task.id), turnApiPath(store, task.id, "/trace"), turnApiPath(store, task.id, "?attempts=true")]) {
      expect((await app.request(path, { headers: headers(self.token) })).status, path).toBe(200);
      expect((await app.request(path, { headers: headers(foreign.token) })).status, path).toBe(403);
      expect((await app.request(path, { headers: headers(sameOwner.token) })).status, path).toBe(403);
    }
    for (const token of [foreign.token,sameOwner.token]) {
      expect((await app.request(attemptMessagesPath(store, task.id), {method:'POST',headers:headers(token),body:JSON.stringify({body_md:'Unrelated task input',to:{type:'agent',ref:agent.id}})})).status).toBe(403);
      expect((await app.request(turnApiPath(store, task.id, '/cancel'), {method:'POST',headers:headers(token)})).status).toBe(403);
    }
    const steer = await app.request(attemptMessagesPath(store, task.id), { method: "POST", headers: headers(self.token), body: JSON.stringify(requestMessageBody(store, { content: "Finish this task" }, { type: "agent", ref: store.getTask(task.id)!.agentId })) });
    expect(steer.status).toBe(200);
    const cancelled = await app.request(turnApiPath(store, task.id, "/cancel"), { method: "POST", headers: headers(self.token) });
    expect(cancelled.status).toBe(200);
  });

  it("keeps retained Chat task records private after deletion, including a capability for the old task", async () => {
    const { store, agent, chat, task, app, alice, bob, headers } = await setup();
    store.deleteChatSession(chat.id);
    expect(store.getTask(task.id)?.chatSessionId).toBe(chat.id);
    // A stale capability must not grant access to a removed Chat even if a
    // caller were still holding a separately minted token for the same task.
    const stale = await store.createTaskAccessToken(task, "bob");
    for (const identity of [alice, bob, headers(stale.token)]) {
      for (const path of [turnApiPath(store, task.id), turnApiPath(store, task.id, "/trace"), turnApiPath(store, task.id, "?attempts=true")]) {
        expect((await app.request(path, { headers: identity })).status, path).toBe(403);
      }
      const listed = await app.request(`/api/agents/${agent.id}/tasks`, { headers: identity });
      expect(taskIds(await listed.json())).not.toContain(task.id);
      expect((await app.request(turnApiPath(store, task.id, "/cancel"), { method: "POST", headers: identity })).status).toBe(403);
    }
  });

  it("does not reuse shared human list visibility for an interleaved task capability", async () => {
    // MUL-357 added a per-request memo behind the list guards. Shared human
    // access must not outlive the request and authorize a later task token.
    const { store, agent, task, app, alice, bob, headers } = await setup();
    const self=await store.createTaskAccessToken(task,'bob');
    const second = store.createChatSession({ agentId: agent.id, creatorId: "bob" });
    const bobTask = store.sendChatMessage(second.id, { content: "Bob private Chat input" }).task;
    store.appendTaskMessages(bobTask.id, [{ type: "text", content: "Bob private transcript" }]);
    const memberChats = store.createChatSession({ agentId: agent.id, creatorId: "bob" });
    const memberTask = store.sendChatMessage(memberChats.id, { content: "Bob second private input" }).task;

    // Interleave identities so a leaked memo would be read by the next caller.
    for (let round = 0; round < 3; round += 1) {
      const aliceList = await app.request("/api/turns", { headers: alice });
      expect(aliceList.status, `alice ${round}`).toBe(200);
      const aliceIds = taskIds(await aliceList.json());
      expect(aliceIds, `alice ${round}`).toContain(task.id);
      expect(aliceIds, `alice ${round}`).toContain(bobTask.id);
      expect(aliceIds, `alice ${round}`).toContain(memberTask.id);

      const scopedList=await app.request('/api/turns',{headers:headers(self.token)});
      expect(scopedList.status,`task ${round}`).toBe(200);
      expect(taskIds(await scopedList.json()),`task ${round}`).toEqual([task.id]);

      const bobList = await app.request("/api/turns", { headers: bob });
      expect(bobList.status, `bob ${round}`).toBe(200);
      const bobIds = taskIds(await bobList.json());
      expect(bobIds, `bob ${round}`).toContain(bobTask.id);
      expect(bobIds, `bob ${round}`).toContain(memberTask.id);
      expect(bobIds, `bob ${round}`).toContain(task.id);
    }

    // Detail reads stay consistent with what the list just reported.
    expect((await app.request(turnApiPath(store, task.id), { headers: alice })).status).toBe(200);
    expect((await app.request(turnApiPath(store, task.id), { headers: bob })).status).toBe(200);
    expect((await app.request(turnApiPath(store, bobTask.id), { headers: bob })).status).toBe(200);
    expect((await app.request(turnApiPath(store, bobTask.id), { headers: alice })).status).toBe(200);
    expect((await app.request(turnApiPath(store, bobTask.id), { headers: headers(self.token) })).status).toBe(403);
  });

  it("keeps cancelled Chat history shared between humans without execution context", async () => {
    const { store, task, app, alice, bob } = await setup();
    store.cancelTask(task.id);
    const response = await app.request(turnApiPath(store, task.id), { headers: alice });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.turn.status).toBe("cancelled");
    expect(body.turn.issue_id).toBeNull();
    expect(body.turn).not.toHaveProperty("provider_session_id");
    const shared=await app.request(turnApiPath(store, task.id), { headers: bob });
    expect(shared.status).toBe(200);
    expect(await shared.json()).toEqual(body);
  });
});
