/** Node owns Playwright; the parent Bun process owns the isolated API/database. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

const { frontend, workspace, runtime, runtimeChoices, pat, controlUrl, artifacts, chrome } =
  JSON.parse(process.env.EXECUTION_SMOKE_INPUT!);
const checks: string[] = [],
  apiFailures: string[] = [],
  jsErrors: string[] = [];
const redact = (value: string) => value.split(pat).join("[redacted]");
const check = (name: string) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
const state = async () => {
  const response = await fetch(`${controlUrl}/state`, {
    headers: { Authorization: `Bearer ${pat}` },
  });
  assert(response.ok);
  return response.json() as Promise<any>;
};
const ack = async (bindings: unknown[]) => {
  const response = await fetch(`${controlUrl}/ack`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(bindings),
  });
  assert(response.ok);
};
let browser: Browser | null = null,
  page: Page | null = null,
  failure: unknown = null;
try {
  browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ["--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "en-US",
  });
  await context.addCookies([
    { name: "multimira_logged_in", value: "1", url: frontend },
    { name: "multimira_auth", value: pat, url: frontend, httpOnly: true },
    { name: "last_workspace_slug", value: workspace.slug, url: frontend },
    { name: "multimira-locale", value: "en", url: frontend },
  ]);
  await context.addInitScript(
    (token) => localStorage.setItem("multimira_token", token),
    pat,
  );
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => jsErrors.push(redact(error.message)));
  page.on("response", (response) => {
    if (
      response.url().startsWith(`${frontend}/api/`) &&
      response.status() >= 500 &&
      response.headers()["x-configuration-smoke-injected-fault"] !== "1"
    )
      apiFailures.push(
        `${new URL(response.url()).pathname} ${response.status()}`,
      );
  });

  assert.equal((await state()).groups.length, 0);
  await page.goto(`${frontend}/${workspace.slug}/execution-groups`, {
    waitUntil: "domcontentloaded",
    // Cold webpack compilation can exceed 90 seconds on the shared dev host.
    timeout: 180_000,
  });
  await page.getByRole("button", { name: "Add endpoint", exact: true }).waitFor();
  const minimize = page.locator("button").filter({ has: page.locator("svg.lucide-minus") });
  if (await minimize.count()) await minimize.click();
  check("non-local workspace loads without creating execution groups");
  const submit = async (method: string, path: string, label: string) => {
    const pending = page!.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname === path);
    await page!.locator("form").getByRole("button", { name: label, exact: true }).click();
    const response = await pending;
    assert(response.ok(), await response.text());
    const result = await response.json();
    assert(!JSON.stringify(result).includes("synthetic-smoke-key"));
    await page!.locator("form").waitFor({ state: "detached" });
    return result;
  };
  await page.getByRole("button", { name: "Add endpoint", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Shared gateway");
  await page.getByLabel("API base URL", { exact: true }).fill("https://example.test");
  await page.getByRole("checkbox", { name: "anthropic-messages", exact: true }).check();
  await page.getByLabel("API key", { exact: true }).fill("synthetic-smoke-key");
  assert.equal(await page.getByLabel("Model ID", { exact: true }).count(), 0);
  const endpoint = (await submit("POST", "/api/execution-endpoints", "Save endpoint")).endpoint;
  assert.deepEqual(endpoint.connection.protocols, ["openai-responses", "anthropic-messages"]);
  check("one endpoint declares multiple API protocols without model or engine fields");
  await page.getByRole("button", { name: "Add group", exact: true }).click();
  const form = page.getByRole("form", { name: "Capability groups", exact: true });
  assert.equal(await form.getByRole("checkbox").count(), 3);
  for (const member of runtimeChoices) {
    assert(await form.getByText(member.id, { exact: true }).isVisible());
    assert.equal(await form.getByRole("checkbox", { name: new RegExp(member.id) }).count(), 1);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth);
  await form.getByText(runtimeChoices[2].id, { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifacts, "runtime-member-picker-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await form.getByLabel("Name", { exact: true }).fill("Group A");
  await form.getByLabel("Purpose and organization", { exact: true }).fill("Build and review");
  await form.getByLabel("Connection endpoint", { exact: true }).selectOption(endpoint.id);
  await form.getByRole("checkbox", { name: new RegExp(runtime.id) }).check();
  await form.locator("summary").click();
  await form.getByLabel("Model ID", { exact: true }).fill("model-a");
  await form.getByLabel(/Allowed models/).fill("model-a\nmodel-fast");
  const ga = (await submit("POST", "/api/execution-groups", "Save group")).group;
  assert.deepEqual(ga.runtime_ids, [runtime.id]);
  assert.equal(ga.endpoint_id, endpoint.id);
  assert.deepEqual(ga.model_policy, { model: "model-a", models: ["model-a", "model-fast"] });
  assert.equal((await state()).runtimeProfile, null);
  check("group owns model policy and exact machine selection; endpoint does not");
  await page.getByRole("button", { name: "Add group", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Group B");
  await page.getByLabel("Connection endpoint", { exact: true }).selectOption(endpoint.id);
  await page.getByRole("checkbox", { name: new RegExp(runtime.id) }).check();
  const gb = (await submit("POST", "/api/execution-groups", "Save group")).group;
  assert.equal((await state()).profiles.length, 1);
  assert.equal((await state()).localProfiles.length, 0);
  assert.equal((await state()).bindings.length, 2);
  const endpointRow = () => page!.getByRole("article", { name: "Shared gateway", exact: true });
  assert(await endpointRow().getByRole("button", { name: "Delete", exact: true }).isDisabled());
  assert(await endpointRow().getByText(/shared by 2 groups/).isVisible());
  const oldBindings = (await state()).bindings;
  await ack(oldBindings);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Applied", { exact: true }).first().waitFor();
  await endpointRow().getByRole("button", { name: "Edit", exact: true }).click();
  assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "");
  await page.getByLabel("API base URL", { exact: true }).fill("https://changed.example.test");
  await submit("PUT", `/api/execution-endpoints/${endpoint.id}`, "Save endpoint");
  const updated = await state();
  assert.equal(updated.profiles[0].revision, 2);
  assert(updated.keysMatch);
  assert.deepEqual(updated.groups.find((g: any) => g.id === ga.id).modelPolicy, ga.model_policy);
  await ack(oldBindings);
  assert((await state()).members[ga.id].every((m: any) => m.status === "pending"));
  check("shared edit preserves secret and group policy, invalidates old acknowledgements for every group");
  await ack((await state()).bindings);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Applied", { exact: true }).first().waitFor();
  await page.screenshot({ path: join(artifacts, "execution-endpoints-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Add group", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Claude team");
  await page.getByLabel("Execution engine", { exact: true }).selectOption("claude");
  await page.getByLabel("Connection endpoint", { exact: true }).selectOption(endpoint.id);
  assert.equal(await page.getByRole("checkbox", { name: new RegExp(runtime.id) }).count(), 0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  check("same endpoint is selectable by a different compatible engine");
  for (const group of [ga, gb]) {
    const pending = page.waitForResponse(response => response.request().method() === "DELETE" && new URL(response.url()).pathname === `/api/execution-groups/${group.id}`);
    await page.getByRole("article", { name: group.name, exact: true }).getByRole("button", { name: "Delete", exact: true }).click();
    assert((await pending).ok());
    await page.getByRole("article", { name: group.name, exact: true }).waitFor({ state: "detached" });
  }
  const deletion = page.waitForResponse(response => response.request().method() === "DELETE" && new URL(response.url()).pathname === `/api/execution-endpoints/${endpoint.id}`);
  await endpointRow().getByRole("button", { name: "Delete", exact: true }).click();
  assert((await deletion).ok());
  await endpointRow().waitFor({ state: "detached" });
  assert.equal((await state()).profiles.length, 0);
  check("deleting groups releases references so the endpoint can be deleted");
  assert.deepEqual(apiFailures, []);
  assert.deepEqual(jsErrors, []);
  check("no uncaught browser errors or API 5xx");
} catch (error) {
  failure = error;
  console.error(
    redact(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    ),
  );
  if (page)
    await page
      .screenshot({
        path: join(artifacts, "configuration-failure.png"),
        timeout: 5000,
      })
      .catch(() => {});
  if (page)
    writeFileSync(
      join(artifacts, "failure-dom.txt"),
      redact(
        await page
          .locator("body")
          .innerText()
          .catch(() => ""),
      ),
    );
} finally {
  await browser?.close();
}
const result = {
  ok: failure === null,
  checks,
  apiFailures,
  jsErrors,
  realProvider: false,
  error:
    failure instanceof Error
      ? redact(failure.stack ?? failure.message)
      : failure,
};
writeFileSync(join(artifacts, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exitCode = failure === null ? 0 : 1;

async function poll(
  condition: () => boolean | Promise<boolean>,
  timeout: number,
  label: string,
) {
  const deadline = Date.now() + timeout;
  while (!(await condition())) {
    assert(Date.now() < deadline, `Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
