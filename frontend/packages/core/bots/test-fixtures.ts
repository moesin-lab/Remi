import type { Bot, BotSender, SaveBotInput } from "./types";

export function botFixture(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    workspace_id: "ws-1",
    name: "Development bot",
    enabled: false,
    revision: 1,
    platform_bindings: [{
      id: "binding-1",
      platform: "feishu",
      app_id: "app-1",
      domain: "feishu",
      host_runtime_id: "runtime-1",
      enabled: true,
      app_secret_configured: true,
      app_secret_hint: "***test",
      status: "stopped",
      last_error: null,
      last_seen_at: null,
    }],
    default_target: { kind: "agent", agent_id: "agent-1", runtime_id: null, project_id: null, runtime_workspace_id: null },
    routes: [{ id: "route-1", name: "Build", match: { commands: ["build"] }, target: { kind: "agent", agent_id: "agent-2" } }],
    allowlist_enabled: false,
    issue_notifications: null,
    created_at: "2026-09-14T00:00:00Z",
    updated_at: "2026-09-14T00:00:00Z",
    ...overrides,
  };
}

export function botInputFixture(overrides: Partial<SaveBotInput> = {}): SaveBotInput {
  const bot = botFixture();
  return {
    workspace_id: bot.workspace_id,
    name: bot.name,
    enabled: bot.enabled,
    platform_bindings: bot.platform_bindings.map((binding) => ({
      id: binding.id,
      platform: binding.platform,
      app_id: binding.app_id,
      domain: binding.domain,
      host_runtime_id: binding.host_runtime_id,
      enabled: binding.enabled,
      app_secret_op: "keep",
    })),
    default_target: bot.default_target,
    routes: bot.routes,
    allowlist_enabled: bot.allowlist_enabled,
    issue_notifications: bot.issue_notifications,
    ...overrides,
  };
}

export function botSenderFixture(overrides: Partial<BotSender> = {}): BotSender {
  return {
    id: "sender-1",
    bot_id: "bot-1",
    platform_binding_id: "binding-1",
    external_id: "ou_sender",
    display_name: "Sender",
    allowed: false,
    first_seen_at: "2026-09-14T00:00:00Z",
    last_seen_at: "2026-09-14T00:00:00Z",
    ...overrides,
  };
}
