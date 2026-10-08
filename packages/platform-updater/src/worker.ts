import type { MultiremiPlatformOperation, MultiremiPlatformRelease } from "@multiremi/contracts";
import type { PlatformUpdaterClient } from "./client.js";
import { DrainCancelledError, PlatformDrainCoordinator } from "./drain.js";
import { parseReleaseFeed, fetchReleaseJson, unwrapReleaseManifest } from "./release-feed.js";
import { releaseCapabilities } from "./release-capabilities.js";
import { assertCompatible, RecoveryRequiredError } from "./safety.js";
import type { PlatformDeploymentDriver } from "./types.js";
import type { LocalProfileOperationOutbox } from "./operation-outbox.js";

export class PlatformUpdateWorker {
  private latest: MultiremiPlatformRelease | null = null;
  private feedUrl: string | null = null;
  private sourceOverride: string | null = null;
  private checkedAt = 0;

  constructor(private readonly client: PlatformUpdaterClient, private readonly driver: PlatformDeploymentDriver, private readonly defaultFeedUrl: string | null, private readonly drainTimeoutMs = 0, private readonly outbox?: LocalProfileOperationOutbox, private readonly finalize?: (id: string) => Promise<void>) {}

  async tick(): Promise<void> {
    await this.driver.recoverInterrupted?.();
    const inspection = await this.driver.inspect();
    // A database restore can resurrect requests; reconcile durable host outcomes before claiming.
    await this.outbox?.reconcile(this.client, this.finalize);
    const pending = await this.driver.pendingFinalization?.();
    if (pending) {
      await this.client.report(pending.operationId, pending.report);
      await this.client.drainRelease(pending.operationId);
      await this.driver.finalize?.(pending.operationId);
    }
    // Always heartbeat and consume settings even when the feed is unreachable.
    const settings = await this.client.heartbeat(inspection, undefined, { defaultReleaseFeedUrl: this.defaultFeedUrl });
    const nextFeed = settings.releaseFeedUrl ?? this.defaultFeedUrl;
    if (nextFeed !== this.feedUrl) { this.checkedAt = 0; this.latest = null; }
    this.sourceOverride = settings.releaseFeedUrl;
    this.feedUrl = settings.releaseFeedUrl ?? this.defaultFeedUrl;
    if (!this.checkedAt || Date.now() - this.checkedAt > 300_000) await this.check();
    const operation = await this.client.claim();
    if (operation) await this.execute(operation);
  }

  private async check(): Promise<void> {
    this.checkedAt = Date.now();
    const preflight = await this.driver.preflight();
    preflight.source = this.feedUrl ? { url: this.feedUrl, manifestUrl: null, modes: [], error: null } : null;
    try {
      this.latest = null;
      if (!this.feedUrl) throw new Error("Configure a release feed URL in Web settings");
      const feed = await fetchReleaseJson(this.feedUrl);
      this.latest = parseReleaseFeed(feed, this.feedUrl);
      const manifestUrl = this.latest.manifestUrl ?? this.feedUrl;
      const manifest = unwrapReleaseManifest(manifestUrl === this.feedUrl ? feed : await fetchReleaseJson(manifestUrl));
      if (manifest.ref !== this.latest.ref || String(manifest.version).replace(/^v/, '') !== this.latest.version.replace(/^v/, '')) {
        throw new Error('Release feed and manifest identities differ; check updates again');
      }
      preflight.source = { url: this.feedUrl, manifestUrl, modes: releaseCapabilities(manifest, preflight.arch, this.driver.kind), error: null };
      preflight.checks.push({ code: "release_feed", ok: true, message: "Release feed is reachable" });
      const artifacts = preflight.source.modes.find(item => item.mode === this.driver.updateMode);
      if (artifacts) preflight.checks.push({ code: 'release_artifacts', ok: artifacts.available,
        message: artifacts.available ? 'Release contains the artifacts for the active update mode'
          : `Release is missing or has invalid artifacts for ${artifacts.mode}: ${artifacts.missing.join(', ')}` });
      if (this.driver.validateRelease) {
        await this.driver.validateRelease(manifest);
      } else assertCompatible((await this.driver.inspect()).currentRelease, this.latest ?? {});
      preflight.checks.push({ code: "data_schema", ok: true, message: "Release data schema is compatible" });
    } catch (error) {
      if (preflight.source && preflight.source.modes.length === 0) preflight.source.error = error instanceof Error ? error.message : String(error);
      preflight.checks.push({ code: "release_feed_or_schema", ok: false, message: error instanceof Error ? error.message : String(error) });
    }
    preflight.ready = preflight.checks.every((check) => check.ok);
    await this.client.heartbeat(await this.driver.inspect(), this.latest, { releaseFeedUrl: this.sourceOverride, preflight });
  }

  private async execute(operation: MultiremiPlatformOperation): Promise<void> {
    // A differently configured updater cannot decide that another driver's
    // committed operation failed and release its maintenance gate.
    // An initial check may be queued before the host's first heartbeat has
    // registered its driver. Checks are read-only and must unblock that setup.
    if (operation.kind !== "check_updates" && operation.driver !== this.driver.kind) throw new Error("Operation driver does not match this updater; operation left untouched");
    const drain = operation.kind === "check_updates" ? null : new PlatformDrainCoordinator(this.client, operation.id, {
      timeoutMs: this.drainTimeoutMs,
      reason: `platform ${operation.kind} ${operation.targetVersion ?? ""}`.trim(),
    });
    let releaseDrain = false;
    const durable = operation.kind === "update" || operation.kind === "rollback" ? this.outbox : undefined;
    if (durable) await durable.remember(operation);
    const finish = async (report: import("@multiremi/contracts").ReportPlatformOperationInput) => {
      if (durable) {
        await durable.complete(operation.id, report);
        await durable.reconcile(this.client, this.finalize);
      } else await this.client.report(operation.id, report);
    };
    try {
      let result: MultiremiPlatformRelease | null;
      try {
        if (operation.kind === "check_updates") await this.check();
        const resolved = await this.resolveManifest(operation);
        result = await this.driver.execute(resolved, (input) => this.client.report(operation.id, input), drain ?? undefined);
      } catch (error) {
        if (error instanceof RecoveryRequiredError) {
          await this.client.report(operation.id, { status: "verifying", error: error.message, progress: { message: error.message, recoveryRequired: true } });
          return;
        }
        await finish({
          status: error instanceof DrainCancelledError ? "cancelled" : "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        releaseDrain = true;
        return;
      }
      // Reporting failure is not a failed deployment: leave the operation for
      // a later tick to deliver the journaled result, with maintenance held.
      await finish({
        status: operation.kind === "rollback" ? "rolled_back" : "succeeded",
        resultRelease: result,
        progress: { message: operation.kind === "check_updates" ? "Update checks completed; review preflight results" : "Operation verified" },
      });
      releaseDrain = true;
    } finally {
      drain?.stopKeeper();
      if (releaseDrain && drain) {
        await drain.release();
        await this.driver.finalize?.(operation.id);
      }
    }
  }

  private async resolveManifest(operation: MultiremiPlatformOperation): Promise<MultiremiPlatformOperation> {
    if (["switching", "restarting", "verifying", "rolling_back"].includes(operation.status)) return operation;
    if (operation.kind !== "update" || Object.keys(operation.targetManifest).length > 0) return operation;
    const targetIsUrl = operation.targetRef?.startsWith("https://");
    if (operation.targetRef && !targetIsUrl && operation.targetRef !== this.latest?.ref) {
      throw new Error("Requested release is no longer advertised; check updates again or provide its manifest URL");
    }
    const url = targetIsUrl ? operation.targetRef : this.latest?.manifestUrl;
    if (!url) throw new Error("Update has no manifest URL");
    const manifest = unwrapReleaseManifest(await fetchReleaseJson(url));
    if (operation.targetVersion && operation.targetVersion.replace(/^v/, "") !== String(manifest.version).replace(/^v/, "")) {
      throw new Error("Requested version does not match the release manifest; check updates again");
    }
    const expectedRef = !targetIsUrl ? operation.targetRef : url === this.latest?.manifestUrl ? this.latest.ref : null;
    if (expectedRef && expectedRef !== manifest.ref) throw new Error("Requested release ref does not match the manifest; check updates again");
    return { ...operation, targetManifest: manifest };
  }
}
