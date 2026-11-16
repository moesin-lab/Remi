import { create } from "zustand";

/** Transient transport state, never persisted or mixed with server query data. */
export const useContinuityStore = create<{ switching: boolean; pendingWrites: number; heldSends: number }>(() => ({
  switching: false, pendingWrites: 0, heldSends: 0,
}));

export const MAINTENANCE_RETRY_LIMIT_MS = 10 * 60_000;

// A send timeout excludes retry backoff, but still bounds each active request.
const budgets = new WeakMap<AbortSignal, { waited: number }>();
export function maintenanceBudget(signal?: AbortSignal | null): { waited: number } {
  if (!signal) return { waited: 0 };
  let budget = budgets.get(signal);
  if (!budget) { budget = { waited: 0 }; budgets.set(signal, budget); }
  return budget;
}
const pauses = new WeakMap<AbortSignal, () => () => void>();
export function registerSendPause(signal: AbortSignal, pause: () => () => void) {
  pauses.set(signal, pause);
  return () => pauses.delete(signal);
}
export function pauseSendTimeout(signal?: AbortSignal | null): () => void {
  return signal ? pauses.get(signal)?.() ?? (() => {}) : () => {};
}

export function retryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : null;
}

export function abortableDelay(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}
