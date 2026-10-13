import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyReports, validatePlan, discoverTests, verifyConfig, type Plan, type Report } from "./ci-backend.js";
import { runTests } from "./run-tests.js";

const WORKFLOW = ".github/workflows/release-build-check.yml";
const RETRY_TEST = "tests/unit/scripts/retry-failed-backend-tests.test.ts";
const RETRY_ONLY_FILES = new Set([WORKFLOW, "scripts/retry-failed-backend-tests.ts", RETRY_TEST, "TESTING.md"]);

export function failedBackendFiles(raw: string, requireFailures = true): string[] {
  const log = raw.replace(/\x1b\[[0-9;]*m/g, "");
  const passes = [...log.matchAll(/^\s*(\d+) pass\s*$/gm)];
  const skips = [...log.matchAll(/^\s*(\d+) skip\s*$/gm)];
  const failures = [...log.matchAll(/^\s*(\d+) fail\s*$/gm)];
  const totals = [...log.matchAll(/Ran (\d+) tests? across (\d+) files?\./g)];
  const [pass] = passes, [skip] = skips, [fail] = failures, [total] = totals;
  if (passes.length !== 1 || skips.length > 1 || failures.length !== 1 || totals.length !== 1
    || !pass || !fail || !total || Number(pass[1]) < 1 || (requireFailures && Number(fail[1]) < 1)
    || Number(pass[1]) + Number(skip?.[1] ?? 0) + Number(fail[1]) !== Number(total[1])) {
    throw new Error("Baseline backend suite did not finish with a complete test summary");
  }
  const files = new Set<string>(), testFiles = new Set<string>();
  let file = "", passCount = 0, skipCount = 0, failCount = 0;
  // The final skipped/failed summaries repeat names without their source file.
  for (const line of log.split(/\r?\n/)) {
    if (/^(?:\d+ tests? (?:failed|skipped):|\d+ pass)$/.test(line.trim())) break;
    const heading = /^(?:##\[group\]|::group::)?(tests\/[A-Za-z0-9_./-]+\.test\.[cm]?[jt]sx?):$/.exec(line.trim());
    if (heading) { file = heading[1]!; testFiles.add(file); }
    if (line.startsWith("(pass) ")) passCount++;
    if (line.startsWith("(skip) ")) skipCount++;
    if (line.startsWith("(fail) ")) {
      if (!file || file.includes("..")) throw new Error("Cannot associate a failed test with a safe test file");
      files.add(file); failCount++;
    }
  }
  if (passCount !== Number(pass[1]) || skipCount !== Number(skip?.[1] ?? 0)
    || failCount !== Number(fail[1]) || testFiles.size !== Number(total[2])) {
    throw new Error("Backend test inventory does not match the complete summary");
  }
  if ([...log.matchAll(/^\[test-home\] residual paths: \[\]$/gm)].length !== 1
    || log.includes("[test-home] unexpected writes:")) throw new Error("Baseline test HOME cleanup was not verified");
  return [...files].sort();
}

interface BackendJob {
  id: number;
  name: string;
  conclusion: string;
  steps: Array<{ name: string; conclusion: string }>;
}

export function backendBaselineJobs(workflow: string, jobs: BackendJob[]): Array<{ job: BackendJob; shard: number }> {
  const sharded = /run: bun run test --shard=\$\{\{ matrix\.shard \}\}\/4\s*(?:\n|$)/.test(workflow);
  const unsharded = /name: Backend test suite[\s\S]*?\n        run: bun run test\s*\n/.test(workflow);
  if (sharded === unsharded) throw new Error("Baseline workflow must have run one complete backend discovery set");

  const backend = jobs.filter(job => sharded ? /^backend \(/.test(job.name) : job.name === "build");
  const names = new Set(backend.map(job => job.name));
  if (sharded ? backend.length !== 4 || [1, 2, 3, 4].some(shard => !names.has(`backend (${shard})`)) : backend.length !== 1) {
    throw new Error("Baseline backend job inventory is incomplete");
  }
  if (jobs.some(job => job.steps.some(step => step.name === "Verify baseline and retry failed backend files"
    && step.conclusion !== "skipped"))) throw new Error("Retry diagnostics cannot be used as a full-suite baseline");
  if (jobs.some(job => !backend.includes(job) && job.conclusion !== "success")) {
    throw new Error("Baseline must have successful non-backend jobs");
  }
  for (const job of backend) {
    const suite = job.steps.filter(step => step.name === "Backend test suite");
    const failedSteps = job.steps.filter(step => step.conclusion === "failure");
    if (suite.length !== 1 || !["success", "failure"].includes(job.conclusion)
      || suite[0]!.conclusion !== job.conclusion
      || (job.conclusion === "failure" ? failedSteps.length !== 1 || failedSteps[0]!.name !== "Backend test suite" : failedSteps.length !== 0)) {
      throw new Error("Baseline must fail only completed backend suites");
    }
  }
  if (!backend.some(job => job.conclusion === "failure")) throw new Error("Baseline must include a failed backend suite");
  return backend.map(job => ({ job, shard: sharded ? Number(/^backend \(([1-4])\)$/.exec(job.name)![1]) : 1 }));
}

export function verifyRetryChanges(changed: string[]): void {
  const unsupported = changed.filter(path => !RETRY_ONLY_FILES.has(path));
  if (unsupported.length) throw new Error(`Passed backend source or tests changed: ${unsupported.join(", ")}`);
}

async function output(command: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code) throw new Error(`${command} failed (${code}): ${stderr}`);
  return stdout;
}

interface BaselineJob { name: string; conclusion: string; steps?: { name: string; conclusion: string }[] }
export function verifyShardedJobs(plan: Plan, reports: Report[], jobs: BaselineJob[]): string[] {
  verifyReports(plan, reports, "completed-test-failure");
  const required = ["im-platform-smoke", "execution-configuration", "platform-updater (ubuntu-latest)", "platform-updater (windows-latest)", "platform-updater (macos-latest)", "guards", "frontend-types", "frontend-tests", "cli-build", "api-build", "web-build", "session-archive-platform (ubuntu-latest)", "session-archive-platform (macos-latest)", "frontend-zero-jump", "frontend-replica", "backend-plan", "backend-evidence", "backend-retry", "candidate-package", "build", ...plan.shards.map(s => `backend (${s.index})`)];
  if (new Set(jobs.map(job => job.name)).size !== jobs.length || required.some(name => !jobs.some(job => job.name === name))) throw new Error("Missing or duplicate baseline jobs");
  const get = (name: string) => jobs.find(job => job.name === name)!;
  for (const job of jobs) {
    let expected = "success";
    if (["backend-evidence", "backend-retry", "candidate-package"].includes(job.name)) expected = "skipped";
    if (job.name === "build") expected = "failure";
    const shard = /^backend \((\d+)\)$/.exec(job.name);
    if (shard) {
      const report = reports.find(r => r.shard === Number(shard[1]));
      if (!report) throw new Error("Unexpected baseline shard job");
      expected = report.shardExitCode === 0 ? "success" : "failure";
      const step = job.steps?.find(step => step.name === "Backend test shard");
      if (step?.conclusion !== expected || job.steps?.some(step => step.name !== "Backend test shard" && step.conclusion !== "success"
        && !(step.conclusion === "skipped" && ["Post Run oven-sh/setup-bun@v2", "Post Run actions/checkout@v4"].includes(step.name)))) throw new Error("Backend job failed outside completed tests");
    }
    if (job.conclusion !== expected) throw new Error(`Unsafe baseline job: ${job.name} (${job.conclusion})`);
  }
  const failedSteps = get("build").steps?.filter(step => step.conclusion === "failure");
  if (failedSteps?.length !== 1 || failedSteps[0].name !== "Require every applicable check") throw new Error("Unexpected baseline summary failure");
  const files = reports.flatMap(report => report.files.filter(file => file.failures > 0).map(file => file.path)).sort();
  if (!files.length) throw new Error("Baseline does not contain test failures");
  return files;
}
async function paginated(endpoint: string, field: string): Promise<any[]> {
  const pages = JSON.parse(await output("gh", ["api", "--paginate", "--slurp", endpoint]));
  return pages.flatMap((page: any) => page[field]);
}
async function shardedFailedFiles(api: string, runId: string, repo: string, sha: string, jobs: BaselineJob[]): Promise<{ files: string[]; evidence: unknown }> {
  const artifacts = await paginated(`${api}/artifacts?per_page=100`, "artifacts");
  const directory = mkdtempSync(join(tmpdir(), "remi-retry-baseline-"));
  try {
    const download = async (name: string) => {
      const matches = artifacts.filter(artifact => artifact.name === name);
      if (matches.length !== 1 || matches[0].expired) throw new Error(`Missing or expired trusted artifact: ${name}`);
      await output("gh", ["run", "download", runId, "--repo", repo, "--name", name, "--dir", directory]);
    };
    await download("backend-plan");
    if (!lstatSync(join(directory, "plan.json")).isFile()) throw new Error("Invalid plan artifact");
    const plan: Plan = JSON.parse(readFileSync(join(directory, "plan.json"), "utf8"));
    validatePlan(plan); verifyConfig(plan);
    if (plan.sha !== sha || JSON.stringify(discoverTests(process.cwd(), plan.scope)) !== JSON.stringify(plan.files)) throw new Error("Baseline plan differs from unchanged test inventory");
    for (const shard of plan.shards) await download(`backend-shard-${shard.index}`);
    const reports: Report[] = plan.shards.map(shard => {
      const path = join(directory, `shard-${shard.index}.json`);
      if (!lstatSync(path).isFile()) throw new Error("Invalid shard artifact");
      return JSON.parse(readFileSync(path, "utf8"));
    });
    if (readdirSync(directory).length !== plan.shards.length + 1) throw new Error("Unexpected baseline artifact files");
    const files = verifyShardedJobs(plan, reports, jobs);
    return { files, evidence: { mode: "completed-sharded-test-failure", plan, reports, artifacts: artifacts.filter(a => a.name === "backend-plan" || /^backend-shard-\d+$/.test(a.name)).map(a => ({ id: a.id, name: a.name, digest: a.digest })) } };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export async function verifiedBackendRetry(runId: string): Promise<number> {
  if (!/^\d+$/.test(runId)) throw new Error("A completed full CI run ID is required");
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("GITHUB_REPOSITORY is required");
  if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" || process.env.GITHUB_REF !== "refs/heads/main") {
    throw new Error("Selective retry is only allowed in a manual workflow on main");
  }
  const api = `repos/${repo}/actions/runs/${runId}`;
  const run = JSON.parse(await output("gh", ["api", api]));
  if (run.status !== "completed" || run.conclusion !== "failure" || run.head_branch !== "main"
    || !["push", "workflow_dispatch"].includes(run.event) || run.path !== WORKFLOW
    || !/^[a-f0-9]{40}$/.test(run.head_sha) || run.repository?.full_name !== repo || run.head_repository?.full_name !== repo) throw new Error("Baseline must be a failed, completed release check on main");
  const workflow = await output("git", ["show", `${run.head_sha}:${WORKFLOW}`]);
  const sharded = workflow.includes("scripts/ci-backend.ts run --plan") && workflow.includes("scripts/ci-backend.ts verify --plan");
  // A retry cannot be used as another retry's full-suite baseline.
  await output("git", ["merge-base", "--is-ancestor", run.head_sha, "HEAD"]);
  const changed = (await output("git", ["diff", "--name-only", run.head_sha, "HEAD"])).trim().split("\n").filter(Boolean);
  verifyRetryChanges(changed);
  const jobs = await paginated(`${api}/jobs?filter=latest&per_page=100`, "jobs");
  let files: string[], evidence: unknown;
  if (sharded) {
    const verified = await shardedFailedFiles(api, runId, repo, run.head_sha, jobs);
    files = verified.files; evidence = verified.evidence;
  } else {
    const backend = backendBaselineJobs(workflow, jobs);
    const inventories = await Promise.all(backend.map(async ({ job, shard }) => {
      const raw = await output("gh", ["run", "view", runId, "--repo", repo, "--job", String(job.id), "--log"]);
      // Keep the complete backend step, including successful native shards.
      const log = raw.split(/\r?\n/).flatMap(line => {
        const parts = line.split("\t");
        return parts[1] === "Backend test suite" ? [parts.slice(2).join("\t").replace(/^\S+Z /, "")] : [];
      }).join("\n");
      const failedFiles = failedBackendFiles(log, job.conclusion === "failure");
      if (job.conclusion === "success" && failedFiles.length) throw new Error("Successful baseline shard contains failed tests");
      return { shard, baselineJobId: job.id, failedFiles };
    }));
    files = inventories.flatMap(inventory => inventory.failedFiles);
    if (new Set(files).size !== files.length) throw new Error("Failed files overlap baseline shards");
    evidence = { mode: "completed-legacy-test-failure", inventories };
  }
  if (files.some(file => !existsSync(file))) throw new Error("A baseline failed test file is missing");
  const receipt = { schemaVersion: 1, mode: "verified-retry", repository: repo, baselineRunId: runId, baselineSha: run.head_sha, targetSha: process.env.GITHUB_SHA, replacesCurrentFullSuite: false,
    sourceAndExistingTestsUnchanged: true, evidence, failedFiles: files, retryInfrastructureTest: RETRY_TEST };
  mkdirSync("ci-backend", { recursive: true });
  writeFileSync("ci-backend/retry-evidence.json", JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify({ mode: receipt.mode, baselineRunId: runId, baselineSha: run.head_sha, failedFiles: files, evidencePath: "ci-backend/retry-evidence.json" }));
  // Keep each test's existing timeout; diagnostics never replace the full run.
  return runTests([...files, RETRY_TEST]);
}

if (import.meta.main) {
  process.exitCode = await verifiedBackendRetry(process.argv[2] ?? "");
}
