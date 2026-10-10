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
    timeout: 90_000,
  });
  await page
    .getByRole("button", { name: "Add profile", exact: true })
    .waitFor();
  await page
    .getByText("No capability groups assigned.", { exact: true })
    .waitFor();
  const minimize = page
    .locator("button")
    .filter({ has: page.locator("svg.lucide-minus") });
  if (await minimize.count()) await minimize.click();
  assert(
    (await page
      .getByRole("link", { name: "Capability groups", exact: true })
      .count()) > 0,
    "Independent configuration navigation is missing",
  );
  check("non-local workspace loads; discovery creates no capability groups");

  const submit = async (method: string, path: string, status: number) => {
    const response = page!.waitForResponse(
      (r) =>
        r.request().method() === method && new URL(r.url()).pathname === path,
    );
    await page!
      .locator("form")
      .getByRole("button", {
        name: path.includes("execution-groups")
          ? "Save group"
          : "Save connection",
        exact: true,
      })
      .click();
    const result = await response;
    assert.equal(result.status(), status, await result.text());
    await page!.locator("form").waitFor({ state: "detached" });
    return result.json();
  };
  const createProfile = async (name: string, model: string) => {
    await page!
      .getByRole("button", { name: "Add profile", exact: true })
      .click();
    const form = page!.locator("form");
    await form.getByLabel("Connection name", { exact: true }).fill(name);
    await form
      .getByLabel("API base URL", { exact: true })
      .fill("https://example.test/v1");
    await form.getByLabel("Model ID", { exact: true }).fill(model);
    await form
      .getByLabel("API key", { exact: true })
      .fill("synthetic-smoke-key");
    const result = await submit("POST", "/api/execution-profiles", 201);
    assert(!JSON.stringify(result).includes("synthetic-smoke-key"));
    return result.profile;
  };
  await page.getByRole("button", { name: "Add group", exact: true }).click();
  const form = page.getByRole("form", {
    name: "Capability groups",
    exact: true,
  });
  assert.equal(await form.getByRole("checkbox").count(), 3);
  for (const member of runtimeChoices) {
    assert(await form.getByText(member.id, { exact: true }).isVisible());
    assert(await form.getByText(member.deviceInfo.split(" · ", 1)[0], { exact: true }).isVisible());
    assert.equal(await form.getByRole("checkbox", { name: new RegExp(member.id) }).count(), 1);
  }
  assert(await form.getByText("Offline", { exact: true }).isVisible());
  await page.screenshot({ path: join(artifacts, "runtime-member-picker-desktop.png"), fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth);
  await form.getByText(runtimeChoices[2].id, { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(artifacts, "runtime-member-picker-mobile.png"), fullPage: false });
  await page.setViewportSize({ width: 1440, height: 1000 });
  check("three same-name Codex runtimes expose machine, status and distinct IDs; long names fit 390px");
  await form.getByLabel("Name", { exact: true }).fill("Group A");
  await form
    .getByLabel("Purpose and organization", { exact: true })
    .fill("Build and review services");
  await form
    .getByLabel("Provider connection", { exact: true })
    .selectOption("new");
  await form.getByLabel("Connection name", { exact: true }).fill("Gateway A");
  await form
    .getByLabel("API base URL", { exact: true })
    .fill("https://example.test/v1");
  await form.getByLabel("Model ID", { exact: true }).fill("model-a");
  await form.getByLabel(/Allowed model IDs/).fill("model-fast");
  await form.getByLabel("API key", { exact: true }).fill("synthetic-smoke-key");
  await form.getByRole("checkbox", { name: new RegExp(runtime.id) }).check();
  const ga = (await submit("POST", "/api/execution-groups", 201)).group;
  assert.deepEqual(ga.runtime_ids, [runtime.id]);
  const memberRow = page.getByRole("article", { name: "Group A", exact: true });
  await memberRow.getByText(runtime.id, { exact: true }).waitFor();
  assert(await memberRow.getByText("Design Mac", { exact: true }).isVisible());
  assert.equal(await memberRow.getByText(runtimeChoices[0].id, { exact: true }).count(), 0);
  check("saving the second Codex binds its exact Runtime ID and keeps the machine visible in the group");
  assert(!JSON.stringify(ga).includes("synthetic-smoke-key"));
  const a = (await state()).profiles.find(
    (profile: any) => profile.id === ga.profile_id,
  )!;
  assert.equal(ga.description, "Build and review services");
  assert.deepEqual(a.profile.models, ["model-a", "model-fast"]);
  assert.equal((await state()).runtimeProfile, null);
  check(
    "creates group, provider, models and membership in one browser save; machine configuration stays empty",
  );
  const b = await createProfile("Gateway B", "model-b");
  assert.equal((await state()).profiles.length, 2);
  assert.equal((await state()).localProfiles.length, 0);
  check(
    "inline and reusable provider connections stay in the selected workspace and never return secrets",
  );
  const createGroup = async (name: string, profileId: string) => {
    await page!.getByRole("button", { name: "Add group", exact: true }).click();
    const form = page!.locator("form");
    await form.getByLabel("Name", { exact: true }).fill(name);
    await form
      .getByRole("combobox", { name: /^Provider connection/ })
      .selectOption(profileId);
    assert.equal(
      await form.getByRole("checkbox", { name: /Other Claude machine/ }).count(),
      0,
    );
    await form.getByRole("checkbox", { name: new RegExp(runtime.id) }).check();
    return (await submit("POST", "/api/execution-groups", 201)).group;
  };
  const gb = await createGroup("Group B", b.id);
  assert.equal((await state()).bindings.length, 2);
  await page.getByText("Pending", { exact: true }).first().waitFor();
  const profileRow = (name: string) =>
    page!
      .getByRole("region", { name: "Connection profiles", exact: true })
      .getByRole("article", { name, exact: true });
  assert(
    await profileRow("Gateway A")
      .getByRole("button", { name: "Delete", exact: true })
      .isDisabled(),
  );
  check(
    "one runtime accepts two profile groups; mismatched engines hidden; bound profiles cannot be deleted",
  );

  const oldBindings = (await state()).bindings;
  await ack(oldBindings);
  await poll(
    async () =>
      (await page!.getByText("Applied", { exact: true }).count()) === 2,
    20_000,
    "ready status polling",
  );
  check(
    "simulated daemon acknowledgements refresh both groups to Applied without reload",
  );
  await page
    .getByRole("textbox", { name: "Search groups", exact: true })
    .fill("review");
  assert.equal(
    await page.getByRole("article", { name: "Group B", exact: true }).count(),
    0,
  );
  await page
    .getByRole("article", { name: "Group A", exact: true })
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  assert(await page.getByRole("checkbox", { name: new RegExp(runtime.id) }).isChecked());
  assert.equal(await page.getByRole("checkbox", { name: new RegExp(runtimeChoices[0].id) }).isChecked(), false);
  check("reopening the group retains the selected Codex without checking another same-name Runtime");
  await page
    .getByRole("button", { name: "Edit provider and models", exact: true })
    .click();
  assert.equal(
    await page
      .locator("form")
      .getByLabel("API key", { exact: true })
      .inputValue(),
    "",
  );
  await page
    .locator("form")
    .getByLabel("Model ID", { exact: true })
    .fill("model-a-next");
  await submit("PUT", `/api/execution-groups/${ga.id}`, 200);
  const updated = (await state()).profiles.find(
    (profile: any) => profile.id === a.id,
  )!;
  await page
    .getByRole("textbox", { name: "Search groups", exact: true })
    .fill("");
  assert.equal(updated.revision, 2);
  assert.equal((await state()).keysMatch, true);
  await ack(oldBindings);
  assert.equal((await state()).members[ga.id][0].status, "pending");
  await page.getByText("Pending", { exact: true }).waitFor();
  const currentBindings = (await state()).bindings;
  await ack(currentBindings);
  await poll(
    async () =>
      (await page!.getByText("Applied", { exact: true }).count()) === 2,
    20_000,
    "new revision ready",
  );
  check(
    "editing retains hidden key, increments revision, rejects old acknowledgement, and reapplies",
  );

  await page
    .getByRole("link", { name: "Assign groups in agent settings", exact: true })
    .click();
  await page
    .getByRole("button", { name: "New agent", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Create Agent",
    exact: true,
  });
  await dialog
    .getByPlaceholder("e.g. Deep Research Agent", { exact: true })
    .fill("Group model smoke agent");
  await dialog
    .getByRole("button", { name: /^Fixed execution group · Group A/ })
    .click();
  await dialog
    .getByRole("button", { name: "Default (provider)", exact: true })
    .click();
  await page.getByRole("button", { name: "model-fast", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "model-b", exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "model-fast", exact: true }).click();
  await dialog
    .getByRole("button", { name: /^Fixed execution group · Group B/ })
    .click();
  await dialog
    .getByRole("button", { name: "Default (provider)", exact: true })
    .click();
  await page.getByRole("button", { name: "model-b", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "model-fast", exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "model-b", exact: true }).click();
  await dialog
    .getByRole("button", { name: /^Fixed execution group · Group A/ })
    .click();
  await dialog
    .getByRole("button", { name: "Default (provider)", exact: true })
    .click();
  await page.getByRole("button", { name: "model-fast", exact: true }).click();
  const createdResponse = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === "/api/agents",
  );
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  const created = await createdResponse;
  assert.equal(created.status(), 201, await created.text());
  const agent = await created.json();
  assert.equal(agent.execution_group_id, ga.id);
  assert.equal(agent.model, "model-fast");
  await dialog.waitFor({ state: "detached" });
  check(
    "assigns group to an agent; switching groups scopes models and clears incompatible selections",
  );

  // Detach the fixture agent before exercising group deletion through the UI.
  const detached = await context.request.put(
    `${frontend}/api/agents/${agent.id}?workspace_id=${workspace.id}`,
    {
      headers: { Authorization: `Bearer ${pat}` },
      data: { execution_group_id: null, model: "", thinking_level: "" },
    },
  );
  assert.equal(detached.status(), 200, await detached.text());
  await page.goto(`${frontend}/${workspace.slug}/execution-groups`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("article", { name: "Group A", exact: true }).waitFor();
  await page.screenshot({
    path: join(artifacts, "configuration-desktop.png"),
    fullPage: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );
  await page.screenshot({
    path: join(artifacts, "configuration-mobile.png"),
    fullPage: false,
  });
  check("390px mobile configuration fits viewport");
  await page
    .getByRole("article", { name: "Group A", exact: true })
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit provider and models", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth);
  await page.screenshot({ path: join(artifacts, "configuration-mobile-editor.png"), fullPage: false });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  check("group provider editor remains usable at 390px");
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const [name, id] of [
    ["Group A", ga.id],
    ["Group B", gb.id],
  ]) {
    const row = page.getByRole("article", { name, exact: true });
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === "DELETE" &&
        new URL(r.url()).pathname === `/api/execution-groups/${id}`,
    );
    await row.getByRole("button", { name: "Delete", exact: true }).click();
    assert.equal((await response).status(), 200);
    await page.getByText(name, { exact: true }).waitFor({ state: "detached" });
  }
  for (const profile of [a, b]) {
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === "DELETE" &&
        new URL(r.url()).pathname === `/api/execution-profiles/${profile.id}`,
    );
    await profileRow(profile.name)
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    assert.equal((await response).status(), 200);
    await page
      .getByText(profile.name, { exact: true })
      .waitFor({ state: "detached" });
  }
  assert.equal((await state()).groups.length, 0);
  assert.equal((await state()).profiles.length, 0);
  check("deleting groups unbinds runtimes and allows profile deletion");
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
