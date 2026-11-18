import { currentBackgroundTerm } from "../db/live-term.js";
import { AsyncLocalStorage } from "node:async_hooks";

export type DbSourceKind = "http" | "ws" | "job";
export type DbJobName = "scheduler.sync" | "scheduler.failure-monitor" | "scheduler.issue-archive"
  | "scheduler.autopilot" | "scm.poll" | "issue-title.poll" | "messaging.sync"
  | "notifications.sweep" | "notifications.retry" | "capability.sweep" | "body-html.backfill"
  | "daemon.offer" | "repository-wiki.lease" | "repository-wiki.storage";
export interface DbSourceSummary {
  kind: DbSourceKind;
  name: string;
  /** Invocations started or issuing SQL in this window (including carry-over). */
  count: number;
  db_queries: number;
  queries_per_invocation: number;
  db_ms: number;
}
interface Invocation { kind: DbSourceKind; name: string; epoch: number }
const context = new AsyncLocalStorage<Invocation>();
let enabled = false;
let epoch = 0;
const groups = new Map<string, Omit<DbSourceSummary, "queries_per_invocation">>();

export function configureDbSources(value: boolean): void {
  enabled = value;
  if (!value) resetDbSourceWindow();
}
export function resetDbSourceWindow(): void { groups.clear(); epoch++; }

function groupFor(source: Invocation) {
  let key = `${source.kind} ${source.name}`;
  // Names come from route patterns, validated frame types or fixed job constants.
  // Still bound cardinality independently of the request ring and traffic volume.
  if (!groups.has(key) && groups.size >= 512) key = `${source.kind} <overflow>`;
  let group = groups.get(key);
  if (!group) {
    group = { kind: source.kind, name: key.slice(source.kind.length + 1), count: 0, db_queries: 0, db_ms: 0 };
    groups.set(key, group);
  }
  if (source.epoch !== epoch) { source.epoch = epoch; group.count++; }
  return group;
}

/** Names must be constants or already sanitized route/frame patterns. Never IDs. */
export function withDbSource<T>(kind: DbSourceKind, name: string, action: () => T): T {
  if (!enabled) return action();
  const source: Invocation = { kind, name, epoch: -1 };
  groupFor(source);
  return context.run(source, action);
}
export function withDbJob<T>(name: DbJobName, action: () => T): T {
  currentBackgroundTerm()?.assertCurrent();
  return withDbSource("job", name, action);
}

/** Called once at SQL completion, so all categories share the process window. */
export function recordDbSourceQuery(dbMs: number): DbSourceKind | undefined {
  if (!enabled) return undefined;
  const source = context.getStore();
  if (!source) return undefined;
  const group = groupFor(source);
  group.db_queries++;
  group.db_ms += dbMs;
  return source.kind;
}

export function drainDbSources(top: number) {
  const rows: DbSourceSummary[] = [...groups.values()].map(group => ({ ...group,
    db_ms: Math.round(group.db_ms * 10) / 10,
    queries_per_invocation: Math.round(group.db_queries / group.count * 100) / 100,
  }));
  const totals = { http: 0, ws: 0, job: 0 };
  for (const row of rows) totals[row.kind] += row.db_queries;
  rows.sort((a, b) => b.db_queries - a.db_queries || b.db_ms - a.db_ms
    || `${a.kind} ${a.name}`.localeCompare(`${b.kind} ${b.name}`));
  resetDbSourceWindow();
  return { db_sources: rows.slice(0, Math.max(0, Math.trunc(top))), db_attributed: totals };
}
