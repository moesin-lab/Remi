/** MUL-27: disposable Linux full stack. No model credentials, host mounts or services. */
import assert from 'node:assert/strict';
import { runDaemonUpgrade } from './upgrade-harness/daemon-upgrade.js';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { snapshotProduction, compareSnapshots, isolatedEnv, assertPort, SESSION_ENV } from './upgrade-harness/isolation.js';
import { ContainerApplicationDriver } from '../../packages/platform-updater/src/application-driver.js';
import { PlatformUpdaterClient } from '../../packages/platform-updater/src/client.js';
import { PlatformUpdateWorker } from '../../packages/platform-updater/src/worker.js';
import { DATA_SCHEMA_INPUTS, migrationFingerprint } from '../../packages/platform-updater/src/safety.js';
import { API_BASE_INPUTS, type ApplicationManifest } from '../../packages/platform-updater/src/application-manifest.js';

const args = process.argv.slice(2);
const value = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
if (args.includes('--help')) {
  console.log('bun run tests/integration/upgrade-harness.ts --release-ref=v0.2.90 [--output=PATH] [--self-check-only]');
  process.exit(0);
}
for (const arg of args) assert(/^--(?:release-ref|output)=.+$/.test(arg) || arg === '--self-check-only', `Unknown option: ${arg}`);
const selfCheckOnly = args.includes('--self-check-only');
const releaseRef = value('release-ref');
assert(selfCheckOnly || releaseRef, 'An explicit --release-ref is required; HEAD is never silently treated as a release');
const repository = resolve(import.meta.dir, '../..');
const output = resolve(value('output') ?? 'upgrade-harness-results');
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), 'remi-upgrade-'));
const project = `remi-upgrade-${randomUUID().slice(0, 12)}`;
const env = isolatedEnv(root);
for (const path of ['home', 'tmp', 'state', 'locks', 'workspaces']) await mkdir(join(root, path), { recursive: true });
const composeFile = join(root, 'compose.json'), envFile = join(root, 'compose.env');
const adminToken = randomUUID(), updaterToken = randomUUID();
const evidence: Record<string, any> = { project, root, self_check_only: selfCheckOnly, scenarios: [] };
let before: ReturnType<typeof snapshotProduction> | undefined;
let failure: unknown;
let dockerAvailable = false, composeStarted = false, cleaning = false, interrupted = false;
const running = new Set<ReturnType<typeof Bun.spawn>>();
const onSignal = () => { interrupted = true; for (const child of running) child.kill('SIGTERM'); };
process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
const images: string[] = [];
const originalFetch = globalThis.fetch;
const log = async (line: string) => {
  const redacted = [adminToken, updaterToken, evidence.daemon_token].filter(Boolean).reduce((s, token) => s.replaceAll(token, '<redacted>'), line);
  await writeFile(join(output, 'run.log'), redacted + '\n', { flag: 'a' });
  console.error(redacted);
};
async function command(cmd: string[], options: { cwd?: string; clean?: boolean } = {}) {
  if (interrupted && !cleaning) throw new Error('Harness interrupted; cleaning isolated resources');
  const child = Bun.spawn(cmd, { cwd: options.cwd ?? repository, env: options.clean === false ? process.env : env, stdout: 'pipe', stderr: 'pipe' });
  running.add(child);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  running.delete(child);
  if (code !== 0) { await log(`${cmd[0]} ${cmd[1]} failed (${code}): ${stderr.slice(-8000)} ${stdout.slice(-2000)}`); throw new Error(`${cmd[0]} ${cmd[1]} exited ${code}`); }
  return stdout.trim();
}
const docker = (args: string[]) => command(['docker', ...args]);
const compose = (args: string[]) => docker(['compose', '-p', project, '--env-file', envFile, '-f', composeFile, ...args]);
async function save(path: string, text: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); }
async function wait<T>(description: string, probe: () => Promise<T | false | null | undefined>, timeout = 90_000): Promise<T> {
  const end = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < end) {
    if (interrupted) throw new Error('Harness interrupted');
    try { const result = await probe(); if (result) return result as T; } catch (error) { last = error; }
    await Bun.sleep(100);
  }
  throw new Error(`Timed out: ${description}${last ? ` (${last})` : ''}`);
}
async function freePort() {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('probe') });
  const port = server.port!; server.stop(true); assertPort(port); return port;
}
try {
  before = snapshotProduction();
  evidence.before = before;
  if (!selfCheckOnly) {
    evidence.docker_free_daemon = await runDaemonUpgrade(releaseRef!, output);
    // Always execute the observation finally block, including Docker failures.
    const dockerVersion = await docker(['version', '--format', '{{.Server.Version}}']);
    assert(/^\d+\.\d+/.test(dockerVersion), 'Docker server unavailable (no server version; check socket permissions)');
    await docker(['compose', 'version']);
    dockerAvailable = true;
    assert.equal(before.observation_errors.length, 0, 'Cannot fully observe production boundary; see observation_errors');
    const candidateSha = await command(['git', 'rev-parse', 'HEAD'], { clean: false });
    const releaseSha = await command(['git', 'rev-parse', '--verify', `${releaseRef}^{commit}`], { clean: false });
    assert.notEqual(releaseSha, candidateSha, 'Release and candidate must have different SHAs');
    // Refuse uncommitted inputs: provenance is the archived commit, never an accidental workspace overlay.
    assert.equal(await command(['git', 'status', '--porcelain', '--untracked-files=no'], { clean: false }), '', 'Commit candidate changes before the full rehearsal');
    const builds: Record<string, { source: string; image: string; webImage: string; version: string; sha: string }> = {};
    for (const [label, sha] of [['release', releaseSha], ['candidate', candidateSha]]) {
      await log(`Building ${label} ${sha}`);
      const source = join(root, label!); await mkdir(source);
      const archive = join(root, `${label}.tar`);
      await command(['git', 'archive', '--format=tar', `--output=${archive}`, sha!], { clean: false });
      await command(['tar', '-xf', archive, '-C', source]);
      await cp(join(repository, 'tests/integration/upgrade-harness'), join(source, 'tests/integration/upgrade-harness'), { recursive: true });
      await save(join(source, 'harness-provenance.json'), JSON.stringify({ sha }));
      const version = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).version as string;
      const image = `${project}-${label}:test`, webImage = `${project}-${label}-web:test`;
      images.push(image, webImage);
      await save(join(source, 'tests/integration/upgrade-harness/Dockerfile'), `FROM oven/bun:1.3.14\nWORKDIR /app\nCOPY . .\nRUN bun install --registry https://registry.npmjs.org --frozen-lockfile --ignore-scripts\nRUN mkdir -p /isolated/home /isolated/tmp /isolated/state /isolated/locks /isolated/workspaces\nENV NODE_ENV=test\nCMD ["bun","tests/integration/upgrade-harness/api-entry.ts"]\n`);
      // The test image has a single stable base recipe across refs; production Dockerfiles are not used as compatibility evidence.
      await cp(join(source, 'tests/integration/upgrade-harness/Dockerfile'), join(source, 'deploy/docker/Dockerfile.api'));
      await save(join(source, 'deploy/docker/api-entrypoint.sh'), '#!/bin/sh\nexec "$@"\n');
      await save(join(source, 'apps/server/main.ts'), `import '../../tests/integration/upgrade-harness/api-entry.ts';`);
      await docker(['build', '-t', image, '-f', join(source, 'tests/integration/upgrade-harness/Dockerfile'), source]);
      // Real Next standalone application, with the API's fixed container DNS name.
      await docker(['build', '-t', webImage, '-f', join(source, 'deploy/docker/Dockerfile.web'), '--build-arg', `REMI_APP_VERSION=${version}`, '--build-arg', 'NEXT_BUILD_CPUS=2', source]);
      builds[label!] = { source, image, webImage, version, sha: sha! };
    }
    evidence.sources = builds;
    await save(envFile, '');
    await mkdir(join(root, 'control'));
    await cp(join(repository, 'tests/fixtures/acp/fake-steering-agent.ts'), join(root, 'control/fake-steering-agent.ts'));
    const apiPort = await freePort(), controlPort = await freePort(), webPort = await freePort();
    assert.equal(new Set([apiPort, controlPort, webPort]).size, 3, 'Duplicate allocated ports; retry harness');
    const apiUrl = `http://127.0.0.1:${apiPort}`, webUrl = `http://127.0.0.1:${webPort}`, controlUrl = `http://127.0.0.1:${controlPort}`;
    evidence.ports = { api: apiPort, control: controlPort, web: webPort, daemon: 19131 };
    const containerEnv = { ...isolatedEnv('/isolated'), PATH: '/usr/local/bin:/usr/bin:/bin',
      MULTIREMI_UPGRADE_HARNESS: '1', MULTIREMI_DATABASE_URL: 'postgresql://fixture@postgres:5432/fixture',
      FIXTURE_ADMIN_TOKEN: adminToken, FIXTURE_UPDATER_TOKEN: updaterToken, HARNESS_SOURCE_SHA: releaseSha, MULTIREMI_VERSION: builds.release!.version };
    const model: any = { services: {
      postgres: { image: 'pgvector/pgvector:pg17', environment: { POSTGRES_HOST_AUTH_METHOD: 'trust', POSTGRES_USER: 'fixture', POSTGRES_DB: 'fixture' }, volumes: ['db:/var/lib/postgresql/data'], healthcheck: { test: ['CMD-SHELL', 'pg_isready -U fixture -d fixture'], interval: '1s', retries: 60 } },
      api: { image: builds.release!.image, init: true, environment: containerEnv, ports: [`127.0.0.1:${apiPort}:6120`, `127.0.0.1:${controlPort}:6121`], volumes: ['api-home:/isolated'], depends_on: { postgres: { condition: 'service_healthy' } } },
      web: { image: builds.release!.webImage, init: true, ports: [`127.0.0.1:${webPort}:3000`] },
    }, volumes: { db: {}, 'api-home': {}, 'daemon-home': {}, control: {} } };
    await save(composeFile, JSON.stringify(model));
    composeStarted = true;
    await compose(['up', '-d', 'postgres', 'api', 'web']);
    const headers = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };
    async function control(path: string, method = 'GET'): Promise<any> {
      const response = await originalFetch(controlUrl + path, { method, headers, signal: AbortSignal.timeout(5000) });
      assert(response.ok, `Control ${path}: ${response.status}`); return response.json();
    }
    await wait('release API', () => control('/version'));
    await wait('real Web', async () => (await originalFetch(webUrl + '/login')).ok);
    const token = await control('/token', 'POST'); evidence.daemon_token = token.token;
    model.services.daemon = { image: builds.release!.image, init: true,
      command: ['bun', 'tests/integration/upgrade-harness/daemon-entry.ts'],
      environment: { ...containerEnv, MULTIREMI_SERVER_URL: 'http://api:6120', MULTIREMI_TOKEN: token.token },
      volumes: ['daemon-home:/isolated', 'control:/control', { type: 'bind', source: join(root, 'control/fake-steering-agent.ts'), target: '/fixture/fake-steering-agent.ts', read_only: true }] };
    await save(composeFile, JSON.stringify(model));
    await compose(['up', '-d', 'daemon']);
    await wait('daemon online', async () => (await control('/runtimes')).some((r: any) => r.status === 'online'));
    // Container boundary plus explicit allowlist, checked from the actual process environment.
    const inspectBoundary = async () => {
      const id = await compose(['ps', '-q', 'daemon']);
      const inspection = JSON.parse(await docker(['inspect', id]))[0];
      for (const mount of inspection.Mounts) if (mount.Type === 'bind') assert(mount.Source.startsWith(root + '/'), 'Unexpected host mount');
      const proc = await docker(['exec', id, 'bun', '-e', `const fs=require('node:fs');console.log(JSON.stringify(fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x)).flatMap(p=>{try{return [fs.readFileSync('/proc/'+p+'/environ','utf8').split('\\0').map(x=>x.split('=')[0])]}catch{return []}})))`]);
      for (const keys of JSON.parse(proc)) for (const key of SESSION_ENV) assert(!keys.includes(key), `Inherited ${key}`);
      const leases = await docker(['exec', id, 'find', '/isolated', '-name', 'owner.json']);
      assert(leases.includes('/isolated/locks/shared-locks/'), 'Supervisor lease escaped explicit test lock root');
      evidence.daemon_boundary = { systemd_session_environment_absent: true, leases: leases.split('\n'), mounts_checked: true };
    };
    const providerLines = () => docker(['compose', '-p', project, '--env-file', envFile, '-f', composeFile, 'exec', '-T', 'daemon', 'cat', '/control/provider.jsonl']);
    const clearGate = async () => { await compose(['exec', '-T', 'daemon', 'rm', '-f', '/control/release', '/control/provider.jsonl']); };
    const releaseGate = () => compose(['exec', '-T', 'daemon', 'touch', '/control/release']);
    const heldTask = async () => {
      await clearGate(); const task = await control('/task', 'POST');
      await wait('ACP tool running', async () => (await providerLines()).includes('control_waiting'));
      assert.equal((await control(`/task/${task.id}`)).status, 'running');
      // Workspace leases exist on demand, after the first task acquires its workspace.
      await inspectBoundary();
      return task;
    };
    const assertCompleted = async (task: any) => {
      await wait('completed attempt', async () => (await control(`/attempts/${task.turnId}`)).some((a: any) => a.status === 'completed'));
      const attempts = await control(`/attempts/${task.turnId}`);
      const completed = attempts.find((a: any) => a.status === 'completed');
      assert.match((await control(`/task/${completed.id}`)).result ?? '', /UPGRADE_HARNESS_OK/);
      return attempts;
    };
    // This baseline is deliberately concentrated here; MUL-28/31 can change the contract explicitly.
    const assertLostThenCompleted = (attempts: any[]) => {
      assert.equal(attempts.length, 2); assert.equal(attempts[0].status, 'lost');
      assert.equal(attempts[0].failure_reason, 'runtime_recovery');
      assert.equal(attempts[1].status, 'completed'); assert.notEqual(attempts[0].id, attempts[1].id);
    };
    for (const label of ['candidate', 'release']) {
      const task = await heldTask();
      // Abrupt process replacement preserves the current restart/recovery behavior, without any host service call.
      await compose(['kill', '-s', 'SIGKILL', 'daemon']);
      model.services.daemon.image = builds[label]!.image;
      model.services.daemon.environment.HARNESS_SOURCE_SHA = builds[label]!.sha;
      model.services.daemon.environment.MULTIREMI_VERSION = builds[label]!.version;
      await save(composeFile, JSON.stringify(model));
      await compose(['up', '-d', '--no-deps', '--force-recreate', 'daemon']);
      await releaseGate();
      const attempts = await assertCompleted(task); assertLostThenCompleted(attempts);
      const actual = await compose(['exec', '-T', 'daemon', 'bun', '-p', 'require("./package.json").version']);
      assert.equal(actual, builds[label]!.version);
      await wait('running daemon version', async () => (await control('/runtimes')).some((r: any) => r.metadata?.cli_version === actual || r.metadata?.version === actual));
      evidence.scenarios.push({ kind: `daemon-${label === 'candidate' ? 'upgrade' : 'rollback'}`, source_sha: builds[label]!.sha, version: actual, attempts });
      await inspectBoundary();
    }
    await log('Daemon upgrade and rollback: lost -> new completed attempt');

    // Real host application updater, including its drain gate, backup and rollback.
    const commandRunner = { async run(cmd: string, argv: string[], options: import('../../packages/platform-updater/src/types.js').CommandOptions = {}) {
      const child = Bun.spawn([cmd, ...argv], { cwd: options.cwd, env: { ...env, ...options.env },
        stdin: options.stdinFile ? Bun.file(options.stdinFile) : 'ignore',
        stdout: options.stdoutFile ? Bun.file(options.stdoutFile) : 'pipe', stderr: 'pipe' });
      const [stdout, stderr, exitCode] = await Promise.all([typeof child.stdout === 'number' ? Promise.resolve('') : new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (exitCode) await log(`Updater ${cmd} ${argv[0]} failed: ${stderr.slice(-4000)}`);
      return { stdout, stderr, exitCode };
    } };
    const apiId = await compose(['ps', '-q', 'api']), webId = await compose(['ps', '-q', 'web']);
    const pgId = await compose(['ps', '-q', 'postgres']);
    const apiRoot = join(root, 'platform-release/api'), webRoot = join(root, 'platform-release/web');
    await mkdir(apiRoot, { recursive: true }); await mkdir(webRoot, { recursive: true });
    await docker(['cp', `${apiId}:/app/.`, apiRoot]); await docker(['cp', `${webId}:/app/.`, webRoot]);
    // Product updater starts this canonical application path. Test controls stay tests-only.
    await save(join(apiRoot, 'apps/server/main.ts'), `import '../../tests/integration/upgrade-harness/api-entry.ts';`);
    const fingerprint = async (directory: string, files: readonly string[]) => migrationFingerprint((await Promise.all(files.map(file => readFile(join(directory, file), 'utf8')))).join(''));
    const schema = await fingerprint(apiRoot, DATA_SCHEMA_INPUTS), apiBase = await fingerprint(apiRoot, API_BASE_INPUTS);
    const installedApi = await docker(['inspect', '--format', '{{.Image}}', apiId]), installedWeb = await docker(['inspect', '--format', '{{.Image}}', webId]);
    const previous = { version: builds.release!.version, ref: releaseSha, dataSchema: schema, apiImage: installedApi, webImage: installedWeb, publishedAt: null, releaseUrl: null, manifestUrl: null };
    await save(join(root, 'current-release.json'), JSON.stringify(previous));
    const arch = await docker(['exec', apiId, 'bun', '-p', 'process.arch']);
    const apiLibc = await docker(['exec', apiId, 'getconf', 'GNU_LIBC_VERSION']), webLibc = await docker(['exec', webId, 'getconf', 'GNU_LIBC_VERSION']);
    const candidateRoot = join(root, 'platform-candidate'); await mkdir(candidateRoot);
    await mkdir(join(candidateRoot, 'api')); await mkdir(join(candidateRoot, 'web'));
    // Extract from stopped, network-free containers; never execute a candidate against host state.
    for (const [role, image] of [['api', builds.candidate!.image], ['web', builds.candidate!.webImage]]) {
      const id = await docker(['create', '--network', 'none', image!]);
      try { await docker(['cp', `${id}:/app/.`, join(candidateRoot, role!)]); } finally { await docker(['rm', id]); }
    }
    await save(join(candidateRoot, 'api/apps/server/main.ts'), `import '../../tests/integration/upgrade-harness/api-entry.ts';`);
    const candidateSchema = await fingerprint(join(candidateRoot, 'api'), DATA_SCHEMA_INPUTS);
    const manifest: ApplicationManifest = { ...previous, version: builds.candidate!.version, ref: candidateSha, dataSchema: candidateSchema,
      application: { format: 1, bun: '1.3.14', nodeMajor: 22, apiLibc, webLibc, apiBase,
        // This test exercises code rollback with the current schema; product release compatibility still needs review.
        rollbackSafeFrom: [schema], assets: {} } };
    await save(join(candidateRoot, 'application.json'), JSON.stringify({ ...manifest, arch }));
    const bundle = join(root, 'candidate-application.tar.gz');
    await command(['tar', '--format=posix', '-czf', bundle, '-C', candidateRoot, 'application.json', 'api', 'web']);
    const feedUrl = 'https://upgrade-harness.invalid/releases.json', bundleUrl = 'https://upgrade-harness.invalid/application.tar.gz';
    manifest.application.assets[`linux-${arch}`] = { url: bundleUrl, sha256: createHash('sha256').update(await readFile(bundle)).digest('hex') };
    globalThis.fetch = (async (input: any, init?: any) => String(input) === feedUrl ? Response.json({ latest: manifest }) : String(input) === bundleUrl ? new Response(Bun.file(bundle)) : originalFetch(input, init)) as typeof fetch;
    const driver = new ContainerApplicationDriver({ kind: 'docker_compose', projectName: project, composeFile, envFile, stateDir: root,
      apiHealthUrl: apiUrl + '/readyz', webHealthUrl: webUrl + '/login', minimumFreeBytes: 1, verificationTimeoutMs: 60_000,
      backup: { directory: join(root, 'backups'), dataPaths: [composeFile, envFile],
        databaseDumpCommand: ['docker', 'exec', pgId, 'pg_dump', '-U', 'fixture', '-d', 'fixture', '-Fc'],
        databaseVerifyCommand: ['docker', 'run', '--rm', '-i', '--network', 'none', '--entrypoint', 'pg_restore', 'pgvector/pgvector:pg17', '--list'] } }, commandRunner);
    const client = new PlatformUpdaterClient(apiUrl, adminToken, updaterToken);
    const worker = new PlatformUpdateWorker(client, driver, feedUrl);
    const request = async (path: string, method = 'GET', body?: unknown): Promise<any> => {
      const response = await originalFetch(apiUrl + '/api/multiremi/platform/' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      assert(response.ok, `${path}: ${response.status} ${await response.clone().text()}`); return response.json();
    };
    const queue = (body: any) => request('operations', 'POST', { requestId: randomUUID(), ...body });
    await request('settings', 'PATCH', { releaseFeedUrl: feedUrl });
    await queue({ kind: 'check_updates' }); await worker.tick();
    assert((await request('status')).preflight?.ready, 'Platform application preflight failed');
    const daemonBefore = await compose(['ps', '-q', 'daemon']);
    const task = await heldTask();
    const { operation } = await queue({ kind: 'update', targetVersion: manifest.version, targetRef: feedUrl });
    const updating = worker.tick();
    // Observe real drain progress before allowing the provider to finish.
    try {
      await wait('platform draining active ACP', async () => {
        const state = await request('status');
        return state.activeOperation?.status === 'draining' && Number(state.activeOperation.progress?.drain?.active_tasks) > 0;
      });
    } finally { await releaseGate(); await updating; }
    assert.equal((await request('status')).lastOperation?.status, 'succeeded');
    assert.deepEqual(await control('/version'), { version: manifest.version, sha: candidateSha });
    const platformAttempts = await assertCompleted(task);
    assert.equal(platformAttempts.length, 1, 'Platform drain unexpectedly interrupted ACP');
    assert.equal(await compose(['ps', '-q', 'daemon']), daemonBefore);
    evidence.scenarios.push({ kind: 'platform-upgrade', operation_id: operation.id, version: manifest.version, source_sha: candidateSha, attempts: platformAttempts, drain_observed: true });
    await queue({ kind: 'rollback', targetVersion: previous.version, targetRef: previous.ref }); await worker.tick();
    assert.equal((await request('status')).lastOperation?.status, 'rolled_back');
    assert.deepEqual(await control('/version'), { version: previous.version, sha: releaseSha });
    const rollbackTask = await heldTask(); await releaseGate(); const rollbackAttempts = await assertCompleted(rollbackTask);
    evidence.scenarios.push({ kind: 'platform-rollback', version: previous.version, source_sha: releaseSha, attempts: rollbackAttempts });
    await log('Platform real updater: ACP drain, candidate version and code rollback verified');
  }
} catch (error) { failure = error; await log(error instanceof Error ? error.stack ?? error.message : String(error)); }
finally {
  cleaning = true;
  if (interrupted) failure ??= new Error('Harness interrupted');
  globalThis.fetch = originalFetch;
  if (composeStarted) {
    try { await writeFile(join(output, 'compose.log'), await compose(['logs', '--no-color']).then(text => [adminToken, updaterToken, evidence.daemon_token].filter(Boolean).reduce((s, token) => s.replaceAll(token, '<redacted>'), text))); } catch {}
    try { await compose(['down', '--volumes', '--remove-orphans', '--timeout', '5']); } catch (error) { failure ??= error; }
  }
  if (dockerAvailable) {
    try {
      const remaining = await docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]);
      evidence.cleanup = { remaining_containers: remaining ? remaining.split('\n').length : 0 };
      assert.equal(remaining, '', 'Harness containers remain');
      const volume = `${project}_application-releases`;
      const found = await docker(['volume', 'ls', '--format', '{{.Name}}', '--filter', `name=^${volume}$`]);
      if (found === volume) await docker(['volume', 'rm', volume]);
      for (const image of images) await docker(['image', 'rm', '-f', image]);
    } catch (error) { failure ??= error; }
  } else evidence.cleanup = { remaining_containers: null, reason: selfCheckOnly ? 'self-check-only: no containers created' : 'Docker unavailable; no containers created' };
  try {
    const after = snapshotProduction();
    evidence.after = after;
    evidence.isolation = before ? compareSnapshots(before, after) : { unchanged: false, changed: ['initial_snapshot_failed'] };
    assert(evidence.isolation.unchanged, 'Protected production instance changed');
    assert(evidence.isolation.fully_observed, 'Production observation is incomplete; see observation_errors');
  } catch (error) { evidence.isolation ??= { unchanged: false, error: String(error) }; failure ??= error; }
  delete evidence.daemon_token;
  evidence.ok = !failure; evidence.error = failure ? String(failure) : null;
  await save(join(output, 'isolation.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  // Only a root minted by this process can be removed; containers use volumes, no root-owned bind directories.
  await rm(root, { recursive: true, force: true }).catch(async error => { await log(`Temporary root cleanup failed: ${error}`); process.exitCode = 1; });
}
if (failure) process.exitCode = 1;
