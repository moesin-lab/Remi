import type { MultiremiPlatformOperation, MultiremiPlatformRelease } from "@multiremi/contracts";
import type { PlatformUpdaterClient } from "./client.js";
import { DrainCancelledError, PlatformDrainCoordinator } from "./drain.js";
import { fetchReleaseFeed, fetchReleaseJson } from "./release-feed.js";
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
    try {
      this.latest = null;
      if (!this.feedUrl) throw new Error("Configure a release feed URL in Web settings");
      this.latest = await fetchReleaseFeed(this.feedUrl);
      preflight.checks.push({ code: "release_feed", ok: true, message: "Release feed is reachable" });
      assertCompatible((await this.driver.inspect()).currentRelease, this.latest ?? {});
      preflight.checks.push({ code: "data_schema", ok: true, message: "Release data schema is compatible" });
    } catch (error) {
      preflight.checks.push({ code: "release_feed_or_schema", ok: false, message: error instanceof Error ? error.message : String(error) });
    }
    preflight.ready = preflight.checks.every((check) => check.ok);
    await this.client.heartbeat(await this.driver.inspect(), this.latest, { releaseFeedUrl: this.sourceOverride, preflight });
  }

  private async execute(operation: MultiremiPlatformOperation): Promise<void> {
    // A differently configured updater cannot decide that another driver's
    // committed operation failed and release its maintenance gate.
    if (operation.driver !== this.driver.kind) throw new Error("Operation driver does not match this updater; operation left untouched");
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
      if (releaseDrain && drain) await drain.release();
    }
  }

  private async resolveManifest(operation: MultiremiPlatformOperation): Promise<MultiremiPlatformOperation> {
    if (["switching", "restarting", "verifying", "rolling_back"].includes(operation.status)) return operation;
    if (operation.kind !== "update" || Object.keys(operation.targetManifest).length > 0) return operation;
    const url = operation.targetRef ?? this.latest?.manifestUrl;
    if (!url) throw new Error("Update has no manifest URL");
    const manifest = await fetchReleaseJson(url);
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Invalid deployment manifest");
    return { ...operation, targetManifest: manifest as Record<string, unknown> };
  }
}
