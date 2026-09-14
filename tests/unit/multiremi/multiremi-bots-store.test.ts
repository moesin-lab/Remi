import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { SaveBotInput } from "@multiremi/contracts/bots.js";
import { BotError } from "@multiremi/bots/errors.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

let key: string | undefined;
beforeEach(() => {
  key = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});
afterEach(() => {
  if (key === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = key;
  resetMultiremiTestEnv();
});

function fixture() {
  const store = createLocalStore();
  const agent = store.createAgent({ name: "General", provider: "codex", workspaceId: "local" });
  const other = store.createAgent({ name: "Coding", provider: "codex", workspaceId: "local" });
  for (const id of ["host", "executor", "replacement"]) {
    store.registerRuntime({ id, name: id, provider: "codex", workspaceId: "local", daemonId: `daemon-${id}` });
    store.heartbeatRuntime(id, {});
  }
  const input: SaveBotInput = { workspace_id: "local", name: "Assistant", enabled: true,
    default_target: { kind: "agent", agent_id: agent.id, runtime_id: "executor" },
    platform_bindings: [
      { id: "account-a", platform: "feishu", app_id: "app_a", host_runtime_id: "host", app_secret_op: "set", app_secret: "secret-one" },
      { id: "account-b", platform: "feishu", app_id: "app_b", host_runtime_id: "host", app_secret_op: "set", app_secret: "secret-two" },
    ], routes: [] };
  const bot = store.createBot(input);
  const send = (externalMessageId: string, extra: Record<string, unknown> = {}, binding = "account-a") => store.submitBotMessage(bot.id, binding, "host", { revision: store.getBot(bot.id)!.revision, externalSessionKey: "chat-one", externalMessageId, senderOpenId: "sender", chatId: "chat-one", text: "hello", ...extra });
  return { store, agent, other, bot, input, send };
}

describe("Bot configuration and durable conversation routing", () => {
  it("isolates same message IDs across accounts and deduplicates each incoming event", () => {
    const { store, send } = fixture();
    const one = send("message");
    expect(send("message")).toMatchObject({ duplicate: true, taskId: one.taskId });
    const other = send("message", {}, "account-b");
    expect(other.chatSessionId).not.toBe(one.chatSessionId);
    expect(store.listTasks()).toHaveLength(2);
    expect(store.getTask(one.taskId)?.runtimeId).toBe("executor");
    expect(store.getTask(one.taskId)?.issueCreationRestricted).toBe(false);
  });

  it("preserves Chat when rules or tokens change and separates resolved Agent targets", () => {
    const { store, bot, input, agent, other, send } = fixture();
    const first = send("one");
    store.cancelTask(first.taskId);
    store.updateBot(bot.id, { ...input, routes: [{ id: "renamed", name: "Universal", match: {}, target: { kind: "agent", agent_id: agent.id } }] });
    expect(send("two").chatSessionId).toBe(first.chatSessionId);
    store.updateBot(bot.id, { ...input, routes: [{ id: "coding", name: "Coding", match: { chat_ids: ["chat-one"] }, target: { kind: "agent", agent_id: other.id } }] });
    expect(send("three").chatSessionId).not.toBe(first.chatSessionId);
    expect(store.listBotSenders(bot.id)).toHaveLength(1);
    expect(JSON.stringify(store.getBot(bot.id))).not.toContain("secret-one");
  });

  it("reply provenance preserves the original Agent after routing edits; controls require a unique target", () => {
    const { store, bot, input, other, send } = fixture();
    const first = send("one");
    store.recordBotReply(bot.id, "account-a", "host", first.taskId, "bot-reply");
    store.cancelTask(first.taskId);
    store.updateBot(bot.id, { ...input, default_target: { kind: "agent", agent_id: other.id } });
    const second = send("two");
    expect(send("three", { parentMessageId: "bot-reply" }).chatSessionId).toBe(first.chatSessionId);
    const control = { revision: store.getBot(bot.id)!.revision, externalSessionKey: "chat-one" };
    expect(() => store.inspectBotSession(bot.id, "account-a", "host", control)).toThrow(BotError);
    expect(store.inspectBotSession(bot.id, "account-a", "host", { ...control, replyToMessageId: "bot-reply" }).chatSessionId).toBe(first.chatSessionId);
    expect(store.resetBotSession(bot.id, "account-a", "host", { ...control, chatSessionId: second.chatSessionId })).toBe(true);
    expect(send("four").chatSessionId).not.toBe(second.chatSessionId);
  });

  it("honors execution location inheritance and explicit automatic overrides", () => {
    const { store, bot, input, agent, send } = fixture();
    const location = store.runtimeWorkspaces.create("executor", { name: "Repository", root_path: "/srv/repo" });
    store.updateBot(bot.id, { ...input, default_target: { ...input.default_target, runtime_workspace_id: location.id }, routes: [{ id: "auto", name: "Automatic", match: { commands: ["auto"] }, target: { kind: "agent", agent_id: agent.id, runtime_id: null, runtime_workspace_id: null } }] });
    const local = send("local");
    const automatic = send("auto", { command: "auto" });
    expect(store.getChatSession(local.chatSessionId)?.runtimeWorkspaceId).toBe(location.id);
    expect(store.getTask(local.taskId)?.runtimeId).toBe("executor");
    expect(store.getChatSession(automatic.chatSessionId)?.runtimeWorkspaceId).toBeNull();
    expect(store.getTask(automatic.taskId)?.runtimeId).toBeNull();
    expect(automatic.chatSessionId).not.toBe(local.chatSessionId);
  });

  it("hands connectors over only after the old host stops, and retains Chat on deletion", () => {
    const { store, bot, input, send } = fixture();
    const first = send("one");
    store.reportBotRuntimeStatus(bot.id, "account-a", "host", { appliedRevision: bot.revision, state: "online" });
    const updated = store.updateBot(bot.id, { ...input, platform_bindings: input.platform_bindings.map((binding) => ({ ...binding, host_runtime_id: "replacement" })) });
    expect(store.getBotDaemonAssignment(bot.id, "account-a", "replacement")).toBeNull();
    expect(store.botDirectivesForRuntime("host").find((d) => d.platform_binding_id === "account-a")?.desired_state).toBe("stopped");
    store.reportBotRuntimeStatus(bot.id, "account-a", "host", { appliedRevision: updated.revision, state: "stopped" });
    expect(store.getBotDaemonAssignment(bot.id, "account-a", "replacement")?.app_secret).toBe("secret-one");
    store.deleteBot(bot.id);
    expect(store.getBot(bot.id)).toBeNull();
    expect(store.getChatSession(first.chatSessionId)).not.toBeNull();
    expect(store.getTask(first.taskId)).not.toBeNull();
  });

  it("clears disabled credentials and requires a replacement before reenabling the account", () => {
    const { store, bot, input, send } = fixture();
    const session = send("one");
    const disabled: SaveBotInput = { ...input, enabled: false, platform_bindings: input.platform_bindings.map((binding) => ({ ...binding, app_secret_op: "clear", app_secret: undefined })) };
    expect(store.updateBot(bot.id, disabled).platform_bindings[0]).toMatchObject({ app_secret_configured: false, app_secret_hint: null });
    const kept = { ...disabled, platform_bindings: disabled.platform_bindings.map((binding) => ({ ...binding, app_secret_op: "keep" as const })) };
    expect(() => store.updateBot(bot.id, { ...kept, enabled: true })).toThrow("requires an app secret");
    expect(store.getBot(bot.id)?.enabled).toBe(false);
    store.updateBot(bot.id, { ...input, platform_bindings: input.platform_bindings.map((binding) => ({ ...binding, app_secret: "rotated-secret" })) });
    expect(store.getBotDaemonAssignment(bot.id, "account-a", "host")?.app_secret).toBe("rotated-secret");
    expect(send("two").chatSessionId).toBe(session.chatSessionId);
  });

  it("rejects an Agent pinned to another machine before saving a local-directory route", () => {
    const { store, bot, input } = fixture();
    const pinned = store.createAgent({ name: "Pinned", provider: "codex", workspaceId: "local", runtimeId: "host" });
    const location = store.runtimeWorkspaces.create("executor", { name: "Project", root_path: "/srv/project" });
    expect(() => store.updateBot(bot.id, { ...input, default_target: { kind: "agent", agent_id: pinned.id, runtime_id: "executor", runtime_workspace_id: location.id } })).toThrow("Agent is bound to a different machine");
    expect(store.getBot(bot.id)?.default_target).toMatchObject(input.default_target);
  });
});
