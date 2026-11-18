import { expect, it, spyOn } from 'bun:test';
import { pendingTurnBackendTests, type PendingTurnTestFixture } from './pending-turn-test-backends.js';
import { createNativeTestQuestion } from './fixtures/native-question.js';
import type { SqlDatabase, SqlStatement } from '@multiremi/store/db/postgres.js';

function measure(db: SqlDatabase, count: () => number) {
  const sql: string[] = [];
  const wrapped = new WeakSet<object>();
  const wrap = (statement: SqlStatement, text: string): SqlStatement => {
    if (wrapped.has(statement)) return statement;
    const proxy = new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (['get', 'all', 'run', 'values'].includes(String(key))) return (...args: unknown[]) => {
        sql.push(text); return value.apply(target, args);
      };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    wrapped.add(proxy); return proxy;
  };
  const query = db.query.bind(db), prepare = db.prepare.bind(db);
  const querySpy = spyOn(db, 'query').mockImplementation(text => wrap(query(text), text));
  const prepareSpy = spyOn(db, 'prepare').mockImplementation(text => wrap(prepare(text), text));
  const run = db.run.bind(db), exec = db.exec.bind(db);
  const runSpy = spyOn(db, 'run').mockImplementation((text, ...args) => { sql.push(text); return run(text, ...args); });
  const execSpy = spyOn(db, 'exec').mockImplementation(text => { sql.push(text); exec(text); });
  try {
    const result = count();
    const writes = sql.filter(text => /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(text)).length;
    return { result, reads: sql.length - writes, writes };
  } finally { querySpy.mockRestore(); prepareSpy.mockRestore(); runSpy.mockRestore(); execSpy.mockRestore(); }
}

function setup(f: PendingTurnTestFixture) {
  const { store, db } = f;
  const runtime = store.registerRuntime({ name: 'budget runtime', provider: 'codex', daemonId: 'budget', maxConcurrency: 16 });
  const agent = store.createAgent({ name: 'budget owner', provider: 'codex', runtimeId: runtime.id });
  const issue = store.createIssue({ title: 'budget issue', assigneeType: 'agent', assigneeId: agent.id });
  const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: 'budget' });
  expect(store.claimTask(runtime.id)?.id).toBe(task.id); store.startTask(task.id);
  const q = createNativeTestQuestion(store, task.id);
  expect(store.getQuestion(q.id)?.stage).toBe('human');
  const base = db.query('SELECT * FROM multiremi_conversation_log WHERE id=?').get(q.id);
  let seq = 10000;
  const clone = (metadata: Record<string, unknown> = JSON.parse(base.metadata), changes: Record<string, unknown> = {}) => {
    const row = { ...base, id: `budget-${++seq}`, seq, dedupe_key: `budget-${seq}`, metadata: JSON.stringify(metadata), ...changes };
    db.query(`INSERT INTO multiremi_conversation_log (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
    return row.id as string;
  };
  const oracle = () => {
    const rows = db.query(`SELECT DISTINCT m.id FROM multiremi_conversation_log m
      LEFT JOIN multiremi_turns t ON t.id=m.task_id LEFT JOIN multiremi_issue_sessions s ON s.id=m.session_id
      WHERE (t.issue_id=? OR s.issue_id=?) AND m.kind='message' AND m.message_kind='decision'
        AND m.deleted_at IS NULL AND m.resolved_at IS NULL`).all(issue.id, issue.id);
    return rows.filter(row => {
      const question = store.getQuestion(row.id);
      return question?.status === 'pending' && question.stage === 'human' && question.source_issue_id === issue.id
        && question.route_reason !== 'source_workspace_changed';
    }).length;
  };
  return { ...f, issue, agent, task, q, base, clone, oracle };
}

pendingTurnBackendTests('MUL-208 pending decision query budget', (fixture, backend) => {
  it('keeps 2 and 1202 native decisions at four reads and zero writes, including UNION deduplication', () => {
    const h = setup(fixture());
    h.clone();
    const before = measure(h.db, h.oracle);
    expect(before.result).toBe(2);
    const small = measure(h.db, () => h.store.countPendingIssueDecisions(h.issue.id));
    expect(small).toEqual({ result: 2, reads: 4, writes: 0 });
    for (let i = 0; i < 1200; i++) h.clone();
    const large = measure(h.db, () => h.store.countPendingIssueDecisions(h.issue.id));
    expect(large).toEqual({ ...small, result: 1202 });
    const beforeLarge = measure(h.db, h.oracle);
    expect(beforeLarge.result).toBe(large.result);
    console.log(`[MUL-208 ${backend}] native before(2/1202): ${before.reads}/${beforeLarge.reads} reads/${before.writes} writes; after 2/1202: ${small.reads}/${large.reads} reads, ${small.writes}/${large.writes} writes`);
  });

  it('keeps mixed historical records at a small fixed budget and matches Questions.get()', () => {
    const h = setup(fixture());
    const historical = { decision_record: { source_issue_id: h.issue.id, issue_id: h.issue.id, kind: 'question', status: 'pending' } };
    h.clone(historical);
    const before = measure(h.db, h.oracle);
    const small = measure(h.db, () => h.store.countPendingIssueDecisions(h.issue.id));
    expect(small.result).toBe(h.oracle());
    expect(small.reads).toBeLessThanOrEqual(8);
    expect(small.writes).toBe(0);
    for (let i = 0; i < 100; i++) h.clone(historical);
    const large = measure(h.db, () => h.store.countPendingIssueDecisions(h.issue.id));
    expect(large).toEqual({ ...small, result: small.result + 100 });
    expect(large.result).toBe(h.oracle());
    console.log(`[MUL-208 ${backend}] mixed before(2): ${before.reads} reads/${before.writes} writes; after 2/102: ${small.reads}/${large.reads} reads, ${small.writes}/${large.writes} writes`);
  });

  it('keeps the native budget fixed when the number of distinct sessions grows', () => {
    const h = setup(fixture());
    const small = measure(h.db, () => h.store.countPendingIssueDecisions(h.issue.id));
    for (let i = 0; i < 32; i++) {
      const session = h.store.createIssueSession(h.issue.id, { title: `Session ${i}`, holdsWorkspace: false });
      h.store.sendMessage({ session_id: session.id, sender: { type: 'platform', id: null },
        to: { type: 'none' }, body_md: 'Bind the conversation head', wake_requested: 'inbox_only' });
      const metadata = JSON.parse(h.base.metadata);
      metadata.question.source_attempt_id = null;
      h.clone(metadata, { session_id: session.id, task_id: null });
    }
    expect(measure(h.db, () => h.store.countPendingIssueDecisions(h.issue.id))).toEqual({ ...small, result: 33 });
    expect(h.oracle()).toBe(33);
  });

  it('excludes an audited retired session after an Issue returns to its original workspace', () => {
    const h = setup(fixture());
    const previous = h.store.createIssueSession(h.issue.id, { title: 'Previous Main', holdsWorkspace: false });
    const next = h.store.createIssueSession(h.issue.id, { title: 'New Main', holdsWorkspace: false });
    h.db.run("UPDATE multiremi_issue_sessions SET workspace_id='foreign',is_default=0,inherit_mode='none',parent_session_id=NULL WHERE id=?", [previous.id]);
    h.db.run("UPDATE multiremi_issue_sessions SET is_default=0,inherit_mode='none',parent_session_id=NULL WHERE id IN (?,?)", [h.base.session_id, next.id]);
    expect(h.store.countPendingIssueDecisions(h.issue.id)).toBe(1);
    h.store.appendIssueActivity(h.issue.id, { actorType: 'system', type: 'issue_main_session_rotated',
      data: { previousSessionId: previous.id, sessionId: next.id, previousWorkspaceId: 'foreign', workspaceId: 'local',
        previousSessionIds: [previous.id], retiredTargetSessionIds: [h.base.session_id] } });
    expect(h.oracle()).toBe(0);
    expect(measure(h.db, () => h.store.countPendingIssueDecisions(h.issue.id))).toEqual({ result: 0, reads: 4, writes: 0 });
  });

  it('preserves source integrity, status, stage, historical upgrades and ordinary-choice exclusions', () => {
    const h = setup(fixture());
    const metadata = JSON.parse(h.base.metadata);
    for (const patch of [
      { workspace_id: 'foreign' }, { source_issue_id: 'missing' }, { source_attempt_id: 'missing' },
      { status: 'answered' }, { status: 'closed' }, { route_reason: 'source_workspace_changed' },
      { route: [{ stage: 'issue_owner', handler: { type: 'agent', id: h.agent.id } }] },
      { route: [], route_index: 0, route_reason: null }, // frozen old human route upgrades at read time
      { route: [{ stage: 'human', handler: { type: 'member', id: 'missing' } }] },
    ]) h.clone({ ...metadata, question: { ...metadata.question, ...patch } });
    for (const changes of [{ sender_id: 'wrong-agent' }, { sender_type: 'member' }, { task_id: null },
      { deleted_at: new Date().toISOString() }, { resolved_at: new Date().toISOString() }]) h.clone(metadata, changes);
    h.clone({ ...metadata, execution_scope: 'wrong' });
    h.clone({}); h.clone({ decision_record: { status: 'pending' } });
    h.clone({ human_request: { kind: 'question', status: 'pending' } });
    h.clone({ human_request: { kind: 'question', status: 'responded' } });
    for (const kind of ['permission', 'question']) for (const status of ['pending', 'escalated', 'answered', 'withdrawn'])
      h.clone({ decision_record: { source_issue_id: h.issue.id, kind, status } });
    expect(h.store.countPendingIssueDecisions(h.issue.id)).toBe(h.oracle());
    const foreignParent = h.store.createIssueSession(h.issue.id, { title: 'Other parent', holdsWorkspace: false });
    for (const mutation of [
      "UPDATE multiremi_issue_sessions SET workspace_id='foreign' WHERE id=?",
      "UPDATE multiremi_conversation_heads SET workspace_id='foreign' WHERE session_id=?",
      `UPDATE multiremi_issue_sessions SET parent_session_id='${foreignParent.id}', workspace_id='foreign' WHERE id=?`,
    ]) {
      h.db.transaction(() => {
        // Keep mutations isolated without changing the original fixture.
        const before = h.db.query('SELECT workspace_id,parent_session_id FROM multiremi_issue_sessions WHERE id=?').get(h.base.session_id);
        h.db.run(mutation, [h.base.session_id]);
        expect(h.store.countPendingIssueDecisions(h.issue.id)).toBe(h.oracle());
        h.db.run('UPDATE multiremi_issue_sessions SET workspace_id=?,parent_session_id=? WHERE id=?', [before.workspace_id, before.parent_session_id, h.base.session_id]);
        h.db.run("UPDATE multiremi_conversation_heads SET workspace_id='local' WHERE session_id=?", [h.base.session_id]);
      })();
    }
    expect(measure(h.db, () => h.store.countPendingIssueDecisions('missing-issue'))).toEqual({ result: 0, reads: 1, writes: 0 });
  });
});
