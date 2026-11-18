import { AsyncLocalStorage } from "node:async_hooks";

/** Immutable activation context, inherited by timers and async continuations. */
export interface BackgroundTerm {
  assertCurrent(): void;
  guard<T>(action: () => T): T;
}
const context = new AsyncLocalStorage<BackgroundTerm | undefined>();
export const currentBackgroundTerm = () => context.getStore();
export function withBackgroundTerm<T>(term: BackgroundTerm | undefined, action: () => T): T {
  return context.run(term, action);
}
export class StaleLiveTermError extends Error {
  constructor() { super("Background jobs lost their live term; activate again to resume"); }
}
