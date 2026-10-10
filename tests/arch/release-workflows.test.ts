import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { migrationFingerprint } from "../../packages/platform-updater/src/safety.js";
import schemaInputs from "../../packages/platform-updater/src/data-schema-inputs.json";

const repoRoot = resolve(import.meta.dir, "../..");

function readWorkflow(name: string): Record<string, any> {
  return parse(readFileSync(resolve(repoRoot, ".github/workflows", name), "utf8"));
}

describe("release workflows", () => {
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
    expect(steps[gate].run).toContain("release-build-check.yml/runs?head_sha=$SHA");
    expect(steps[gate].run).toContain("branch=main&status=success");
    expect(steps[gate].run).toContain('select(.event == "push" or .event == "workflow_dispatch")');
    expect(release.jobs.release.permissions.actions).toBe("read");
    expect(JSON.stringify(release)).not.toContain("release:prepare");
    const ci = readWorkflow("release-build-check.yml");
    expect(JSON.stringify(ci.jobs.build.steps)).toContain("release:check --base-ref");
    expect(ci.jobs.build.steps[0].with["fetch-depth"]).toBe(0);
    expect(ci.jobs["session-archive-platform"].strategy.matrix.os).toEqual(["ubuntu-latest", "macos-latest"]);
    expect(JSON.stringify(ci)).toContain("runtime prepare --provider claude --provider codex");
    expect(ci.on).toHaveProperty("workflow_dispatch");
    expect(ci.jobs.backend.strategy.matrix.shard).toEqual([1, 2, 3, 4]);
    const backend = ci.jobs.backend.steps.find((step: any) => step.name === "Backend test suite");
    expect(backend.if).toBe("github.event_name != 'pull_request'");
    expect(backend.run).toBe("bun run test --shard=${{ matrix.shard }}/4");
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
    const upload = release.jobs.publish.steps.findIndex((step: any) => step.run?.includes('gh release upload'));
    expect(packaging).toBeGreaterThan(-1);
    expect(packaging).toBeLessThan(upload);
    expect(release.jobs.publish.steps[upload].run).toContain('platform-application-*.tar.gz');
    expect(builds.some((step: any) => step.with.file === 'deploy/docker/Dockerfile.updater')).toBe(true);
    expect(JSON.stringify(release)).toContain('updaterImage');
    expect(JSON.stringify(check.jobs['platform-updater'])).toContain('platform-application-smoke.ts --internal');
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

    const gate = platform.jobs.validate.steps.find((step: any) => step.run?.includes("release-build-check.yml/runs"));
    expect(gate?.run).toContain("release-build-check.yml/runs?head_sha=$SHA&branch=main&status=success");
    expect(gate?.run).toContain('select(.event == "push" or .event == "workflow_dispatch")');

    const serialized = JSON.stringify(platform);
    expect(serialized).toContain("remi-api:sha-${{ needs.validate.outputs.sha }}");
    expect(serialized).toContain("remi-web:sha-${{ needs.validate.outputs.sha }}");
    expect(serialized).toContain("steps.images.outputs.api_digest");
    expect(serialized).toContain("steps.images.outputs.web_digest");
    expect(serialized).toContain("--clobber");
  });
});
