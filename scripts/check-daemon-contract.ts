import { execFileSync } from "node:child_process";
import { DAEMON_MIN_CLI_VERSION, compareDaemonCliVersion } from "../packages/contracts/src/daemon-protocol.js";
import { DAEMON_CONTRACT_RELEASES } from "../packages/contracts/src/daemon-compatibility.js";
import { version } from "../package.json";

export function assertDaemonContractChange(previous: string, floor: string, release: string,
  contract: { version: string; minCliVersion: string; reason: string }): void {
  if (floor !== contract.minCliVersion) throw new Error("min_cli_version must match the reviewed contract ledger");
  if (previous !== floor && (contract.version !== release || contract.minCliVersion !== release || !contract.reason.trim()
    || compareDaemonCliVersion(floor, previous) <= 0)) {
    throw new Error("Only a declared contract release may raise min_cli_version; ordinary releases retain the previous floor");
  }
}

if (import.meta.main) {
  const base = process.argv[2];
  if (!base) throw new Error("usage: check-daemon-contract.ts <base git ref>");
  const source = execFileSync("git", ["show", `${base}:packages/contracts/src/daemon-protocol.ts`], { encoding: "utf8" });
  const previous = source.match(/export const DAEMON_MIN_CLI_VERSION = "([^"]+)"/)?.[1];
  if (!previous) throw new Error("base has no daemon contract floor");
  const latest = DAEMON_CONTRACT_RELEASES.at(-1)!;
  assertDaemonContractChange(previous, DAEMON_MIN_CLI_VERSION, version, latest);
  console.log(JSON.stringify({ base, previous, min_cli_version: DAEMON_MIN_CLI_VERSION, contract: latest.version }));
}
