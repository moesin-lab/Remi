import { expect, it } from 'bun:test';
import { withAttemptAdmission, type AttemptWrite } from '@multiremi/store/attempt-admission.js';
import { createReplacementAttemptWithinTransaction } from '@multiremi/store/turn-attempts.js';
import { pendingTurnBackendTests } from './pending-turn-test-backends.js';

const id = 'tsk_admission_check';
const plan = { expectedRevision: 0, workspaceIds: ['local'], numberKeys: [], domainTargets: [`attempt:${id}`] };
const unexpected = (): never => { throw new Error('unexpected execution after rejection'); };
const rejected: AttemptWrite = { attemptId: id, kernel: { admitAttempt: unexpected, consumeAdmission: unexpected },
  resolveInvocation() { throw new Error('root_invoker_untrusted'); }, resolveExecution: unexpected };

pendingTurnBackendTests('attempt admission boundaries', fixture => {
  it('rolls back the initial turn and conversation insert if invocation verification fails', () => {
    const { store, db } = fixture();
    const agent = store.createAgent({ name: 'admission check', provider: 'codex' });
    expect(() => store.withAttemptAdmission(undefined, plan, rejected, () =>
      store.createTask({ id, agentId: agent.id, prompt: 'test' }))).toThrow('root_invoker_untrusted');
    expect(store.getTask(id)).toBeNull();
    expect(db.query('SELECT id FROM multiremi_turns WHERE id=?').get(id)).toBeNull();
    expect(db.query('SELECT id FROM multiremi_conversation_log WHERE id=?').get(id)).toBeNull();
  });

  it('restores the old current attempt and its credential when replacement admission fails', async () => {
    const { store, db } = fixture();
    const agent = store.createAgent({ name: 'replacement admission check', provider: 'codex' });
    const previous = store.createTask({ agentId: agent.id, prompt: 'test' });
    const token = await store.createTaskAccessToken(previous, 'local');
    expect(() => withAttemptAdmission(db, undefined, plan, rejected, () =>
      createReplacementAttemptWithinTransaction(db, previous.id, { previousStatus: 'lost', reason: 'test', id }))).toThrow('root_invoker_untrusted');
    expect(store.getTask(id)).toBeNull();
    expect(store.getTask(previous.id)?.status).toBe(previous.status);
    expect((await store.verifyAccessToken(token.token))?.taskId).toBe(previous.id);
  });
});
