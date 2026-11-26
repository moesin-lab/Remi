import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { countSql, settleReportFleet, useReportFleetFixtures } from "../../fixtures/multiremi/daemon-report-fleet.js";
import { createReportScaleFixture, REPORT_SCALES } from "../../fixtures/multiremi/daemon-report-scale.js";

useReportFleetFixtures("file");
// Executions include queued downlinks/offers, through layer.drain(). PG runs
// the same comparisons; its fixed totals need a real-backend capture.
// MUL-31 adds fixed generation/handoff authority reads. Checkpoint projections
// join the existing batched snapshot; small/stable equality and the 9-query
// snapshot ceiling below must not grow with active attempts.
const SQLITE_BUDGETS = {
  hb: { total: 60, reads: 43, writes: 17 },
  'task.start': { total: 81, reads: 64, writes: 17 },
  'task.progress': { total: 43, reads: 34, writes: 9 },
  'task.workspace': { total: 39, reads: 31, writes: 8 },
  'turn.input': { total: 90, reads: 75, writes: 15 },
  'turn.complete': { total: 230, reads: 178, writes: 52 },
  'task.fail': { total: 143, reads: 118, writes: 25 },
};
const fleets: Record<string, Awaited<ReturnType<typeof createReportScaleFixture>>> = {};
const costs: Record<string, { total: number; reads: number; writes: number; statements: Record<string, number> }> = {};
afterAll(async () => {
  if (process.env.MULTIREMI_TEST_QUERY_PROFILE) await Bun.write(process.env.MULTIREMI_TEST_QUERY_PROFILE, JSON.stringify(costs, null, 2));
});
beforeAll(async () => {
  // PG seed/round trips can cross store freshness and offer retry windows.
  // Measure identical state/time in both tiers; protocol timers are manual too.
  setSystemTime(new Date('2026-11-17T12:00:00.000Z'));
  for (const [name, scale] of Object.entries(REPORT_SCALES)) fleets[name] = await createReportScaleFixture({ ...scale,
    ...(process.env.MULTIREMI_TEST_SCALE_DIMENSIONS ? JSON.parse(process.env.MULTIREMI_TEST_SCALE_DIMENSIONS) : {}),
    ...(name === 'stable' && process.env.MULTIREMI_TEST_STABLE_DIMENSIONS ? JSON.parse(process.env.MULTIREMI_TEST_STABLE_DIMENSIONS) : {}),
  });
}, 120_000);

test('seed contains every requested scale dimension', () => {
  for (const f of Object.values(fleets)) {
    expect(f.activeTasks).toHaveLength(f.scale.activeAttempts ?? 0);
    expect(f.questionIds).toHaveLength(f.scale.pendingQuestions ?? 0);
    for (const id of f.questionIds) expect(f.store.getQuestion(id)?.status).toBe('pending');
    expect(Number(f.database.query("SELECT COUNT(*) AS n FROM multiremi_feishu_bot_outbound_deliveries WHERE id LIKE 'scale-pending-%' AND status IN ('pending','sending')").get()!.n))
      .toBe(f.scale.pendingOutbound ?? 0);
    for (const task of f.activeTasks) expect(['running','awaiting_human']).toContain(f.store.getTask(task.id)?.status!);
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
      const trace = process.env.MULTIREMI_TEST_SQL_TRACE;
      if (trace) process.env.MULTIREMI_TEST_SQL_TRACE = `${trace}-${type}-${name}`;
      // Keep the independently tested one-second readiness probe outside the
      // business SQL profile, even when a PG round trip crosses its TTL.
      f.store.checkDatabaseReady(true);
      const sql = await countSql(f.database, f.layer, () => type === 'hb' ? f.heartbeat(0, false, 1)
        : f.sessions[sessionIndex]!.handleMessage(JSON.stringify({ v: 2, t: type, rt: runtime, seq, id: String(seq), p })));
      if (trace) process.env.MULTIREMI_TEST_SQL_TRACE = trace;
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
          if (JSON.stringify(measured) !== JSON.stringify(small)) {
            const prior = costs[`${type}:small`]!.statements;
            console.info('SCALE_SQL_DIFF', type, JSON.stringify([...new Set([...Object.keys(prior), ...Object.keys(profile)])]
              .filter(sql => (prior[sql] ?? 0) !== (profile[sql] ?? 0))
              .map(sql => ({ sql, small: prior[sql] ?? 0, stable: profile[sql] ?? 0 }))));
          }
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

test('batched snapshots retain every live interrupt and wrap-up and exclude foreign attempts', async () => {
  for (const f of Object.values(fleets)) {
    const tasks = f.activeTasks.filter(task => f.store.getTask(task.id)?.status === 'running');
    const expected = tasks.map(task => f.store.sendChatMessage(task.chatSessionId!, { body: `Interrupt ${task.id}` }).message.id);
    await settleReportFleet(f);
    const turn = f.store.getTurnForAttempt(tasks[0]!.id)!;
    const at = new Date().toISOString();
    f.database.run('UPDATE multiremi_turns SET wrap_up_requested_at=? WHERE id=?', [at, turn.id]);
    let result!: ReturnType<ReturnType<typeof f.store.getDaemonTurnBridge>['snapshot']>;
    const sql = await countSql(f.database, f.layer, () => {
      result = f.store.getDaemonTurnBridge().snapshot({ runtimeId: f.runtimeIds[0]!, daemonId: 'dm_cost_0', workspaceId: 'local' },
        new Set([...tasks.map(task => task.id), f.peer.id, 'missing-attempt']));
    });
    expect(result.messages.map(input => input.message.id).sort()).toEqual(expected.sort());
    expect(result.wrapUps).toEqual([{ turn_id: turn.id, attempt_id: tasks[0]!.id, requested_at: at }]);
    expect(sql.length).toBeLessThanOrEqual(9);
    const wrongHost = f.store.getDaemonTurnBridge().snapshot({ runtimeId: f.runtimeIds[0]!, daemonId: 'foreign-daemon', workspaceId: 'local' },
      new Set(tasks.map(task => task.id)));
    expect(wrongHost).toEqual({ messages: [], wrapUps: [] });
  }
}, 60_000);
