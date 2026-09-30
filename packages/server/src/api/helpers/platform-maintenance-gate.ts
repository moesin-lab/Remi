import type { MiddlewareHandler } from "hono";
import type { MultiremiPlatformOperationStatus } from "@multiremi/contracts/types.js";
import type { MultiremiStore } from "@multiremi/store/store.js";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const SWITCH_STATUSES = new Set<MultiremiPlatformOperationStatus>([
  "switching", "restarting", "verifying", "rolling_back",
]);

/**
 * A restarted API is reachable before the host has verified the matching Web.
 * Keep business writes closed until that host commits or recovers the update,
 * so restoring the pre-switch database cannot discard acknowledged writes.
 * Preparation/draining remains writable: in-flight tasks must finish normally.
 */
export function createPlatformMaintenanceWriteGate(
  store: Pick<MultiremiStore, "getPlatformMaintenance" | "getActivePlatformOperation">,
): MiddlewareHandler {
  return async (c, next) => {
    // The host must be able to renew, report and reconcile after an API restart
    // or database restore. These routes retain their normal API + updater auth.
    if (READ_METHODS.has(c.req.method) || c.req.path.startsWith("/api/platform-updater/")) {
      await next();
      return;
    }
    // Most requests have no active update. Avoid maintenance's lazy lease
    // cleanup/row initialization on that normal path (including heartbeats).
    const operation = store.getActivePlatformOperation();
    const maintenance = operation && SWITCH_STATUSES.has(operation.status)
      ? store.getPlatformMaintenance()
      : null;
    if (operation && maintenance?.mode === "draining" && maintenance.operationId === operation.id) {
      c.header("Retry-After", "5");
      c.header("Cache-Control", "no-store");
      return c.json({
        error: "Platform update in progress; writes resume after API and Web verification or recovery",
        code: "platform_update_in_progress",
        operation_id: operation.id,
      }, 503);
    }
    await next();
  };
}
