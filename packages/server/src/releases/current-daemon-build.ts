import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILD_COMMIT } from "@shared/version.js";
import { DAEMON_ARTIFACT_MANIFEST_FILE, isBuildCommit, parseDaemonArtifactManifest, type DaemonArtifactManifest } from "@shared/daemon-artifact-manifest.js";
import { createLogger } from "@shared/logger.js";
import type { MultiremiStore } from "@multiremi/store/store.js";

const log = createLogger("daemon-build");
let lastMissingReason: string | null = null;

/** Reads the API's own build, never the updater's advertised latest build. */
export function readCurrentDaemonBuild(
  commit: string | null = BUILD_COMMIT,
  directory = process.env.MULTIREMI_DAEMON_ARTIFACT_DIR || "/opt/remi/daemon-artifacts",
): DaemonArtifactManifest | null {
  let reason: string;
  try {
    if (!commit || !isBuildCommit(commit)) throw new Error("platform_build_commit_missing");
    const manifest = parseDaemonArtifactManifest(JSON.parse(readFileSync(join(directory, commit, DAEMON_ARTIFACT_MANIFEST_FILE), "utf8")));
    if (manifest.commit !== commit) throw new Error("platform_manifest_commit_mismatch");
    lastMissingReason = null;
    return manifest;
  } catch (error) {
    reason = error instanceof Error && error.message === "platform_build_commit_missing"
      ? error.message : "platform_daemon_manifest_missing_or_invalid";
  }
  if (lastMissingReason !== reason) log.info(`daemon build reconciliation skipped: ${reason}`);
  lastMissingReason = reason;
  return null;
}

/** Called after listen/readiness, including deployments with no updater. */
export function reconcileCurrentDaemonBuild(store: MultiremiStore): void {
  if (store.getActivePlatformOperation()) return;
  const manifest = readCurrentDaemonBuild();
  if (manifest) store.reconcileRuntimeCliRelease(manifest.version, manifest.commit);
  store.reconcileRuntimeUpdateFailures();
}
