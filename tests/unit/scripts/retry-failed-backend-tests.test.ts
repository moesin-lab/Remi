import { createPlan, type Report } from "../../../scripts/ci-backend.js";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { backendBaselineJobs, failedBackendFiles, verifyRetryChanges, verifyShardedJobs } from "../../../scripts/retry-failed-backend-tests.js";

const finished = `tests/unit/example.test.ts:
(pass) passing case
(fail) timed out fixture

1 tests failed:
(fail) timed out fixture
1 pass
0 skip
1 fail
Ran 2 tests across 1 file. [8.00s]
[test-home] residual paths: []
`;
const successful = `tests/unit/example.test.ts:
(pass) passing case
(skip) environment-specific case

1 tests skipped:
(skip) environment-specific case
1 pass
1 skip
0 fail
Ran 2 tests across 1 file. [0.10s]
[test-home] residual paths: []
`;
const shardedWorkflow = "      - name: Backend test suite\n        run: bun run test --shard=${{ matrix.shard }}/4\n";
const unshardedWorkflow = "      - name: Backend test suite\n        run: bun run test\n";
function shardedJobs() {
  return [1, 2, 3, 4].map(shard => ({ id: shard, name: `backend (${shard})`,
    conclusion: shard === 2 ? "failure" : "success",
    steps: [{ name: "Backend test suite", conclusion: shard === 2 ? "failure" : "success" }] }))
    .concat([{ id: 5, name: "build", conclusion: "success", steps: [] }]);
}

describe("verified backend retry", () => {
  it("selects files from actual failures without counting the repeated summary", () => {
    expect(failedBackendFiles(finished)).toEqual(["tests/unit/example.test.ts"]);
    expect(failedBackendFiles(finished.replace("tests/unit/example", "##[group]tests/unit/example"))).toEqual(["tests/unit/example.test.ts"]);
    expect(failedBackendFiles(finished.replace("tests/unit/example", "::group::tests/unit/example"))).toEqual(["tests/unit/example.test.ts"]);
  });
  it("rejects interrupted suites, missing cleanup and mismatched failure inventories", () => {
    expect(() => failedBackendFiles(finished.replace("Ran 2 tests", "Ran 3 tests"))).toThrow();
    expect(() => failedBackendFiles(finished.replace("1 fail", "2 fail").replace("Ran 2 tests", "Ran 3 tests"))).toThrow();
    expect(() => failedBackendFiles(finished.replace("[test-home] residual paths: []", ""))).toThrow();
    expect(() => failedBackendFiles(finished.split("1 tests failed:")[0])).toThrow();
    expect(() => failedBackendFiles(finished.replace("(pass) passing case\n", ""))).toThrow();
    expect(() => failedBackendFiles(finished.replace("across 1 file", "across 2 files"))).toThrow();
    expect(() => failedBackendFiles(finished + finished)).toThrow();
    expect(() => failedBackendFiles(finished + "[test-home] unexpected writes:\n.remi\n")).toThrow();
  });
  it("verifies successful shards and ignores the repeated skip summary", () => {
    expect(failedBackendFiles(successful, false)).toEqual([]);
    expect(() => failedBackendFiles(successful)).toThrow();
    expect(() => failedBackendFiles(successful.replace("(skip) environment-specific case\n", ""), false)).toThrow();
  });
  it("rejects unknown failure sources and unsafe paths", () => {
    expect(() => failedBackendFiles(finished.replace("tests/unit/example.test.ts:\n", ""))).toThrow();
    expect(() => failedBackendFiles(finished.replace("tests/unit/example", "tests/../example"))).toThrow();
  });
  it("allows retry infrastructure changes but rejects changed passed code or existing tests", () => {
    expect(() => verifyRetryChanges([".github/workflows/release-build-check.yml", "TESTING.md"])).not.toThrow();
    expect(() => verifyRetryChanges(["packages/server/src/worker/outbox.ts"])).toThrow();
    expect(() => verifyRetryChanges(["tests/unit/example.test.ts"])).toThrow();
    expect(() => verifyRetryChanges(["bun.lock"])).toThrow();
  });
  it("requires all four completed backend shards with other jobs successful", () => {
    const jobs = shardedJobs();
    expect(backendBaselineJobs(shardedWorkflow, jobs).map(item => [item.shard, item.job.conclusion]))
      .toEqual([[1, "success"], [2, "failure"], [3, "success"], [4, "success"]]);
    expect(() => backendBaselineJobs(shardedWorkflow, jobs.filter(job => job.name !== "backend (4)"))).toThrow();
    expect(() => backendBaselineJobs(shardedWorkflow, [...jobs, jobs[0]!])).toThrow();
    const skipped = shardedJobs();
    skipped[2]!.steps[0]!.conclusion = "skipped";
    expect(() => backendBaselineJobs(shardedWorkflow, skipped)).toThrow();
    const cancelled = shardedJobs();
    cancelled[2]!.conclusion = "cancelled";
    expect(() => backendBaselineJobs(shardedWorkflow, cancelled)).toThrow();
    const brokenBuild = shardedJobs();
    brokenBuild[4]!.conclusion = "failure";
    expect(() => backendBaselineJobs(shardedWorkflow, brokenBuild)).toThrow();
  });
  it("rejects setup failures, diagnostic baselines and partial discovery commands", () => {
    const setupFailure = shardedJobs();
    setupFailure[1]!.steps.push({ name: "Install dependencies", conclusion: "failure" });
    expect(() => backendBaselineJobs(shardedWorkflow, setupFailure)).toThrow();
    const diagnostic = shardedJobs();
    diagnostic[0]!.steps.push({ name: "Verify baseline and retry failed backend files", conclusion: "success" });
    expect(() => backendBaselineJobs(shardedWorkflow, diagnostic)).toThrow();
    diagnostic[0]!.steps[1]!.conclusion = "skipped";
    expect(() => backendBaselineJobs(shardedWorkflow, diagnostic)).not.toThrow();
    expect(() => backendBaselineJobs(shardedWorkflow.replace("--shard=", "tests/unit/example.test.ts --shard="), shardedJobs())).toThrow();
    expect(() => backendBaselineJobs(shardedWorkflow + unshardedWorkflow, shardedJobs())).toThrow();
  });
  it("keeps genuine upstream single-job full-suite baselines", () => {
    const jobs = [{ id: 1, name: "build", conclusion: "failure",
      steps: [{ name: "Backend test suite", conclusion: "failure" }] },
    { id: 2, name: "session-archive-platform", conclusion: "success", steps: [] }];
    expect(backendBaselineJobs(unshardedWorkflow, jobs).map(item => item.shard)).toEqual([1]);
    expect(() => backendBaselineJobs(unshardedWorkflow, shardedJobs())).toThrow();
  });
  it("keeps complete evidence mandatory when diagnostic retry is requested", () => {
    const workflow = parse(readFileSync(new URL("../../../.github/workflows/release-build-check.yml", import.meta.url), "utf8"));
    expect(workflow.jobs["backend-plan"].if).toBe("github.event_name != 'pull_request'");
    expect(JSON.stringify(workflow.jobs.backend)).not.toContain("retry_backend_run_id");
    expect(workflow.jobs.backend.strategy.matrix.shard).toEqual([0, 1, 2, 3]);
    expect(JSON.stringify(workflow.jobs.backend)).not.toContain("continue-on-error");
    expect(workflow.jobs.build.needs).toContain("backend");
    expect(workflow.jobs.build.needs).toContain("backend-evidence");
    expect(workflow.jobs.build.needs).toContain("backend-retry");
    expect(workflow.jobs.build.steps[0].run).toContain("mode = 'full-with-retry'");
    expect(workflow.jobs.build.steps[0].run).not.toContain("skipped.remove");
    expect(JSON.stringify(workflow.jobs["backend-retry"])).not.toContain("continue-on-error");
    expect(readFileSync(new URL("../../../scripts/retry-failed-backend-tests.ts", import.meta.url), "utf8")).not.toContain('"--timeout"');
  });
});


it("sharded retry requires completed test failures and every non-backend job green", () => {
  const sha = "a".repeat(40);
  const plan = createPlan(["tests/a.test.ts"], 1, {}, sha, "tests", [], {});
  const report: Report = { schemaVersion: 1, sha, scope: "tests", shard: 0, startedAt: "start", finishedAt: "end", shardExitCode: 1, runner: { childExitCode: 1, homeEmpty: true, observerFailed: false, interrupted: false }, summary: { pass: 1, skip: 0, fail: 1, tests: 2, files: 1 }, files: [{ path: "tests/a.test.ts", seconds: 1, failures: 1 }] };
  const jobs = ["im-platform-smoke", "execution-configuration", "platform-updater (ubuntu-latest)", "platform-updater (windows-latest)", "platform-updater (macos-latest)", "guards", "frontend-types", "frontend-tests", "cli-build", "api-build", "web-build", "session-archive-platform (ubuntu-latest)", "session-archive-platform (macos-latest)", "frontend-zero-jump", "frontend-replica", "backend-plan"].map(name => ({ name, conclusion: "success", steps: [] as { name: string; conclusion: string }[] }));
  jobs.push(...["backend-evidence", "backend-retry", "candidate-package"].map(name => ({ name, conclusion: "skipped", steps: [] })));
  jobs.push({ name: "backend (0)", conclusion: "failure", steps: [{ name: "Backend test shard", conclusion: "failure" }, { name: "Upload report", conclusion: "success" }] });
  jobs.push({ name: "build", conclusion: "failure", steps: [{ name: "Require every applicable check", conclusion: "failure" }] });
  expect(verifyShardedJobs(plan, [report], jobs)).toEqual(["tests/a.test.ts"]);
  expect(() => verifyShardedJobs(plan, [report], jobs.filter(job => job.name !== "web-build"))).toThrow();
  for (const [name, conclusion] of [["web-build", "failure"], ["backend-retry", "success"], ["backend-evidence", "success"], ["backend (0)", "cancelled"]]) {
    expect(() => verifyShardedJobs(plan, [report], jobs.map(job => job.name === name ? { ...job, conclusion } : job))).toThrow();
  }
  expect(() => verifyShardedJobs(plan, [report], jobs.map(job => job.name === "backend (0)" ? { ...job, steps: [...job.steps, { name: "Upload", conclusion: "failure" }] } : job))).toThrow();
});
