import { DatabaseRetryLoop, isDatabaseConnectionError } from "@shared/db/recovery.js";
import { withDbJob } from "@shared/observability/db-sources.js";
/**
 * Idle backfill for `multiremi_conversation_log.body_html`.
 *
 * B1 (MUL-426) inserts conversation-log rows with `body_html` NULL, because the
 * renderer did not exist when the writer landed: the plan is explicit that the
 * column is filled here, after the fact, rather than by widening the write path
 * (MUL-402 `cmt_4dntxwh8ub1m`: "B1 先存 NULL，等 C 的
 * `renderMarkdown(md) → {html, render_version}` 就绪后再补").
 *
 * Three properties make this safe to run in the production API process:
 *
 * - **It does not start when the column is absent.** Other agents own the
 *   migration that creates `multiremi_conversation_log`; until it lands, this
 *   task logs once and stays stopped instead of failing its way through a log
 *   file. The probe re-runs on every start attempt, so a process that boots
 *   before B1 can still pick the work up after a restart.
 * - **It is idle.** Work runs in small batches with a pause between them, and a
 *   short batch means the next tick comes back for more. It never re-reads a
 *   row it just wrote, so a table with nothing to do costs one indexed query
 *   per pause.
 * - **It converges rather than racing.** A row is a candidate when `body_html`
 *   is NULL or when its `render_version` is not the current one, so bumping
 *   `RENDER_PIPELINE_REVISION` re-renders everything through the same path. The
 *   update is guarded by `(session_id, seq)`, which is the table's primary key.
 *
 * Rows are re-read every tick rather than tracked in memory: the table is the
 * only source of truth, a restart resumes exactly where it left off, and a
 * concurrent writer that fills a row itself simply removes it from the next
 * candidate set.
 */
import { createLogger } from "@shared/logger.js";
import { scrubErrorForLog } from "@multiremi/store/db/dsn-redaction.js";
import { renderMarkdown, RENDER_VERSION } from "./markdown.js";

const log = createLogger("body-html-backfill");

/** The table B1 owns. Both the table and its two columns are probed. */
export const CONVERSATION_LOG_TABLE = "multiremi_conversation_log";

/** Rows rendered per batch. Small: this runs beside request traffic. */
export const BODY_HTML_BACKFILL_BATCH_SIZE = 50;
/** Pause between batches, in milliseconds. */
export const BODY_HTML_BACKFILL_INTERVAL_MS = 2_000;

export interface BodyHtmlBackfillOptions {
  /**
   * The store. Only three members are used — the column probe, the candidate
   * query and the guarded update — so tests can pass a narrow stand-in.
   */
  store: BodyHtmlBackfillStore;
  /** Overrides the batch size, for tests. */
  batchSize?: number;
  /** Overrides the pause between batches, for tests. */
  intervalMs?: number;
  /** Overrides the renderer, for tests. */
  render?: (markdown: string) => { html: string; render_version: string };
  /** Overrides the version rows are compared against, for tests. */
  renderVersion?: string;
}

/** The store surface the task needs, so a test can drive it without a database. */
export interface BodyHtmlBackfillStore {
  conversationLogRenderColumns(): { body_html: boolean; render_version: boolean } | null;
  listConversationLogRowsNeedingBodyHtml(
    renderVersion: string,
    limit: number,
  ): Array<{ session_id: string; seq: number; body_md: string | null }>;
  setConversationLogBodyHtml(
    sessionId: string,
    seq: number,
    html: string,
    renderVersion: string,
  ): number;
}

/**
 * True when the table exists with the two columns the backfill writes.
 *
 * The probe lives on the store because that is where the database handle is;
 * this is the predicate the "do not start when the column is absent" rule from
 * the issue description is implemented as.
 */
export function conversationLogBodyHtmlColumnsExist(store: BodyHtmlBackfillStore): boolean {
  const columns = store.conversationLogRenderColumns();
  return columns?.body_html === true && columns.render_version === true;
}

/**
 * The task itself. Construct one per store and start it with the other
 * background jobs.
 */
export class BodyHtmlBackfillTask {
  private readonly store: BodyHtmlBackfillStore;
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private readonly render: (markdown: string) => { html: string; render_version: string };
  private readonly renderVersion: string;

  private timer: DatabaseRetryLoop | null = null;
  private nextDelay = 1;
  private running = false;
  private stopped = true;
  private columnsReady: boolean | null = null;

  constructor(options: BodyHtmlBackfillOptions) {
    this.store = options.store;
    this.batchSize = options.batchSize ?? BODY_HTML_BACKFILL_BATCH_SIZE;
    this.intervalMs = options.intervalMs ?? BODY_HTML_BACKFILL_INTERVAL_MS;
    this.render = options.render ?? ((markdown) => renderMarkdown(markdown));
    this.renderVersion = options.renderVersion ?? RENDER_VERSION;
  }

  /** True once the column probe has succeeded and the loop is armed. */
  get started(): boolean {
    return !this.stopped;
  }

  /** Result of the last column probe, or null before the first one. */
  get columnsPresent(): boolean | null {
    return this.columnsReady;
  }

  /**
   * Probe, then run until stopped.
   *
   * Returns false when the columns are absent, which is the documented
   * "do not start" case rather than an error.
   */
  start(): boolean {
    if (!this.stopped) return true;
    try { this.columnsReady = conversationLogBodyHtmlColumnsExist(this.store); }
    catch (error) { if (!isDatabaseConnectionError(error)) throw error; }
    if (this.columnsReady === false) {
      log.info(
        `body_html backfill not started: ${CONVERSATION_LOG_TABLE} has no body_html/render_version columns yet`,
      );
      return false;
    }
    this.stopped = false;
    this.timer = new DatabaseRetryLoop("body-html.backfill",
      () => withDbJob("body-html.backfill", () => this.tick()), () => this.nextDelay);
    this.timer.start(1);
    return true;
  }

  stop(): void {
    this.stopped = true;
    this.timer?.stop();
    this.timer = null;
  }

  /** Re-run the probe; used by tests and by a caller that missed the table. */
  probe(): boolean {
    this.columnsReady = conversationLogBodyHtmlColumnsExist(this.store);
    return this.columnsReady;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.columnsReady !== true && !this.probe()) { this.stop(); return; }
    const processed = await this.runBatch();
    this.nextDelay = processed >= this.batchSize ? 1 : this.intervalMs;
  }

  /**
   * Render one batch. Returns how many rows were updated.
   *
   * Public so a test (and an operator) can drive one pass without the timer.
   */
  async runBatch(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const rows = this.store.listConversationLogRowsNeedingBodyHtml(this.renderVersion, this.batchSize);

      let updated = 0;
      for (const row of rows) {
        const markdown = row.body_md ?? "";
        let rendered: { html: string; render_version: string };
        try {
          rendered = this.render(markdown);
        } catch (error) {
          // One unrenderable row must not stall the rest of the batch; leave it
          // a candidate so the next pass retries it.
          log.warn(
            `body_html backfill could not render ${row.session_id}/${row.seq}: ${scrubErrorForLog(error)}`,
          );
          continue;
        }
        this.store.setConversationLogBodyHtml(
          row.session_id,
          row.seq,
          rendered.html,
          rendered.render_version,
        );
        updated += 1;
      }
      return updated;
    } finally {
      this.running = false;
    }
  }
}
