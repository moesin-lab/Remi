import { randomUUID } from "node:crypto";
import { createId } from "@multiremi/ids.js";
import { createCommitEventQueue, type StoreContext } from "@multiremi/store/context.js";
import type { MultiremiScmCanonicalEvent } from "@multiremi/contracts/types.js";
import type { ScmCheckSummary } from "@multiremi/contracts/scm-operations.js";
import type { ScmRepo } from "@multiremi/store/repos/scm-repo.js";
import { GitHubScmOperations } from "./operations.js";
import { ScmHttpError } from "./http.js";
import { SCM_SYNC_STREAMS } from "./types.js";
import { SCM_PROVIDER_CAPABILITIES } from "./capabilities.js";
import { isDatabaseConnectionError } from "@shared/db/recovery.js";

type Row = Record<string, any>;
export interface ScmMonitorRule {
  /** Stable effect name; additions must not change the meaning of persisted effects. */
  effectType: string;
  matches(event: MultiremiScmCanonicalEvent): boolean;
  /** Read external evidence, then return a synchronous, lease-fenced DB commit. */
  prepare?: (input: { event: MultiremiScmCanonicalEvent; effect: Readonly<Row>; now: Date }) =>
    Promise<(events: ReturnType<typeof createCommitEventQueue>) => void>;
}
export const SCM_MONITOR_RULES: readonly ScmMonitorRule[] = [
  { effectType: "monitor_head", matches: e => e.type === "change.updated" || e.type === "change.opened" },
  { effectType: "monitor_checks", matches: e => e.type === "pipeline.completed" || e.type === "change.updated" || e.type === "change.opened" },
  { effectType: "monitor_review", matches: e => e.type === "review.submitted" || e.type === "review.dismissed" },
];

/** Persistent outbox consumer. Called by the existing scheduler, never a new timer. */
export class ScmMonitor {
  private readonly rules = new Map(SCM_MONITOR_RULES.map(rule => [rule.effectType, rule]));
  constructor(private ctx: StoreContext, private scm: ScmRepo) {}

  registerRule(rule: ScmMonitorRule): void {
    if (!/^monitor_[a-z_]+$/.test(rule.effectType) || this.rules.has(rule.effectType) || rule.effectType === "monitor_capacity" || !rule.prepare) {
      throw new Error("A monitor rule needs a unique monitor_* effect type and prepare handler");
    }
    this.rules.set(rule.effectType, rule);
  }

  enqueue(event: MultiremiScmCanonicalEvent, now: Date): void {
    if (event.provider !== "github") return;
    if (![...this.rules.values()].some(rule => rule.matches(event)) && !["change.closed", "change.merged"].includes(event.type)) return;
    const changes = this.ctx.db.query(`SELECT * FROM multiremi_scm_change_requests
      WHERE connection_id = ? AND repository_id = ?`).all(event.connectionId, event.repositoryId) as Row[];
    for (const change of changes) {
      const related = event.subjectType === "change_request"
        ? change.external_id === event.subjectId
        : event.subjectType === "review"
          ? String(event.payload.change_id) === change.external_id || Number(event.payload.change_number) === change.number
          : event.subjectType === "pipeline" && event.payload.head_sha === change.head_sha;
      if (!related) continue;
      if (["closed", "merged"].includes(change.state)) {
        this.ctx.db.run("UPDATE multiremi_scm_watches SET active = 0 WHERE change_request_id = ?", [change.id]);
        continue;
      }
      const targets = this.ctx.db.query(`SELECT issue_id FROM multiremi_scm_issue_links WHERE change_request_id = ? AND active = 1
        UNION SELECT s.issue_id FROM multiremi_scm_watches w JOIN multiremi_issue_sessions s ON s.id = w.session_id
        WHERE w.change_request_id = ? AND w.active = 1 AND s.issue_id IS NOT NULL`).all(change.id, change.id) as Row[];
      for (const rule of this.rules.values()) {
        if (!rule.matches(event)) continue;
        for (const target of targets) this.insertEffect(event.id, target.issue_id, rule.effectType,
          { changeRequestId: change.id }, now, `${rule.effectType}:${event.id}:${target.issue_id}`);
      }
    }
  }

  private insertEffect(eventId: string, issueId: string, type: string, payload: Row, available: Date, key: string): void {
    this.ctx.db.run(`INSERT OR IGNORE INTO multiremi_scm_effects
      (id, event_id, issue_id, effect_type, status, payload, available_at, dedupe_key, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    [createId("sfx"), eventId, issueId, type, JSON.stringify(payload), available.toISOString(), key, new Date().toISOString()]);
  }

  async run(now = new Date(), limit = 25): Promise<void> {
    this.checkHealth(now);
    // Claim one at a time: a large HTTP batch must not exhaust later rows' leases before it starts.
    for (let i = 0; i < limit; i++) {
      const token = randomUUID();
      const types = [...this.rules.keys(), "monitor_capacity"];
      const effect = this.ctx.db.query(`UPDATE multiremi_scm_effects SET status = 'processing',
        lease_token = ?, lease_until = ?, attempt_count = attempt_count + 1
        WHERE id = (SELECT id FROM multiremi_scm_effects WHERE effect_type IN (${types.map(() => "?").join(",")})
          AND ((status = 'pending' AND available_at <= ?) OR (status = 'processing' AND lease_until <= ?))
          ORDER BY available_at, id LIMIT 1)
        AND ((status = 'pending' AND available_at <= ?) OR (status = 'processing' AND lease_until <= ?)) RETURNING *`).get(
        token, new Date(Math.max(Date.now(), now.getTime()) + 120_000).toISOString(), ...types, now.toISOString(), now.toISOString(), now.toISOString(), now.toISOString()) as Row | null;
      if (!effect) break;
      try {
        await this.execute(effect, token, now);
      } catch (error) {
        if (isDatabaseConnectionError(error)) throw error;
        const delay = error instanceof ScmHttpError && error.rateLimited
          ? Math.max(60_000, (error.retryAfterSeconds ?? 0) * 1000, (error.rateLimitResetAt ?? 0) * 1000 - now.getTime())
          : Math.min(300_000, 1000 * 2 ** Math.min(effect.attempt_count, 9));
        // Never serialize provider response bodies or credential errors into the outbox.
        this.ctx.db.run(`UPDATE multiremi_scm_effects SET status = 'pending', lease_token = NULL, lease_until = NULL,
          available_at = ?, last_error = ? WHERE id = ? AND lease_token = ?`,
        [new Date(now.getTime() + delay).toISOString(), error instanceof ScmHttpError ? `SCM HTTP ${error.status}; retry scheduled` : "SCM monitor failed; retry scheduled", effect.id, token]);
      }
    }
  }

  private async execute(effect: Row, token: string, now: Date): Promise<void> {
    const payload = JSON.parse(effect.payload);
    const initial = this.scm.getChangeRequest(payload.changeRequestId);
    const event = this.scm.getCanonicalEvent(effect.event_id)!;
    const prepared = await this.rules.get(effect.effect_type)?.prepare?.({ event, effect, now });
    let summary: ScmCheckSummary | null = null;
    let capacity: Array<{ name: string; url: string | null }> = [];
    let liveClosed = false;
    if (!prepared && initial && !["closed", "merged"].includes(initial.state) && !["monitor_review", "monitor_head"].includes(effect.effect_type)) {
      const connection = this.scm.getConnection(initial.connectionId)!;
      const binding = this.scm.listRepositoryBindings({ connectionId: connection.id }).find(b => b.repositoryId === initial.repositoryId)!;
      const operations = new GitHubScmOperations({ connection, binding,
        credential: this.scm.getConnectionCredential(connection.id)!, signal: AbortSignal.timeout(90_000) });
      const observed = await operations.liveChecks(initial.number!);
      summary = observed.summary;
      liveClosed = ["closed", "merged"].includes(String(observed.change.payload.state));
      if (effect.effect_type === "monitor_capacity" && summary.headSha === payload.headSha) {
        capacity = await operations.queuedJobs(summary.headSha);
      }
    }
    const events = createCommitEventQueue();
    this.ctx.db.transaction(() => {
      // Serialize state transitions and delivery with Issue ownership/status writers.
      if (initial) this.ctx.lockWorkspaceRuntimeLifecycle(initial.workspaceId);
      const owned = this.ctx.db.query(`UPDATE multiremi_scm_effects SET lease_token = lease_token
        WHERE id = ? AND status = 'processing' AND lease_token = ? RETURNING id`).get(effect.id, token);
      if (!owned) return;
      const change = this.scm.getChangeRequest(payload.changeRequestId);
      if (!change || liveClosed || ["closed", "merged"].includes(change.state)) {
        if (change) this.ctx.db.run("UPDATE multiremi_scm_watches SET active = 0 WHERE change_request_id = ?", [change.id]);
      } else if (prepared) {
        prepared(events);
      } else if (effect.effect_type === "monitor_head") {
        const prior = this.ctx.db.query("SELECT concluded_head FROM multiremi_scm_monitor_heads WHERE change_request_id = ? AND issue_id = ?")
          .get(change.id, effect.issue_id) as Row | null;
        if (change.headSha && prior?.concluded_head && prior.concluded_head !== change.headSha) {
          this.deliver(change.id, effect.issue_id, `head_changed:${change.repositoryId}#${change.number}@${change.headSha}:${prior.concluded_head}`, {
            pr: change.url, head_sha: change.headSha, conclusion: "head_changed", previous_head_sha: prior.concluded_head,
            failed_checks: [], unexecuted_checks: [], run_links: [],
            next_step: "The previous head conclusion is invalid. Wait for checks and review the new head.",
          }, events);
          this.ctx.db.run("UPDATE multiremi_scm_monitor_heads SET concluded_head = NULL WHERE change_request_id = ? AND issue_id = ?", [change.id, effect.issue_id]);
        }
      } else if (effect.effect_type === "monitor_review") {
        this.deliver(change.id, effect.issue_id, `review:${event.id}`, {
          pr: change.url, head_sha: change.headSha, conclusion: event.type,
          review_commit: event.payload.commit_sha ?? null, review: event.payload,
          failed_checks: [], unexecuted_checks: [], run_links: [], next_step: "Read the review against its commit; no merge authorization is granted.",
        }, events);
      } else if (summary && summary.headSha === change.headSha) {
        const prior = this.ctx.db.query("SELECT concluded_head FROM multiremi_scm_monitor_heads WHERE change_request_id = ? AND issue_id = ?")
          .get(change.id, effect.issue_id) as Row | null;
        const key = `${change.repositoryId}#${change.number}@${summary.headSha}`;
        const base = { pr: change.url, head_sha: summary.headSha, failed_checks: [], unexecuted_checks: [], run_links: [], next_step: "Wait for checks; events do not authorize merging." };
        if (effect.effect_type !== "monitor_capacity" && prior?.concluded_head && prior.concluded_head !== summary.headSha) {
          this.deliver(change.id, effect.issue_id, `head_changed:${key}:${prior.concluded_head}`, {
            ...base, conclusion: "head_changed", previous_head_sha: prior.concluded_head,
            next_step: "The previous head conclusion is invalid. Wait for checks and review the new head.",
          }, events);
          this.ctx.db.run("UPDATE multiremi_scm_monitor_heads SET concluded_head = NULL WHERE change_request_id = ? AND issue_id = ?", [change.id, effect.issue_id]);
        }
        const terminal = new Set(["success", "neutral", "skipped", "failure", "error", "cancelled", "timed_out", "action_required", "stale", "startup_failure"]);
        const pending = summary.checks.some(c => c.status !== "completed" || !terminal.has(c.conclusion ?? ""));
        if (effect.effect_type === "monitor_capacity") {
          if (payload.headSha === summary.headSha && capacity.length) this.deliver(change.id, effect.issue_id, `capacity:${key}`, {
            ...base, conclusion: "capacity_blocked", unexecuted_checks: capacity,
            run_links: capacity.map(c => c.url).filter(Boolean), next_step: "Queued jobs have no runner. Check runner capacity.",
          }, events);
        } else if (pending || summary.conclusion === "pending") {
          const issue = this.ctx.issues().getIssue(effect.issue_id);
          const config = issue?.projectId ? this.projectConfig(issue.projectId) : { pendingTimeoutSeconds: 2700 };
          this.insertEffect(event.id, effect.issue_id, "monitor_capacity", { changeRequestId: change.id, headSha: summary.headSha },
            new Date(now.getTime() + config.pendingTimeoutSeconds * 1000), `capacity:${change.id}:${effect.issue_id}:${summary.headSha}`);
        } else if (summary.conclusion === "success" || summary.conclusion === "failure") {
          const failed = summary.checks.filter(c => ["failure", "error", "timed_out", "action_required", "stale", "startup_failure"].includes(c.conclusion ?? ""));
          const unexecuted = summary.checks.filter(c => ["cancelled", "skipped"].includes(c.conclusion ?? ""));
          const delivered = this.deliver(change.id, effect.issue_id, `checks:${key}:${summary.conclusion}`, {
            ...base, conclusion: summary.conclusion, failed_checks: failed, unexecuted_checks: unexecuted,
            run_links: [...new Set(summary.checks.map(c => c.url).filter(Boolean))],
            next_step: summary.conclusion === "failure" ? "Inspect failed and unexecuted checks, then fix or rerun as appropriate." : "Checks observed complete. Obtain review and explicit merge authorization.",
          }, events);
          if (delivered) this.ctx.db.run(`INSERT INTO multiremi_scm_monitor_heads(change_request_id, issue_id, concluded_head) VALUES (?, ?, ?)
            ON CONFLICT(change_request_id, issue_id) DO UPDATE SET concluded_head = excluded.concluded_head`, [change.id, effect.issue_id, summary.headSha]);
          this.ctx.db.run(`UPDATE multiremi_scm_watches SET active = 0 WHERE change_request_id = ? AND until_state = 'settled'
            AND session_id IN (SELECT id FROM multiremi_issue_sessions WHERE issue_id = ?)`, [change.id, effect.issue_id]);
        }
      } else if (summary && effect.effect_type !== "monitor_capacity") {
        // The poll projection or live head changed while HTTP was in flight. Retry, do not discard.
        throw new Error("SCM head changed during monitor read");
      }
      this.ctx.db.run(`UPDATE multiremi_scm_effects SET status = 'applied', applied_at = ?, lease_token = NULL,
        lease_until = NULL, last_error = NULL WHERE id = ? AND lease_token = ?`, [now.toISOString(), effect.id, token]);
    })();
    this.ctx.emitCommitEvents(events);
  }

  private deliver(changeId: string, issueId: string, dedupeKey: string, message: Row, events: ReturnType<typeof createCommitEventQueue>): boolean {
    const linked = this.ctx.db.query("SELECT id FROM multiremi_scm_issue_links WHERE change_request_id = ? AND issue_id = ? AND active = 1").get(changeId, issueId);
    const sessions = this.ctx.db.query(`SELECT s.id FROM multiremi_scm_watches w JOIN multiremi_issue_sessions s ON s.id = w.session_id
      WHERE w.change_request_id = ? AND w.active = 1 AND s.issue_id = ?`).all(changeId, issueId) as Row[];
    if (!linked && sessions.length === 0) return false;
    const body = `SCM monitor\n\n\`\`\`json\n${JSON.stringify({ schema: "scm_monitor.v1", ...message }, null, 2)}\n\`\`\``;
    const envelope = { kind: "lifecycle" as const, wake: "now" as const, body, dedupeKey, source: { issueId } };
    if (linked) this.ctx.inbox().sendEnvelopeWithinTransaction({ ...envelope, to: { role: "issue_owner", issueId } }, [], events);
    const owner = this.ctx.resolveIssueResponsibility(issueId).executionOwner;
    if (!owner) throw new Error("SCM monitor target has no owner");
    for (const session of sessions) this.ctx.inbox().sendEnvelopeWithinTransaction({ ...envelope,
      to: { role: "agent", agentId: owner.id, issueSessionId: session.id } }, [], events);
    return true;
  }

  watches(workspaceId: string, repositoryId: string, number: number): Row[] {
    this.expireClosed();
    return this.ctx.db.query(`SELECT w.* FROM multiremi_scm_watches w JOIN multiremi_scm_change_requests cr ON cr.id = w.change_request_id
      WHERE cr.workspace_id = ? AND cr.repository_id = ? AND cr.number = ? AND w.active = 1`).all(workspaceId, repositoryId, number) as Row[];
  }

  watch(workspaceId: string, repositoryId: string, number: number, sessionId: string, until: string, active: boolean): void {
    if (!["closed", "merged", "settled"].includes(until)) throw new Error("until must be closed, merged or settled");
    const session = this.ctx.issueSessions().getIssueSession(sessionId);
    if (!session?.issueId || session.workspaceId !== workspaceId || session.status === 'archived') throw new Error("An active Issue session in this workspace is required");
    this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      const change = this.ctx.db.query("SELECT id, state FROM multiremi_scm_change_requests WHERE workspace_id = ? AND repository_id = ? AND number = ?").get(workspaceId, repositoryId, number) as Row | null;
      if (!change) throw new Error("Change request not collected yet");
      if (active && ["closed", "merged"].includes(change.state)) throw new Error("Change request is closed");
      this.ctx.db.run(`INSERT INTO multiremi_scm_watches(change_request_id, session_id, until_state, active, created_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(change_request_id, session_id) DO UPDATE SET until_state = excluded.until_state, active = excluded.active`,
      [change.id, sessionId, until, active ? 1 : 0, new Date().toISOString()]);
    })();
  }

  projectConfig(projectId: string, seconds?: number): { pendingTimeoutSeconds: number } {
    if (seconds !== undefined) {
      if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 86400) throw new Error("pendingTimeoutSeconds must be between 60 and 86400");
      this.ctx.db.run(`INSERT INTO multiremi_scm_monitor_projects(project_id, pending_timeout_seconds) VALUES (?, ?)
        ON CONFLICT(project_id) DO UPDATE SET pending_timeout_seconds = excluded.pending_timeout_seconds`, [projectId, seconds]);
    }
    const row = this.ctx.db.query("SELECT pending_timeout_seconds FROM multiremi_scm_monitor_projects WHERE project_id = ?").get(projectId) as Row | null;
    return { pendingTimeoutSeconds: Number(row?.pending_timeout_seconds ?? 2700) };
  }

  private expireClosed(): void {
    this.ctx.db.run(`UPDATE multiremi_scm_watches SET active = 0 WHERE active = 1 AND change_request_id IN
      (SELECT id FROM multiremi_scm_change_requests WHERE state IN ('closed', 'merged'))`);
  }

  status(workspaceId: string, now = new Date()) {
    return this.scm.listConnections({ workspaceId, enabled: true }).filter(c => c.mode !== "webhook").flatMap(connection =>
      this.scm.listRepositoryBindings({ connectionId: connection.id, enabled: true }).flatMap(binding =>
        SCM_SYNC_STREAMS.filter(stream => SCM_PROVIDER_CAPABILITIES[connection.provider].streams[stream].poll).map(stream => {
          const cursor = this.scm.getSyncCursor(connection.id, binding.repositoryId, stream);
          const lastSuccessfulPollAt = cursor?.lastCompletedAt ?? null;
          const lagSeconds = Math.max(0, (now.getTime() - Date.parse(lastSuccessfulPollAt ?? binding.createdAt)) / 1000);
          return { connectionId: connection.id, repositoryId: binding.repositoryId, stream, lastSuccessfulPollAt,
            lagSeconds, stale: lagSeconds > connection.pollIntervalSeconds * 5, lastError: cursor?.lastError ?? null };
        })));
  }

  private checkHealth(now: Date): void {
    this.expireClosed();
    const workspaceIds = new Set(this.scm.listConnections({ enabled: true }).map(c => c.workspaceId));
    for (const workspaceId of workspaceIds) {
      for (const stream of this.status(workspaceId, now).filter(s => s.stale)) {
        const connection = this.scm.getConnection(stream.connectionId)!;
        const key = stream.lastSuccessfulPollAt ?? "never";
        this.ctx.db.transaction(() => {
          this.ctx.lockWorkspaceRuntimeLifecycle(connection.workspaceId);
          const previous = this.ctx.db.query("SELECT alert_key FROM multiremi_scm_monitor_health WHERE connection_id = ? AND repository_id = ? AND stream = ?").get(connection.id, stream.repositoryId, stream.stream) as Row | null;
          if (previous?.alert_key === key) return;
          for (const member of this.ctx.workspaces().listWorkspaceMembers(connection.workspaceId).filter(m => !m.archivedAt)) {
            this.ctx.createInboxItem({ workspaceId: connection.workspaceId, memberId: member.id, type: "scm_collection_alert",
              title: "SCM collection is delayed", body: JSON.stringify({ schema: "scm_monitor.health.v1", ...stream }), details: stream, actorType: "system" });
          }
          this.ctx.db.run(`INSERT INTO multiremi_scm_monitor_health(connection_id, repository_id, stream, alert_key) VALUES (?, ?, ?, ?)
            ON CONFLICT(connection_id, repository_id, stream) DO UPDATE SET alert_key = excluded.alert_key`, [connection.id, stream.repositoryId, stream.stream, key]);
        })();
      }
    }
  }
}
