/**
 * Loaded by the host with `bun run --preload /remi-host/host-write-fence.ts ...`.
 * This lives outside the image so even an older API obeys the host's persistent
 * write fence while API + Web are being verified or restored. Do not import it
 * from application/test code: installing the Bun.serve wrapper is intentional.
 */
import { readFileSync } from "node:fs";

const fenceFile = process.env.MULTIREMI_HOST_WRITE_FENCE_FILE ?? "/remi-host/write-fence.json";
const readMethods = new Set(["GET", "HEAD", "OPTIONS"]);
const originalServe = Bun.serve;

function fenceResponse(request: Request): Response | null {
  if (readMethods.has(request.method) || new URL(request.url).pathname.startsWith("/api/platform-updater/")) {
    return null;
  }
  let operationId: string | null = null;
  try {
    const marker = JSON.parse(readFileSync(fenceFile, "utf8")) as unknown;
    if (marker && typeof marker === "object" && "operationId" in marker && typeof marker.operationId === "string") {
      operationId = marker.operationId;
    }
  } catch (error) {
    // Only a missing file releases the fence. An unreadable/partial/corrupt
    // marker must not admit writes that a subsequent DB restore would discard.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
  }
  return Response.json({
    error: "Platform update in progress; writes resume after API and Web verification or recovery",
    code: "platform_update_in_progress",
    operation_id: operationId,
  }, {
    status: 503,
    headers: {
      "Retry-After": "5",
      "Cache-Control": "no-store",
      // Match the API's existing cors() default even before its fetch handler.
      "Access-Control-Allow-Origin": "*",
    },
  });
}

Bun.serve = ((options: Parameters<typeof Bun.serve>[0]) => {
  const originalFetch = options.fetch;
  // Remi's API uses a single fetch handler. Native routes would bypass that
  // handler; refuse an unsupported entrypoint instead of silently losing it.
  if (typeof originalFetch !== "function" || options.routes || "static" in options) {
    throw new Error("Host write fence requires a Bun.serve fetch handler without native routes");
  }
  return originalServe({
    ...options,
    fetch(this: Bun.Server<unknown>, request: Request, server: Bun.Server<unknown>) {
      return fenceResponse(request) ?? originalFetch.call(this, request, server);
    },
  } as typeof options);
}) as typeof Bun.serve;
