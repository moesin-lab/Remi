import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  MultiremiPlatformOperation,
  MultiremiPlatformRelease,
  MultiremiPlatformService,
  ReportPlatformOperationInput,
} from "@multiremi/contracts";
import { type PlatformDrainGate } from "./drain.js";
import { resolveHealthTimeoutMs, waitForHealthyUrl } from "./health-check.js";
import { validateComposeStartupBudgets } from "./startup-budget.js";
import type { CommandRunner, PlatformDeploymentDriver, PlatformInspection } from "./types.js";
import { assertCompatible, atomicJson, checkBackup, createBackup, DATA_SCHEMA_INPUTS, migrationFingerprint, preflightResult, readRecoveryJournal, RecoveryRequiredError, type BackupConfig } from "./safety.js";

interface ComposeConfig {
  backup?: BackupConfig;
  projectName?: string;
  composeFile: string;
  envFile: string;
  stateDir: string;
  apiHealthUrl: string;
  webHealthUrl: string;
  healthTimeoutMs?: number;
  /**
   * Overrides `MULTIREMI_PLATFORM_CORE_SERVICES` for tests and embedders.
   * `null`/absent means the environment decides.
   */
  coreServices?: readonly string[] | null;
  /**
   * Overrides `MULTIREMI_PLATFORM_EXTRA_HEALTH_URLS` for tests and embedders.
   */
  extraHealthUrls?: readonly string[] | null;
  postgresContainer?: string | null;
  openvikingContainer?: string | null;
}

/** Services this stack owns outright and switches as one batch. */
const DEFAULT_CORE_SERVICES = ["api", "web"] as const;
/**
 * Services whose absence from a configured list means the host silently stops
 * being upgraded. Both share the API image, and `web` is the only route to the
 * browser surface.
 */
const REQUIRED_SERVICES = ["api", "web"] as const;
/**
 * The service that used to run Feishu ingestion. It is gone from the Compose
 * file, but an installation upgrading across that change still has its
 * container running — and because it borrowed the API container's network
 * namespace, Docker will refuse to replace the API container until it is gone.
 * Removing it is therefore part of the switch, not housekeeping. Safe to delete
 * once no installation predates this release.
 */
const RETIRED_SIDECAR_SERVICE = "feishu-sidecar";

interface ComposeManifest {
  dataSchema?: string | null;
  version: string;
  ref: string;
  releaseUrl?: string | null;
  manifestUrl?: string | null;
  apiImage: string;
  webImage: string;
}

interface ComposeJournal {
  originalEnv: string;
  previous: MultiremiPlatformRelease;
  phase?: string;
  result?: MultiremiPlatformRelease;
}

export class DockerComposeDriver implements PlatformDeploymentDriver {
  readonly kind = "docker_compose" as const;
  readonly updateMode = "images" as const;

  private readonly coreServices: readonly string[];
  private readonly pullServices: readonly string[];
  private readonly extraHealthUrls: readonly string[];
  private readonly healthTimeoutMs: number;

  constructor(private readonly config: ComposeConfig, private readonly runner: CommandRunner) {
    this.healthTimeoutMs = resolveHealthTimeoutMs(config.healthTimeoutMs ?? process.env.MULTIREMI_PLATFORM_HEALTH_TIMEOUT_MS);
    // Keep split application services configurable, while leaving agent
    // connectivity and persistent data containers outside every switch.
    const configured = config.coreServices ?? parseServiceList(process.env.MULTIREMI_PLATFORM_CORE_SERVICES);
    const protectedServices = new Set(["ssh-mesh-control-plane", "daemon", "postgres", "openviking"]);
    this.coreServices = [...new Set(configured ?? DEFAULT_CORE_SERVICES)].filter(service => !protectedServices.has(service));
    this.pullServices = this.coreServices;
    this.extraHealthUrls = config.extraHealthUrls
      ?? parseServiceList(process.env.MULTIREMI_PLATFORM_EXTRA_HEALTH_URLS)
      ?? [];
    // An explicit list is the operator's statement about this host's topology,
    // so a partial one is obeyed, not repaired: inventing services here would
    // start containers the operator did not ask for. But dropping `api` or `web`
    // means the platform stops being upgraded, which is silent and only visible
    // days later, so it is worth one line in the journal. The default list and
    // an injected config never warn.
    for (const required of REQUIRED_SERVICES) {
      if (!this.coreServices.includes(required) && !this.pullServices.includes(required)) {
        console.warn(`[platform-updater] MULTIREMI_PLATFORM_CORE_SERVICES does not include "${required}": that service will not be pulled, switched or restarted`);
      }
    }
  }

  async recoverInterrupted(): Promise<void> {
    let entries: string[];
    try { entries = await readdir(this.config.stateDir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const name of entries.filter((name) => /^operation-[A-Za-z0-9_-]+\.json$/.test(name))) {
      const path = join(this.config.stateDir, name);
      const journal = await this.readJournal(path);
      if (journal?.phase === "committed") await this.recoverJournal(path, journal);
    }
  }

  private readJournal(path: string) {
    return readRecoveryJournal<ComposeJournal>(path, (value) => {
      if (typeof value.originalEnv !== "string" || ![undefined, "committed", "verified", "rolled_back"].includes(value.phase)) throw new Error("Invalid journal");
      parseComposeManifest(value.previous);
      if (value.phase === "verified") parseComposeManifest(value.result);
    });
  }

  private async recoverJournal(path: string, journal: ComposeJournal): Promise<void> {
    try {
      await this.restoreEnvFile(journal.originalEnv);
      await this.mustCompose(["up", "-d", "--no-deps", "--pull", "never", ...this.coreServices]);
      await this.verify();
      await this.writeRelease(journal.previous);
      await atomicJson(path, { ...journal, phase: "rolled_back" });
    } catch { throw new RecoveryRequiredError("Interrupted switch recovery failed; task scheduling remains paused"); }
  }

  async preflight() {
    const checks: Array<{ code: string; ok: boolean; message: string }> = [];
    for (const [code, run] of [
      ["compose", async () => {
        await this.mustCompose(["version"]);
        const result = await this.compose(["config", "--format", "json"]);
        if (result.exitCode !== 0) throw new Error("Compose configuration is invalid");
        const config = JSON.parse(result.stdout);
        if (!config.name || !config.services?.api || !config.services?.web) throw new Error("Compose must identify a project with api and web services");
        const engine = await this.runner.run("docker", ["info", "--format", "{{.OSType}}"]);
        if (engine.exitCode !== 0 || engine.stdout.trim() !== "linux") throw new Error("A running Linux-container Docker engine is required");
      }],
      ["backup", () => checkBackup(this.config.backup)],
      ["current_release", async () => {
        const current = await this.readCurrentRelease();
        if (!current?.apiImage || !current.webImage) throw new Error("Register the current release manifest before updating");
        parseComposeManifest(current);
        assertCompatible(current, current);
        const source = await this.compose(["exec", "-T", "api", "cat", ...DATA_SCHEMA_INPUTS.map((path) => `/app/${path}`)]);
        if (source.exitCode !== 0 || migrationFingerprint(source.stdout) !== current.dataSchema) throw new Error("Current release data schema does not match the running API");
      }],
    ] as const) {
      try { await run(); checks.push({ code, ok: true, message: `${code}: ready` }); }
      catch (error) { checks.push({ code, ok: false, message: errorMessage(error) }); }
    }
    return preflightResult(checks);
  }

  async inspect(): Promise<PlatformInspection> {
    const [currentRelease, recentReleases, services] = await Promise.all([
      this.readCurrentRelease(), this.readRecentReleases(), this.inspectServices(),
    ]);
    return { driver: this.kind, updateMode: this.updateMode, currentRelease, recentReleases, services };
  }

  async execute(
    operation: MultiremiPlatformOperation,
    report: (input: ReportPlatformOperationInput) => Promise<void>,
    drain?: PlatformDrainGate,
  ): Promise<MultiremiPlatformRelease | null> {
    if (operation.kind === "check_updates") return (await this.inspect()).currentRelease;
    if (!drain) throw new Error("A platform drain is required before restarting or updating services");
    const journalPath = this.journalPath(operation.id);
    const interrupted = await this.readJournal(journalPath);
    if (interrupted) {
      if (interrupted.phase === "verified") return interrupted.result!;
      if (interrupted.phase === "rolled_back") throw new Error("Previous release recovered; the update did not complete");
      if (!["switching", "restarting", "verifying", "rolling_back"].includes(operation.status)) {
        await rm(journalPath);
        throw new Error("Prepared update was interrupted before commit; current services were left running");
      }
      // A crash after commit cannot be replayed as a new deployment. Restore the
      // exact old configuration locally before any call to the recovering API.
      await this.recoverJournal(journalPath, interrupted);
      throw new Error("Interrupted platform operation recovered to the previous release");
    }
    if (["switching", "restarting", "verifying", "rolling_back"].includes(operation.status)) {
      throw new RecoveryRequiredError("Committed operation has no local recovery journal; inspect deployment before releasing maintenance");
    }
    if (operation.kind === "update") {
      parseComposeManifest(operation.targetManifest);
      // Rendered environment contains secrets; validate with redacted errors
      // before the general preflight and any host changes.
      await this.validateStartupBudgets();
    }
    const preflight = await this.preflight();
    if (!preflight.ready) throw new Error(preflight.checks.filter((check) => !check.ok).map((check) => check.message).join("; "));
    if (operation.kind === "restart") {
      await drain.waitUntilDrained(report);
      await report({ status: "backing_up", progress: { message: "Backing up database and persistent state" } });
      const backup = await createBackup(this.config.backup, this.runner, operation.id);
      await drain.assertReady();
      const previous = (await this.inspect()).currentRelease!;
      const journal = { originalEnv: await readFile(this.config.envFile, "utf8"), previous, backup };
      await atomicJson(journalPath, journal);
      await report({ status: "restarting", progress: { message: "Restarting platform services" } });
      await atomicJson(journalPath, { ...journal, phase: "committed" });
      try { await this.mustCompose(["restart", ...this.coreServices]); await this.verify(); }
      catch { throw new RecoveryRequiredError("Service restart verification failed; task scheduling remains paused"); }
      await atomicJson(journalPath, { ...journal, phase: "verified", result: previous });
      return previous;
    }
    if (operation.kind === "rollback") {
      const release = (await this.readRecentReleases()).find((item) => item.ref === operation.targetRef || item.version === operation.targetVersion);
      if (!release?.apiImage || !release.webImage) throw new Error("rollback release not found");
      return this.activate(release as ComposeManifest, operation, report, true, drain);
    }
    return this.activate(parseComposeManifest(operation.targetManifest), operation, report, false, drain);
  }

  private async activate(
    manifest: ComposeManifest,
    operation: MultiremiPlatformOperation,
    report: (input: ReportPlatformOperationInput) => Promise<void>,
    rollback: boolean,
    drain?: PlatformDrainGate,
  ): Promise<MultiremiPlatformRelease> {
    const previous = await this.readCurrentRelease();
    assertCompatible(previous, manifest);
    if (operation.targetVersion && manifest.version.replace(/^v/, "") !== operation.targetVersion.replace(/^v/, "")) throw new Error("Manifest version does not match requested version");
    const originalEnv = await readFile(this.config.envFile, "utf8");
    const stagedEnv = join(dirname(this.config.envFile), `.platform-stage-${process.pid}.env`);
    let committed = false;
    await report({ status: "pulling", previousRelease: previous, progress: { message: rollback ? `Restoring ${manifest.version}` : `Pulling ${manifest.version}` } });
    try {
      await this.writeImageEnv(originalEnv, manifest.apiImage, manifest.webImage, stagedEnv);
      const pulled = await this.compose(["pull", ...this.pullServices], stagedEnv);
      if (pulled.exitCode !== 0) throw new Error("Image pull failed; current services are unchanged");
      const targetSource = await this.runner.run("docker", ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--entrypoint", "cat", manifest.apiImage, ...DATA_SCHEMA_INPUTS.map((path) => `/app/${path}`)]);
      if (targetSource.exitCode !== 0 || migrationFingerprint(targetSource.stdout) !== manifest.dataSchema) throw new Error("Target image data schema does not match its manifest");
      // Images are staged; only the container switch needs a drained platform.
      // waitUntilDrained throws (with the drain already released) on timeout or
      // operator cancel, so the switch below never runs in those cases.
      await drain!.waitUntilDrained(report);
      await report({ status: "backing_up", progress: { message: "Backing up database and persistent state" } });
      const backup = await createBackup(this.config.backup, this.runner, operation.id);
      await drain!.assertReady();
      await mkdir(this.config.stateDir, { recursive: true });
      const journal = { originalEnv, previous, backup, target: manifest };
      await atomicJson(this.journalPath(operation.id), journal);
      await report({ status: "switching", previousRelease: previous, progress: { message: "Applying image digests" } });
      committed = true;
      await atomicJson(this.journalPath(operation.id), { ...journal, phase: "committed" });
      await this.writeImageEnv(originalEnv, manifest.apiImage, manifest.webImage);
      await this.removeRetiredSidecar();
      await this.mustCompose(["up", "-d", "--no-deps", "--pull", "never", ...this.coreServices]);
      // Do not call the control API between switching containers and verifying
      // them. A broken API image must not be able to block the local rollback.
      await this.verify();
      const release = toRelease(manifest);
      await this.writeRelease(release);
      await atomicJson(this.journalPath(operation.id), { originalEnv, previous, phase: "verified", result: release, backup });
      return release;
    } catch (error) {
      if (!committed) {
        await rm(this.journalPath(operation.id), { force: true });
        throw error;
      }
      if (previous?.apiImage && previous.webImage) {
        // Restore the host first. Reporting through the newly switched API can
        // fail for the same reason that triggered this rollback.
        try {
          await this.restoreEnvFile(originalEnv);
          await this.mustCompose(["up", "-d", "--no-deps", "--pull", "never", ...this.coreServices]);
          await this.verify();
          await this.writeRelease(previous);
          await atomicJson(this.journalPath(operation.id), { originalEnv, previous, phase: "rolled_back" });
        } catch { throw new RecoveryRequiredError("Update and rollback verification failed; backup retained and scheduling remains paused"); }
        await report({ status: "rolling_back", previousRelease: previous, error: errorMessage(error) });
      }
      throw error;
    } finally {
      await rm(stagedEnv, { force: true });
    }
  }

  private journalPath(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid operation ID");
    return join(this.config.stateDir, `operation-${id}.json`);
  }

  /**
   * Drop a leftover ingestion sidecar container.
   *
   * `docker compose` cannot address a service the file no longer declares, so
   * the container is found by the label Compose stamped on it. Best effort
   * throughout: on an installation that never ran ingestion both commands find
   * nothing, and a removal that fails surfaces as the switch failing right
   * after, which already rolls back.
   */
  private async removeRetiredSidecar(): Promise<void> {
    const config = await this.compose(["config", "--format", "json"]);
    if (config.exitCode !== 0) throw new Error("Cannot identify Compose project");
    const project: unknown = JSON.parse(config.stdout).name;
    if (typeof project !== "string" || !project) throw new Error("Compose project name is missing");
    const found = await this.runner.run("docker", [
      "ps", "-aq", "--filter", `label=com.docker.compose.service=${RETIRED_SIDECAR_SERVICE}`,
      "--filter", `label=com.docker.compose.project=${project}`,
    ]);
    if (found.exitCode !== 0) return;
    const ids = found.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    if (ids.length === 0) return;
    // Container only. Its data volumes are named and hold the operator's own
    // Feishu credential; deleting those is their call, not an upgrade's.
    await this.runner.run("docker", ["rm", "--force", ...ids]);
  }

  private async restoreEnvFile(originalEnv: string): Promise<void> {
    const temp = `${this.config.envFile}.tmp-${process.pid}`;
    await writeFile(temp, originalEnv, { mode: 0o600 });
    await rename(temp, this.config.envFile);
  }

  private async writeImageEnv(source: string, apiImage: string, webImage: string, envFile = this.config.envFile): Promise<void> {
    validateImage(apiImage);
    validateImage(webImage);
    const values = new Map<string, string>();
    const passthrough: string[] = [];
    for (const line of source.split("\n")) {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (match) values.set(match[1]!, match[2]!);
      else if (line) passthrough.push(line);
    }
    values.set("REMI_API_IMAGE", apiImage);
    values.set("REMI_WEB_IMAGE", webImage);
    const next = [...passthrough, ...[...values.entries()].map(([key, value]) => `${key}=${value}`), ""].join("\n");
    const temp = `${envFile}.tmp-${process.pid}`;
    await writeFile(temp, next, { mode: 0o600 });
    await rename(temp, envFile);
  }

  private async writeRelease(release: MultiremiPlatformRelease): Promise<void> {
    const releases = join(this.config.stateDir, "releases");
    await mkdir(releases, { recursive: true });
    await atomicJson(join(releases, `${safeFile(release.version)}.json`), release);
    await atomicJson(join(this.config.stateDir, "current-release.json"), release);
  }

  private async readCurrentRelease(): Promise<MultiremiPlatformRelease | null> {
    return readRelease(join(this.config.stateDir, "current-release.json"));
  }

  private async readRecentReleases(): Promise<MultiremiPlatformRelease[]> {
    const directory = join(this.config.stateDir, "releases");
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const paths = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map(async (entry) => {
      const path = join(directory, entry.name);
      return { path, modified: (await stat(path)).mtimeMs };
    }));
    const releases = await Promise.all(paths.sort((a, b) => b.modified - a.modified).slice(0, 10).map(({ path }) => readRelease(path)));
    return releases.filter((release): release is MultiremiPlatformRelease => release !== null);
  }

  private async inspectServices(): Promise<MultiremiPlatformService[]> {
    const result = await this.compose(["ps", "--format", "json"]);
    const rows = result.stdout.split("\n").filter(Boolean).flatMap((line) => {
      try { const parsed = JSON.parse(line); return Array.isArray(parsed) ? parsed : [parsed]; } catch { return []; }
    });
    // Deliberately the default list, not the configured one: the panel's id is a
    // closed union in the contracts package (`MultiremiPlatformServiceId`), so a
    // service the panel cannot name would be a type error and a contract change.
    // The switch, pull and restart lists above are what decides which containers
    // move; the panel keeps describing the three it has always described.
    const ids = [
      ...DEFAULT_CORE_SERVICES,
      "ssh-mesh-control-plane",
      "postgres", "openviking",
    ] as const satisfies readonly MultiremiPlatformService["id"][];
    return Promise.all(ids.map(async (id) => {
      const row = rows.find((item) => item.Service === id);
      if (!row && (id === "postgres" || id === "openviking")) {
        return this.inspectExternalDependency(id);
      }
      const state = String(row?.State ?? "unknown");
      return { id, name: serviceName(id), status: state === "running" ? "ready" : state === "unknown" ? "unknown" : "stopped", detail: row ? String(row.Status ?? state) : null, version: row ? String(row.Image ?? "") || null : null, checkedAt: new Date().toISOString() };
    }));
  }

  private async inspectExternalDependency(id: "postgres" | "openviking"): Promise<MultiremiPlatformService> {
    const container = id === "postgres" ? this.config.postgresContainer : this.config.openvikingContainer;
    if (!container) {
      return { id, name: serviceName(id), status: "unknown", detail: "External container is not configured", version: null, checkedAt: new Date().toISOString() };
    }
    const result = await this.runner.run("docker", ["inspect", "--format", "{{json .State}}|{{.Config.Image}}", container]);
    if (result.exitCode !== 0) {
      return { id, name: serviceName(id), status: "stopped", detail: result.stderr.trim() || "Container not found", version: null, checkedAt: new Date().toISOString() };
    }
    const [stateJson = "{}", image = ""] = result.stdout.trim().split("|", 2);
    let state: Record<string, unknown> = {};
    try { state = JSON.parse(stateJson) as Record<string, unknown>; } catch {}
    const health = state.Health && typeof state.Health === "object"
      ? String((state.Health as Record<string, unknown>).Status ?? "")
      : "";
    const running = state.Running === true;
    const status = running && (!health || health === "healthy") ? "ready" : running ? "degraded" : "stopped";
    return { id, name: serviceName(id), status, detail: health || String(state.Status ?? "unknown"), version: image || null, checkedAt: new Date().toISOString() };
  }

  private async verify(): Promise<void> {
    const urls = [this.config.apiHealthUrl, this.config.webHealthUrl, ...this.extraHealthUrls];
    await Promise.all(urls.map((url) => waitForHealthyUrl(url, this.healthTimeoutMs)));
  }

  private async validateStartupBudgets(): Promise<void> {
    let result;
    try {
      result = await this.compose(["config", "--format", "json"]);
    } catch {
      throw new Error(`docker compose config failed; fix ${this.config.composeFile} and its env files. See deploy/README.md#usage-accounting-startup-cutover.`);
    }
    // Do not include stdout, stderr or JSON parser errors: env_file is expanded.
    if (result.exitCode !== 0) {
      throw new Error(`docker compose config failed (exit ${result.exitCode}); fix ${this.config.composeFile} and its env files. See deploy/README.md#usage-accounting-startup-cutover.`);
    }
    let rendered: unknown;
    try { rendered = JSON.parse(result.stdout); } catch {
      throw new Error(`docker compose config returned invalid JSON; fix ${this.config.composeFile}. See deploy/README.md#usage-accounting-startup-cutover.`);
    }
    validateComposeStartupBudgets(rendered, {
      coreServices: this.coreServices,
      healthTimeoutMs: this.healthTimeoutMs,
      composeFile: this.config.composeFile,
    });
  }

  private async compose(args: string[], envFile = this.config.envFile) {
    return this.runner.run("docker", ["compose", ...(this.config.projectName ? ["--project-name", this.config.projectName] : []), "--env-file", envFile, "-f", this.config.composeFile, ...args], { cwd: dirname(this.config.composeFile) });
  }

  private async mustCompose(args: string[]): Promise<void> {
    const result = await this.compose(args);
    if (result.exitCode !== 0) throw new Error(`docker compose ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

/**
 * Parse a comma-separated env list. Blank entries are dropped so a trailing
 * comma in an env file cannot name an empty service, and an empty string means
 * "unset" rather than "no services" — switching nothing would silently stop
 * updating the host.
 */
function parseServiceList(value: string | undefined): readonly string[] | null {
  const entries = (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  return entries.length > 0 ? entries : null;
}

function parseComposeManifest(input: unknown): ComposeManifest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid release manifest");
  const value = input as Record<string, unknown>;
  for (const key of ["version", "ref", "apiImage", "webImage"] as const) {
    if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`manifest ${key} is required`);
  }
  if (!/^v?\d+\.\d+\.\d+$/.test(String(value.version))) throw new Error("manifest version must be SemVer");
  validateImage(String(value.apiImage)); validateImage(String(value.webImage));
  if (value.manifestUrl) assertHttpsUrl(String(value.manifestUrl), "manifest manifestUrl");
  return value as unknown as ComposeManifest;
}

function validateImage(value: string): void {
  if (!/^[a-z0-9][a-z0-9.:-]*\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/i.test(value)) throw new Error("image must be an immutable registry digest");
}

function assertHttpsUrl(value: string, label: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} is invalid`); }
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
}

function toRelease(value: ComposeManifest): MultiremiPlatformRelease {
  return { dataSchema: value.dataSchema ?? null, version: value.version, ref: value.ref, publishedAt: new Date().toISOString(), releaseUrl: value.releaseUrl ?? null, manifestUrl: value.manifestUrl ?? null, apiImage: value.apiImage, webImage: value.webImage };
}

async function readRelease(path: string): Promise<MultiremiPlatformRelease | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as MultiremiPlatformRelease; } catch { return null; }
}

function safeFile(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error("release version is invalid");
  return value;
}

function serviceName(id: MultiremiPlatformService["id"]): string {
  if (id === "api") return "API";
  if (id === "web") return "Web";
  if (id === "ssh-mesh-control-plane") return "SSH Mesh Control Plane";
  return id === "postgres" ? "PostgreSQL" : "OpenViking";
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
