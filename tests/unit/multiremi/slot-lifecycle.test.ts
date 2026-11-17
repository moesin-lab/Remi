import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { SlotLifecycle, resolveSlotConfiguration, type SlotHooks } from "@multiremi/api/slot-lifecycle.js";
import { startMultiremiServer } from "@multiremi/api.js";
import { createLocalStore, createResponsibleTestIssue, resetMultiremiTestEnv } from "./helpers.js";
import { MultiremiScheduler } from "@daemon/scheduler.js";
import { connect } from "node:net";

afterEach(resetMultiremiTestEnv);

const config = { id: "blue", start: "standby" as const, controlToken: "test-secret", lockTimeoutMs: 10, drainTimeoutMs: 1000 };
function fixture(overrides: Partial<SlotHooks> = {}) {
  const events: string[] = [];
  const slot = new SlotLifecycle(config, "test-version", {
    acquire: async () => { events.push("lock"); return { close: async () => { events.push("unlock"); } }; },
    fence: async () => { events.push("fence"); return 42; },
    start: () => { events.push("start"); }, disconnect: () => { events.push("disconnect"); },
    stop: async () => { events.push("stop"); }, ...overrides,
  });
  return { slot, events };
}

describe("API slot lifecycle", () => {
  test("validates opt-in configuration and defaults", () => {
    expect(resolveSlotConfiguration({})).toBeNull();
    expect(() => resolveSlotConfiguration({ MULTIREMI_SLOT_START: "standby" })).toThrow();
    expect(() => resolveSlotConfiguration({ MULTIREMI_SLOT: "blue" })).toThrow();
    expect(resolveSlotConfiguration({ MULTIREMI_SLOT: "blue", MULTIREMI_SLOT_CONTROL_TOKEN: "secret" }))
      .toMatchObject({ start: "active", lockTimeoutMs: 10_000, drainTimeoutMs: 20_000 });
  });

  test("serializes activation, awaits stop before unlock, and permits rollback activation", async () => {
    let finish!: () => void;
    const stopping = new Promise<void>(resolve => { finish = resolve; });
    const { slot, events } = fixture({ stop: async () => { events.push("stop"); await stopping; } });
    await Promise.all([slot.activate(), slot.activate()]);
    expect(slot.status()).toMatchObject({ state: "active", term: 42 });
    const releasing = slot.release();
    await Bun.sleep(0);
    expect(events).toEqual(["lock", "fence", "start", "disconnect", "stop"]);
    expect(slot.state).toBe("draining");
    finish();
    await releasing;
    expect(events.at(-1)).toBe("unlock");
    await slot.activate();
    expect(slot.state).toBe("active");
    await slot.exit();
    expect(slot.state).toBe("exited");
    await expect(slot.activate()).rejects.toThrow();
  });

  test("activation failure cleans up and remains retryable without exiting", async () => {
    let fails = true;
    const { slot, events } = fixture({ fence: async () => { if (fails) throw new Error("fenced"); return 2; } });
    await expect(slot.activate()).rejects.toThrow("fenced");
    expect(slot.state).toBe("failed");
    expect(events).toEqual(["lock", "stop", "unlock"]);
    fails = false;
    await slot.activate();
    expect(slot.state).toBe("active");
    await slot.release();
  });

  test("only accepts the control token from an actual loopback socket", () => {
    const { slot } = fixture();
    const request = new Request("http://localhost/internal/slot/status", { headers: { Authorization: "Bearer test-secret", "X-Forwarded-For": "127.0.0.1" } });
    expect(slot.authorized(request, "127.0.0.1")).toBe(true);
    expect(slot.authorized(request, "10.0.0.2")).toBe(false);
    expect(slot.authorized(new Request(request.url), "127.0.0.1")).toBe(false);
    expect(slot.authorized(new Request(request.url, { headers: { Authorization: "test-secret" } }), "127.0.0.1")).toBe(false);
  });

  test("retains the role lock after a failed stop until release succeeds", async () => {
    let fails = true;
    const { slot, events } = fixture({ stop: async () => { if (fails) throw new Error("still running"); } });
    await slot.activate();
    await expect(slot.release()).rejects.toThrow("still running");
    expect(slot.state).toBe("draining");
    expect(events).not.toContain("unlock");
    await expect(slot.activate()).rejects.toThrow("release the previous activation");
    fails = false;
    await slot.release();
    expect(events.at(-1)).toBe("unlock");
    await slot.activate();
    expect(slot.state).toBe("active");
    await slot.exit();
  });

  test("server leaves jobs stopped in standby and restarts them on rollback activation", async () => {
    const store = createLocalStore();
    const scheduler = new MultiremiScheduler({ store });
    const start = spyOn(scheduler, "start").mockImplementation(() => {});
    const stop = spyOn(scheduler, "stop").mockImplementation(async () => {});
    const reconcile = spyOn(store, "reconcileRuntimeUpdateFailures");
    const server = startMultiremiServer({
      store, port: 0, hostname: "127.0.0.1", authToken: "request-token", slotConfiguration: config,
      backgroundJobs: true, scheduler, scmPolling: null, messaging: null, issueTitleScheduler: null,
      bodyHtmlBackfill: null, controlPlaneSshMesh: null,
    });
    try {
      await server.slotStartup;
      expect(start).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
      await server.slot!.activate();
      expect(start).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalled();
      await server.slot!.release();
      expect(stop).toHaveBeenCalledTimes(1);
      reconcile.mockClear();
      await server.slot!.activate();
      expect(start).toHaveBeenCalledTimes(2);
      expect(reconcile).toHaveBeenCalled();
      await server.stop(true);
      expect(server.slot!.state).toBe("exited");
    } finally {
      await server.shutdown();
      start.mockRestore();
      stop.mockRestore();
      reconcile.mockRestore();
    }
  });

  test("an unresponsive WebSocket close handshake cannot block shutdown", async () => {
    const store = createLocalStore();
    const server = startMultiremiServer({ store, port: 0, hostname: "127.0.0.1", authToken: "", backgroundJobs: false,
      slotConfiguration: { ...config, start: "active" } });
    const port = server.port!;
    const socket = connect(port, "127.0.0.1");
    try {
      await server.slotStartup;
      await new Promise<void>((resolve, reject) => {
        socket.on("error", reject);
        socket.once("data", data => {
          if (!data.toString().startsWith("HTTP/1.1 101")) reject(new Error("WebSocket did not upgrade"));
          else resolve();
        });
        socket.write("GET /ws?workspace_slug=local HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
      });
      await server.shutdown();
      expect(server.slot!.state).toBe("exited");
      const replacement = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("rebound") });
      await replacement.stop(true);
    } finally { socket.destroy(); await server.stop(true); }
  }, 5000);

  for (const mode of ["slot", "legacy"] as const) {
    test(`${mode}: real API completes a five-second HTTP handler during release/shutdown`, async () => {
      const store = createLocalStore();
      const issue = createResponsibleTestIssue(store, { title: "slow request" });
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const server = startMultiremiServer({
        store, port: 0, hostname: "127.0.0.1", authToken: "request-token", backgroundJobs: false,
        slotConfiguration: mode === "slot" ? { ...config, start: "active", drainTimeoutMs: 6000 } : null,
        issueRetitle: async () => {
          entered();
          await Bun.sleep(5000);
          return { title: "completed", previousTitle: "slow request", applied: true, reason: "generated" };
        },
      });
      try {
        await server.slotStartup;
        const response = fetch(new URL(`/api/multiremi/issues/${issue.id}/retitle`, server.url), {
          method: "POST", headers: { Authorization: "Bearer request-token", "Content-Type": "application/json" }, body: "{}",
        });
        await started;
        const releasing = mode === "slot"
          ? fetch(new URL("/internal/slot/release", server.url), { method: "POST", headers: { Authorization: "Bearer test-secret" } })
          : server.shutdown();
        await Bun.sleep(30);
        expect((await fetch(new URL("/readyz", server.url))).status).toBe(503);
        const result = await response;
        expect(result.status).toBe(200);
        expect(await result.json()).toMatchObject({ title: "completed" });
        await releasing;
        if (mode === "slot") expect(server.slot?.state).toBe("released");
      } finally { await server.shutdown(); }
    }, 12_000);
  }

  test("waits for a slow HTTP response body before disconnecting daemon RPC", async () => {
    const { slot, events } = fixture();
    await slot.activate();
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => slot.request(req, () => {
      entered();
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode("first"));
        finish = () => { controller.enqueue(new TextEncoder().encode("last")); controller.close(); };
      } }));
    }) });
    try {
      const response = fetch(server.url).then(r => r.text());
      await started;
      const release = slot.release();
      await Bun.sleep(30);
      expect(events).not.toContain("disconnect");
      finish();
      expect(await response).toBe("firstlast");
      await release;
      expect(events.slice(-3)).toEqual(["disconnect", "stop", "unlock"]);
    } finally { await server.stop(true); }
  });

  test("SSE does not consume drain budget, ordinary stuck responses respect the deadline", async () => {
    const { slot } = fixture();
    await slot.activate();
    const stream = new ReadableStream();
    const response = await slot.request(new Request("http://localhost/events"), () => new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    const start = performance.now();
    await slot.release();
    expect(performance.now() - start).toBeLessThan(100);
    await response.body?.cancel();
    const bounded = new SlotLifecycle({ ...config, drainTimeoutMs: 30 }, "test", {
      acquire: async () => ({ close: async () => {} }), start: () => {}, stop: () => {}, disconnect: () => {},
    });
    await bounded.activate();
    const ordinary = await bounded.request(new Request("http://localhost/slow"), () => new Response(new ReadableStream()));
    await bounded.release();
    expect(bounded.state).toBe("released");
    await ordinary.body?.cancel();
  });

  test("release closes SSE so graceful listener shutdown can finish", async () => {
    const { slot } = fixture();
    await slot.activate();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => slot.request(req, () => new Response(
      new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("data: hello\n\n")); } }),
      { headers: { "Content-Type": "text/event-stream" } },
    )) });
    try {
      const response = await fetch(server.url);
      const body = response.text();
      await slot.release();
      expect(await body).toBe("data: hello\n\n");
      await server.stop(false);
    } finally { await server.stop(true); }
  });
});
