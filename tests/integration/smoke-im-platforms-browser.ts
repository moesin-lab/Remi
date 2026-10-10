/** Browser worker for smoke-im-platforms.ts. Run through bun run smoke:im.
 * Playwright runs in Node so its browser transport works on Windows too.
 * Fixture credentials arrive through stdin and never appear in process arguments.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

const { frontend, workspace, other, memberIds, memberToken, ownerToken, artifacts, message } = JSON.parse(readFileSync(0, "utf8")) as {
  frontend: string; workspace: { id: string; slug: string }; other: { slug: string };
  memberIds: { owner: string; member: string };
  memberToken: string; ownerToken: string; artifacts: string; message: { text: string };
};
const checks: string[] = [], jsErrors: string[] = [], apiFailures: string[] = [];
const redact = (text: string) => [ownerToken, memberToken].reduce((value, token) => value.split(token).join("[redacted]"), text);
const check = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
let browser: Browser | null = null, page: Page | null = null, failure: unknown = null;
try {
  browser = await chromium.launch({ executablePath: resolveChrome(), headless: true, timeout: 30_000 });
  const context = await authenticatedContext(browser, ownerToken, workspace.slug);
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(90_000);
  page.on("pageerror", error => jsErrors.push(redact(error.message)));
  page.on("response", response => {
    if (response.url().startsWith(`${frontend}/api/`) && response.status() >= 500 && response.headers()["x-im-smoke-fault"] !== "1") apiFailures.push(`${new URL(response.url()).pathname} ${response.status()}`);
  });
  const base = `/${workspace.slug}/im/feishu`, apiBase = `/api/workspaces/${workspace.id}`;
  const navigate = async (section: string, heading: string) => {
    await page!.getByRole("navigation", { name: "Manage platform capabilities" }).getByRole("link", { name: heading, exact: true }).click();
    await page!.waitForURL(`**${base}${section ? `/${section}` : ""}`);
    await page!.getByRole("heading", { name: heading, exact: true, level: 1 }).waitFor();
  };
  const saveResponse = async (method: string, path: string, action: () => Promise<unknown>) => {
    const pending = page!.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname === path);
    await action(); const response = await pending;
    assert(response.ok(), `${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  await page.goto(`${frontend}${base}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  await page.getByTestId("im-platforms-sidebar").getByRole("link", { name: "Feishu", exact: true }).waitFor();
  assert.equal(await page.getByTestId("im-platforms-sidebar").getByRole("link").count(), 1);
  await page.getByText("2 connections", { exact: false }).waitFor();
  // Close the unrelated floating Chat panel when its default is expanded.
  const minimize = page.locator("button").filter({ has: page.locator("svg.lucide-minus") });
  if (await minimize.isVisible()) {
    await minimize.click();
    await poll(() => minimize.evaluate(button => {
      const panel = button.closest<HTMLElement>('div[style*="pointer-events"]');
      return !panel || getComputedStyle(panel).opacity === "0";
    }), 5000, "chat minimize animation");
  }
  await page.screenshot({ path: join(artifacts, "im-overview-desktop.png") });
  check("IM platforms is a peer sidebar group with Feishu; overview reads both real connections");

  await navigate("bot", "Bot");
  assert.equal(await page.getByLabel("App ID", { exact: true }).inputValue(), "cli_im_smoke");
  assert.equal(await page.getByLabel("App Secret", { exact: true }).inputValue(), "");
  await page.getByLabel("App ID", { exact: true }).fill("cli_im_updated");
  const botSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Feishu concierge bot", exact: true }) });
  const designatedHuman = botSection.getByRole("combobox", { name: "Designated human", exact: true });
  await designatedHuman.selectOption(memberIds.owner);
  const savedBot = await saveResponse("PUT", `${apiBase}/feishu-bot`, () => botSection.getByRole("button", { name: "Save", exact: true }).click());
  assert.equal(savedBot.responsible_member_id, memberIds.owner);
  await page.reload();
  await poll(async () => await page!.getByLabel("App ID", { exact: true }).inputValue() === "cli_im_updated" && await designatedHuman.inputValue() === memberIds.owner, 20_000, "saved bot after reload");
  check("bot configuration saves through HTTP, survives refresh, retains write-only secret and stopped state");
  const menu = page.locator("section").filter({ has: page.getByRole("heading", { name: "Feishu bot menu", exact: true }) });
  await menu.getByRole("button", { name: "Add item", exact: true }).first().click();
  await menu.getByPlaceholder("Menu label").first().fill("Smoke menu");
  await saveResponse("PUT", `${apiBase}/bot-menu`, () => menu.getByRole("button", { name: "Save", exact: true }).click());
  check("bot menu saves through the relocated page without publishing to Feishu");

  await page.getByRole("button", { name: "Add bot", exact: true }).click();
  await page.waitForURL(/bot=new/);
  await page.getByLabel("Bot name", { exact: true }).fill("Second concierge");
  await designatedHuman.selectOption(memberIds.member);
  await botSection.getByText("Default Agent", { exact: true }).locator("..").getByRole("combobox").click();
  await page.getByRole("option", { name: "Group Specialist", exact: true }).click();
  await botSection.getByText("Host machine", { exact: true }).locator("..").getByRole("combobox").click();
  await page.getByRole("option", { name: "im-second-daemon", exact: true }).click();
  await page.getByLabel("App ID", { exact: true }).fill("cli_second_bot");
  await page.getByLabel("App Secret", { exact: true }).fill("second-synthetic-secret");
  const createdBot = await saveResponse("POST", `${apiBase}/feishu-bots`, () => botSection.getByRole("button", { name: "Save", exact: true }).click());
  assert(createdBot.bot_id && createdBot.bot_id !== "default");
  assert.equal(createdBot.responsible_member_id, memberIds.member);
  await page.waitForURL(new RegExp(`bot=${createdBot.bot_id}`));
  await page.reload();
  await poll(async () => await page!.getByLabel("App ID", { exact: true }).inputValue() === "cli_second_bot" && await designatedHuman.inputValue() === memberIds.member, 20_000, "second bot after reload");
  assert.equal(await page.getByLabel("App Secret", { exact: true }).inputValue(), "");
  await page.getByRole("combobox", { name: "Select bot", exact: true }).selectOption("default");
  await poll(async () => await page!.getByLabel("App ID", { exact: true }).inputValue() === "cli_im_updated" && await designatedHuman.inputValue() === memberIds.owner, 20_000, "original bot unchanged");
  await page.getByRole("combobox", { name: "Select bot", exact: true }).selectOption(createdBot.bot_id);
  await poll(async () => await page!.getByLabel("App ID", { exact: true }).inputValue() === "cli_second_bot" && await designatedHuman.inputValue() === memberIds.member, 20_000, "second bot selection");
  await page.screenshot({ path: join(artifacts, "im-multiple-bots-desktop.png") });
  check("second bot is created through the form, survives refresh and switches without overwriting original credentials");

  await page.goto(`${frontend}${base}`);
  await page.getByRole("link", { name: /Second concierge/ }).waitFor();
  await page.getByRole("link", { name: /cli_im_updated/ }).waitFor();
  await page.getByRole("link", { name: /Second concierge/ }).click();
  await page.waitForURL(new RegExp(`bot=${createdBot.bot_id}`));
  check("overview lists both bots and opens the selected bot");

  await page.getByRole("navigation", { name: "Manage platform capabilities" }).getByRole("link", { name: "Access control", exact: true }).click();
  await page.waitForURL(new RegExp(`/access\\?bot=${createdBot.bot_id}`));
  const scopedSave = await saveResponse("PUT", `${apiBase}/feishu-bot`, () => page!.getByRole("switch").click());
  assert.equal(scopedSave.bot_id, createdBot.bot_id);
  assert.equal(scopedSave.sender_access_policy, "allowlist");
  assert.equal(scopedSave.responsible_member_id, memberIds.member);
  await page.getByRole("combobox", { name: "Select bot", exact: true }).selectOption("default");
  await page.getByRole("heading", { name: "Bot capability access", exact: true }).waitFor();
  check("bot selection persists between capability pages and isolates sender access policy");

  await page.goto(`${frontend}${base}/bot?bot=${createdBot.bot_id}`);
  await page.getByLabel("App ID", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await poll(() => page!.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 10_000, "multi-bot mobile overflow");
  await page.screenshot({ path: join(artifacts, "im-multiple-bots-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await botSection.getByRole("button", { name: "Delete", exact: true }).click();
  await saveResponse("DELETE", `${apiBase}/feishu-bot`, () => page!.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click());
  await poll(async () => await page!.getByLabel("App ID", { exact: true }).inputValue() === "cli_im_updated" && await designatedHuman.inputValue() === memberIds.owner, 20_000, "original bot after second deletion");
  check("deleting the second bot preserves the original bot; multi-bot UI fits mobile");

  await navigate("access", "Access control");
  await saveResponse("PUT", `${apiBase}/feishu-bot`, () => page!.getByRole("switch").click());
  await page.getByRole("heading", { name: "Feishu account allowlist" }).waitFor();
  await saveResponse("PUT", `${apiBase}/feishu-bot`, () => page!.getByRole("switch").click());
  check("access policy switches between agent capabilities and sender allowlist");

  await navigate("conversations", "Chats & notifications");
  await page.getByRole("combobox", { name: "Direct messages use", exact: true }).click();
  await page.getByRole("option", { name: "Group Specialist", exact: true }).click();
  await saveResponse("PUT", `${apiBase}/feishu-bot/routes`, () => page!.getByRole("button", { name: "Save routes", exact: true }).click());
  const topics = page.locator("section").filter({ has: page.getByRole("heading", { name: "Issue topics", exact: true }) });
  await topics.getByLabel("Feishu group chat ID", { exact: true }).fill("oc_smoke");
  await topics.getByRole("switch", { name: "Create topics for new Issues", exact: true }).click();
  await saveResponse("PUT", `${apiBase}/issue-topics`, () => topics.getByRole("button", { name: "Save", exact: true }).click());
  check("agent routing and Issue topic configuration save on Chats & notifications");

  await navigate("ingestion", "Message ingestion");
  await page.getByText("Personal connection", { exact: true }).waitFor();
  await page.getByText("Team connection", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Add connection", exact: true }).click();
  const connect = page.getByRole("dialog");
  await connect.getByLabel("Connection name", { exact: true }).fill("Third connection");
  await connect.getByLabel("App ID", { exact: true }).fill("cli_smoke_three");
  await connect.getByLabel("App Secret", { exact: true }).fill("synthetic-only");
  await connect.getByRole("button", { name: "Configure and authorize", exact: true }).click();
  await connect.waitFor({ state: "hidden", timeout: 25_000 });
  await page.getByText("Third connection", { exact: true }).waitFor();
  check("new connection and simulated external authorization complete through real API");
  await page.getByRole("button", { name: "New source", exact: true }).click();
  const source = page.getByRole("dialog");
  await source.getByLabel("Name", { exact: true }).fill("New smoke feed");
  await saveResponse("POST", `${apiBase}/feishu/sources`, () => source.getByRole("button", { name: "Save", exact: true }).click());
  await source.waitFor({ state: "hidden" });
  await page.getByText("New smoke feed", { exact: true }).waitFor();
  check("message source creation persists alongside existing connections and source");

  await navigate("messages", "Message history");
  await page.getByText(message.text, { exact: true }).waitFor();
  await page.getByRole("textbox", { name: "Search message text" }).fill("preserved");
  await page.waitForURL(/q=preserved/);
  await page.reload();
  await page.getByText(message.text, { exact: true }).waitFor();
  check("existing messages and URL filters survive navigation and refresh");
  await page.screenshot({ path: join(artifacts, "im-messages-desktop.png") });

  for (const [legacy, target] of [["integrations", "bot"], ["lark", "bot"], ["feishu-messages", "messages"]]) {
    await page.goto(`${frontend}/${workspace.slug}/settings?tab=${legacy}&q=preserved`);
    await page.waitForURL(`**${base}/${target}?q=preserved`);
  }
  await page.goto(`${frontend}/${workspace.slug}/settings?tab=workspace`);
  await page.getByRole("tab", { name: "General", exact: true }).waitFor();
  assert.equal(await page.getByRole("tab", { name: "Integrations", exact: true }).count(), 0);
  assert.equal(await page.getByRole("tab", { name: "Feishu Messages", exact: true }).count(), 0);
  check("legacy links redirect with filters; Settings no longer owns either IM tab");

  await page.goto(`${frontend}${base}/ingestion`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("heading", { name: "Message ingestion", level: 1 }).waitFor();
  await poll(() => page!.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 10_000, "mobile overflow");
  await page.screenshot({ path: join(artifacts, "im-ingestion-mobile.png") });
  await navigate("messages", "Message history");
  await poll(() => page!.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 10_000, "message mobile overflow");
  await poll(() => page!.locator('nav [aria-current="page"]').evaluate(link => {
    const rect = link.getBoundingClientRect();
    // Browser layout uses subpixels; allow at most one rounding pixel.
    return rect.left >= -1 && rect.right <= innerWidth + 1;
  }), 5000, "selected mobile section visible");
  await page.screenshot({ path: join(artifacts, "im-messages-mobile.png") });
  check("ingestion and message history fit a 390px mobile viewport");
  await page.setViewportSize({ width: 1440, height: 1000 });

  const memberContext = await authenticatedContext(browser, memberToken, workspace.slug);
  const memberPage = await memberContext.newPage(); memberPage.setDefaultTimeout(20_000);
  memberPage.setDefaultNavigationTimeout(90_000);
  const forbiddenRequests: string[] = [];
  memberPage.on("request", request => { if (/\/feishu\/(endpoints|sources)|\/feishu-bot\/(status|candidates|routes|senders)/.test(request.url())) forbiddenRequests.push(request.url()); });
  for (const section of ["", "/bot", "/access", "/conversations", "/ingestion", "/messages"]) {
    await memberPage.goto(`${frontend}${base}${section}`);
    await memberPage.getByRole("heading", { level: 1 }).waitFor();
    if (section === "/messages") await memberPage.getByText(message.text, { exact: true }).waitFor();
  }
  assert.equal(await memberPage.getByRole("button", { name: "Add connection" }).count(), 0);
  assert.deepEqual(forbiddenRequests, []);
  await memberContext.close();
  check("members can read history and never issue operator-only requests across all six pages");

  await page.goto(`${frontend}/${other.slug}/im/feishu/ingestion`);
  await page.getByRole("button", { name: "Add connection", exact: true }).waitFor();
  assert.equal(await page.getByText("Personal connection", { exact: true }).count(), 0);
  await page.goto(`${frontend}${base}/ingestion`);
  await page.getByText("Personal connection", { exact: true }).waitFor();
  check("switching workspaces isolates connection data and restores it on return");

  const fault = `**${apiBase}/feishu/endpoints`;
  await page.route(fault, route => route.fulfill({ status: 503, headers: { "content-type": "application/json", "x-im-smoke-fault": "1" }, body: JSON.stringify({ error: "Injected smoke failure" }) }));
  await page.goto(`${frontend}${base}`);
  await page.getByRole("alert").filter({ hasText: "Could not load IM platform data. Try again." }).waitFor();
  await page.unroute(fault);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByText("3 connections", { exact: false }).waitFor();
  check("failed overview requests show an error and recover on retry");
  assert.deepEqual(jsErrors, []); assert.deepEqual(apiFailures, []);
  check("no uncaught browser errors or unexpected API 5xx");
} catch (error) {
  failure = error;
  console.error(redact(error instanceof Error ? error.stack ?? error.message : String(error)));
  if (page) {
    await page.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {});
    writeFileSync(join(artifacts, "failure-dom.txt"), redact(await page.locator("body").innerText().catch(() => "")));
  }
} finally {
  await browser?.close().catch(() => {});
}
const report = { ok: failure === null, checks, jsErrors, apiFailures, error: failure instanceof Error ? redact(failure.stack ?? failure.message) : failure };
writeFileSync(join(artifacts, "browser-report.json"), JSON.stringify(report, null, 2));
process.exit(failure === null ? 0 : 1);

async function authenticatedContext(browser: Browser, token: string, slug: string): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US" });
  await context.addCookies([{ name: "multimira_logged_in", value: "1", url: frontend }, { name: "multimira_auth", value: token, url: frontend, httpOnly: true }, { name: "last_workspace_slug", value: slug, url: frontend }, { name: "multimira-locale", value: "en", url: frontend }]);
  await context.addInitScript(value => localStorage.setItem("multimira_token", value), token);
  return context;
}
async function poll(condition: () => boolean | Promise<boolean>, timeout: number, label: string): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await condition())) { assert(Date.now() < deadline, `Timed out: ${label}`); await new Promise(done => setTimeout(done, 100)); }
}
function resolveChrome(): string {
  if (process.env.CHROME_EXECUTABLE) { assert(existsSync(process.env.CHROME_EXECUTABLE)); return process.env.CHROME_EXECUTABLE; }
  const caches = [join(homedir(), "AppData/Local/ms-playwright"), join(homedir(), "Library/Caches/ms-playwright"), join(homedir(), ".cache/ms-playwright")];
  const suffixes = ["chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome-headless-shell-win64/chrome-headless-shell.exe", "chrome-headless-shell-mac-arm64/chrome-headless-shell", "chrome-linux64/chrome", "chrome-linux/chrome", "chrome-linux/headless_shell"];
  for (const cache of caches) if (existsSync(cache)) for (const entry of readdirSync(cache).filter(name => name.startsWith("chromium")).sort().reverse()) for (const suffix of suffixes) { const candidate = join(cache, entry, suffix); if (existsSync(candidate)) return candidate; }
  for (const candidate of ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]) if (existsSync(candidate)) return candidate;
  throw new Error("No Chromium found; set CHROME_EXECUTABLE");
}
