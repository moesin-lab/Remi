import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from 'node:crypto';
import { MultiremiTaskReportOutbox } from '@multiremi/worker/outbox.js';
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { PlannedRestartJournal, PlannedRestartTransfer, type RestartExecution,
  RESTART_RECOVERY_LIMIT_MS, RESTART_RECOVERY_MAX_ATTEMPTS, type PlannedRestartRemote } from "@multiremi/worker/planned-restart-journal.js";
import type { PlannedRestartCheckpoint } from "@multiremi/contracts/planned-restart.js";
import { fixtureDeliveryTuple, fixtureExecutionLocator, fixtureDeliveryStatusResponse } from '../../fixtures/root-authority.js';

const execution: RestartExecution = { workspace_id: "ws_test", daemon_id: "daemon_test", runtime_id: "rt_test",
  turn_id: "turn_test", attempt_id: "attempt_test", handoff_id: "handoff_test", generation: 0 };
const checkpoint: PlannedRestartCheckpoint = { version: 1, session_id: "provider_session", work_dir: "/work",
  trace_head: 42, input_ack_seq: 12, delivered_message_ids: ["message_test"] };
const roots: string[] = [];
const journals: PlannedRestartJournal[] = [];
afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
function root() { const path = mkdtempSync(join(tmpdir(), "planned-restart-journal-")); roots.push(path); return path; }
function journal(path = ":memory:") { const value = new PlannedRestartJournal(path); journals.push(value); return value; }

it('preserves one receiver and launch identity across journal connections and ordered installation steps', () => {
  const path = join(root(), 'receipts.db');
  const first = journal(path), second = journal(path);
  const tuple = fixtureDeliveryTuple, digest = fixtureDeliveryStatusResponse.envelope_digest;
  const received = first.receiveRootExecution(tuple, digest);
  expect(second.receiveRootExecution(tuple, digest)).toEqual(received);
  expect(() => second.receiveRootExecution({ ...tuple, receipt_id: 'different' }, digest)).toThrow('receipt_conflict');
  expect(() => second.receiveRootExecution({ ...tuple, delivery_version: 0 }, digest)).toThrow('receipt_conflict');
  expect(() => second.receiveRootExecution(tuple, 'sha256:' + '0'.repeat(64))).toThrow('receipt_conflict');
  const locator = { ...fixtureExecutionLocator, launch_identity: received.launchIdentity };
  expect(() => second.advanceRootExecution(tuple, digest, locator, 'confirmed')).toThrow('receipt_conflict');
  first.advanceRootExecution(tuple, digest, locator, 'installed');
  second.advanceRootExecution(tuple, digest, locator, 'installed');
  expect(() => second.advanceRootExecution(tuple, digest, { ...locator, execution_id: 'replacement' }, 'confirmed')).toThrow('receipt_conflict');
  first.advanceRootExecution(tuple, digest, locator, 'confirmed');
  const started = { ...locator, started_at: new Date().toISOString() };
  second.advanceRootExecution(tuple, digest, started, 'started');
  expect(journal(path).receiveRootExecution(tuple, digest)).toEqual({ ...received, state: 'started', locator: started });
  expect(() => first.advanceRootExecution(tuple, digest, locator, 'installed')).toThrow('receipt_conflict');
});
const remote = (): PlannedRestartRemote => ({ suspend: async () => {}, resume: async entry => ({ generation: entry.execution.generation + 1 }) });

it('pre-scans a co-resident damaged journal before recovering unread input or sending imported reports', async () => {
  const directory = root();
  const hash = (value:string) => createHash('sha256').update(value).digest('hex').slice(0,16);
  const scope = {server:'isolated',workspace:execution.workspace_id,daemon:execution.daemon_id,provider:'codex'};
  const legacyPath = (provider:string) => join(directory,`${provider}-${hash([scope.server,scope.workspace,scope.daemon,provider].join('|'))}.db`);
  const source = legacyPath('claude');
  const journalPath = join(directory,`restart-claude-${hash(source)}.db`);
  const restart = journal(journalPath);
  const entry = restart.prepare(execution,checkpoint);
  const evidence = openSqliteDatabase(journalPath);
  evidence.run("UPDATE planned_restart_journal SET payload='{}' WHERE handoff_id=?",[execution.handoff_id]);
  const discoverRestartHolds = () => PlannedRestartJournal.discover({...scope,legacyPath:legacyPath('codex')});
  const shared = join(directory,'shared.db');
  const seed = async (path:string,task:string,kind:'progress'|'turn.complete') => {
    const outbox = new MultiremiTaskReportOutbox({path,canSend:()=>false,deliver:async()=>{}});
    outbox.enqueue(task,kind,{value:task,runtime_id:execution.runtime_id});
    await outbox.close();
  };
  await seed(shared,execution.attempt_id,'turn.complete');
  await seed(source,'other-attempt','progress');
  const db = openSqliteDatabase(shared);
  db.run("UPDATE outbox_events SET status='input_unread'");
  const original = db.query('SELECT * FROM outbox_events WHERE id=1').get();
  const sent:string[] = [];
  const outbox = new MultiremiTaskReportOutbox({path:shared,discoverRestartHolds,deliver:async record => {sent.push(record.taskId);}});
  try {
    expect(outbox.isHeld('other-attempt')).toBe(true);
    outbox.importLegacy(source,'different-registration');
    outbox.enqueue('rt:healthy','runtime.command_result',{});
    expect(await outbox.waitForTaskDrain('rt:healthy')).toBe('delivered');
    expect(sent).toEqual(['rt:healthy']);
    expect(db.query('SELECT * FROM outbox_events WHERE id=1').get()).toEqual(original);
    expect(db.query('SELECT COUNT(*) AS n FROM restart_source_rows').get()).toEqual({n:2});
    restart.entries(); restart.remove(execution.handoff_id);
    expect(evidence.query('SELECT payload,consumer_id FROM planned_restart_journal').get()).toEqual({payload:'{}',consumer_id:entry.consumer_id});
  } finally {await outbox.close(); db.close(); evidence.close();}
});

it('rejects delayed receives and installation transitions after a newer run is journaled', () => {
  const path = join(root(), 'receipts.db');
  const original = journal(path), recovered = journal(path);
  const tuple = fixtureDeliveryTuple, digest = fixtureDeliveryStatusResponse.envelope_digest;
  const first = original.receiveRootExecution(tuple, digest);
  const locator = { ...fixtureExecutionLocator, launch_identity: first.launchIdentity };
  original.advanceRootExecution(tuple, digest, locator, 'installed');
  const next = { ...tuple, receipt_id: 'next', run_generation: tuple.run_generation + 1, material_version: tuple.material_version + 1 };
  const current = recovered.receiveRootExecution(next, digest);
  expect(() => original.receiveRootExecution(tuple, digest)).toThrow('stale_execution');
  expect(() => original.advanceRootExecution(tuple, digest, locator, 'confirmed')).toThrow('receipt_conflict');
  expect(() => recovered.receiveRootExecution({ ...next, receipt_id: 'rollback', run_generation: next.run_generation + 1,
    material_version: tuple.material_version }, digest)).toThrow('stale_execution');
  expect(journal(path).receiveRootExecution(next, digest)).toEqual(current);
});

it("journals only after provider/report/trace quiescence, and only acknowledges a committed remote checkpoint", async () => {
  const path = join(root(), "journal.db"), local = journal(path);
  const order: string[] = [];
  let finish!: () => void;
  const safePoint = new Promise<void>(resolve => { finish = resolve; });
  const transfer = new PlannedRestartTransfer(local, { ...remote(), suspend: async entry => {
    order.push("remote");
    expect(local.get(entry.execution.handoff_id)?.state).toBe("prepared");
    expect(local.get(entry.execution.handoff_id)?.checkpoint).toEqual(checkpoint);
  } });
  const pending = transfer.suspend(execution, async () => { await safePoint; order.push("provider-stopped-and-flushed"); return checkpoint; });
  expect(local.entries()).toEqual([]);
  const duplicate = transfer.suspend(execution, async () => { throw new Error("must not stop twice"); });
  await expect(transfer.suspend({ ...execution, attempt_id: "other_attempt" }, async () => checkpoint)).rejects.toThrow("conflict");
  finish();
  expect((await pending).state).toBe("acknowledged");
  expect(await duplicate).toEqual(await pending);
  expect(order).toEqual(["provider-stopped-and-flushed", "remote"]);
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
});

it("failed safe-point shutdown produces no suspension evidence", async () => {
  const local = journal(); let calls = 0;
  const transfer = new PlannedRestartTransfer(local, { ...remote(), suspend: async () => { calls++; } });
  await expect(transfer.suspend(execution, async () => { throw new Error("provider still running"); })).rejects.toThrow("provider still running");
  expect(local.entries()).toEqual([]); expect(calls).toBe(0);
  expect((await transfer.suspend(execution, async () => checkpoint)).state).toBe("acknowledged");
});

it("a new process recovers a prepared journal after a lost suspend response", async () => {
  const path = join(root(), "journal.db");
  const local = new PlannedRestartJournal(path);
  let consumer = "";
  try {
    const transfer = new PlannedRestartTransfer(local, { ...remote(), suspend: async entry => {
      consumer = entry.consumer_id; throw new Error("response lost after commit");
    } });
    await expect(transfer.suspend(execution, async () => checkpoint)).rejects.toThrow("response lost");
    expect(local.get(execution.handoff_id)?.state).toBe("prepared");
  } finally { local.close(); }
  const result = spawnSync(process.execPath, ["-e", `
    import { PlannedRestartJournal, PlannedRestartTransfer } from "./packages/server/src/worker/planned-restart-journal.ts";
    const journal = new PlannedRestartJournal(process.env.TEST_RESTART_JOURNAL);
    const order = [];
    const transfer = new PlannedRestartTransfer(journal, {
      suspend: async () => { order.push("suspend-replay"); },
      resume: async entry => { order.push("resume-cas"); return { generation: entry.execution.generation + 1 }; },
    });
    const entry = await transfer.resume("handoff_test");
    console.log(JSON.stringify({ entry, order })); journal.close();
  `], { cwd: new URL("../../../", import.meta.url), env: { ...process.env, TEST_RESTART_JOURNAL: path }, encoding: "utf8", timeout: 10_000 });
  expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
  const resultBody = JSON.parse(result.stdout.trim());
  expect(resultBody.order).toEqual(["suspend-replay", "resume-cas"]);
  expect(resultBody.entry).toMatchObject({ execution, checkpoint, consumer_id: consumer, state: "resumed", resumed_generation: 1 });
  expect(journal(path).get(execution.handoff_id)).toEqual(resultBody.entry);
});

it("persists the same consumer across an ambiguous resume and rechecks remote authority on every recovery", async () => {
  const path = join(root(), "journal.db"); let local = new PlannedRestartJournal(path);
  const entry = local.prepare(execution, checkpoint); local.acknowledge(execution.handoff_id);
  const consumers: string[] = [];
  try {
    await expect(new PlannedRestartTransfer(local, { ...remote(), resume: async value => {
      consumers.push(value.consumer_id); throw new Error("resume response lost");
    } }).resume(execution.handoff_id)).rejects.toThrow("resume response lost");
    expect(local.get(execution.handoff_id)?.state).toBe("acknowledged");
  } finally { local.close(); }
  local = journal(path);
  const transferred = await new PlannedRestartTransfer(local, { ...remote(), resume: async value => {
    consumers.push(value.consumer_id); return { generation: 1 };
  } }).resume(execution.handoff_id);
  expect(consumers).toEqual([entry.consumer_id, entry.consumer_id]);
  expect(transferred.state).toBe("resumed");
  await expect(new PlannedRestartTransfer(local, { ...remote(), resume: async () => {
    throw new Error("stale_execution");
  } }).resume(execution.handoff_id)).rejects.toThrow("stale_execution");
});

it("does not consume a checkpoint behind a fence or accept a mismatched generation receipt", async () => {
  const local = journal(); local.prepare(execution, checkpoint);
  await expect(new PlannedRestartTransfer(local, { ...remote(), resume: async () => {
    throw new Error("resume_fenced");
  } }).resume(execution.handoff_id)).rejects.toThrow("resume_fenced");
  expect(local.get(execution.handoff_id)?.state).toBe("acknowledged");
  await expect(new PlannedRestartTransfer(local, { ...remote(), resume: async () => ({ generation: 2 }) })
    .resume(execution.handoff_id)).rejects.toThrow("Invalid planned restart resume receipt");
  expect(local.get(execution.handoff_id)?.resumed_generation).toBeNull();
});

it("rejects conflicting checkpoints, unknown fields and corrupt disk evidence", () => {
  const path = join(root(), "journal.db"), local = journal(path);
  const first = local.prepare(execution, checkpoint);
  expect(local.prepare(execution, checkpoint)).toEqual(first);
  expect(() => local.prepare(execution, { ...checkpoint, trace_head: 43 })).toThrow("conflict");
  expect(() => local.prepare({ ...execution, runtime_id: "another_runtime" }, checkpoint)).toThrow("conflict");
  expect(() => local.prepare({ ...execution, handoff_id: "new" }, { ...checkpoint, token: "not-allowed" } as PlannedRestartCheckpoint)).toThrow("Invalid");
  expect(() => local.prepare({ ...execution, handoff_id: "new" }, { ...checkpoint, trace_head: -1 })).toThrow("Invalid");
  const db = openSqliteDatabase(path);
  try { db.run("UPDATE planned_restart_journal SET payload='{}' WHERE handoff_id=?", [execution.handoff_id]); }
  finally { db.close(); }
  expect(() => local.get(execution.handoff_id)).toThrow("Corrupt");
  const healthy = local.prepare({...execution,attempt_id:'healthy_attempt',handoff_id:'healthy_handoff'},checkpoint);
  expect(local.entries()).toEqual([healthy]);
  const evidence = openSqliteDatabase(path);
  try {
    expect(evidence.query('SELECT payload,consumer_id FROM planned_restart_journal WHERE handoff_id=?').get(execution.handoff_id))
      .toEqual({payload:'{}',consumer_id:first.consumer_id});
    expect(evidence.query('SELECT reason FROM planned_restart_holds WHERE handoff_id=?').get(execution.handoff_id))
      .toEqual({reason:'restart_policy_unverifiable'});
    expect(evidence.query('SELECT COUNT(*) AS count FROM planned_restart_trace_identities').get()).toEqual({count:0});
    expect(evidence.query<{name:string},[]>('PRAGMA table_info(planned_restart_journal)').all().map(row => row.name)).not.toContain('attempt_id');
  } finally { evidence.close(); }
});

it("treats trace identities as optional and discards bad digest, head or generation bindings", async () => {
  const identities = { version: 1 as const, agent_type: "claude", used_ids: ["old_tool"],
    counters: { syn: 1, text: 2, notice: 3, spawn: 0 }, natives: [], sessions: [], aliases: [], failure_ids: [], consumed_steers: [] };
  for (const problem of ["none", "missing", "digest", "head", "generation"] as const) {
    const path = join(root(), "identity.db"), local = journal(path);
    const entry = local.prepare(execution, checkpoint); local.acknowledge(execution.handoff_id);
    if (problem !== "missing") local.saveTraceIdentities(
      { ...execution, generation: problem === "generation" ? 1 : 0 }, problem === "head" ? 43 : 42, identities);
    if (problem === "digest") {
      const writer = openSqliteDatabase(path);
      try { writer.run("UPDATE planned_restart_trace_identities SET sha256='invalid'"); } finally { writer.close(); }
    }
    const warnings: string[] = [];
    expect(local.traceIdentities(entry, reason => warnings.push(reason))).toEqual(problem === "none" ? identities : null);
    expect(warnings.length).toBe(problem === "none" ? 0 : 1);
    const resumed = await new PlannedRestartTransfer(local, {
      ...remote(), resume: async value => {
        // This is how the daemon consumes optional state before its authoritative CAS.
        local.traceIdentities(value, () => {});
        return { generation: value.execution.generation + 1 };
      },
    }).resume(execution.handoff_id);
    expect(resumed.resumed_generation).toBe(1);
  }
});


it("persists capped exponential retry backoff and exhaustion across daemon process restarts", () => {
  const path = join(root(), "retry.db");
  let j = new PlannedRestartJournal(path);
  try {
    j.prepare(execution, checkpoint);
    expect(j.reserveResume(execution.handoff_id, 0)).toBe("ready");
    expect(j.reserveResume(execution.handoff_id, 999)).toBe("waiting");
    j.close();
    j = new PlannedRestartJournal(path);
    expect(j.reserveResume(execution.handoff_id, 999)).toBe("waiting");
    expect(j.reserveResume(execution.handoff_id, 1000)).toBe("ready");
    expect(j.reserveResume(execution.handoff_id, 2999)).toBe("waiting");
    for (let i = 2; i < RESTART_RECOVERY_MAX_ATTEMPTS; i++) {
      expect(j.reserveResume(execution.handoff_id, 3000 + (i - 2) * 60_000)).toBe("ready");
    }
    expect(j.reserveResume(execution.handoff_id, RESTART_RECOVERY_MAX_ATTEMPTS * 60_000)).toBe("expired");
    j.close();
    j = new PlannedRestartJournal(path);
    expect(j.reserveResume(execution.handoff_id, RESTART_RECOVERY_MAX_ATTEMPTS * 60_000)).toBe("expired");
  } finally { j.close(); }
});

it("expires recovery by total deadline even when fewer RPCs were sent and removes terminal journals", () => {
  const j = journal();
  j.prepare(execution, checkpoint);
  expect(j.reserveResume(execution.handoff_id, 0)).toBe("ready");
  expect(j.reserveResume(execution.handoff_id, RESTART_RECOVERY_LIMIT_MS)).toBe("expired");
  j.remove(execution.handoff_id);
  expect(j.entries()).toEqual([]);
  expect(j.traceIdentities({ execution, checkpoint } as any, () => {})).toBeNull();
});
