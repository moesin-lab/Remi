import { readGitHubRequiredChecks } from "./github-required-checks.js";
import type { MultiremiScmConnection, MultiremiScmConnectionCredential, MultiremiScmRepositoryBinding } from "@multiremi/contracts/types.js";
import type { CreateScmPullRequestInput, MergeScmPullRequestInput, ScmCheckObservation, ScmCheckSummary, ScmMergeResult, UpdateScmPullRequestInput } from "@multiremi/contracts/scm-operations.js";
import { githubPullObservation } from "./github.js";
import { hasNextLink, scmRequestJson, ScmHttpError } from "./http.js";
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

/** Server-only adapter. merge() must be called only by the policy/operation service,
 * never directly from an HTTP handler. Requests are not automatically retried. */
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

  async create(input: CreateScmPullRequestInput): Promise<{ observation: ScmEntityObservation; reused: boolean }> {
    objectInput(input);
    requiredString(input.title, "title");
    branch(input.head, "head");
    branch(input.base, "base");
    if (input.head === input.base) throw new ScmOperationError("scm_invalid_input", "head and base must differ");
    if (input.body !== undefined && typeof input.body !== "string") throw new ScmOperationError("scm_invalid_input", "body must be a string");
    if (input.draft !== undefined && typeof input.draft !== "boolean") throw new ScmOperationError("scm_invalid_input", "draft must be a boolean");
    // One open PR per source branch. Reuse without modifying the existing PR.
    const existing = await this.findOpen(input.head);
    if (existing) return this.reuse(existing, input.base);
    try {
      const pull = await this.request<Record<string, unknown>>("/pulls", "POST", {
        head: input.head, base: input.base, title: input.title, body: input.body ?? "", draft: input.draft ?? true,
      });
      return { observation: this.observe(pull), reused: false };
    } catch (error) {
      // A concurrent create may have won. Only a validation conflict is safe to
      // reconcile here; a timeout is ambiguous and must not cause a second POST.
      if (error instanceof ScmHttpError && error.status === 422) {
        const raced = await this.findOpen(input.head);
        if (raced) return this.reuse(raced, input.base);
      }
      throw error;
    }
  }

  async update(number: number, input: UpdateScmPullRequestInput): Promise<ScmEntityObservation> {
    objectInput(input);
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) { requiredString(input.title, "title"); body.title = input.title; }
    if (input.body !== undefined) {
      if (typeof input.body !== "string") throw new ScmOperationError("scm_invalid_input", "body must be a string");
      body.body = input.body;
    }
    if (input.base !== undefined) { branch(input.base, "base"); body.base = input.base; }
    if (!Object.keys(body).length) throw new ScmOperationError("scm_invalid_input", "Provide title, body or base");
    return this.observe(await this.request<Record<string, unknown>>(`/pulls/${pullNumber(number)}`, "PATCH", body));
  }

  async checks(headSha: string): Promise<ScmCheckSummary> {
    sha(headSha);
    const runs = await this.pages(`/commits/${headSha}/check-runs?filter=latest`, "check_runs");
    const statuses = await this.pages(`/commits/${headSha}/statuses`);
    const workflows = new Map<string, string | null>();
    const checks: ScmCheckObservation[] = [];
    for (const run of runs) {
      if (run.head_sha !== headSha) throw new ScmOperationError("scm_evidence_mismatch", "Check run does not match requested head SHA");
      const app = record(run.app);
      const suite = record(run.check_suite);
      let workflowPath: string | null = null;
      if (app.slug === "github-actions" && suite.id != null) {
        const key = String(suite.id);
        if (!workflows.has(key)) {
          const associated = await this.pages(appendQuery("/actions/runs", { check_suite_id: key, head_sha: headSha }), "workflow_runs");
          const matching = associated.filter(item => String(item.check_suite_id) === key && item.head_sha === headSha);
          const paths = new Set(matching.map(item => text(item.path)).filter(Boolean));
          workflows.set(key, paths.size === 1 ? [...paths][0]! : null);
        }
        workflowPath = workflows.get(key) ?? null;
      }
      checks.push({
        id: String(run.id), kind: "check_run", name: text(run.name) ?? "", headSha,
        appId: typeof app.id === "number" ? app.id : null, appSlug: text(app.slug), workflowPath,
        status: text(run.status) ?? "unknown", conclusion: text(run.conclusion), url: text(run.html_url),
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

  /** Gate-only evidence: bind Actions jobs to the newest workflow run/attempt.
   * A's observational checks endpoint and response contract are unchanged. */
  async gateChecks(headSha: string): Promise<ScmCheckObservation[]> {
    const summary = await this.checks(headSha);
    const actions = summary.checks.filter(c => c.kind === "check_run" && c.appSlug === "github-actions" && c.workflowPath);
    if (!actions.length) return summary.checks;
    const runs = await this.pages(appendQuery("/actions/runs", { head_sha: headSha }), "workflow_runs");
    const allowed = new Set<string>();
    for (const path of new Set(actions.map(c => c.workflowPath!))) {
      const matching = runs.filter(r => r.path === path && r.head_sha === headSha);
      if (!matching.length || matching.some(r => !Number.isSafeInteger(r.id) || !Number.isSafeInteger(r.run_number) || !Number.isSafeInteger(r.run_attempt))) {
        throw new ScmOperationError("scm_evidence_incomplete", "Cannot establish latest workflow attempt");
      }
      matching.sort((a, b) => Number(b.run_number) - Number(a.run_number) || Number(b.run_attempt) - Number(a.run_attempt));
      const latest = matching[0]!;
      if (matching.some(r => r !== latest && r.run_number === latest.run_number && r.run_attempt === latest.run_attempt && r.id !== latest.id)) {
        throw new ScmOperationError("scm_evidence_incomplete", "Ambiguous latest workflow attempt");
      }
      if (latest.status !== "completed") {
        // A queued rerun can still expose check runs from the old successful attempt.
        // Omit them so the required identity is missing until current jobs exist.
        continue;
      }
      // filter=latest includes each job's latest execution in this run, including
      // successful jobs retained when only failed jobs were rerun. Never use another run.
      const jobs = await this.pages(appendQuery(`/actions/runs/${latest.id}/jobs`, { filter: "latest" }), "jobs");
      for (const job of jobs) {
        const match = typeof job.check_run_url === "string" ? /\/check-runs\/(\d+)$/u.exec(job.check_run_url) : null;
        if (job.head_sha !== headSha || !match || typeof job.name !== "string") throw new ScmOperationError("scm_evidence_incomplete", "Invalid latest-run job evidence");
        const observation = actions.find(c => c.id === match[1] && c.name === job.name && c.workflowPath === path);
        if (observation) allowed.add(observation.id);
      }
    }
    return summary.checks.filter(c => c.kind !== "check_run" || c.appSlug !== "github-actions" || allowed.has(c.id));
  }

  async requiredChecks(targetBranch: string) {
    branch(targetBranch, "target_branch");
    return readGitHubRequiredChecks(path => this.request(path), path => this.pages(path), targetBranch);
  }

  async merge(number: number, input: MergeScmPullRequestInput): Promise<ScmMergeResult> {
    sha(input.headSha);
    if (!["merge", "squash", "rebase"].includes(input.method)) throw new ScmOperationError("scm_invalid_input", "Invalid merge method");
    const result = await this.request<Record<string, unknown>>(`/pulls/${pullNumber(number)}/merge`, "PUT", {
      sha: input.headSha, merge_method: input.method,
    });
    return { merged: result.merged === true, sha: text(result.sha) };
  }

  private observe(pull: Record<string, unknown>): ScmEntityObservation {
    if (!pull.id || !Number.isSafeInteger(pull.number) || !record(pull.head).sha || !record(pull.base).sha) {
      throw new ScmOperationError("scm_invalid_response", "Provider returned an incomplete pull request");
    }
    return githubPullObservation(pull, new Date());
  }

  private async findOpen(head: string): Promise<Record<string, unknown> | null> {
    const rows = await this.pages(appendQuery("/pulls", { state: "open", head: `${this.context.binding.owner}:${head}` }));
    const repository = `${this.context.binding.owner}/${this.context.binding.name}`.toLowerCase();
    const matches = rows.filter(row => {
      const source = record(row.head);
      if (source.ref !== head) return false;
      const fullName = text(record(source.repo).full_name);
      if (!fullName) throw new ScmOperationError("scm_invalid_response", "Provider omitted the PR source repository identity");
      return fullName.toLowerCase() === repository;
    });
    if (matches.length > 1) throw new ScmOperationError("scm_ambiguous_change_request", "Multiple open PRs exist for this source branch");
    return matches[0] ?? null;
  }

  private reuse(pull: Record<string, unknown>, base: string) {
    if (record(pull.base).ref !== base) throw new ScmOperationError("scm_change_request_conflict", "Source branch already has a PR targeting another base");
    return { observation: this.observe(pull), reused: true };
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

  private async request<T>(path: string, method = "GET", body?: Record<string, unknown>): Promise<T> {
    return (await this.raw(path, method, body)).data as T;
  }

  private raw(path: string, method = "GET", body?: Record<string, unknown>) {
    const { connection, credential, binding, signal } = this.context;
    const root = `${connection.apiBaseUrl.replace(/\/$/u, "")}/repos/${encodeURIComponent(binding.owner!)}/${encodeURIComponent(binding.name)}`;
    return scmRequestJson<unknown>(`${root}${path}`, {
      method,
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "multiremi-scm", Authorization: `Bearer ${credential.accessToken!.trim()}`,
        ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }, { signal });
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | null { return typeof value === "string" && value ? value : null; }
function requiredString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new ScmOperationError("scm_invalid_input", `${name} is required`);
}
function branch(value: unknown, name: string): asserts value is string {
  requiredString(value, name);
  if (/[:\s\x00-\x1f]/u.test(value)) throw new ScmOperationError("scm_invalid_input", `${name} must be a branch in the bound repository`);
}
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
  if (checks.some(check => check.status !== "completed" || check.conclusion !== "success")) return "pending";
  return "success";
}

function appendQuery(path: string, values: Record<string, string | number>): string {
  const url = new URL(path, "https://scm.invalid");
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, String(value));
  return `${url.pathname}${url.search}`;
}

function objectInput(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ScmOperationError("scm_invalid_input", "Request body must be a JSON object");
  }
}
