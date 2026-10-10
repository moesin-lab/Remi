import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { backendBaselineJobs, failedBackendFiles, verifyRetryChanges } from "../../../scripts/retry-failed-backend-tests.js";

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
  it("keeps the full shard mandatory when diagnostic retry is requested", () => {
    const workflow = parse(readFileSync(new URL("../../../.github/workflows/release-build-check.yml", import.meta.url), "utf8"));
    const steps = workflow.jobs.backend.steps;
    const fullIndex = steps.findIndex((step: { name: string }) => step.name === "Backend test suite");
    const retryIndex = steps.findIndex((step: { name: string }) => step.name === "Verify baseline and retry failed backend files");
    expect(fullIndex).toBeGreaterThan(-1);
    expect(retryIndex).toBeGreaterThan(fullIndex);
    expect(steps[fullIndex].if).toBe("github.event_name != 'pull_request'");
    expect(steps[fullIndex].run).toBe("bun run test --shard=${{ matrix.shard }}/4");
    expect(JSON.stringify(steps[fullIndex])).not.toContain("retry_backend_run_id");
    expect(JSON.stringify(steps)).not.toContain("continue-on-error");
    expect(steps[retryIndex].if).toContain("!cancelled()");
  });
});
