import { createId, nowIso } from "@multiremi/ids.js";
import type { StoreContext } from "@multiremi/store/context.js";
import { nullableString, parseJson } from "@multiremi/store/helpers.js";
import { decryptFeishuBotSecret, encryptFeishuBotSecret, feishuBotSecretHint } from "@multiremi/feishu-bot/credentials.js";
import { redactFeishuBotError } from "@multiremi/feishu-bot/diagnostics.js";
import { isRuntimeEffectivelyOnline } from "./runtimes-repo.js";
import { RuntimeWorkspacesRepo } from "./runtime-workspaces-repo.js";
import { BotError } from "@multiremi/bots/errors.js";
import { botTargetKey, resolveBotTarget, selectBotTarget } from "@multiremi/bots/routing.js";
import type { Bot, BotDaemonAssignment, BotDirective, BotOutboundDelivery, BotPlatformBinding, BotSender, BotSession, BotSessionControlInput, BotSessionSnapshot, BotTarget, ReportBotStatusInput, SaveBotInput, SubmitBotMessageInput, SubmitBotMessageResult } from "@multiremi/contracts/bots.js";
import type { MultiremiTask } from "@multiremi/contracts/types.js";

type Row = Record<string, unknown>;
const text = (value: unknown, name: string, max = 512): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new BotError(`Invalid ${name}`);
  return value.trim();
};
const optional = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const bool = (value: unknown, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new BotError("Expected a boolean");
  return value;
};

/** Bot configuration and durable transport lineage. Agent execution stays in Chat/Task. */
export class BotsRepo {
  constructor(private readonly ctx: StoreContext) {}

  list(workspaceId?: string): Bot[] {
    const rows = this.ctx.db.query(`SELECT * FROM multiremi_bots WHERE deleted_at IS NULL ${workspaceId ? "AND workspace_id = ?" : ""} ORDER BY created_at, id`).all(...(workspaceId ? [workspaceId] : [])) as Row[];
    return rows.map((row) => this.mapBot(row));
  }

  get(id: string): Bot | null {
    const row = this.ctx.db.query("SELECT * FROM multiremi_bots WHERE id = ? AND deleted_at IS NULL").get(id) as Row | null;
    return row ? this.mapBot(row) : null;
  }

  create(input: SaveBotInput): Bot { return this.save(createId("bot"), input, false); }
  update(id: string, input: SaveBotInput): Bot { return this.save(id, input, true); }

  private save(id: string, input: SaveBotInput, updating: boolean): Bot {
    if (!input || typeof input !== "object") throw new BotError("Bot configuration is required");
    const workspaceId = text(input.workspace_id, "workspace_id");
    const name = text(input.name, "name", 120);
    const enabled = bool(input.enabled, false);
    const allowlist = bool(input.allowlist_enabled, false);
    if (!Array.isArray(input.platform_bindings) || input.platform_bindings.length > 50) throw new BotError("platform_bindings must be an array of at most 50 accounts");
    if (input.routes !== undefined && (!Array.isArray(input.routes) || input.routes.length > 100)) throw new BotError("routes must be an array of at most 100 rules");
    return this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(workspaceId);
      const current = this.get(id);
      if (updating && !current) throw new BotError("Bot not found", 404, "bot_not_found");
      if (current && current.workspace_id !== workspaceId) throw new BotError("Bot workspace cannot change", 409, "workspace_mismatch");
      if (!this.ctx.workspaces().getWorkspace(workspaceId)) throw new BotError("Workspace not found", 404);
      const defaultTarget = resolveBotTarget(input.default_target);
      this.validateTarget(workspaceId, defaultTarget);
      const bindingIds = new Set<string>();
      const activeAccounts = new Set<string>();
      const bindings = input.platform_bindings.map((binding) => {
        if (!binding || typeof binding !== "object" || Array.isArray(binding)) throw new BotError("Invalid platform binding");
        const bindingId = binding.id === undefined ? createId("bp") : text(binding.id, "platform binding id");
        if (bindingIds.has(bindingId)) throw new BotError("Duplicate platform binding id");
        bindingIds.add(bindingId);
        const existing = this.bindingRow(bindingId);
        if (existing && existing.bot_id !== id) throw new BotError("Platform binding belongs to another Bot");
        if (binding.platform !== "feishu") throw new BotError("Unsupported platform", 400, "unsupported_platform");
        const appId = text(binding.app_id, "app_id");
        const domain = binding.domain ?? "feishu";
        if (!["feishu", "lark", "bytedance"].includes(domain)) throw new BotError("Unsupported platform domain");
        if (existing && (existing.app_id !== appId || existing.domain !== domain)) throw new BotError("Add a new platform binding to change account identity", 409, "platform_identity_immutable");
        const hostId = text(binding.host_runtime_id, "host_runtime_id");
        if (this.ctx.runtimes().getRuntime(hostId)?.workspaceId !== workspaceId) throw new BotError("Platform host belongs to another workspace");
        const bindingEnabled = bool(binding.enabled, true);
        const active = enabled && bindingEnabled;
        if (active) {
          const identity = JSON.stringify([binding.platform, domain, appId]);
          if (activeAccounts.has(identity)) throw new BotError("This platform account is configured twice", 409, "platform_account_in_use");
          activeAccounts.add(identity);
          const old = this.ctx.db.query("SELECT workspace_id FROM multiremi_feishu_bot_configs WHERE enabled = 1 AND app_id = ? AND domain = ?").get(appId, domain);
          const another = this.ctx.db.query("SELECT id FROM multiremi_bot_platform_bindings WHERE active = 1 AND platform = 'feishu' AND app_id = ? AND domain = ? AND bot_id != ?").get(appId, domain, id);
          if (old || another) throw new BotError("This platform account already has an active connector", 409, "platform_account_in_use");
        }
        const op = binding.app_secret_op ?? "keep";
        if (!["keep", "set", "clear"].includes(op)) throw new BotError("Invalid app_secret_op");
        const secret = op === "set" ? text(binding.app_secret, "app_secret", 4096) : null;
        const ciphertext = secret ? encryptFeishuBotSecret(secret, { workspaceId: `${workspaceId}:${id}:${bindingId}`, field: "app_secret" }) : op === "clear" ? "" : String(existing?.app_secret_encrypted ?? "");
        if (!ciphertext && (active || !existing)) throw new BotError("Platform account requires an app secret", 400, "app_secret_required");
        return { id: bindingId, platform: binding.platform, appId, domain, hostId, enabled: bindingEnabled, active, ciphertext, hint: !ciphertext ? null : secret ? feishuBotSecretHint(secret) : nullableString(existing?.app_secret_hint), createdAt: existing?.created_at };
      });
      const routeIds = new Set<string>();
      const routes = (input.routes ?? []).map((route) => {
        if (!route || typeof route !== "object" || !route.match || typeof route.match !== "object" || Array.isArray(route.match)) throw new BotError("Invalid route");
        const routeId = text(route.id, "route id");
        if (routeIds.has(routeId)) throw new BotError("Duplicate route id");
        routeIds.add(routeId);
        for (const [field, values] of Object.entries(route.match)) {
          if (!["platform_binding_ids", "chat_types", "chat_ids", "commands"].includes(field) || !Array.isArray(values) || values.length > 100 || values.some((v) => typeof v !== "string" || !v.trim())) throw new BotError(`Invalid route ${field}`);
        }
        if (route.match.platform_binding_ids?.some((value) => !bindingIds.has(value))) throw new BotError("Route references a missing platform binding");
        if (route.match.chat_types?.some((value) => value !== "p2p" && value !== "group")) throw new BotError("Invalid chat type");
        this.validateTarget(workspaceId, resolveBotTarget(route.target, defaultTarget));
        return { id: routeId, name: text(route.name, "route name", 120), match: route.match, target: route.target };
      });
      const notifications = input.issue_notifications ?? null;
      if (notifications) {
        if (!bindingIds.has(notifications.platform_binding_id)) throw new BotError("Issue notifications reference a missing platform binding");
        text(notifications.chat_id, "notification chat_id");
        this.validateTarget(workspaceId, resolveBotTarget(notifications.target ?? defaultTarget, defaultTarget));
        if (notifications.project_ids !== undefined && (!Array.isArray(notifications.project_ids) || notifications.project_ids.some((project) => this.ctx.projects().getProject(project)?.workspaceId !== workspaceId))) throw new BotError("Invalid notification project filter");
      }
      const now = nowIso();
      this.ctx.db.run(`INSERT INTO multiremi_bots (id,workspace_id,name,enabled,revision,default_target,routes,allowlist_enabled,issue_notifications,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled,revision=excluded.revision,default_target=excluded.default_target,routes=excluded.routes,allowlist_enabled=excluded.allowlist_enabled,issue_notifications=excluded.issue_notifications,updated_at=excluded.updated_at`,
      [id, workspaceId, name, enabled ? 1 : 0, (current?.revision ?? 0) + 1, JSON.stringify(defaultTarget), JSON.stringify(routes), allowlist ? 1 : 0, notifications ? JSON.stringify(notifications) : null, current?.created_at ?? now, now]);
      this.ctx.db.run("UPDATE multiremi_bot_platform_bindings SET active = 0, removed = 1, updated_at = ? WHERE bot_id = ?", now, id);
      for (const binding of bindings) {
        this.ctx.db.run(`INSERT INTO multiremi_bot_platform_bindings (id,bot_id,platform,app_id,domain,host_runtime_id,enabled,active,removed,app_secret_encrypted,app_secret_hint,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?) ON CONFLICT(id) DO UPDATE SET host_runtime_id=excluded.host_runtime_id,enabled=excluded.enabled,active=excluded.active,removed=0,app_secret_encrypted=excluded.app_secret_encrypted,app_secret_hint=excluded.app_secret_hint,updated_at=excluded.updated_at`,
        [binding.id, id, binding.platform, binding.appId, binding.domain, binding.hostId, binding.enabled ? 1 : 0, binding.active ? 1 : 0, binding.ciphertext, binding.hint, binding.createdAt ?? now, now]);
      }
      return this.get(id)!;
    })();
  }

  delete(id: string): boolean {
    return this.ctx.db.transaction(() => {
      if (!this.get(id)) return false;
      this.ctx.db.run("UPDATE multiremi_bots SET deleted_at = ?, enabled = 0, revision = revision + 1 WHERE id = ?", nowIso(), id);
      this.ctx.db.run("UPDATE multiremi_bot_platform_bindings SET active = 0, removed = 1 WHERE bot_id = ?", id);
      return true;
    })();
  }

  private validateTarget(workspaceId: string, target: BotTarget): void {
    const agent = this.ctx.agents().getAgent(target.agent_id);
    if (!agent || agent.workspaceId !== workspaceId || agent.archivedAt) throw new BotError("Target Agent is unavailable in this workspace", 400, "agent_unavailable");
    const runtime = target.runtime_id ? this.ctx.runtimes().getRuntime(target.runtime_id) : null;
    if (target.runtime_id && (!runtime || runtime.workspaceId !== workspaceId || !this.ctx.runtimes().runtimeCanRunAgent(runtime, agent))) throw new BotError("Execution Runtime cannot run this Agent", 400, "runtime_agent_incompatible");
    if (target.project_id) {
      const project = this.ctx.projects().getProject(target.project_id);
      if (!project || project.workspaceId !== workspaceId || project.archivedAt) throw new BotError("Project is unavailable in this workspace");
    }
    if (target.runtime_workspace_id) {
      const location = new RuntimeWorkspacesRepo(this.ctx).get(target.runtime_workspace_id);
      if (!location || location.workspaceId !== workspaceId || location.archivedAt) throw new BotError("Runtime workspace is unavailable", 400, "runtime_workspace_unavailable");
      if (runtime && location.daemonId !== runtime.daemonId) throw new BotError("Runtime workspace belongs to another machine");
      if (agent.runtimeId && this.ctx.runtimes().getRuntime(agent.runtimeId)?.daemonId !== location.daemonId) throw new BotError("Agent is bound to a different machine", 409, "agent_runtime_workspace_mismatch");
    }
  }

  private bindingRow(id: string): Row | null { return this.ctx.db.query("SELECT * FROM multiremi_bot_platform_bindings WHERE id = ?").get(id) as Row | null; }

  private mapBot(row: Row): Bot {
    const bindings = this.ctx.db.query("SELECT * FROM multiremi_bot_platform_bindings WHERE bot_id = ? AND removed = 0 ORDER BY created_at,id").all(String(row.id)) as Row[];
    return { id: String(row.id), workspace_id: String(row.workspace_id), name: String(row.name), enabled: Boolean(row.enabled), revision: Number(row.revision), platform_bindings: bindings.map((binding) => this.mapBinding(binding)), default_target: parseJson(row.default_target, {} as BotTarget), routes: parseJson(row.routes, []), allowlist_enabled: Boolean(row.allowlist_enabled), issue_notifications: parseJson(row.issue_notifications, null), created_at: String(row.created_at), updated_at: String(row.updated_at) };
  }

  private mapBinding(row: Row): BotPlatformBinding {
    const state = this.ctx.db.query("SELECT * FROM multiremi_bot_runtime_states WHERE platform_binding_id = ? AND runtime_id = ?").get(String(row.id), String(row.host_runtime_id)) as Row | null;
    const runtime = this.ctx.runtimes().getRuntime(String(row.host_runtime_id));
    const fresh = state && Date.now() - Date.parse(String(state.reported_at)) < 90_000;
    const status = !runtime || !isRuntimeEffectivelyOnline(runtime) || (state && !fresh)
      ? "offline"
      : state ? String(state.state) as BotPlatformBinding["status"] : Number(row.active) ? "starting" : "stopped";
    return { id: String(row.id), platform: "feishu", app_id: String(row.app_id), domain: String(row.domain) as BotPlatformBinding["domain"], host_runtime_id: String(row.host_runtime_id), enabled: Boolean(row.enabled), app_secret_configured: Boolean(row.app_secret_encrypted), app_secret_hint: nullableString(row.app_secret_hint), status, last_error: nullableString(state?.error_message), last_seen_at: nullableString(state?.reported_at) };
  }

  directivesForRuntime(runtimeId: string): BotDirective[] {
    const rows = this.ctx.db.query(`SELECT DISTINCT p.* FROM multiremi_bot_platform_bindings p LEFT JOIN multiremi_bot_runtime_states s ON s.platform_binding_id=p.id
      WHERE p.host_runtime_id=? OR (s.runtime_id=? AND s.state!='stopped')`).all(runtimeId, runtimeId) as Row[];
    return rows.map((row) => this.directive(row, runtimeId));
  }

  private directive(binding: Row, runtimeId: string): BotDirective {
    const bot = this.get(String(binding.bot_id));
    let running = Boolean(bot?.enabled && Number(binding.active) && !Number(binding.removed) && binding.host_runtime_id === runtimeId);
    if (running) {
      const states = this.ctx.db.query("SELECT * FROM multiremi_bot_runtime_states WHERE platform_binding_id = ? AND runtime_id != ? AND state != 'stopped'").all(String(binding.id), runtimeId) as Row[];
      running = !states.some((state) => {
        const runtime = this.ctx.runtimes().getRuntime(String(state.runtime_id));
        return runtime && isRuntimeEffectivelyOnline(runtime) && Date.now() - Date.parse(String(state.reported_at)) < 90_000;
      });
      // A disabled legacy connector must have actually stopped before the new one starts.
      if (running) {
        const legacy = this.ctx.db.query(`SELECT s.* FROM multiremi_feishu_bot_runtime_states s JOIN multiremi_feishu_bot_configs c ON c.workspace_id=s.workspace_id WHERE c.app_id=? AND c.domain=? AND s.state!='stopped'`).all(String(binding.app_id), String(binding.domain)) as Row[];
        running = !legacy.some((state) => {
          const runtime = this.ctx.runtimes().getRuntime(String(state.runtime_id));
          return runtime && isRuntimeEffectivelyOnline(runtime) && Date.now() - Date.parse(String(state.reported_at)) < 90_000;
        });
      }
    }
    return { bot_id: String(binding.bot_id), platform_binding_id: String(binding.id), revision: bot?.revision ?? 0, desired_state: running ? "running" : "stopped", config_available: running };
  }

  getDaemonAssignment(botId: string, bindingId: string, runtimeId: string): BotDaemonAssignment | null {
    const binding = this.bindingRow(bindingId);
    const bot = this.get(botId);
    if (!binding || binding.bot_id !== botId || !bot || !this.directive(binding, runtimeId).config_available) return null;
    return { bot_id: botId, platform_binding_id: bindingId, platform: "feishu", workspace_id: bot.workspace_id, runtime_id: runtimeId, agent_id: bot.default_target.agent_id, revision: bot.revision, desired_state: "running", app_id: String(binding.app_id), app_secret: decryptFeishuBotSecret(String(binding.app_secret_encrypted), { workspaceId: `${bot.workspace_id}:${botId}:${bindingId}`, field: "app_secret" }), domain: String(binding.domain) as BotPlatformBinding["domain"], bot_agent: null };
  }

  reportRuntimeStatus(botId: string, bindingId: string, runtimeId: string, input: ReportBotStatusInput): BotDirective {
    const binding = this.bindingRow(bindingId);
    const previous = this.ctx.db.query("SELECT 1 FROM multiremi_bot_runtime_states WHERE platform_binding_id = ? AND runtime_id = ?").get(bindingId, runtimeId);
    if (!binding || binding.bot_id !== botId || (binding.host_runtime_id !== runtimeId && !previous)) throw new BotError("Runtime does not host this platform binding", 403, "runtime_not_selected");
    if (!["stopped", "starting", "online", "failed"].includes(input.state) || !Number.isSafeInteger(input.appliedRevision) || input.appliedRevision < 0) throw new BotError("Invalid connector runtime status");
    this.ctx.db.run(`INSERT INTO multiremi_bot_runtime_states (bot_id,platform_binding_id,runtime_id,applied_revision,state,bot_name,bot_open_id,error_code,error_message,reported_at) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(platform_binding_id,runtime_id) DO UPDATE SET applied_revision=excluded.applied_revision,state=excluded.state,bot_name=excluded.bot_name,bot_open_id=excluded.bot_open_id,error_code=excluded.error_code,error_message=excluded.error_message,reported_at=excluded.reported_at`,
    [botId, bindingId, runtimeId, input.appliedRevision, input.state, optional(input.botName), optional(input.botOpenId), optional(input.errorCode), input.errorMessage ? redactFeishuBotError(input.errorMessage).slice(0, 2000) : null, nowIso()]);
    return this.directive(binding, runtimeId);
  }

  private assigned(botId: string, bindingId: string, runtimeId: string, revision?: number): Bot {
    const bot = this.get(botId);
    const binding = this.bindingRow(bindingId);
    if (!bot || !binding || binding.bot_id !== botId || binding.host_runtime_id !== runtimeId) throw new BotError("Runtime does not host this platform binding", 403, "runtime_not_selected");
    if (!this.directive(binding, runtimeId).config_available) throw new BotError("Bot platform binding is not running", 409, "bot_not_running");
    if (revision !== undefined && bot.revision !== revision) throw new BotError("Bot assignment is stale", 409, "stale_revision");
    return bot;
  }

  listSenders(botId: string): BotSender[] {
    return (this.ctx.db.query("SELECT * FROM multiremi_bot_senders WHERE bot_id = ? ORDER BY last_seen_at DESC,id").all(botId) as Row[]).map(mapSender);
  }
  setSenderAllowed(botId: string, senderId: string, allowed: boolean): BotSender {
    bool(allowed, false);
    if (this.ctx.db.run("UPDATE multiremi_bot_senders SET allowed = ? WHERE id = ? AND bot_id = ?", allowed ? 1 : 0, senderId, botId).changes !== 1) throw new BotError("Sender not found", 404);
    return mapSender(this.ctx.db.query("SELECT * FROM multiremi_bot_senders WHERE id = ?").get(senderId) as Row);
  }
  listSessions(botId: string): BotSession[] {
    return (this.ctx.db.query("SELECT * FROM multiremi_bot_sessions WHERE bot_id = ? ORDER BY updated_at DESC,id").all(botId) as Row[]).map(mapSession);
  }

  isChatSession(chatSessionId: string): boolean {
    return Boolean(this.ctx.db.query("SELECT 1 FROM multiremi_bot_sessions WHERE chat_session_id=? LIMIT 1").get(chatSessionId));
  }

  submitMessage(botId: string, bindingId: string, runtimeId: string, input: SubmitBotMessageInput): SubmitBotMessageResult {
    let bot = this.assigned(botId, bindingId, runtimeId, input.revision);
    const externalKey = text(input.externalSessionKey, "external_session_key", 1024);
    const externalMessageId = text(input.externalMessageId, "external_message_id");
    const body = text(input.text, "text", 200_000);
    let enqueued: MultiremiTask | null = null;
    let chatMessageId: string | null = null;
    const result = this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(bot.workspace_id);
      bot = this.assigned(botId, bindingId, runtimeId, input.revision);
      const duplicate = this.ctx.db.query(`SELECT d.*,s.chat_session_id FROM multiremi_bot_deliveries d JOIN multiremi_bot_sessions s ON s.id=d.bot_session_id WHERE d.platform_binding_id=? AND d.external_message_id=?`).get(bindingId, externalMessageId) as Row | null;
      if (duplicate) {
        const task = this.ctx.tasks().getTask(String(duplicate.task_id));
        if (!task) throw new BotError("Original task no longer exists", 409, "task_unavailable");
        return { chatSessionId: String(duplicate.chat_session_id), taskId: task.id, status: task.status, duplicate: true, steered: false, botSessionId: String(duplicate.bot_session_id), senderAllowed: Boolean(this.ctx.db.query("SELECT allowed FROM multiremi_bot_senders WHERE id=?").get(String(duplicate.sender_id))?.allowed) };
      }
      const senderExternalId = optional(input.senderOpenId);
      let sender: BotSender | null = null;
      const now = nowIso();
      if (senderExternalId) {
        text(senderExternalId, "sender_open_id");
        this.ctx.db.run(`INSERT INTO multiremi_bot_senders (id,bot_id,platform_binding_id,external_id,display_name,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(platform_binding_id,external_id) DO UPDATE SET display_name=COALESCE(excluded.display_name,multiremi_bot_senders.display_name),last_seen_at=excluded.last_seen_at`,
        [createId("bs"), botId, bindingId, senderExternalId, optional(input.senderName)?.slice(0, 512) ?? null, now, now]);
        sender = mapSender(this.ctx.db.query("SELECT * FROM multiremi_bot_senders WHERE platform_binding_id=? AND external_id=?").get(bindingId, senderExternalId) as Row);
      }
      const reference = !input.target && input.parentMessageId ? this.ctx.db.query(`SELECT s.* FROM multiremi_bot_reply_messages r JOIN multiremi_bot_sessions s ON s.id=r.bot_session_id WHERE r.platform_binding_id=? AND r.external_message_id=? AND s.external_session_key=?`).get(bindingId, input.parentMessageId, externalKey) as Row | null : null;
      const target = reference ? mapSession(reference).target : selectBotTarget(bot, bindingId, input);
      this.validateTarget(bot.workspace_id, target);
      const targetKey = botTargetKey(target);
      let sessionRow = (reference && !Number(reference.closed) ? reference : null) ?? this.ctx.db.query("SELECT * FROM multiremi_bot_sessions WHERE platform_binding_id=? AND external_session_key=? AND target_key=? AND closed=0").get(bindingId, externalKey, targetKey) as Row | null;
      if (sessionRow && !this.ctx.chat().getChatSession(String(sessionRow.chat_session_id))) {
        this.ctx.db.run("UPDATE multiremi_bot_sessions SET closed=1 WHERE id=?", String(sessionRow.id));
        sessionRow = null;
      }
      if (!sessionRow) {
        const chat = this.ctx.chat().createChatSession({ workspaceId: bot.workspace_id, agentId: target.agent_id, creatorId: `bot:${botId}`, title: bot.name, projectId: target.project_id, runtimeWorkspaceId: target.runtime_workspace_id });
        const id = createId("bss");
        this.ctx.db.run(`INSERT INTO multiremi_bot_sessions (id,bot_id,platform_binding_id,external_session_key,target_key,target,chat_session_id,chat_id,thread_id,reply_to_message_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, botId, bindingId, externalKey, targetKey, JSON.stringify(target), chat.id, optional(input.chatId), optional(input.threadId), optional(input.replyToMessageId) ?? externalMessageId, now, now]);
        sessionRow = this.ctx.db.query("SELECT * FROM multiremi_bot_sessions WHERE id=?").get(id) as Row;
      }
      const session = mapSession(sessionRow);
      const activeTask = this.ctx.chat().getPendingChatTask(session.chat_session_id);
      let task: MultiremiTask;
      if (activeTask) {
        task = activeTask;
      } else {
        task = this.ctx.tasks().createTaskWithinTransaction({ agentId: target.agent_id, runtimeId: target.runtime_id, chatSessionId: session.chat_session_id, workspaceId: bot.workspace_id, prompt: body, requestingUserName: sender?.display_name ?? "Bot sender", requestingUserProfileDescription: `Source: Bot ${bot.name}. Issue creation uses the Bot's current optional sender allowlist.`, issueCreationRestricted: false });
        enqueued = task;
      }
      const messageId = createId("msg");
      chatMessageId = messageId;
      this.ctx.db.run("INSERT INTO multiremi_chat_messages (id,chat_session_id,task_id,role,body,created_at) VALUES (?,?,?,'user',?,?)", messageId, session.chat_session_id, task.id, body, now);
      const attachmentIds = input.attachmentIds ?? [];
      if (!Array.isArray(attachmentIds) || attachmentIds.length > 32) throw new BotError("Invalid attachment_ids");
      for (const attachmentId of attachmentIds) {
        const attachment = this.ctx.db.query("SELECT * FROM multiremi_attachments WHERE id=?").get(text(attachmentId, "attachment_id")) as Row | null;
        if (!attachment || attachment.workspace_id !== bot.workspace_id || attachment.uploader_type !== "bot" || attachment.uploader_id !== botId || attachment.chat_message_id) throw new BotError("Attachment does not belong to this Bot", 400, "invalid_attachment");
        this.ctx.db.run("UPDATE multiremi_attachments SET chat_session_id=? WHERE id=?", session.chat_session_id, attachmentId);
      }
      if (attachmentIds.length) this.ctx.issues().linkAttachmentsToChatMessage(session.chat_session_id, messageId, attachmentIds);
      if (activeTask) {
        const attachments = attachmentIds.length
          ? `\n\nAttachments added to this message:\n${attachmentIds.map((id) => `- /api/attachments/${encodeURIComponent(id)}/download — download on your execution machine with: remi attachment download ${JSON.stringify(id)} --output-dir ./attachments`).join("\n")}`
          : "";
        this.ctx.tasks().createTaskSteerMessage({ taskId: activeTask.id, kind: "steer", content: body + attachments, authorType: "external", authorId: sender?.id ?? `bot:${botId}:unknown` });
      }
      this.ctx.db.run("UPDATE multiremi_chat_sessions SET latest_task_id=?,updated_at=? WHERE id=?", task.id, now, session.chat_session_id);
      this.ctx.db.run("UPDATE multiremi_bot_sessions SET chat_id=COALESCE(?,chat_id),thread_id=COALESCE(?,thread_id),reply_to_message_id=?,updated_at=? WHERE id=?", optional(input.chatId), optional(input.threadId), optional(input.replyToMessageId) ?? externalMessageId, now, session.id);
      this.ctx.db.run("INSERT INTO multiremi_bot_deliveries (platform_binding_id,external_message_id,bot_session_id,task_id,sender_id,reply_to_message_id,created_at) VALUES (?,?,?,?,?,?,?)", bindingId, externalMessageId, session.id, task.id, sender?.id ?? null, optional(input.replyToMessageId) ?? externalMessageId, now);
      return { chatSessionId: session.chat_session_id, taskId: task.id, status: task.status, duplicate: false, steered: Boolean(activeTask), botSessionId: session.id, senderAllowed: sender?.allowed ?? false };
    })();
    if (chatMessageId) {
      const chat = this.ctx.chat().getChatSession(result.chatSessionId);
      if (chat) this.ctx.emitChatEvent(chat, "chat:message", {
        message_id: chatMessageId,
        role: "user",
        content: body,
        task_id: result.taskId,
      }, { actorType: "bot", actorId: botId });
    }
    if (enqueued) this.ctx.notifyTaskEnqueued(enqueued);
    return result;
  }

  private controlSession(botId: string, bindingId: string, runtimeId: string, input: BotSessionControlInput): BotSession | null {
    this.assigned(botId, bindingId, runtimeId, input.revision);
    const key = text(input.externalSessionKey, "external_session_key", 1024);
    let candidates = (this.ctx.db.query("SELECT * FROM multiremi_bot_sessions WHERE bot_id=? AND platform_binding_id=? AND external_session_key=?").all(botId, bindingId, key) as Row[]).map(mapSession);
    if (input.chatSessionId) candidates = candidates.filter((session) => session.chat_session_id === input.chatSessionId);
    else if (input.replyToMessageId) {
      const row = this.ctx.db.query(`SELECT bot_session_id FROM multiremi_bot_reply_messages WHERE platform_binding_id=? AND external_message_id=? UNION SELECT bot_session_id FROM multiremi_bot_deliveries WHERE platform_binding_id=? AND external_message_id=?`).get(bindingId, input.replyToMessageId, bindingId, input.replyToMessageId) as Row | null;
      candidates = row ? candidates.filter((session) => session.id === String(row.bot_session_id)) : [];
    } else {
      const liveIds = new Set((this.ctx.db.query("SELECT id FROM multiremi_bot_sessions WHERE bot_id=? AND platform_binding_id=? AND closed=0").all(botId, bindingId) as Row[]).map((row) => String(row.id)));
      candidates = candidates.filter((session) => liveIds.has(session.id));
    }
    if (candidates.length > 1) throw new BotError("Reply to a Bot message to select the Agent conversation", 409, "ambiguous_session");
    return candidates[0] ?? null;
  }

  resetSession(botId: string, bindingId: string, runtimeId: string, input: BotSessionControlInput): boolean {
    const session = this.controlSession(botId, bindingId, runtimeId, input);
    return session ? this.ctx.db.run("UPDATE multiremi_bot_sessions SET closed=1,updated_at=? WHERE id=? AND closed=0", nowIso(), session.id).changes === 1 : false;
  }
  cancelSessionTask(botId: string, bindingId: string, runtimeId: string, input: BotSessionControlInput): string | null {
    const session = this.controlSession(botId, bindingId, runtimeId, input);
    const task = session ? this.ctx.chat().getPendingChatTask(session.chat_session_id) : null;
    if (!task) return null;
    this.ctx.tasks().cancelTask(task.id);
    return task.id;
  }
  inspectSession(botId: string, bindingId: string, runtimeId: string, input: BotSessionControlInput): BotSessionSnapshot {
    const session = this.controlSession(botId, bindingId, runtimeId, input);
    const chat = session ? this.ctx.chat().getChatSession(session.chat_session_id) : null;
    const task = chat?.latestTaskId ? this.ctx.tasks().getTask(chat.latestTaskId) : null;
    return { chatSessionId: session?.chat_session_id ?? null, task: task ? { taskId: task.id, status: task.status, result: task.result, error: task.error, sessionId: task.sessionId, workDir: task.workDir, usage: task.usage } : null };
  }

  isHostForTask(runtimeId: string, taskId: string): boolean {
    const runtime = this.ctx.runtimes().getRuntime(runtimeId);
    const seen = new Set<string>();
    let task = this.ctx.tasks().getTask(taskId);
    while (task && runtime && task.workspaceId === runtime.workspaceId && !seen.has(task.id)) {
      seen.add(task.id);
      const rows = this.ctx.db.query("SELECT p.* FROM multiremi_bot_sessions s JOIN multiremi_bot_platform_bindings p ON p.id=s.platform_binding_id WHERE s.chat_session_id=? AND p.host_runtime_id=?").all(task.chatSessionId ?? "", runtimeId) as Row[];
      if (rows.some((row) => this.directive(row, runtimeId).config_available)) return true;
      task = task.parentTaskId ? this.ctx.tasks().getTask(task.parentTaskId) : null;
    }
    return false;
  }

  recordReply(botId: string, bindingId: string, runtimeId: string, taskId: string, externalMessageId: string): boolean {
    const bot = this.assigned(botId, bindingId, runtimeId);
    return this.ctx.db.transaction(() => {
      this.ctx.lockWorkspaceRuntimeLifecycle(bot.workspace_id);
      this.assigned(botId, bindingId, runtimeId);
      const task = this.ctx.tasks().getTask(taskId);
      const session = task?.chatSessionId ? this.ctx.db.query("SELECT id FROM multiremi_bot_sessions WHERE bot_id=? AND platform_binding_id=? AND chat_session_id=?").get(botId, bindingId, task.chatSessionId) as Row | null : null;
      if (!session) throw new BotError("Task does not belong to this platform binding", 403, "task_not_bound");
      const externalId = text(externalMessageId, "external_message_id");
      const prior = this.ctx.db.query("SELECT bot_session_id FROM multiremi_bot_reply_messages WHERE platform_binding_id=? AND external_message_id=?").get(bindingId, externalId) as Row | null;
      if (prior && prior.bot_session_id !== session.id) throw new BotError("Reply already belongs to another session", 409);
      // Platform card creation can finish after a fast provider failure. Attach
      // its receipt to the replacement so the eventual result updates this card.
      const effectiveTaskId = this.getTaskReplacement(taskId) ?? taskId;
      this.ctx.db.run("INSERT INTO multiremi_bot_reply_messages (platform_binding_id,external_message_id,bot_session_id,task_id,created_at) VALUES (?,?,?,?,?) ON CONFLICT(platform_binding_id,external_message_id) DO UPDATE SET task_id=excluded.task_id", bindingId, externalId, String(session.id), effectiveTaskId, nowIso());
      this.ctx.db.run("UPDATE multiremi_bot_outbound_deliveries SET update_message_id=? WHERE task_id=? AND platform_binding_id=? AND status!='sent'", externalId, effectiveTaskId, bindingId);
      return true;
    })();
  }

  getTaskReplacement(taskId: string): string | null {
    const task = this.ctx.tasks().getTask(taskId);
    if (!task?.chatSessionId) return null;
    const candidates = this.ctx.db.query("SELECT DISTINCT d.task_id FROM multiremi_bot_deliveries d JOIN multiremi_bot_sessions s ON s.id=d.bot_session_id WHERE s.chat_session_id=? AND d.task_id!=? UNION SELECT r.wake_task_id AS task_id FROM multiremi_bot_round_pushes r JOIN multiremi_bot_sessions s ON s.id=r.bot_session_id WHERE s.chat_session_id=? AND r.wake_task_id!=?").all(task.chatSessionId, taskId, task.chatSessionId, taskId) as Row[];
    for (const row of candidates) {
      const candidateId = String(row.task_id);
      let candidate = this.ctx.tasks().getTask(candidateId);
      const seen = new Set<string>();
      while (candidate?.parentTaskId && !seen.has(candidate.id)) {
        seen.add(candidate.id);
        if (candidate.parentTaskId === taskId) return candidateId;
        candidate = this.ctx.tasks().getTask(candidate.parentTaskId);
      }
    }
    return null;
  }

  isTaskIssueCreationRestricted(taskId: string): boolean {
    const initial = this.ctx.tasks().getTask(taskId);
    const seen = new Set<string>();
    let task = initial;
    while (task && initial && task.workspaceId === initial.workspaceId && !seen.has(task.id)) {
      seen.add(task.id);
      const row = this.ctx.db.query(`SELECT 1 AS restricted FROM multiremi_bot_deliveries d JOIN multiremi_bot_sessions s ON s.id=d.bot_session_id JOIN multiremi_bots b ON b.id=s.bot_id LEFT JOIN multiremi_bot_senders sender ON sender.id=d.sender_id
        WHERE b.allowlist_enabled=1 AND b.deleted_at IS NULL AND b.workspace_id=? AND (d.task_id=? OR s.chat_session_id=?) AND (sender.id IS NULL OR sender.allowed=0) LIMIT 1`).get(task.workspaceId, task.id, task.chatSessionId ?? "");
      if (row) return true;
      task = task.parentTaskId ? this.ctx.tasks().getTask(task.parentTaskId) : null;
    }
    return false;
  }

  retargetTaskWithinTransaction(fromTaskId: string, toTaskId: string): void {
    this.ctx.db.run("UPDATE multiremi_bot_deliveries SET task_id=? WHERE task_id=?", toTaskId, fromTaskId);
    this.ctx.db.run("UPDATE multiremi_bot_reply_messages SET task_id=? WHERE task_id=?", toTaskId, fromTaskId);
  }

  claimOutbound(botId: string, bindingId: string, runtimeId: string, nowInput: Date = new Date()): BotOutboundDelivery | null {
    this.assigned(botId, bindingId, runtimeId);
    return this.ctx.db.transaction(() => {
      const now = nowInput.toISOString();
      const row = this.ctx.db.query(`SELECT o.* FROM multiremi_bot_outbound_deliveries o JOIN multiremi_bot_sessions s ON s.id=o.bot_session_id WHERE o.bot_id=? AND o.platform_binding_id=? AND ((o.status='pending' AND o.available_at<=?) OR (o.status='sending' AND o.leased_until<=?)) AND (o.task_id IS NULL OR o.reply_to_message_id IS NOT NULL OR s.thread_id IS NOT NULL) ORDER BY o.created_at,o.id LIMIT 1`).get(botId, bindingId, now, now) as Row | null;
      if (!row) return null;
      if (row.task_id && !row.reply_to_message_id) {
        const session = this.ctx.db.query("SELECT thread_id FROM multiremi_bot_sessions WHERE id=?").get(String(row.bot_session_id)) as Row;
        row.reply_to_message_id = session.thread_id;
        row.thread_id = session.thread_id;
        this.ctx.db.run("UPDATE multiremi_bot_outbound_deliveries SET reply_to_message_id=?,thread_id=? WHERE id=?", String(session.thread_id), String(session.thread_id), String(row.id));
      }
      const claim = createId("boc");
      const changed = this.ctx.db.run("UPDATE multiremi_bot_outbound_deliveries SET status='sending',claim_token=?,leased_until=?,attempt_count=attempt_count+1,updated_at=? WHERE id=? AND ((status='pending' AND available_at<=?) OR (status='sending' AND leased_until<=?))", claim, new Date(nowInput.getTime() + 30_000).toISOString(), now, String(row.id), now, now).changes;
      if (changed !== 1) return null;
      return { id: String(row.id), botId, platformBindingId: bindingId, idempotencyKey: String(row.id), updateMessageId: nullableString(row.update_message_id), chatId: String(row.chat_id), threadId: nullableString(row.thread_id), replyToMessageId: nullableString(row.reply_to_message_id), body: String(row.body), claimToken: claim };
    })();
  }

  reportOutbound(botId: string, bindingId: string, runtimeId: string, deliveryId: string, input: { claimToken: string; status: "sent" | "failed"; externalMessageId?: string | null; error?: string | null }, nowInput: Date = new Date()): boolean {
    this.assigned(botId, bindingId, runtimeId);
    return this.ctx.db.transaction(() => {
      const row = this.ctx.db.query("SELECT * FROM multiremi_bot_outbound_deliveries WHERE id=? AND bot_id=? AND platform_binding_id=? AND status='sending' AND claim_token=? AND leased_until>?").get(deliveryId, botId, bindingId, input.claimToken, nowInput.toISOString()) as Row | null;
      if (!row) return false;
      const now = nowInput.toISOString();
      if (input.status === "sent") {
        if (!row.reply_to_message_id && !optional(input.externalMessageId)) return false;
        this.ctx.db.run("UPDATE multiremi_bot_outbound_deliveries SET status='sent',external_message_id=?,sent_at=?,claim_token=NULL,leased_until=NULL,last_error=NULL,updated_at=? WHERE id=?", optional(input.externalMessageId), now, now, deliveryId);
        if (!row.reply_to_message_id) this.ctx.db.run("UPDATE multiremi_bot_sessions SET external_session_key=?,thread_id=?,reply_to_message_id=?,updated_at=? WHERE id=?", `${String(row.chat_id)}:thread:${input.externalMessageId}`, input.externalMessageId!, input.externalMessageId!, now, String(row.bot_session_id));
        if (optional(input.externalMessageId)) this.ctx.db.run("INSERT INTO multiremi_bot_reply_messages (platform_binding_id,external_message_id,bot_session_id,task_id,created_at) VALUES (?,?,?,?,?) ON CONFLICT(platform_binding_id,external_message_id) DO NOTHING", bindingId, input.externalMessageId!, String(row.bot_session_id), String(row.task_id ?? ""), now);
      } else {
        const delay = Math.min(300_000, 5000 * 2 ** Math.min(6, Number(row.attempt_count) - 1));
        this.ctx.db.run("UPDATE multiremi_bot_outbound_deliveries SET status='pending',claim_token=NULL,leased_until=NULL,available_at=?,last_error=?,updated_at=? WHERE id=?", new Date(nowInput.getTime() + delay).toISOString(), input.error ? redactFeishuBotError(input.error).slice(0, 2000) : "Platform send failed", now, deliveryId);
      }
      return true;
    })();
  }
}

function mapSender(row: Row): BotSender { return { id: String(row.id), bot_id: String(row.bot_id), platform_binding_id: String(row.platform_binding_id), external_id: String(row.external_id), display_name: nullableString(row.display_name), allowed: Boolean(row.allowed), first_seen_at: String(row.first_seen_at), last_seen_at: String(row.last_seen_at) }; }
function mapSession(row: Row): BotSession { return { id: String(row.id), bot_id: String(row.bot_id), platform_binding_id: String(row.platform_binding_id), external_session_key: String(row.external_session_key), target: parseJson(row.target, {} as BotTarget), chat_session_id: String(row.chat_session_id), chat_id: nullableString(row.chat_id), thread_id: nullableString(row.thread_id), reply_to_message_id: nullableString(row.reply_to_message_id), created_at: String(row.created_at), updated_at: String(row.updated_at) }; }
