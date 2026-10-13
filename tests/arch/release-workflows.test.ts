import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { parse } from "yaml";
import { migrationFingerprint } from "../../packages/platform-updater/src/safety.js";
import schemaInputs from "../../packages/platform-updater/src/data-schema-inputs.json";
import { DAEMON_MIN_CLI_VERSION } from "../../packages/contracts/src/daemon-protocol.js";

const repoRoot = resolve(import.meta.dir, "../..");

function readWorkflow(name: string): Record<string, any> {
  return parse(readFileSync(resolve(repoRoot, ".github/workflows", name), "utf8"));
}

function protocolMinimums(value: unknown): unknown[] {
  if (typeof value === "string") {
    const body = value.trim();
    if (!body.startsWith("{") && !body.startsWith("[")) return [];
    try { return protocolMinimums(JSON.parse(body)); } catch { return []; }
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => key === "min_version" ? [child] : protocolMinimums(child));
}

describe("release workflows", () => {
  for (const path of ["scripts/api-routes.golden.json", "tests/fixtures/multiremi/first-screen-hotspots-pr2-golden.json"]) {
    test(`${path} publishes the current daemon minimum version`, () => {
      const minimums = protocolMinimums(JSON.parse(readFileSync(resolve(repoRoot, path), "utf8")));
      expect(minimums.length).toBeGreaterThan(0);
      expect(new Set(minimums)).toEqual(new Set([DAEMON_MIN_CLI_VERSION]));
    });
  }

  test("application publication policy matches the migration source included in bundles", () => {
    const policy = JSON.parse(readFileSync(resolve(repoRoot, "deploy/platform-application-compatibility.json"), "utf8"));
    const source = schemaInputs.map(path => readFileSync(resolve(repoRoot, path), "utf8")).join("");
    expect(policy.dataSchema).toBe(migrationFingerprint(source));
    expect(Array.isArray(policy.rollbackSafeFrom)).toBe(true);
    for (const fingerprint of policy.rollbackSafeFrom) expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  test("release publication uses a prepared snapshot and exact-commit full CI before building", () => {
    const release = readWorkflow("release.yml");
    const steps = release.jobs.release.steps;
    const gate = steps.findIndex((step: any) => step.run?.includes("release:check --tag"));
    const build = steps.findIndex((step: any) => step.run?.includes("bun run build:multiremi"));
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(build);
    const candidate = steps.findIndex((step: any) => step.run?.includes("scripts/release-candidate.ts resolve"));
    expect(candidate).toBeGreaterThan(gate);
    expect(candidate).toBeLessThan(build);
    expect(steps[candidate].run).toContain("--kind cli");
    expect(steps[build].if).toBe("steps.candidate.outputs.reused != 'true'");
    const resolver = readFileSync(resolve(repoRoot, "scripts/release-candidate.ts"), "utf8");
    expect(resolver).toContain("runs?head_sha=${sha}&branch=main&status=success");
    expect(resolver).toContain('["push", "workflow_dispatch"].includes(run.event)');
    expect(resolver).toContain('job.name === "backend-evidence"');
    expect(resolver).toContain('job.name === "backend-retry"');
    expect(resolver).toContain("if (candidate) return false");
    expect(release.jobs.release.permissions.actions).toBe("read");
    expect(JSON.stringify(release)).not.toContain("release:prepare");
    const ci = readWorkflow("release-build-check.yml");
    expect(JSON.stringify(ci.jobs.guards.steps)).toContain("release:check --base-ref");
    expect(ci.jobs.guards.steps[0].with["fetch-depth"]).toBe(0);
    expect(ci.jobs["session-archive-platform"].strategy.matrix.os).toEqual(["ubuntu-latest", "macos-latest"]);
    expect(JSON.stringify(ci)).toContain("runtime prepare --provider claude --provider codex");
    expect(ci.on).toHaveProperty("workflow_dispatch");
    expect(ci.jobs.backend.strategy.matrix.shard).toEqual([0, 1, 2, 3]);
    const backend = ci.jobs.backend.steps.find((step: any) => step.name === "Backend test shard");
    expect(ci.jobs["backend-plan"].if).toBe("github.event_name != 'pull_request'");
    expect(backend.run).toContain("scripts/ci-backend.ts run --plan");
    expect(ci.jobs.build.steps.some((step: any) => step.name === "Backend test suite")).toBe(false);
  });


  test("validates the updater on all host platforms and publishes both container architectures", () => {
    const check = readWorkflow("release-build-check.yml");
    expect(check.jobs["platform-updater"].strategy.matrix.os).toEqual(["ubuntu-latest", "windows-latest", "macos-latest"]);
    const release = readWorkflow("platform-release.yml");
    const builds = release.jobs.publish.steps.filter((step: any) => step.uses === "docker/build-push-action@v6");
    expect(builds).toHaveLength(3);
    for (const build of builds) expect(build.with.platforms).toBe("linux/amd64,linux/arm64");
    expect(JSON.stringify(release)).toContain("dataSchema");
    const packaging = release.jobs.publish.steps.findIndex((step: any) => step.run?.includes('package-platform-application.mjs'));
    // Packaging pulls the same immutable index for both architectures. The
    // classic Docker store cannot retain both under that digest.
    const storage = release.jobs.publish.steps.findIndex((step: any) => step.uses?.startsWith('docker/setup-docker-action@'));
    const qemu = release.jobs.publish.steps.findIndex((step: any) => step.uses === 'docker/setup-qemu-action@v3');
    expect(storage).toBeGreaterThan(-1);
    expect(storage).toBeLessThan(qemu);
    expect(storage).toBeLessThan(packaging);
    expect(release.jobs.publish.steps[storage].with.version).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(JSON.parse(release.jobs.publish.steps[storage].with['daemon-config']).features['containerd-snapshotter']).toBe(true);
    const upload = release.jobs.publish.steps.findIndex((step: any) => step.run?.includes('gh release upload'));
    expect(packaging).toBeGreaterThan(-1);
    expect(packaging).toBeLessThan(upload);
    expect(release.jobs.publish.steps[upload].run).toContain('platform-application-*.tar.gz');
    expect(builds.some((step: any) => step.with.file === 'deploy/docker/Dockerfile.updater')).toBe(true);
    expect(JSON.stringify(release)).toContain('updaterImage');
    expect(JSON.stringify(check.jobs['platform-updater'])).toContain('platform-application-smoke.ts --internal');
  });
  test("parallel backend remains an exact-coverage gate with independent services", () => {
    const ci = readWorkflow("release-build-check.yml");
    expect(ci.jobs.backend.strategy.matrix.shard).toEqual([0, 1, 2, 3]);
    expect(ci.jobs.backend.strategy["fail-fast"]).toBe(false);
    expect(ci.jobs.backend.services.postgres.image).toBe("pgvector/pgvector:pg17");
    const shard = ci.jobs.backend.steps.find((step: any) => step.name === "Backend test shard");
    expect(shard.env.MULTIREMI_TEST_POSTGRES_URL).toBe("postgres://multimira:multimira@localhost:5432/postgres");
    expect(shard.env.MULTIREMI_TEST_LOCK_ORDER_SENTINEL).toBe("1");
    expect(ci.jobs.build.if).toBe("always()");
    expect(ci.jobs.build.needs).toContain("backend-evidence");
    expect(ci.jobs.build.needs).toContain("backend-retry");
    const summary = ci.jobs.build.steps[0].run;
    expect(summary).toContain("result == expected");
    expect(summary).toContain("full-with-retry");
    for (const job of ["im-platform-smoke", "execution-configuration", "platform-updater"]) expect(ci.jobs.build.needs).toContain(job);
    expect(JSON.stringify(ci.jobs.guards)).toContain("shared-workspace-operator.test.ts");
    expect(JSON.stringify(ci.jobs.guards)).toContain("runtime-capabilities.test.ts");
    expect(JSON.stringify(ci.jobs["backend-evidence"])).toContain("scripts/ci-backend.ts verify");
    expect(JSON.stringify(ci.jobs["backend-retry"])).toContain("scripts/retry-failed-backend-tests.ts");
  });

  test("the real summary rejects any failed full gate even when diagnostics pass", () => {
    const ci = readWorkflow("release-build-check.yml");
    const summary = ci.jobs.build.steps[0].run;
    const run = (event: string, retry: string, failures: Record<string, string> = {}) => {
      const skipped = event === "pull_request" ? ["backend-plan", "backend", "backend-evidence", "backend-retry"] : retry ? [] : ["backend-retry"];
      const results = Object.fromEntries(ci.jobs.build.needs.map((job: string) => [job, { result: failures[job] ?? (skipped.includes(job) ? "skipped" : "success") }]));
      return spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", summary], {
        encoding: "utf8", env: { ...process.env, RESULTS: JSON.stringify(results), EVENT: event, RETRY: retry, REF: "refs/heads/main", GITHUB_SHA: "a".repeat(40) },
      });
    };
    for (const [event, retry] of [["pull_request", ""], ["push", ""], ["workflow_dispatch", ""], ["workflow_dispatch", "123"]]) {
      expect(run(event!, retry!).status).toBe(0);
    }
    for (const job of ["backend", "backend-evidence", "im-platform-smoke", "execution-configuration", "platform-updater"]) {
      for (const result of ["failure", "cancelled", "skipped"]) expect(run("workflow_dispatch", "123", { [job]: result }).status).not.toBe(0);
    }
  });

  test("candidate producer shares one checked main flag and retains full validation and immutable OCI inputs", () => {
    const ci = readWorkflow("release-build-check.yml");
    expect(ci.on.workflow_dispatch.inputs.release_candidate.default).toBe(false);
    expect(ci.jobs.guards.outputs.candidate).toBe("${{ steps.candidate.outputs.enabled }}");
    expect(ci.jobs["candidate-package"].needs).toEqual(["build", "guards"]);
    expect(ci.jobs["candidate-package"].if).toBe("needs.guards.outputs.candidate == 'true'");
    const create = ci.jobs["candidate-package"].steps.find((step: any) => step.run?.includes("scripts/release-candidate.ts create"));
    expect(create.env.RELEASE_BASE_SHA).toBe("${{ github.event.before }}");
    expect(create.env.RELEASE_CANDIDATE_REQUEST).toBe("${{ inputs.release_candidate }}");
    expect(create.env.RETRY_BACKEND_RUN_ID).toBe("${{ inputs.retry_backend_run_id }}");
    expect(ci.jobs["candidate-package"].steps[0].with["fetch-depth"]).toBe(0);
    expect(JSON.stringify(ci.jobs["candidate-package"])).toContain("scripts/release-candidate.ts create");
    const finalUpload = ci.jobs["candidate-package"].steps.find((step: any) => step.uses === "actions/upload-artifact@v4");
    expect(finalUpload.with.path).toBe("candidate/release-candidate.json");
    expect(finalUpload.with["retention-days"]).toBe(30);
    for (const kind of ["cli", "api", "web"]) {
      expect(ci.jobs[`${kind}-build`].needs).toBe("guards");
      const version = ci.jobs[`${kind}-build`].steps.find((step: any) => step.env?.CANDIDATE);
      expect(version.env.CANDIDATE).toBe("${{ needs.guards.outputs.candidate }}");
      const upload = ci.jobs[`${kind}-build`].steps.find((step: any) => step.uses === "actions/upload-artifact@v4");
      expect(upload.if).toBe(ci.jobs["candidate-package"].if);
      expect(upload.with["retention-days"]).toBe(30);
      expect(upload.with["compression-level"]).toBe(0);
    }
    for (const kind of ["api", "web"]) {
      const image = ci.jobs[`${kind}-build`].steps.find((step: any) => step.uses === "docker/build-push-action@v6");
      expect(image.with.platforms).toBe("linux/amd64");
      expect(image.with.provenance).toBe(false);
      expect(image.with.outputs).toContain("oci-mediatypes=true");
      expect(image.with.outputs).toContain("needs.guards.outputs.candidate == 'true'");
      expect(image.with.labels).toContain("org.opencontainers.image.revision=${{ github.sha }}");
    }
    const platform = readWorkflow("platform-release.yml");
    expect(JSON.stringify(platform)).not.toContain("Publish verified candidate images without rebuilding");
    expect(JSON.stringify(platform)).not.toContain("scripts/release-candidate.ts resolve");
  });

  test("real candidate selection enables new-version main pushes and manual requests without PR or retry promotion", () => {
    const ci = readWorkflow("release-build-check.yml");
    const select = ci.jobs.guards.steps.find((step: any) => step.id === "candidate");
    const reject = ci.jobs.guards.steps.find((step: any) => step.name === "Reject invalid candidate requests");
    expect(reject.if).toBe("inputs.release_candidate");
    expect(select.env.VERSION_CHANGED).toBe("${{ steps.release.outputs.version_changed }}");
    const directory = mkdtempSync(join(tmpdir(), "release-candidate-selection-"));
    const output = join(directory, "output");
    try {
      for (const [event, ref, changed, requested, retry, enabled, rejected] of [
        ["push", "refs/heads/main", "true", "", "", true, false],
        ["push", "refs/heads/main", "false", "", "", false, false],
        ["push", "refs/heads/main", "", "", "", false, false],
        ["push", "refs/heads/feature", "true", "", "", false, false],
        ["pull_request", "refs/pull/1/merge", "true", "", "", false, false],
        ["workflow_dispatch", "refs/heads/main", "false", "true", "", true, false],
        ["workflow_dispatch", "refs/heads/main", "true", "false", "", false, false],
        ["workflow_dispatch", "refs/heads/main", "true", "", "123", false, false],
        ["workflow_dispatch", "refs/heads/main", "true", "true", "123", false, true],
        ["workflow_dispatch", "refs/heads/feature", "true", "true", "", false, true],
      ] as const) {
        writeFileSync(output, "");
        const env = { ...process.env, EVENT: event, REF: ref, VERSION_CHANGED: changed, REQUESTED: requested, RETRY: retry, GITHUB_OUTPUT: output };
        const run = (script: string) => spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], { cwd: directory, env, encoding: "utf8" });
        if (requested === "true") {
          const result = run(reject.run);
          expect(result.error).toBeUndefined();
          expect(result.status === 0).toBe(!rejected);
          if (rejected) {
            expect(readFileSync(output, "utf8")).toBe("");
            continue;
          }
        }
        const result = run(select.run);
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(readFileSync(output, "utf8")).toBe(`enabled=${enabled}\n`);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("PR guards exercise only the bounded CI orchestration regressions in GitHub log mode", () => {
    const ci = readWorkflow("release-build-check.yml");
    const step = ci.jobs.guards.steps.find((step: any) => step.name === "CI orchestration regression tests");
    expect(step.if).toBeUndefined();
    expect(step.env).toEqual({ CI: "true", GITHUB_ACTIONS: "true" });
    expect(step.run.trim().split(/\s+/)).toEqual(["bun", "run", "test", ...[
      "ci-backend", "run-tests", "run-tests-signals", "retry-failed-backend-tests", "release-candidate",
    ].map(name => `tests/unit/scripts/${name}.test.ts`)]);
    expect(ci.jobs["backend-plan"].if).toContain("github.event_name != 'pull_request'");
  });

  test("publishes the platform automatically after the tag release", () => {
    const release = readWorkflow("release.yml");
    expect(release.on.push.tags).toContain("v*");
    expect(release.jobs.platform.needs).toBe("release");
    expect(release.jobs.platform.uses).toBe("./.github/workflows/platform-release.yml");
    expect(release.jobs.platform.with.tag).toBe("${{ github.ref_name }}");
    expect(release.jobs.platform.permissions.packages).toBe("write");
    expect(release.jobs.platform.permissions.attestations).toBe("write");
  });

  test("keeps platform publication manually recoverable and source-bound", () => {
    const platform = readWorkflow("platform-release.yml");
    expect(platform.on.workflow_call.inputs.tag.type).toBe("string");
    expect(platform.on.workflow_dispatch.inputs.tag.type).toBe("string");
    expect(platform.jobs.publish.steps[0].with.ref).toBe("${{ needs.validate.outputs.sha }}");

    const gate = platform.jobs.validate.steps.find((step: any) => step.id === "meta");
    expect(gate.run).toContain("runs?head_sha=$SHA&branch=main&status=success");
    expect(gate.run).toContain('.event == "push" or .event == "workflow_dispatch"');
    expect(gate.env.GH_TOKEN).toBe("${{ github.token }}");
    expect(JSON.stringify(platform.jobs.publish.steps)).toContain("release:check --tag");

    const serialized = JSON.stringify(platform);
    expect(serialized).toContain("remi-api:sha-${{ needs.validate.outputs.sha }}");
    expect(serialized).toContain("remi-web:sha-${{ needs.validate.outputs.sha }}");
    expect(serialized).toContain("steps.images.outputs.api_digest");
    expect(serialized).toContain("steps.images.outputs.web_digest");
    expect(serialized).toContain("--clobber");
  });

  test("published image verification writes digests only after every image pair is valid", () => {
    const platform = readWorkflow("platform-release.yml");
    const step = platform.jobs.publish.steps.find((step: any) => step.name === "Verify published image identity");
    const directory = mkdtempSync(join(tmpdir(), "release-image-verification-"));
    const output = join(directory, "outputs");
    const apiDigest = `sha256:${"a".repeat(64)}`, webDigest = `sha256:${"b".repeat(64)}`, updaterDigest = `sha256:${"c".repeat(64)}`;
    try {
      writeFileSync(join(directory, "docker"), `#!/bin/sh
case "$4" in
  */remi-api:*) kind=api; digest="$API_DIGEST" ;;
  */remi-web:*) kind=web; digest="$WEB_DIGEST" ;;
  */remi-updater:*) kind=updater; digest="$UPDATER_DIGEST" ;;
  *) exit 90 ;;
esac
case "$4" in *:sha-*) ref=source ;; *) ref=version ;; esac
if [ "$kind/$ref" = "$FAIL_TARGET" ] || [ "$kind/both" = "$FAIL_TARGET" ]; then
  case "$SCENARIO" in
    mismatch) digest="sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" ;;
    inspect-failure) printf '{"digest":"%s"}\\n' "$digest"; exit 17 ;;
    malformed) printf 'invalid JSON\\n'; exit 0 ;;
    missing) printf '{}\\n'; exit 0 ;;
    empty) digest= ;;
    invalid) digest="sha256:invalid" ;;
  esac
fi
printf '{"digest":"%s"}\\n' "$digest"
`, { mode: 0o755 });
      const cases = [{ scenario: "success", target: "" }, ...["mismatch", "inspect-failure", "malformed", "missing", "empty", "invalid"].flatMap(scenario => {
        // Identical invalid values must fail even though the tag pair agrees.
        const targets = ["empty", "invalid"].includes(scenario) ? ["api/both", "web/both", "updater/both"] : ["api/version", "api/source", "web/version", "web/source", "updater/version", "updater/source"];
        return targets.map(target => ({ scenario, target }));
      })];
      for (const { scenario, target } of cases) {
        writeFileSync(output, "");
        const result = spawnSync("bash", ["--noprofile", "--norc", "-c", step.run], {
          cwd: directory,
          encoding: "utf8",
          env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`, REGISTRY: "ghcr.io", GITHUB_REPOSITORY_OWNER: "Example",
            TAG: "v1.2.3", SHA: "d".repeat(40), GITHUB_OUTPUT: output, API_DIGEST: apiDigest, WEB_DIGEST: webDigest, UPDATER_DIGEST: updaterDigest, SCENARIO: scenario, FAIL_TARGET: target },
        });
        expect(result.error).toBeUndefined();
        const outputs = readFileSync(output, "utf8");
        if (scenario === "success") {
          expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
          expect(outputs).toBe(`api_digest=${apiDigest}\nweb_digest=${webDigest}\nupdater_digest=${updaterDigest}\n`);
        } else {
          expect({ scenario, target, failed: result.status !== 0, outputs }).toEqual({ scenario, target, failed: true, outputs: "" });
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
