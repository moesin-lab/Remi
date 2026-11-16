import { afterEach, describe, expect, it } from "bun:test";
import { GitHubScmOperations } from "@multiremi/scm/operations.js";
import { scmBinding, scmConnection } from "./scm-test-helpers.js";

const originalFetch = globalThis.fetch;
function stubFetch(handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): typeof fetch {
  return Object.assign(handler, { preconnect: originalFetch.preconnect });
}
const head = "a".repeat(40);
const base = "b".repeat(40);
export const pull = {
  id: 9001, number: 42, title: "MUL-35 gate", body: "", state: "open", draft: true,
  head: { ref: "feature", sha: head, repo: { full_name: "acme/widgets" } }, base: { ref: "main", sha: base },
  html_url: "https://github.com/acme/widgets/pull/42", updated_at: "2026-11-16T00:00:00Z",
};
function adapter() {
  return new GitHubScmOperations({ connection: scmConnection(), binding: scmBinding(), credential: { accessToken: "token", webhookSecret: null } });
}
function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { status, headers });
}
afterEach(() => { globalThis.fetch = originalFetch; });

describe("GitHub active SCM adapter (mock provider)", () => {
  it("paginates checks, binds Actions app/workflow/job and keeps latest status", async () => {
    const requested: string[] = [];
    globalThis.fetch = stubFetch(async (url) => {
      const parsed = new URL(String(url));
      requested.push(parsed.pathname + parsed.search);
      if (parsed.pathname.endsWith("check-runs")) {
        const run = { id: 7, name: "build", head_sha: head, status: "completed", conclusion: "success", app: { id: 15368, slug: "github-actions" }, check_suite: { id: 99 } };
        return parsed.searchParams.get("page") === "1"
          ? json({ check_runs: [run] }, 200, { link: '<https://api.github.com/page2>; rel="next"' })
          : json({ check_runs: [{ ...run, id: 8, name: "lint" }] });
      }
      if (parsed.pathname.endsWith("actions/runs")) {
        expect(parsed.searchParams.get("head_sha")).toBe(head);
        return json({ workflow_runs: [{ id: 5, status: "completed", conclusion: "success", run_attempt: 1, check_suite_id: 99, head_sha: head, path: ".github/workflows/release-build-check.yml" }] });
      }
      return json([{ id: 2, context: "external", state: "success" }, { id: 1, context: "external", state: "failure" }]);
    });
    const summary = await adapter().checks(head);
    expect(summary.conclusion).toBe("success");
    expect(summary.checks).toHaveLength(4);
    expect(summary.checks[0]).toMatchObject({ appId: 15368, appSlug: "github-actions", name: "build", workflowPath: ".github/workflows/release-build-check.yml", headSha: head });
    expect(requested.filter(path => path.includes("actions/runs"))).toHaveLength(1);
    expect(requested.some(path => path.includes("page=2"))).toBe(true);
  });

  it("treats empty, unknown, skipped, pending and failed evidence conservatively", async () => {
    for (const [state, expected] of [[null, "missing"], ["pending", "pending"], ["skipped", "pending"], ["unknown", "pending"], ["error", "failure"]] as const) {
      globalThis.fetch = stubFetch(async (url) => String(url).includes("actions/runs") ? json({ workflow_runs: [] }) : String(url).includes("check-runs") ? json({ check_runs: [] }) : json(state ? [{ id: 1, context: "test", state }] : []));
      expect((await adapter().checks(head)).conclusion).toBe(expected);
    }
  });

  it("fails closed on SHA mismatch, provider error, and truncated evidence", async () => {
    globalThis.fetch = stubFetch(async (url) => String(url).includes("actions/runs") ? json({ workflow_runs: [] }) : String(url).includes("check-runs") ? json({ check_runs: [{ id: 7, name: "build", head_sha: base }] }) : json([]));
    await expect(adapter().checks(head)).rejects.toMatchObject({ code: "scm_evidence_mismatch" });
    globalThis.fetch = stubFetch(async (_input) => json({}, 403));
    await expect(adapter().checks(head)).rejects.toMatchObject({ status: 403 });
    globalThis.fetch = stubFetch(async (_input) => json({ check_runs: [], total_count: 1 }));
    await expect(adapter().checks(head)).rejects.toMatchObject({ code: "scm_evidence_incomplete" });
    globalThis.fetch = stubFetch(async (_input) => json({ check_runs: [] }, 200, { link: '<https://evil.invalid>; rel="next"' }));
    await expect(adapter().checks(head)).rejects.toMatchObject({ code: "scm_evidence_incomplete" });
  });

  it("leaves workflow unknown when provider association is not proven", async () => {
    globalThis.fetch = stubFetch(async (url) => {
      if (String(url).includes("check-runs")) return json({ check_runs: [{ id: 1, name: "build", head_sha: head, status: "completed", conclusion: "success", app: { id: 15368, slug: "github-actions" }, check_suite: { id: 99 } }] });
      if (String(url).includes("actions/runs")) return json({ workflow_runs: [{ id: 5, check_suite_id: 100, head_sha: head, path: ".github/workflows/release-build-check.yml" }] });
      return json([]);
    });
    expect((await adapter().checks(head)).checks[0]?.workflowPath).toBeNull();
  });

  it("observes workflows without job checks, including queued reruns and cancellation", async () => {
    for (const state of ["queued", "in_progress", "cancelled"] as const) {
      for (const otherSucceeded of [false, true]) {
        globalThis.fetch = stubFetch(async (url) => {
          if (String(url).includes("actions/runs")) return json({ workflow_runs: [
            { id: 5, head_sha: head, status: "completed", conclusion: "success", run_attempt: 1 },
            { id: 5, head_sha: head, status: state === "cancelled" ? "completed" : state,
              conclusion: state === "cancelled" ? state : null, run_attempt: 2 },
          ] });
          if (String(url).includes("check-runs")) return json({ check_runs: [] });
          return json(otherSucceeded ? [{ id: 2, context: "external", state: "success" }] : []);
        });
        const summary = await adapter().checks(head);
        expect(summary.conclusion).toBe(state === "cancelled" ? "failure" : "pending");
        expect(summary.checks.filter(check => check.kind === "workflow_run")).toEqual([
          expect.objectContaining({ id: "5", runAttempt: 2, status: state === "cancelled" ? "completed" : state }),
        ]);
      }
    }
  });

  it("reports unverified providers as explicitly unavailable", () => {
    expect(() => new GitHubScmOperations({ connection: scmConnection({ provider: "codebase" }), binding: scmBinding(), credential: { accessToken: "token", webhookSecret: null } })).toThrow("not verified");
  });
});
