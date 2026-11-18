import { currentBackgroundTerm, StaleLiveTermError, withBackgroundTerm, type BackgroundTerm } from "@shared/db/live-term.js";
import type { SqlDatabase, SqlStatement } from "./db/postgres.js";

export const LIVE_TERM_SCHEMA = `CREATE TABLE IF NOT EXISTS multiremi_live_terms (
  scope TEXT PRIMARY KEY, term BIGINT NOT NULL, holder TEXT, updated_at TEXT NOT NULL
)`;

/** One object per activation. Old continuations retain the old object forever. */
export class LiveTermFence implements BackgroundTerm {
  private lost = false;
  private depth = 0;
  constructor(private readonly db: SqlDatabase, readonly term: string, private readonly onLost: () => void) {}

  static activate(db: SqlDatabase, holder: string, onLost: () => void): LiveTermFence {
    return withBackgroundTerm(undefined, () => db.transaction(() => {
      db.query(`INSERT INTO multiremi_live_terms(scope, term, holder, updated_at)
        VALUES ('background_jobs', 0, NULL, ?) ON CONFLICT(scope) DO NOTHING`).run(new Date().toISOString());
      const row = db.query(`UPDATE multiremi_live_terms SET term = term + 1, holder = ?, updated_at = ?
        WHERE scope = 'background_jobs' RETURNING CAST(term AS TEXT) AS term`).get(holder, new Date().toISOString());
      return new LiveTermFence(db, row.term, onLost);
    })());
  }

  private reject(): never {
    if (!this.lost) {
      this.lost = true;
      withBackgroundTerm(undefined, this.onLost);
    }
    throw new StaleLiveTermError();
  }

  assertCurrent(): void {
    if (this.lost) this.reject();
    const row = this.db.query("SELECT CAST(term AS TEXT) AS term FROM multiremi_live_terms WHERE scope = 'background_jobs'").get();
    if (row?.term !== this.term) this.reject();
  }

  /**
   * Acquire the fence before domain locks, retaining it until COMMIT. Activation
   * updates this same row, so it cannot pass an in-flight background write.
   * This also fences SQL after an await, not just the initial tick check.
   */
  guard<T>(action: () => T): T {
    if (this.lost) this.reject();
    if (this.depth) return action();
    return this.db.transaction(() => {
      const row = this.db.query(`UPDATE multiremi_live_terms SET term = term
        WHERE scope = 'background_jobs' AND term = ? RETURNING term`).get(this.term);
      if (!row) this.reject();
      this.depth++;
      try { return action(); } finally { this.depth--; }
    })();
  }
}

/** Apply the activation fence to every SQL boundary, including prepared writes. */
export function liveTermDatabase(db: SqlDatabase): SqlDatabase {
  const guarded = <T>(action: () => T): T => {
    const term = currentBackgroundTerm();
    return term ? term.guard(action) : action();
  };
  return new Proxy(db, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "query" || key === "prepare") return (sql: string): SqlStatement => {
        const statement = value.call(target, sql) as SqlStatement;
        return new Proxy(statement, { get(stmt, method) {
          const fn = Reflect.get(stmt, method, stmt);
          return typeof fn === "function" ? (...args: unknown[]) => guarded(() => fn.apply(stmt, args)) : fn;
        } });
      };
      if (key === "run" || key === "exec") return (...args: unknown[]) => guarded(() => value.apply(target, args));
      if (key === "transaction") return (fn: (...args: any[]) => unknown) => {
        const built = value.call(target, fn);
        const run = (...args: unknown[]) => guarded(() => built(...args));
        return Object.assign(run, { deferred: (...args: unknown[]) => guarded(() => (built.deferred ?? built)(...args)) });
      };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
