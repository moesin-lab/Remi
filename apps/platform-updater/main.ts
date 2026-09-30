import type { MultiremiPlatformOperation, MultiremiPlatformRelease } from "@multiremi/contracts";
import { PlatformUpdaterClient } from "@remi-platform/updater/client.js";
import { DockerComposeDriver } from "@remi-platform/updater/compose-driver.js";
import {
  DrainCancelledError,
  PlatformDrainCoordinator,
  resolveDrainTimeoutMs,
} from "@remi-platform/updater/drain.js";
import { fetchReleaseFeed } from "@remi-platform/updater/release-feed.js";
import { LocalProfileDriver } from "@remi-platform/updater/local-profile-driver.js";
import { SystemdReleaseDriver } from "@remi-platform/updater/systemd-release-driver.js";
import { BunCommandRunner, type PlatformDeploymentDriver } from "@remi-platform/updater/types.js";
import { LocalProfileOperationOutbox } from "@remi-platform/updater/operation-outbox.js";
import { join } from "node:path";

const apiUrl = requiredEnv("MULTIREMI_API_URL");
const apiToken = requiredEnv("MULTIREMI_TOKEN");
const updaterToken = requiredEnv("MULTIREMI_PLATFORM_UPDATER_TOKEN");
const releaseFeedUrl = optionalEnv("MULTIREMI_PLATFORM_RELEASE_FEED_URL");
const pollMs = positiveNumber(process.env.MULTIREMI_PLATFORM_UPDATER_POLL_MS, 5_000);
const drainTimeoutMs = resolveDrainTimeoutMs(process.env.MULTIREMI_PLATFORM_DRAIN_TIMEOUT_MS);
const runner = new BunCommandRunner();
const client = new PlatformUpdaterClient(apiUrl, apiToken, updaterToken);
const driver = createDriver();
const outbox = driver.kind === "local_profile"
  ? new LocalProfileOperationOutbox(join(requiredEnv("MULTIREMI_LOCAL_PROFILE_ROOT"), process.env.MULTIREMI_LOCAL_PROFILE_NAME ?? "stable"))
  : null;
let latestRelease: MultiremiPlatformRelease | null = null;
let lastFeedCheck = 0;

console.info(`Multiremi platform updater started with ${driver.kind} driver`);

while (true) {
  try {
    // The API can be down, or its database can have been restored to an older
    // snapshot. Recover locally and reconcile durable outcomes BEFORE claiming.
    const inspection = await driver.inspect();
    if (outbox) await outbox.reconcile(client, finalizeHostOperation);
    if (Date.now() - lastFeedCheck > 300_000 || lastFeedCheck === 0) {
      lastFeedCheck = Date.now();
      try {
        latestRelease = await fetchReleaseFeed(releaseFeedUrl);
      } catch (error) {
        // Release discovery must not block host recovery, heartbeats or an
        // explicitly requested operation when a feed is absent/unavailable.
        console.error(`release feed unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await client.heartbeat(inspection, latestRelease);
    const operation = await client.claim();
    if (operation) await execute(operation);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }
  await Bun.sleep(pollMs);
}

async function execute(operation: MultiremiPlatformOperation): Promise<void> {
  // Only container/service switches need a drained platform. The coordinator
  // renews a server-side lease during draining. Once switching starts, the
  // server keeps the gate closed until a verified terminal receipt arrives.
  const drain = operation.kind === "update" || operation.kind === "rollback"
    ? new PlatformDrainCoordinator(client, operation.id, {
        timeoutMs: drainTimeoutMs,
        reason: operation.kind === "rollback"
          ? `platform rollback to ${operation.targetVersion ?? operation.targetRef ?? "previous release"}`
          : `platform update to ${operation.targetVersion ?? "new release"}`,
      })
    : null;
  const durable = drain ? outbox : null;
  // Persist the exact API envelope, before manifest resolution or any service
  // mutation, so restoring a database cannot erase this request's identity.
  if (durable) await durable.remember(operation);
  let terminal: import("@multiremi/contracts").ReportPlatformOperationInput;
  try {
    if (operation.kind === "check_updates") {
      latestRelease = await fetchReleaseFeed(releaseFeedUrl);
      lastFeedCheck = Date.now();
    }
    const resolved = await resolveManifest(operation);
    const resultRelease = await driver.execute(
      resolved,
      (input) => client.report(operation.id, input),
      drain ?? undefined,
    );
    terminal = {
      status: operation.kind === "rollback" ? "rolled_back" : "succeeded",
      resultRelease,
      progress: { message: operation.kind === "check_updates" ? "Release information refreshed" : "Operation completed" },
    };
  } catch (error) {
    terminal = {
      status: error instanceof DrainCancelledError ? "cancelled" : "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  // A reporting outage must never turn a successful switch into a failed
  // deployment. Incomplete recovery throws here and keeps maintenance held.
  if (durable) {
    await durable.complete(operation.id, terminal);
    await durable.reconcile(client, finalizeHostOperation);
  } else {
    await client.report(operation.id, terminal);
  }
  if (drain) await drain.release();
  await client.heartbeat(await driver.inspect(), latestRelease);
}

async function finalizeHostOperation(operationId: string): Promise<void> {
  if (driver instanceof LocalProfileDriver) await driver.finalize(operationId);
}

async function resolveManifest(operation: MultiremiPlatformOperation): Promise<MultiremiPlatformOperation> {
  if (operation.kind !== "update" || Object.keys(operation.targetManifest).length > 0) return operation;
  const manifestUrl = operation.targetRef ?? latestRelease?.manifestUrl;
  if (!manifestUrl) throw new Error("update operation has no deployment manifest URL");
  assertHttpsUrl(manifestUrl, "deployment manifest URL");
  const response = await fetch(manifestUrl, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`deployment manifest returned ${response.status}`);
  const manifest = await response.json();
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("deployment manifest is invalid");
  return { ...operation, targetManifest: manifest as Record<string, unknown> };
}

function assertHttpsUrl(value: string, label: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} is invalid`); }
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
}

function createDriver(): PlatformDeploymentDriver {
  const kind = process.env.MULTIREMI_PLATFORM_DRIVER ?? "systemd_release";
  if (kind === "docker_compose") {
    return new DockerComposeDriver({
      composeFile: requiredEnv("MULTIREMI_PLATFORM_COMPOSE_FILE"),
      envFile: requiredEnv("MULTIREMI_PLATFORM_COMPOSE_ENV_FILE"),
      stateDir: process.env.MULTIREMI_PLATFORM_STATE_DIR ?? "/var/lib/multiremi-platform-updater",
      apiHealthUrl: process.env.MULTIREMI_PLATFORM_API_HEALTH_URL ?? `${apiUrl.replace(/\/$/, "")}/readyz`,
      webHealthUrl: process.env.MULTIREMI_PLATFORM_WEB_HEALTH_URL ?? "http://127.0.0.1:3000/login",
      postgresContainer: optionalEnv("MULTIREMI_PLATFORM_POSTGRES_CONTAINER"),
      openvikingContainer: optionalEnv("MULTIREMI_PLATFORM_OPENVIKING_CONTAINER"),
    }, runner);
  }
  if (kind === "local_profile") {
    return new LocalProfileDriver({
      repository: requiredEnv("MULTIREMI_LOCAL_PROFILE_REPOSITORY"),
      profilesRoot: requiredEnv("MULTIREMI_LOCAL_PROFILE_ROOT"),
      profile: process.env.MULTIREMI_LOCAL_PROFILE_NAME ?? "stable",
      nodeExecutable: requiredEnv("MULTIREMI_PLATFORM_NODE"),
      expectedArchitecture: process.env.MULTIREMI_PLATFORM_ARCH ?? process.arch,
      minimumFreeBytes: positiveNumber(process.env.MULTIREMI_PLATFORM_MIN_FREE_BYTES, 5 * 1024 * 1024 * 1024),
    }, runner);
  }
  if (kind !== "systemd_release") throw new Error(`Unsupported platform driver: ${kind}`);
  return new SystemdReleaseDriver({
    root: process.env.MULTIREMI_PLATFORM_ROOT ?? "/opt/multiremi-platform",
    apiService: process.env.MULTIREMI_PLATFORM_API_SERVICE ?? "remi-platform-api.service",
    webService: process.env.MULTIREMI_PLATFORM_WEB_SERVICE ?? "remi-platform-web.service",
    apiHealthUrl: process.env.MULTIREMI_PLATFORM_API_HEALTH_URL ?? `${apiUrl.replace(/\/$/, "")}/readyz`,
    webHealthUrl: process.env.MULTIREMI_PLATFORM_WEB_HEALTH_URL ?? "http://127.0.0.1:3000/login",
    bunExecutable: process.env.MULTIREMI_PLATFORM_BUN ?? "/usr/local/bin/bun",
  }, runner);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalEnv(name: string): string | null {
  return process.env[name]?.trim() || null;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
