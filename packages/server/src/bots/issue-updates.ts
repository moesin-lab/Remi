import type { BotIssueNotifications, BotTarget } from "@multiremi/contracts/bots.js";
import type { MultiremiIssue, MultiremiTask } from "@multiremi/contracts/types.js";
import { createId, nowIso } from "@multiremi/ids.js";
import type { StoreContext } from "@multiremi/store/context.js";
import { cleanOptionalString, parseJson, toJson } from "@multiremi/store/helpers.js";
import { RuntimeWorkspacesRepo } from "@multiremi/store/repos/runtime-workspaces-repo.js";
import { createLogger } from "@shared/logger.js";
import { botTargetKey, resolveBotTarget } from "./routing.js";

type Row = Record<string, unknown>;
const log = createLogger("bots");

/** Bot notifications reuse the Chat queue and its existing Issue update aggregation. */
export class BotIssueUpdates {
  constructor(private readonly ctx: StoreContext) {}

  prepareIssueTopicWithinTransaction(issue: MultiremiIssue): boolean {
    const bots = this.ctx.db.query(`SELECT * FROM multiremi_bots
      WHERE workspace_id = ? AND enabled = 1 AND deleted_at IS NULL
        AND issue_notifications IS NOT NULL ORDER BY created_at, id`).all(issue.workspaceId) as Row[];
    let prepared = false;
    for (const bot of bots) {
      const config = parseJson<BotIssueNotifications | null>(bot.issue_notifications, null);
      if (!config?.chat_id || !config.platform_binding_id) continue;
      if (config.project_ids?.length && (!issue.projectId || !config.project_ids.includes(issue.projectId))) continue;
      const platform = this.ctx.db.query(`SELECT id FROM multiremi_bot_platform_bindings
        WHERE id = ? AND bot_id = ? AND active = 1 AND removed = 0`).get(config.platform_binding_id, String(bot.id));
      if (!platform) continue;
      const defaults = parseJson<BotTarget>(bot.default_target, { kind: "agent", agent_id: "" });
      const target = resolveBotTarget(config.target ?? defaults, defaults);
      const unavailable = this.targetUnavailableReason(issue.workspaceId, target);
      if (unavailable) {
        log.warn("bot.issue_topic.skipped", { botId: String(bot.id), issueId: issue.id, reason: unavailable });
        continue;
      }
      const created = this.ctx.db.transaction(() => {
        const existing = this.ctx.db.query(`SELECT s.id FROM multiremi_bot_sessions s
          JOIN multiremi_chat_sessions c ON c.id = s.chat_session_id
          WHERE s.bot_id = ? AND s.platform_binding_id = ? AND c.issue_id = ? LIMIT 1`)
          .get(String(bot.id), config.platform_binding_id, issue.id);
        if (existing) return false;
        const chat = this.ctx.chat().createChatSession({
          workspaceId: issue.workspaceId,
          agentId: target.agent_id,
          creatorId: issue.createdBy ?? "local",
          issueId: issue.id,
          projectId: target.project_id ?? null,
          runtimeWorkspaceId: target.runtime_workspace_id ?? null,
          title: `${issue.key}: ${issue.title}`,
        });
        const sessionId = createId("bsn");
        const now = nowIso();
        this.ctx.db.run(`INSERT INTO multiremi_bot_sessions
          (id, bot_id, platform_binding_id, external_session_key, target_key, target,
           chat_session_id, chat_id, thread_id, reply_to_message_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
        [sessionId, String(bot.id), config.platform_binding_id, `pending:${issue.id}`, botTargetKey(target),
          toJson(target), chat.id, config.chat_id, now, now]);
        this.ctx.db.run(`INSERT INTO multiremi_bot_outbound_deliveries
          (id, bot_id, platform_binding_id, bot_session_id, task_id, chat_id, thread_id,
           reply_to_message_id, body, status, available_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, ?, 'pending', ?, ?, ?)`,
        [createId("bop"), String(bot.id), config.platform_binding_id, sessionId, config.chat_id,
          issueTopicBody(issue), now, now, now]);
        return true;
      })();
      prepared = created || prepared;
    }
    return prepared;
  }

  /** The Task terminal transaction owns both the wakeup and the delivery record. */
  prepareIssueRoundPushesWithinTransaction(input: {
    issue: MultiremiIssue;
    leaderTask: MultiremiTask;
  }): MultiremiTask[] {
    const rows = this.ctx.db.query(`SELECT s.* FROM multiremi_bot_sessions s
      JOIN multiremi_bots b ON b.id = s.bot_id
      JOIN multiremi_bot_platform_bindings p ON p.id = s.platform_binding_id
      JOIN multiremi_chat_sessions c ON c.id = s.chat_session_id
      WHERE b.workspace_id = ? AND b.enabled = 1 AND b.deleted_at IS NULL
        AND p.active = 1 AND p.removed = 0 AND s.closed = 0
        AND c.issue_id = ? AND c.status = 'active'
        AND s.chat_id IS NOT NULL
        AND (s.reply_to_message_id IS NOT NULL OR s.external_session_key LIKE 'pending:%')
      ORDER BY s.created_at, s.id`).all(input.issue.workspaceId, input.issue.id) as Row[];
    const enqueued: MultiremiTask[] = [];
    const seenChats = new Set<string>();
    for (const session of rows) {
      const chatSessionId = String(session.chat_session_id);
      if (seenChats.has(chatSessionId)) continue;
      seenChats.add(chatSessionId);
      if (!this.ctx.notificationChannels().getAgentChatNotificationChannel(chatSessionId)?.enabled) continue;
      if (this.ctx.db.query(`SELECT id FROM multiremi_bot_round_pushes
        WHERE bot_session_id = ? AND leader_task_id = ?`).get(String(session.id), input.leaderTask.id)) continue;

      let task = this.ctx.chat().getPendingChatTask(chatSessionId);
      let deliveryMode: "inbound" | "proactive";
      if (task) {
        deliveryMode = this.ctx.db.query(`SELECT id FROM multiremi_bot_round_pushes
          WHERE wake_task_id = ? AND delivery_mode = 'proactive' LIMIT 1`).get(task.id) ? "proactive" : "inbound";
        const pending = task.status === "queued"
          ? { messages: [], omittedCount: 0 }
          : this.ctx.chat().preparePendingAgentIssueUpdatesForTaskWithinTransaction(chatSessionId, task.id);
        this.ctx.tasks().createTaskSteerMessage({
          taskId: task.id,
          kind: "steer",
          content: roundPushPrompt(input.issue, pending.messages.map(message => message.body), pending.omittedCount),
          authorType: "system",
          authorId: null,
        });
      } else {
        deliveryMode = "proactive";
        // Session configuration is immutable. Later Bot edits must not reroute a reply.
        const target = parseJson<BotTarget>(session.target, { kind: "agent", agent_id: "" });
        const unavailable = this.targetUnavailableReason(input.issue.workspaceId, target);
        if (unavailable) {
          log.warn("bot.issue_round.skipped", { botId: String(session.bot_id), botSessionId: String(session.id),
            issueId: input.issue.id, leaderTaskId: input.leaderTask.id, reason: unavailable });
          continue;
        }
        task = this.ctx.tasks().createTaskWithinTransaction({
          agentId: target.agent_id,
          ...(target.runtime_id ? { runtimeId: target.runtime_id } : {}),
          chatSessionId,
          workspaceId: input.issue.workspaceId,
          prompt: roundPushPrompt(input.issue),
          requestingUserName: "Remi",
          requestingUserProfileDescription: "System-triggered summary for a completed Issue work round.",
        });
        enqueued.push(task);
      }
      const now = nowIso();
      this.ctx.db.run(`INSERT INTO multiremi_bot_round_pushes
        (id, bot_id, platform_binding_id, bot_session_id, issue_id, leader_task_id,
         wake_task_id, delivery_mode, chat_id, thread_id, reply_to_message_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(bot_session_id, leader_task_id) DO NOTHING`,
      [createId("brp"), String(session.bot_id), String(session.platform_binding_id), String(session.id),
        input.issue.id, input.leaderTask.id, task.id, deliveryMode, String(session.chat_id),
        cleanOptionalString(session.thread_id), cleanOptionalString(session.reply_to_message_id), now, now]);
    }
    return enqueued;
  }

  retargetTaskWithinTransaction(fromTaskId: string, toTaskId: string): void {
    // A retry keeps the original response destination after the inbound handler exits.
    this.ctx.db.run(`UPDATE multiremi_bot_round_pushes SET wake_task_id = ?,
      delivery_mode = 'proactive', updated_at = ? WHERE wake_task_id = ?`, [toTaskId, nowIso(), fromTaskId]);
  }

  completeTaskWithinTransaction(task: MultiremiTask, body: string): void {
    const row = this.ctx.db.query(`SELECT * FROM multiremi_bot_round_pushes
      WHERE wake_task_id = ? ORDER BY created_at, id LIMIT 1`).get(task.id) as Row | null
      ?? this.ctx.db.query(`SELECT s.bot_id, d.platform_binding_id, d.bot_session_id,
        s.chat_id, s.thread_id, d.reply_to_message_id
        FROM multiremi_bot_deliveries d JOIN multiremi_bot_sessions s ON s.id = d.bot_session_id
        WHERE d.task_id = ? AND s.chat_id IS NOT NULL ORDER BY d.created_at DESC, d.external_message_id DESC LIMIT 1`)
        .get(task.id) as Row | null;
    if (!row) return;
    const receipt = this.ctx.db.query(`SELECT external_message_id FROM multiremi_bot_reply_messages
      WHERE task_id = ? ORDER BY created_at DESC, external_message_id DESC LIMIT 1`).get(task.id) as Row | null;
    const now = nowIso();
    this.ctx.db.run(`INSERT INTO multiremi_bot_outbound_deliveries
      (id, bot_id, platform_binding_id, bot_session_id, task_id, chat_id, thread_id,
       reply_to_message_id, update_message_id, body, status, available_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?) ON CONFLICT(task_id) DO NOTHING`,
    [createId("bop"), String(row.bot_id), String(row.platform_binding_id), String(row.bot_session_id),
      task.id, String(row.chat_id), cleanOptionalString(row.thread_id), cleanOptionalString(row.reply_to_message_id),
      receipt ? String(receipt.external_message_id) : null, body, now, now, now]);
  }

  /** References can become unavailable after a valid Bot configuration was saved. */
  private targetUnavailableReason(workspaceId: string, target: BotTarget): string | null {
    const agent = this.ctx.agents().getAgent(target.agent_id);
    if (!agent || agent.archivedAt || agent.workspaceId !== workspaceId) return "agent_unavailable";
    const runtime = target.runtime_id ? this.ctx.runtimes().getRuntime(target.runtime_id) : null;
    if (target.runtime_id && (!runtime || !this.ctx.runtimes().runtimeCanRunAgent(runtime, agent))) return "runtime_incompatible";
    if (target.project_id) {
      const project = this.ctx.projects().getProject(target.project_id);
      if (!project || project.archivedAt || project.workspaceId !== workspaceId) return "project_unavailable";
    }
    if (target.runtime_workspace_id) {
      const location = new RuntimeWorkspacesRepo(this.ctx).get(target.runtime_workspace_id);
      if (!location || location.archivedAt || location.workspaceId !== workspaceId) return "runtime_workspace_unavailable";
      const pinned = agent.runtimeId ? this.ctx.runtimes().getRuntime(agent.runtimeId) : null;
      if ((runtime && location.daemonId !== runtime.daemonId) || (pinned && location.daemonId !== pinned.daemonId)) {
        return "runtime_workspace_machine_mismatch";
      }
    }
    return null;
  }
}

function issueTopicBody(issue: MultiremiIssue): string {
  const title = `**${issue.key} - ${issue.title}**`;
  const description = cleanOptionalString(issue.description);
  return description ? `${title}\n\n${description}` : title;
}

function roundPushPrompt(issue: MultiremiIssue, updates: string[] = [], omittedCount = 0): string {
  const lines = [
    `The responsible agent completed a work round for ${issue.key} - ${issue.title}.`,
    "Report the current result to the users in this Bot conversation. Use the Bound Issue Updates context below when present.",
  ];
  if (updates.length) lines.push("", "Updates delivered while the current Chat task was already active:", ...updates);
  if (omittedCount > 0) lines.push("", `${omittedCount} earlier update aggregate(s) were omitted.`);
  return lines.join("\n");
}
