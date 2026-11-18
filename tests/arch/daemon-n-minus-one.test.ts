import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DAEMON_CONTRACT_RELEASES } from "@multiremi/contracts/daemon-compatibility.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";

const root = resolve(import.meta.dir, "../..");
it("keeps the minimum CLI fixed to a declared contract release", () => {
  expect(DAEMON_MIN_CLI_VERSION).toBe(DAEMON_CONTRACT_RELEASES.at(-1)!.minCliVersion);
});
import { capabilityDecisionGlobs, findVersionDecisions, versionDecisionExceptions } from "./helpers/daemon-capability-guard.js";

it("does not infer features from CLI/build versions across capability decision directories", () => {
  const files = new Set(capabilityDecisionGlobs.flatMap(pattern =>
    [...new Bun.Glob(pattern).scanSync({ cwd: root })]));
  expect(files.size).toBeGreaterThan(50);
  const failures = [...files].sort().flatMap(file =>
    findVersionDecisions(file, readFileSync(resolve(root, file), "utf8")));
  expect(failures).toEqual([]);
});

it("rejects version inference including review counterexamples and future files", () => {
  const counterexamples = [
    ["packages/server/src/worker/daemon-protocol-client.ts", 'compareDaemonCliVersion(cliVersion, "0.2.95") >= 0'],
    ["packages/server/src/store/repos/tasks-repo.ts", 'runtime.metadata["cli_version"] >= "0.2.95"'],
    ["packages/server/src/store/repos/tasks-repo.ts", 'runtime.metadata.build >= 12345'],
    ["packages/server/src/worker/new-capability.ts", 'compareOtherVersion(current, target) >= 0'],
    ["packages/server/src/api/daemon-protocol/new-capability.ts", 'semver.gte(current, "0.2.95")'],
    ["packages/server/src/store/repos/new-runtime.ts", 'runtime.metadata.version !== "0.2.95"'],
    ["packages/server/src/store/repos/new-task.ts", "runtime.metadata['build'] > 12345"],
    ["packages/server/src/scheduler.ts", 'runtime.metadata.cli_version < "0.2.95"'],
    ["packages/server/src/worker/new-capability.ts", 'runtime.metadata["version"] === "0.2.95"'],
    ["packages/server/src/worker/future.ts", 'runtime?.metadata?.["cli_version"] >= "0.2.95"'],
    ["packages/server/src/worker/future.ts", '`${runtime.metadata.build}` >= "12345"'],
    // A valid admission expression copied into another file is not exempt.
    ["packages/server/src/worker/new-capability.ts", 'compareDaemonCliVersion(this.options.cliVersion, this.serverMinCli) < 0'],
  ];
  expect(findVersionDecisions("packages/server/src/worker/future.ts",
    'import { gte as supports } from "semver"; supports(cli, "0.2.95");')).not.toEqual([]);
  for (const [file, expression] of counterexamples) {
    expect(capabilityDecisionGlobs.some(pattern => new Bun.Glob(pattern).match(file!))).toBe(true);
    expect(findVersionDecisions(file!, `if (${expression}) enableFeature();`).length).toBeGreaterThan(0);
  }
});

it.each([
  ["destructuring rename", 'const {cli_version: v} = runtime.metadata; if (v >= "0.2.95") feature();'],
  ["local initializer", 'const v = runtime.metadata.build; if (v >= 12345) feature();'],
  ["renamed comparison import", 'import { compareDaemonCliVersion as cmp } from "@multiremi/contracts/daemon-protocol.js"; if (cmp(current, "0.2.95") >= 0) feature();'],
  ["nested destructuring with default", 'const {metadata: {cli_version: v = "0.0.0"} = {}} = runtime; if (v >= "0.2.95") feature();'],
  ["namespace comparison import", 'import * as protocol from "@multiremi/contracts/daemon-protocol.js"; if (protocol.compareDaemonCliVersion(current, "0.2.95") >= 0) feature();'],
  ["let reassignment chain", 'let v; let next; v = runtime.metadata.build; next = v; if (12345 <= next) feature();'],
])("rejects bound version inference: %s", (_name, source) => {
  expect(findVersionDecisions("packages/server/src/worker/future.ts", source).length).toBeGreaterThan(0);
});

it.each([
  'var v = runtime.metadata.cli_version; const copy = v; if (copy >= "0.2.95") feature();',
  'const {metadata: {build: b}} = runtime; if (b > 12345) feature();',
  'const {value: v = runtime.metadata.build} = input; if (v > 12345) feature();',
  'let a, b, c; a = b = c = runtime.metadata.build; if (a > 12345) feature();',
  'let v; ({metadata: {cli_version: v = "0.0.0"}} = runtime); if (v >= "0.2.95") feature();',
  'const [v = runtime.metadata.build] = input; if (v > 12345) feature();',
  'import * as sv from "semver"; if (sv.gte(current, "0.2.95")) feature();',
])("rejects binding and default propagation: %s", source => {
  expect(findVersionDecisions("packages/server/src/worker/future.ts", source).length).toBeGreaterThan(0);
});

it("keeps lexical scopes separate and permits type inspection", () => {
  const file = "packages/server/src/worker/future.ts";
  expect(findVersionDecisions(file, `
    const v = runtime.metadata.build;
    function unrelated(v: number) { return v >= 12345; }
    function sibling() { const v = 1; return v >= 2; }
    if (typeof v === "number") display(v);
  `)).toEqual([]);
  expect(findVersionDecisions(file, `
    import { compareDaemonCliVersion as cmp } from "@multiremi/contracts/daemon-protocol.js";
    function unrelated(cmp: Function) { return cmp(1, 2) >= 0; }
  `)).toEqual([]);
});

it("allows only the explicitly reviewed admission and upgrade expressions", () => {
  for (const exception of versionDecisionExceptions) {
    expect(exception.reason.length).toBeGreaterThan(10);
    expect(readFileSync(resolve(root, exception.file), "utf8")).toContain(exception.expression);
    expect(findVersionDecisions(exception.file, `if (${exception.expression}) admit();`)).toEqual([]);
  }
  expect(findVersionDecisions("packages/server/src/worker/daemon-protocol-client.ts",
    'if (compareDaemonCliVersion(cliVersion, "0.2.95") >= 0) feature();')).not.toEqual([]);
});

import { assertDaemonContractChange } from "../../scripts/check-daemon-contract.js";
it("rejects ordinary floor edits, rollbacks, and undeclared or mismatched contract releases", () => {
  const contract = { version: "0.2.90", minCliVersion: "0.2.90", reason: "trace contract" };
  expect(() => assertDaemonContractChange("0.2.90", "0.2.90", "0.2.95", contract)).not.toThrow();
  expect(() => assertDaemonContractChange("0.2.90", "0.2.95", "0.2.95", contract)).toThrow();
  expect(() => assertDaemonContractChange("0.2.90", "0.2.96", "0.2.95",
    { ...contract, version: "0.2.96", minCliVersion: "0.2.96" })).toThrow();
  expect(() => assertDaemonContractChange("0.2.90", "0.2.86", "0.2.86",
    { ...contract, version: "0.2.86", minCliVersion: "0.2.86" })).toThrow();
  expect(() => assertDaemonContractChange("0.2.90", "0.2.95", "0.2.95",
    { version: "0.2.95", minCliVersion: "0.2.95", reason: "reviewed semantic removal" })).not.toThrow();
});
