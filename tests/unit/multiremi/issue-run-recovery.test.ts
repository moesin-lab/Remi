import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import type { MultiremiStore } from "@multiremi/store.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";
import { turnApiPath } from "./unified-test-paths.js";
import { resetMultiremiTestEnv, seedHistoricalIssueFacts } from "./helpers.js";
afterEach(resetMultiremiTestEnv);

async function fixture(store: MultiremiStore, privateChat = false, options: { publicSession?: boolean; failed?: boolean } = {}) {
  const user = store.getOrCreateUser({ name: "Run creator", email: "recovery-creator@example.test" });
  const member = store.createWorkspaceMember({ workspaceId: "local", userId: user.id, name: user.name, role: "member" });
  const original = store.createAgent({ name: "Original agent", provider: "codex", ownerId: user.id });
  const replacement = store.createAgent({ name: "New assignee", provider: "codex", ownerId: user.id });
  const issue = store.createIssue({ title: "Recover context", assigneeType: "agent", assigneeId: replacement.id,
    workspaceId: "local", responsibleMemberId: member.id });
  const chat = privateChat ? store.createChatSession({ agentId: original.id, creatorId: user.id }) : null;
  const session = chat ? store.createIssueSession(issue.id, { chatId: chat.id, title: "Private recovery" })
    : options.publicSession ? store.getOrCreateDefaultIssueSession(issue.id) : null;
  const runtime = options.failed ? store.registerRuntime({ id: `rt_recovery_${issue.id}`, name: "Recovery runtime", provider: "codex", workspaceId: "local", ownerId: user.id }) : null;
  const previous = store.createTask({ agentId: original.id, issueId: issue.id, issueSessionId: session?.id, runtimeId: runtime?.id,
    prompt: "Original detailed instructions", maxAttempts: 1, assignmentAuthorType: "member", assignmentAuthorId: member.id, issueCreationRestricted: true });
  if (options.failed) {
    expect(store.claimTask(runtime!.id)?.id).toBe(previous.id);
    store.startTask(previous.id);
    store.failTask(previous.id, { error: "Original provider failure", failureReason: "provider_error" });
  } else {
    store.cancelTask(previous.id);
  }
  const app = createMultiremiApp({ store, authToken: "recovery-fixture-token" });
  const pat = await store.createAccessToken({ name: "Creator token", type: "pat", workspaceId: "local", userId: user.id });
  const headers = { Authorization: `Bearer ${pat.token}`, "Content-Type": "application/json" };
  const retry = (taskId: string, body: Record<string, unknown> = {}) => app.request(turnApiPath(store, taskId, "/retry"), { method: "POST", headers, body: JSON.stringify(body) });
  return { store, original, replacement, issue, previous, retry, app, user, member, headers, chat, session, pat };
}

pendingTurnBackendTests("specific run recovery", (current, backend) => {
  it("retains the selected run's agent, Session and prompt and rejects another retry while active", async () => {
    const f = await fixture(current().store);
    const response = await f.retry(f.previous.id);
    expect(response.status).toBe(200);
    const { turn } = await response.json();
    expect(turn).toMatchObject({ id: f.store.getTurnForAttempt(f.previous.id)!.id, status: "pending" });
    const next = f.store.getTask(turn.current_attempt_id)!;
    expect(next.agentId).toBe(f.original.id);
    expect(next.prompt).toBe(f.previous.prompt);
    expect(next.issueSessionId).toBe(f.previous.issueSessionId);
    expect(next.issueCreationRestricted).toBe(true);
    expect(next.id).not.toBe(f.previous.id);
    const again = await f.retry(f.previous.id);
    expect(again.status).toBe(409);
    expect(f.store.getTurnForAttempt(next.id)?.current_attempt_id).toBe(next.id);
    expect(f.store.listTasksForIssue(f.issue.id)).toHaveLength(2);
  });

  it("rejects an Issue override and leaves the selected Turn on its original Issue", async () => {
    const f = await fixture(current().store);
    const other = f.store.createIssue({ title: "Other issue", workspaceId: "local", responsibleMemberId: f.member.id });
    expect((await f.retry(f.previous.id, { issue_id: other.id })).status).toBe(400);
    const retired = await f.app.request(`/api/issues/${other.id}/rerun`, {
      method: "POST", headers: f.headers, body: JSON.stringify({ task_id: f.previous.id }),
    });
    expect(retired.status).toBe(410);
    expect(f.store.getTurnForAttempt(f.previous.id)?.issue_id).toBe(f.issue.id);
    expect(f.store.getTurnForAttempt(f.previous.id)?.current_attempt_id).toBe(f.previous.id);
    expect(f.store.listTasksForIssue(other.id)).toHaveLength(0);
  });

  it("accepts only one of two simultaneous recovery requests", async () => {
    const f = await fixture(current().store);
    const results = await Promise.all([f.retry(f.previous.id), f.retry(f.previous.id)]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(f.store.listTasksForIssue(f.issue.id).filter((task) => task.status === "queued")).toHaveLength(1);
  });

  it("keeps linked Chat recovery within its creator boundary", async () => {
    const f = await fixture(current().store, true);
    expect(f.previous.chatSessionId).not.toBeNull();
    expect(f.store.getIssueSession(f.previous.issueSessionId!)?.ownerType).toBe("chat");
    const member = f.store.getOrCreateUser({ name: "Other member", email: "recovery-other-member@example.test" });
    f.store.createWorkspaceMember({ workspaceId: "local", userId: member.id, name: member.name, role: "member" });
    const pat = await f.store.createAccessToken({ name: "Other member", type: "pat", workspaceId: "local", userId: member.id });
    const response = await f.app.request(turnApiPath(f.store, f.previous.id, "/retry"), { method: "POST", headers: { Authorization: `Bearer ${pat.token}`, "Content-Type": "application/json" }, body: "{}" });
    expect(response.status).toBe(403);
    expect(f.store.listTasksForIssue(f.issue.id)).toHaveLength(1);
    const own = await f.retry(f.previous.id);
    expect(own.status).toBe(200);
    expect((await own.json()).turn.session_id).toBe(f.previous.issueSessionId);
  });

  it("does not retry an active task or an invalid reference", async () => {
    const f = await fixture(current().store);
    const active = f.store.createTask({ agentId: f.original.id, issueId: f.issue.id, prompt: "Active" });
    expect((await f.retry(active.id)).status).toBe(409);
    expect((await f.retry("missing-turn")).status).toBe(404);
    expect((await f.retry(f.previous.id, { task_id: 42 })).status).toBe(400);
    expect((await f.retry(f.previous.id, { task_id: "" })).status).toBe(400);
  });

  it("rejects workspace outsiders and conflicting overrides", async () => {
    const f = await fixture(current().store);
    const user = f.store.getOrCreateUser({ name: "Other workspace", email: "recovery-outsider@example.test" });
    const other = f.store.createWorkspace({ name: "Other", slug: "recovery-other" }, user.id);
    const pat = await f.store.createAccessToken({ name: "Other workspace token", type: "pat", workspaceId: other.id, userId: user.id });
    const response = await f.app.request(turnApiPath(f.store, f.previous.id, "/retry"), { method: "POST", headers: { Authorization: `Bearer ${pat.token}`, "Content-Type": "application/json" }, body: "{}" });
    expect(response.status).toBe(404);
    const conflict = await f.app.request(turnApiPath(f.store, f.previous.id, "/retry"), { method: "POST", headers: { Authorization: "Bearer recovery-fixture-token", "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "replace instructions" }) });
    expect(conflict.status).toBe(400);
    expect(f.store.listTasksForIssue(f.issue.id)).toHaveLength(1);
  });

  it("does not interpret a member's specific retry as a force-start past dependencies", async () => {
    const f = await fixture(current().store);
    const prerequisite = f.store.createIssue({ title: "Pending prerequisite", workspaceId: "local", responsibleMemberId: f.member.id });
    f.store.updateIssue(f.issue.id, { status: "backlog" });
    f.store.createIssueDependency(f.issue.id, { dependsOnIssueId: prerequisite.id, type: "blocked_by" });
    expect(f.store.listUnmetPrerequisites(f.issue.id)).toHaveLength(1);
    const pat = await f.store.createAccessToken({ name: "Member token", type: "pat", workspaceId: "local", userId: f.user.id });
    const response = await f.app.request(turnApiPath(f.store, f.previous.id, "/retry"), { method: "POST", headers: { Authorization: `Bearer ${pat.token}`, "Content-Type": "application/json" }, body: "{}" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "dependencies_unmet" });
    expect(f.store.listTasksForIssue(f.issue.id)).toHaveLength(1);
    expect(f.store.getIssue(f.issue.id)?.status).toBe("backlog");
  });

  it("cold-retries a failed run without losing its input or failure audit", async () => {
    const f = await fixture(current().store, false, { publicSession: true, failed: true });
    const db = current().db;
    const before = f.store.getTurnForAttempt(f.previous.id)!;
    expect(before.status).toBe("failed");
    expect(f.session?.ownerType).toBe("issue");
    db.run(`UPDATE multiremi_turn_attempts SET session_id=?,input_ack_seq=?,input_read_seq=?,input_read_offset=2
      WHERE id=?`, ["old-provider-session", before.wake_seq, before.wake_seq, f.previous.id]);
    db.run(`UPDATE multiremi_session_lanes SET cursor_seq=?,provider_session_id=?,runtime_id=?,provider=?,work_dir=?,execution_fingerprint=?
      WHERE session_id=? AND reader_type='agent' AND reader_id=? AND execution_scope=?`,
    [before.wake_seq, "old-provider-session", "old-runtime", "codex", "/old-work", "old-fingerprint", before.session_id, before.agent_id, before.execution_scope]);
    const credential = await f.store.createTaskAccessToken(f.store.getTask(f.previous.id)!, "local");
    const response = await f.retry(f.previous.id, { cold: true, reason: "Recover the selected failed run" });
    expect(response.status).toBe(200);
    const { turn } = await response.json();
    expect(turn).toMatchObject({ id: before.id, status: "pending", session_id: before.session_id, agent_id: before.agent_id });
    expect(db.query("SELECT status,failure_reason,error FROM multiremi_turn_attempts WHERE id=?").get(f.previous.id))
      .toMatchObject({ status: "failed", failure_reason: "provider_error", error: "Original provider failure" });
    expect(db.query("SELECT session_id,runtime_id,input_ack_seq,input_read_seq,input_read_offset FROM multiremi_turn_attempts WHERE id=?").get(turn.current_attempt_id))
      .toEqual({ session_id: null, runtime_id: null, input_ack_seq: 0, input_read_seq: 0, input_read_offset: 0 });
    expect(f.store.getSessionAgentLane(before.session_id, before.agent_id, before.execution_scope))
      .toMatchObject({ cursorSeq: before.wake_seq, providerSessionId: null, runtimeId: null, provider: null, workDir: null, executionFingerprint: null });
    expect(db.query("SELECT revoked_at FROM multiremi_access_tokens WHERE task_id=?").get(f.previous.id)?.revoked_at).not.toBeNull();
    const input = await f.app.request(`/api/turns/${turn.id}?input=true`, { headers: f.headers });
    expect(input.status).toBe(200);
    expect((await input.json()).input.messages.map((message: { body_md: string }) => message.body_md))
      .toContain(f.previous.prompt);
    expect(f.store.getTask(turn.current_attempt_id)).toMatchObject({ issueCreationRestricted: true, prompt: f.previous.prompt });
  });

  it("keeps public recovery status semantics and leaves private projected Issue status alone", async () => {
    for (const status of ["blocked", "done", "cancelled"] as const) {
      const f = await fixture(current().store, false, { publicSession: true });
      expect(f.session?.ownerType).toBe("issue");
      if (status === "done") seedHistoricalIssueFacts(f.store, f.issue.id, { status });
      else f.store.updateIssue(f.issue.id, { status });
      expect((await f.retry(f.previous.id)).status).toBe(200);
      expect(f.store.getIssue(f.issue.id)?.status).toBe(status === "blocked" ? "todo" : status);
    }
    const f = await fixture(current().store, true);
    expect(f.session?.ownerType).toBe("chat");
    f.store.updateIssue(f.issue.id, { status: "blocked" });
    expect((await f.retry(f.previous.id)).status).toBe(200);
    expect(f.store.getIssue(f.issue.id)?.status).toBe("blocked");
  });

  it("rejects an archived or deleted actual private owner without creating an attempt", async () => {
    const f = await fixture(current().store, true);
    const turnId = f.store.getTurnForAttempt(f.previous.id)!.id;
    f.store.updateIssueSession(f.session!.id, { status: "archived" });
    expect((await f.retry(f.previous.id)).status).toBe(409);
    expect(f.store.getTurn(turnId)?.current_attempt_id).toBe(f.previous.id);
    expect(f.store.listTurnAttempts(turnId)).toHaveLength(1);
    f.store.deleteChatSession(f.chat!.id);
    const missingOwner = await f.app.request(`/api/turns/${turnId}/retry`, { method: "POST", headers: f.headers, body: "{}" });
    expect([403, 404]).toContain(missingOwner.status);
    expect(f.store.getTurn(turnId)?.current_attempt_id).toBe(f.previous.id);
    expect(f.store.listTurnAttempts(turnId)).toHaveLength(1);
  });

  it("excludes any active Issue run for public recovery while private recovery keeps its Session axis", async () => {
    const publicRun = await fixture(current().store, false, { publicSession: true });
    const siblingChat = publicRun.store.createChatSession({ agentId: publicRun.replacement.id, creatorId: publicRun.user.id });
    const sibling = publicRun.store.createIssueSession(publicRun.issue.id, { chatId: siblingChat.id, title: "Active private sibling" });
    publicRun.store.createTask({ agentId: publicRun.replacement.id, issueId: publicRun.issue.id, issueSessionId: sibling.id, prompt: "Active private work" });
    expect((await publicRun.retry(publicRun.previous.id)).status).toBe(409);
    expect(publicRun.store.listTurnAttempts(publicRun.store.getTurnForAttempt(publicRun.previous.id)!.id)).toHaveLength(1);

    const privateRun = await fixture(current().store, true);
    const publicSession = privateRun.store.getOrCreateDefaultIssueSession(privateRun.issue.id);
    expect(publicSession.ownerType).toBe("issue");
    privateRun.store.createTask({ agentId: privateRun.replacement.id, issueId: privateRun.issue.id, issueSessionId: publicSession.id, prompt: "Independent public work" });
    expect((await privateRun.retry(privateRun.previous.id)).status).toBe(200);
    expect(privateRun.store.getTurnForAttempt(privateRun.previous.id)?.session_id).toBe(privateRun.session!.id);
  });

  it("rechecks private creator and workspace inside the retry transaction and rolls back all writes", async () => {
    const f = await fixture(current().store, true);
    const db = current().db;
    const turnId = f.store.getTurnForAttempt(f.previous.id)!.id;
    const outsider = f.store.getOrCreateUser({ name: "Changed owner", email: "recovery-changed-owner@example.test" });
    const foreign = f.store.createWorkspace({ name: "Changed workspace", slug: "recovery-changed-owner" }, outsider.id);
    const snapshot = () => ({
      turn: db.query("SELECT * FROM multiremi_turns WHERE id=?").get(turnId),
      attempts: db.query("SELECT * FROM multiremi_turn_attempts WHERE turn_id=? ORDER BY attempt_no").all(turnId),
      lanes: db.query("SELECT * FROM multiremi_session_lanes WHERE session_id=?").all(f.session!.id),
      chat: db.query("SELECT * FROM multiremi_chat_sessions WHERE id=?").get(f.chat!.id),
      tokens: db.query("SELECT * FROM multiremi_access_tokens WHERE task_id=?").all(f.previous.id),
    });
    const unchanged = snapshot();
    const retry = f.store.retryTurnAsMember.bind(f.store);
    try {
      for (const [column, value] of [["creator_id", outsider.id], ["workspace_id", foreign.id]] as const) {
        f.store.retryTurnAsMember = (id, cold, authorize) => retry(id, cold, sessionId => {
          db.run(`UPDATE multiremi_chat_sessions SET ${column}=? WHERE id=?`, [value, f.chat!.id]);
          authorize!(sessionId);
        });
        expect([403, 404]).toContain((await f.retry(f.previous.id)).status);
        expect(snapshot()).toEqual(unchanged);
      }
    } finally {
      f.store.retryTurnAsMember = retry;
    }
  });

  it.skipIf(backend !== "PostgreSQL")("serializes independent API processes to exactly one replacement attempt", async () => {
    const f = await fixture(current().store, false, { publicSession: true });
    const turnId = f.store.getTurnForAttempt(f.previous.id)!.id;
    const script = `
      import { PostgresSyncDatabase } from ${JSON.stringify(new URL("../../../packages/server/src/store/db/postgres.ts", import.meta.url).pathname)};
      import { MultiremiStore } from ${JSON.stringify(new URL("../../../packages/server/src/store.ts", import.meta.url).pathname)};
      import { createMultiremiApp } from ${JSON.stringify(new URL("../../../packages/server/src/api.ts", import.meta.url).pathname)};
      const db = new PostgresSyncDatabase(process.env.RECOVERY_DATABASE_URL);
      try {
        const store = new MultiremiStore(db);
        const app = createMultiremiApp({ store, authToken: "recovery-fixture-token" });
        console.log("RECOVERY_READY");
        await Bun.stdin.text();
        const response = await app.request("/api/turns/" + process.env.RECOVERY_TURN_ID + "/retry", {
          method: "POST", headers: { Authorization: "Bearer " + process.env.RECOVERY_TOKEN, "Content-Type": "application/json" }, body: "{}" });
        console.log(JSON.stringify({ status: response.status }));
      } finally { db.close(); }
    `;
    const children = [0, 1].map(() => Bun.spawn([process.execPath, "--eval", script], {
      cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, RECOVERY_DATABASE_URL: current().databaseUrl!, RECOVERY_TURN_ID: turnId, RECOVERY_TOKEN: f.pat.token },
    }));
    try {
      const ready = await Promise.all(children.map(async child => {
        const reader = child.stdout.getReader();
        const decoder = new TextDecoder();
        let output = "";
        while (!output.includes("RECOVERY_READY\n")) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error(`Recovery worker exited before ready: ${output}\n${await new Response(child.stderr).text()}`);
          output += decoder.decode(chunk.value, { stream: true });
        }
        return { reader, decoder, output };
      }));
      for (const child of children) child.stdin.end();
      const responses = await Promise.all(ready.map(async ({ reader, decoder, output }, index) => {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          output += decoder.decode(chunk.value, { stream: true });
        }
        expect(await children[index]!.exited).toBe(0);
        return JSON.parse(output.trim().split("\n").at(-1)!).status as number;
      }));
      expect(responses.sort()).toEqual([200, 409]);
      current().reopen();
      expect(current().store.getTurn(turnId)?.status).toBe("pending");
      expect(current().store.listTurnAttempts(turnId)).toHaveLength(2);
      expect(current().store.listTasksForIssue(f.issue.id).filter(task => task.status === "queued")).toHaveLength(1);
    } finally {
      for (const child of children) child.kill();
    }
  }, 30_000);
});
