import { afterEach, describe, expect, it } from "bun:test";
import { matchScmRepositoryBindings } from "@multiremi/scm/repository-reference.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, createResponsibleTestIssue, resetMultiremiTestEnv } from "./helpers.js";

const originalFetch = globalThis.fetch;
function stubFetch(handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): typeof fetch {
  return Object.assign(handler, { preconnect: originalFetch.preconnect });
}
const originalKey = process.env.MULTIREMI_SCM_ENCRYPTION_KEY;
const head = "a".repeat(40);
const pull = { id: 9001, number: 42, title: "PR", state: "open", head: { ref: "feature", sha: head, repo: { full_name: "acme/widgets" } }, base: { ref: "main", sha: "b".repeat(40), repo: { full_name: "acme/widgets" } }, updated_at: "2026-11-16T00:00:00Z" };
const root = "/api/workspaces/local/scm/repositories/repo_widgets/change-requests";
function setup(repositoryUrl = "https://github.com/acme/widgets.git", baseUrl = "https://github.com") {
  process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  const store = createStore();
  store.ensureLocalWorkspace();
  store.updateWorkspace("local", { repos: [{ id: "repo_widgets", name: "widgets", url: repositoryUrl, defaultBranch: "main" }] });
  store.createScmConnection({ id: "scm_github", workspaceId: "local", name: "GitHub", provider: "github", baseUrl, accessToken: "secret-provider-token", repositoryIds: ["repo_widgets"] });
  return { store, app: createMultiremiApp({ store, authToken: "dashboard-secret" }) };
}
const headers = { Authorization: "Bearer dashboard-secret", "Content-Type": "application/json" };
function json(value: unknown, status = 200, headers: Record<string, string> = {}) { return new Response(JSON.stringify(value), { status, headers }); }
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.MULTIREMI_SCM_ENCRYPTION_KEY;
  else process.env.MULTIREMI_SCM_ENCRYPTION_KEY = originalKey;
  resetMultiremiTestEnv();
});

describe("SCM read-only checks HTTP (mock provider)", () => {
  it.each(["repo_widgets", "git@github.com:acme/widgets", "acme/widgets", "ACME/Widgets", "https://github.com/acme/widgets.git", "git@github.com:acme/widgets.git", "ssh://git@github.com/acme/widgets.git", "ssh://git@github.com:22/acme/widgets.git", "https://github.com:443/acme/widgets.git", "http://github.com:80/acme/widgets.git"])("resolves the enabled workspace binding for %s", async reference => {
    const { app } = setup();
    globalThis.fetch = stubFetch(async url => String(url).includes("actions/runs") ? json({ workflow_runs: [] }) : String(url).includes("check-runs") ? json({ check_runs: [] }) : String(url).includes("statuses") ? json([]) : json(pull));
    const response = await app.request(root.replace("repo_widgets", encodeURIComponent(reference)) + "/42/checks", { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ summary: { headSha: head, conclusion: "missing" } });
  });

  it.each([
    "https://TEST_TOKEN@github.com/acme/widgets.git",
    "http://TEST_TOKEN@github.com/acme/widgets.git",
    "https://user:TEST_TOKEN@github.com/acme/widgets.git",
    "https://@github.com/acme/widgets.git",
    " https://@github.com/acme/widgets.git",
    "https://@github.com/acme/widgets.git ",
    ...["\t", "\r", "\n", "\x00", "\x1f"].flatMap(control => [
      `${control}https://@github.com/acme/widgets.git`,
      `https://@github.com/acme/widgets.git${control}`,
    ]),
    "ht\ttps://@github.com/acme/widgets.git",
    "https://@git\nhub.com/acme/widgets.git",
    "https://@git\rhub.com/acme/widgets.git",
    "https:\\@github.com/acme/widgets.git",
    "https:\\\\@github.com/acme/widgets.git",
    "https:@github.com/acme/widgets.git",
    "https:github.com/acme/widgets.git",
    "https:///github.com/acme/widgets.git",
  ])("rejects HTTP userinfo without echoing it or calling the provider: %s", async reference => {
    const { app } = setup();
    let calls = 0;
    globalThis.fetch = stubFetch(async () => { calls++; return json(pull); });
    const response = await app.request(root.replace("repo_widgets", encodeURIComponent(reference)) + "/42/checks", { headers });
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).not.toContain("TEST_TOKEN");
    expect(body).not.toContain(reference);
    expect(calls).toBe(0);
  });

  it.each([
    ["https://github.com/acme/widgets.git", "ssh://git@github.com:2222/acme/widgets.git", 404],
    ["https://github.com/acme/widgets.git", "https://github.com:8443/acme/widgets.git", 404],
    ["https://github.com/acme/widgets.git", "http://github.com:8080/acme/widgets.git", 404],
    ["ssh://git@github.com:2222/acme/widgets.git", "ssh://git@github.com/acme/widgets.git", 404],
    ["ssh://git@github.com:2222/acme/widgets.git", "ssh://git@github.com:2223/acme/widgets.git", 404],
    ["ssh://git@github.com:2222/acme/widgets.git", "ssh://git@elsewhere.example:2222/acme/widgets.git", 404],
    ["ssh://git@github.com:2222/acme/widgets.git", "ssh://git@github.com:2222/acme/widgets.git", 200],
    ["ssh://git@github.com:22/acme/widgets.git", "https://github.com/acme/widgets.git", 200],
  ] as const)("keeps host and non-default ports isolated: %s vs %s", (repositoryUrl, reference, status) => {
    const { store } = setup();
    const binding = { ...store.listScmRepositoryBindings({ workspaceId: "local" })[0]!, repositoryUrl };
    expect(matchScmRepositoryBindings([binding], reference)).toEqual(status === 200 ? [binding] : []);
  });

  it("resolves a canonical HTTPS URL with a non-default port over HTTP", async () => {
    const reference = "https://github.com:8443/acme/widgets.git";
    const { app } = setup(reference, "https://github.com:8443");
    globalThis.fetch = stubFetch(async url => String(url).includes("actions/runs") ? json({ workflow_runs: [] }) : String(url).includes("check-runs") ? json({ check_runs: [] }) : String(url).includes("statuses") ? json([]) : json(pull));
    const response = await app.request(root.replace("repo_widgets", encodeURIComponent(reference)) + "/42/checks", { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ summary: { headSha: head } });
  });

  it("lists only current workspace enabled bindings when resolution fails", async () => {
    const { app, store } = setup();
    const binding = store.listScmRepositoryBindings({ workspaceId: "local" })[0]!;
    store.updateWorkspace("local", { repos: [
      { id: "repo_widgets", name: "widgets", url: binding.repositoryUrl },
      { id: "repo_disabled", name: "disabled", url: "https://github.com/acme/disabled.git" },
    ] });
    store.upsertScmRepositoryBinding({ ...binding, repositoryId: "repo_disabled", name: "disabled", enabled: false });
    const other = store.createWorkspace({ name: "Private", slug: "private-binding" });
    store.updateWorkspace(other.id, { repos: [{ id: "repo_private", name: "private", url: "https://github.com/acme/private.git" }] });
    store.createScmConnection({ id: "scm_private", workspaceId: other.id, name: "Private", provider: "github", accessToken: "private-secret" });
    store.upsertScmRepositoryBinding({ ...binding, workspaceId: other.id, connectionId: "scm_private", repositoryId: "repo_private", name: "private" });
    globalThis.fetch = stubFetch(async () => { throw new Error("must not call provider"); });
    for (const reference of ["repo_unknown", "acme/unknown", "https://elsewhere.example/acme/widgets.git", "garbage"]) {
      const response = await app.request(root.replace("repo_widgets", encodeURIComponent(reference)) + "/42/checks", { headers });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "SCM repository binding not found. Available repository bindings: repo_widgets (acme/widgets)" });
    }
  });

  it("rejects ambiguous names and allows a host-qualified URL", async () => {
    const { app, store } = setup();
    const binding = store.listScmRepositoryBindings({ workspaceId: "local" })[0]!;
    store.updateWorkspace("local", { repos: [
      { id: "repo_widgets", name: "widgets", url: binding.repositoryUrl },
      { id: "repo_enterprise", name: "widgets", url: "https://github.enterprise.example/acme/widgets.git" },
    ] });
    const allowedHosts = process.env.MULTIREMI_SCM_ALLOWED_API_HOSTS;
    try {
      process.env.MULTIREMI_SCM_ALLOWED_API_HOSTS = "github.enterprise.example";
      store.createScmConnection({ id: "scm_enterprise", workspaceId: "local", name: "Enterprise", provider: "github", baseUrl: "https://github.enterprise.example", accessToken: "enterprise-secret", repositoryIds: ["repo_enterprise"] });
    } finally {
      if (allowedHosts === undefined) delete process.env.MULTIREMI_SCM_ALLOWED_API_HOSTS;
      else process.env.MULTIREMI_SCM_ALLOWED_API_HOSTS = allowedHosts;
    }
    const ambiguous = await app.request(root.replace("repo_widgets", "acme%2Fwidgets") + "/42/checks", { headers });
    expect(ambiguous.status).toBe(409);
    const error = await ambiguous.text();
    expect(error).toContain("ambiguous");
    expect(error).toContain("repo_widgets (acme/widgets)");
    expect(error).toContain("repo_enterprise (acme/widgets)");
    globalThis.fetch = stubFetch(async url => String(url).includes("actions/runs") ? json({ workflow_runs: [] }) : String(url).includes("check-runs") ? json({ check_runs: [] }) : String(url).includes("statuses") ? json([]) : json(pull));
    const resolved = await app.request(root.replace("repo_widgets", encodeURIComponent("https://github.com/acme/widgets.git")) + "/42/checks", { headers });
    expect(resolved.status).toBe(200);
  });

  it("returns missing for no checks and rejects head/base changes during the read", async () => {
    const { app } = setup();
    let reads = 0;
    globalThis.fetch = stubFetch(async (url) => {
      if (String(url).includes("actions/runs")) return json({ workflow_runs: [] });
      if (String(url).includes("check-runs")) return json({ check_runs: [] });
      if (String(url).includes("statuses")) return json([]);
      reads++;
      return json(reads <= 3 ? pull : { ...pull, base: { ref: "main", sha: "c".repeat(40) } });
    });
    const first = await app.request(`${root}/42/checks`, { headers });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ summary: { conclusion: "missing", headSha: head } });
    const raced = await app.request(`${root}/42/checks`, { headers });
    expect(raced.status).toBe(409);
    expect(await raced.json()).toMatchObject({ code: "scm_head_changed" });
  });

  it.each([
    { ref: "release", repo: { full_name: "acme/widgets" } },
    { ref: "main", repo: { full_name: "acme/other" } },
  ])("rejects target identity changes with unchanged head/base SHAs: %j", async (base) => {
    const { app } = setup();
    let reads = 0;
    globalThis.fetch = stubFetch(async (url) => {
      if (String(url).includes("actions/runs")) return json({ workflow_runs: [] });
      if (String(url).includes("check-runs")) return json({ check_runs: [{ id: 1, name: "build", status: "completed", conclusion: "success", head_sha: head }] });
      if (String(url).includes("statuses")) return json([]);
      return json(++reads === 1 ? pull : { ...pull, base: { ...pull.base, ...base } });
    });
    const response = await app.request(`${root}/42/checks`, { headers });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "scm_head_changed" });
    expect(reads).toBe(2);
  });

  it("requires authentication and an enabled binding before provider access", async () => {
    const { app, store } = setup();
    globalThis.fetch = stubFetch(async (_input) => { throw new Error("must not call provider"); });
    expect((await app.request(`${root}/42/checks`)).status).toBe(401);
    expect((await app.request(root.replace("repo_widgets", "missing") + "/42/checks", { headers })).status).toBe(404);
    store.updateScmConnection("scm_github", { enabled: false });
    expect((await app.request(`${root}/42/checks`, { headers })).status).toBe(409);
  });

  it("allows workspace-bound task operations and denies cross-workspace and daemon access", async () => {
    const { store, app } = setup();
    const agent = store.createAgent({ name: "SCM task", provider: "codex", workspaceId: "local" });
    const issue = createResponsibleTestIssue(store, { title: "SCM task", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "SCM" });
    const taskToken = await store.createTaskAccessToken(task, "local");
    const other = store.createWorkspace({ name: "Other", slug: "scm-other" });
    const daemon = await store.createAccessToken({ name: "SCM daemon", type: "daemon", workspaceId: "local", daemonId: "dmn_scm" });
    let calls = 0;
    globalThis.fetch = stubFetch(async (url, init) => { calls++; expect(init?.method).toBe("GET"); return String(url).includes("actions/runs") ? json({ workflow_runs: [] }) : String(url).includes("check-runs") ? json({ check_runs: [] }) : String(url).includes("statuses") ? json([]) : json(pull); });
    const taskHeaders = { Authorization: `Bearer ${taskToken.token}`, "Content-Type": "application/json" };
    expect((await app.request(`${root.replace("repo_widgets", "acme%2Fwidgets")}/42/checks`, { headers: taskHeaders })).status).toBe(200);
    expect((await app.request(root.replace("/local/", `/${other.id}/`) + "/42/checks", { headers: taskHeaders })).status).toBe(404);
    expect((await app.request(`${root}/42/checks`, { headers: { Authorization: `Bearer ${daemon.token}` } })).status).toBe(403);
    expect(calls).toBe(5);
    expect(store.listScmCanonicalEvents({ workspaceId: "local" })).toHaveLength(0);
    expect(store.getScmEntitySnapshot("scm_github", "repo_widgets", "change_request", "9001")).toBeNull();
    expect((await app.request(root, { method: "POST", headers: taskHeaders, body: "{}" })).status).toBe(404);
    expect((await app.request(`${root}/42`, { method: "PATCH", headers: taskHeaders, body: "{}" })).status).toBe(404);
  });

  it("distinguishes rate-limited 403 from permission 403 without exposing provider secrets", async () => {
    const { app } = setup();
    for (const rateHeaders of [
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" },
      { "retry-after": "60" },
      {},
    ] as Record<string, string>[]) {
      globalThis.fetch = stubFetch(async () => json({ message: "secret-provider-token" }, 403,
        { ...rateHeaders, "x-private-header": "secret-provider-token" }));
      const response = await app.request(`${root}/42/checks`, { headers });
      expect(response.status).toBe(502);
      const body = await response.text();
      expect(body).not.toContain("secret-provider-token");
      expect(body).not.toContain("x-private-header");
      const limited = Object.keys(rateHeaders).length > 0;
      expect(JSON.parse(body)).toEqual(limited
        ? { error: "SCM provider rate limit exceeded; retry later", code: "scm_rate_limited", providerStatus: 403,
          retryAfterSeconds: "retry-after" in rateHeaders ? 60 : null,
          rateLimitResetAt: "x-ratelimit-reset" in rateHeaders ? 1800000000 : null }
        : { error: "SCM provider request failed", code: "scm_provider_error", providerStatus: 403 });
    }
  });

  it("redacts provider errors, marks timeout unknown, and exposes no merge route", async () => {
    const { app } = setup();
    for (const providerStatus of [403, 429]) {
      globalThis.fetch = stubFetch(async (_input) => json({ message: "secret-provider-token" }, providerStatus));
      const failed = await app.request(`${root}/42/checks`, { headers });
      expect(failed.status).toBe(502);
      const body = await failed.text();
      expect(body).not.toContain("secret-provider-token");
      expect(JSON.parse(body)).toMatchObject({ code: providerStatus === 429 ? "scm_rate_limited" : "scm_provider_error", providerStatus });
    }
    globalThis.fetch = stubFetch(async (_input) => { throw new DOMException("timeout", "TimeoutError"); });
    const timed = await app.request(`${root}/42/checks`, { headers });
    expect(timed.status).toBe(504);
    expect(await timed.json()).toMatchObject({ code: "scm_operation_unknown" });
    expect((await app.request(`${root}/42/merge`, { method: "POST", headers, body: "{}" })).status).toBe(404);
  });
});
