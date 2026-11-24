/** Node/Playwright half of smoke-interaction-recovery.ts. Start through that harness. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { user, workspace, runtime, agent, changedAssignee, frontend, artifacts, pat, controlUrl, controlToken } = JSON.parse(input);
const checks = [], apiFailures = [], jsErrors = [], consoleErrors = [];
let browser, page, failure = null;
const redact = text => text.split(pat).join("[redacted]").split(controlToken).join("[redacted]");
const check = name => { checks.push(name); console.log("PASS " + name); };
// Read/store lifecycle calls only control this process's disposable fixture.
const store = new Proxy({}, { get: (_, method) => async (...args) => {
  const response = await fetch(controlUrl, { method: "POST", headers: { Authorization: "Bearer " + controlToken, "Content-Type": "application/json" }, body: JSON.stringify({ method, args }) });
  const body = await response.json();
  assert(response.ok, JSON.stringify(body));
  return body;
} });
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE || chromium.executablePath(), headless: true, timeout: 30_000 });
  console.log("Browser connected; loading isolated workspace");
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US" });
  await context.addCookies([
    { name: "multimira_logged_in", value: "1", url: frontend },
    { name: "multimira_auth", value: pat, url: frontend, httpOnly: true },
    { name: "last_workspace_slug", value: workspace.slug, url: frontend },
    { name: "multimira-locale", value: "en", url: frontend },
  ]);
  await context.addInitScript(token => localStorage.setItem("multimira_token", token), pat);
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", error => jsErrors.push(redact(error.message)));
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(redact(message.text())); });
  page.on("response", response => {
    if (response.url().startsWith(`${frontend}/api/`) && response.status() >= 500 && response.headers()["x-interaction-smoke-injected-fault"] !== "1") apiFailures.push(`${new URL(response.url()).pathname} ${response.status()}`);
  });


  await page.goto(frontend + "/" + workspace.slug + "/my-issues", { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByText("No issues assigned to you", { exact: true }).waitFor();
  const minimizeChat = async () => {
    const chat = page.locator("[data-floating-chat-window]");
    // A minimized chat stays mounted with zero opacity and pointer-events:none.
    if (await chat.count() && await chat.evaluate(el => getComputedStyle(el).pointerEvents !== "none")) {
      await chat.locator("button").filter({ has: page.locator("svg.lucide-minus") }).click();
    }
  };
  await minimizeChat();
  await page.getByRole("button", { name: /^New Issue/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /^Switch to (Manual|Agent)$/ }).waitFor();
  if (await dialog.getByRole("button", { name: "Switch to Manual", exact: true }).isVisible()) {
    await dialog.getByRole("button", { name: "Switch to Manual", exact: true }).click();
  }
  const title = dialog.getByLabel("Issue title", { exact: true });
  await title.fill("MUL8 manual receipt");
  const createPath = "/api/issues";
  const manualResponse = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === createPath);
  await dialog.getByRole("button", { name: "Create Issue", exact: true }).click();
  const createdResponse = await manualResponse;
  assert.equal(createdResponse.status(), 201, await createdResponse.text());
  const created = await createdResponse.json();
  const receipt = dialog.getByRole("region", { name: "Creation receipt" });
  await receipt.getByText("No agent task was started. Assign an agent from the issue when you are ready.", { exact: true }).waitFor();
  assert.equal((await store.listTasksForIssue(created.id)).length, 0);
  assert.equal((await store.getIssue(created.id))?.workspaceId, workspace.id);
  await page.screenshot({ path: join(artifacts, "creation-receipt.png") });
  // The former toast vanished after a few seconds. This acknowledgement survives.
  await new Promise(resolve => setTimeout(resolve, 5200));
  assert(await receipt.isVisible());
  await receipt.getByRole("button", { name: "View issue", exact: true }).press("Enter");
  await page.waitForURL(url => url.pathname === "/" + workspace.slug + "/issues/" + created.id);
  await dialog.waitFor({ state: "detached" });
  await page.getByText("No linked Sessions to show", { exact: true }).waitFor();
  check("manual creation saves in isolated workspace; durable no-dispatch receipt opens the correct issue by keyboard");

  await page.getByRole("button", { name: /^New Issue/ }).click();
  await title.fill("MUL8 queued receipt");
  await dialog.getByRole("button", { name: "Unassigned", exact: true }).click();
  await page.locator("[data-picker-item]").filter({ hasText: agent.name }).click();
  const assignedResponse = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === createPath);
  await dialog.getByRole("button", { name: "Create Issue", exact: true }).click();
  const assignedResult = await assignedResponse;
  assert.equal(assignedResult.status(), 201, await assignedResult.text());
  const assigned = await assignedResult.json();
  assert.equal(assigned.dispatch_status, "dispatched");
  assert.equal((await store.getTask(assigned.task_id))?.status, "queued");
  await receipt.getByText("An execution task was created and queued. It may still be waiting for a runtime.", { exact: true }).waitFor();
  check("agent creation acknowledgement says queued, not running");
  await receipt.getByRole("button", { name: "Create another", exact: true }).click();
  assert.equal((await title.innerText()).trim(), "");
  await dialog.getByRole("button", { name: "Switch to Agent", exact: true }).click();
  const prompt = dialog.locator('.tiptap[contenteditable="true"]');
  await prompt.fill("MUL8 organize this request; keep my exact context.");
  const quickPath = "/api/issues/quick-create";
  let quickRequests = 0;
  page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === quickPath) quickRequests++; });
  await page.route("**" + quickPath, route => route.fulfill({ status: 503, headers: { "x-interaction-smoke-injected-fault": "1" }, contentType: "application/json", body: JSON.stringify({ error: "Injected connection failure" }) }), { times: 1 });
  await dialog.getByRole("button", { name: /^Let agent create/ }).click();
  await dialog.getByText("Injected connection failure", { exact: true }).waitFor();
  assert.match(await prompt.innerText(), /keep my exact context/);
  assert.equal(await receipt.count(), 0);
  check("failed creation preserves the draft and does not fabricate a success receipt");
  // Slow the real response to exercise two fast submissions against the same UI state.
  await page.route("**" + quickPath, async route => {
    const response = await route.fetch();
    await new Promise(resolve => setTimeout(resolve, 300));
    await route.fulfill({ response });
  }, { times: 1 });
  const quickResponse = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === quickPath && r.status() < 400);
  await prompt.press("Control+Enter");
  await prompt.press("Control+Enter");
  const quickResult = await quickResponse;
  assert.equal(quickResult.status(), 202, await quickResult.text());
  const quick = await quickResult.json();
  await receipt.getByText("Your request was saved and queued for the agent to organize. Open the intake issue to follow progress and generated issues.", { exact: true }).waitFor();
  assert.equal(quickRequests, 2, "One failed attempt plus one accepted attempt, even after double submission");
  assert.equal((await store.getTask(quick.task_id))?.issueId, quick.issue.id);
  await page.screenshot({ path: join(artifacts, "intake-receipt.png") });
  await receipt.getByRole("button", { name: "View request and progress", exact: true }).click();
  await page.waitForURL(url => url.pathname === "/" + workspace.slug + "/issues/" + quick.issue.id);
  check("quick creation accepts only one double-submit and links its durable intake/task receipt");

  // Finish setup through store primitives: no worker or model process is started.
  await store.cancelTask(assigned.task_id);
  await store.cancelTask(quick.task_id);
  const blocked = await store.createIssue({ title: "MUL8 recover original run", workspaceId: workspace.id, createdBy: user.id, assigneeType: "agent", assigneeId: changedAssignee.id, status: "todo" });
  const previous = await store.createTask({ agentId: agent.id, issueId: blocked.id, prompt: "ORIGINAL RECOVERY INSTRUCTIONS: retain Session and tool context.", maxAttempts: 1, assignmentAuthorType: "member", assignmentAuthorId: user.id });
  assert.equal((await store.claimTask(runtime.id))?.id, previous.id);
  await store.startTask(previous.id);
  await store.failTask(previous.id, { error: "Synthetic worker disconnected; original instructions retained.", failureReason: "runtime_disconnected" });
  assert.equal((await store.getTask(previous.id))?.status, "failed");
  await page.goto(frontend + "/" + workspace.slug + "/workbench?issue=" + blocked.id, { waitUntil: "domcontentloaded", timeout: 90_000 });
  const panel = page.getByRole("region", { name: "Execution and recovery" });
  await panel.getByText("Latest run failed", { exact: true }).waitFor();
  await minimizeChat();
  await panel.getByText("Synthetic worker disconnected; original instructions retained.", { exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, "recovery-failed.png") });
  const rerunPath = "/api/issues/" + blocked.id + "/rerun";
  await page.route("**" + rerunPath, route => route.fulfill({ status: 503, headers: { "x-interaction-smoke-injected-fault": "1" }, contentType: "application/json", body: JSON.stringify({ error: "Injected retry failure" }) }), { times: 1 });
  await panel.getByRole("button", { name: "Retry run", exact: true }).click();
  await panel.getByRole("alert").filter({ hasText: "Retry was not confirmed" }).waitFor();
  assert.equal((await store.listTasksForIssue(blocked.id)).length, 1);
  assert.equal(new URL(page.url()).searchParams.get("issue"), blocked.id);
  check("failed retry remains in the selected issue with actionable error and original context");

  const retryResponse = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === rerunPath && r.status() < 400);
  await panel.getByRole("button", { name: "Retry run", exact: true }).click();
  const retryResult = await retryResponse;
  assert.equal(retryResult.status(), 202, await retryResult.text());
  const retried = await retryResult.json();
  const retryTask = await store.getTask(retried.id);
  assert.equal(retryTask.agentId, agent.id);
  assert.equal(retryTask.prompt, previous.prompt);
  assert.equal(retryTask.issueSessionId, previous.issueSessionId);
  assert.equal(retryTask.workspaceId, workspace.id);
  assert.equal((await store.listTasksForIssue(blocked.id)).length, 2);
  await panel.getByText("Queued — waiting to start", { exact: true }).waitFor();
  assert.equal(await panel.getByRole("button", { name: "Retry run", exact: true }).count(), 0);
  check("retry creates one queued run using the original agent, Session and instructions despite changed assignee");

  assert.equal((await store.claimTask(runtime.id))?.id, retryTask.id);
  await store.startTask(retryTask.id);
  await panel.getByText("Agent is working", { exact: true }).waitFor();
  await store.completeTask(retryTask.id, { output: "MUL8_RECOVERY_RESULT: synthetic execution finished, human review remains.", sessionId: "interaction-smoke-provider-session" });
  await panel.getByText("Latest run completed — ready for review", { exact: true }).waitFor();
  assert.notEqual((await store.getIssue(blocked.id))?.status, "done", "Run completion must not approve the issue");
  const traceResponse = page.waitForResponse(r => new URL(r.url()).pathname === "/api/tasks/" + retryTask.id + "/trace");
  await panel.getByRole("button", { name: "View run", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  assert.equal((await traceResponse).status(), 200);
  await page.getByRole("dialog").getByText(agent.name, { exact: true }).waitFor();
  check("live execution moves queued → running → completed; review remains human-owned and latest run opens directly");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.screenshot({ path: join(artifacts, "recovery-completed.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.waitFor();
  await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth);
  const bounds = await panel.boundingBox();
  assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391);
  await page.screenshot({ path: join(artifacts, "recovery-mobile.png") });
  check("390px mobile recovery panel fits the viewport and keeps actions accessible");
  assert.equal((await store.listIssues({ workspaceId: "local" })).length, 0);
  assert.deepEqual(apiFailures, []);
  assert.deepEqual(jsErrors, []);
  check("no writes to local workspace, uncaught browser errors, or unexpected API 5xx");

} catch (error) {
  failure = error;
  console.error(redact(error instanceof Error ? error.stack || error.message : String(error)));
  if (page) {
    await page.screenshot({ path: join(artifacts, "interaction-failure.png"), timeout: 5000 }).catch(() => {});
    writeFileSync(join(artifacts, "failure-dom.txt"), redact(await page.locator("body").innerText({ timeout: 5000 }).catch(() => "")));
  }
} finally {
  // Keep the acceptance evidence even if Chromium teardown is interrupted.
  const result = { ok: failure === null, checks, artifacts, realProvider: false, apiFailures, jsErrors, consoleErrors, error: failure instanceof Error ? redact(failure.stack || failure.message) : failure };
  writeFileSync(join(artifacts, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  await Promise.race([browser?.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 10_000))]);
}
process.exit(failure === null ? 0 : 1);
