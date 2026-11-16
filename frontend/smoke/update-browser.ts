/** Node worker: real browser, real Web/API and SQLite; credentials via stdin. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const fixture = JSON.parse((await lines.next()).value!);
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const context = await browser.newContext();
await context.addInitScript(({ token }) => {
  localStorage.setItem("multimira_token", token);
  localStorage.setItem("multimira-locale", "en");
  localStorage.setItem("multimira:chat:followUpMode", "steer");
}, { token: fixture.token });
await context.addCookies([{ name: "multimira_logged_in", value: "1", url: fixture.web }, { name: "multimira-locale", value: "en", url: fixture.web }, { name: "multimira_auth", value: fixture.token, url: fixture.web, httpOnly: true }, { name: "last_workspace_slug", value: fixture.slug, url: fixture.web }]);
const page = await context.newPage();
page.setDefaultTimeout(60_000);
const errors: string[] = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto(`${fixture.web}/${fixture.slug}/chat?session=${fixture.sessionId}`);
  const editor = page.locator('[contenteditable="true"]').last();
  await editor.waitFor();
  console.log("BROWSER_READY");
  // Parent controls the actual API gate/process, never browser route mocks.
  const command = async (value: string) => {
    console.log(value);
    assert.equal((await lines.next()).value, value);
  };
  for (const mode of ["gate", "restart"]) {
    await command(`prepare-${mode}`);
    await editor.fill(`continuity-${mode}`);
    const response = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith(`/sessions/${fixture.sessionId}/messages`) && r.ok()).then(value => ({ value, error: null }), error => ({ value: null, error }));
    await page.getByRole("button", { name: /^(Send|Steer|发送|送信|보내기)$/ }).click();
    await page.getByText(/Sending|发送中|送信中|전송 중/).first().waitFor();
    if (mode === "gate") {
      const bounds = await page.locator('[data-update-state="switching"]').boundingBox();
      assert(bounds && bounds.y >= 0 && bounds.height > 0, "Maintenance banner must be fully visible");
    }
    await page.screenshot({ path: join(fixture.artifacts, `pending-${mode}.png`) });
    console.log(`PENDING_${mode}`);
    const accepted = await response;
    if (accepted.error) throw accepted.error;
    await page.getByText(`continuity-${mode}`, { exact: true }).first().waitFor();
    assert.equal(await page.getByText(/Delivery unconfirmed|Failed to send|发送失败|未确认送达/).count(), 0);
    console.log(`SENT_${mode}`);
  }
  // Keep the old document open while the parent swaps standalone A for B.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await command("swap-build");
  const documentRequest = page.waitForRequest(r => r.isNavigationRequest() && r.resourceType() === "document");
  const link = page.getByRole("link", { name: /Issues|任务|课题|이슈/, exact: true }).first();
  await link.click();
  await documentRequest;
  await page.waitForLoadState("networkidle");
  assert.deepEqual(await page.evaluate(() => fetch("/health/build", { cache: "no-store" }).then(r => r.json())), { build_id: "mul34-build-b" });
  assert.equal(errors.length, 0, errors.join("\n"));
  assert.equal(await page.getByText(/Application error|ChunkLoadError|Loading chunk .*failed/).count(), 0);
  await page.screenshot({ path: join(fixture.artifacts, "build-b.png") });
  console.log("BUILD_B_OK");
} catch (error) { await page.screenshot({ path: join(fixture.artifacts, "failure.png") }); throw error; } finally { await browser.close(); }
