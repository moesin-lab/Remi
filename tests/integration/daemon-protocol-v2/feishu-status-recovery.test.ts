import { afterEach, expect, it } from "bun:test";
import { DAEMON_HEARTBEAT_INTERVAL_MS } from "@multiremi/contracts/daemon-protocol.js";
import { DaemonProtocolHarness, waitFor } from "./harness.js";

const fixtures: DaemonProtocolHarness[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.dispose(); });

it("recovers an unacknowledged online report and releases outbound without a new directive or reconnect", async () => {
  const previousKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 77).toString("base64");
  try {
    let lostOnline = false;
    const h = await DaemonProtocolHarness.create({ beforeSend: frame => {
      if (!lostOnline && frame.t === "concierge.status_report" && frame.p?.state === "online") {
        lostOnline = true;
        return false; // Simulate a swallowed first write on the connected socket.
      }
    } });
    fixtures.push(h);
    const sent: string[] = [];
    h.daemon.setFeishuConciergeHost({
      start: async () => ({ botName: "Fixture" }),
      stop: async () => {},
      sendOutbound: async delivery => { sent.push(delivery.id); return { messageId: `om_sent_${delivery.id}` }; },
    });
    await h.startDaemon();
    await h.settleHeartbeat();
    const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id as string;
    const agent = h.store.createAgent({ name: "Concierge", provider: "claude", workspaceId: "local", runtimeId });
    const config = h.store.upsertFeishuBotConfig("local", { senderAccessPolicy: "agent",
      agentId: agent.id, runtimeId, appId: "cli_status_recovery", appSecretOp: "set",
      appSecret: "fixture-only-secret", domain: "feishu", enabled: true,
    });
    const state = () => h.store.listFeishuBotRuntimeStatuses("local").find(row => row.runtimeId === runtimeId);
    await waitFor(() => lostOnline && state()?.state === "starting", "unacknowledged online status");

    const submitted = h.store.submitFeishuBotMessage("local", runtimeId, {
      revision: config.revision, externalSessionKey: "oc_status_recovery", externalMessageId: "om_status_recovery",
      chatId: "oc_status_recovery", chatType: "p2p", text: "Please answer", deliveryMode: "native_cot_v1",
    });
    expect(submitted.taskId).toBeTruthy();
    expect(h.store.pendingFeishuBotOutbound("local", runtimeId)).toBeNull();
    expect(sent).toHaveLength(0);
    const directives = h.received.filter(frame => frame.t === "feishu.directive").length;
    expect(directives).toBe(1);

    // This expires the unacknowledged RPC and triggers the next normal hb ack.
    h.clock.advance(DAEMON_HEARTBEAT_INTERVAL_MS);
    await waitFor(() => state()?.state === "online", "online status to be retried");
    await waitFor(() => sent.length > 0, "pending Feishu reply to be sent");
    await waitFor(() => sent.every(id => (h.db.query("SELECT status FROM multiremi_feishu_bot_outbound_deliveries WHERE id = ?")
      .get(id) as { status: string } | null)?.status === "sent"), "Feishu reply results to be acknowledged");
    expect(h.received.filter(frame => frame.t === "feishu.directive")).toHaveLength(directives);
    expect(h.sockets).toHaveLength(1);
    expect(new Set(sent).size).toBe(sent.length);
    expect(h.ledger.filter(entry => entry.type === "concierge.status_report" && entry.frame.p.state === "online")).toHaveLength(1);
  } finally {
    if (previousKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
    else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousKey;
  }
}, 15_000);


it("runs two scoped bot hosts over v2 and stops only the deleted bot", async () => {
  const previousKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 77).toString("base64");
  try {
    const h = await DaemonProtocolHarness.create(); fixtures.push(h);
    const starts: string[] = [], stops: string[] = [], sent: string[] = [];
    h.daemon.setFeishuConciergeHost(botId => ({
      start: async assignment => {
        expect(assignment.config.bot_id).toBe(botId);
        expect(assignment.config.app_id).toBe(`cli_${botId}`);
        starts.push(botId!); return {};
      },
      stop: async () => { stops.push(botId!); },
      sendOutbound: async delivery => {
        expect(delivery.botId).toBe(botId);
        sent.push(botId!); return { messageId: `om_${delivery.id}` };
      },
    }));
    await h.startDaemon(); await h.settleHeartbeat();
    const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id as string;
    expect(h.store.getRuntime(runtimeId)!.metadata.feishu_concierge_multi_v1).toBe(true);
    const agent = h.store.createAgent({ name: "Multi", provider: "claude", workspaceId: "local", runtimeId });
    for (const id of ["default", "second"]) h.store.feishuBotFor(id).upsertConfig("local", {
      senderAccessPolicy: "agent", agentId: agent.id, runtimeId, appId: `cli_${id}`,
      appSecretOp: "set", appSecret: `secret-${id}`, domain: "feishu", enabled: true,
    });
    const online = (id: string) => h.store.feishuBotFor(id).getRuntimeStatus("local", runtimeId)?.state === "online";
    await waitFor(() => online("default") && online("second"), "both scoped bots online");
    expect(h.received.some(frame => frame.t === "feishu.directive")).toBe(false);
    for (const id of ["default", "second"]) h.store.submitFeishuBotMessage("local", runtimeId, {
      revision: 1, externalSessionKey: "oc_same", externalMessageId: "om_same", chatId: "oc_same",
      chatType: "p2p", text: "answer", deliveryMode: "native_cot_v1",
    }, id);
    await waitFor(() => sent.includes("default") && sent.includes("second"), "outbounds sent by matching hosts");
    h.store.feishuBotFor("second").deleteConfig("local");
    await waitFor(() => stops.includes("second"), "deleted bot stopped");
    expect(online("default")).toBe(true);
    expect(starts.filter(id => id === "default")).toHaveLength(1);
    expect(stops).not.toContain("default");
  } finally {
    if (previousKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
    else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousKey;
  }
}, 15_000);
