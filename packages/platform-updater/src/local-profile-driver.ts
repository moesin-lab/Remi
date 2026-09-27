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

interface LocalProfileConfig {
  repository: string;
  profilesRoot: string;
  profile: string;
  nodeExecutable: string;
  expectedArchitecture: string;
  minimumFreeBytes: number;
}

interface LocalProfileManifest {
  version: string;
  ref: string;
  sourceUrl: string;
  sourceSha256: string;
}

interface HostOperationJournal {
  status?: string;
  error?: string | null;
  resultRelease?: MultiremiPlatformRelease | null;
}

/**
 * Source-build driver for repository-external local profiles.
 *
 * The child script owns an atomic host journal. inspect() first recovers an
 * interrupted switch, allowing an old API to return before any heartbeat or
 * operation report is attempted. Staging completes before the drain gate.
 */
export class LocalProfileDriver implements PlatformDeploymentDriver {
  readonly kind = "local_profile" as const;
  private readonly script: string;
  private readonly profileRoot: string;

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

  async execute(
    operation: MultiremiPlatformOperation,
    report: (input: ReportPlatformOperationInput) => Promise<void>,
    drain?: PlatformDrainGate,
  ): Promise<MultiremiPlatformRelease | null> {
    if (operation.kind === "check_updates") return (await this.inspect()).currentRelease;
    if (operation.kind === "restart") {
      await report({ status: "restarting", progress: { message: `Restarting ${this.config.profile} profile services` } });
      await this.runHost(["restart"]);
      return (await this.inspect()).currentRelease;
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
    await report({ status: "pulling", previousRelease: previous, progress: { message: `Fetching and staging ${manifest.ref}` } });
    await this.runHost([
      "host-stage", "--operation-id", operation.id, "--ref", manifest.ref,
      "--version", manifest.version, "--source-url", manifest.sourceUrl,
      "--source-sha256", manifest.sourceSha256,
    ]);
    await this.throwForTerminalJournal(operation.id);
    await drain.waitUntilDrained(report);
    await report({ status: "switching", previousRelease: previous, progress: { message: "Activating staged profile release" } });
    try {
      await this.runHost(["host-activate", "--operation-id", operation.id]);
    } catch (error) {
      const journal = await this.readJournal(operation.id);
      throw new Error(journal?.error || errorMessage(error));
    }
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
    await this.runHost(["host-rollback-stage", "--operation-id", operation.id, "--ref", target]);
    await this.throwForTerminalJournal(operation.id);
    await drain.waitUntilDrained(report);
    await report({ status: "rolling_back", previousRelease: previous, progress: { message: `Restoring code and data for ${target}` } });
    await this.runHost(["host-rollback-activate", "--operation-id", operation.id]);
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
    try { return active ? releaseFromDeployment(active) : null; } catch { return null; }
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
    const result = await this.runner.run("docker", [
      "compose", "-p", `remi-${this.config.profile}`,
      "--env-file", join(this.profileRoot, "compose.env"),
      "-f", join(this.profileRoot, "compose.yml"), "ps", "--format", "json",
    ]);
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
