import { expect, test } from "bun:test";
import { diskSpace } from "@daemon/agent-runtime/workspace/disk-usage.js";
import type { DiskPressureMonitor } from "@daemon/agent-runtime/workspace/disk-pressure.js";
import { DAEMON_HEARTBEAT_INTERVAL_MS, DAEMON_OFFER_COOLDOWN_MS } from "@multiremi/contracts/daemon-protocol.js";
import { DaemonProtocolHarness, waitFor } from "./harness.js";

// Real statfs, temporary root, HTTP API, native WebSocket, Store and daemon.
// No model invocation is required: execution may stop at the credential preflight.
test("temporary daemon refuses disk-critical offers and automatically recovers after policy restoration", async () => {
  const h = await DaemonProtocolHarness.create({ providers: ["codex"], beforeStart: async h => {
    h.store.updateWorkspace("local", { settings: { storage: {
      pressure_free_percent: 100, critical_free_percent: 99, pressure_free_bytes: 0, critical_free_bytes: 0,
    } } });
  } });
  try {
    await h.startDaemon();
    const runtimeId = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id;
    h.client.sendHeartbeatNow();
    await h.settleHeartbeat();
    const disk = await diskSpace(h.root);
    expect(disk).not.toBeNull();
    const agent = h.store.createAgent({ name: "disk acceptance", provider: "codex", runtimeId, workspaceId: "local" });
    const task = h.store.createTask({ agentId: agent.id, prompt: "disk recovery acceptance" });
    await waitFor(() => h.ledger.some(entry => entry.type === "res" && entry.frame.p.code === "disk_critical"), "critical rejection");
    expect(h.store.getTask(task.id)?.status).toBe("queued");
    const response = await fetch(`${h.url}/api/runtimes/${runtimeId}`, { headers: { Authorization: "Bearer fixture-master" } });
    const body = await response.json();
    expect(JSON.stringify(body)).toContain('"degraded"');
    expect(JSON.stringify(body)).toContain('"disk_critical"');
    console.log(`MUL-212 critical: ${JSON.stringify({ root: h.root, disk, offer: "disk_critical", task: h.store.getTask(task.id)?.status, health: h.store.getRuntime(runtimeId)?.metadata.health })}`);

    const restored = await fetch(`${h.url}/api/workspaces/local/storage`, { method: "PUT", headers: { Authorization: "Bearer fixture-master", "Content-Type": "application/json" },
      body: JSON.stringify({ pressure_free_percent: 0, critical_free_percent: 0, pressure_free_bytes: 0, critical_free_bytes: 0 }) });
    expect(restored.status).toBe(200);
    await waitFor(() => (h.daemon as any).workspaceSettings.get("local")?.storage?.critical_free_percent === 0, "policy downlink");
    // Invoke the same check used by the 30 s timer, without waiting for wall-clock polling.
    const monitor = (h.daemon as unknown as { diskMonitor: DiskPressureMonitor }).diskMonitor;
    await monitor.check();
    await h.settleHeartbeat();
    h.clock.advance(DAEMON_OFFER_COOLDOWN_MS + DAEMON_HEARTBEAT_INTERVAL_MS);
    await waitFor(() => h.ledger.some(entry => entry.type === "task.start" && entry.partition === task.id)
      || ["completed", "failed"].includes(h.store.getTask(task.id)?.status ?? ""), "automatic offer recovery", 35_000);
    const offers = h.received.filter(frame => frame.t === "task.offer" && frame.p.attempt_id === task.id);
    expect(offers).toHaveLength(2);
    expect(h.ledger.some(entry => entry.type === "res" && entry.frame.re === String(offers[1]!.seq) && entry.frame.p.ok === true)).toBe(true);
    expect(h.store.getRuntime(runtimeId)?.metadata.health).toEqual({ state: "ok", reasons: [] });
    console.log(`MUL-212 recovered: ${JSON.stringify({ task: h.store.getTask(task.id)?.status, health: h.store.getRuntime(runtimeId)?.metadata.health, offers: offers.length, provider_execution: "not validated" })}`);
  } finally { await h.dispose(); }
}, 45_000);
