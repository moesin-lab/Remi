import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { PlatformUpdaterClient } from "@remi-platform/updater/client.js";
import { DockerComposeDriver } from "@remi-platform/updater/compose-driver.js";
import { resolveDrainTimeoutMs } from "@remi-platform/updater/drain.js";
import { SystemdReleaseDriver } from "@remi-platform/updater/systemd-release-driver.js";
import { BunCommandRunner, type PlatformDeploymentDriver } from "@remi-platform/updater/types.js";
import type { BackupConfig } from "@remi-platform/updater/safety.js";
import { LocalProfileDriver } from "@remi-platform/updater/local-profile-driver.js";
import { LocalProfileOperationOutbox } from "@remi-platform/updater/operation-outbox.js";
import { PlatformUpdateWorker } from "@remi-platform/updater/worker.js";

const apiUrl = requiredEnv("MULTIREMI_API_URL");
const runner = new BunCommandRunner();
const client = new PlatformUpdaterClient(apiUrl, requiredEnv("MULTIREMI_TOKEN"), requiredEnv("MULTIREMI_PLATFORM_UPDATER_TOKEN"));
const stateDir = resolve(process.env.MULTIREMI_PLATFORM_STATE_DIR ?? join(homedir(), ".remi", "platform-updater"));
const backupFile = optionalEnv("MULTIREMI_PLATFORM_BACKUP_CONFIG");
const backup: BackupConfig | undefined = backupFile ? JSON.parse(await readFile(backupFile, "utf8")) : undefined;
const driver = createDriver();
const outbox = driver.kind === "local_profile"
  ? new LocalProfileOperationOutbox(join(requiredEnv("MULTIREMI_LOCAL_PROFILE_ROOT"), process.env.MULTIREMI_LOCAL_PROFILE_NAME ?? "stable"))
  : undefined;
const worker = new PlatformUpdateWorker(client, driver, optionalEnv("MULTIREMI_PLATFORM_RELEASE_FEED_URL"), resolveDrainTimeoutMs(process.env.MULTIREMI_PLATFORM_DRAIN_TIMEOUT_MS), outbox, driver instanceof LocalProfileDriver ? (id) => driver.finalize(id) : undefined);

// One local poller owns each state directory. Never evict an uncertain live PID.
await mkdir(stateDir, { recursive: true, mode: 0o700 });
const lockPath = join(stateDir, "updater.lock");
try {
  const existing = Number(await readFile(lockPath, "utf8"));
  if (!Number.isSafeInteger(existing) || existing <= 0) throw new Error("Invalid updater lock; inspect it before recovery");
  try { process.kill(existing, 0); throw new Error("Another updater owns this state directory"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  await unlink(lockPath);
} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const lock = await open(lockPath, "wx", 0o600);
await lock.writeFile(String(process.pid));
await lock.sync();
console.info(`Multiremi platform updater: ${driver.kind} on ${process.platform}/${process.arch}`);
try {
  for (;;) {
    try { await worker.tick(); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
    await Bun.sleep(Math.max(1_000, Number(process.env.MULTIREMI_PLATFORM_UPDATER_POLL_MS) || 5_000));
  }
} finally { await lock.close(); await unlink(lockPath); }

function createDriver(): PlatformDeploymentDriver {
  const kind = process.env.MULTIREMI_PLATFORM_DRIVER ?? "docker_compose";
  const common = {
    backup,
    apiHealthUrl: process.env.MULTIREMI_PLATFORM_API_HEALTH_URL ?? `${apiUrl.replace(/\/$/, "")}/readyz`,
    webHealthUrl: process.env.MULTIREMI_PLATFORM_WEB_HEALTH_URL ?? "http://127.0.0.1:3000/login",
  };
  if (kind === "docker_compose") return new DockerComposeDriver({
    ...common,
    composeFile: resolve(requiredEnv("MULTIREMI_PLATFORM_COMPOSE_FILE")),
    envFile: resolve(requiredEnv("MULTIREMI_PLATFORM_COMPOSE_ENV_FILE")),
    stateDir,
    projectName: optionalEnv("MULTIREMI_PLATFORM_COMPOSE_PROJECT") ?? undefined,
    postgresContainer: optionalEnv("MULTIREMI_PLATFORM_POSTGRES_CONTAINER"),
    openvikingContainer: optionalEnv("MULTIREMI_PLATFORM_OPENVIKING_CONTAINER"),
  }, runner);
  if (kind === "local_profile") return new LocalProfileDriver({
    repository: requiredEnv("MULTIREMI_LOCAL_PROFILE_REPOSITORY"),
    profilesRoot: requiredEnv("MULTIREMI_LOCAL_PROFILE_ROOT"),
    profile: process.env.MULTIREMI_LOCAL_PROFILE_NAME ?? "stable",
    nodeExecutable: requiredEnv("MULTIREMI_PLATFORM_NODE"),
    expectedArchitecture: process.env.MULTIREMI_PLATFORM_ARCH ?? process.arch,
    minimumFreeBytes: Math.max(1, Number(process.env.MULTIREMI_PLATFORM_MIN_FREE_BYTES) || 5 * 1024 * 1024 * 1024),
  }, runner);
  if (kind !== "systemd_release") throw new Error(`Unsupported platform driver: ${kind}`);
  return new SystemdReleaseDriver({
    ...common,
    root: process.env.MULTIREMI_PLATFORM_ROOT ?? "/opt/multiremi-platform",
    apiService: process.env.MULTIREMI_PLATFORM_API_SERVICE ?? "remi-platform-api.service",
    webService: process.env.MULTIREMI_PLATFORM_WEB_SERVICE ?? "remi-platform-web.service",
    bunExecutable: process.env.MULTIREMI_PLATFORM_BUN ?? process.execPath,
  }, runner);
}

function requiredEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function optionalEnv(name: string): string | null { return process.env[name]?.trim() || null; }
