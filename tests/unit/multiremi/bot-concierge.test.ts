import { describe, expect, it } from "bun:test";
import { BotConciergeSupervisor } from "@multiremi/worker/bot-concierge.js";
import type { BotDirective, BotOutboundDelivery } from "@multiremi/contracts/bots.js";
import type { MultiremiFeishuBotAssignment } from "@multiremi/worker/client.js";

const directive = (id: string, revision = 1): BotDirective => ({
  bot_id: "bot", platform_binding_id: id, revision, desired_state: "running", config_available: true,
});
const assignment = (id: string): MultiremiFeishuBotAssignment => ({
  config: { workspace_id: "workspace", runtime_id: "host", agent_id: "agent", revision: 1,
    desired_state: "running", app_id: id, app_secret: "secret-value", domain: "feishu" },
  agent: { id: "agent", name: "Agent" } as MultiremiFeishuBotAssignment["agent"],
});

function setup(options: { start?: (id: string) => Promise<void>; acknowledge?: () => Promise<void> } = {}) {
  const events: string[] = [];
  const reports: Array<{ id: string; state: string }> = [];
  const outbound = new Map<string, BotOutboundDelivery>();
  const results: Array<{ id: string; status: string }> = [];
  const supervisor = new BotConciergeSupervisor({
    createHost: (item) => ({
      start: async () => { events.push(`start:${item.platform_binding_id}`); await options.start?.(item.platform_binding_id); return {}; },
      stop: async () => { events.push(`stop:${item.platform_binding_id}`); },
      sendOutbound: async (delivery) => { events.push(`send:${item.platform_binding_id}:${delivery.id}`); return { messageId: "platform-message" }; },
    }),
    fetchConfig: async (item) => assignment(item.platform_binding_id),
    report: async (item, report) => { reports.push({ id: item.platform_binding_id, state: report.state }); },
    claimOutbound: async (item) => outbound.get(item.platform_binding_id) ?? null,
    reportOutbound: async (item, _delivery, result) => { results.push({ id: item.platform_binding_id, status: result.status }); await options.acknowledge?.(); },
  });
  return { supervisor, events, reports, outbound, results };
}

describe("Bot platform supervisor", () => {
  it("keeps accounts independent and stops only a removed binding", async () => {
    const test = setup();
    await test.supervisor.apply([directive("one"), directive("two")]);
    await test.supervisor.apply([directive("two")]);
    expect(test.events).toEqual(["start:one", "start:two", "stop:one"]);
    await test.supervisor.shutdown();
    expect(test.events.at(-1)).toBe("stop:two");
  });

  it("keeps another account online when one credential fails", async () => {
    const test = setup({ start: async (id) => { if (id === "one") throw new Error("bad credentials secret-value"); } });
    await test.supervisor.apply([directive("one"), directive("two")]);
    expect(test.reports).toContainEqual({ id: "one", state: "failed" });
    expect(test.reports).toContainEqual({ id: "two", state: "online" });
    await test.supervisor.shutdown();
  });

  it("waits for an in-flight start before shutdown and ignores later polls", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => { started = resolve; });
    const test = setup({ start: async () => { started(); await gate; } });
    const applying = test.supervisor.apply([directive("one")]);
    await hasStarted;
    const stopping = test.supervisor.shutdown();
    release();
    await Promise.all([applying, stopping]);
    await test.supervisor.apply([directive("two")]);
    expect(test.events).toEqual(["start:one", "stop:one"]);
  });

  it("sends a delivery on its original account and does not misreport an acknowledgement failure", async () => {
    const test = setup({ acknowledge: async () => { throw new Error("control plane disconnected"); } });
    test.outbound.set("two", {
      id: "delivery", botId: "bot", platformBindingId: "two", claimToken: "lease", chatId: "chat",
      threadId: null, replyToMessageId: null, body: "completed", idempotencyKey: "delivery",
    });
    await test.supervisor.apply([directive("one"), directive("two")]);
    expect(test.events.filter((entry) => entry.startsWith("send:"))).toEqual(["send:two:delivery"]);
    expect(test.results).toEqual([{ id: "two", status: "sent" }]);
    await test.supervisor.shutdown();
  });
});
