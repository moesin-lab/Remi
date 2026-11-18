import type { MultiremiScmConnection, MultiremiScmConnectionCredential, MultiremiScmRepositoryBinding } from "@multiremi/contracts/types.js";
import type { ScmCheckObservation, ScmCheckSummary } from "@multiremi/contracts/scm-operations.js";
import { githubPullObservation } from "./github.js";
import { hasNextLink, scmRequestJson } from "./http.js";
import type { ScmEntityObservation } from "./types.js";

export interface ScmOperationContext {
  connection: MultiremiScmConnection;
  credential: MultiremiScmConnectionCredential;
  binding: MultiremiScmRepositoryBinding;
  signal?: AbortSignal;
}

export class ScmOperationError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** Read-only live check evidence. No provider mutation methods are exposed. */
export class GitHubScmOperations {
  constructor(private readonly context: ScmOperationContext) {
    if (context.connection.provider !== "github") {
      throw new ScmOperationError("scm_capability_unavailable", "Active SCM operations are not verified for this provider");
    }
    if (!context.connection.enabled || !context.binding.enabled
      || context.binding.connectionId !== context.connection.id
      || context.binding.workspaceId !== context.connection.workspaceId) {
      throw new ScmOperationError("scm_binding_unavailable", "SCM connection or repository binding is unavailable");
    }
    if (!context.binding.owner || !context.binding.name || !context.credential.accessToken?.trim()) {
      throw new ScmOperationError("scm_credentials_unavailable", "SCM repository identity and credentials are required");
    }
  }

  async get(number: number): Promise<ScmEntityObservation> {
    return this.observe(await this.request<Record<string, unknown>>(`/pulls/${pullNumber(number)}`));
  }

  async checks(headSha: string): Promise<ScmCheckSummary> {
    sha(headSha);
    const runs = await this.pages(`/commits/${headSha}/check-runs?filter=latest`, "check_runs");
    const statuses = await this.pages(`/commits/${headSha}/statuses`);
    const workflowRuns = await this.pages(appendQuery("/actions/runs", { head_sha: headSha }), "workflow_runs");
    // A rerun shares its run ID; retain the newest attempt without collapsing distinct runs.
    const workflows = new Map<string, Record<string, unknown>>();
    for (const run of workflowRuns) {
      if (run.head_sha !== headSha) throw new ScmOperationError("scm_evidence_mismatch", "Workflow run does not match requested head SHA");
      const previous = workflows.get(String(run.id));
      if (!previous || Number(run.run_attempt ?? 0) > Number(previous.run_attempt ?? 0)) workflows.set(String(run.id), run);
    }
    const checks: ScmCheckObservation[] = [];
    for (const run of runs) {
      if (run.head_sha !== headSha) throw new ScmOperationError("scm_evidence_mismatch", "Check run does not match requested head SHA");
      const app = record(run.app);
      const suite = record(run.check_suite);
      let workflowPath: string | null = null;
      if (app.slug === "github-actions" && suite.id != null) {
        const matching = [...workflows.values()].filter(item => String(item.check_suite_id) === String(suite.id));
        const paths = new Set(matching.map(item => text(item.path)).filter(Boolean));
        workflowPath = paths.size === 1 ? [...paths][0]! : null;
      }
      checks.push({
        id: String(run.id), kind: "check_run", name: text(run.name) ?? "", headSha,
        appId: typeof app.id === "number" ? app.id : null, appSlug: text(app.slug), workflowPath,
        status: text(run.status) ?? "unknown", conclusion: text(run.conclusion), url: text(run.html_url),
      });
    }
    for (const run of workflows.values()) {
      checks.push({
        id: String(run.id), kind: "workflow_run", name: text(run.name) ?? "", headSha,
        appId: null, appSlug: null, workflowPath: text(run.path),
        status: text(run.status) ?? "unknown", conclusion: text(run.conclusion), url: text(run.html_url),
        runAttempt: typeof run.run_attempt === "number" ? run.run_attempt : null,
      });
    }
    // GitHub statuses are reverse chronological; retain the latest per context.
    const contexts = new Set<string>();
    for (const status of statuses) {
      const name = text(status.context) ?? "";
      if (contexts.has(name)) continue;
      contexts.add(name);
      checks.push({ id: String(status.id), kind: "commit_status", name, headSha,
        appId: null, appSlug: null, workflowPath: null, status: "completed",
        conclusion: text(status.state), url: text(status.target_url) });
    }
    return { headSha, observedAt: new Date().toISOString(), checks, conclusion: summarize(checks) };
  }

  /** Shared coherent read for the CLI and monitor. */
  async liveChecks(number: number): Promise<{ summary: ScmCheckSummary; change: ScmEntityObservation }> {
    const before = await this.get(number);
    const summary = await this.checks(String(before.payload.head_sha));
    const after = await this.get(number);
    if (["head_sha", "base_sha", "target_branch", "base_repository_full_name"].some(key => before.payload[key] !== after.payload[key])) {
      throw new ScmOperationError("scm_head_changed", "Pull request changed while reading checks");
    }
    return { summary, change: after };
  }

  /** A queued workflow alone does not prove runner starvation. */
  async queuedJobs(headSha: string): Promise<Array<{ name: string; url: string | null }>> {
    sha(headSha);
    const runs = await this.pages(appendQuery("/actions/runs", { head_sha: headSha }), "workflow_runs");
    const jobs: Array<{ name: string; url: string | null }> = [];
    for (const run of runs) {
      if (run.head_sha !== headSha) throw new ScmOperationError("scm_evidence_mismatch", "Workflow head mismatch");
      if (!["queued", "in_progress", "waiting", "pending"].includes(String(run.status))) continue;
      for (const job of await this.pages(`/actions/runs/${encodeURIComponent(String(run.id))}/jobs?filter=latest`, "jobs")) {
        if (job.head_sha != null && job.head_sha !== headSha) throw new ScmOperationError("scm_evidence_mismatch", "Job head mismatch");
        if (job.status === "queued" && !job.runner_id && !job.runner_name) jobs.push({ name: String(job.name ?? job.id), url: text(job.html_url) });
      }
    }
    return jobs;
  }

  private observe(pull: Record<string, unknown>): ScmEntityObservation {
    if (!pull.id || !Number.isSafeInteger(pull.number) || !record(pull.head).sha || !record(pull.base).sha) {
      throw new ScmOperationError("scm_invalid_response", "Provider returned an incomplete pull request");
    }
    return githubPullObservation(pull, new Date());
  }

  private async pages(path: string, field?: string): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    for (let page = 1; page <= 100; page++) {
      const { data, headers } = await this.raw(appendQuery(path, { page, per_page: 100 }));
      const entries = field ? record(data)[field] : data;
      if (!Array.isArray(entries)) throw new ScmOperationError("scm_invalid_response", "Provider returned an invalid page");
      rows.push(...entries.map(record));
      if (!hasNextLink(headers.get("link"))) {
        const total = record(data).total_count;
        if (typeof total === "number" && total > rows.length) {
          throw new ScmOperationError("scm_evidence_incomplete", "Provider omitted remaining evidence pages");
        }
        return rows;
      }
    }
    throw new ScmOperationError("scm_evidence_incomplete", "Provider pagination limit exceeded");
  }

  private async request<T>(path: string): Promise<T> {
    return (await this.raw(path)).data as T;
  }

  private raw(path: string) {
    const { connection, credential, binding, signal } = this.context;
    const root = `${connection.apiBaseUrl.replace(/\/$/u, "")}/repos/${encodeURIComponent(binding.owner!)}/${encodeURIComponent(binding.name)}`;
    return scmRequestJson<unknown>(`${root}${path}`, {
      method: "GET",
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "multiremi-scm", Authorization: `Bearer ${credential.accessToken!.trim()}` },
    }, { signal });
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | null { return typeof value === "string" && value ? value : null; }
function sha(value: string) {
  if (!/^[0-9a-f]{40}$/u.test(value)) throw new ScmOperationError("scm_invalid_input", "A full head SHA is required");
}
function pullNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new ScmOperationError("scm_invalid_input", "Invalid pull request number");
  return value;
}
function summarize(checks: ScmCheckObservation[]): ScmCheckSummary["conclusion"] {
  if (!checks.length) return "missing";
  if (checks.some(check => ["failure", "error", "cancelled", "timed_out", "action_required", "stale", "startup_failure"].includes(check.conclusion ?? ""))) return "failure";
  if (checks.some(check => check.status !== "completed" || !["success", "skipped", "neutral"].includes(check.conclusion ?? ""))) return "pending";
  return "success";
}

function appendQuery(path: string, values: Record<string, string | number>): string {
  const url = new URL(path, "https://scm.invalid");
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, String(value));
  return `${url.pathname}${url.search}`;
}
