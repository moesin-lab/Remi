/**
 * `remi update` — install a verified Remi CLI release without restarting the daemon.
 *
 * Platform manifests or GitHub releases supply the archive URL and SHA-256 digest.
 * The archive is completely validated in a staging
 * directory before the stable launcher or launchd file is changed.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { assertUpdateServiceLauncher, type UpdateServiceRestart } from "./cli-update-service.js";
import { resolveUpdateArtifact } from "./cli-update-source.js";
import { VERSION } from "@shared/version.js";

const DEFAULT_RELEASE_REPOSITORY = "moesin-lab/Remi";
const RELEASE_ARCHIVE_ENTRIES = new Set(["remi", "remi-claude-agent-acp", "runtime-bundle.json"]);

export interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
  digest?: string | null;
  size?: number;
}

export interface GithubRelease {
  tag_name: string;
  assets: GithubReleaseAsset[];
}

export interface UpdatePlatform {
  os: "darwin" | "linux";
  arch: "arm64" | "x64";
}

export interface UpdateOptions {
  currentVersion?: string;
  serviceRestart?: UpdateServiceRestart;
  targetVersion?: string;
  targetCommit?: string;
  currentCommit?: string | null;
  serverUrl?: string;
  token?: string | null;
  rollbackExecutable?: string;
  beforeActivate?: (result: Extract<UpdateResult, { status: "installed" }>) => void | Promise<void>;
  platform?: UpdatePlatform;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  launcherPath?: string;
  launchdPath?: string;
  installRoot?: string;
  onProgress?: (message: string) => void | Promise<void>;
}

export type UpdateResult =
  | { status: "current"; version: string; source?: "platform" | "github"; commit?: string }
  | {
    status: "installed";
    version: string;
    source?: "platform" | "github";
    commit?: string;
    assetName: string;
    digest: string;
    snapshotDir: string;
    launcherPath: string;
    launchdUpdated: boolean;
  };

export function releaseRepository(env: NodeJS.ProcessEnv = process.env): string {
  return env.MULTIREMI_RELEASE_REPO?.trim()
    || env.MULTIREMI_REPO?.trim()
    || DEFAULT_RELEASE_REPOSITORY;
}

export function detectUpdatePlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): UpdatePlatform {
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`Unsupported update platform: ${platform}`);
  }
  if (arch !== "arm64" && arch !== "x64") {
    throw new Error(`Unsupported update architecture: ${arch}`);
  }
  return { os: platform, arch };
}

export function releaseAssetName(version: string, platform: UpdatePlatform): string {
  return `remi-${version.replace(/^v/, "")}-${platform.os}-${platform.arch}.tar.gz`;
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  }
  // Preserve build suffixes as identity: different builds must never compare equal.
  const left = a.replace(/^v/, "");
  const right = b.replace(/^v/, "");
  if (left === right) return 0;
  const preA = left.split("+")[0]!.split("-").slice(1).join("-");
  const preB = right.split("+")[0]!.split("-").slice(1).join("-");
  if (!!preA !== !!preB) return preA ? -1 : 1;
  return left.localeCompare(right, "en", { numeric: true }) || (left < right ? -1 : 1);
}

export async function fetchLatestRelease(
  repository: string,
  fetchImpl: typeof fetch = fetch,
  targetVersion?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GithubRelease> {
  let response: Response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${repository}/releases/${targetVersion ? `tags/v${targetVersion.replace(/^v/, "")}` : "latest"}`, {
      headers: {
        ...(env.GITHUB_TOKEN?.trim() ? { Authorization: `Bearer ${env.GITHUB_TOKEN.trim()}` } : {}),
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
  } catch { throw new Error("GitHub release lookup failed: source unreachable"); }
  if (!response.ok) {
    throw new Error(`GitHub release lookup failed for ${repository}: ${response.status}`);
  }
  let release: Partial<GithubRelease>;
  try { release = await response.json() as Partial<GithubRelease>; }
  catch { throw new Error("Invalid GitHub release metadata"); }
  if (!release.tag_name || !Array.isArray(release.assets)) {
    throw new Error(`GitHub release metadata for ${repository} is incomplete`);
  }
  return release as GithubRelease;
}

export async function performUpdate(options: UpdateOptions = {}): Promise<UpdateResult> {
  const env = options.env ?? process.env;
  const secrets = [options.token, env.GITHUB_TOKEN].filter((value): value is string => !!value?.trim()).map(value => value.trim());
  const redact = (message: string) => secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), message);
  try {
    return await installVerifiedUpdate({ ...options,
      onProgress: options.onProgress ? message => options.onProgress!(redact(message)) : undefined });
  } catch (error) {
    throw new Error(redact(error instanceof Error ? error.message : "CLI update failed"));
  }
}

async function installVerifiedUpdate(options: UpdateOptions): Promise<UpdateResult> {
  const env = options.env ?? process.env;
  const currentVersion = options.currentVersion ?? VERSION;
  const platform = options.platform ?? detectUpdatePlatform();
  const fetchImpl = options.fetchImpl ?? fetch;
  const homeDir = options.homeDir ?? homedir();
  const installRoot = options.installRoot
    ?? env.MULTIREMI_INSTALL_ROOT?.trim()
    ?? join(homeDir, ".local", "lib", "remi");
  const launcherPath = options.launcherPath
    ?? (env.MULTIREMI_BIN_DIR?.trim() ? join(env.MULTIREMI_BIN_DIR.trim(), "remi") : findLauncherOnPath(env.PATH))
    ?? "/usr/local/bin/remi";
  const launchdPath = options.launchdPath
    ?? env.MULTIREMI_LAUNCHD_PLIST?.trim()
    ?? join(homeDir, "Library", "LaunchAgents", "dev.remi.multiremi.daemon.plist");
  assertUpdateServiceLauncher({ restart: options.serviceRestart, launcherPath });
  const artifact = await resolveUpdateArtifact(options, platform);
  const latestVersion = artifact.version;
  parseVersion(latestVersion);
  if (options.targetVersion && latestVersion !== options.targetVersion.replace(/^v/, "")) throw new Error("Release does not match target_version");
  await options.onProgress?.(`Using ${artifact.source} update source`);
  if (!options.targetVersion && !options.targetCommit && (artifact.commit
    ? latestVersion === currentVersion && artifact.commit === options.currentCommit
    : compareVersions(latestVersion, currentVersion) <= 0)) {
    return { status: "current", version: currentVersion, source: artifact.source, commit: artifact.commit };
  }
  const assetName = artifact.assetName;
  const expectedDigest = parseSha256Digest(artifact.sha256, assetName);
  const progress = options.onProgress ?? (() => {});
  const tempRoot = mkdtempSync(join(tmpdir(), "remi-update-"));

  try {
    await progress(`Downloading ${assetName}`);
    const fallback = async (): Promise<UpdateResult> => {
      const sources = (env.MULTIREMI_UPDATE_SOURCES ?? "platform,github").split(",").map(s => s.trim());
      const remaining = sources.slice(sources.indexOf("platform") + 1);
      if (artifact.source !== "platform" || options.targetCommit || !remaining.includes("github")) {
        throw new Error("Release download failed: platform artifact unavailable");
      }
      await progress("Platform artifact unavailable; trying GitHub fallback");
      return performUpdate({ ...options, env: { ...env, MULTIREMI_UPDATE_SOURCES: remaining.join(",") } });
    };
    let response: Response;
    try {
      response = await fetchImpl(artifact.url, {
        headers: artifact.headers,
        redirect: artifact.source === "platform" ? "error" : "follow",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      if (artifact.source === "platform") return await fallback();
      throw new Error("Release download failed: source unreachable");
    }
    if (artifact.source === "platform" && response.status === 404) return await fallback();
    if (!response.ok) throw new Error(`Release download failed: ${response.status}`);
    const archiveBytes = Buffer.from(await response.arrayBuffer());
    if (typeof artifact.size === "number" && artifact.size >= 0 && archiveBytes.byteLength !== artifact.size) {
      throw new Error(`Downloaded size mismatch for ${assetName}: expected ${artifact.size}, got ${archiveBytes.byteLength}`);
    }
    const actualDigest = createHash("sha256").update(archiveBytes).digest("hex");
    if (actualDigest !== expectedDigest) {
      throw new Error(`SHA-256 mismatch for ${assetName}: expected ${expectedDigest}, got ${actualDigest}; existing executable was not replaced`);
    }

    const archivePath = join(tempRoot, assetName);
    const extractDir = join(tempRoot, "release");
    writeFileSync(archivePath, archiveBytes, { mode: 0o600 });
    mkdirSync(extractDir);
    validateArchiveEntries(archivePath);
    execFileSync("tar", ["-xzf", archivePath, "-C", extractDir], { stdio: "pipe" });

    const stagedBinary = join(extractDir, "remi");
    if (!existsSync(stagedBinary)) throw new Error(`${assetName} does not contain remi`);
    chmodSync(stagedBinary, 0o755);
    const reportedVersion = execFileSync(stagedBinary, ["--version"], { encoding: "utf8", stdio: "pipe", timeout: 30_000 }).trim().replace(/^v/, "");
    if (reportedVersion !== latestVersion) {
      throw new Error(`Downloaded remi reports ${reportedVersion || "no version"}; expected ${latestVersion}`);
    }
    if (artifact.commit) {
      let identity: { commit?: string; version?: string };
      try { identity = JSON.parse(execFileSync(stagedBinary, ["--build-info"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 })); }
      catch { throw new Error("Downloaded remi cannot report build identity"); }
      if (identity.commit !== artifact.commit || identity.version !== latestVersion) throw new Error("Downloaded remi build identity does not match manifest commit/version");
    }
    const stagedWrapper = join(extractDir, "remi-claude-agent-acp");
    if (existsSync(stagedWrapper)) chmodSync(stagedWrapper, 0o755);

    if (existsSync(join(extractDir, "runtime-bundle.json"))) {
      await progress("Preparing and verifying bundled runtimes");
      try {
        execFileSync(stagedBinary, ["runtime", "prepare"], { stdio: "pipe", env: { ...env } });
      } catch {
        throw new Error("Runtime preparation failed; existing executable was not replaced");
      }
    }

    const versionsDir = join(installRoot, "versions");
    const snapshotId = expectedDigest.slice(0, 8);
    const snapshotDir = join(versionsDir, snapshotId);
    const snapshotStaging = join(versionsDir, `.${snapshotId}.${process.pid}.tmp`);
    mkdirSync(versionsDir, { recursive: true });
    if (existsSync(snapshotStaging)) rmSync(snapshotStaging, { recursive: true, force: true });
    mkdirSync(snapshotStaging);
    for (const entry of RELEASE_ARCHIVE_ENTRIES) {
      const source = join(extractDir, entry);
      if (existsSync(source)) copyFileSync(source, join(snapshotStaging, entry));
    }
    chmodSync(join(snapshotStaging, "remi"), 0o755);
    if (existsSync(join(snapshotStaging, "remi-claude-agent-acp"))) {
      chmodSync(join(snapshotStaging, "remi-claude-agent-acp"), 0o755);
    }

    const previousLauncher = existsSync(launcherPath) ? readFileSync(launcherPath) : null;
    preserveDirectBinary(previousLauncher, launcherPath, versionsDir, currentVersion);
    const rollbackLauncher = options.rollbackExecutable && options.rollbackExecutable !== launcherPath
      ? buildLauncher(previousLauncher, options.rollbackExecutable) : null;
    const previousWrapperPath = join(dirname(launcherPath), "remi-claude-agent-acp");
    if (existsSync(previousWrapperPath)) copyFileSync(previousWrapperPath, join(snapshotStaging, "previous-wrapper"));
    const nextLauncher = buildLauncher(previousLauncher, join(snapshotDir, "remi"));
    writeFileSync(join(snapshotStaging, "launcher"), nextLauncher, { mode: 0o755 });
    if (previousLauncher) writeFileSync(join(snapshotStaging, "previous-launcher"),
      rollbackLauncher ?? (previousLauncher.subarray(0, 2).toString() === "#!" ? previousLauncher
        : genericLauncher(join(versionsDir, `previous-${currentVersion.replace(/[^A-Za-z0-9._-]+/g, "-")}`, "remi"))),
      { mode: 0o755 });

    let launchdUpdated = false;
    let nextLaunchd: string | null = null;
    let previousLaunchd: string | null = null;
    if (!options.serviceRestart?.manager && existsSync(launchdPath)) {
      previousLaunchd = readFileSync(launchdPath, "utf8");
      nextLaunchd = rewriteLaunchdExecutable(previousLaunchd, launcherPath);
      launchdUpdated = nextLaunchd !== previousLaunchd;
      if (launchdUpdated) writeFileSync(join(snapshotStaging, "previous-launchd.plist"), previousLaunchd);
    }

    if (existsSync(snapshotDir)) {
      if (!readFileSync(join(snapshotDir, "remi")).equals(readFileSync(stagedBinary))) {
        throw new Error("Existing snapshot binary does not match verified archive");
      }
      const existingVersion = execFileSync(join(snapshotDir, "remi"), ["--version"], { encoding: "utf8", stdio: "pipe", timeout: 30_000 }).trim().replace(/^v/, "");
      if (existingVersion !== latestVersion) {
        throw new Error(`Snapshot ${snapshotDir} already exists with version ${existingVersion}; refusing to overwrite it`);
      }
      if (previousLauncher && !previousLauncher.equals(Buffer.from(nextLauncher))) {
        atomicWriteFile(join(snapshotDir, "previous-launcher"), readFileSync(join(snapshotStaging, "previous-launcher")), 0o755);
        const stagedWrapper = join(snapshotStaging, "previous-wrapper");
        if (existsSync(stagedWrapper)) atomicWriteFile(join(snapshotDir, "previous-wrapper"), readFileSync(stagedWrapper), 0o755);
        else rmSync(join(snapshotDir, "previous-wrapper"), { force: true });
      }
      rmSync(snapshotStaging, { recursive: true, force: true });
    } else {
      renameSync(snapshotStaging, snapshotDir);
    }

    await options.beforeActivate?.({ status: "installed", version: latestVersion, source: artifact.source, commit: artifact.commit, assetName,
      digest: expectedDigest, snapshotDir, launcherPath, launchdUpdated });

    // Point launchd at the stable launcher first. Until the following atomic
    // launcher swap it still resolves to the old binary, so a mid-update stop
    // remains recoverable.
    if (launchdUpdated && nextLaunchd !== null) atomicWriteFile(launchdPath, nextLaunchd, 0o644);
    atomicWriteFile(launcherPath, nextLauncher, 0o755);
    const installedWrapper = join(snapshotDir, "remi-claude-agent-acp");
    if (existsSync(installedWrapper)) {
      atomicWriteFile(join(dirname(launcherPath), "remi-claude-agent-acp"), genericLauncher(installedWrapper), 0o755);
    }

    return {
      status: "installed",
      version: latestVersion,
      source: artifact.source,
      commit: artifact.commit,
      assetName,
      digest: expectedDigest,
      snapshotDir,
      launcherPath,
      launchdUpdated,
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}


function parseVersion(value: string): [number, number, number] {
  const match = value.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) throw new Error(`Invalid release version: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function parseSha256Digest(digest: string | null | undefined, assetName: string): string {
  const match = digest?.trim().match(/^sha256:([a-fA-F0-9]{64})$/);
  if (!match) throw new Error(`Release asset ${assetName} has no valid SHA-256 digest; refusing to replace the existing executable`);
  return match[1]!.toLowerCase();
}

function validateArchiveEntries(archivePath: string): void {
  const entries = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8" })
    .split("\n")
    .map((entry) => entry.replace(/^\.\//, "").replace(/\/$/, ""))
    .filter(Boolean);
  if (!entries.length) throw new Error("Release archive is empty");
  for (const entry of entries) {
    if (!RELEASE_ARCHIVE_ENTRIES.has(entry)) {
      throw new Error(`Release archive contains unexpected path: ${entry}`);
    }
  }
}

function findLauncherOnPath(pathValue: string | undefined): string | null {
  for (const directory of pathValue?.split(":") ?? []) {
    const candidate = join(directory, "remi");
    if (directory && existsSync(candidate)) return candidate;
  }
  return null;
}

function preserveDirectBinary(
  current: Buffer | null,
  launcherPath: string,
  versionsDir: string,
  currentVersion: string,
): void {
  if (!current || current.subarray(0, 2).toString() === "#!") return;
  const safeVersion = currentVersion.replace(/[^A-Za-z0-9._-]+/g, "-");
  const previousDir = join(versionsDir, `previous-${safeVersion}`);
  if (existsSync(previousDir)) return;
  mkdirSync(previousDir);
  copyFileSync(launcherPath, join(previousDir, "remi"));
  chmodSync(join(previousDir, "remi"), lstatSync(launcherPath).mode & 0o777 || 0o755);
}

function buildLauncher(current: Buffer | null, binaryPath: string): string {
  if (!current || current.subarray(0, 2).toString() !== "#!") return genericLauncher(binaryPath);
  const text = current.toString("utf8");
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = lines[index]!.match(/^(\s*exec\s+)(?:"([^"]+)"|'((?:[^']|'\\'')+)'|(\S+))(.*)$/);
    const command = match?.[2] ?? match?.[3]?.replaceAll("'\\''", "'") ?? match?.[4];
    if (!match || !command || basename(command) !== "remi") continue;
    lines[index] = `${match[1]}${shellQuote(binaryPath)}${match[5]}`;
    return lines.join("\n");
  }
  return genericLauncher(binaryPath);
}

function genericLauncher(binaryPath: string): string {
  return `#!/bin/sh\n# Remi stable launcher; versioned binaries make upgrades recoverable.\nexec ${shellQuote(binaryPath)} "$@"\n`;
}

function rewriteLaunchdExecutable(content: string, launcherPath: string): string {
  const programArguments = content.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!programArguments) return content;
  const rewritten = programArguments[1]!.replace(
    /<string>([^<]*\/remi)<\/string>/,
    `<string>${escapeXml(launcherPath)}</string>`,
  );
  if (rewritten === programArguments[1]) return content;
  return content.replace(programArguments[1]!, rewritten);
}

function atomicWriteFile(path: string, content: string | Buffer, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(temporary, content, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
