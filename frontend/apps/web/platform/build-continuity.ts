import { z } from "zod";
import { parseStrictResponse } from "@multiremi/core/api/schema";
import { useContinuityStore } from "@multiremi/core/platform-lifecycle";
import { useChatStore } from "@multiremi/core/chat";

export const BUILD_PATH = "/health/build";
export const CURRENT_BUILD = process.env.NEXT_PUBLIC_REMI_WEB_BUILD_ID ?? "dev";
const BuildSchema = z.object({ build_id: z.string().min(1) });
let availableBuild = CURRENT_BUILD;
let inFlight: Promise<boolean> | undefined;

export function canRefresh(): boolean {
  const state = useContinuityStore.getState();
  const chat = useChatStore.getState?.();
  return state.pendingWrites === 0 && state.heldSends === 0 &&
    !Object.values(chat?.queueOutbox ?? {}).some(rows => rows.length > 0) &&
    !Object.values(chat?.inputDrafts ?? {}).some(Boolean) &&
    !Object.values(chat?.inputDraftAttachments ?? {}).some(items => Object.keys(items).length > 0) &&
    !document.querySelector('[contenteditable="true"]:focus, input:focus, textarea:focus');
}
export function checkBuild(): Promise<boolean> {
  if (!inFlight) {
    inFlight = fetch(BUILD_PATH, { cache: "no-store", signal: AbortSignal.timeout(1500) }).then(async response => {
      if (!response.ok) return false;
      const result = parseStrictResponse<{ build_id: string }>(await response.json(), BuildSchema, { endpoint: BUILD_PATH });
      availableBuild = result.build_id;
      return availableBuild !== CURRENT_BUILD;
    }).catch(() => false).finally(() => { inFlight = undefined; });
  }
  return inFlight;
}
export function hasBuildDrift() { return availableBuild !== CURRENT_BUILD; }

/** One recovery per source build per tab. A second failure stays visible. */
export function recoverChunk(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (!/ChunkLoadError|Loading chunk .+ failed|Failed to fetch dynamically imported module|Importing a module script failed/i.test(message) || !canRefresh()) return false;
  try {
    const key = `remi:chunk-recovery:${CURRENT_BUILD}`;
    if (sessionStorage.getItem(key)) return false;
    sessionStorage.setItem(key, "1");
    window.location.reload();
    return true;
  } catch { return false; }
}
