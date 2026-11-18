import { expect, it } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import { MultiremiStore } from '@multiremi/store.js';
import { startMultiremiServer } from '@multiremi/api.js';
import { isolatedEnv } from './upgrade-harness/isolation.js';

it('test-only daemon entry recovers a killed native ACP tool as lost then completed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remi-upgrade-recovery-'));
  for (const path of ['home', 'tmp', 'state', 'locks', 'workspaces', 'control']) await mkdir(join(root, path));
  const db = openSqliteDatabase(':memory:'); const store = new MultiremiStore(db); store.ensureLocalWorkspace();
  const token = await store.createAccessToken({ name: 'upgrade recovery', type: 'daemon', workspaceId: 'local', daemonId: 'upgrade-harness' });
  const server = startMultiremiServer({ store, scheduler: null, backgroundJobs: false, authToken: 'upgrade-test-root', hostname: '127.0.0.1', port: 0 });
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const logs: string[] = [];
  const launch = () => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'upgrade-harness/daemon-entry.ts')], {
      cwd: join(import.meta.dir, '../..'), env: { ...isolatedEnv(root), MULTIREMI_UPGRADE_HARNESS: '1',
        MULTIREMI_SERVER_URL: `http://127.0.0.1:${server.port}`, MULTIREMI_TOKEN: token.token, MULTIREMI_DAEMON_PORT: '0',
        MULTIREMI_HARNESS_CONTROL_DIR: join(root, 'control'), MULTIREMI_HARNESS_FAKE_ACP: join(import.meta.dir, '../fixtures/acp/fake-steering-agent.ts') },
      stdout: 'pipe', stderr: 'pipe',
    });
    children.push(proc);
    const collect = async (stream: ReadableStream<Uint8Array>) => { for await (const bytes of stream) logs.push(new TextDecoder().decode(bytes)); };
    void collect(proc.stderr as ReadableStream<Uint8Array>); void collect(proc.stdout as ReadableStream<Uint8Array>);
    return proc;
  };
  async function wait(description: string, probe: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) { if (await probe()) return; await Bun.sleep(25); }
    throw new Error(`Timed out ${description}: ${logs.join('\n')}`);
  }
  try {
    const first = launch();
    await wait('runtime', () => store.listRuntimes().some(r => r.status === 'online'));
    const agent = store.createAgent({ name: 'Upgrade ACP', provider: 'codex' });
    const chat = store.createChatSession({ agentId: agent.id });
    const task = store.sendChatMessage(chat.id, { body: 'Exercise lost recovery' }).task;
    const turn = store.getTurnForAttempt(task.id)!;
    await wait('provider gate', async () => (await readFile(join(root, 'control/provider.jsonl'), 'utf8').catch(() => '')).includes('control_waiting'));
    expect(store.getTask(task.id)?.status).toBe('running');
    first.kill('SIGKILL'); await first.exited;
    launch();
    await writeFile(join(root, 'control/release'), 'release');
    const attempts = () => db.query('SELECT id,status,failure_reason FROM multiremi_turn_attempts WHERE turn_id=? ORDER BY attempt_no').all(turn.id) as any[];
    await wait('retry completion', () => attempts().some(a => a.status === 'completed'));
    expect(attempts()).toMatchObject([{ id: task.id, status: 'lost', failure_reason: 'runtime_recovery' }, { status: 'completed' }]);
    expect(attempts()).toHaveLength(2);
    expect(store.getTask(attempts()[1].id)?.result).toContain('UPGRADE_HARNESS_OK');
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    await Promise.all(children.map(child => child.exited));
    server.stop(true); db.close(); await rm(root, { recursive: true, force: true });
  }
}, 60_000);
