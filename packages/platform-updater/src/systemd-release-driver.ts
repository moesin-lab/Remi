import { createHash } from "node:crypto";
import { mkdir, readFile, readlink, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  MultiremiPlatformOperation,
  MultiremiPlatformRelease,
  MultiremiPlatformService,
  ReportPlatformOperationInput,
} from "@multiremi/contracts";
import { type PlatformDrainGate } from "./drain.js";
import type { CommandRunner, PlatformDeploymentDriver, PlatformInspection } from "./types.js";
import { assertCompatible, atomicJson, checkBackup, createBackup, isWithin, migrationFingerprint, preflightResult, readMigrationSource, readRecoveryJournal, RecoveryRequiredError, type BackupConfig } from "./safety.js";
import { fetchReleaseResponse } from "./release-feed.js";

interface SystemdReleaseConfig {
  backup?: BackupConfig;
  root: string;
  apiService: string;
  webService: string;
  apiHealthUrl: string;
  webHealthUrl: string;
  bunExecutable: string;
}

interface SystemdManifest {
  dataSchema?: string | null;
  version: string;
  ref: string;
  releaseUrl?: string | null;
  sourceUrl: string;
  sourceSha256: string;
}

interface SystemdJournal {
  previousPath: string;
  previous: MultiremiPlatformRelease;
  phase?: string;
  result?: MultiremiPlatformRelease;
}

export class SystemdReleaseDriver implements PlatformDeploymentDriver {
  readonly kind = "systemd_release" as const;

  constructor(private readonly config: SystemdReleaseConfig, private readonly runner: CommandRunner) {}

  async recoverInterrupted(): Promise<void> {
    let entries: string[];
    try { entries = await readdir(this.config.root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const name of entries.filter((name) => /^operation-[A-Za-z0-9_-]+\.json$/.test(name))) {
      const path = join(this.config.root, name);
      const journal = await this.readJournal(path);
      if (journal?.phase === "committed") await this.recoverJournal(path, journal);
    }
  }

  private readJournal(path: string) {
    return readRecoveryJournal<SystemdJournal>(path, (value) => {
      if (typeof value.previousPath !== "string" || ![undefined, "committed", "verified", "rolled_back"].includes(value.phase)) throw new Error("Invalid journal");
      ensureChild(join(this.config.root, "releases"), value.previousPath);
      assertCompatible(value.previous, value.previous);
      if (value.phase === "verified") assertCompatible(value.result ?? null, value.result ?? {});
    });
  }

  private async recoverJournal(path: string, journal: SystemdJournal): Promise<void> {
    try {
      await this.switchCurrent(journal.previousPath);
      await this.restartAndVerify();
      await atomicJson(path, { ...journal, phase: "rolled_back" });
    } catch { throw new RecoveryRequiredError("Interrupted systemd switch recovery failed; scheduling remains paused"); }
  }

  async preflight() {
    const checks: Array<{ code: string; ok: boolean; message: string }> = [];
    for (const [code, run] of [
      ["host", async () => {
        if (process.platform !== "linux") throw new Error("systemd requires Linux; use docker_compose on Windows or macOS");
        await this.mustRun("systemctl", ["is-active", this.config.apiService, this.config.webService]);
        await this.mustRun("tar", ["--version"]);
        const bun = await this.runner.run(this.config.bunExecutable, ["--version"]);
        if (bun.exitCode !== 0 || bun.stdout.trim() !== "1.3.14") throw new Error("Bun 1.3.14 is required for release builds");
      }],
      ["backup", () => checkBackup(this.config.backup)],
      ["current_release", async () => {
        const current = await this.readCurrentRelease();
        if (!current) throw new Error("Current release metadata is missing");
        assertCompatible(current, current);
        const source = await readMigrationSource(join(this.config.root, "current"));
        if (migrationFingerprint(source) !== current.dataSchema) throw new Error("Current release schema does not match its manifest");
      }],
    ] as const) {
      try { await run(); checks.push({ code, ok: true, message: `${code}: ready` }); }
      catch (error) { checks.push({ code, ok: false, message: errorMessage(error) }); }
    }
    return preflightResult(checks);
  }

  async inspect(): Promise<PlatformInspection> {
    const [currentRelease, recentReleases, api, web] = await Promise.all([
      this.readCurrentRelease(),
      this.readRecentReleases(),
      this.inspectService("api", "API", this.config.apiService),
      this.inspectService("web", "Web", this.config.webService),
    ]);
    return {
      driver: this.kind,
      currentRelease,
      recentReleases,
      services: [api, web, unknownDependency("postgres", "PostgreSQL"), unknownDependency("openviking", "OpenViking")],
    };
  }

  async execute(
    operation: MultiremiPlatformOperation,
    report: (input: ReportPlatformOperationInput) => Promise<void>,
    drain?: PlatformDrainGate,
  ): Promise<MultiremiPlatformRelease | null> {
    if (operation.kind === "check_updates") return (await this.inspect()).currentRelease;
    if (!drain) throw new Error("A platform drain is required before restarting or updating services");
    const interrupted = await this.readJournal(this.journalPath(operation.id));
    if (interrupted) {
      if (interrupted.phase === "verified") return interrupted.result!;
      if (interrupted.phase === "rolled_back") throw new Error("Previous release recovered; the update did not complete");
      if (!["switching", "restarting", "verifying", "rolling_back"].includes(operation.status)) {
        await rm(this.journalPath(operation.id));
        throw new Error("Prepared update was interrupted before commit; current services were left running");
      }
      await this.recoverJournal(this.journalPath(operation.id), interrupted);
      throw new Error("Interrupted platform operation recovered to the previous release");
    }
    if (["switching", "restarting", "verifying", "rolling_back"].includes(operation.status)) throw new RecoveryRequiredError("Committed operation has no recovery journal");
    if (operation.kind === "update") parseSystemdManifest(operation.targetManifest);
    const preflight = await this.preflight();
    if (!preflight.ready) throw new Error(preflight.checks.filter((check) => !check.ok).map((check) => check.message).join("; "));
    if (operation.kind === "restart") {
      const current = (await this.inspect()).currentRelease!;
      return this.activateTarget(operation, await this.releasePathFor(current), current, report, drain);
    }
    if (operation.kind === "rollback") return this.rollback(operation, report, drain);
    return this.update(operation, report, drain);
  }

  private async update(
    operation: MultiremiPlatformOperation,
    report: (input: ReportPlatformOperationInput) => Promise<void>,
    drain?: PlatformDrainGate,
  ): Promise<MultiremiPlatformRelease> {
    const manifest = parseSystemdManifest(operation.targetManifest);
    const previous = await this.readCurrentRelease();
    assertCompatible(previous, manifest);
    if (operation.targetVersion && operation.targetVersion.replace(/^v/, "") !== manifest.version.replace(/^v/, "")) throw new Error("Manifest version does not match requested version");
    const releaseName = safeReleaseName(`${manifest.version}-${manifest.ref.slice(0, 12)}-${operation.id}`);
    const releasesDir = join(this.config.root, "releases");
    const target = ensureChild(releasesDir, join(releasesDir, releaseName));
    const archive = ensureChild(this.config.root, join(this.config.root, `.download-${operation.id}.tar.gz`));
    await report({ status: "pulling", previousRelease: previous, progress: { message: `Downloading ${manifest.version}` } });
    try {
      await mkdir(releasesDir, { recursive: true });
      await mkdir(target);
      const response = await fetchReleaseResponse(manifest.sourceUrl);
      if (!response.ok) throw new Error(`release archive returned ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== manifest.sourceSha256.toLowerCase()) throw new Error("release archive checksum mismatch");
      await writeFile(archive, bytes, { mode: 0o600 });
      const listing = await this.runner.run("tar", ["-tzf", archive]);
      if (listing.exitCode !== 0 || listing.stdout.split("\n").some((path) => path.startsWith("/") || path.split(/[\\/]/).includes(".."))) throw new Error("Invalid release archive paths");
      await this.mustRun("tar", ["-xzf", archive, "--strip-components=1", "--no-same-owner", "--no-same-permissions", "-C", target]);
      if (migrationFingerprint(await readMigrationSource(target)) !== manifest.dataSchema) throw new Error("Release archive schema does not match its manifest");
      await this.mustRun(this.config.bunExecutable, ["install", "--frozen-lockfile", "--ignore-scripts", "--registry", "https://registry.npmjs.org"], target);
      await this.mustRun(this.config.bunExecutable, ["run", "--filter", "@multiremi/web", "build"], target, { STANDALONE: "true" });
      const release: MultiremiPlatformRelease = {
        dataSchema: manifest.dataSchema,
        version: manifest.version,
        ref: manifest.ref,
        publishedAt: new Date().toISOString(),
        releaseUrl: manifest.releaseUrl ?? null,
        manifestUrl: operation.targetRef,
        apiImage: null,
        webImage: null,
      };
      await writeFile(join(target, ".platform-release.json"), `${JSON.stringify(release, null, 2)}\n`);
      // The release is fully staged; only the symlink switch + service restart
      // require a drained platform. Timeout/cancel throws with drain released
      // and the current release untouched.
      return await this.activateTarget(operation, target, release, report, drain!);
    } finally {
      await rm(archive, { force: true });
    }
  }

  private async rollback(
    operation: MultiremiPlatformOperation,
    report: (input: ReportPlatformOperationInput) => Promise<void>,
    drain?: PlatformDrainGate,
  ): Promise<MultiremiPlatformRelease> {
    const targetRelease = await this.findRelease(operation.targetRef ?? operation.targetVersion ?? "");
    if (!targetRelease) throw new Error("rollback release not found");
    return this.activateTarget(operation, await this.releasePathFor(targetRelease), targetRelease, report, drain!);
  }

  private journalPath(id: string): string {
    safeReleaseName(id);
    return join(this.config.root, `operation-${id}.json`);
  }

  private async activateTarget(operation: MultiremiPlatformOperation, target: string, release: MultiremiPlatformRelease, report: (input: ReportPlatformOperationInput) => Promise<void>, drain: PlatformDrainGate) {
    const previous = (await this.readCurrentRelease())!;
    assertCompatible(previous, release);
    const previousPath = ensureChild(join(this.config.root, "releases"), resolve(this.config.root, await readlink(join(this.config.root, "current"))));
    await drain.waitUntilDrained(report);
    await report({ status: "backing_up", progress: { message: "Backing up database and persistent state" } });
    const backup = await createBackup(this.config.backup, this.runner, operation.id);
    await drain.assertReady();
    const journal = { previous, previousPath, backup };
    await atomicJson(this.journalPath(operation.id), journal);
    let committed = false;
    try {
      await report({ status: "switching", previousRelease: previous, progress: { message: "Activating release", backup } });
      committed = true;
      await atomicJson(this.journalPath(operation.id), { ...journal, phase: "committed" });
      await this.switchCurrent(target);
      await this.restartAndVerify();
      await atomicJson(this.journalPath(operation.id), { ...journal, phase: "verified", result: release });
      return release;
    } catch (error) {
      if (!committed) { await rm(this.journalPath(operation.id), { force: true }); throw error; }
      try {
        await this.switchCurrent(previousPath);
        await this.restartAndVerify();
        await atomicJson(this.journalPath(operation.id), { ...journal, phase: "rolled_back" });
      } catch { throw new RecoveryRequiredError("Update and rollback verification failed; backup retained and scheduling remains paused"); }
      throw error;
    }
  }

  private async restartAndVerify(): Promise<void> {
    await this.mustRun("systemctl", ["restart", this.config.apiService, this.config.webService]);
    await Promise.all([verifyUrl(this.config.apiHealthUrl), verifyUrl(this.config.webHealthUrl)]);
  }

  private async switchCurrent(target: string): Promise<void> {
    ensureChild(join(this.config.root, "releases"), target);
    const current = join(this.config.root, "current");
    const next = join(this.config.root, `.current-${process.pid}`);
    await rm(next, { force: true });
    await symlink(target, next);
    await rename(next, current);
  }

  private async readCurrentRelease(): Promise<MultiremiPlatformRelease | null> {
    try {
      const target = await readlink(join(this.config.root, "current"));
      return this.readRelease(resolve(this.config.root, target));
    } catch {
      return null;
    }
  }

  private async readRecentReleases(): Promise<MultiremiPlatformRelease[]> {
    try {
      const names = (await readdir(join(this.config.root, "releases"))).sort().reverse().slice(0, 10);
      const releases = await Promise.all(names.map((name) => this.readRelease(join(this.config.root, "releases", name))));
      return releases.filter((release): release is MultiremiPlatformRelease => release !== null);
    } catch {
      return [];
    }
  }

  private async readRelease(path: string): Promise<MultiremiPlatformRelease | null> {
    try {
      return JSON.parse(await readFile(join(path, ".platform-release.json"), "utf8")) as MultiremiPlatformRelease;
    } catch {
      return null;
    }
  }

  private async findRelease(ref: string): Promise<MultiremiPlatformRelease | null> {
    return (await this.readRecentReleases()).find((release) => release.ref === ref || release.version === ref) ?? null;
  }

  private async releasePathFor(release: MultiremiPlatformRelease): Promise<string> {
    const entries = await readdir(join(this.config.root, "releases"));
    for (const name of entries) {
      const path = ensureChild(join(this.config.root, "releases"), join(this.config.root, "releases", name));
      const candidate = await this.readRelease(path);
      if (candidate?.version === release.version && candidate.ref === release.ref) return path;
    }
    throw new Error(`release directory for ${release.version} not found`);
  }

  private async inspectService(id: "api" | "web", name: string, unit: string): Promise<MultiremiPlatformService> {
    const result = await this.runner.run("systemctl", ["is-active", unit]);
    return { id, name, status: result.exitCode === 0 ? "ready" : "stopped", detail: result.stdout.trim() || result.stderr.trim() || null, version: null, checkedAt: new Date().toISOString() };
  }

  private async mustRun(command: string, args: string[], cwd?: string, env?: Record<string, string>): Promise<void> {
    const result = await this.runner.run(command, args, { cwd, env });
    if (result.exitCode !== 0) throw new Error(`${command} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

function parseSystemdManifest(value: Record<string, unknown>): SystemdManifest {
  for (const key of ["version", "ref", "sourceUrl", "sourceSha256"] as const) {
    if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`manifest ${key} is required`);
  }
  if (!/^v?\d+\.\d+\.\d+$/.test(String(value.version))) throw new Error("manifest version must be SemVer");
  if (!/^[a-f0-9]{64}$/i.test(String(value.sourceSha256))) throw new Error("manifest sourceSha256 is invalid");
  assertHttpsUrl(String(value.sourceUrl), "manifest sourceUrl");
  return value as unknown as SystemdManifest;
}

function assertHttpsUrl(value: string, label: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} is invalid`); }
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
}

function safeReleaseName(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error("release name is invalid");
  return value;
}

function ensureChild(parent: string, child: string): string {
  const candidate = resolve(child);
  if (!isWithin(parent, candidate) || resolve(parent) === candidate) throw new Error("release path escapes platform root");
  return candidate;
}

async function verifyUrl(url: string): Promise<void> {
  let lastError = "health check failed";
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return;
      lastError = `${url} returned ${response.status}`;
    } catch (error) {
      lastError = errorMessage(error);
    }
    await Bun.sleep(2_500);
  }
  throw new Error(lastError);
}

function unknownDependency(id: "postgres" | "openviking", name: string): MultiremiPlatformService {
  return { id, name, status: "unknown", detail: "Not managed by the systemd release driver", version: null, checkedAt: new Date().toISOString() };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
