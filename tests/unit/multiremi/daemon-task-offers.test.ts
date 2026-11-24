import { DEFAULT_SYSTEM_PROMPT_CONTENT } from "@multiremi/contracts/system-prompt-policy.js";
import { CURRENT_SYSTEM_PROMPT_DEFAULT, hashSystemPromptContent } from "@shared/system-prompt-policy-hash.js";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { fitTaskOfferToBudget } from "@multiremi/api/daemon-protocol/offer-budget.js";
import { currentBackgroundTerm, withBackgroundTerm, StaleLiveTermError } from "@shared/db/live-term.js";
import { DatabaseUnavailableError } from "@shared/db/recovery.js";
import { createResponsibleTestIssue } from './helpers.js';
import { afterEach, describe, expect, it, spyOn, setSystemTime } from "bun:test";
import { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import { DAEMON_OFFER_SWEEP_MS, DaemonTaskOffers, daemonTurnOfferPayload } from "@multiremi/api/daemon-protocol/task-offers.js";
import { ManualDaemonProtocolClock } from "@multiremi/api/daemon-protocol/clock.js";
import { DAEMON_MIN_CLI_VERSION, DAEMON_OFFER_COOLDOWN_MS, DAEMON_OFFER_TIMEOUT_MS } from "@multiremi/contracts/daemon-protocol.js";
import type { MultiremiTaskWithAgent } from "@multiremi/contracts/types.js";
import { createLocalStore, resetMultiremiTestEnv, db } from "./helpers.js";

const layers: DaemonProtocolLayer[] = [];
afterEach(async () => {
  for (const layer of layers.splice(0)) { layer.closeAll(); layer.stop(); await layer.drain(); }
  resetMultiremiTestEnv();
});

function fixture(prepare?: (task: MultiremiTaskWithAgent) => Promise<Record<string, unknown> | null>, runtimeCount = 1, sweepMs?: number, metrics = false, autostart = true) {
  const store = createLocalStore();
  const runtimeIds = Array.from({ length: runtimeCount }, (_, index) => {
    const id = `rt_offer_${index}`;
    store.registerRuntime({ id, name: id, daemonId: "dmn_offer", workspaceId: "local", provider: "claude",
      ownerId: "local", status: "online", maxConcurrency: 1, metadata: { parallel_agent_execution: 1 } });
    return id;
  });
  const agentIds = runtimeIds.map(runtimeId => store.createAgent({ name: runtimeId, runtimeId,
    provider: "claude", workspaceId: "local" }).id);
  const clock = new ManualDaemonProtocolClock(Date.now());
  const layer = new DaemonProtocolLayer({ store, metrics: metrics ? { enabled: true,
    summaryIntervalMs: 2_147_483_647, summaryTopTypes: 20, bufferCapacity: 4096 } : undefined });
  layers.push(layer);
  const offers = new DaemonTaskOffers({ store, layer, clock, sweepMs, autostart,
    prepare: async task => {
      const execution = prepare ? await prepare(task)
        : { runtime_id: task.runtimeId, auth_token: "fixture-capability" };
      return execution ? daemonTurnOfferPayload(execution, store.getDaemonTurnBridge().offerInput(task)) : null;
    } });
  const frames: Record<string, any>[] = [];
  let sendStatus: number | null = null;
  const session = layer.openSession({ send: text => { frames.push(JSON.parse(text)); return sendStatus ?? text.length; }, close() {} },
    { accessToken: null, masterToken: true });
  const send = (t: string, p: unknown, fields: Record<string, unknown> = {}) => session.handleMessage(JSON.stringify({ v: 2, t, p, ...fields }));
  const hello = async () => {
    await send("hello", { protocol: 2, daemon_id: "dmn_offer", cli_version: DAEMON_MIN_CLI_VERSION, caps: ["offer"],
      runtimes: runtimeIds.map(runtime_id => ({ runtime_id, provider: "claude", max_concurrency: 1, active_task_ids: [] })) });
    await layer.drain();
  };
  const task = (index = 0, prompt = "no-op") => store.createTask({ agentId: agentIds[index]!, prompt, maxAttempts: 1 });
  const offered = () => frames.filter(frame => frame.t === "task.offer");
  const accept = async (frame = offered().at(-1)!) => {
    await send("res", { ok: true }, { re: String(frame.seq), ack: frame.seq });
    await layer.drain();
  };
  return { store, runtimeIds, agentIds, clock, layer, offers, session, send, hello, task, offered, frames, accept,
    setSendStatus: (value: number | null) => { sendStatus = value; } };
}

describe("A-3 task offers", () => {
  for (const fenced of [false, true]) {
    for (const accepted of [false, true]) {
      it(`persists an ${accepted ? "accepted" : "explicitly rejected"} offer with ${fenced ? "an active" : "no"} term`, async () => {
        const h = fixture(undefined, 1, undefined, false, false);
        const task = h.task();
        const term = fenced ? h.store.activateBackgroundTerm("single:test", () => {}) : undefined;
        withBackgroundTerm(term, () => h.offers.start());
        await h.hello();
        const offer = h.offered()[0]!;
        expect(offer.p.attempt_id).toBe(task.id);
        await h.send("res", accepted ? { ok: true } : { ok: false, code: "binary_skill_files_unsupported" },
          { re: String(offer.seq), ack: offer.seq });
        await h.layer.drain();
        const persisted = h.store.getTask(task.id)!;
        expect(persisted.status).toBe(accepted ? "dispatched" : "queued");
        if (accepted) expect(persisted.acceptedAt).toBeString();
        else expect(persisted).toMatchObject({ acceptedAt: null, offeredAt: null });
      });
    }
  }

  for (const accepted of [false, true]) {
    it(`rejects a stale term's ${accepted ? "accept" : "requeue"} SQL after takeover`, async () => {
      const h = fixture(undefined, 1, undefined, false, false);
      const task = h.task();
      let losses = 0;
      const a = h.store.activateBackgroundTerm("A", () => { losses++; });
      withBackgroundTerm(a, () => h.offers.start());
      await h.hello();
      const offer = h.offered()[0]!;
      const before = h.store.getTask(task.id);
      h.store.activateBackgroundTerm("B", () => {});
      expect(() => withBackgroundTerm(a, () => accepted
        ? h.store.acceptTaskOffer(task.id, h.runtimeIds[0]!)
        : h.store.requeueTaskOffer(task.id, h.runtimeIds[0]!, "rejected"))).toThrow(StaleLiveTermError);
      await h.send("res", { ok: accepted }, { re: String(offer.seq), ack: offer.seq });
      await h.layer.drain();
      expect(losses).toBe(1);
      expect(h.store.getTask(task.id)).toEqual(before);
    });
  }

  it("binds a hello pump and its paused preparation to the activation that started offers", async () => {
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const preparing = new Promise<void>(resolve => { entered = resolve; });
    let observed: ReturnType<typeof currentBackgroundTerm>;
    const h = fixture(async () => {
      observed = currentBackgroundTerm();
      entered();
      await paused;
      return { auth_token: "fixture" };
    }, 1, undefined, false, false);
    const task = h.task();
    let losses = 0;
    const a = h.store.activateBackgroundTerm("A", () => { losses++; });
    withBackgroundTerm(a, () => h.offers.start());
    const hello = h.hello(); // WebSocket callback has no inherited background term.
    try {
      await preparing;
      expect(observed).toBe(a);
      h.store.activateBackgroundTerm("B", () => {});
    } finally { release(); }
    await hello;
    expect(h.offered()).toHaveLength(0);
    expect(h.store.getTask(task.id)).toMatchObject({ status: "dispatched", offeredAt: null });
    expect(losses).toBe(1);
  });

  it("fences offered_at if takeover happens inside the transport send", async () => {
    const h = fixture(undefined, 1, undefined, false, false);
    const task = h.task();
    let losses = 0;
    const a = h.store.activateBackgroundTerm("A", () => { losses++; });
    withBackgroundTerm(a, () => h.offers.start());
    const original = h.session.sendEvent.bind(h.session);
    const send = spyOn(h.session, "sendEvent").mockImplementation((...args) => {
      const sent = original(...args);
      if (args[0].t === "task.offer") h.store.activateBackgroundTerm("B", () => {});
      return sent;
    });
    try {
      await h.hello();
      // The send precedes takeover, but its SQL continuation must not commit.
      expect(h.offered()).toHaveLength(1);
      expect(h.store.getTask(task.id)?.offeredAt).toBeNull();
      expect(losses).toBe(1);
    } finally { send.mockRestore(); }
  });

  for (const timer of ["rescind", "database retry", "scheduled retry"] as const) {
    it(`fences a ${timer} timer fired outside async context after takeover`, async () => {
      const h = fixture(undefined, 1, undefined, false, false);
      const task = timer === "database retry" ? null : h.task();
      const a = h.store.activateBackgroundTerm("A", () => {});
      withBackgroundTerm(a, () => h.offers.start());
      if (timer === "database retry") await h.hello();
      const retryTask = task ?? h.task();
      const claim = spyOn(h.store, "claimTask");
      const requeue = spyOn(h.store, "requeueTaskOffer");
      const runtime = h.store.getRuntimeLite.bind(h.store);
      const probe = spyOn(h.store, "getRuntimeLite").mockImplementation((...args) => {
        if (timer === "database retry") throw new DatabaseUnavailableError();
        return runtime(...args);
      });
      try {
        if (timer === "database retry") {
          h.offers.kick();
          await h.layer.drain();
          expect(probe).toHaveBeenCalled();
          expect(h.clock.pendingTimerCount).toBe(2); // sweep plus database retry
        } else await h.hello();
        if (timer === "scheduled retry") h.offers.enqueued({ ...retryTask,
          nextRetryAt: new Date(h.clock.now() + 1_000).toISOString() });
        const before = h.store.getTask(retryTask.id);
        h.store.activateBackgroundTerm("B", () => {});
        claim.mockClear(); requeue.mockClear();
        h.clock.advance(DAEMON_OFFER_TIMEOUT_MS + DAEMON_OFFER_COOLDOWN_MS);
        await h.layer.drain();
        expect(claim).not.toHaveBeenCalled();
        expect(requeue).not.toHaveBeenCalled();
        expect(h.store.getTask(retryTask.id)).toEqual(before);
      } finally { claim.mockRestore(); requeue.mockRestore(); probe.mockRestore(); }
    });
  }

  it("does not let an old activation callback kick offers after a restart", async () => {
    const h = fixture(undefined, 1, undefined, false, false);
    const a = h.store.activateBackgroundTerm("A", () => {});
    withBackgroundTerm(a, () => h.offers.start());
    await h.hello();
    await h.offers.stop();
    const b = h.store.activateBackgroundTerm("A", () => {});
    withBackgroundTerm(b, () => h.offers.start());
    const task = h.task();
    withBackgroundTerm(a, () => h.offers.enqueued(task));
    await h.layer.drain();
    expect(h.offered()).toHaveLength(0);
    h.offers.enqueued(task);
    await h.layer.drain();
    expect(h.offered()).toHaveLength(1);
  });

  it("workspace wakeups retain queued hosts and unassigned admission without checking idle hosts", async () => {
    const h = fixture(undefined, 2);
    await h.hello();
    const task = h.task(1);
    const kick = spyOn(h.offers, "kick").mockImplementation(() => {});
    try {
      h.offers.kickWorkspace("local");
      expect(kick.mock.calls.map(([id]) => id)).toEqual([h.runtimeIds[1]]);
      // Unassigned queued work must still try all connected hosts.
      db!.run("UPDATE multiremi_turn_attempts SET runtime_id=NULL WHERE id=?", [task.id]);
      kick.mockClear();
      h.offers.kickWorkspace("local");
      expect(kick.mock.calls.map(([id]) => id).sort()).toEqual([...h.runtimeIds].sort());
      db!.run("UPDATE multiremi_turn_attempts SET status='cancelled' WHERE id=?", [task.id]);
      kick.mockClear();
      h.offers.kickWorkspace("local");
      expect(kick).not.toHaveBeenCalled();
    } finally { kick.mockRestore(); }
  });

  it("backs off an unavailable database and resumes offers on the same session", async () => {
    const h = fixture();
    const task = h.task();
    await h.hello();
    await h.accept();
    h.store.startTask(task.id);
    h.store.completeTask(task.id, { output: "done" });
    const next = h.task();
    const original = h.store.getRuntimeLite.bind(h.store);
    let attempts = 0;
    const probe = spyOn(h.store, "getRuntimeLite").mockImplementation((...args) => {
      attempts++;
      if (attempts <= 2) throw new DatabaseUnavailableError();
      return original(...args);
    });
    try {
      h.offers.kick(); await h.layer.drain();
      expect(attempts).toBe(1);
      h.clock.advance(999); await h.layer.drain();
      expect(attempts).toBe(1);
      h.clock.advance(1); await h.layer.drain();
      expect(attempts).toBe(2);
      h.clock.advance(1999); await h.layer.drain();
      expect(attempts).toBe(2);
      h.clock.advance(1); await h.layer.drain();
      expect(h.offered().at(-1)!.p.attempt_id).toBe(next.id);
    } finally { probe.mockRestore(); }
  });

  it("dispatches irreducible structure that exceeds the soft budget but fits the actual protocol hard limit", async () => {
    const h = fixture(async task => ({ id: task.id, prompt: task.prompt, repos: new Array(300_000).fill(0) }));
    const task = h.task(); await h.hello();
    expect(h.offered()[0]!.p.attempt_id).toBe(task.id);
    expect(Buffer.byteLength(JSON.stringify(h.offered()[0]))).toBeGreaterThan(512 * 1024);
    expect(Buffer.byteLength(JSON.stringify(h.offered()[0]))).toBeLessThan(1_048_576);
    expect(h.store.getTask(task.id)).toMatchObject({ status: "dispatched", failureReason: null });
  });

  it("folds a pathological repository URL and releases the runtime for its next task", async () => {
    const h = fixture(async task => ({ id: task.id, prompt: task.prompt, auth_token: "fixture-capability",
      agent: { id: task.agentId }, repos: [{ url: task.prompt === "huge" ? "x".repeat(1_100_000) : "https://github.com/example/repo.git" }] }));
    const huge = h.task(0, "huge"); const next = h.task();
    await h.hello();
    expect(h.offered()[0]!.p.attempt_id).toBe(huge.id);
    expect(h.offered()[0]!.p.repos[0].url).toContain("还有");
    expect(h.offered()[0]!.p.auth_token).toBe("fixture-capability");
    expect(h.offered()[0]!.p.agent.id).toBe(huge.agentId);
    expect(Buffer.byteLength(JSON.stringify(h.offered()[0]))).toBeLessThan(1_048_576);
    await h.accept(); h.store.startTask(huge.id); h.store.completeTask(huge.id, { output: "done" });
    h.offers.kick(); await h.layer.drain();
    expect(h.offered().map(frame => frame.p.attempt_id)).toEqual([huge.id, next.id]);
  });

  it("fails only irreducible structure with size diagnostics and continues the same runtime queue", async () => {
    const h = fixture(async task => ({ id: task.id, prompt: task.prompt,
      repos: task.prompt === "structure" ? new Array(600_000).fill(0) : [] }));
    const issue = createResponsibleTestIssue(h.store, { title: "Structural capacity", status: "in_progress" });
    const huge = h.store.createTask({ agentId: h.agentIds[0]!, issueId: issue.id, prompt: "structure", maxAttempts: 3 });
    const next = h.task(); await h.hello();
    expect(h.store.getTask(huge.id)).toMatchObject({ status: "failed", failureReason: "offer_too_large" });
    expect(h.store.getTask(huge.id)!.error).toContain("parts=repos:");
    expect(h.store.getIssue(issue.id)!.status).not.toBe("blocked");
    expect(h.offered().map(frame => frame.p.attempt_id)).toEqual([next.id]);
    await h.accept();
    h.clock.advance(120_000); h.offers.kick(); await h.layer.drain();
    expect(h.offered().map(frame => frame.p.attempt_id)).toEqual([next.id]);
    expect(h.store.listTasks().filter(task => task.issueId === issue.id)).toHaveLength(1);
  });

  it("degrades an oversized offer and dispatches without failing or blocking the Issue", async () => {
    const h = fixture(async task => ({ id: task.id, prompt: "触发".repeat(200_000),
      issue: { id: task.issueId, description: "description".repeat(100_000) },
      repository_wiki_contexts: [{ docs: [{ body: "wiki".repeat(200_000) }] }] }));
    const issue = createResponsibleTestIssue(h.store, { title: "Oversized offer" });
    const task = h.store.createTask({ agentId: h.agentIds[0]!, issueId: issue.id, prompt: "触发".repeat(200_000) });
    await h.hello();
    expect(h.offered()).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(h.offered()[0]))).toBeLessThan(512 * 1024);
    expect(h.offered()[0]!.p.knowledge_warnings.join("\n")).toContain("1 页暂不可用");
    expect(h.store.getTask(task.id)?.status).toBe("dispatched");
    expect(h.store.getIssue(issue.id)?.status).not.toBe("blocked");
  });
  it("clears only capacity cooldown when the active count changes on heartbeat", async () => {
    const h = fixture(); const task = h.task(); await h.hello();
    const first = h.offered()[0]!;
    await h.send("hb", { active_task_count: 1 }); await h.layer.drain();
    await h.send("res", { ok: false, code: "capacity" }, { re: String(first.seq), ack: first.seq });
    await h.layer.drain();
    expect(h.store.getTask(task.id)).toMatchObject({ status: "queued", offeredAt: null, acceptedAt: null });
    expect(h.offered()).toHaveLength(1);
    await h.send("hb", { active_task_count: 0 }); await h.layer.drain();
    expect(h.offered().map(frame => frame.p.attempt_id)).toEqual([task.id, task.id]);
    expect(h.clock.now()).toBeLessThan(Date.now() + DAEMON_OFFER_COOLDOWN_MS);
  });

  it("bounds full-capacity offers and falls back to 30 seconds when release heartbeat is lost", async () => {
    const h = fixture(); h.task(); await h.hello();
    await h.send("hb", { active_task_count: 1 }); await h.layer.drain();
    const startedAt = h.clock.now();
    for (let attempt = 0; attempt < 2; attempt++) {
      const offer = h.offered().at(-1)!;
      await h.send("res", { ok: false, code: "capacity" }, { re: String(offer.seq), ack: offer.seq });
      await h.layer.drain();
      h.clock.advance(DAEMON_OFFER_COOLDOWN_MS - 1); await h.layer.drain();
      expect(h.offered()).toHaveLength(attempt + 1);
      h.clock.advance(1); await h.layer.drain();
    }
    expect(h.clock.now() - startedAt).toBe(60_000);
    expect(h.offered()).toHaveLength(3);
  });

  for (const reason of ["draining", "claims_paused", "binary_skill_files_unsupported"] as const) {
    it(`keeps ${reason} rejection on the full cooldown despite a changed heartbeat`, async () => {
      const h = fixture(); const task = h.task(); await h.hello();
      const first = h.offered()[0]!;
      await h.send("hb", { active_task_count: 1 }); await h.layer.drain();
      await h.send("res", { ok: false, code: reason }, { re: String(first.seq), ack: first.seq });
      await h.layer.drain();
      expect(h.store.getTask(task.id)).toMatchObject({ status: "queued", offeredAt: null, acceptedAt: null });
      await h.send("hb", { active_task_count: 0 }); await h.layer.drain();
      h.clock.advance(DAEMON_OFFER_COOLDOWN_MS - 1); await h.layer.drain();
      expect(h.offered()).toHaveLength(1);
      h.clock.advance(1); await h.layer.drain();
      expect(h.offered()).toHaveLength(2);
    });
  }

  it("does not clear a timed-out offer cooldown on changed heartbeat", async () => {
    const h = fixture(); const task = h.task(); await h.hello();
    await h.send("hb", { active_task_count: 1 }); await h.layer.drain();
    h.clock.advance(DAEMON_OFFER_TIMEOUT_MS); await h.layer.drain();
    expect(h.store.getTask(task.id)).toMatchObject({ status: "queued", acceptedAt: null });
    expect(h.store.getTask(task.id)?.offeredAt).toBeString();
    await h.send("hb", { active_task_count: 0 }); await h.layer.drain();
    h.clock.advance(DAEMON_OFFER_COOLDOWN_MS - 1); await h.layer.drain();
    expect(h.offered()).toHaveLength(1);
    h.clock.advance(1); await h.layer.drain();
    expect(h.offered()).toHaveLength(2);
  });

  it("keeps disconnect cooldown through a new hello and changed heartbeat", async () => {
    const h = fixture(); const task = h.task(); await h.hello();
    h.session.handleSocketClose();
    expect(h.store.getTask(task.id)).toMatchObject({ status: "queued", acceptedAt: null });
    expect(h.store.getTask(task.id)?.offeredAt).toBeString();
    const reconnected = h.layer.openSession({ send: text => { h.frames.push(JSON.parse(text)); return text.length; }, close() {} },
      { accessToken: null, masterToken: true });
    await reconnected.handleMessage(JSON.stringify({ v: 2, t: "hello", p: { protocol: 2,
      daemon_id: "dmn_offer", cli_version: DAEMON_MIN_CLI_VERSION, caps: ["offer"],
      runtimes: [{ runtime_id: h.runtimeIds[0], provider: "claude", max_concurrency: 1, active_task_ids: [] }] } }));
    await reconnected.handleMessage(JSON.stringify({ v: 2, t: "hb", p: { active_task_count: 0 } }));
    await h.layer.drain();
    h.clock.advance(DAEMON_OFFER_COOLDOWN_MS - 1); await h.layer.drain();
    expect(h.offered()).toHaveLength(1);
    h.clock.advance(1); await h.layer.drain();
    expect(h.offered()).toHaveLength(2);
  });

  it("recovers missed queue events with the production default sweep and increments the summary counter", async () => {
    const previous = process.env.NODE_ENV;
    let h: ReturnType<typeof fixture>;
    try {
      process.env.NODE_ENV = "production";
      h = fixture(undefined, 1, undefined, true);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
    await h.hello(); const task = h.task();
    const metric = spyOn(h.layer, "recordOfferSweepRecovery");
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      h.clock.advance(DAEMON_OFFER_SWEEP_MS - 1); await h.layer.drain();
      expect(h.offered()).toHaveLength(0); expect(metric).not.toHaveBeenCalled();
      h.clock.advance(1); await h.layer.drain();
      expect(h.offered().map(frame => frame.p.attempt_id)).toEqual([task.id]);
      expect(metric).toHaveBeenCalledTimes(1);
      h.layer.flushMetrics();
      expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
        event: "ws_minute_summary", offer_sweep_recovered: 1,
      });
      h.layer.flushMetrics();
      expect(JSON.parse(log.mock.calls[1]![0] as string).offer_sweep_recovered).toBe(0);
      expect(JSON.parse(warn.mock.calls[0]![0] as string)).toEqual({
        event: "daemon_offer_sweep_recovered", runtime_id: h.runtimeIds[0], task_id: task.id,
      });
    } finally { metric.mockRestore(); warn.mockRestore(); log.mockRestore(); }
  });

  it("sweeps online runtimes at 60s, records recovered work and skips a pending offer", async () => {
    const h = fixture(undefined, 1, DAEMON_OFFER_SWEEP_MS); await h.hello(); const task = h.task();
    const metric = spyOn(h.layer, "recordOfferSweepRecovery");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      h.clock.advance(59_999); await h.layer.drain(); expect(h.offered()).toHaveLength(0);
      h.clock.advance(1); await h.layer.drain();
      expect(h.offered()[0]!.p.attempt_id).toBe(task.id); expect(metric).toHaveBeenCalledTimes(1);
      expect(JSON.parse(warn.mock.calls[0]![0] as string)).toEqual({
        event: "daemon_offer_sweep_recovered", runtime_id: h.runtimeIds[0], task_id: task.id,
      });
      h.offers.kick(h.runtimeIds[0], true); await h.layer.drain();
      expect(h.offered()).toHaveLength(1); expect(metric).toHaveBeenCalledTimes(1);
      h.layer.stop(); h.clock.advance(60_000); await h.layer.drain();
      expect(h.offered()).toHaveLength(1);
    } finally { metric.mockRestore(); warn.mockRestore(); }
  });

  it("hello offers the existing queue, with the claim payload and capability intact", async () => {
    const h = fixture(); const task = h.task(); await h.hello();
    expect(h.offered()).toHaveLength(1);
    expect(h.offered()[0]!.p).toMatchObject({ turn_id: h.store.getTurnForAttempt(task.id)!.id,
      attempt_id: task.id, auth_token: "fixture-capability" });
    expect(h.offered()[0]!.p.input_messages).toHaveLength(1);
    expect(h.offered()[0]!.p.input_messages[0].body_md).toContain(task.prompt);
    expect(h.offered()[0]!.p).not.toHaveProperty("id");
    expect(h.offered()[0]!.p).not.toHaveProperty("prompt");
    expect(h.store.getTask(task.id)?.offeredAt).not.toBeNull();
    await h.accept();
    expect(h.store.getTask(task.id)?.acceptedAt).not.toBeNull();
  });

  it("keeps preparation single-flight when enqueue kicks overlap", async () => {
    let release!: () => void; let calls = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = fixture(async task => { calls++; await gate; return { id: task.id }; });
    await h.hello(); h.task();
    const claim = spyOn(h.store, "claimTask");
    try {
      for (let i = 0; i < 20; i++) h.offers.kick(h.runtimeIds[0]);
      await Bun.sleep(0);
      expect(calls).toBe(1); expect(claim).toHaveBeenCalledTimes(1);
      release(); await h.layer.drain();
      expect(calls).toBe(1); expect(h.offered()).toHaveLength(1);
    } finally { release(); await h.layer.drain(); claim.mockRestore(); }
  });

  it("requeues a declined preparation and retries the same attempt after cooldown", async () => {
    let decline = true;
    const h = fixture(async task => decline ? null : { id: task.id });
    const task = h.task();
    await h.hello();
    expect(h.store.getTask(task.id)).toMatchObject({ status: "queued", offeredAt: null, acceptedAt: null });
    expect(h.offered()).toHaveLength(0);
    decline = false;
    h.clock.advance(DAEMON_OFFER_COOLDOWN_MS - 1); await h.layer.drain();
    expect(h.offered()).toHaveLength(0);
    h.clock.advance(1); await h.layer.drain();
    expect(h.offered().map(frame => frame.p.attempt_id)).toEqual([task.id]);
    expect(h.store.listTurnAttempts(h.store.getTurnForAttempt(task.id)!.id)).toHaveLength(1);
  });

  it("requeues a failed preparation and does not leave the runtime waiting for an unsent offer", async () => {
    let failed = true;
    const h = fixture(async task => { if (failed) throw new Error("fixture preparation failure"); return { id: task.id }; });
    const task = h.task(); const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await h.hello(); expect(h.store.getTask(task.id)?.status).toBe("queued");
      expect(h.offered()).toHaveLength(0); failed = false;
      h.clock.advance(30_000); await h.layer.drain();
      expect(h.offered()[0]!.p.attempt_id).toBe(task.id);
    } finally { warn.mockRestore(); }
  });

  it("wakes another runtime when a shared Agent concurrency slot becomes free", async () => {
    const h = fixture(undefined, 2);
    const agent = h.store.createAgent({ name: "shared agent", provider: "claude", maxConcurrentTasks: 1 });
    const first = h.store.createTask({ agentId: agent.id, runtimeId: h.runtimeIds[0], prompt: "first" });
    const next = h.store.createTask({ agentId: agent.id, runtimeId: h.runtimeIds[1], prompt: "next" });
    await h.hello(); expect(h.offered()).toHaveLength(1); await h.accept();
    h.store.startTask(first.id); h.store.completeTask(first.id, { output: "done" });
    h.offers.terminal(first.id, h.runtimeIds[0]!); await h.layer.drain();
    expect(h.offered().at(-1)!.p.attempt_id).toBe(next.id);
    expect(h.offered().at(-1)!.rt).toBe(h.runtimeIds[1]);
  });

  it("reconstructs delayed retry wakeups at hello without the sweep or a changed heartbeat", async () => {
    const h = fixture(); const now = h.clock.now();
    setSystemTime(now);
    try {
      const task = h.store.createTask({ agentId: h.store.listAgents()[0]!.id, prompt: "delayed retry",
        nextRetryAt: new Date(now + 10_000).toISOString() });
      await h.hello(); expect(h.offered()).toHaveLength(0);
      setSystemTime(now + 9_999); h.clock.advance(9_999); await h.layer.drain(); expect(h.offered()).toHaveLength(0);
      setSystemTime(now + 10_000); h.clock.advance(1); await h.layer.drain();
      expect(h.offered()[0]!.p.attempt_id).toBe(task.id);
    } finally { setSystemTime(); }
  });

  it("offers on enqueue and on a terminal report freeing capacity", async () => {
    const h = fixture(); await h.hello();
    const first = h.task(); h.offers.kick(h.runtimeIds[0]); await h.layer.drain(); await h.accept();
    h.store.startTask(first.id);
    const next = h.task(); h.offers.kick(h.runtimeIds[0]); await h.layer.drain();
    expect(h.offered()).toHaveLength(1);
    h.store.completeTask(first.id, { output: "done" }); h.offers.terminal(first.id, h.runtimeIds[0]!); await h.layer.drain();
    expect(h.offered().at(-1)!.p.attempt_id).toBe(next.id);
  });

  it("keeps work queued during platform drain and wakes at the lease deadline without a sweep", async () => {
    const h = fixture(); const now = h.clock.now();
    setSystemTime(now);
    try {
      const maintenance = h.store.beginPlatformDrain({ operationId: "offer-drain", ttlMs: 30_000 });
      const remaining = Date.parse(maintenance.expiresAt!) - now;
      const task = h.task(); await h.hello();
      expect(h.store.getTask(task.id)?.status).toBe("queued");
      expect(h.offered()).toHaveLength(0);
      setSystemTime(now + remaining - 1); h.clock.advance(remaining - 1); await h.layer.drain();
      expect(h.offered()).toHaveLength(0);
      setSystemTime(now + remaining + 1); h.clock.advance(2); await h.layer.drain();
      expect(h.offered()[0]!.p.attempt_id).toBe(task.id);
    } finally { setSystemTime(); }
  });

  it("kicks on a changed heartbeat count, not on an unchanged count", async () => {
    const h = fixture(); await h.hello();
    await h.send("hb", { active_task_count: 0 }, { id: "hb1" }); await h.layer.drain();
    const task = h.task();
    await h.send("hb", { active_task_count: 0 }, { id: "hb2" }); await h.layer.drain();
    expect(h.offered()).toHaveLength(0);
    await h.send("hb", { active_task_count: 1 }, { id: "hb3" }); await h.layer.drain();
    expect(h.offered()[0]!.p.attempt_id).toBe(task.id);
  });

  it("requeues an unanswered offer at 30s and cools that runtime for another 30s", async () => {
    const h = fixture(); const task = h.task(); await h.hello();
    h.clock.advance(29_999); expect(h.store.getTask(task.id)?.status).toBe("dispatched");
    h.clock.advance(1); expect(h.store.getTask(task.id)?.status).toBe("queued");
    h.offers.kick(h.runtimeIds[0]); await h.layer.drain(); expect(h.offered()).toHaveLength(1);
    h.clock.advance(29_999); await h.layer.drain(); expect(h.offered()).toHaveLength(1);
    h.clock.advance(1); await h.layer.drain(); expect(h.offered()).toHaveLength(2);
  });

  it("reject cools only the rejecting runtime on a shared daemon", async () => {
    const h = fixture(undefined, 2); const first = h.task(0); const second = h.task(1); await h.hello();
    const rejected = h.offered().find(frame => frame.p.attempt_id === first.id)!;
    await h.send("res", { ok: false, code: "capacity" }, { re: String(rejected.seq), ack: rejected.seq });
    await h.layer.drain();
    expect(h.store.getTask(first.id)?.status).toBe("queued");
    await h.accept(h.offered().find(frame => frame.p.attempt_id === second.id)!);
    expect(h.store.getTask(second.id)?.acceptedAt).not.toBeNull();
    h.offers.kick(); await h.layer.drain(); expect(h.offered()).toHaveLength(2);
  });

  it("disconnect requeues unaccepted work, but preserves accepted work and drops its lease", async () => {
    const h = fixture(); const task = h.task(); await h.hello(); h.session.handleSocketClose();
    expect(h.store.getTask(task.id)?.status).toBe("queued");
    expect(h.store.getTask(task.id)?.acceptedAt).toBeNull();
  });

  it("holds a dispatched lease after accept, and keeps 90s recovery as the final fallback", async () => {
    const h = fixture(); const task = h.task(); await h.hello(); await h.accept();
    db!.run("UPDATE multiremi_turn_attempts SET accepted_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [task.id]);
    expect(h.store.claimTask(h.runtimeIds[0]!)).toBeNull();
    h.session.handleSocketClose();
    expect(h.store.getTask(task.id)?.status).toBe("dispatched");
    expect(h.store.claimTask(h.runtimeIds[0]!)?.id).toBe(task.id);
  });

  it("folds a >1MiB request without failing the task", async () => {
    const h = fixture(async task => ({ id: task.id, prompt: task.prompt }));
    const huge = h.task(0, "x".repeat(1_048_576)); const next = h.task(); await h.hello();
    expect(h.store.getTask(huge.id)?.status).toBe("dispatched");
    expect(h.store.getTask(huge.id)?.error).toBeNull();
    expect(h.offered()).toHaveLength(1);
    expect(h.offered()[0]!.p.attempt_id).toBe(huge.id);
    const message = h.offered()[0]!.p.input_messages[0];
    expect(message.body_md).toContain("还有");
    expect(message.body_md).toContain(`remi message list ${message.session_id} --from ${message.seq - 1} --to ${message.seq}`);
    expect(message.body_md).not.toContain("undefined");
    expect(h.store.getMessage(message.id)!.body_md).toBe(huge.prompt);
    expect(Buffer.byteLength(JSON.stringify(h.offered()[0]))).toBeLessThan(512 * 1024);
    await h.accept(); h.store.startTask(huge.id); h.store.completeTask(huge.id, { output: "done" });
    h.offers.kick(); await h.layer.drain();
    expect(h.offered()[1]!.p.attempt_id).toBe(next.id);
  });

  it("dispatches huge agent instructions and then the next task on the same runtime", async () => {
    const h = fixture(async task => ({ id: task.id, prompt: task.prompt, auth_token: "fixture-capability",
      agent: { id: task.agentId, provider: "claude", instructions: "😀中文\\\n\"".repeat(200_000) } }));
    const issue = createResponsibleTestIssue(h.store, { title: "Irreducible input" });
    const task = h.store.createTask({ agentId: h.agentIds[0]!, issueId: issue.id, prompt: "request" });
    const next = h.task();
    await h.hello();
    expect(h.offered()).toHaveLength(1);
    expect(h.store.getTask(task.id)?.status).toBe("dispatched");
    expect(h.store.getTask(task.id)?.failureReason).toBeNull();
    expect(h.store.getIssue(issue.id)?.status).not.toBe("blocked");
    const payload = h.offered()[0]!.p;
    expect(payload.agent.instructions).toContain("还有");
    expect(payload.agent.instructions).toContain(`remi agent get ${task.agentId}`);
    const prefixLength = payload.agent.instructions.lastIndexOf("\n只看到了开头");
    expect(Number(payload.agent.instructions.match(/还有 (\d+) 字/)![1])).toBe("😀中文\\\n\"".repeat(200_000).length - prefixLength);
    expect(payload.auth_token).toBe("fixture-capability");
    expect(Buffer.byteLength(JSON.stringify(h.offered()[0]))).toBeLessThan(512 * 1024);
    await h.accept(); h.store.startTask(task.id); h.store.completeTask(task.id, { output: "done" });
    h.offers.kick(); await h.layer.drain();
    expect(h.offered()[1]!.p.attempt_id).toBe(next.id);
  });

  it("does not reset an accepted Chat dispatch through the stale workspace recovery path", async () => {
    const h = fixture();
    const project = h.store.createProject({ title: "leased Chat" });
    const agent = h.store.createAgent({ name: "leased Chat", provider: "claude", runtimeId: h.runtimeIds[0]! });
    const chat = h.store.createChatSession({ agentId: agent.id, projectId: project.id });
    const task = h.store.sendChatMessage(chat.id, { body: "no-op" }).task;
    await h.hello(); await h.accept();
    const stale = "chat-workspace:deadbeef:managed:frozen";
    db!.run("UPDATE multiremi_turn_attempts SET accepted_at = '2000-01-01T00:00:00.000Z', execution_fingerprint = ? WHERE id = ?", [stale, task.id]);
    expect(h.store.claimTask(h.runtimeIds[0]!)).toBeNull();
    expect(h.store.getTask(task.id)).toMatchObject({ status: "dispatched", executionFingerprint: stale });
    h.session.handleSocketClose();
    expect(h.store.claimTask(h.runtimeIds[0]!)?.id).toBe(task.id);
    expect(h.store.getTask(task.id)?.executionFingerprint).not.toBe(stale);
  });

  it("does not claim on ordinary ack/drain without a blocked offer, and enqueue still offers immediately", async () => {
    const h = fixture(); await h.hello();
    // Create work without an enqueue event: unrelated socket traffic must not poll it.
    const task = h.task();
    const claim = spyOn(h.store, "claimTask");
    try {
      for (let i = 0; i < 8; i++) {
        await h.send("ack", { ack: 0 });
        h.session.handleDrain();
        await h.layer.drain();
      }
      h.clock.advance(180_000); await h.layer.drain();
      expect(claim).not.toHaveBeenCalled();
      h.offers.enqueued(task); await h.layer.drain();
      expect(claim).toHaveBeenCalledTimes(1);
      expect(h.offered()[0]!.p.attempt_id).toBe(task.id);
    } finally { claim.mockRestore(); }
  });

  it("derives pending work again after a full window receives an ack", async () => {
    const h = fixture(); await h.hello();
    for (let i = 0; i < 64; i++) expect(h.session.sendEvent({ t: "plugin.desired_revision", p: { revision: i } }).ok).toBe(true);
    const task = h.task(); h.offers.kick(h.runtimeIds[0]); await h.layer.drain();
    expect(h.store.getTask(task.id)?.status).toBe("queued"); expect(h.offered()).toHaveLength(0);
    await h.send("ack", { ack: 64 }); await h.layer.drain(); expect(h.offered()[0]!.p.attempt_id).toBe(task.id);
  });

  it("waits for drain when the socket is paused", async () => {
    const h = fixture(); await h.hello(); h.setSendStatus(-1);
    h.session.sendEvent({ t: "plugin.desired_revision", p: { revision: 1 } }); h.setSendStatus(null);
    const task = h.task(); h.offers.kick(h.runtimeIds[0]); await h.layer.drain(); expect(h.offered()).toHaveLength(0);
    h.session.handleDrain(); await h.layer.drain(); expect(h.offered()[0]!.p.attempt_id).toBe(task.id);
  });

  it("runtime.ready cancels terminal active tasks, recovers missing running tasks and preserves active ones", async () => {
    const h = fixture(); const terminal = h.task(); const missing = h.task(); const active = h.task();
    h.store.claimTask(h.runtimeIds[0]!); h.store.startTask(terminal.id); h.store.completeTask(terminal.id, { output: "done" });
    db!.run("UPDATE multiremi_turn_attempts SET status = 'running', runtime_id = ? WHERE id IN (?, ?)", [h.runtimeIds[0]!, missing.id, active.id]);
    await h.hello(); await h.send("runtime.ready", { active_task_ids: [terminal.id, active.id] }, { rt: h.runtimeIds[0] }); await h.layer.drain();
    expect(h.frames.filter(frame => frame.t === "task.cancelled")).toHaveLength(1);
    expect(h.store.getTask(missing.id)?.status).toBe("failed");
    expect(h.store.getTask(active.id)?.status).toBe("running");
  });

  it("never recovers another runtime named in an unauthorized ready", async () => {
    const h = fixture(); await h.hello(); const task = h.task();
    await h.send("runtime.ready", { active_task_ids: [] }, { rt: "rt_foreign" }); await h.layer.drain();
    expect(h.store.getTask(task.id)?.status).toBe("queued");
  });
});


describe("System Prompt policy claim and offer", () => {
  const actor = { type: "human" as const, operatorId: "local", userId: "local", displayName: "Tester" };
  const edit = (store: ReturnType<typeof createLocalStore>, common: string, requestId: string) =>
    store.editSystemPrompt("local", { expectedRevision: store.getSystemPrompt("local").document.revision,
      requestId, content: { ...DEFAULT_SYSTEM_PROMPT_CONTENT, common } }, actor);

  it("permits baseline defaults on old daemons, but leaves custom policy queued with a diagnostic before claim", async () => {
    const h = fixture(undefined, 1, undefined, false, false);
    const task = h.task();
    edit(h.store, "CUSTOM POLICY", "custom");
    h.offers.start();
    await h.hello();
    expect(h.offered()).toHaveLength(0);
    expect(h.store.getTask(task.id)).toMatchObject({ status: "queued", waitReason: "daemon_capability_required:prompt.policy.v1" });
    expect(h.store.getAttemptSystemPrompt(task.id)).toBeNull();
    const claim = h.store.claimTask(h.runtimeIds[0]!, { supportsPromptPolicy: true });
    expect(claim?.id).toBe(task.id);
    expect(h.store.getAttemptSystemPrompt(task.id)).toMatchObject({ mode: "custom", legacyCompatible: false,
      content: expect.objectContaining({ common: "CUSTOM POLICY" }) });
  });

  it("freezes atomically at claim, rebinds the same rejected offer id, and preserves accepted/running snapshots", () => {
    const h = fixture(undefined, 1, undefined, false, false);
    const task = h.task();
    const first = h.store.claimTask(h.runtimeIds[0]!)!;
    const baseline = h.store.getAttemptSystemPrompt(task.id)!;
    expect(baseline).toMatchObject({ mode: "default", legacyCompatible: true, versionId: null });
    edit(h.store, "AFTER CLAIM", "edit1");
    expect(daemonTaskClaimResponse(h.store, first).system_prompt_policy).toEqual(baseline);
    expect(h.store.requeueTaskOffer(task.id, h.runtimeIds[0]!, "rejected")).toBe(true);
    expect(h.store.claimTask(h.runtimeIds[0]!, { supportsPromptPolicy: true })?.id).toBe(task.id);
    const rebound = h.store.getAttemptSystemPrompt(task.id)!;
    expect(rebound.content.common).toBe("AFTER CLAIM");
    h.store.recordTaskOffered(task.id, h.runtimeIds[0]!);
    h.store.acceptTaskOffer(task.id, h.runtimeIds[0]!);
    h.store.startTask(task.id);
    edit(h.store, "AFTER START", "edit2");
    expect(h.store.getAttemptSystemPrompt(task.id)).toEqual(rebound);
    expect(daemonTaskClaimResponse(h.store, h.store.getTaskWithAgent(task.id)!).system_prompt_policy).toEqual(rebound);
  });

  it("rebinds a stale preaccept dispatch with the same task id", () => {
    const h = fixture(undefined, 1, undefined, false, false);
    const task = h.task();
    h.store.claimTask(h.runtimeIds[0]!, { supportsPromptPolicy: true });
    const first = h.store.getAttemptSystemPrompt(task.id)!;
    edit(h.store, "STALE RECLAIM POLICY", "stale-edit");
    db!.run("UPDATE multiremi_turn_attempts SET accepted_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [task.id]);
    expect(h.store.claimTask(h.runtimeIds[0]!, { supportsPromptPolicy: true })?.id).toBe(task.id);
    const rebound = h.store.getAttemptSystemPrompt(task.id)!;
    expect(rebound.content.common).toBe("STALE RECLAIM POLICY");
    expect(rebound).not.toEqual(first);
  });

  it("rolls back both the claim and its binding if binding persistence fails", () => {
    const h = fixture(undefined, 1, undefined, false, false);
    const task = h.task();
    const repo = h.store.systemPromptsRepo();
    const bind = repo.bindAttemptSystemPrompt.bind(repo);
    const probe = spyOn(repo, "bindAttemptSystemPrompt").mockImplementation((...args) => {
      bind(...args);
      throw new Error("injected post-bind failure");
    });
    try {
      expect(() => h.store.claimTask(h.runtimeIds[0]!, { supportsPromptPolicy: true })).toThrow("injected post-bind failure");
      expect(h.store.getTask(task.id)?.status).toBe("queued");
      expect(h.store.getAttemptSystemPrompt(task.id)).toBeNull();
    } finally { probe.mockRestore(); }
    expect(h.store.claimTask(h.runtimeIds[0]!, { supportsPromptPolicy: true })?.id).toBe(task.id);
  });

  it("keeps reset-to-baseline compatible with old daemons", () => {
    const h = fixture(undefined, 1, undefined, false, false);
    const task = h.task();
    h.store.resetSystemPrompt("local", { expectedRevision: 0, requestId: "baseline-reset" }, actor);
    expect(h.store.claimTask(h.runtimeIds[0]!)?.id).toBe(task.id);
    expect(h.store.getAttemptSystemPrompt(task.id)).toMatchObject({ mode: "default", legacyCompatible: true,
      defaultRevision: CURRENT_SYSTEM_PROMPT_DEFAULT.revision });
  });

  for (const reset of [false, true]) {
    it(`requires policy capability after server default upgrades for ${reset ? "reset" : "never-customized"} workspaces`, () => {
      const h = fixture(undefined, 1, undefined, false, false);
      const task = h.task();
      if (reset) h.store.resetSystemPrompt("local", { expectedRevision: 0, requestId: "reset" }, actor);
      const repo = h.store.systemPromptsRepo();
      // Dependency-injected catalog simulates a later server release without changing the frozen legacy baseline.
      const catalog = { ...CURRENT_SYSTEM_PROMPT_DEFAULT, revision: "future-server-default",
        content: { ...DEFAULT_SYSTEM_PROMPT_CONTENT, common: "NEW SERVER DEFAULT" } };
      const probe = spyOn(repo as any, "catalog").mockReturnValue(catalog);
      try {
        expect(h.store.claimTask(h.runtimeIds[0]!)).toBeNull();
        expect(h.store.getTask(task.id)).toMatchObject({ status: "queued", waitReason: "daemon_capability_required:prompt.policy.v1" });
        expect(h.store.claimTask(h.runtimeIds[0]!, { supportsPromptPolicy: true })?.id).toBe(task.id);
        expect(h.store.getAttemptSystemPrompt(task.id)).toMatchObject({ mode: "default", defaultRevision: catalog.revision,
          content: catalog.content, legacyCompatible: false });
      } finally { probe.mockRestore(); }
    });
  }

  it("preserves the entire frozen subtree through ordinary and emergency offer compression", () => {
    const content = { common: "😀".repeat(7_000), code_delivery: "", chat_delivery: "", issue_delivery: "", finishing: "" };
    const binding = { format: 1, workspaceId: "local", documentId: "doc", versionId: "version", versionNumber: 2,
      mode: "custom", defaultRevision: CURRENT_SYSTEM_PROMPT_DEFAULT.revision, legacyCompatible: false,
      content, contentHash: hashSystemPromptContent(content) };
    const payload = { turn_id: "turn", system_prompt_policy: binding, agent: { id: "agent", instructions: "x".repeat(1_200_000) } };
    const fitted = fitTaskOfferToBudget(payload, "runtime", 16 * 1024);
    expect(fitted.response.system_prompt_policy).toEqual(binding);
    expect(fitted.report.steps).toContain("strings");
    // Protected content itself can exceed a soft budget; it must never be corrupted to meet one.
    expect(fitted.report.bytes).toBeGreaterThan(16 * 1024);
    const emergency = { turn_id: "turn", system_prompt_policy: binding,
      execution_connection: { id: "conn", token: "t".repeat(1_100_000) } };
    const result = fitTaskOfferToBudget(emergency, "runtime", 16 * 1024);
    expect(result.report.steps).toContain("protected_strings");
    expect(result.response.system_prompt_policy).toEqual(binding);
  });
});
