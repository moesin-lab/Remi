import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configureKindBot } from "../../tests/unit/multiremi/feishu-outbound-kind-fixture";
import { chromium, firefox } from "playwright-core";
import { startMultiremiServer } from "@multiremi/api.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { MultiremiStore } from "@multiremi/store.js";

for (const key of Object.keys(process.env)) {
  if (key.startsWith("MULTIREMI_") || key.startsWith("REMI_")) delete process.env[key];
}
const root = mkdtempSync(join(tmpdir(), "remi-autopilot-browser-"));
process.env.MULTIREMI_STATE_DIR = join(root, "state");
process.env.MULTIREMI_WORKSPACE_ROOT = join(root, "workspaces");
process.env.MULTIREMI_UPLOAD_DIR = join(root, "uploads");
process.env.NODE_ENV = "test";
process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
const db = openSqliteDatabase(join(root, "smoke.sqlite"));
const store = new MultiremiStore(db);
store.ensureLocalWorkspace();
const user = store.getOrCreateUser({ name: "Browser tester", email: "browser@example.test" });
const workspace = store.createWorkspace({ name: "Delivery smoke", slug: "delivery-smoke" }, user.id);
const agent = store.createAgent({ workspaceId: workspace.id, ownerId: user.id, name: "Reporter", provider: "codex" });
const makeTarget = (title: string) => store.createChatSession({ workspaceId: workspace.id, creatorId: user.id, agentId: agent.id, title });
const first = makeTarget("Morning reports");
const member = store.getWorkspaceOperator(workspace.id);
assert(member);
const bot = configureKindBot(store, workspace.id, "rt_browser_fixture", member.id);
const inbound = bot.inbound("browser-fixture");
store.completeTask(inbound.taskId, { output: "Fixture initialized" });
const second = store.updateChatSession(inbound.chatSessionId, { title: "Evening reports" });
assert(second);
const autopilot = store.createAutopilot({ workspaceId: workspace.id, assigneeId: agent.id, title: "Browser report", executionMode: "run_only" });
const { token } = await store.createAccessToken({ type: "pat", name: "Browser smoke", workspaceId: workspace.id, userId: user.id });
const server = startMultiremiServer({ store, authToken: randomUUID(), hostname: "127.0.0.1", port: 0, backgroundJobs: false, scheduler: null, messaging: null, scmPolling: null, controlPlaneSshMesh: null });
const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
const port = portProbe.port!;
portProbe.stop(true);
const frontend = `http://127.0.0.1:${port}`;
const next = Bun.spawn(["node", require.resolve("next/dist/bin/next"), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: resolve(import.meta.dir, "../apps/web"), stdout: "ignore", stderr: "inherit",
  env: { ...process.env, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1", REMOTE_API_URL: `http://127.0.0.1:${server.port}`, NEXT_PUBLIC_API_URL: "", NEXT_PUBLIC_WS_URL: `ws://127.0.0.1:${server.port}/ws` },
});
let browser;
try {
  const limit = Date.now() + 90_000;
  while (true) {
    const response = await fetch(`${frontend}/api/health`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
    if (response && response.status < 500) break;
    assert(next.exitCode === null && Date.now() < limit, "Isolated Next server did not start");
    await Bun.sleep(300);
  }
  const engine = process.env.FIREFOX_EXECUTABLE ? firefox : chromium;
  browser = await engine.launch({ executablePath: process.env.FIREFOX_EXECUTABLE || process.env.CHROME_EXECUTABLE, headless: true });
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1440, height: 1000 } });
  await context.addCookies([
    { name: "multimira_logged_in", value: "1", url: frontend }, { name: "multimira_auth", value: token, httpOnly: true, url: frontend },
    { name: "multimira-locale", value: "en", url: frontend }, { name: "last_workspace_slug", value: workspace.slug, url: frontend },
  ]);
  await context.addInitScript(value => localStorage.setItem("multimira_token", value), token);
  const page = await context.newPage();
  const migrationSignals: unknown[] = [];
  page.on("websocket", socket => {
    if (new URL(socket.url()).pathname !== "/ws") return;
    socket.on("framereceived", ({ payload }) => {
      const frame = JSON.parse(payload.toString());
      if (frame.type === "autopilot:delivery_targets_changed") migrationSignals.push(frame.payload);
    });
  });
  page.setDefaultTimeout(30_000);
  const unbound = "Reports are saved only in the internal session. No report is sent to a user Chat.";
  await page.goto(`${frontend}/${workspace.slug}/autopilots`, { timeout: 120_000 });
  await page.getByText(unbound, { exact: true }).waitFor();
  await page.getByRole("link", { name: /Browser report/ }).click();
  const edit = () => page.getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const choose = async (id: string) => {
    await dialog.getByRole("button", { name: "Choose delivery Chat" }).click();
    const filter = page.getByPlaceholder("Choose delivery Chat");
    await filter.fill(id);
    await page.getByRole("button", { name: new RegExp(id) }).waitFor();
    await filter.press("Enter");
  };
  const save = async () => {
    const response = page.waitForResponse(item => item.request().method() === "PATCH" && item.url().endsWith(`/autopilots/${autopilot.id}`));
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    return await response;
  };
  for (const [target, channel] of [[first, "Web Chat"], [second, "Feishu"]] as const) {
    await edit();
    await choose(target.id);
    assert((await save()).ok());
    await dialog.waitFor({ state: "hidden" });
    assert.equal(store.getAutopilot(autopilot.id)?.deliveryChatSessionId, target.id);
    await page.reload();
    await page.getByText(`${target.title} · ${channel} · ${target.id}`, { exact: true }).waitFor();
  }
  await edit();
  await choose(first.id);
  store.updateChatSession(first.id, { status: "archived" });
  assert.equal((await save()).status(), 400);
  await dialog.getByText(`Target unavailable · ${first.id}`).waitFor();
  assert.equal(store.getAutopilot(autopilot.id)?.deliveryChatSessionId, second.id);
  await dialog.getByRole("button", { name: "Clear delivery target" }).click();
  assert((await save()).ok());
  await dialog.waitFor({ state: "hidden" });
  await page.reload();
  await page.getByText(unbound, { exact: true }).waitFor();
  assert.equal(store.getAutopilot(autopilot.id)?.deliveryChatSessionId, null);
  await page.goto(`${frontend}/${workspace.slug}/autopilots`);
  await page.getByRole("button", { name: "New autopilot" }).click();
  await dialog.getByLabel("Autopilot name").fill("Created in browser");
  await dialog.getByRole("button", { name: /Select agent or squad/ }).click();
  await page.getByRole("button", { name: "Reporter" }).click();
  await dialog.getByRole("button", { name: /^Run only/ }).click();
  await choose(second.id);
  await dialog.getByRole("button", { name: /^Create issue/ }).click();
  await dialog.getByText(`${second.title} · Feishu · ${second.id}`, { exact: true }).waitFor();
  const creation = page.waitForResponse(item => item.request().method() === "POST" && item.url().endsWith("/api/autopilots"));
  await dialog.getByRole("button", { name: "Create autopilot", exact: true }).click();
  const created = await creation;
  assert(created.ok());
  const createdId = (await created.json()).id;
  assert.equal(store.getAutopilot(createdId)?.deliveryChatSessionId, second.id);
  await dialog.waitFor({ state: "hidden" });
  await page.reload();
  await page.getByRole("link", { name: /Created in browser/ }).getByText(`${second.title} · Feishu · ${second.id}`).waitFor();
  for (const scenario of ["missing target", "different target", "missing ID", "lost headers", "explicit rejection"]) {
    let posts = 0;
    let committedId = "";
    const path = "**/api/autopilots";
    await page.route(path, async route => {
      if (route.request().method() !== "POST") return route.continue();
      posts++;
      assert.equal(route.request().postDataJSON().delivery_chat_session_id, second.id);
      if (scenario === "explicit rejection" && posts === 1) return route.fulfill({ status: 403, json: { error: "Forbidden" } });
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      const body = await response.json();
      committedId = body.id;
      if (scenario === "lost headers") return route.abort("connectionreset");
      if (scenario === "missing ID") delete body.id;
      if (scenario === "missing target") delete body.delivery_chat_session_id;
      if (scenario === "different target") {
        body.delivery_chat_session_id = null;
        store.updateAutopilot(committedId, { deliveryChatSessionId: null });
      }
      await route.fulfill({ response, json: body });
    });
    await page.getByRole("button", { name: "New autopilot" }).click();
    await dialog.getByLabel("Autopilot name").fill(scenario);
    await dialog.getByRole("button", { name: /Select agent or squad/ }).click();
    await page.getByRole("button", { name: "Reporter" }).click();
    await dialog.getByRole("button", { name: /^Run only/ }).click();
    await choose(second.id);
    await dialog.getByRole("button", { name: "Create autopilot", exact: true }).click();
    if (scenario === "explicit rejection") {
      await dialog.getByRole("alert").waitFor();
      assert(await dialog.getByLabel("Autopilot name").isEditable());
      await dialog.getByRole("button", { name: "Create autopilot", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(posts, 2);
      assert.equal(store.listAutopilotTriggers(committedId).length, 1);
      await page.unroute(path);
      continue;
    }
    const resume = dialog.getByRole("button", { name: "Verify and continue" });
    await resume.waitFor();
    assert.equal(store.listAutopilotTriggers(committedId).length, 0);
    if (scenario === "missing ID" || scenario === "lost headers") {
      assert(await resume.isDisabled());
      await dialog.getByText(/Check the autopilot list/).waitFor();
      if (scenario === "lost headers") await dialog.getByText(/Could not confirm whether this autopilot was created/).waitFor();
      await resume.click({ force: true });
      assert.equal(store.listAutopilotTriggers(committedId).length, 0);
      await dialog.getByRole("button", { name: "Cancel" }).click();
    } else {
      await dialog.getByText(new RegExp(committedId)).waitFor();
      await resume.click();
      await dialog.waitFor({ state: "hidden" });
      assert.equal(store.getAutopilot(committedId)?.deliveryChatSessionId, second.id);
      assert.equal(store.listAutopilotTriggers(committedId).length, 1);
    }
    assert.equal(posts, 1);
    assert.deepEqual(store.listAutopilots(workspace.id).filter(item => item.title === scenario).map(item => item.id), [committedId]);
    await page.unroute(path);
  }
  await page.getByRole("link", { name: /Created in browser/ }).click();
  await edit();
  await dialog.getByRole("button", { name: "Choose delivery Chat" }).click();
  const candidate = page.getByRole("button", { name: new RegExp(second.id) });
  await candidate.waitFor();
  const destination = store.createWorkspace({ name: "Migration destination" }, user.id);
  const refresh = page.waitForResponse(response => new URL(response.url()).pathname === "/api/autopilot-delivery-targets" && response.ok());
  const moved = await page.request.put(`${frontend}/api/agents/${bot.agent.id}`, {
    headers: { Authorization: `Bearer ${token}` }, data: { workspace_id: destination.id },
  });
  assert.equal(moved.status(), 200);
  assert(!(await (await refresh).json()).targets.some((target: { id: string }) => target.id === second.id));
  await dialog.getByText(`Target unavailable · ${second.id}`).waitFor();
  assert.deepEqual(migrationSignals, [{ workspace_id: workspace.id }]);
  assert(await page.getByPlaceholder("Choose delivery Chat").isVisible());
  assert.equal(await candidate.count(), 0);
  assert.equal(await dialog.getByText(new RegExp(second.title)).count(), 0);
  assert.equal(store.getAutopilot(createdId)?.deliveryChatSessionId, second.id);
  console.log("PASS response loss after commit, explicit rejection retry, live Agent migration in open picker");
  console.log("PASS accepted create recovery, original ID and single trigger, missing ID blocks resubmission");
  console.log("PASS list, create, bind, change, reload, rejected archived target, retained draft, mode guard and explicit clear");
} finally {
  await browser?.close();
  next.kill();
  await next.exited;
  server.stop(true);
  db.close();
  rmSync(root, { recursive: true, force: true });
}
