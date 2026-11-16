import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, createResponsibleTestIssue, resetMultiremiTestEnv } from "./helpers.js";
import { defaultMergePolicy, validateMergePolicy, validateReview } from "@multiremi/scm/merge-policy.js";
import { evaluateMergeGate } from "@multiremi/scm/merge-gate.js";
import { readGitHubRequiredChecks, resolveRepositoryChecks } from "@multiremi/scm/github-required-checks.js";
import { GitHubScmOperations } from "@multiremi/scm/operations.js";
import { scmBinding, scmConnection } from "./scm-test-helpers.js";
import { runMigrations } from "@multiremi/store/migrations.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import type { ScmStructuredReview, RequiredMergeCheck } from "@multiremi/contracts/merge-policy.js";
const originalFetch = globalThis.fetch;
const originalKey = process.env.MULTIREMI_SCM_ENCRYPTION_KEY;
const head = "a".repeat(40), base = "b".repeat(40);
const pull = { id: 9001, number: 42, title: "PR", draft: false, state: "open", head: { ref: "feature", sha: head, repo: { full_name: "acme/widgets" } }, base: { ref: "main", sha: base, repo: { full_name: "acme/widgets" } }, updated_at: "2026-11-16T00:00:00Z" };
const identity = { head_sha: head, base_sha: base, target_branch: "main", base_repository_full_name: "acme/widgets" };
const required: Extract<RequiredMergeCheck, { kind: "check_run" }> = { kind: "check_run", app_id: 15368, workflow_path: ".github/workflows/release-build-check.yml", job: "build" };
const memberHeaders = { Authorization: "Bearer dashboard-secret", "Content-Type": "application/json" };
function mock(handler: (path: string, init?: RequestInit) => unknown) {
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const result = handler(new URL(String(input)).pathname + new URL(String(input)).search, init);
    return result instanceof Response ? result : Response.json(result);
  }, { preconnect: originalFetch.preconnect });
}
afterEach(() => { globalThis.fetch = originalFetch; if (originalKey === undefined) delete process.env.MULTIREMI_SCM_ENCRYPTION_KEY; else process.env.MULTIREMI_SCM_ENCRYPTION_KEY = originalKey; resetMultiremiTestEnv(); });
function reviewBody(verdict = "pass") { return { schema_version: 1, head_sha: head, base_sha: base, verdict, summary: "Inspected diff and evidence", findings: [], evidence: ["bun test regression"] }; }
async function fixture() {
  process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  const store = createStore(); store.ensureLocalWorkspace();
  store.updateWorkspace("local", { repos: [{ id: "repo_widgets", name: "widgets", url: "https://github.com/acme/widgets.git", defaultBranch: "main" }] });
  store.createScmConnection({ id: "scm_github", workspaceId: "local", name: "GitHub", provider: "github", accessToken: "secret-provider-token", repositoryIds: ["repo_widgets"] });
  const project = store.createProject({ title: "Merge policy" });
  const issue = createResponsibleTestIssue(store, { title: "Gate", projectId: project.id, workspaceId: "local" });
  const app = createMultiremiApp({ store, authToken: "dashboard-secret", backgroundJobs: false });
  const agents = ["creator", "reviewer", "reviewer2", "outsider"].map(name => store.createAgent({ name, provider: "codex", workspaceId: "local" }));
  const headers = await Promise.all(agents.map(async agent => {
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "SCM" });
    const token = await store.createTaskAccessToken(task, "local");
    return { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" };
  }));
  const active = "/api/workspaces/local/scm/repositories/repo_widgets/change-requests";
  mock((_path, init) => init?.method === "POST" ? pull : []);
  expect((await app.request(active, { method: "POST", headers: headers[0], body: JSON.stringify({ head: "feature", base: "main", title: "PR" }) })).status).toBe(201);
  const cr = store.mergePolicies.findChangeRequest("scm_github", "repo_widgets", "9001")!;
  store.linkScmChangeRequestToIssue(issue.id, cr.id);
  const root = `/api/projects/${project.id}/change-requests/${cr.id}`;
  const policyRoot = `/api/projects/${project.id}/merge-policy`;
  const policy = { ...defaultMergePolicy(), enabled: true, target_branches: ["main", "release"], independent_reviewers: [agents[0]!.id, agents[1]!.id, agents[2]!.id], required_checks: [required] };
  const { revision: _, ...fields } = policy;
  const update = { ...fields, expected_revision: 0 };
  const save = async (body: unknown = update, h = memberHeaders) => app.request(policyRoot, { method: "PUT", headers: h, body: JSON.stringify(body) });
  const submit = async (n: number, body: unknown = reviewBody()) => app.request(`${root}/reviews`, { method: "POST", headers: headers[n], body: JSON.stringify(body) });
  return { store, app, project, agents, headers, active, cr, root, policyRoot, update, save, submit };
}
function greenProvider(options: { status?: string; conclusion?: string; app?: number; path?: string; rulesFail?: boolean; queued?: boolean; oldFailure?: boolean } = {}) {
  mock(path => {
    if (path.includes("/pulls/")) return pull;
    if (path.includes("/rules/branches/")) return options.rulesFail ? Response.json({}, { status: 403 }) : [];
    if (path.includes("/branches/")) return { name: "main", protected: false };
    if (path.includes("check-runs")) {
      const run = { id: 7, name: "build", head_sha: head, status: options.status ?? "completed", conclusion: options.conclusion ?? "success", app: { id: options.app ?? 15368, slug: "github-actions" }, check_suite: { id: 99 } };
      return { check_runs: options.oldFailure ? [run, { ...run, id: 6, conclusion: "failure" }] : [run] };
    }
    if (path.includes("statuses")) return [];
    if (path.includes("/attempts/")) return { jobs: [{ name: "build", head_sha: head, check_run_url: "https://api.github.com/repos/acme/widgets/check-runs/7" }] };
    if (path.includes("actions/runs")) return { workflow_runs: [{ id: 5, check_suite_id: 99, head_sha: head, path: options.path ?? required.workflow_path, run_number: 5, run_attempt: options.queued ? 2 : 1, status: options.queued ? "queued" : "completed" }] };
    throw new Error(`unexpected ${path}`);
  });
}
async function gate(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await f.app.request(`${f.root}/merge-gate`, { headers: f.headers[0] });
  expect(response.status).toBe(200); return response.json();
}
describe("B1 merge policy and structured reviews (SQLite + mock GitHub)", () => {
  it("defaults disabled with no provider access; task and daemon cannot write policy, members CAS update", async () => {
    const f = await fixture(); mock(() => { throw new Error("disabled must not read provider"); });
    expect(await gate(f)).toMatchObject({ allowed: false, reasons: [{ code: "policy_disabled" }], execution_authorized: false });
    expect((await f.save(f.update, f.headers[0])).status).toBe(403);
    const daemon = await f.store.createAccessToken({ name: "SCM daemon", type: "daemon", workspaceId: "local", daemonId: "dmn_scm" });
    expect((await f.save(f.update, { ...memberHeaders, Authorization: `Bearer ${daemon.token}` })).status).toBe(403);
    expect((await f.save()).status).toBe(200);
    expect((await f.save()).status).toBe(409);
    const db = (f.store as unknown as { db: SqlDatabase }).db;
    runMigrations(db); runMigrations(db);
    expect(f.store.mergePolicies.get(f.project.id)).toMatchObject({ revision: 1, enabled: true });
    expect((await f.app.request(f.policyRoot, { headers: memberHeaders })).status).toBe(200);
  });
  it.each([{ extra: 1 }, { independent_reviewers: [] }, { required_checks: [{ kind: "check_run", job: "build" }] }, { allowed_merge_methods: ["force"] }, { credential_enforcement_mode: "bypass" }, { credential_enforcement_mode: ["strict"] }])("rejects invalid/unknown policy input %j", async change => {
    const f = await fixture(); expect((await f.save({ ...f.update, ...change })).status).toBe(400);
  });
  it("rejects self review, nonallowlisted review, old SHA, and client-forged identity", async () => {
    const f = await fixture(); expect((await f.save()).status).toBe(200); greenProvider();
    expect((await f.submit(0)).status).toBe(403); expect((await f.submit(3)).status).toBe(403);
    expect((await f.submit(1, { ...reviewBody(), head_sha: "c".repeat(40) })).status).toBe(409);
    expect((await f.submit(1, { ...reviewBody(), verdict: ["pass"] })).status).toBe(400);
    expect((await f.submit(1, { ...reviewBody(), reviewer: { kind: "member", id: "local" } })).status).toBe(400);
    expect((await f.submit(1, { ...reviewBody(), verdict: "pass", findings: [{ id: "F1", severity: "high", blocking: true, path: "x.ts", line: 1, message: "block" }] })).status).toBe(400);
    const response = await f.submit(1); expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ review: { reviewer: { kind: "agent", id: f.agents[1]!.id }, policy_revision: 1, target_branch: "main" } });
    const history = await f.app.request(`${f.root}/reviews`, { headers: f.headers[0] });
    expect((await history.json()).reviews).toHaveLength(1);
  });
  it("requires review; pass does not override another reviewer block; latest same reviewer replaces its own verdict", async () => {
    const f = await fixture(); await f.save(); greenProvider();
    expect((await gate(f)).reasons.map((r: { code: string }) => r.code)).toContain("independent_review_missing");
    expect((await f.submit(1, reviewBody("block"))).status).toBe(201); expect((await f.submit(2)).status).toBe(201);
    expect((await gate(f)).reasons.map((r: { code: string }) => r.code)).toContain("review_blocked");
    expect((await f.submit(1)).status).toBe(201); expect((await gate(f)).allowed).toBe(true);
    expect(f.store.mergePolicies.list(f.project.id, f.cr.id)).toHaveLength(3);
  });
  it.each(["push", "base", "retarget", "base_repo", "policy"])("invalidates review after %s", async change => {
    const f = await fixture(); await f.save(); greenProvider(); expect((await f.submit(1)).status).toBe(201);
    if (change === "policy") await f.save({ ...f.update, expected_revision: 1 });
    else {
      const updated = structuredClone(pull);
      if (change === "push") updated.head.sha = "c".repeat(40);
      if (change === "base") updated.base.sha = "c".repeat(40);
      if (change === "retarget") updated.base.ref = "release";
      if (change === "base_repo") updated.base.repo.full_name = "acme/other";
      mock(path => path.includes("/pulls/") ? updated : path.includes("/rules/") ? [] : path.includes("/branches/") ? { name: updated.base.ref, protected: false } : path.includes("check-runs") ? { check_runs: [] } : []);
    }
    expect((await gate(f)).reasons.map((r: { code: string }) => r.code)).toContain("independent_review_missing");
  });
  it.each([{ app: 42 }, { path: ".github/workflows/evil.yml" }, { queued: true }, { conclusion: "skipped" }, { conclusion: "neutral" }, { status: "in_progress" }])("never releases mismatched or non-success checks %j", async options => {
    const f = await fixture(); await f.save(); greenProvider(); await f.submit(1); greenProvider(options);
    const result = await gate(f); expect(result.allowed).toBe(false);
    expect(result.reasons.some((r: { code: string }) => r.code.startsWith("required_check_"))).toBe(true);
  });
  it("uses latest-attempt job IDs despite an older failure and never uses the summary conclusion", async () => {
    const f = await fixture(); await f.save(); greenProvider(); await f.submit(1);
    greenProvider({ oldFailure: true });
    expect((await gate(f)).allowed).toBe(true);
  });
  it("blocks rule read failures and explains credential and human boundaries", async () => {
    const f = await fixture(); await f.save({ ...f.update, require_human_approval: true, credential_enforcement_mode: "strict" }); greenProvider(); await f.submit(1); greenProvider({ rulesFail: true });
    const result = await gate(f); expect(result.allowed).toBe(false);
    expect(result.reasons.map((r: { code: string }) => r.code)).toEqual(expect.arrayContaining(["repository_rules_unavailable", "human_approval_required", "credential_enforcement_unavailable"]));
    expect(result.credential_boundary).toBe("平台入口受控、直推未封闭");
  });
  it("member review records server identity, and an update by a former reviewer invalidates that review", async () => {
    const f = await fixture(); await f.save(); greenProvider();
    expect((await f.submit(1)).status).toBe(201);
    expect((await f.app.request(`${f.active}/42`, { method: "PATCH", headers: f.headers[1], body: JSON.stringify({ title: "update" }) })).status).toBe(200);
    expect((await gate(f)).reasons.map((r: { code: string }) => r.code)).toContain("independent_review_missing");
    expect((await f.submit(1)).status).toBe(403);
    const memberReview = await f.app.request(`${f.root}/reviews`, { method: "POST", headers: memberHeaders, body: JSON.stringify(reviewBody()) });
    expect(memberReview.status).toBe(201);
    expect((await memberReview.json()).review.reviewer).toMatchObject({ kind: "member", turn_id: null });
    expect((await gate(f)).allowed).toBe(true);
  });
  it("blocks incomplete rule pages at the gate and retarget races during preflight", async () => {
    const f = await fixture(); await f.save(); greenProvider(); await f.submit(1);
    mock(path => path.includes("/pulls/") ? pull : path.includes("/rules/") ? Response.json({ invalid: true }) : path.includes("/branches/") ? { name: "main", protected: false } : path.includes("check-runs") ? { check_runs: [] } : []);
    expect((await gate(f)).reasons.map((r: { code: string }) => r.code)).toContain("repository_rules_incomplete");
    let reads = 0;
    mock(path => path.includes("/pulls/") ? (++reads === 1 ? pull : { ...pull, base: { ...pull.base, ref: "release" } }) : path.includes("/rules/") ? [] : path.includes("/branches/") ? { name: "main", protected: false } : path.includes("check-runs") ? { check_runs: [] } : []);
    expect((await gate(f)).reasons.map((r: { code: string }) => r.code)).toContain("pull_request_changed");
  });
  it("unknown creator remains unknown after update; foreign project cannot consume CR", async () => {
    const f = await fixture(); await f.save(); greenProvider();
    const db = (f.store as unknown as { db: SqlDatabase }).db;
    db.query("DELETE FROM multiremi_scm_cr_actors WHERE change_request_id=?").run(f.cr.id);
    expect((await f.submit(1)).status).toBe(403);
    expect((await f.app.request(`${f.active}/42`, { method: "PATCH", headers: f.headers[0], body: JSON.stringify({ title: "new" }) })).status).toBe(200);
    expect((await f.submit(1)).status).toBe(403);
    expect((await gate(f)).reasons.map((r: { code: string }) => r.code)).toContain("cr_ownership_unknown");
    const other = f.store.createProject({ title: "Other" });
    expect((await f.app.request(f.root.replace(f.project.id, other.id) + "/merge-gate", { headers: memberHeaders })).status).toBe(404);
  });
});

describe("repository requirements fail closed", () => {
  it("unions branch protection and inherited effective rules and cannot remove repository requirements", async () => {
    const rules = await readGitHubRequiredChecks(async path => path.endsWith("/protection") ? { required_status_checks: { strict: false, contexts: ["build"], checks: [{ context: "build", app_id: 15368 }] } } : { name: "main", protected: true }, async () => [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: "security", integration_id: null }] } }], "main");
    expect(resolveRepositoryChecks(rules, [required])).toEqual([required, { kind: "commit_status", context: "security" }]);
    expect(() => resolveRepositoryChecks(rules, [])).toThrow("needs app/workflow/job identity");
  });
  it("rejects unsupported semantic rules, missing identities and incomplete pagination", async () => {
    await expect(readGitHubRequiredChecks(async () => ({ name: "main", protected: false }), async () => [{ type: "pull_request" }], "main")).rejects.toMatchObject({ code: "repository_rules_unsupported" });
    await expect(readGitHubRequiredChecks(async p => p.endsWith("protection") ? {} : { name: "main", protected: true }, async () => [], "main")).rejects.toMatchObject({ code: "repository_rules_incomplete" });
    const op = new GitHubScmOperations({ connection: scmConnection(), binding: scmBinding(), credential: { accessToken: "token", webhookSecret: null } });
    let pages = 0;
    mock(path => !path.includes("/rules/") ? { name: "main", protected: false } : (pages++, Response.json([{ type: "required_status_checks" }], { headers: { link: '<https://api.github.com/next>; rel="next"' } })));
    await expect(op.requiredChecks("main")).rejects.toMatchObject({ code: "scm_evidence_incomplete" }); expect(pages).toBe(100);
  });
});
