import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DAEMON_CONTRACT_RELEASES } from "@multiremi/contracts/daemon-compatibility.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";

const root = resolve(import.meta.dir, "../..");
it("keeps the minimum CLI fixed to a declared contract release", () => {
  expect(DAEMON_MIN_CLI_VERSION).toBe(DAEMON_CONTRACT_RELEASES.at(-1)!.minCliVersion);
});
it("does not restore CLI/build-based feature inference in scheduling or named capability negotiation", () => {
  for (const file of ["packages/server/src/store/repos/tasks-repo.ts",
    "packages/server/src/api/daemon-protocol/handshake.ts",
    "packages/server/src/worker/daemon-protocol-client.ts"]) {
    const source = readFileSync(resolve(root, file), "utf8");
    expect(source).not.toMatch(/ISSUE_WORKSPACE_MIN_CLI_VERSION|runtimeSupportsIssueWorkspaces|metadata\.(?:cli_version|cliVersion)/);
    // Version comparisons are allowed only in the handshake's contract admission gate.
    if (file.endsWith("tasks-repo.ts")) expect(source).not.toMatch(/compare\w*Version|semver/);
  }
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
