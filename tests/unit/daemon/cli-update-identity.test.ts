import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bindUpdateCandidate, journalForInstall, matchesUpdateIdentity, updateDecision, updateJournalDir, type DaemonUpdateJournal } from "@shared/daemon-update.js";
import { multiremiVersion } from "@multiremi/version.js";
import { BUILD_COMMIT } from "@shared/version.js";
import { MultiremiDaemon } from "@multiremi/daemon.js";

const roots: string[] = [];
const savedStateDir = process.env.MULTIREMI_STATE_DIR;
afterEach(() => {
  if (savedStateDir === undefined) delete process.env.MULTIREMI_STATE_DIR; else process.env.MULTIREMI_STATE_DIR = savedStateDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function journalFixture(commit?: string) {
  const root = mkdtempSync(join(tmpdir(), "update-identity-")); roots.push(root);
  const directory = updateJournalDir(root, "rt_identity", "upd_identity"); mkdirSync(directory, { recursive: true });
  const journal: DaemonUpdateJournal = { runtimeId: "rt_identity", requestId: "upd_identity", targetVersion: multiremiVersion.replace(/^v/, ""),
    targetCommit: commit, previousVersion: "0.1.0", launcherPath: join(root, "remi"), snapshotDir: root };
  writeFileSync(join(directory, "journal.json"), JSON.stringify(journal));
  return { root, directory, journal };
}
test("journal preserves verified commit; only that candidate can bind its PID", () => {
  const f = journalFixture("a".repeat(40));
  writeFileSync(join(f.root, "previous-launcher"), "#!/bin/sh\n");
  expect(journalForInstall({ status: "installed", version: f.journal.targetVersion, commit: f.journal.targetCommit,
    assetName: "remi.tar.gz", digest: "b".repeat(64), snapshotDir: f.root, launcherPath: f.journal.launcherPath,
    launchdUpdated: false }, "rt_identity", "upd_identity", "0.1.0").targetCommit).toBe(f.journal.targetCommit);
  bindUpdateCandidate(f.root, multiremiVersion, 123, "b".repeat(40));
  expect(existsSync(join(f.directory, "candidate.pid"))).toBe(false);
  bindUpdateCandidate(f.root, multiremiVersion, 123, null);
  expect(existsSync(join(f.directory, "candidate.pid"))).toBe(false);
  bindUpdateCandidate(f.root, multiremiVersion, 123, f.journal.targetCommit);
  expect(readFileSync(join(f.directory, "candidate.pid"), "utf8")).toBe("123");
  expect(matchesUpdateIdentity(f.journal, `${multiremiVersion}-other`, f.journal.targetCommit)).toBe(false);
});
for (const explicitCommit of [true, false]) test(`confirmation ${explicitCommit ? "rejects same version with another commit" : "supports legacy version-only handoffs"}`, async () => {
  const f = journalFixture(explicitCommit ? (BUILD_COMMIT === "a".repeat(40) ? "b" : "a").repeat(40) : undefined);
  process.env.MULTIREMI_STATE_DIR = f.root;
  const reports: unknown[] = [];
  // Exercise the real confirmation method without booting connectors or providers.
  const daemon = Object.create(MultiremiDaemon.prototype) as { confirmRuntimeUpdate(): Promise<void> };
  Object.assign(daemon, { options: { runtimeId: "rt_identity" }, ready: true, stopped: false,
    supervisorReady: () => true, client: { reportRuntimeUpdateResult: async (_rt: string, _id: string, report: unknown) => { reports.push(report); } } });
  await daemon.confirmRuntimeUpdate();
  if (explicitCommit) {
    expect(updateDecision(f.directory)).toBeNull(); expect(reports).toEqual([]);
    expect(existsSync(`${f.directory}.settled`)).toBe(false);
  } else {
    expect(reports).toMatchObject([{ status: "completed", self_check: true }]);
    expect(existsSync(`${f.directory}.settled`)).toBe(true);
  }
});
