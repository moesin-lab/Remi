import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/postcss";
import { chromium } from "playwright-core";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const { repo, artifacts } = JSON.parse(input);
const now = "2026-10-08T00:00:00.000Z";
const agent = { id: "agt_smoke", name: "Smoke Agent", workspace_id: "ws_smoke", owner_id: "usr_smoke",
  visibility: "workspace", archived_at: null, provider: "codex", status: "idle", runtime_mode: "local",
  runtime_id: null, runtime_ids: [], skills: [], instructions: "Synthetic browser fixture", created_at: now, updated_at: now };
const chat = { id: "chat_smoke", workspace_id: "ws_smoke", agent_id: agent.id, creator_id: "usr_smoke",
  project_id: null, runtime_workspace_id: null, title: "Ordinary browser Chat", status: "active", has_unread: false,
  pinned: false, unread_count: 0, last_message: null, created_at: now, updated_at: now };
const session = (id, ownerType, ownerId, title, extra = {}) => ({ id, owner_type: ownerType, owner_id: ownerId,
  chat_id: ownerType === "chat" ? ownerId : null, issue_id: ownerType === "issue" ? ownerId : null,
  workspace_id: "ws_smoke", title, status: "active", is_default: false, holds_workspace: true,
  parent_session_id: null, inherit_mode: "none", inherit_cutoff_seq: null, inherited_event_count: 0,
  summary: null, created_by_type: "member", created_by_id: "usr_smoke", created_at: now, updated_at: now,
  participants: [], ...extra });
const chatRoot = session("ses_chat_root", "chat", chat.id, "Chat work root", { issue_id: "iss_smoke_linked" });
const sessions = [chatRoot];
const tasks = [];
const logs = new Map();
const requests = [];
const unknownRequests = [];
let failedCreation = false;
let count = 0;
const row = (sessionId, seq, body, extra = {}) => ({ session_id: sessionId, seq, id: `${sessionId}_${seq}`,
  revision: 1, kind: "message", visibility: "shown", author_type: "agent", author_id: agent.id,
  task_id: null, parent_id: null, body_md: body, body_html: `<p>${body}</p>`, render_version: "fixture",
  metadata: {}, created_at: now, updated_at: now, deleted_at: null, ...extra });
const task = (id, sessionId, status, extra = {}) => ({ id, agent_id: agent.id, runtime_id: "", issue_id: null,
  turn_id: `turn_${id}`, issue_session_id: sessionId, chat_session_id: chat.id, holds_workspace: true, status, priority: 0,
  dispatched_at: now, started_at: now, completed_at: now, result: null, error: null, created_at: now, ...extra });
const completed = task("tsk_persisted", chatRoot.id, "completed", { prompt: "Persistent delegated task instructions" });
const failed = task("tsk_failed", chatRoot.id, "failed", { error: "Fixture failure evidence" });
tasks.push(completed, failed);

const turnWire = currentTask => ({ id: currentTask.turn_id, session_id: currentTask.issue_session_id,
  seq: 1, agent_id: currentTask.agent_id, status: currentTask.status, current_attempt_id: currentTask.id,
  input_from_seq: 0, input_to_seq: 1, created_at: now, started_at: now, ended_at: now,
  ended_reason: null, legacy_prompt: currentTask.prompt ?? null,
  current_attempt: { id: currentTask.id, status: currentTask.status, runtime_id: null, provider: "codex",
    error: currentTask.error, failure_reason: null, progress_summary: null, progress_step: null, progress_total: null } });
const messageWire = (sessionId, seq, body, toAgent = agent.id) => ({
  ...row(sessionId, seq, body, { author_type: "member", author_id: "usr_smoke" }),
  sender_type: "member", sender_id: "mem_smoke", to_type: "agent", to_ref: toAgent,
  to_agent_id: toAgent, to_member_id: null, message_kind: "request", wake_requested: "now",
  wake_applied: "now", wake_reason: "started", reply_to_id: null, dedupe_key: null, options: null,
});

function completedLogRows(currentTask, result, fromSeq) {
  const sessionId = currentTask.issue_session_id;
  const reply = row(sessionId, fromSeq + 1, result, { task_id: currentTask.id });
  const turn = row(sessionId, fromSeq, currentTask.prompt, { id: currentTask.turn_id, kind: "turn", task_id: currentTask.id,
    metadata: { status: "completed", final_entry_id: reply.id, final_reply_md: result } });
  return [turn, reply];
}

logs.set(chatRoot.id, [...completedLogRows(completed, "Persistent completed Session result", 1),
  row(chatRoot.id, 3, "Persistent failed Session result", { task_id: failed.id })]);

async function fixtureApi(req, res, next) {
  const url = new URL(req.url, "http://fixture.test");
  const path = url.pathname;
  if (!path.startsWith("/api/")) return next();
  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    let source = "";
    for await (const chunk of req) source += chunk;
    body = source ? JSON.parse(source) : undefined;
  }
  requests.push({ method: req.method, path, body });
  const send = (value, status = 200) => {
    res.statusCode = status;
    if (status === 204) return res.end();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(value));
  };
  if (path === "/api/workspaces") return send([{ id: "ws_smoke", slug: "session-smoke", name: "Session smoke" }]);
  if (path === "/api/workspaces/ws_smoke/members") return send([{ id: "mem_smoke", user_id: "usr_smoke", role: "owner", name: "Browser smoke" }]);
  if (path === "/api/agents") return send([agent]);
  if (path === `/api/agents/${agent.id}`) return send(agent);
  if (path === "/api/projects") return send({ projects: [] });
  if (["/api/runtimes", "/api/agent-task-snapshot", "/api/runtime-workspaces", "/api/attachments"].includes(path)) return send([]);
  if (path === "/api/chat/sessions") return send([chat]);
  if (path === `/api/chat/sessions/${chat.id}` && req.method === "GET") return send(chat);
  if (path === "/api/turns") {
    const sessionId = url.searchParams.get("session_id");
    const status = url.searchParams.get("status");
    return send({ turns: tasks.filter(current => (!sessionId || current.issue_session_id === sessionId)
      && (!status || current.status === status)).map(turnWire), next_cursor: null });
  }
  if (path === `/api/sessions/${chat.id}/messages` && req.method === "POST") {
    assert.equal(typeof body.body_md, "string");
    const entries = logs.get(chat.id) ?? [];
    const message = messageWire(chat.id, entries.length + 1, body.body_md);
    entries.push(message);
    logs.set(chat.id, entries);
    return send({ message, wake_applied: "now", wake_reason: "started" });
  }
  if (path === `/api/chat/sessions/${chat.id}/read`) return send(undefined, 204);
  if (path === "/api/inbox/read") return send({ session_id: body.session_id, cursor_seq: 0 });
  const issueSessions = path.match(/^\/api\/issues\/(iss_smoke_empty|iss_smoke_linked)\/sessions$/);
  const chatSessions = path.match(/^\/api\/multiremi\/chats\/chat_smoke\/sessions$/);
  if (issueSessions || chatSessions) {
    const ownerType = issueSessions ? "issue" : "chat";
    const ownerId = issueSessions?.[1] ?? chat.id;
    if (req.method === "GET") {
      const list = sessions.filter(current => issueSessions ? current.issue_id === ownerId : current.owner_type === "chat" && current.owner_id === ownerId);
      return send(issueSessions ? list : { sessions: list });
    }
    if (req.method === "POST") {
      if (body.title === "Retry preserved title" && !failedCreation) {
        failedCreation = true;
        return send({ error: "Synthetic create failure" }, 503);
      }
      const parent = body.parent_session_id ? sessions.find(current => current.id === body.parent_session_id) : null;
      if (parent) assert.equal(`${parent.owner_type}:${parent.owner_id}`, `${ownerType}:${ownerId}`, "Side chat must follow its parent's owner");
      const created = session(`ses_created_${++count}`, ownerType, ownerId, body.title, { holds_workspace: body.holds_workspace,
        parent_session_id: parent?.id ?? null, inherit_mode: parent ? "snapshot" : "none",
        ...(parent?.issue_id ? { issue_id: parent.issue_id } : {}) });
      sessions.push(created);
      return send(issueSessions ? created : { session: created }, 201);
    }
  }
  const sessionMessages = path.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (sessionMessages) {
    const sessionId = sessionMessages[1];
    if (req.method === "GET") return send({ messages: [], next_cursor: null });
    if (req.method === "POST") {
      assert.equal(body.to.ref, agent.id);
      assert.equal(body.message_kind, "request");
      assert.equal(body.wake_requested, "now");
      assert.equal(typeof body.body_md, "string");
      const created = task(`tsk_created_${++count}`, sessionId, "completed", { prompt: body.body_md });
      tasks.push(created);
      const entries = logs.get(sessionId) ?? [];
      entries.push(...completedLogRows(created, "Browser delegated task result", entries.length + 1));
      logs.set(sessionId, entries);
      return send({ message: messageWire(sessionId, entries.length + 1, body.body_md),
        turn_id: created.turn_id, wake_applied: "now", wake_reason: "started" }, 201);
    }
  }
  const log = path.match(/^\/api\/sessions\/([^/]+)\/log$/);
  if (log) {
    const entries = logs.get(log[1]) ?? [];
    const anchor = url.searchParams.get("anchor");
    const after = Number(url.searchParams.get("after") ?? 0);
    const before = Number(url.searchParams.get("before") ?? 0);
    const selected = anchor === null ? entries : entries.filter(entry => entry.seq >= Number(anchor) - before && entry.seq <= Number(anchor) + after);
    return send({ entries: selected, head_seq: entries.at(-1)?.seq ?? 0, log_version: 1, has_more_before: false, has_more_after: false });
  }
  if (/^\/api\/turns\/[^/]+\/trace$/.test(path)) return send({ events: [], head: 0, next_after_seq: 0, eof: true, closed: true, source: "archive", state: "ok" });
  const turnDetail = path.match(/^\/api\/turns\/([^/]+)$/);
  if (turnDetail) {
    const current = tasks.find(current => current.turn_id === turnDetail[1]);
    assert(current, "Turn detail must use a persisted Turn ID");
    return send({ turn: turnWire(current), input: { from_seq: 0, to_seq: 1,
      messages: [], legacy_prompt: current.prompt ?? null } });
  }
  unknownRequests.push({ method: req.method, path });
  return send({ error: "Unknown fixture request: " + path }, 404);
}

const server = await createServer({ configFile: false, root: join(repo, "frontend/tests/session-dual-ownership"),
  cacheDir: join(artifacts, "vite-cache"), css: { postcss: { plugins: [tailwind()] } }, plugins: [react(), { name: "isolated-session-api", configureServer(server) { server.middlewares.use((...args) => {
    void fixtureApi(...args).catch(error => { args[1].statusCode = 500; args[1].end(String(error)); });
  }); } }],
  resolve: { dedupe: ["react", "react-dom"] }, server: { host: "127.0.0.1", port: 0, fs: { allow: [repo] } },
});
let browser;
let currentPage;
const checks = [];
const pageErrors = [];
let failure;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  const origin = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_EXECUTABLE || undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  currentPage = page;
  page.on("pageerror", error => pageErrors.push(error.message));
  const navigate = async surface => {
    await page.goto(`${origin}/?surface=${surface}`);
    await page.waitForSelector("#root > *", { timeout: 30_000 });
  };
  const fillAndCreate = async title => {
    await page.getByRole("textbox", { name: "Session name", exact: true }).fill(title);
    await page.getByRole("button", { name: "Create", exact: true }).click();
  };
  const selectedId = () => page.getByTestId("selected-session").textContent();
  const sideChat = async title => {
    const row = page.getByRole("button", { name: new RegExp(title) }).locator("..");
    await row.getByRole("button", { name: "Session actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Side chat", exact: true }).click();
  };

  await navigate("issue-empty");
  await page.getByRole("status").getByRole("button", { name: "New session", exact: true }).click();
  const rejectedCreate = page.waitForResponse(response => response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/issues/iss_smoke_empty/sessions");
  await fillAndCreate("Retry preserved title");
  assert.equal((await rejectedCreate).status(), 503);
  await page.getByRole("button", { name: "Create", exact: true }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: "Session name", exact: true }).inputValue(), "Retry preserved title");
  assert.equal(await selectedId(), "", "Failed creation must not select a Session");
  assert.equal(await page.getByRole("dialog", { name: "Create session" }).count(), 1, "Failure must retain the form");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("dialog", { name: "Create session" }).waitFor({ state: "hidden" });
  const issueRootId = await selectedId();
  assert(issueRootId);
  await sideChat("Retry preserved title");
  await fillAndCreate("Issue owned side chat");
  await page.getByRole("dialog", { name: "Create session" }).waitFor({ state: "hidden" });
  checks.push("Issue empty-state creation and failed-form recovery");
  const createdIssueSide = sessions.find(current => current.title === "Issue owned side chat");
  assert.equal(createdIssueSide.owner_type, "issue");
  assert.equal(createdIssueSide.parent_session_id, issueRootId);
  checks.push("Issue-owned side chat uses the Issue owner endpoint");
  await page.screenshot({ path: join(artifacts, "issue-created.png"), fullPage: true });

  await navigate("issue-linked");
  await sideChat("Chat work root");
  await fillAndCreate("Chat owned linked side chat");
  await page.getByRole("dialog", { name: "Create session" }).waitFor({ state: "hidden" });
  const linkedSide = sessions.find(current => current.title === "Chat owned linked side chat");
  assert.equal(linkedSide.owner_type, "chat");
  assert.equal(linkedSide.parent_session_id, chatRoot.id);
  checks.push("Chat-owned parent in Issue aggregation creates its side chat through the Chat endpoint");

  await navigate("chat");
  await page.getByRole("button", { name: "Work Sessions", exact: true }).click();
  await page.getByText("Persistent completed Session result", { exact: true }).waitFor();
  assert.equal(await page.getByText("Persistent completed Session result", { exact: true }).count(), 1,
    "Persisted final body must render once from its independent agent message");
  await page.getByText("Persistent delegated task instructions", { exact: true }).waitFor();
  await page.getByText("Persistent failed Session result", { exact: true }).waitFor();
  await page.getByText("Fixture failure evidence", { exact: true }).waitFor();
  checks.push("Chat work Session reads persisted completed and failed log results");
  const traceRead = page.waitForResponse(response => new URL(response.url()).pathname === `/api/turns/${completed.turn_id}/trace`);
  await page.getByRole("button", { name: "Execution details", exact: true }).first().click();
  assert.equal((await traceRead).status(), 200);
  await page.getByRole("dialog").last().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 2);
  assert(requests.some(request => request.path === `/api/turns/${completed.turn_id}/trace`), "Trace action must load its Turn trace");
  await page.screenshot({ path: join(artifacts, "chat-task-trace.png"), fullPage: true });
  await page.keyboard.press("Escape");
  checks.push("Work Session trace entry opens the real task trace dialog");
  await page.getByRole("button", { name: "Side chat", exact: true }).click();
  await fillAndCreate("Browser Chat panel side chat");
  await page.getByRole("dialog", { name: "Create session" }).waitFor({ state: "hidden" });
  const panelSide = sessions.find(current => current.title === "Browser Chat panel side chat");
  assert.equal(panelSide.owner_type, "chat");
  assert.equal(panelSide.parent_session_id, chatRoot.id);
  checks.push("Chat panel creates a side chat under the selected Chat-owned parent");
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await fillAndCreate("Browser Chat work Session");
  await page.getByRole("dialog", { name: "Create session" }).waitFor({ state: "hidden" });
  const chatWork = sessions.find(current => current.title === "Browser Chat work Session");
  assert.equal(chatWork.owner_type, "chat");
  await page.getByRole("textbox", { name: "Task instructions", exact: true }).fill("Run the isolated browser task");
  await page.getByRole("button", { name: "Delegate task", exact: true }).click();
  await page.getByText("Browser delegated task result", { exact: true }).waitFor();
  assert.equal(await page.getByText("Browser delegated task result", { exact: true }).count(), 1,
    "New final body must render once when the turn references its independent agent message");
  await page.getByText("Run the isolated browser task", { exact: true }).waitFor();
  assert(requests.some(request => request.method === "POST" && request.path === `/api/sessions/${chatWork.id}/messages`
    && request.body.body_md === "Run the isolated browser task"), "Delegate must address the selected Session through the canonical message API");
  checks.push("Chat Session creation, canonical request message and terminal log rendering");
  await page.screenshot({ path: join(artifacts, "chat-work-result.png"), fullPage: true });
  await page.keyboard.press("Escape");
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.fill("Ordinary Chat keeps its queue path");
  const ordinarySend = page.waitForResponse(response => response.request().method() === "POST"
    && new URL(response.url()).pathname === `/api/sessions/${chat.id}/messages`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  assert.equal((await ordinarySend).status(), 200);
  await page.waitForFunction(() => document.body.textContent.includes("Ordinary Chat keeps its queue path"));
  assert(requests.some(request => request.method === "POST" && request.path === `/api/sessions/${chat.id}/messages`
    && request.body.body_md.includes("Ordinary Chat keeps its queue path")), "Ordinary Chat must address its own conversation");
  checks.push("Ordinary Chat sends through its own canonical message endpoint");
  await page.screenshot({ path: join(artifacts, "ordinary-chat.png"), fullPage: true });
  assert.deepEqual(pageErrors, [], "Browser runtime errors");
  assert.deepEqual(unknownRequests, [], "Fixture must explicitly cover every requested API");
  await context.close();
} catch (error) {
  failure = String(error);
  console.error(error);
  if (currentPage) {
    await currentPage.screenshot({ path: join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
    writeFileSync(join(artifacts, "failure.html"), await currentPage.content().catch(() => ""));
  }
} finally {
  writeFileSync(join(artifacts, "result.json"), JSON.stringify({ passed: !failure, fixture: "real React/Vite/HTTP mock, no real backend or model",
    browser: browser?.version(), checks, requests, unknownRequests, pageErrors, failure }, null, 2));
  await browser?.close();
  await server.close();
}
console.log(`${checks.length} browser checks completed; artifacts: ${artifacts}`);
process.exit(failure ? 1 : 0);
