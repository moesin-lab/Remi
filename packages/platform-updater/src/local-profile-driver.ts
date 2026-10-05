import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  MultiremiPlatformOperation,
  MultiremiPlatformRelease,
  MultiremiPlatformService,
  ReportPlatformOperationInput,
} from "@multiremi/contracts";
import type { PlatformDrainGate } from "./drain.js";
import type { CommandRunner, PlatformDeploymentDriver, PlatformInspection } from "./types.js";
import { assertCompatible, DATA_SCHEMA_INPUTS, migrationFingerprint, preflightResult, RecoveryRequiredError } from "./safety.js";

interface LocalProfileConfig {
  repository: string;
  profilesRoot: string;
  profile: string;
  nodeExecutable: string;
  expectedArchitecture: string;
  minimumFreeBytes: number;
}

interface LocalProfileManifest {
  dataSchema?: string | null;
  version: string;
  ref: string;
  sourceUrl: string;
  sourceSha256: string;
}

interface HostOperationJournal {
  status?: string;
  phase?: string;
  error?: string | null;
  resultRelease?: MultiremiPlatformRelease | null;
}

/**
 * CI-image deployment driver for repository-external local profiles.
 *
 * The child script owns an atomic host journal. inspect() first recovers an
 * interrupted switch, allowing an old API to return before any heartbeat or
 * operation report is attempted. Staging completes before the drain gate.
 */
export class LocalProfileDriver implements PlatformDeploymentDriver {
  readonly kind = "local_profile" as const;
  private readonly script: string;
  private readonly profileRoot: string;
  private readonly schemas = new Map<string, string>();

  constructor(private readonly config: LocalProfileConfig, private readonly runner: CommandRunner) {
    if (!/^[A-Za-z0-9._-]+$/.test(config.profile)) throw new Error("local profile name is invalid");
    this.script = join(resolve(config.repository), "scripts", "local-profile.mjs");
    this.profileRoot = join(resolve(config.profilesRoot), config.profile);
  }

  async inspect(): Promise<PlatformInspection> {
    await this.runHost(["host-recover"]);
    const currentRelease = await this.readCurrentRelease();
    return {
      driver: this.kind,
      currentRelease,
      recentReleases: await this.readRecentReleases(currentRelease),
      services: await this.inspectServices(),
    };
  }

  async finalize(operationId: string): Promise<void> {
    await this.runHost(["host-finalize", "--operation-id", operationId]);
  }

  async preflight() {
    const checks: Array<{ code: string; ok: boolean; message: string }> = [];
    for (const [code, run] of [
      ["local_profile", () => this.runHost(["host-preflight"])],
      ["current_release", async () => {
        const current = await this.readCurrentRelease();
        assertCompatible(current, current ?? {});
        const result = await this.compose(["exec", "-T", "api", "cat", ...DATA_SCHEMA_INPUTS.map(path => `/app/${path}`)]);
        if (result.exitCode !== 0 || !result.stdout || migrationFingerprint(result.stdout) !== current?.dataSchema) throw new Error("Current profile schema does not match the running API");
      }],
    ] as const) {
      try { await run(); checks.push({ code, ok: true, message: `${code} ready` }); }
      catch (error) { checks.push({ code, ok: false, message: errorMessage(error) }); }
    }
    return preflightResult(checks);
  }

  async execute(
    operation: MultiremiPlatformOperation,
    report: (input: ReportPlatformOperationInput) => Promise<void>,
    drain?: PlatformDrainGate,
  ): Promise<MultiremiPlatformRelease | null> {
    if (operation.kind === "check_updates") return (await this.inspect()).currentRelease;
    if (operation.kind === "restart") {
      if (!drain) throw new Error("local profile restart requires a drain gate");
      if (["restarting", "verifying"].includes(operation.status)) return this.restartServices();
      const checks = await this.preflight();
      if (!checks.ready) throw new Error(checks.checks.filter(check => !check.ok).map(check => check.message).join("; "));
      await drain.waitUntilDrained(report);
      await report({ status: "backing_up", progress: { message: "Verifying a complete profile backup" } });
      await drain.assertReady();
      // The native backup temporarily stops API/Web, so fence cancellation and
      // scheduling before it can touch those services.
      await report({ status: "restarting", progress: { message: `Backing up and restarting ${this.config.profile} profile services` } });
      try { await this.runHost(["backup"]); }
      catch (error) { throw new RecoveryRequiredError(`Profile backup needs recovery; scheduling remains paused: ${errorMessage(error)}`); }
      return this.restartServices();
    }
    if (!drain) throw new Error(`local profile ${operation.kind} requires a drain gate`);
    return operation.kind === "rollback"
      ? this.rollback(operation, report, drain)
      : this.update(operation, report, drain);
  }

  private async update(
    operation: MultiremiPlatformOperation,
    report: (input: ReportPlatformOperationInput) => Promise<void>,
    drain: PlatformDrainGate,
  ): Promise<MultiremiPlatformRelease> {
    const manifest = parseManifest(operation.targetManifest);
    if (operation.targetVersion && operation.targetVersion !== manifest.version) {
      throw new Error("operation targetVersion does not match the deployment manifest");
    }
    const previous = await this.readCurrentRelease();
    assertCompatible(previous, manifest);
    await report({ status: "pulling", previousRelease: previous, progress: { message: `Fetching and staging ${manifest.ref}` } });
    await this.runHost([
      "host-stage", "--operation-id", operation.id, "--ref", manifest.ref,
      "--version", manifest.version, "--source-url", manifest.sourceUrl,
      "--source-sha256", manifest.sourceSha256,
      "--data-schema", manifest.dataSchema!,
    ]);
    await this.throwForTerminalJournal(operation.id);
    await drain.waitUntilDrained(report);
    await drain.assertReady();
    await report({ status: "switching", previousRelease: previous, progress: { message: "Activating staged profile release" } });
    await this.activateHost(operation.id, "host-activate");
    const release = (await this.readJournal(operation.id))?.resultRelease ?? await this.readCurrentRelease();
    if (!release || release.ref !== manifest.ref) throw new Error("host activation did not record the requested release");
    return release;
  }

  private async rollback(
    operation: MultiremiPlatformOperation,
    report: (input: ReportPlatformOperationInput) => Promise<void>,
    drain: PlatformDrainGate,
  ): Promise<MultiremiPlatformRelease> {
    const target = operation.targetRef ?? operation.targetVersion;
    if (!target) throw new Error("rollback target is required");
    const previous = await this.readCurrentRelease();
    await report({ status: "preparing", previousRelease: previous, progress: { message: `Locating complete backup for ${target}` } });
    await this.runHost(["host-rollback-stage", "--operation-id", operation.id, "--ref", target, "--preserve-data", "true"]);
    await this.throwForTerminalJournal(operation.id);
    await drain.waitUntilDrained(report);
    await drain.assertReady();
    await report({ status: "switching", previousRelease: previous, progress: { message: `Restoring code for ${target} while preserving current data` } });
    await this.activateHost(operation.id, "host-rollback-activate");
    const release = (await this.readJournal(operation.id))?.resultRelease ?? await this.readCurrentRelease();
    if (!release) throw new Error("host rollback did not record a release");
    return release;
  }

  private async runHost(args: string[]): Promise<void> {
    const result = await this.runner.run(this.config.nodeExecutable, [this.script, this.config.profile, ...args], {
      cwd: this.config.repository,
      env: {
        REMI_PROFILES_ROOT: this.config.profilesRoot,
        REMI_HOST_EXPECTED_ARCH: this.config.expectedArchitecture,
        REMI_HOST_MIN_FREE_BYTES: String(Math.floor(this.config.minimumFreeBytes)),
      },
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `local profile ${args[0]} failed`);
  }

  private async readCurrentRelease(): Promise<MultiremiPlatformRelease | null> {
    const active = await readJson<Record<string, unknown>>(join(this.profileRoot, "active.json"));
    if (!active) return null;
    try {
      const release = releaseFromDeployment(active);
      if (!release.dataSchema) {
        if (!this.schemas.has(release.ref)) {
          const chunks: string[] = [];
          for (const path of DATA_SCHEMA_INPUTS) {
            const result = await this.runner.run("git", ["show", `${release.ref}:${path}`], { cwd: this.config.repository });
            if (result.exitCode !== 0 || !result.stdout) throw new Error("Current profile schema is unavailable");
            chunks.push(result.stdout);
          }
          this.schemas.set(release.ref, migrationFingerprint(chunks.join("")));
        }
        release.dataSchema = this.schemas.get(release.ref)!;
      }
      return release;
    } catch { return releaseFromDeployment(active); }
  }

  private async readRecentReleases(current: MultiremiPlatformRelease | null): Promise<MultiremiPlatformRelease[]> {
    const releases: MultiremiPlatformRelease[] = current ? [current] : [];
    try {
      const backups = (await readdir(join(this.profileRoot, "backups"))).sort().reverse();
      for (const name of backups) {
        if (releases.length >= 10) break;
        try {
          await readFile(join(this.profileRoot, "backups", name, "complete.json"), "utf8");
          const deployment = JSON.parse(await readFile(join(this.profileRoot, "backups", name, "active.json"), "utf8")) as Record<string, unknown>;
          const candidate = releaseFromDeployment(deployment);
          if (!releases.some((item) => item.ref === candidate.ref)) releases.push(candidate);
        } catch {}
      }
    } catch {}
    return releases;
  }

  private async inspectServices(): Promise<MultiremiPlatformService[]> {
    const deployment = await readJson<Record<string, unknown>>(join(this.profileRoot, "deployment.json"));
    if (!deployment) return [unknown("api"), unknown("web"), unknown("postgres"), unknown("openviking")];
    const result = await this.compose(["ps", "--format", "json"]);
    const rows = result.exitCode === 0 ? result.stdout.split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
    }) : [];
    const managed = (["api", "web", "postgres"] as const).map((id): MultiremiPlatformService => {
      const row = rows.find((value) => value.Service === id);
      const state = String(row?.State ?? "unknown");
      return { id, name: id === "api" ? "API" : id === "web" ? "Web" : "PostgreSQL", status: state === "running" ? "ready" : state === "unknown" ? "unknown" : "stopped", detail: row ? String(row.Status ?? state) : null, version: row ? String(row.Image ?? "") || null : null, checkedAt: new Date().toISOString() };
    });
    return [...managed, unknown("openviking")];
  }

  private async restartServices(): Promise<MultiremiPlatformRelease | null> {
    try {
      await this.runHost(["restart"]);
      return (await this.inspect()).currentRelease;
    } catch (error) {
      throw new RecoveryRequiredError(`Profile restart needs recovery; scheduling remains paused: ${errorMessage(error)}`);
    }
  }

  private async activateHost(operationId: string, action: string): Promise<void> {
    try { await this.runHost([action, "--operation-id", operationId]); }
    catch (error) {
      let journal: HostOperationJournal | null;
      try { journal = await this.readJournal(operationId); }
      catch { throw new RecoveryRequiredError("Host recovery journal is unreadable; scheduling remains paused"); }
      if (!journal || journal.status === "recovery_required" || (journal.status === "running"
        && ["switching", "backup_complete", "activating", "rolling_back", "rollback_backing_up", "rollback_recovering"].includes(journal.phase ?? ""))) {
        throw new RecoveryRequiredError(journal?.error || `Host switch needs recovery: ${errorMessage(error)}`);
      }
      throw new Error(journal.error || errorMessage(error));
    }
  }

  private compose(args: string[]) {
    return this.runner.run("docker", [
      "compose", "-p", `remi-${this.config.profile}`,
      "--env-file", join(this.profileRoot, "compose.env"),
      "-f", join(this.profileRoot, "compose.yml"), ...args,
    ]);
  }

  private readJournal(operationId: string): Promise<HostOperationJournal | null> {
    return readJson(join(this.profileRoot, "host-operations", operationId, "operation.json"));
  }

  private async throwForTerminalJournal(operationId: string): Promise<void> {
    const journal = await this.readJournal(operationId);
    if (journal?.status === "failed" || journal?.status === "rolled_back") {
      throw new Error(journal.error || `host operation ${operationId} ${journal.status}`);
    }
  }
}

function parseManifest(value: Record<string, unknown>): LocalProfileManifest {
  for (const key of ["version", "ref", "sourceUrl", "sourceSha256"] as const) {
    if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`manifest ${key} is required`);
  }
  if (!/^v?\d+\.\d+\.\d+$/.test(String(value.version))) throw new Error("manifest version must be SemVer");
  if (!/^[a-f0-9]{40}$/i.test(String(value.ref))) throw new Error("manifest ref must be a full Git commit");
  if (!/^[a-f0-9]{64}$/i.test(String(value.sourceSha256))) throw new Error("manifest sourceSha256 is invalid");
  assertHttpsUrl(String(value.sourceUrl), "manifest sourceUrl");
  return value as unknown as LocalProfileManifest;
}

function assertHttpsUrl(value: string, label: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} is invalid`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must use HTTPS without credentials, query, or fragment`);
  }
}

function releaseFromDeployment(value: Record<string, unknown>): MultiremiPlatformRelease {
  const ref = String(value.ref ?? "");
  if (!/^[a-f0-9]{40}$/i.test(ref)) throw new Error("profile deployment has an invalid ref");
  return {
    dataSchema: typeof value.dataSchema === "string" ? value.dataSchema : null,
    version: String(value.version ?? ref).split("-stable.")[0]!, ref, publishedAt: null, releaseUrl: null, manifestUrl: null,
    apiImage: typeof value.apiImage === "string" ? value.apiImage : null,
    webImage: typeof value.webImage === "string" ? value.webImage : null,
  };
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return null; }
}

function unknown(id: "api" | "web" | "postgres" | "openviking"): MultiremiPlatformService {
  const name = id === "api" ? "API" : id === "web" ? "Web" : id === "postgres" ? "PostgreSQL" : "OpenViking";
  return { id, name, status: "unknown", detail: id === "openviking" ? "Not part of a local profile" : "Profile is not prepared", version: null, checkedAt: new Date().toISOString() };
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
