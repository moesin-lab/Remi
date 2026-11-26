// Copied into the previous release's worktree and resolved using ITS tsconfig.
// Only PostgreSQL is shared with the candidate; no candidate modules are loaded.
import assert from 'node:assert/strict';
import { PostgresSyncDatabase } from '../packages/server/src/store/db/postgres.ts';
import { MultiremiStore } from '../packages/server/src/store/store.ts';

const db = new PostgresSyncDatabase(process.env.MULTIREMI_DATABASE_URL!);
try {
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  if (process.env.MUL173_EXPECT_TASK) {
    const preserved = store.getTask(process.env.MUL173_EXPECT_TASK);
    assert.equal(preserved?.status, 'completed', 'Previous task must survive candidate migrations');
    assert.equal(preserved?.prompt, 'MUL-173 mixed-version PostgreSQL core probe');
  }
  const runtime = store.registerRuntime({ name: `mixed-${crypto.randomUUID()}`, provider: 'codex', workspaceId: 'local', ownerId: 'local' });
  const agent = store.createAgent({ name: `mixed-${crypto.randomUUID()}`, provider: 'codex', workspaceId: 'local', runtimeId: runtime.id });
  const task = store.createTask({ agentId: agent.id, prompt: 'MUL-173 mixed-version PostgreSQL core probe', workspaceId: 'local' });
  assert.equal(store.getTask(task.id)?.status, 'queued');
  assert.equal(store.claimTask(runtime.id, { supportsPromptPolicy: true })?.id, task.id);
  store.startTask(task.id);
  assert.equal(store.getTask(task.id)?.status, 'running');
  store.completeTask(task.id, { output: 'completed against shared schema' });
  assert.equal(store.getTask(task.id)?.status, 'completed');
  const cancelled = store.createTask({ agentId: agent.id, prompt: 'cancel core probe', workspaceId: 'local' });
  store.cancelTask(cancelled.id);
  assert.equal(store.getTask(cancelled.id)?.status, 'cancelled');
  console.log(JSON.stringify({ probe: 'previous-release-core', pass: true, task: task.id, cancelled: cancelled.id }));
} finally { db.close(); }
