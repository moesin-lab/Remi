import { existsSync } from "node:fs";
import { runTests } from "./run-tests.js";

const WORKFLOW = ".github/workflows/release-build-check.yml";
const RETRY_TEST = "tests/unit/scripts/retry-failed-backend-tests.test.ts";
const RETRY_ONLY_FILES = new Set([WORKFLOW, "scripts/retry-failed-backend-tests.ts", RETRY_TEST, "TESTING.md"]);

export function failedBackendFiles(raw: string, requireFailures = true): string[] {
  const log = raw.replace(/\x1b\[[0-9;]*m/g, "");
  const passes = [...log.matchAll(/^\s*(\d+) pass\s*$/gm)];
  const skips = [...log.matchAll(/^\s*(\d+) skip\s*$/gm)];
  const failures = [...log.matchAll(/^\s*(\d+) fail\s*$/gm)];
  const totals = [...log.matchAll(/Ran (\d+) tests across (\d+) files?\./g)];
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
    const heading = /^(?:##\[group\])?(tests\/[A-Za-z0-9_./-]+\.test\.[cm]?[jt]sx?):$/.exec(line.trim());
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

export async function verifiedBackendRetry(runId: string, shard = 1): Promise<number> {
  if (!/^\d+$/.test(runId)) throw new Error("A completed full CI run ID is required");
  if (!Number.isInteger(shard) || shard < 1 || shard > 4) throw new Error("Retry shard must be an integer from 1 through 4");
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("GITHUB_REPOSITORY is required");
  if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" || process.env.GITHUB_REF !== "refs/heads/main") {
    throw new Error("Selective retry is only allowed in a manual workflow on main");
  }
  const api = `repos/${repo}/actions/runs/${runId}`;
  const run = JSON.parse(await output("gh", ["api", api]));
  if (run.status !== "completed" || run.conclusion !== "failure" || run.head_branch !== "main"
    || !["push", "workflow_dispatch"].includes(run.event) || run.path !== WORKFLOW
    || !/^[a-f0-9]{40}$/.test(run.head_sha)) throw new Error("Baseline must be a failed, completed release check on main");
  const workflow = await output("git", ["show", `${run.head_sha}:${WORKFLOW}`]);
  await output("git", ["merge-base", "--is-ancestor", run.head_sha, "HEAD"]);
  const changed = (await output("git", ["diff", "--name-only", run.head_sha, "HEAD"])).trim().split("\n").filter(Boolean);
  verifyRetryChanges(changed);
  const { jobs, total_count } = JSON.parse(await output("gh", ["api", `${api}/jobs?per_page=100`]));
  if (jobs.length !== total_count) throw new Error("Baseline job inventory was truncated");
  const backend = backendBaselineJobs(workflow, jobs);
  const inventories = await Promise.all(backend.map(async ({ job, shard: baselineShard }) => {
    const raw = await output("gh", ["run", "view", runId, "--repo", repo, "--job", String(job.id), "--log"]);
    // Whole logs are required for successful shards too; architecture summaries
    // in a single-job baseline are outside this backend step.
    const log = raw.split(/\r?\n/).flatMap(line => {
      const parts = line.split("\t");
      return parts[1] === "Backend test suite" ? [parts.slice(2).join("\t").replace(/^\S+Z /, "")] : [];
    }).join("\n");
    const files = failedBackendFiles(log, job.conclusion === "failure");
    if (job.conclusion === "success" && files.length) throw new Error("Successful baseline shard contains failed tests");
    return { baselineShard, baselineJobId: job.id, failedFiles: files };
  }));
  const allFiles = inventories.flatMap(inventory => inventory.failedFiles);
  if (new Set(allFiles).size !== allFiles.length) throw new Error("Failed files overlap baseline shards");
  const files = inventories.find(inventory => inventory.baselineShard === shard)?.failedFiles ?? [];
  if (files.some(file => !existsSync(file))) throw new Error("A baseline failed test file is missing");
  console.log(JSON.stringify({ baselineRunId: runId, baselineSha: run.head_sha,
    sourceAndExistingTestsUnchanged: true, baselineBackendInventories: inventories,
    retryShard: shard, failedFiles: files, retryInfrastructureTest: RETRY_TEST,
    replacesCurrentFullSuite: false }));
  return runTests([...files, RETRY_TEST]);
}

if (import.meta.main) {
  process.exitCode = await verifiedBackendRetry(process.argv[2] ?? "", Number(process.argv[3] ?? "1"));
}
