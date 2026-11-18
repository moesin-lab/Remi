/** Cross-ref daemon recovery with a real SQLite API and separate native ACP processes. */
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openSqliteDatabase } from '@multiremi/store/db/sqlite.js';
import { MultiremiStore } from '@multiremi/store.js';
import { startMultiremiServer } from '@multiremi/api.js';
import { assertPort, isolatedEnv, SESSION_ENV } from './isolation.js';

export async function runDaemonUpgrade(releaseRef: string, output: string) {
  const repository = resolve(import.meta.dir, '../../..');
  const root = await mkdtemp(join(tmpdir(), 'remi-daemon-upgrade-'));
  await mkdir(output, { recursive: true });
  for (const path of ['home', 'tmp', 'state', 'locks', 'workspaces', 'control']) await mkdir(join(root, path));
  const env = isolatedEnv(root);
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const collectors: Promise<unknown>[] = [];
  const logs: string[] = [];
  const evidence: any = { kind: 'docker-free-daemon', sources: {}, scenarios: [], root };
  let db: ReturnType<typeof openSqliteDatabase> | undefined;
  let server: ReturnType<typeof startMultiremiServer> | undefined;
  let failure: unknown;
  const stop = () => { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  async function command(argv: string[], cwd = repository, clean = true) {
    const child = Bun.spawn(argv, { cwd, env: clean ? env : process.env, stdout: 'pipe', stderr: 'pipe' });
    children.push(child);
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    logs.push(`${argv[0]} ${argv[1]} (${code})\n${stderr}`);
    assert.equal(code, 0, `${argv[0]} ${argv[1]} failed: ${stderr}`);
    return stdout.trim();
  }
  async function wait(description: string, probe: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) { if (await probe()) return; await Bun.sleep(50); }
    throw new Error(`Timed out ${description}; see daemon-upgrade.log`);
  }
  try {
    const candidateSha = await command(['git', 'rev-parse', 'HEAD'], repository, false);
    const releaseSha = await command(['git', 'rev-parse', '--verify', `${releaseRef}^{commit}`], repository, false);
    assert.notEqual(releaseSha, candidateSha, 'Release must differ from candidate HEAD');
    assert.equal(await command(['git', 'status', '--porcelain', '--untracked-files=no'], repository, false), '', 'Commit candidate changes before rehearsal');
    for (const [label, sha] of [['release', releaseSha], ['candidate', candidateSha]]) {
      const source = join(root, label!); await mkdir(source);
      const archive = join(root, `${label}.tar`);
      await command(['git', 'archive', '--format=tar', `--output=${archive}`, sha!], repository, false);
      await command(['tar', '-xf', archive, '-C', source]);
      // Only the explicit test entry is overlaid, not production implementation or schema.
      await mkdir(join(source, 'tests/integration/upgrade-harness'), { recursive: true });
      await cp(join(import.meta.dir, 'daemon-entry.ts'), join(source, 'tests/integration/upgrade-harness/daemon-entry.ts'));
      await command([process.execPath, 'install', '--registry', 'https://registry.npmjs.org', '--frozen-lockfile', '--ignore-scripts'], source);
      evidence.sources[label!] = { sha, version: JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).version, source };
    }
    db = openSqliteDatabase(join(root, 'api.sqlite'));
    const store = new MultiremiStore(db); store.ensureLocalWorkspace();
    const token = await store.createAccessToken({ name: 'isolated daemon upgrade', type: 'daemon', workspaceId: 'local', daemonId: 'upgrade-harness' });
    server = startMultiremiServer({ store, scheduler: null, backgroundJobs: false, authToken: crypto.randomUUID(), hostname: '127.0.0.1', port: 0 });
    assertPort(server.port!);
    const portProbe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('probe') });
    const port = portProbe.port!; portProbe.stop(true); assertPort(port);
    evidence.ports = { api: server.port, daemon: port };
    async function launch(label: string) {
      const build = evidence.sources[label];
      const child = Bun.spawn([process.execPath, join(build.source, 'tests/integration/upgrade-harness/daemon-entry.ts')], {
        cwd: build.source, env: { ...env, MULTIREMI_UPGRADE_HARNESS: '1', MULTIREMI_SERVER_URL: `http://127.0.0.1:${server!.port}`,
          MULTIREMI_TOKEN: token.token, MULTIREMI_DAEMON_PORT: String(port), MULTIREMI_VERSION: build.version,
          MULTIREMI_HARNESS_CONTROL_DIR: join(root, 'control'), MULTIREMI_HARNESS_FAKE_ACP: join(repository, 'tests/fixtures/acp/fake-steering-agent.ts') },
        stdout: 'pipe', stderr: 'pipe',
      });
      children.push(child);
      for (const stream of [child.stdout, child.stderr]) collectors.push((async () => { for await (const bytes of stream) logs.push(new TextDecoder().decode(bytes).replaceAll(token.token, '<redacted>')); })());
      await wait(`${label} daemon version ${build.version}`, () => {
        assert.equal(child.exitCode, null, `${label} daemon exited; see daemon-upgrade.log`);
        return store.listRuntimes().some(r => r.status === 'online' && r.metadata?.cli_version === build.version);
      });
      const actualEnv = (await readFile(`/proc/${child.pid}/environ`, 'utf8')).split('\0').map(s => s.split('=')[0]);
      for (const key of SESSION_ENV) assert(!actualEnv.includes(key), `Inherited ${key}`);
      const leaseRoot = join(root, 'locks/shared-locks/workspace-supervisors');
      const owners = await Promise.all((await readdir(leaseRoot)).map(async name => JSON.parse(await readFile(join(leaseRoot, name, 'owner.lock/owner.json'), 'utf8'))));
      assert.equal(owners.length, 1);
      assert.equal(owners[0].pid, child.pid); assert.equal(owners[0].released, false);
      assert.equal(owners[0].workspace_root, join(root, 'state/workspaces')); assert.equal(owners[0].base_port, port);
      evidence.boundary = { lease_root: leaseRoot, lease_owner_pid: child.pid, session_environment_absent: true };
      evidence.sources[label].observed_cli_version = build.version;
      return child;
    }
    let current = await launch('release');
    const agent = store.createAgent({ name: 'Cross-ref fake ACP', provider: 'codex' });
    for (const label of ['candidate', 'release']) {
      await rm(join(root, 'control/release'), { force: true });
      await rm(join(root, 'control/provider.jsonl'), { force: true });
      const chat = store.createChatSession({ agentId: agent.id });
      const task = store.sendChatMessage(chat.id, { body: `Hold long tool during ${label} switch` }).task;
      const turn = store.getTurnForAttempt(task.id)!;
      await wait('long ACP tool gate', async () => (await readFile(join(root, 'control/provider.jsonl'), 'utf8').catch(() => '')).includes('control_waiting'));
      assert.equal(store.getTask(task.id)?.status, 'running');
      current.kill('SIGKILL'); await current.exited;
      current = await launch(label);
      await writeFile(join(root, 'control/release'), 'release');
      const attempts = () => db!.query('SELECT id,status,failure_reason FROM multiremi_turn_attempts WHERE turn_id=? ORDER BY attempt_no').all(turn.id) as any[];
      await wait('retry completion', () => attempts().some(a => a.status === 'completed'));
      const actual = attempts();
      assert.equal(actual.length, 2);
      assert.equal(actual[0].id, task.id); assert.equal(actual[0].status, 'lost'); assert.equal(actual[0].failure_reason, 'runtime_recovery');
      assert.notEqual(actual[0].id, actual[1].id); assert.equal(actual[1].status, 'completed');
      assert.match(store.getTask(actual[1].id)!.result!, /UPGRADE_HARNESS_OK/);
      evidence.scenarios.push({ kind: label === 'candidate' ? 'daemon-upgrade' : 'daemon-rollback', ...evidence.sources[label], attempts: actual });
      console.error(`Docker-free ${evidence.scenarios.at(-1).kind}: ${evidence.sources[label].sha} version=${evidence.sources[label].version} lost(runtime_recovery) -> completed`);
    }
  } catch (error) { failure = error; }
  finally {
    stop(); await Promise.all(children.map(child => child.exited)); await Promise.all(collectors);
    server?.stop(true); db?.close();
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    evidence.ok = !failure; evidence.error = failure ? String(failure) : null;
    await writeFile(join(output, 'daemon-upgrade.log'), logs.join('\n'));
    await writeFile(join(output, 'daemon-upgrade.json'), JSON.stringify(evidence, null, 2));
    await rm(root, { recursive: true, force: true });
  }
  if (failure) throw failure;
  return evidence;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const ref = args.find(a => a.startsWith('--release-ref='))?.slice('--release-ref='.length);
  const output = resolve(args.find(a => a.startsWith('--output='))?.slice('--output='.length) ?? 'upgrade-harness-results');
  assert(ref && args.every(a => /^--(?:release-ref|output)=.+$/.test(a)), 'Usage: bun run tests/integration/upgrade-harness/daemon-upgrade.ts --release-ref=REF [--output=PATH]');
  await runDaemonUpgrade(ref, output);
}
