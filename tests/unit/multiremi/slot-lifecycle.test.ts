import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { SlotLifecycle, resolveSlotConfiguration, type SlotHooks } from "@multiremi/api/slot-lifecycle.js";
import { startMultiremiServer } from "@multiremi/api.js";
import { createLocalStore, createResponsibleTestIssue, resetMultiremiTestEnv } from "./helpers.js";
import { MultiremiScheduler } from "@daemon/scheduler.js";
import { connect } from "node:net";
import { databaseTimeoutMs } from "@shared/db/recovery.js";

afterEach(resetMultiremiTestEnv);

const config = { id: "blue", start: "standby" as const, controlToken: "test-secret", lockTimeoutMs: 1000, drainTimeoutMs: 1000 };
function fixture(overrides: Partial<SlotHooks> = {}) {
  const events: string[] = [];
  const slot = new SlotLifecycle({ ...config }, "test-version", {
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
      .toMatchObject({ start: "active", lockTimeoutMs: 10_000, drainTimeoutMs: 20_000, stopTimeoutMs: 5_000 });
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
    expect(events).toEqual(["lock", "unlock"]);
    fails = false;
    await slot.activate();
    expect(slot.state).toBe("active");
    await slot.release();
  });

  test("timed-out asynchronous startup retains ownership until startup and cleanup settle", async () => {
    let finish!: () => void;
    const starting = new Promise<void>(resolve => { finish = resolve; });
    const { slot, events } = fixture({ start: () => starting });
    slot.config.lockTimeoutMs = 30;
    await expect(slot.activate()).rejects.toThrow("activation_timeout");
    expect(slot.state).toBe("failed");
    expect(events).not.toContain("unlock");
    await expect(slot.release()).rejects.toThrow("activation cleanup pending");
    finish();
    await Bun.sleep(5);
    expect(events.slice(-2)).toEqual(["stop", "unlock"]);
    expect(slot.state).toBe("failed");
    await slot.release();
    expect(slot.state).toBe("released");
    slot.config.lockTimeoutMs = 1000;
  });

  for (const stage of ["acquire", "fence", "start"] as const) {
    test(`checks the absolute deadline after synchronous ${stage} blocks timer delivery`, async () => {
      const block = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
      const { slot, events } = fixture({
        [stage]: stage === "acquire" ? async () => {
          block();
          return { close: async () => { events.push("unlock"); } };
        } : stage === "fence" ? async () => { block(); return 7; }
          : () => { events.push("start"); block(); },
      });
      slot.config.lockTimeoutMs = 30;
      await expect(slot.activate()).rejects.toThrow("activation_timeout");
      await Bun.sleep(5);
      expect(slot.status()).toMatchObject({ state: "failed" });
      expect(slot.term).toBeNull();
      expect(events.at(-1)).toBe("unlock");
      if (stage !== "start") expect(events).not.toContain("start");
      else expect(events.slice(-3)).toEqual(["start", "stop", "unlock"]);
    });
  }

  test("SQL budget shrinks across fence calls and startup descendants regain their own budget", async () => {
    let descendant!: Promise<number | undefined>;
    let first = 0;
    let second = 0;
    const { slot } = fixture({
      fence: async () => {
        first = databaseTimeoutMs()!;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
        second = databaseTimeoutMs()!;
        return 7;
      },
      start: () => {
        // Preserve the actual inherited async context, as a job timer would.
        descendant = new Promise(resolve => setTimeout(() => resolve(databaseTimeoutMs()), 150));
      },
    });
    slot.config.lockTimeoutMs = 100;
    await slot.activate();
    expect(first - second).toBeGreaterThanOrEqual(20);
    expect(await descendant).toBeUndefined();
    expect(databaseTimeoutMs()).toBeUndefined();
    await slot.release();
  });

  test("an asynchronous fence uses only the budget left after synchronous acquisition", async () => {
    const { slot, events } = fixture({
      acquire: async () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        return { close: async () => { events.push("unlock"); } };
      },
      fence: async () => { await Bun.sleep(500); return 7; },
    });
    slot.config.lockTimeoutMs = 150;
    const started = performance.now();
    await expect(slot.activate()).rejects.toThrow("activation_timeout");
    expect(performance.now() - started).toBeLessThan(220);
    expect(events).toEqual(["unlock"]);
    expect(slot.state).toBe("failed");
  });

  test("HTTP timeout retains the intact activation even after requests finish until rollback or exit", async () => {
    let pending = 1;
    const { slot, events } = fixture({ pendingRequests: () => pending });
    slot.config.drainTimeoutMs = 20;
    await slot.activate();
    await expect(slot.release()).rejects.toThrow("drain_timeout");
    pending = 0;
    await expect(slot.release()).rejects.toThrow("drain_timeout");
    expect(events).toEqual(["lock", "fence", "start"]);
    await slot.activate();
    expect(slot.status()).toMatchObject({ state: "active", term: 42 });
    expect(events).toEqual(["lock", "fence", "start"]);
    await slot.exit();
    expect(events.slice(-3)).toEqual(["disconnect", "stop", "unlock"]);
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

  test("release excludes its own control request from the native drain count", async () => {
    const server = startMultiremiServer({ store: createLocalStore(), port: 0, hostname: "127.0.0.1",
      backgroundJobs: false, slotConfiguration: { ...config, start: "active", drainTimeoutMs: 6000 } });
    try {
      await server.slotStartup;
      const started = performance.now();
      const response = await fetch(new URL("/internal/slot/release", server.url), {
        method: "POST", headers: { Authorization: "Bearer test-secret" }, signal: AbortSignal.timeout(2000),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ state: "released" });
      expect(performance.now() - started).toBeLessThan(1000);
    } finally { await server.shutdown(); }
  });

  test("ordinary responses preserve native body identity", async () => {
    const { slot } = fixture();
    const response = new Response("native body");
    expect(await slot.request(new Request("http://localhost/"), () => response)).toBe(response);
  });

  test("hung network jobs fail release within budget and retain ownership until retry", async () => {
    const store = createLocalStore();
    const scheduler = new MultiremiScheduler({ store });
    let finish!: () => void;
    const running = new Promise<void>(resolve => { finish = resolve; });
    const start = spyOn(scheduler, "start").mockImplementation(() => {});
    const stop = spyOn(scheduler, "stop").mockImplementation(() => running);
    const server = startMultiremiServer({ store, port: 0, hostname: "127.0.0.1", backgroundJobs: true,
      scmPolling: null, messaging: null, issueTitleScheduler: null, bodyHtmlBackfill: null, controlPlaneSshMesh: null,
      scheduler, slotConfiguration: { ...config, start: "active", stopTimeoutMs: 30 } });
    try {
      await server.slotStartup;
      const started = performance.now();
      await expect(server.slot!.release()).rejects.toThrow("background job stop timed out");
      expect(performance.now() - started).toBeLessThan(500);
      expect(server.slot!.state).toBe("draining");
      await expect(server.slot!.activate()).rejects.toThrow("release the previous activation");
      finish();
      await server.slot!.release();
      await server.slot!.activate();
      expect(server.slot!.state).toBe("active");
    } finally { finish(); await server.shutdown(); start.mockRestore(); stop.mockRestore(); }
  });

  test("a second shutdown signal forces exit while graceful stop is pending", async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", "tests/fixtures/slot-shutdown-signals.ts"], { stdout: "pipe", stderr: "pipe" });
    let output = "";
    const read = (async () => { for await (const chunk of child.stdout) output += new TextDecoder().decode(chunk); })();
    const waitFor = async (text: string) => {
      const deadline = Date.now() + 5000;
      while (!output.includes(text) && Date.now() < deadline) await Bun.sleep(10);
      expect(output).toContain(text);
    };
    try {
      await waitFor("ready");
      child.kill("SIGINT");
      await waitFor("stopping");
      expect(child.exitCode).toBeNull();
      child.kill("SIGINT");
      expect(await Promise.race([child.exited, Bun.sleep(3000).then(() => "timeout")])).toBe(1);
    } finally { child.kill(); await child.exited; await read; }
  }, 10_000);

  for (const mode of ["body", "slot", "legacy"]) {
    test(`${mode}: pipelined requests and socket resets cannot crash Bun`, async () => {
      for (let run = 0; run < 3; run++) {
        const child = Bun.spawn([process.execPath, "--no-env-file", "tests/fixtures/slot-disconnect-stress.ts", mode], {
          env: { ...process.env, MULTIREMI_DATABASE_URL: "", MULTIREMI_SLOT: "", MULTIREMI_SLOT_START: "" },
          stdout: "pipe", stderr: "pipe",
        });
        const stdout = new Response(child.stdout).text();
        const stderr = new Response(child.stderr).text();
        try {
          const result = await Promise.race([child.exited, Bun.sleep(12_000).then(() => "timeout")]);
          expect(result, result === "timeout" ? "stress child timed out" : await stderr).toBe(0);
          const report = JSON.parse((await stdout).trim().split("\n").at(-1)!);
          expect(report.resets).toBeGreaterThan(500);
          if (mode === "body") expect(report.handled).toBeGreaterThan(500);
          console.info(`[disconnect-stress] ${mode} run ${run + 1}: ${JSON.stringify(report)}`);
        } finally { child.kill(); await child.exited; }
      }
    }, 40_000);
  }

  test("waits for a slow HTTP response body before disconnecting daemon RPC", async () => {
    const { slot, events } = fixture({ pendingRequests: () => server.pendingRequests });
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
      pendingRequests: () => 1,
      acquire: async () => ({ close: async () => {} }), start: () => {}, stop: () => {}, disconnect: () => {},
    });
    await bounded.activate();
    const ordinary = await bounded.request(new Request("http://localhost/slow"), () => new Response(new ReadableStream()));
    await expect(bounded.release()).rejects.toThrow("drain_timeout");
    expect(bounded.state).toBe("draining");
    await bounded.activate();
    expect(bounded.state).toBe("active");
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
