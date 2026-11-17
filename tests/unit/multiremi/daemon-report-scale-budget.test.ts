import { afterAll, beforeAll, expect, test } from "bun:test";
import { countSql, settleReportFleet, useReportFleetFixtures } from "../../fixtures/multiremi/daemon-report-fleet.js";
import { createReportScaleFixture, REPORT_SCALES } from "../../fixtures/multiremi/daemon-report-scale.js";

useReportFleetFixtures("file");
// Executions include queued downlinks/offers, through layer.drain(). PG runs
// the same comparisons; its fixed totals need a real-backend capture.
const SQLITE_BUDGETS = {
  hb: { total: 64, reads: 48, writes: 16 },
  'task.start': { total: 100, reads: 81, writes: 19 },
  'task.progress': { total: 54, reads: 44, writes: 10 },
  'task.workspace': { total: 47, reads: 38, writes: 9 },
  'turn.input': { total: 105, reads: 85, writes: 20 },
};
const fleets: Record<string, Awaited<ReturnType<typeof createReportScaleFixture>>> = {};
const costs: Record<string, { total: number; reads: number; writes: number; statements: Record<string, number> }> = {};
afterAll(async () => {
  if (process.env.MULTIREMI_TEST_QUERY_PROFILE) await Bun.write(process.env.MULTIREMI_TEST_QUERY_PROFILE, JSON.stringify(costs, null, 2));
});
beforeAll(async () => {
  for (const [name, scale] of Object.entries(REPORT_SCALES)) fleets[name] = await createReportScaleFixture(scale);
}, 120_000);

test('seed contains every requested scale dimension', () => {
  for (const f of Object.values(fleets)) {
    expect(f.issues).toHaveLength(f.scale.issues);
    expect(f.sessionIds).toHaveLength(f.scale.sessions);
    expect(f.agents).toHaveLength(f.scale.agents);
    expect(f.runtimeIds).toHaveLength(f.scale.runtimes);
    for (const id of f.sessionIds) expect(Number(f.database.query(
      "SELECT COUNT(*) AS n FROM multiremi_conversation_log WHERE session_id=?").get(id)!.n)).toBeGreaterThanOrEqual(f.scale.logsPerSession);
    for (const [table, minimum] of [
      ['multiremi_turn_attempts', f.scale.historicalAttempts],
      ['multiremi_usage_units', f.scale.historicalAttempts],
      ['multiremi_feishu_bot_outbound_deliveries', f.scale.outboxRows],
      ['multiremi_queued_messages', f.scale.queuedRows],
      ['multiremi_runtime_command_requests', f.scale.queuedRows],
      ['multiremi_agent_skills', f.scale.agents * f.scale.skillsPerAgent],
    ] as const) expect(Number(f.database.query(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n)).toBeGreaterThanOrEqual(minimum);
  }
});

// All frames share the seeded fleet. Mutations are deliberately ordered:
// start/progress/workspace/input, then terminal completion and peer failure.
for (const type of ['hb','task.start','task.progress','task.workspace','turn.input','turn.complete','task.fail']) {
  test(`${type}: small and stable statement profile`, async () => {
    for (const [name, f] of Object.entries(fleets)) {
      await settleReportFleet(f);
      const task = ['task.fail', 'task.progress'].includes(type) ? f.peer : f.task;
      const runtime = ['task.fail', 'task.progress'].includes(type) ? f.runtimeIds[2]! : f.runtimeIds[0]!;
      const sessionIndex = ['task.fail', 'task.progress'].includes(type) ? 1 : 0;
      const turn = f.store.getTurnForAttempt(task.id)!;
      const input = f.store.getDaemonTurnBridge().offerInput(f.store.getTaskWithAgent(task.id)!);
      if (type === 'turn.input') f.store.recordSessionAgentRangeRead(f.issueSession.id, f.agent.id,
        { seq: 1, offset: 0 }, { seq: input.input_to_seq + 1, offset: 0 }, task.id);
      const completion = { trace: { head: 0, event_count: 0, tool_call_count: 0, type_histogram: [], closed: true },
        final_reply_md: 'finished', model: { provider: 'claude', model: 'fixture' } };
      let p: Record<string, unknown> = { task_id: task.id };
      if (type === 'task.progress') p = { ...p, summary: 'working', step: 1, total: 2 };
      if (type === 'task.workspace') p = { ...p, runtime_id: runtime, root_path: '/fixture', branch_name: `agent/${f.issue.key}`, status: 'ready', repos: [] };
      if (type === 'turn.input') p = { turn_id: turn.id, attempt_id: task.id, input_to_seq: input.input_to_seq,
        message_ids: input.input_messages.map(message => message.id) };
      if (type === 'turn.complete') p = { ...completion, turn_id: turn.id, attempt_id: task.id,
        input_to_seq: input.input_to_seq, reply: { body_md: 'finished', message_kind: 'final' } };
      if (type === 'task.fail') p = { ...p, ...completion, error: 'fixture failure' };
      const seq = 100 + ['hb','task.start','task.progress','task.workspace','turn.input','turn.complete','task.fail'].indexOf(type);
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const unsubscribe = f.store.onWorkspaceEvent(event => events.push(event));
      const sql = await countSql(f.database, f.layer, () => type === 'hb' ? f.heartbeat(0, false, 1)
        : f.sessions[sessionIndex]!.handleMessage(JSON.stringify({ v: 2, t: type, rt: runtime, seq, id: String(seq), p })));
      unsubscribe();
      if (type !== 'hb') expect(f.frames[sessionIndex]!.find(frame => frame.t === 'res' && frame.re === String(seq))?.p.ok).toBe(true);
      const profile: Record<string, number> = {};
      for (const statement of sql) { const normalized = statement.replace(/\s+/g, ' ').trim(); profile[normalized] = (profile[normalized] ?? 0) + 1; }
      const reads = sql.filter(statement => /^\s*(SELECT|WITH)\b/i.test(statement)).length;
      costs[`${type}:${name}`] = { total: sql.length, reads, writes: sql.length - reads, statements: profile };
      console.info('SCALE_COST', type, name, sql.length, reads, sql.length - reads);
      const measured = { total: sql.length, reads, writes: sql.length - reads };
      const expected = SQLITE_BUDGETS[type as keyof typeof SQLITE_BUDGETS];
      if (expected) {
        if (f.database.dialect === 'sqlite') expect(measured).toEqual(expected);
        if (name === 'stable') {
          const { statements: _, ...small } = costs[`${type}:small`]!;
          expect(measured).toEqual(small);
        }
      }
      if (type === 'task.start') {
        expect(f.store.getTask(task.id)?.status).toBe('running');
        expect(events.filter(event => event.type === 'issue:updated')
          .every(event => event.payload.runtime_id === runtime)).toBe(true);
      }
      if (type === 'task.progress') expect(f.store.getTask(task.id)?.progressSummary).toBe('working');
      if (type === 'task.workspace') {
        expect(f.store.getIssueWorkspace(f.issue.id)?.rootPath).toBe('/fixture');
        expect(events.filter(event => event.type === 'daemon:dispatch_conditions_changed')
          .map(event => event.payload.runtime_id).sort()).toEqual([f.runtimeIds[0], f.runtimeIds[1]].sort());
      }
      if (type === 'turn.input') expect(f.database.query('SELECT input_ack_seq FROM multiremi_turn_attempts WHERE id=?')
        .get(task.id)!.input_ack_seq).toBe(input.input_to_seq);
      if (type === 'turn.complete') {
        expect(f.store.getTask(task.id)?.status).toBe('completed');
        expect(f.store.getMessage(f.store.getTurn(turn.id)!.reply_message_id!)?.body_md).toBe('finished');
      }
      if (type === 'task.fail') expect(f.store.getTask(task.id)?.status).toBe('failed');
    }
  }, 60_000);
}

test('batched downlink identities match individual lookups across runtime and status', async () => {
  for (const f of Object.values(fleets)) {
    const ids = f.database.query('SELECT id FROM multiremi_turn_execution_records').all().map(row => String(row.id));
    const expected = ids.map(id => f.store.getTaskIdentity(id)!).sort((a, b) => a.id.localeCompare(b.id));
    const sql = await countSql(f.database, f.layer, () => {
      expect(f.store.getTaskIdentities([...ids, ids[0]!, 'missing']).sort((a, b) => a.id.localeCompare(b.id))).toEqual(expected);
    });
    expect(sql).toHaveLength(1);
  }
});
