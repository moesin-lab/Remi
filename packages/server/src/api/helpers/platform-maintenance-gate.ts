import type { MiddlewareHandler } from "hono";
import type { MultiremiStore } from "@multiremi/store/store.js";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * A restarted API is reachable before the host has verified the matching Web.
 * Keep business writes closed until that host commits or recovers the update,
 * so restoring the pre-switch database cannot discard acknowledged writes.
 * Preparation/draining remains writable: in-flight tasks must finish normally.
 */
export function createPlatformMaintenanceWriteGate(
  store: Pick<MultiremiStore, "getPlatformWriteBlockingOperationId">,
): MiddlewareHandler {
  return async (c, next) => {
    // The host must be able to renew, report and reconcile after an API restart
    // or database restore. These routes retain their normal API + updater auth.
    if (READ_METHODS.has(c.req.method) || c.req.path.startsWith("/api/platform-updater/")) {
      await next();
      return;
    }
    // Read current shared state on every mutation, including daemon messages.
    // Caching an "open" answer could admit writes after another API process
    // starts switching. Only the operation id crosses the database bridge.
    const operationId = store.getPlatformWriteBlockingOperationId();
    if (operationId) {
      c.header("Retry-After", "5");
      c.header("Cache-Control", "no-store");
      return c.json({
        error: "Platform update in progress; writes resume after API and Web verification or recovery",
        code: "platform_update_in_progress",
        operation_id: operationId,
      }, 503);
    }
    await next();
  };
}
