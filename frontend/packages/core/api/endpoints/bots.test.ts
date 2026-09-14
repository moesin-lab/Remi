import { describe, expect, it, vi } from "vitest";
import { botFixture, botInputFixture, botSenderFixture } from "../../bots/test-fixtures";
import type { HttpClient } from "../http";
import { ApiContractError } from "../schema";
import { BotsEndpoints } from "./bots";

function endpoints(raw: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(raw);
  return { api: new BotsEndpoints({ fetch: fetchMock } as unknown as HttpClient), fetchMock };
}

describe("Bot API boundary", () => {
  it("carries the requested workspace and encodes resource ids independently of current navigation", async () => {
    const { api, fetchMock } = endpoints({ bots: [botFixture({ workspace_id: "ws /1" })] });
    await api.listBots("ws /1");
    expect(fetchMock).toHaveBeenCalledWith("/api/bots?workspace_id=ws%20%2F1");
    fetchMock.mockResolvedValue(botFixture({ workspace_id: "ws /1", id: "bot /1" }));
    await api.getBot("ws /1", "bot /1");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/bots/bot%20%2F1?workspace_id=ws%20%2F1");
  });

  it.each([
    { platform_bindings: undefined },
    { allowlist_enabled: "false" },
    { default_target: { kind: "agent" } },
    { routes: [{ id: "route-1", match: {}, target: { kind: "agent", agent_id: "a" } }] },
  ])("rejects incomplete configuration rather than editing a substituted empty value: %j", async (malformed) => {
    const { api } = endpoints({ ...botFixture(), ...malformed });
    await expect(api.getBot("ws-1", "bot-1")).rejects.toBeInstanceOf(ApiContractError);
    await expect(api.createBot(botInputFixture())).rejects.toBeInstanceOf(ApiContractError);
    await expect(api.updateBot("bot-1", botInputFixture())).rejects.toBeInstanceOf(ApiContractError);
  });

  it("rejects well-formed responses belonging to another workspace or Bot", async () => {
    const { api, fetchMock } = endpoints({ bots: [botFixture({ workspace_id: "ws-other" })] });
    await expect(api.listBots("ws-1")).rejects.toBeInstanceOf(ApiContractError);
    fetchMock.mockResolvedValue(botFixture({ workspace_id: "ws-other" }));
    await expect(api.createBot(botInputFixture())).rejects.toBeInstanceOf(ApiContractError);
    fetchMock.mockResolvedValue(botFixture({ id: "bot-other" }));
    await expect(api.getBot("ws-1", "bot-1")).rejects.toBeInstanceOf(ApiContractError);
    await expect(api.updateBot("bot-1", botInputFixture())).rejects.toBeInstanceOf(ApiContractError);
  });

  it("preserves route inheritance, explicit automatic overrides, and credential keep semantics", async () => {
    const { api, fetchMock } = endpoints(botFixture());
    const input = botInputFixture({ routes: [
      { id: "inherit", name: "Inherit", match: { chat_types: ["group"] }, target: { kind: "agent", agent_id: "agent-2" } },
      { id: "automatic", name: "Automatic", match: { commands: ["deploy"] }, target: { kind: "agent", agent_id: "agent-2", runtime_id: null, runtime_workspace_id: null } },
    ] });
    await api.updateBot("bot-1", input);
    expect(fetchMock).toHaveBeenCalledWith("/api/bots/bot-1?workspace_id=ws-1", {
      method: "PUT", body: JSON.stringify(input),
    });
    expect(input.platform_bindings[0]).not.toHaveProperty("app_secret");
    expect(input.platform_bindings[0]?.app_secret_op).toBe("keep");
  });

  it("keeps unknown platform values visible and removes accidental secret fields from cached responses", async () => {
    const bot = botFixture();
    const { api } = endpoints({ ...bot, platform_bindings: [{ ...bot.platform_bindings[0], platform: "future-platform", app_secret: "unexpected-secret" }] });
    const result = await api.getBot("ws-1", "bot-1");
    expect(result.platform_bindings[0]?.platform).toBe("future-platform");
    expect(result.platform_bindings[0]).not.toHaveProperty("app_secret");
  });

  it("does not acknowledge malformed deletion responses", async () => {
    const { api, fetchMock } = endpoints({ deleted: false });
    await expect(api.deleteBot("ws-1", "bot-1")).rejects.toBeInstanceOf(ApiContractError);
    fetchMock.mockResolvedValue({ deleted: true });
    await expect(api.deleteBot("ws-1", "bot-1")).resolves.toEqual({ deleted: true });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/bots/bot-1?workspace_id=ws-1", { method: "DELETE" });
  });

  it("rejects a mixed-Bot sender list and wrong allow/revoke acknowledgement", async () => {
    const { api, fetchMock } = endpoints({ senders: [botSenderFixture({ bot_id: "other" })] });
    await expect(api.listBotSenders("ws-1", "bot-1")).rejects.toBeInstanceOf(ApiContractError);
    fetchMock.mockResolvedValue(botSenderFixture());
    await expect(api.updateBotSender("ws-1", "bot-1", "sender-1", true)).rejects.toBeInstanceOf(ApiContractError);
    fetchMock.mockResolvedValue(botSenderFixture({ allowed: true }));
    await expect(api.updateBotSender("ws-1", "bot-1", "sender-1", true)).resolves.toMatchObject({ allowed: true });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/bots/bot-1/senders/sender-1?workspace_id=ws-1", {
      method: "PUT", body: JSON.stringify({ allowed: true }),
    });
  });

  it("rejects malformed sender and session catalogs instead of showing no activity", async () => {
    const { api, fetchMock } = endpoints({ senders: [{ ...botSenderFixture(), allowed: "true" }] });
    await expect(api.listBotSenders("ws-1", "bot-1")).rejects.toBeInstanceOf(ApiContractError);
    fetchMock.mockResolvedValue({ sessions: [{ id: "session-1", bot_id: "bot-1" }] });
    await expect(api.listBotSessions("ws-1", "bot-1")).rejects.toBeInstanceOf(ApiContractError);
  });
});
