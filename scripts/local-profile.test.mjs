import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { redactor } from './proxy-command.mjs';
import { createHash, createHmac } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, lstatSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scriptSource = readFileSync(join(repository, 'scripts/local-profile.mjs'), 'utf8');
const OLD_REF = 'a'.repeat(40);
const NEW_REF = 'b'.repeat(40);
const schemaInputs = JSON.parse(readFileSync(join(repository, 'packages/platform-updater/src/data-schema-inputs.json'), 'utf8'));
const SCHEMA = createHash('sha256').update('test migration\n'.repeat(schemaInputs.length)).digest('hex');

// Every child runs a copy of the real CLI in a temporary repository. Patch the
// process boundary before its ESM imports load: no real Git, Docker, tar, or
// network request can run, including for deploy/stop/up failure scenarios.
const mockSource = String.raw`
import childProcess from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';

const succeed = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const fail = () => ({ status: 1, stdout: '', stderr: 'Injected test failure' });
Atomics.wait = (array, index, value, delay) => {
  appendFileSync(process.env.TEST_COMMAND_LOG, JSON.stringify({ command: 'backoff', delay }) + '\n');
  return 'timed-out';
};
const imageId = (tag) => 'sha256:' + createHash('sha256').update(tag).digest('hex');
childProcess.spawnSync = (command, args, options = {}) => {
  let streamingSecrets = null;
  let detectPortBinding = false;
  if (args[0]?.endsWith('proxy-command.mjs')) {
    const request = JSON.parse(options.input);
    command = request.command; args = request.args; streamingSecrets = request.secrets; detectPortBinding = request.detectPortBinding;
    options = { ...options, input: request.input };
  }
  const metadataPath = join(process.env.TEST_PROFILE_ROOT, 'deployment.json');
  const selection = existsSync(metadataPath) ? JSON.parse(readFileSync(metadataPath, 'utf8')) : null;
  appendFileSync(process.env.TEST_COMMAND_LOG, JSON.stringify({
    command, args,
    buildOverride: args.includes('-') && options.input ? JSON.parse(options.input) : null,
    // Log only names, never inherited values or the generated credentials.
    environmentKeys: Object.keys(options.env || {}),
    runtimeEnvironment: process.env.TEST_CAPTURE_RUNTIME === '1' ? Object.fromEntries(Object.entries(options.env || {}).filter(([key]) => key.startsWith('REMI_RUNTIME_'))) : null,
    selectedRef: selection?.ref ?? null,
    selectedProfile: selection?.profile ?? null,
    restoreControlPlane: args.includes('pg_restore') && String(options.input ?? '').includes('CONTROL-PLANE'),
  }) + '\n');
  if (command === 'git' && args[0] === 'rev-parse') return succeed(process.env.TEST_COMMIT + '\n');
  if (command === 'git' && args[0] === 'fetch') return succeed();
  if (command === 'git' && args[0] === 'show' && args[1].endsWith(':packages/server/src/store/schema-compatibility.json')) return { status: 128, stdout: '', stderr: 'historical file absent' };
  if (command === 'git' && args[0] === 'show') return succeed(process.env.TEST_FAIL === 'schema_changed' && args[1].startsWith(process.env.TEST_NEW_COMMIT) ? 'changed migration\n' : 'test migration\n');
  if (command === 'git' && args[0] === 'remote') return succeed('https://github.com/example/remi.git');
  if (command === 'gh') return succeed(JSON.stringify({ artifacts: [] }));
  if (command === 'git' && args[0] === 'archive') {
    writeFileSync(args[args.indexOf('--output') + 1], 'Test archive');
    return succeed();
  }
  if (command === 'tar' && args.includes('-xf')) {
    const source = args[args.indexOf('-C') + 1];
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'package.json'), '{"version":"0.2.60"}\n');
    return succeed();
  }
  if (command !== 'docker') throw new Error('Unmocked command: ' + command);
  if (args.includes('--entrypoint') && args.includes('/bin/sh') && args.includes('--network')) return succeed(process.env.TEST_SCHEMA_TARGET || 'null');
  if (args.includes('psql')) {
    if (process.env.TEST_FAIL === 'schema_query') return fail();
    if (args.at(-1).includes('json_agg')) return succeed(process.env.TEST_SCHEMA_ROWS || '[{"singleton":1,"expand_level":3,"contract_level":0}]');
    return succeed(process.env.TEST_SCHEMA_INVENTORY || '{"historical":true,"metadata":true}');
  }
  if (args.includes('image') && args.includes('ls')) {
    const tag = args[args.indexOf('--filter') + 1].slice('reference='.length);
    const service = tag.startsWith('remi-api:') ? 'api' : 'web';
    return succeed((process.env.TEST_CACHED_IMAGES || '').split(',').includes(service) ? imageId(tag) : '');
  }
  if (args.includes('image') && args.includes('inspect')) {
    if (process.env.TEST_FAIL === 'missing_old_web' && args.at(-1) === 'remi-web:stable-' + 'a'.repeat(40)) return fail();
    if (process.env.TEST_FAIL === 'mutated_old_web' && args.at(-1) === 'remi-web:stable-' + 'a'.repeat(40)) return succeed(imageId('different-content'));
    if (args.includes('{{json .Config.Labels}}')) {
      const revision = process.env.TEST_FAIL === 'image_revision' ? 'wrong-revision' : (args.at(-1).split(':stable-')[1] || process.env.TEST_COMMIT);
      return succeed(JSON.stringify({ 'org.opencontainers.image.revision': revision, 'io.remi.local-profile.hostname': '127.0.0.1' }));
    }
    return succeed(imageId(args.at(-1)));
  }
  if (args.includes('ps') && args.includes('--quiet')) return succeed(args.at(-1) + '-fixture');
  if (args.includes('inspect')) {
    const service = args.at(-1).split('-')[0];
    if (args.includes('{{json .Image}}')) {
      const stale = process.env.TEST_FAIL === 'stale_web' && service === 'web' && selection.ref === process.env.TEST_NEW_COMMIT;
      return succeed(JSON.stringify(imageId(stale ? 'remi-web:stable-' + 'a'.repeat(40) : selection[service + 'Image'])));
    }
    return succeed(JSON.stringify({ Running: true, Health: { Status: 'healthy' } }));
  }
  if (process.env.TEST_FAIL === 'runtime_diagnostic' && args.includes('up')) {
    const diagnostic = options.env.REMI_RUNTIME_HTTPS_PROXY + ' sentinel-user sentinel-password ' + process.env.HTTPS_PROXY;
    writeSync(2, streamingSecrets.filter(Boolean).sort((a,b) => b.length-a.length).reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), diagnostic));
    return fail();
  }
  if (process.env.TEST_FAIL.startsWith('bind_') && args.includes('up') && selection?.ref === process.env.TEST_NEW_COMMIT) {
    const attempts = readFileSync(process.env.TEST_COMMAND_LOG, 'utf8').trim().split('\n').map(JSON.parse).filter(call => call.args?.includes('up') && call.selectedRef === selection.ref).length;
    if (process.env.TEST_FAIL === 'bind_always' || attempts <= 2) return { status: detectPortBinding ? 98 : 1, stdout: '', stderr: 'bind: address already in use' };
  }
  if (process.env.TEST_FAIL === 'config' && args.includes('config')) return fail();
  if (process.env.TEST_FAIL === 'build' && args.includes('build')) return fail();
  if (process.env.TEST_FAIL === 'pull' && args.includes('pull')) return fail();
  if (process.env.TEST_FAIL === 'crash_build' && args.includes('build')) process.exit(91);
  if (process.env.TEST_FAIL === 'deploy_rollback_failure' && args.includes('up') && !args.includes('postgres')) return fail();
  if (['activate', 'activate_restore'].includes(process.env.TEST_FAIL) && args.includes('up') && selection?.ref === process.env.TEST_NEW_COMMIT) return fail();
  if (['restore_old', 'activate_restore'].includes(process.env.TEST_FAIL) && args.includes('pg_restore') && selection?.ref !== process.env.TEST_NEW_COMMIT) return fail();
  if (process.env.TEST_FAIL === 'control_overlay' && args.includes('pg_restore') && String(options.input ?? '').includes('CONTROL-PLANE')) return fail();
  if (process.env.TEST_FAIL === 'crash_overlay' && args.includes('pg_restore') && String(options.input ?? '').includes('CONTROL-PLANE')) process.exit(91);
  if (process.env.TEST_FAIL === 'crash_restore' && args.includes('createdb')) process.exit(91);
  if (process.env.TEST_FAIL === 'crash_activate' && args.includes('up') && selection?.ref === process.env.TEST_NEW_COMMIT) process.exit(91);
  if (args.includes('pg_dump')) {
    writeSync(options.stdio[1], args.some((arg) => arg.startsWith('--table=')) ? 'PGDMP CONTROL-PLANE ' + selection.ref : 'PGDMP test fixture');
    return succeed();
  }
  if (args.includes('tar')) {
    if (process.env.TEST_FAIL === 'tar') return fail();
    writeSync(options.stdio[1], 'Home archive test fixture');
    return succeed();
  }
  // In particular, ps returns no running services. active.json must still
  // protect the data when an already stopped deployment is upgraded.
  return succeed();
};
for (const name of ['spawn', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = () => { throw new Error('Unmocked process API: ' + name); };
}
syncBuiltinESMExports();
globalThis.fetch = async (url) => {
  const deployment = JSON.parse(readFileSync(join(process.env.TEST_PROFILE_ROOT, 'deployment.json'), 'utf8'));
  if (process.env.TEST_FAIL === 'web_health' && String(url).includes(':13000/') && deployment.ref === process.env.TEST_NEW_COMMIT) return { status: 503, ok: false };
  return { status: 200, ok: true, arrayBuffer: async () => Buffer.from('release archive') };
};
if (process.env.TEST_FAIL === 'web_health') globalThis.setTimeout = (fn) => { fn(); return 0; };
`;

function fixture(t) {
  const temporaryParent = realpathSync(tmpdir());
  const root = mkdtempSync(join(temporaryParent, 'remi-local-profile-test-'));
  t.after(() => {
    // The Windows cleanup target is verified before recursive deletion. Any
    // test-created junction points only at another directory inside this root.
    const target = realpathSync(root);
    assert.equal(dirname(target), temporaryParent);
    assert.match(relative(temporaryParent, target), /^remi-local-profile-test-[^/\\]+$/u);
    rmSync(target, { recursive: true, force: true });
  });
  const source = join(root, 'source repo 中文');
  const profilesRoot = join(root, 'profiles with spaces');
  const script = join(source, 'scripts/local-profile.mjs');
  const mock = join(root, 'mock-process.mjs');
  const log = join(root, 'commands.jsonl');
  mkdirSync(dirname(script), { recursive: true });
  mkdirSync(join(source, 'deploy/docker'), { recursive: true });
  mkdirSync(join(source, 'packages/platform-updater/src'), { recursive: true });
  copyFileSync(join(repository, 'packages/platform-updater/src/data-schema-inputs.json'), join(source, 'packages/platform-updater/src/data-schema-inputs.json'));
  copyFileSync(join(repository, 'packages/platform-updater/src/schema-preflight.mjs'), join(source, 'packages/platform-updater/src/schema-preflight.mjs'));
  copyFileSync(join(repository, 'packages/platform-updater/src/schema-fingerprint.mjs'), join(source, 'packages/platform-updater/src/schema-fingerprint.mjs'));
  writeFileSync(script, scriptSource);
  copyFileSync(join(repository, 'scripts/ci-images.mjs'), join(source, 'scripts/ci-images.mjs'));
  copyFileSync(join(repository, 'scripts/proxy-command.mjs'), join(source, 'scripts/proxy-command.mjs'));
  writeFileSync(join(source, 'package.json'), '{"version":"0.2.60"}\n');
  writeFileSync(join(source, 'deploy/docker/host-write-fence.ts'), '// Runtime fence is validated independently.\n');
  for (const name of ['compose.local.yml', 'compose.local-dev.yml']) {
    copyFileSync(join(repository, 'deploy/docker', name), join(source, 'deploy/docker', name));
  }
  writeFileSync(mock, mockSource);

  function run(profile, action, { args = [], commit = OLD_REF, fail = '', environment = {}, profileBase = profilesRoot, localBuild = true } = {}) {
    writeFileSync(log, '');
    if (localBuild && profile === 'stable' && ['deploy', 'host-stage'].includes(action)) args = [...args, '--build-local', 'true'];
    const inheritedEnvironment = { ...process.env };
    // Delete all spellings before applying test inputs. Empty uppercase entries
    // would shadow lowercase inputs when Windows deduplicates spawn's env keys.
    for (const key of Object.keys(inheritedEnvironment)) {
      if (/^(https?_proxy|no_proxy|remi_build_network)$/iu.test(key)) delete inheritedEnvironment[key];
    }
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(mock).href, script, profile, action, ...args], {
      env: {
        ...inheritedEnvironment,
        HOME: join(root, 'home'),
        USERPROFILE: join(root, 'home'),
        XDG_CONFIG_HOME: join(root, 'home/.config'),
        ...environment,
        NODE_OPTIONS: '',
        REMI_PROFILES_ROOT: profileBase,
        TEST_PROFILE_ROOT: join(profileBase, profile),
        TEST_COMMAND_LOG: log,
        TEST_COMMIT: commit,
        TEST_NEW_COMMIT: NEW_REF,
        TEST_FAIL: fail,
        REMI_HOST_MIN_FREE_BYTES: '1',
        REMI_HOST_EXPECTED_ARCH: process.arch,
      },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    });
    assert.ifError(result.error);
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    return { ...result, calls };
  }
  const profileRoot = (profile = 'stable') => join(profilesRoot, profile);
  const readProfile = (name, profile = 'stable') => JSON.parse(readFileSync(join(profileRoot(profile), name), 'utf8'));
  function activate() {
    succeeds(run('stable', 'prepare'));
    const apiEnv = join(profileRoot(), 'api.env');
    writeFileSync(apiEnv, readFileSync(apiEnv, 'utf8') + '\nMULTIREMI_PLATFORM_UPDATER_TOKEN=fixture-updater-token\n');
    succeeds(run('stable', 'up'));
    assert.equal(readProfile('active.json').ref, OLD_REF);
  }
  return { root, source, profilesRoot, profileRoot, readProfile, run, activate };
}

function succeeds(result) {
  assert.equal(result.status, 0, result.stderr);
}

const dockerCalls = (result) => result.calls.filter((call) => call.command === 'docker');
const isAction = (action) => (call) => call.command === 'docker' && call.args.includes(action);
const releaseSha = createHash('sha256').update('release archive').digest('hex');
const hostStageArgs = (operationId = 'pop_recoverable_test') => [
  '--operation-id', operationId,
  '--ref', NEW_REF,
  '--version', '0.2.60',
  '--source-url', 'https://example.com/platform-release.tar.gz',
  '--source-sha256', releaseSha,
];


for (const runtimeProxy of [false, true]) {
  test(`deploy retries bind errors and records active after success (runtime proxy ${runtimeProxy})`, (t) => {
    const f = fixture(t);
    f.activate();
    const result = f.run('stable', 'deploy', { commit: NEW_REF, fail: 'bind_twice',
      args: runtimeProxy ? ['--runtime-proxy', 'true'] : [],
      environment: runtimeProxy ? { HTTPS_PROXY: 'http://sentinel-user:sentinel-password@proxy.example:8080' } : {} });
    succeeds(result);
    const attempts = dockerCalls(result).filter(call => call.args.includes('up') && call.selectedRef === NEW_REF);
    assert.equal(attempts.length, 3);
    for (const attempt of attempts) assert.deepEqual(attempt.args, attempts[0].args);
    assert.deepEqual(result.calls.filter(call => call.command === 'backoff').map(call => call.delay), [1000, 2000]);
    assert.equal(f.readProfile('active.json').ref, NEW_REF);
    assert.equal(result.calls.filter(isAction('pg_dump')).length, 2, 'backup must not repeat');
    assert.doesNotMatch(result.stderr, /Restore|sentinel-user|sentinel-password/);
  });
}

test('persistent bind conflict exhausts retries without changing active or suggesting data restore', (t) => {
  const f = fixture(t);
  f.activate();
  const result = f.run('stable', 'deploy', { commit: NEW_REF, fail: 'bind_always' });
  assert.equal(result.status, 1);
  assert.equal(dockerCalls(result).filter(call => call.args.includes('up') && call.selectedRef === NEW_REF).length, 4);
  assert.deepEqual(result.calls.filter(call => call.command === 'backoff').map(call => call.delay), [1000, 2000, 4000]);
  assert.equal(f.readProfile('active.json').ref, OLD_REF);
  assert.match(result.stderr, /port binding conflict persisted after 3 retries/);
  assert.doesNotMatch(result.stderr, /Restore the matching|before rolling code back/);
});

test('unrelated startup failure is not retried or treated as proof of migration', (t) => {
  const f = fixture(t);
  f.activate();
  const result = f.run('stable', 'deploy', { commit: NEW_REF, fail: 'activate' });
  assert.equal(result.status, 1);
  assert.equal(dockerCalls(result).filter(call => call.args.includes('up') && call.selectedRef === NEW_REF).length, 1);
  assert.equal(result.calls.filter(call => call.command === 'backoff').length, 0);
  assert.equal(f.readProfile('active.json').ref, OLD_REF);
  assert.match(result.stderr, /Previous release .* restored/);
  assert.equal(f.readProfile('deployment.json').ref, OLD_REF);
  assert.ok(dockerCalls(result).some(call => call.args.includes('up') && call.selectedRef === OLD_REF));
  assert.ok(!dockerCalls(result).some(call => call.args.includes('pg_restore')));
  assert.doesNotMatch(result.stderr, /Restore the matching|before rolling code back/);
});

for (const [diagnostic, exit, expected] of [
  ['listen tcp4 0.0.0.0:13000: bind: address already in use', 1, 98],
  ['Bind for 0.0.0.0:13000 failed: port is already allocated', 1, 98],
  ['Ports are not available: exposing port TCP: listen tcp: bind: Only one usage of each socket address is normally permitted.', 1, 98],
  ['container is unhealthy', 98, 1],
  ['bind: address already in use', 0, 0],
]) {
  test(`streaming runner classifies failed port binding: ${diagnostic}, exit ${exit}`, () => {
    const request = { command: process.execPath, args: ['-e', `process.stderr.write(${JSON.stringify(diagnostic.slice(0, 25))});setTimeout(()=>{process.stderr.write(${JSON.stringify(diagnostic.slice(25))});process.exit(${exit})},20)`],
      secrets: [], cwd: repository, detectPortBinding: true };
    const result = spawnSync(process.execPath, [join(repository, 'scripts/proxy-command.mjs'), '--run'], { input: JSON.stringify(request), encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, expected, result.stderr);
    assert.equal(result.stderr, diagnostic);
  });
}

test('stable deploy pulls verified CI digests before stopping the previous service', (t) => {
  const f = fixture(t);
  f.activate();
  const manifest = { schemaVersion: 1, repository: 'example/remi', ref: NEW_REF,
    hostname: '127.0.0.1', profile: 'stable', platform: 'linux/amd64', version: '0.2.60-stable.bbbbbbbb',
    apiImage: `ghcr.io/example/remi-api@sha256:${'c'.repeat(64)}`, webImage: `ghcr.io/example/remi-web@sha256:${'d'.repeat(64)}` };
  const path = join(f.root, 'stable-images.json');
  writeFileSync(path, JSON.stringify(manifest));
  const result = f.run('stable', 'deploy', { commit: NEW_REF, localBuild: false, args: ['--image-manifest', path] });
  succeeds(result);
  assert.equal(result.calls.filter(isAction('pull')).length, 2);
  assert.equal(result.calls.filter(isAction('build')).length, 0);
  assert.ok(result.calls.findLastIndex(isAction('pull')) < result.calls.findIndex(isAction('stop')));
  assert.equal(f.readProfile('active.json').apiImage, manifest.apiImage);
  assert.equal(f.readProfile('active.json').imageSource, 'ci');
  succeeds(f.run('stable', 'up'));
});

test('explicit local build can be stopped and brought up without a false deployment mismatch', (t) => {
  const f = fixture(t);
  succeeds(f.run('stable', 'deploy'));
  succeeds(f.run('stable', 'stop'));
  succeeds(f.run('stable', 'up'));
});

for (const scenario of ['missing', 'hostname', 'pull', 'image_revision']) {
  test(`CI ${scenario} failure leaves the previous deployment intact`, (t) => {
    const f = fixture(t);
    f.activate();
    const path = join(f.root, 'stable-images.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, repository: 'example/remi', ref: NEW_REF,
      hostname: scenario === 'hostname' ? '192.168.1.2' : '127.0.0.1', profile: 'stable', platform: 'linux/amd64', version: '0.2.60-stable.bbbbbbbb',
      apiImage: `ghcr.io/example/remi-api@sha256:${'c'.repeat(64)}`, webImage: `ghcr.io/example/remi-web@sha256:${'d'.repeat(64)}` }));
    const result = f.run('stable', 'deploy', { commit: NEW_REF, localBuild: false, fail: scenario,
      args: scenario === 'missing' ? [] : ['--image-manifest', path] });
    assert.notEqual(result.status, 0);
    assert.equal(result.calls.filter(isAction('build')).length, 0);
    assert.equal(result.calls.filter(isAction('stop')).length, 0);
    assert.equal(f.readProfile('active.json').ref, OLD_REF);
    assert.equal(f.readProfile('deployment.json').ref, OLD_REF);
  });
}

test('token signs a 24-hour local session with only the selected profile secret', (t) => {
  const f = fixture(t);
  succeeds(f.run('stable', 'prepare'));
  succeeds(f.run('dev', 'prepare'));
  const stableEnv = parseEnv(readFileSync(join(f.profileRoot(), 'api.env'), 'utf8'));
  const devEnv = parseEnv(readFileSync(join(f.profileRoot('dev'), 'api.env'), 'utf8'));
  const before = Math.floor(Date.now() / 1000);
  const result = f.run('stable', 'token', { environment: { JWT_SECRET: 'wrong-shell-secret' } });
  const after = Math.floor(Date.now() / 1000);
  succeeds(result);
  assert.equal(result.calls.length, 0, 'Issuing a session must not invoke Docker or Git');
  const [header, claims, signature, extra] = result.stdout.trim().split('.');
  assert.equal(extra, undefined);
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'HS256', typ: 'JWT' });
  const payload = JSON.parse(Buffer.from(claims, 'base64url'));
  assert.equal(payload.sub, 'local');
  assert.ok(payload.iat >= before && payload.iat <= after);
  assert.equal(payload.exp - payload.iat, 24 * 60 * 60);
  const input = `${header}.${claims}`;
  assert.ok(signature === createHmac('sha256', stableEnv.JWT_SECRET).update(input).digest('base64url'));
  assert.ok(signature !== createHmac('sha256', devEnv.JWT_SECRET).update(input).digest('base64url'));
  assert.ok(!result.stdout.includes(stableEnv.MULTIREMI_TOKEN));
  assert.ok(!result.stdout.includes(stableEnv.JWT_SECRET));
});

test('token reads quoted profile secrets and fails without a signing secret', (t) => {
  const f = fixture(t);
  succeeds(f.run('dev', 'prepare'));
  const envPath = join(f.profileRoot('dev'), 'api.env');
  writeFileSync(envPath, 'MULTIREMI_TOKEN=never-output-master\nJWT_SECRET="test-only-quoted-secret"\n');
  const result = f.run('dev', 'token');
  succeeds(result);
  const [header, claims, signature] = result.stdout.trim().split('.');
  assert.ok(signature === createHmac('sha256', 'test-only-quoted-secret').update(`${header}.${claims}`).digest('base64url'));
  writeFileSync(envPath, 'MULTIREMI_TOKEN=never-output-master\n');
  const missing = f.run('dev', 'token', { environment: { JWT_SECRET: 'wrong-shell-secret' } });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /No local profile JWT_SECRET/u);
  assert.equal(missing.stdout, '');
  assert.equal(missing.calls.length, 0);
});

test('shell profile variables and remote Docker settings cannot override the selected profile', (t) => {
  const f = fixture(t);
  const poisoned = {
    REMI_API_ENV_FILE: '/wrong/profile.env', REMI_SOURCE_DIR: '/wrong/source', REMI_API_BIND_PORT: '19999',
    REMI_API_IMAGE: 'wrong:latest', MULTIREMI_PUBLIC_URL: 'http://wrong.invalid', POSTGRES_PASSWORD: 'test-only',
    COMPOSE_FILE: '/wrong/compose.yml', COMPOSE_PROJECT_NAME: 'remi-stable',
    DOCKER_HOST: 'tcp://wrong.invalid:2375', DOCKER_CONTEXT: 'remote-test', DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: '/wrong/certs',
    remi_web_bind_port: '29999', Compose_Profiles: 'wrong',
  };
  const result = f.run('dev', 'prepare', { args: ['--ref', 'HEAD'], environment: poisoned });
  succeeds(result);
  const calls = dockerCalls(result);
  assert.equal(calls.length, 1);
  for (const call of calls) {
    const passed = new Set(call.environmentKeys.map((key) => key.toLowerCase()));
    for (const key of Object.keys(poisoned)) assert.ok(!passed.has(key.toLowerCase()), `${key} must not reach Docker`);
    assert.deepEqual(call.args.slice(0, 5), ['--context', process.platform === 'win32' ? 'desktop-linux' : 'default', 'compose', '-p', 'remi-dev']);
    assert.equal(call.args[call.args.indexOf('--env-file') + 1], join(f.profileRoot('dev'), 'compose.env'));
    assert.deepEqual(call.args.slice(-2), ['config', '--quiet']);
  }
  assert.equal(f.readProfile('deployment.json', 'dev').source, f.source);
});

test('copied profile metadata cannot make a dev command operate on stable', (t) => {
  const f = fixture(t);
  succeeds(f.run('dev', 'prepare'));
  const path = join(f.profileRoot('dev'), 'deployment.json');
  writeFileSync(path, JSON.stringify({ ...f.readProfile('deployment.json', 'dev'), profile: 'stable' }));
  const result = f.run('dev', 'build');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /metadata does not match/u);
  assert.equal(dockerCalls(result).length, 0);
});

test('profiles cannot be initialized in the source repository', (t) => {
  const f = fixture(t);
  const inside = join(f.source, 'new', 'profiles');
  const result = f.run('dev', 'prepare', { profileBase: inside });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside the source repository/u);
  assert.equal(result.calls.length, 0);
  assert.ok(!existsSync(inside));
});

test('source-directory rejection resolves a junction or symlink before creating profiles', (t) => {
  const f = fixture(t);
  const alias = join(f.root, 'source alias');
  symlinkSync(f.source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const result = f.run('dev', 'prepare', { profileBase: join(alias, 'new', 'profiles') });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside the source repository/u);
  assert.equal(result.calls.length, 0);
  assert.ok(!existsSync(join(f.source, 'new')));
});

test('failed prepare restores the previous selection and Compose files byte for byte', (t) => {
  const f = fixture(t);
  succeeds(f.run('stable', 'prepare'));
  const names = ['deployment.json', 'compose.env', 'compose.yml'];
  const before = new Map(names.map((name) => [name, readFileSync(join(f.profileRoot(), name))]));
  const result = f.run('stable', 'prepare', { args: ['--ref', 'new-ref'], commit: NEW_REF, fail: 'config' });
  assert.notEqual(result.status, 0);
  assert.equal(dockerCalls(result).find(isAction('config'))?.selectedRef, NEW_REF);
  for (const [name, contents] of before) {
    assert.ok(readFileSync(join(f.profileRoot(), name)).equals(contents), `${name} was not restored`);
  }
  assert.equal(f.readProfile('deployment.json').ref, OLD_REF);
});

test('a failed first prepare does not leave an executable deployment selection', (t) => {
  const f = fixture(t);
  const result = f.run('dev', 'prepare', { fail: 'config' });
  assert.notEqual(result.status, 0);
  assert.ok(dockerCalls(result).some(isAction('config')));
  for (const name of ['deployment.json', 'compose.env', 'compose.yml', 'compose.dev.yml']) {
    assert.ok(!existsSync(join(f.profileRoot('dev'), name)), `${name} survived failed validation`);
  }
});

test('an activated profile is still backed up before upgrading after stop', (t) => {
  const f = fixture(t);
  f.activate();
  succeeds(f.run('stable', 'stop'));
  const result = f.run('stable', 'deploy', { args: ['--ref', 'new-ref'], commit: NEW_REF });
  succeeds(result);
  const calls = dockerCalls(result);
  const build = calls.findIndex(isAction('build'));
  const stop = calls.findIndex(isAction('stop'));
  const dump = calls.findIndex(isAction('pg_dump'));
  const archive = calls.findIndex(isAction('tar'));
  const launch = calls.findIndex((call) => isAction('up')(call) && call.selectedRef === NEW_REF);
  assert.ok(build >= 0 && build < stop && stop < dump && dump < archive && archive < launch);
  assert.equal(calls[dump].selectedRef, OLD_REF);
  assert.equal(calls[archive].selectedRef, OLD_REF);
  assert.ok(calls[archive].args.includes('type=volume,src=remi-stable_api-home,dst=/backup,readonly'));
  assert.ok(calls[archive].args.includes('none'));
  const backups = readdirSync(join(f.profileRoot(), 'backups'));
  assert.equal(backups.length, 1);
  const saved = join(f.profileRoot(), 'backups', backups[0]);
  assert.ok(existsSync(join(saved, 'complete.json')));
  for (const name of ['postgres.dump', 'api-home.tar']) assert.ok(statSync(join(saved, name)).size > 0);
  assert.equal(JSON.parse(readFileSync(join(saved, 'deployment.json'), 'utf8')).ref, OLD_REF);
  assert.equal(f.readProfile('active.json').ref, NEW_REF);
});

test('a failed home archive leaves no completion marker and never starts the new version', (t) => {
  const f = fixture(t);
  f.activate();
  const result = f.run('stable', 'deploy', { args: ['--ref', 'new-ref'], commit: NEW_REF, fail: 'tar' });
  assert.notEqual(result.status, 0);
  const calls = dockerCalls(result);
  assert.ok(calls.some(isAction('pg_dump')));
  assert.ok(calls.some(isAction('tar')));
  assert.ok(!calls.some((call) => isAction('up')(call) && call.selectedRef === NEW_REF));
  assert.equal(f.readProfile('active.json').ref, OLD_REF);
  assert.equal(f.readProfile('deployment.json').ref, OLD_REF);
  const backups = readdirSync(join(f.profileRoot(), 'backups'));
  assert.equal(backups.length, 1);
  assert.ok(!existsSync(join(f.profileRoot(), 'backups', backups[0], 'complete.json')));
});

test('an activated profile cannot bypass deploy using prepare or a changed up selection', (t) => {
  const f = fixture(t);
  f.activate();
  const prepare = f.run('stable', 'prepare', { commit: NEW_REF });
  assert.notEqual(prepare.status, 0);
  assert.match(prepare.stderr, /upgraded with deploy/u);
  assert.equal(prepare.calls.length, 0);
  const path = join(f.profileRoot(), 'deployment.json');
  writeFileSync(path, JSON.stringify({ ...f.readProfile('deployment.json'), ref: NEW_REF }));
  const up = f.run('stable', 'up');
  assert.notEqual(up.status, 0);
  assert.match(up.stderr, /use deploy/u);
  assert.equal(dockerCalls(up).length, 0);
});

test('unsupported or misleading ref arguments fail before running external commands', (t) => {
  const f = fixture(t);
  for (const [profile, action, args] of [
    ['stable', 'build', ['--ref', 'HEAD']],
    ['stable', 'up', ['--ref', 'HEAD']],
    ['stable', 'prepare', ['--ref']],
    ['dev', 'prepare', ['--ref', 'old-release']],
    ['dev', 'deploy', ['--ref', OLD_REF]],
    ['dev', 'prepare', ['--unexpected', 'value']],
  ]) {
    const result = f.run(profile, action, { args });
    assert.notEqual(result.status, 0, `${profile} ${action} accepted invalid ref arguments`);
    assert.match(result.stderr, /--ref|working tree/u);
    assert.equal(result.calls.length, 0);
  }
});

test('stable LAN selection publishes both services and survives upgrades without affecting dev', (t) => {
  const f = fixture(t);
  succeeds(f.run('stable', 'prepare', { args: ['--lan-host', '192.168.40.12'] }));
  succeeds(f.run('stable', 'up'));
  succeeds(f.run('stable', 'deploy', { commit: NEW_REF }));
  const stable = parseEnv(readFileSync(join(f.profileRoot(), 'compose.env'), 'utf8'));
  assert.equal(stable.REMI_BIND_ADDRESS, '0.0.0.0');
  assert.equal(stable.REMI_PUBLIC_URL, 'http://192.168.40.12:13000');
  assert.equal(stable.REMI_PUBLIC_WS_URL, 'ws://192.168.40.12:16120/ws');
  assert.equal(stable.REMI_DAEMON_SERVER_URL, 'http://192.168.40.12:16120');
  assert.deepEqual(f.readProfile('active.json').network, { hostname: '192.168.40.12', bindAddress: '0.0.0.0' });
  assert.match(f.run('stable', 'status').stdout, /http:\/\/192\.168\.40\.12:13000/u);
  succeeds(f.run('dev', 'prepare'));
  const dev = parseEnv(readFileSync(join(f.profileRoot('dev'), 'compose.env'), 'utf8'));
  assert.equal(dev.REMI_BIND_ADDRESS, '127.0.0.1');
  assert.equal(dev.REMI_PUBLIC_URL, 'http://localhost:14000');
  assert.equal(dev.REMI_DAEMON_SERVER_URL, 'http://localhost:16220');
});

test('a failed LAN rebuild leaves the active loopback configuration untouched', (t) => {
  const f = fixture(t);
  f.activate();
  const original = readFileSync(join(f.profileRoot(), 'compose.env'));
  const result = f.run('stable', 'deploy', { args: ['--lan-host', '10.20.30.40'], fail: 'build', commit: NEW_REF });
  assert.notEqual(result.status, 0);
  assert.ok(readFileSync(join(f.profileRoot(), 'compose.env')).equals(original));
  assert.equal(f.readProfile('active.json').network.bindAddress, '127.0.0.1');
  assert.ok(!result.calls.some(isAction('stop')));
});

test('LAN settings reject unreachable bind values and never expose dev', (t) => {
  const f = fixture(t);
  for (const host of ['0.0.0.0', '127.0.0.1', '8.8.8.8', 'http://192.168.1.2', '192.168.1.300', '172.32.1.2']) {
    const result = f.run('stable', 'prepare', { args: ['--lan-host', host] });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /private IPv4/u);
    assert.equal(result.calls.length, 0);
  }
  const dev = f.run('dev', 'deploy', { args: ['--lan-host', '192.168.1.2'] });
  assert.notEqual(dev.status, 0);
  assert.match(dev.stderr, /only valid for stable/u);
  assert.equal(dev.calls.length, 0);
});

test('recoverable host update stages before switching and is idempotent by operation ID', (t) => {
  const f = fixture(t);
  f.activate();
  const staged = f.run('stable', 'host-stage', { args: hostStageArgs(), commit: NEW_REF });
  succeeds(staged);
  assert.equal(f.readProfile('active.json').ref, OLD_REF, 'staging must not switch the live profile');
  const journalPath = join(f.profileRoot(), 'host-operations', 'pop_recoverable_test', 'operation.json');
  assert.equal(JSON.parse(readFileSync(journalPath, 'utf8')).phase, 'built');
  assert.ok(staged.calls.some((call) => call.command === 'git' && call.args[0] === 'fetch' && call.args.includes(NEW_REF)));
  assert.ok(staged.calls.some(isAction('build')));
  assert.ok(!staged.calls.some(isAction('stop')));

  const duplicate = f.run('stable', 'host-stage', { args: hostStageArgs(), commit: NEW_REF });
  succeeds(duplicate);
  assert.equal(duplicate.calls.length, 0, 'a duplicate staged operation must not rebuild');

  const activated = f.run('stable', 'host-activate', { args: ['--operation-id', 'pop_recoverable_test'], commit: NEW_REF });
  succeeds(activated);
  assert.equal(f.readProfile('active.json').ref, NEW_REF);
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  assert.equal(journal.status, 'succeeded');
  assert.equal(journal.resultRelease.ref, NEW_REF);
  assert.ok(existsSync(join(journal.backupDir, 'complete.json')));
  const complete = JSON.parse(readFileSync(join(journal.backupDir, 'complete.json'), 'utf8'));
  assert.equal(complete.schemaVersion, 2);
  assert.match(complete.files['postgres.dump'].sha256, /^[a-f0-9]{64}$/u);
  assert.match(complete.restoreCommand, /host-rollback-stage/u);
});

test('host staging reuses a matching API image and builds only the missing Web image', (t) => {
  const f = fixture(t);
  f.activate();
  const operationId = 'pop_cached_api';
  const staged = f.run('stable', 'host-stage', {
    args: hostStageArgs(operationId), commit: NEW_REF, environment: { TEST_CACHED_IMAGES: 'api' },
  });
  succeeds(staged);
  const builds = dockerCalls(staged).filter(isAction('build'));
  assert.equal(builds.length, 1);
  assert.deepEqual(builds[0].args.slice(builds[0].args.indexOf('build') + 1), ['web']);
  const candidate = JSON.parse(readFileSync(join(f.profileRoot(), 'host-operations', operationId, 'candidate', 'deployment.json'), 'utf8'));
  for (const service of ['api', 'web']) {
    assert.equal(candidate[`${service}ImageId`], `sha256:${createHash('sha256').update(candidate[`${service}Image`]).digest('hex')}`);
  }
  assert.equal(f.readProfile('active.json').ref, OLD_REF);
});

test('host staging reuses both matching fixed-commit images without a rebuild', (t) => {
  const f = fixture(t);
  f.activate();
  const operationId = 'pop_cached_pair';
  const staged = f.run('stable', 'host-stage', {
    args: hostStageArgs(operationId), commit: NEW_REF, environment: { TEST_CACHED_IMAGES: 'api,web' },
  });
  succeeds(staged);
  assert.ok(!dockerCalls(staged).some(isAction('build')));
  assert.ok(!dockerCalls(staged).some(isAction('stop')));
  const candidate = JSON.parse(readFileSync(join(f.profileRoot(), 'host-operations', operationId, 'candidate', 'deployment.json'), 'utf8'));
  for (const service of ['api', 'web']) {
    assert.equal(candidate[`${service}ImageId`], `sha256:${createHash('sha256').update(candidate[`${service}Image`]).digest('hex')}`);
  }
  assert.equal(JSON.parse(readFileSync(join(f.profileRoot(), 'host-operations', operationId, 'operation.json'), 'utf8')).phase, 'built');
});

test('host staging refuses an existing fixed tag with a different revision before building anything', (t) => {
  const f = fixture(t);
  f.activate();
  const operationId = 'pop_wrong_cached_revision';
  const staged = f.run('stable', 'host-stage', {
    args: hostStageArgs(operationId), commit: NEW_REF, fail: 'image_revision', environment: { TEST_CACHED_IMAGES: 'web' },
  });
  assert.notEqual(staged.status, 0);
  assert.match(staged.stderr, /revision does not match the requested commit; refusing to overwrite/u);
  assert.ok(!dockerCalls(staged).some(isAction('build')), 'even a missing API must not build before validating the cached Web');
  assert.ok(!dockerCalls(staged).some(isAction('stop')));
  assert.equal(f.readProfile('active.json').ref, OLD_REF);
  assert.equal(f.readProfile('deployment.json').ref, OLD_REF);
  assert.equal(JSON.parse(readFileSync(join(f.profileRoot(), 'host-operations', operationId, 'operation.json'), 'utf8')).status, 'failed');
});

test('failed activation restores matching database, API home, configuration, and old services', (t) => {
  const f = fixture(t);
  f.activate();
  const operationId = 'pop_failed_activation';
  succeeds(f.run('stable', 'host-stage', { args: hostStageArgs(operationId), commit: NEW_REF }));
  const failed = f.run('stable', 'host-activate', {
    args: ['--operation-id', operationId], commit: NEW_REF, fail: 'activate',
  });
  assert.notEqual(failed.status, 0);
  assert.equal(f.readProfile('active.json').ref, OLD_REF);
  const journal = JSON.parse(readFileSync(join(f.profileRoot(), 'host-operations', operationId, 'operation.json'), 'utf8'));
  assert.equal(journal.status, 'rolled_back');
  assert.match(journal.error, /Update failed/u);
  const calls = dockerCalls(failed);
  const drop = calls.findIndex((call) => call.args.includes('dropdb') && call.args.includes('--force'));
  const create = calls.findIndex((call) => call.args.includes('createdb') && call.args.includes('--template=template0'));
  const restore = calls.findIndex((call) => call.args.includes('pg_restore') && call.args.includes('--exit-on-error') && call.args.includes('--single-transaction'));
  assert.ok(drop >= 0 && create > drop && restore > create, 'restore must replace the database, removing objects introduced by new migrations');
  assert.ok(calls.filter((call) => call.args.includes('pg_restore')).every((call) => !call.args.includes('/dev/stdin')), 'pg_restore must consume the archive from stdin without reopening a non-seekable Docker pipe');
  assert.equal(journal.resultRelease.ref, OLD_REF);
  assert.ok(calls.some((call) => call.args.some((arg) => String(arg).includes('/snapshot/api-home.tar'))));
  assert.ok(calls.some((call) => isAction('up')(call) && call.selectedRef === OLD_REF));
});

test('explicit host rollback restores the verified matching backup', (t) => {
  const f = fixture(t);
  f.activate();
  succeeds(f.run('stable', 'host-stage', { args: hostStageArgs('pop_before_rollback'), commit: NEW_REF }));
  succeeds(f.run('stable', 'host-activate', {
    args: ['--operation-id', 'pop_before_rollback'], commit: NEW_REF,
  }));
  succeeds(f.run('stable', 'host-finalize', { args: ['--operation-id', 'pop_before_rollback'] }));
  assert.equal(f.readProfile('active.json').ref, NEW_REF);

  const staged = f.run('stable', 'host-rollback-stage', {
    args: ['--operation-id', 'pop_explicit_rollback', '--ref', OLD_REF], commit: NEW_REF,
  });
  succeeds(staged);
  assert.equal(f.readProfile('active.json').ref, NEW_REF, 'staging a rollback must not stop or switch services');
  assert.ok(!staged.calls.some(isAction('stop')));

  const activated = f.run('stable', 'host-rollback-activate', {
    args: ['--operation-id', 'pop_explicit_rollback'], commit: NEW_REF,
  });
  succeeds(activated);
  assert.equal(f.readProfile('active.json').ref, OLD_REF);
  const journal = JSON.parse(readFileSync(join(
    f.profileRoot(), 'host-operations', 'pop_explicit_rollback', 'operation.json',
  ), 'utf8'));
  assert.equal(journal.status, 'succeeded');
  assert.equal(journal.resultRelease.ref, OLD_REF);
  const calls = dockerCalls(activated);
  assert.ok(calls.some((call) => call.args.includes('pg_restore')));
  assert.ok(calls.some((call) => call.args.some((arg) => String(arg).includes('/snapshot/api-home.tar'))));
  assert.equal(journal.controlPlaneBackupDir, journal.fallbackBackupDir);
  const overlayIndex = calls.findIndex((call) => call.restoreControlPlane);
  assert.ok(overlayIndex >= 0 && calls[overlayIndex].args.includes('--single-transaction'));
  assert.ok(calls.slice(overlayIndex + 1).some(isAction('up')), 'the current operation/drain must be restored before starting API and Web');
  const marker = JSON.parse(readFileSync(join(journal.controlPlaneBackupDir, 'complete.json'), 'utf8'));
  assert.ok(marker.files['control-plane.dump'].size > 0);
  assert.ok(readFileSync(join(journal.controlPlaneBackupDir, 'control-plane.dump'), 'utf8').includes(NEW_REF), 'overlay comes from rollback start, not the old business backup');
});

test('automatic profile update fingerprints exact source bytes and rolls back code without restoring historical data', (t) => {
  const f = fixture(t);
  f.activate();
  const stageArgs = [...hostStageArgs('pop_safe_update'), '--data-schema', SCHEMA];
  succeeds(f.run('stable', 'host-stage', { args: stageArgs, commit: NEW_REF }));
  const update = f.run('stable', 'host-activate', { args: ['--operation-id', 'pop_safe_update'], commit: NEW_REF });
  succeeds(update);
  const launch = dockerCalls(update).find(call => isAction('up')(call) && call.selectedRef === NEW_REF);
  assert.deepEqual(launch.args.slice(-3), ['--no-deps', 'api', 'web']);
  assert.equal(f.readProfile('active.json').dataSchema, SCHEMA);
  succeeds(f.run('stable', 'host-finalize', { args: ['--operation-id', 'pop_safe_update'] }));
  succeeds(f.run('stable', 'host-rollback-stage', { args: ['--operation-id', 'pop_safe_rollback', '--ref', OLD_REF, '--preserve-data', 'true'], commit: NEW_REF }));
  const rollback = f.run('stable', 'host-rollback-activate', { args: ['--operation-id', 'pop_safe_rollback'], commit: NEW_REF });
  succeeds(rollback);
  assert.equal(f.readProfile('active.json').ref, OLD_REF);
  assert.ok(!dockerCalls(rollback).some(call => call.args.includes('pg_restore') || call.args.includes('dropdb') || call.args.some(arg => String(arg).includes('/snapshot/api-home.tar'))));
  assert.ok(dockerCalls(rollback).some(call => call.args.includes('pg_dump')), 'a fresh rescue backup is still required');
});

test('automatic profile updates reject a changed schema before activating a candidate', (t) => {
  const f = fixture(t);
  f.activate();
  const stage = f.run('stable', 'host-stage', { args: [...hostStageArgs('pop_schema_changed'), '--data-schema', SCHEMA], commit: NEW_REF, fail: 'schema_changed' });
  assert.notEqual(stage.status, 0);
  assert.match(stage.stderr, /schema.*incompatible/iu);
  assert.equal(f.readProfile('active.json').ref, OLD_REF);
  assert.ok(!dockerCalls(stage).some(isAction('stop')));
});

test('automatic host crash recovery restores code while retaining current database and home data', (t) => {
  const f = fixture(t);
  f.activate();
  const operationId = 'pop_safe_crash';
  succeeds(f.run('stable', 'host-stage', { args: [...hostStageArgs(operationId), '--data-schema', SCHEMA], commit: NEW_REF }));
  const interrupted = f.run('stable', 'host-activate', { args: ['--operation-id', operationId], commit: NEW_REF, fail: 'crash_activate' });
  assert.equal(interrupted.status, 91);
  const recovered = f.run('stable', 'host-recover', { commit: NEW_REF });
  succeeds(recovered);
  assert.equal(f.readProfile('active.json').ref, OLD_REF);
  const journal = JSON.parse(readFileSync(join(f.profileRoot(), 'host-operations', operationId, 'operation.json'), 'utf8'));
  assert.equal(journal.status, 'rolled_back');
  assert.ok(existsSync(join(f.profileRoot(), 'host-control', 'write-fence.json')), 'the fence remains until the durable result is acknowledged');
  assert.ok(!dockerCalls(recovered).some(call => call.args.includes('pg_restore') || call.args.includes('dropdb') || call.args.some(arg => String(arg).includes('/snapshot/api-home.tar'))));
  const launch = dockerCalls(recovered).find(isAction('up'));
  assert.ok(launch.args.includes('--no-deps'));
  assert.deepEqual(launch.args.slice(-2), ['api', 'web']);
});

test('rollback refuses a backup whose content no longer matches its completion manifest', (t) => {
  const f = fixture(t);
  f.activate();
  const operationId = 'pop_backup_integrity';
  succeeds(f.run('stable', 'host-stage', { args: hostStageArgs(operationId), commit: NEW_REF }));
  succeeds(f.run('stable', 'host-activate', {
    args: ['--operation-id', operationId], commit: NEW_REF,
  }));
  const completed = JSON.parse(readFileSync(join(
    f.profileRoot(), 'host-operations', operationId, 'operation.json',
  ), 'utf8'));
  writeFileSync(join(completed.backupDir, 'postgres.dump'), 'tampered backup');

  const rejected = f.run('stable', 'host-rollback-stage', {
    args: ['--operation-id', 'pop_tampered_rollback', '--ref', OLD_REF], commit: NEW_REF,
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /No verified complete backup/u);
  assert.ok(!dockerCalls(rejected).some((call) =>
    call.args.includes('stop') || call.args.includes('up') || call.args.includes('pg_restore')
  ), 'an invalid backup must be rejected before any destructive Docker action');
  assert.equal(f.readProfile('active.json').ref, NEW_REF);
});

test('host recovery restores the old release after an executor crash during switch', (t) => {
  const f = fixture(t);
  f.activate();
  const operationId = 'pop_crash_recovery';
  succeeds(f.run('stable', 'host-stage', { args: hostStageArgs(operationId), commit: NEW_REF }));
  const operationRoot = join(f.profileRoot(), 'host-operations', operationId);
  const journalPath = join(operationRoot, 'operation.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  writeFileSync(journalPath, JSON.stringify({ ...journal, phase: 'switching', status: 'running' }));
  for (const name of ['deployment.json', 'compose.env', 'compose.yml']) {
    copyFileSync(join(operationRoot, 'candidate', name), join(f.profileRoot(), name));
  }
  assert.equal(f.readProfile('deployment.json').ref, NEW_REF);

  const recovered = f.run('stable', 'host-recover');
  succeeds(recovered);
  assert.equal(f.readProfile('active.json').ref, OLD_REF);
  assert.equal(f.readProfile('deployment.json').ref, OLD_REF);
  const after = JSON.parse(readFileSync(journalPath, 'utf8'));
  assert.equal(after.status, 'rolled_back');
  assert.match(after.error, /interrupted/u);
  assert.ok(dockerCalls(recovered).some((call) => isAction('up')(call) && call.selectedRef === OLD_REF));
});

for (const failure of ['stale_web', 'web_health']) {
  test(`a healthy API with ${failure} cannot commit a mixed or unhealthy release`, (t) => {
    const f = fixture(t);
    f.activate();
    const operationId = `pop_${failure}`;
    succeeds(f.run('stable', 'host-stage', { args: hostStageArgs(operationId), commit: NEW_REF }));
    const failed = f.run('stable', 'host-activate', { args: ['--operation-id', operationId], commit: NEW_REF, fail: failure });
    assert.notEqual(failed.status, 0);
    const journal = JSON.parse(readFileSync(join(f.profileRoot(), 'host-operations', operationId, 'operation.json'), 'utf8'));
    assert.equal(journal.status, 'rolled_back');
    assert.equal(journal.resultRelease.ref, OLD_REF);
    assert.equal(f.readProfile('active.json').ref, OLD_REF);
    assert.ok(dockerCalls(failed).some((call) => call.args.includes('pg_restore')));
  });
}

test('a failed database restore leaves writers stopped and can recover on the next host start', (t) => {
  const f = fixture(t);
  f.activate();
  const operationId = 'pop_restore_retry';
  succeeds(f.run('stable', 'host-stage', { args: hostStageArgs(operationId), commit: NEW_REF }));
  const failed = f.run('stable', 'host-activate', { args: ['--operation-id', operationId], commit: NEW_REF, fail: 'activate_restore' });
  assert.notEqual(failed.status, 0);
  const journalPath = join(f.profileRoot(), 'host-operations', operationId, 'operation.json');
  assert.equal(JSON.parse(readFileSync(journalPath, 'utf8')).status, 'recovery_required');
  const calls = dockerCalls(failed);
  const restore = calls.findIndex((call) => call.args.includes('pg_restore'));
  assert.ok(restore >= 0);
  assert.ok(!calls.slice(restore + 1).some(isAction('up')), 'no writer may restart after an incomplete restore');
  succeeds(f.run('stable', 'host-recover'));
  assert.equal(JSON.parse(readFileSync(journalPath, 'utf8')).status, 'rolled_back');
  assert.equal(f.readProfile('active.json').ref, OLD_REF);
});

test('an actual executor exit during candidate activation restores both services and data after restart', (t) => {
  const f = fixture(t);
  f.activate();
  const operationId = 'pop_real_activation_crash';
  succeeds(f.run('stable', 'host-stage', { args: hostStageArgs(operationId), commit: NEW_REF }));
  const crashed = f.run('stable', 'host-activate', { args: ['--operation-id', operationId], commit: NEW_REF, fail: 'crash_activate' });
  assert.equal(crashed.status, 91);
  const journalPath = join(f.profileRoot(), 'host-operations', operationId, 'operation.json');
  assert.equal(JSON.parse(readFileSync(journalPath, 'utf8')).phase, 'activating');
  const recovered = f.run('stable', 'host-recover');
  succeeds(recovered);
  assert.equal(JSON.parse(readFileSync(journalPath, 'utf8')).resultRelease.ref, OLD_REF);
  assert.ok(dockerCalls(recovered).some((call) => call.args.includes('dropdb')));
  assert.ok(dockerCalls(recovered).some((call) => call.args.includes('{{json .Image}}') && call.args.at(-1) === 'web-fixture'));
});

test('a failed explicit rollback restores its pre-rollback rescue snapshot', (t) => {
  const f = fixture(t);
  f.activate();
  succeeds(f.run('stable', 'host-stage', { args: hostStageArgs('pop_upgrade'), commit: NEW_REF }));
  succeeds(f.run('stable', 'host-activate', { args: ['--operation-id', 'pop_upgrade'], commit: NEW_REF }));
  succeeds(f.run('stable', 'host-finalize', { args: ['--operation-id', 'pop_upgrade'] }));
  const operationId = 'pop_failed_rollback';
  succeeds(f.run('stable', 'host-rollback-stage', { args: ['--operation-id', operationId, '--ref', OLD_REF] }));
  const failed = f.run('stable', 'host-rollback-activate', { args: ['--operation-id', operationId], fail: 'restore_old' });
  assert.notEqual(failed.status, 0);
  const journal = JSON.parse(readFileSync(join(f.profileRoot(), 'host-operations', operationId, 'operation.json'), 'utf8'));
  assert.equal(journal.status, 'failed');
  assert.equal(journal.resultRelease.ref, NEW_REF);
  assert.ok(journal.fallbackBackupDir);
  assert.equal(f.readProfile('active.json').ref, NEW_REF);
  assert.equal(dockerCalls(failed).filter((call) => call.args.includes('pg_restore')).length, 2);
});

test('rollback rejects a missing old Web image before stopping the current pair', (t) => {
  const f = fixture(t);
  f.activate();
  succeeds(f.run('stable', 'host-stage', { args: hostStageArgs('pop_upgrade'), commit: NEW_REF }));
  succeeds(f.run('stable', 'host-activate', { args: ['--operation-id', 'pop_upgrade'], commit: NEW_REF }));
  succeeds(f.run('stable', 'host-finalize', { args: ['--operation-id', 'pop_upgrade'] }));
  const rejected = f.run('stable', 'host-rollback-stage', { args: ['--operation-id', 'pop_missing_web', '--ref', OLD_REF], fail: 'missing_old_web' });
  assert.notEqual(rejected.status, 0);
  assert.ok(!dockerCalls(rejected).some(isAction('stop')));
  assert.equal(f.readProfile('active.json').ref, NEW_REF);
});

test('a crash while restoring PostgreSQL is retried without accepting a partial restore', (t) => {
  const f = fixture(t);
  f.activate();
  const operationId = 'pop_database_crash';
  succeeds(f.run('stable', 'host-stage', { args: hostStageArgs(operationId), commit: NEW_REF }));
  f.run('stable', 'host-activate', { args: ['--operation-id', operationId], fail: 'activate_restore' });
  const crashed = f.run('stable', 'host-recover', { fail: 'crash_restore' });
  assert.equal(crashed.status, 91);
  succeeds(f.run('stable', 'host-recover'));
  const journal = JSON.parse(readFileSync(join(f.profileRoot(), 'host-operations', operationId, 'operation.json'), 'utf8'));
  assert.equal(journal.status, 'rolled_back');
  assert.equal(journal.resultRelease.ref, OLD_REF);
});

test('a crash while building restores profile metadata without stopping the active pair', (t) => {
  const f = fixture(t);
  f.activate();
  const operationId = 'pop_stage_crash';
  const crashed = f.run('stable', 'host-stage', { args: hostStageArgs(operationId), commit: NEW_REF, fail: 'crash_build' });
  assert.equal(crashed.status, 91);
  assert.equal(f.readProfile('deployment.json').ref, NEW_REF);
  const recovered = f.run('stable', 'host-recover');
  succeeds(recovered);
  assert.equal(f.readProfile('deployment.json').ref, OLD_REF);
  assert.equal(f.readProfile('active.json').ref, OLD_REF);
  assert.ok(!dockerCalls(recovered).some(isAction('stop')));
  const journal = JSON.parse(readFileSync(join(f.profileRoot(), 'host-operations', operationId, 'operation.json'), 'utf8'));
  assert.equal(journal.status, 'failed');
});

test('rollback rejects an old image tag that now resolves to different content', (t) => {
  const f = fixture(t);
  f.activate();
  succeeds(f.run('stable', 'host-stage', { args: hostStageArgs('pop_upgrade'), commit: NEW_REF }));
  succeeds(f.run('stable', 'host-activate', { args: ['--operation-id', 'pop_upgrade'], commit: NEW_REF }));
  succeeds(f.run('stable', 'host-finalize', { args: ['--operation-id', 'pop_upgrade'] }));
  const rejected = f.run('stable', 'host-rollback-stage', { args: ['--operation-id', 'pop_mutated_web', '--ref', OLD_REF], fail: 'mutated_old_web' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /web image no longer matches/u);
  assert.ok(!dockerCalls(rejected).some(isAction('stop')));
});

test('a checksum manifest omitting required configuration is not a complete rollback backup', (t) => {
  const f = fixture(t);
  f.activate();
  succeeds(f.run('stable', 'host-stage', { args: hostStageArgs('pop_upgrade'), commit: NEW_REF }));
  succeeds(f.run('stable', 'host-activate', { args: ['--operation-id', 'pop_upgrade'], commit: NEW_REF }));
  succeeds(f.run('stable', 'host-finalize', { args: ['--operation-id', 'pop_upgrade'] }));
  const journal = JSON.parse(readFileSync(join(f.profileRoot(), 'host-operations', 'pop_upgrade', 'operation.json'), 'utf8'));
  const markerPath = join(journal.backupDir, 'complete.json');
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  delete marker.files['api.env'];
  writeFileSync(markerPath, JSON.stringify(marker));
  const rejected = f.run('stable', 'host-rollback-stage', { args: ['--operation-id', 'pop_missing_config', '--ref', OLD_REF] });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /No verified complete backup/u);
  assert.ok(!dockerCalls(rejected).some(isAction('stop')));
});

test('failure restoring the current control plane does not start the old API with an absent fence', (t) => {
  const f = fixture(t);
  f.activate();
  succeeds(f.run('stable', 'host-stage', { args: hostStageArgs('pop_upgrade'), commit: NEW_REF }));
  succeeds(f.run('stable', 'host-activate', { args: ['--operation-id', 'pop_upgrade'], commit: NEW_REF }));
  succeeds(f.run('stable', 'host-finalize', { args: ['--operation-id', 'pop_upgrade'] }));
  const operationId = 'pop_control_overlay_failure';
  succeeds(f.run('stable', 'host-rollback-stage', { args: ['--operation-id', operationId, '--ref', OLD_REF] }));
  const failed = f.run('stable', 'host-rollback-activate', { args: ['--operation-id', operationId], fail: 'control_overlay' });
  assert.notEqual(failed.status, 0);
  const calls = dockerCalls(failed);
  const overlay = calls.findIndex((call) => call.restoreControlPlane);
  assert.ok(overlay >= 0);
  assert.ok(!calls.slice(overlay + 1).some((call) => isAction('up')(call) && call.selectedRef === OLD_REF));
  const journal = JSON.parse(readFileSync(join(f.profileRoot(), 'host-operations', operationId, 'operation.json'), 'utf8'));
  assert.equal(journal.status, 'failed');
  assert.equal(journal.resultRelease.ref, NEW_REF);
});

test('a restart during explicit rollback reuses its persisted current control-plane snapshot', (t) => {
  const f = fixture(t);
  f.activate();
  succeeds(f.run('stable', 'host-stage', { args: hostStageArgs('pop_upgrade'), commit: NEW_REF }));
  succeeds(f.run('stable', 'host-activate', { args: ['--operation-id', 'pop_upgrade'], commit: NEW_REF }));
  succeeds(f.run('stable', 'host-finalize', { args: ['--operation-id', 'pop_upgrade'] }));
  const operationId = 'pop_control_overlay_crash';
  succeeds(f.run('stable', 'host-rollback-stage', { args: ['--operation-id', operationId, '--ref', OLD_REF] }));
  const crashed = f.run('stable', 'host-rollback-activate', { args: ['--operation-id', operationId], fail: 'crash_overlay' });
  assert.equal(crashed.status, 91);
  const journalPath = join(f.profileRoot(), 'host-operations', operationId, 'operation.json');
  const before = JSON.parse(readFileSync(journalPath, 'utf8'));
  assert.equal(before.phase, 'rolling_back');
  const recovered = f.run('stable', 'host-recover');
  succeeds(recovered);
  const after = JSON.parse(readFileSync(journalPath, 'utf8'));
  assert.equal(after.controlPlaneBackupDir, before.controlPlaneBackupDir);
  assert.equal(after.status, 'succeeded');
  assert.equal(after.resultRelease.ref, OLD_REF);
  assert.equal(dockerCalls(recovered).filter((call) => call.restoreControlPlane).length, 1);
  assert.ok(!dockerCalls(recovered).some((call) => call.args.includes('pg_dump')), 'recovery must not replace the persisted control plane with the partially restored database');
});

test('host write fence survives success until terminal acknowledgement and is mounted into API', (t) => {
  const f = fixture(t);
  f.activate();
  const operationId = 'pop_fence_lifecycle';
  succeeds(f.run('stable', 'host-stage', { args: hostStageArgs(operationId), commit: NEW_REF }));
  const activated = f.run('stable', 'host-activate', { args: ['--operation-id', operationId], commit: NEW_REF });
  succeeds(activated);
  const fencePath = join(f.profileRoot(), 'host-control', 'write-fence.json');
  assert.equal(JSON.parse(readFileSync(fencePath, 'utf8')).operationId, operationId);
  const overridePath = join(f.profileRoot(), 'compose.host-control.yml');
  const override = JSON.parse(readFileSync(overridePath, 'utf8'));
  assert.deepEqual(override.services.api.command, ['bun', 'run', '--preload', '/remi-host/host-write-fence.ts', 'apps/server/main.ts', 'serve']);
  assert.equal(override.services.api.volumes[0].target, '/remi-host');
  assert.equal(override.services.api.volumes[0].read_only, true);
  assert.ok(dockerCalls(activated).filter((call) => call.args.includes('compose') && call.args.includes('up')).every((call) => call.args.includes(overridePath)));
  succeeds(f.run('stable', 'host-finalize', { args: ['--operation-id', operationId] }));
  assert.ok(!existsSync(fencePath));
  assert.ok(existsSync(overridePath), 'preload remains attached and dynamically observes the next fence');
  succeeds(f.run('stable', 'host-finalize', { args: ['--operation-id', operationId] }));
});

test('host finalize cannot remove a nonterminal or different operation write fence', (t) => {
  const f = fixture(t);
  f.activate();
  const operationId = 'pop_fence_guard';
  succeeds(f.run('stable', 'host-stage', { args: hostStageArgs(operationId), commit: NEW_REF }));
  const crashed = f.run('stable', 'host-activate', { args: ['--operation-id', operationId], fail: 'crash_activate' });
  assert.equal(crashed.status, 91);
  const fencePath = join(f.profileRoot(), 'host-control', 'write-fence.json');
  const unfinished = f.run('stable', 'host-finalize', { args: ['--operation-id', operationId] });
  assert.notEqual(unfinished.status, 0);
  assert.match(unfinished.stderr, /not terminal/u);
  succeeds(f.run('stable', 'host-recover'));
  assert.equal(JSON.parse(readFileSync(fencePath, 'utf8')).operationId, operationId, 'automatic rollback retains the fence until its report is acknowledged');
  writeFileSync(fencePath, JSON.stringify({ operationId: 'pop_new_owner' }));
  const wrongOwner = f.run('stable', 'host-finalize', { args: ['--operation-id', operationId] });
  assert.notEqual(wrongOwner.status, 0);
  assert.match(wrongOwner.stderr, /does not own/u);
  assert.equal(JSON.parse(readFileSync(fencePath, 'utf8')).operationId, 'pop_new_owner');
});

test('old backup recovery and the next operation preserve the effective updater credentials through acknowledgement', (t) => {
  const f = fixture(t);
  f.activate();
  const apiEnvPath = join(f.profileRoot(), 'api.env');
  succeeds(f.run('stable', 'host-stage', { args: hostStageArgs('pop_auth_upgrade'), commit: NEW_REF }));
  succeeds(f.run('stable', 'host-activate', { args: ['--operation-id', 'pop_auth_upgrade'], commit: NEW_REF }));
  succeeds(f.run('stable', 'host-finalize', { args: ['--operation-id', 'pop_auth_upgrade'] }));
  const setCurrentCredentials = (source) => source
    .replace(/^MULTIREMI_TOKEN=.*$/mu, "MULTIREMI_TOKEN='fixture#new$master'")
    .replace(/^MULTIREMI_PLATFORM_UPDATER_TOKEN=.*$/mu, "MULTIREMI_PLATFORM_UPDATER_TOKEN='fixture#new$updater'");
  writeFileSync(apiEnvPath, setCurrentCredentials(readFileSync(apiEnvPath, 'utf8')));
  succeeds(f.run('stable', 'host-auth-refresh'));
  const authPath = join(f.profileRoot(), 'host-control', 'updater-auth.env');
  const currentAuth = readFileSync(authPath, 'utf8');
  assert.ok(currentAuth.includes('MULTIREMI_TOKEN=fixture#new$master\n'));
  const operationId = 'pop_auth_rollback';
  succeeds(f.run('stable', 'host-rollback-stage', { args: ['--operation-id', operationId, '--ref', OLD_REF] }));
  const crashed = f.run('stable', 'host-rollback-activate', { args: ['--operation-id', operationId], fail: 'crash_overlay' });
  assert.equal(crashed.status, 91);
  assert.ok(!readFileSync(apiEnvPath, 'utf8').includes('fixture#new$master'), 'the old business configuration really was restored');
  assert.ok(readFileSync(authPath, 'utf8') === currentAuth, 'current control credentials remain outside the business backup');
  const recovered = f.run('stable', 'host-recover');
  succeeds(recovered);
  assert.ok(readFileSync(authPath, 'utf8') === currentAuth, 'same-operation recovery must not capture old api.env');
  const marker = join(f.profileRoot(), 'host-control', 'write-fence.json');
  assert.ok(existsSync(marker), 'credentials remain usable while acknowledgement is still pending');
  const overridePath = join(f.profileRoot(), 'compose.host-control.yml');
  const override = JSON.parse(readFileSync(overridePath, 'utf8'));
  assert.equal(override.services.api.env_file.at(-1).path, authPath.replaceAll('\\', '/'));
  assert.equal(override.services.api.env_file.at(-1).format, 'raw');
  succeeds(f.run('stable', 'host-finalize', { args: ['--operation-id', operationId] }));
  assert.ok(!existsSync(marker));
  assert.ok(readFileSync(authPath, 'utf8') === currentAuth, 'acknowledgement must preserve the control channel overlay');
  succeeds(f.run('stable', 'host-stage', { args: hostStageArgs('pop_auth_next'), commit: NEW_REF }));
  succeeds(f.run('stable', 'host-activate', { args: ['--operation-id', 'pop_auth_next'], commit: NEW_REF }));
  assert.ok(readFileSync(authPath, 'utf8') === currentAuth, 'a new operation captures effective overlay values rather than historic api.env');
});

test('credential refresh is explicit and cannot replace an in-flight operation capture', (t) => {
  const f = fixture(t);
  f.activate();
  const operationId = 'pop_auth_refresh_guard';
  succeeds(f.run('stable', 'host-stage', { args: hostStageArgs(operationId), commit: NEW_REF }));
  succeeds(f.run('stable', 'host-activate', { args: ['--operation-id', operationId], commit: NEW_REF }));
  const authPath = join(f.profileRoot(), 'host-control', 'updater-auth.env');
  const before = readFileSync(authPath, 'utf8');
  const refused = f.run('stable', 'host-auth-refresh');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /during a fenced operation/u);
  assert.ok(readFileSync(authPath, 'utf8') === before);
});

test('internal updates persist across up and block competing host deployment or backup commands', (t) => {
  const f = fixture(t); f.activate();
  const overlay = join(f.profileRoot(), 'compose.internal-updates.yml');
  writeFileSync(overlay, 'services: {}\n');
  const resumed = f.run('stable', 'up'); succeeds(resumed);
  assert.ok(resumed.calls.find(call => call.args.includes('up')).args.includes(overlay));
  const before = readFileSync(join(f.profileRoot(), 'compose.env'), 'utf8');
  for (const action of ['deploy', 'restart', 'backup', 'host-recover', 'host-preflight']) {
    const refused = f.run('stable', action);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /uses internal updates/);
    assert.equal(refused.calls.length, 0);
  }
  assert.equal(readFileSync(join(f.profileRoot(), 'compose.env'), 'utf8'), before);
  writeFileSync(join(f.profileRoot(), 'compose.application.json'), '{}');
  const conflicting = f.run('stable', 'up');
  assert.notEqual(conflicting.status, 0);
  assert.match(conflicting.stderr, /cannot be combined/);
});


test('local builds inherit proxy names only and keep proxy values out of saved files and output', (t) => {
  const f = fixture(t);
  const proxy = 'http://build-user:sentinel-secret@127.0.0.1:17890';
  const environment = { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: 'localhost,127.0.0.1', http_proxy: proxy, https_proxy: proxy, no_proxy: 'localhost' };
  const result = f.run('stable', 'deploy', { environment });
  succeeds(result);
  const build = result.calls.find(isAction('build'));
  for (const service of ['api', 'web']) {
    assert.deepEqual(build.buildOverride.services[service].build, {
      args: Object.fromEntries(Object.keys(environment).map((key) => [process.platform === 'win32' ? key.toUpperCase() : key, null])),
      ...(process.platform === 'linux' ? { network: 'host' } : {}),
    });
  }
  assert.ok(build.args.indexOf('-') < build.args.indexOf('build'));
  assert.ok(result.calls.filter((call) => call !== build).every((call) => !call.buildOverride));
  assert.ok(!JSON.stringify(result.calls).includes('sentinel-secret'));
  assert.ok(!(result.stdout + result.stderr).includes('sentinel-secret'));
  for (const name of readdirSync(f.profileRoot())) {
    const path = join(f.profileRoot(), name);
    if (statSync(path).isFile()) assert.ok(!readFileSync(path, 'utf8').includes('sentinel-secret'), name);
  }
});

test('direct builds keep the original command and network overrides apply to dev watch rebuilds', (t) => {
  const f = fixture(t);
  succeeds(f.run('dev', 'prepare'));
  const direct = f.run('dev', 'build');
  succeeds(direct);
  assert.equal(direct.calls.find(isAction('build')).buildOverride, null);
  for (const network of ['host', 'default', 'none']) {
    const result = f.run('dev', 'watch', { environment: { REMI_BUILD_NETWORK: network, https_proxy: 'http://proxy.example:8080' } });
    succeeds(result);
    for (const call of result.calls.filter((call) => call.args.includes('--build') || call.args.includes('watch'))) {
      const proxyKey = process.platform === 'win32' ? 'HTTPS_PROXY' : 'https_proxy';
      assert.deepEqual(call.buildOverride.services.api.build, { args: { [proxyKey]: null }, network });
      assert.ok(call.environmentKeys.some((key) => key.toLowerCase() === 'https_proxy'), 'the lowercase proxy input reaches Docker');
    }
  }
});

for (const proxy of ['http://localhost:17890', 'http://127.4.3.2:17890', 'http://[::1]:17890', 'http://proxy.example:8080']) {
  test(`build network selection for ${proxy}`, (t) => {
    const f = fixture(t);
    succeeds(f.run('dev', 'prepare'));
    const result = f.run('dev', 'build', { environment: { HTTPS_PROXY: proxy } });
    succeeds(result);
    assert.equal(result.calls.find(isAction('build')).buildOverride.services.api.build.network,
      process.platform === 'linux' && !proxy.includes('proxy.example') ? 'host' : undefined);
  });
}

test('invalid build settings fail without disclosing proxy values or invoking a build', (t) => {
  const f = fixture(t);
  succeeds(f.run('dev', 'prepare'));
  for (const environment of [{ REMI_BUILD_NETWORK: 'bad-secret' }, { HTTPS_PROXY: 'bad-secret' }]) {
    const result = f.run('dev', 'build', { environment });
    assert.equal(result.status, 1);
    assert.ok(!result.stderr.includes('bad-secret'));
    assert.equal(result.calls.filter(isAction('build')).length, 0);
  }
});

test('Dockerfiles keep predefined proxy args out of image metadata and shell tracing', () => {
  for (const name of ['api', 'web']) {
    const source = readFileSync(join(repository, `deploy/docker/Dockerfile.${name}`), 'utf8');
    assert.doesNotMatch(source, /^(?:ARG|ENV)\s+.*(?:https?_proxy|no_proxy)/imu);
    assert.doesNotMatch(source, /\$(?:\{)?(?:https?_proxy|no_proxy)|set\s+-[a-z]*x/iu);
  }
});


for (const host of ['127.0.0.1', 'localhost', '[::1]', '127.2.3.4', 'proxy.example']) {
  test(`runtime proxy rewrites ${host} and merges internal bypasses without persisting values`, (t) => {
    const f = fixture(t);
    succeeds(f.run('dev', 'prepare'));
    const before = Object.fromEntries(readdirSync(f.profileRoot('dev')).filter((name) => name !== 'backups').map((name) => [name, readFileSync(join(f.profileRoot('dev'), name), 'utf8')]));
    const proxy = `http://sentinel-user:sentinel-password@${host}:17890`;
    const result = f.run('dev', 'up', { args: ['--runtime-proxy', 'true'], environment: {
      https_proxy: proxy, no_proxy: 'custom.internal,api', TEST_CAPTURE_RUNTIME: '1',
    } });
    succeeds(result);
    const call = result.calls.find(isAction('up'));
    const expected = `http://sentinel-user:sentinel-password@${host === 'proxy.example' ? host : 'host.docker.internal'}:17890/`;
    assert.equal(call.runtimeEnvironment.REMI_RUNTIME_HTTPS_PROXY, expected);
    assert.deepEqual(call.buildOverride.services.api.extra_hosts, ['host.docker.internal:host-gateway']);
    assert.deepEqual(call.buildOverride.services.api.environment, {
      HTTPS_PROXY: '${REMI_RUNTIME_HTTPS_PROXY}', https_proxy: '${REMI_RUNTIME_HTTPS_PROXY}',
      NO_PROXY: '${REMI_RUNTIME_NO_PROXY}', no_proxy: '${REMI_RUNTIME_NO_PROXY}',
    });
    assert.equal(call.buildOverride.services.web, undefined);
    const bypass = call.runtimeEnvironment.REMI_RUNTIME_NO_PROXY.split(',');
    for (const value of ['postgres', 'api', 'web', 'updater', 'localhost', '127.0.0.1', 'host.docker.internal', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'custom.internal']) assert.ok(bypass.includes(value));
    assert.equal(bypass.filter((value) => value === 'api').length, 1);
    for (const [name, contents] of Object.entries(before)) assert.equal(readFileSync(join(f.profileRoot('dev'), name), 'utf8'), contents);
    assert.deepEqual(readdirSync(join(f.profileRoot('dev'), 'backups')), []);
    assert.doesNotMatch(result.stdout + result.stderr + JSON.stringify(call.args) + JSON.stringify(call.buildOverride), /sentinel-user|sentinel-password/);
  });
}

test('disabled runtime proxy preserves compose bytes and invocation with proxy environment present', (t) => {
  const f = fixture(t);
  succeeds(f.run('dev', 'prepare'));
  assert.equal(readFileSync(join(f.profileRoot('dev'), 'compose.yml'), 'utf8'), readFileSync(join(repository, 'deploy/docker/compose.local.yml'), 'utf8'));
  const plain = f.run('dev', 'up');
  const disabled = f.run('dev', 'up', { args: ['--runtime-proxy', 'false'], environment: { HTTPS_PROXY: 'not even a valid URL' } });
  succeeds(plain); succeeds(disabled);
  assert.deepEqual(dockerCalls(disabled).map(({ args, buildOverride }) => ({ args, buildOverride })), dockerCalls(plain).map(({ args, buildOverride }) => ({ args, buildOverride })));
});

test('runtime diagnostic failures redact original and rewritten URLs and credentials', (t) => {
  const f = fixture(t);
  succeeds(f.run('dev', 'prepare'));
  const result = f.run('dev', 'up', { args: ['--runtime-proxy', 'true'], fail: 'runtime_diagnostic', environment: { HTTPS_PROXY: 'http://sentinel-user:sentinel-password@localhost:17890' } });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /REDACTED/);
  assert.doesNotMatch(result.stdout + result.stderr, /sentinel-user|sentinel-password|localhost:17890|host.docker.internal:17890/);
});

test('runtime proxy validates opt-in and URLs without disclosing invalid credentials', (t) => {
  const f = fixture(t);
  for (const environment of [{}, { HTTPS_PROXY: 'sentinel-password-invalid' }, { HTTP_PROXY: 'socks5://sentinel-password@localhost:17890' }]) {
    const result = f.run('dev', 'up', { args: ['--runtime-proxy', 'true'], environment });
    assert.equal(result.status, 1);
    assert.equal(dockerCalls(result).length, 0);
    assert.doesNotMatch(result.stderr, /sentinel-password/);
  }
});

test('stable deploy runtime proxy stays out of backups and precedes the up subcommand', (t) => {
  const f = fixture(t);
  f.activate();
  const result = f.run('stable', 'deploy', { commit: NEW_REF, args: ['--runtime-proxy', 'true'], environment: {
    HTTP_PROXY: 'http://sentinel-user:sentinel-password@localhost:17890',
    HTTPS_PROXY: 'https://secure.example:17891', NO_PROXY: 'upper.internal', no_proxy: 'lower.internal', TEST_CAPTURE_RUNTIME: '1',
  } });
  succeeds(result);
  for (const call of result.calls.filter(isAction('up'))) {
    assert.ok(call.args.indexOf('-') < call.args.indexOf('up'));
    assert.equal(call.runtimeEnvironment.REMI_RUNTIME_HTTP_PROXY, 'http://sentinel-user:sentinel-password@host.docker.internal:17890/');
    assert.equal(call.runtimeEnvironment.REMI_RUNTIME_HTTPS_PROXY, 'https://secure.example:17891/');
    const bypass = call.runtimeEnvironment.REMI_RUNTIME_NO_PROXY;
    if (process.platform !== 'win32') {
      assert.ok(bypass.includes('upper.internal'));
      assert.ok(bypass.includes('lower.internal'));
    }
  }
  function scan(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) scan(path);
      else assert.doesNotMatch(readFileSync(path, 'utf8'), /sentinel-user|sentinel-password|secure.example:17891|upper.internal|lower.internal/);
    }
  }
  scan(f.profileRoot());
  assert.doesNotMatch(result.stdout + result.stderr, /sentinel-user|sentinel-password/);
});

test('watch combines ephemeral runtime and build overlays without persisting proxy configuration', (t) => {
  const f = fixture(t);
  succeeds(f.run('dev', 'prepare'));
  const result = f.run('dev', 'watch', { args: ['--runtime-proxy', 'true'], environment: { HTTPS_PROXY: 'http://localhost:17890', TEST_CAPTURE_RUNTIME: '1' } });
  succeeds(result);
  const up = result.calls.find(isAction('up'));
  assert.ok(up.buildOverride.services.api.environment);
  assert.ok(up.buildOverride.services.api.build);
  assert.ok(up.buildOverride.services.web.build);
  const watch = result.calls.find(isAction('watch'));
  assert.deepEqual(watch.buildOverride.services.api.environment, up.buildOverride.services.api.environment);
  assert.deepEqual(watch.buildOverride.services.api.extra_hosts, up.buildOverride.services.api.extra_hosts);
  assert.deepEqual(watch.runtimeEnvironment, up.runtimeEnvironment);
});


test('streaming redactor protects secrets across chunks, overlaps and UTF-8 boundaries', async () => {
  const stream = redactor(['abc', 'abcdef', 'bcdef', '密码']);
  let output = '';
  stream.on('data', (chunk) => { output += chunk.toString(); });
  const done = once(stream, 'end');
  for (const byte of Buffer.from('start abcdef abc 密码 end')) stream.write(Buffer.from([byte]));
  stream.end();
  await done;
  assert.equal(output, 'start [REDACTED] [REDACTED] [REDACTED] end');
});

test('real streaming runner handles more than spawnSync default output without leaking credentials', () => {
  const request = { command: process.execPath, args: ['-e', `for(let i=0;i<100;i++){process.stdout.write('x'.repeat(32768)+'sentinel-secret');process.stderr.write('y'.repeat(32768)+'sentinel-secret')}`], secrets: ['sentinel-secret'], cwd: repository };
  const result = spawnSync(process.execPath, [join(repository, 'scripts/proxy-command.mjs'), '--run'], { input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 15000 });
  assert.ifError(result.error);
  succeeds(result);
  assert.ok(result.stdout.length > 1024 * 1024);
  assert.ok(result.stderr.length > 1024 * 1024);
  assert.doesNotMatch(result.stdout + result.stderr, /sentinel-secret/);
  assert.equal((result.stdout.match(/REDACTED/g) || []).length, 100);
});

test('real runner streams before child exit and forwards termination', { skip: process.platform === 'win32', timeout: 10000 }, async (t) => {
  const child = spawn(process.execPath, [join(repository, 'scripts/proxy-command.mjs'), '--run'], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  const closed = once(child, 'close');
  const data = once(child.stdout, 'data');
  child.stdin.end(JSON.stringify({ command: process.execPath, args: ['-e', `process.stdout.write('ready\\n');setInterval(()=>{},1000)`], secrets: ['secret'], cwd: repository }));
  await data;
  assert.equal(child.exitCode, null);
  child.kill('SIGTERM');
  const [code] = await closed;
  assert.notEqual(code, 0);
});

test('prepare deletes its extracted source archive', (t) => {
  const f = fixture(t);
  succeeds(f.run('stable', 'prepare'));
  assert.ok(existsSync(join(f.profileRoot(), 'releases', OLD_REF, '.remi-profile-source')));
  assert.ok(!existsSync(join(f.profileRoot(), 'releases', `${OLD_REF}.tar`)));
});

test('prune protects active, both candidates, in-flight snapshots and latest distinct backup refs', (t) => {
  const f = fixture(t); f.activate();
  const root = f.profileRoot();
  const refs = Array.from({ length: 12 }, (_, i) => i.toString(16).padStart(2, '0').repeat(20));
  const source = ref => join(root, 'releases', ref);
  const json = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
  for (const ref of refs) { mkdirSync(source(ref)); writeFileSync(`${source(ref)}.tar`, 'archive'); }
  mkdirSync(source('manual-release'));
  json(join(root, 'deployment.json'), { source: source(refs[0]) });
  writeFileSync(join(root, 'compose.env'), `REMI_SOURCE_DIR='${source(refs[1])}'\n`);
  for (const [name, status, previous, candidate] of [['one', 'running', 2, 3], ['two', 'recovery_required', 4, 5], ['done', 'succeeded', 6, 7]]) {
    const op = join(root, 'host-operations', name);
    json(join(op, 'operation.json'), { status });
    json(join(op, 'previous', 'deployment.json'), { source: source(refs[previous]) });
    json(join(op, 'candidate', 'deployment.json'), { source: source(refs[candidate]) });
  }
  for (const [name, index] of [['2026-01', 8], ['2026-02', 9], ['2026-03', 10], ['2026-04', 10]]) {
    json(join(root, 'backups', name, 'active.json'), { ref: refs[index], source: source(refs[index]) });
  }
  const options = { environment: { REMI_RELEASES_KEEP: '2' } };
  const dry = f.run('stable', 'prune-releases', { ...options, args: ['--dry-run'] }); succeeds(dry);
  assert.match(dry.stdout, /Would remove/);
  assert.ok(existsSync(source(refs[11])));
  succeeds(f.run('stable', 'prune-releases', options));
  for (let i = 0; i < refs.length; i++) {
    const kept = i <= 5 || i === 9 || i === 10;
    assert.equal(existsSync(source(refs[i])), kept, refs[i]);
    assert.equal(existsSync(`${source(refs[i])}.tar`), kept);
  }
  assert.ok(existsSync(source(OLD_REF)));
  assert.ok(existsSync(source('manual-release')));
});

// Unit files use systemd escapes even when the fixture path is a Windows path.
const daemonExecutable = (...parts) => join(...parts).replaceAll('\\', '\\\\');

test('prune protects effective daemon and latest distinct drop-in refs in systemd filename order', (t) => {
  const f = fixture(t); f.activate();
  const releases = join(f.profileRoot(), 'releases');
  const refs = ['b', 'c', 'd', 'e', 'f'].map(c => c.repeat(40));
  for (const ref of refs) { mkdirSync(join(releases, ref)); writeFileSync(join(releases, `${ref}.tar`), 'archive'); }
  const config = join(f.root, 'home/.config/systemd/user'); mkdirSync(config, { recursive: true });
  const unit = join(config, 'multiremi-daemon.service'); mkdirSync(`${unit}.d`);
  writeFileSync(unit, `[Service]\nExecStart="${daemonExecutable(releases, refs[4], 'daemon-bin/remi')}" daemon start\n`);
  const dropin = (name, ref) => writeFileSync(join(`${unit}.d`, name),
    `[Service]\nExecStart=\nExecStart="-${daemonExecutable(releases, ref, 'daemon-bin/remi')}" \\\n daemon start --foreground\n`);
  // Create in reverse lexical order; duplicate B must not consume retention.
  dropin('99-last.conf', refs[0]); dropin('98-duplicate.conf', refs[0]);
  dropin('50-middle.conf', refs[1]); dropin('20-old.conf', refs[2]); dropin('10-oldest.conf', refs[3]);
  const dry = f.run('stable', 'prune-releases', { args: ['--dry-run'] }); succeeds(dry);
  assert.doesNotMatch(dry.stderr, /Release pruning failed/);
  for (const ref of refs.slice(0, 3)) {
    assert.ok(dry.stdout.includes(`Keeping release for daemon reference: ${join(releases, ref)}`));
    assert.ok(!dry.stdout.includes(`Would remove release: ${join(releases, ref)}`));
  }
  for (const ref of refs.slice(3)) assert.ok(dry.stdout.includes(`Would remove release: ${join(releases, ref)}`));
  succeeds(f.run('stable', 'prune-releases'));
  for (const [i, ref] of refs.entries()) {
    assert.equal(existsSync(join(releases, ref)), i < 3);
    assert.equal(existsSync(join(releases, `${ref}.tar`)), i < 3);
  }
  assert.ok(existsSync(join(releases, OLD_REF)));
});

for (const keep of [0, 3]) for (const historical of [false, true]) {
  test(`daemon ${historical ? 'historical' : 'effective'} symlink protects its target with keep=${keep}`, (t) => {
    const f = fixture(t); f.activate();
    const releases = join(f.profileRoot(), 'releases');
    const targetRef = 'c'.repeat(40), obsoleteRef = 'd'.repeat(40);
    const target = join(releases, targetRef), link = join(releases, NEW_REF);
    mkdirSync(join(target, 'daemon-bin'), { recursive: true });
    writeFileSync(join(target, 'daemon-bin/remi'), 'daemon executable');
    writeFileSync(`${target}.tar`, 'archive');
    mkdirSync(join(releases, obsoleteRef));
    symlinkSync(target, link, 'dir');
    const unit = join(f.root, 'home/.config/systemd/user/multiremi-daemon.service');
    mkdirSync(`${unit}.d`, { recursive: true });
    writeFileSync(unit, `[Service]\nExecStart="${daemonExecutable(link, 'daemon-bin/remi')}" daemon start\n`);
    if (historical) writeFileSync(join(`${unit}.d`, '99-current.conf'),
      `[Service]\nExecStart=\nExecStart="${daemonExecutable(releases, OLD_REF, 'daemon-bin/remi')}" daemon start\n`);
    const environment = { REMI_RELEASES_KEEP: String(keep) };
    const retained = !historical || keep > 0;
    const dry = f.run('stable', 'prune-releases', { environment, args: ['--dry-run'] }); succeeds(dry);
    assert.doesNotMatch(dry.stderr, /Release pruning failed/);
    for (const ref of [NEW_REF, targetRef]) {
      assert.equal(dry.stdout.includes(`Keeping release for daemon reference: ${join(releases, ref)}`), retained);
    }
    assert.equal(dry.stdout.includes(`Would remove release: ${target}\n`), !retained);
    assert.ok(existsSync(join(target, 'daemon-bin/remi'))); // dry-run never deletes
    const result = f.run('stable', 'prune-releases', { environment }); succeeds(result);
    assert.doesNotMatch(result.stderr, /Release pruning failed/);
    assert.equal(existsSync(join(target, 'daemon-bin/remi')), retained);
    assert.equal(existsSync(`${target}.tar`), retained);
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.ok(!existsSync(join(releases, obsoleteRef)));
  });
}

for (const historical of [false, true]) for (const cyclic of [false, true]) {
  test(`daemon ${historical ? 'historical' : 'effective'} ${cyclic ? 'cyclic' : 'broken'} link aborts pruning`, (t) => {
    const f = fixture(t); f.activate();
    const releases = join(f.profileRoot(), 'releases');
    const link = join(releases, NEW_REF), obsolete = join(releases, 'c'.repeat(40));
    mkdirSync(obsolete);
    symlinkSync(cyclic ? link : join(releases, 'missing'), link, 'dir');
    const unit = join(f.root, 'home/.config/systemd/user/multiremi-daemon.service');
    mkdirSync(`${unit}.d`, { recursive: true });
    writeFileSync(unit, `[Service]\nExecStart="${daemonExecutable(link, 'daemon-bin/remi')}" daemon start\n`);
    if (historical) writeFileSync(join(`${unit}.d`, '99-current.conf'),
      '[Service]\nExecStart=\nExecStart=/usr/bin/remi daemon start\n');
    for (const args of [['--dry-run'], []]) {
      const result = f.run('stable', 'prune-releases', { args }); succeeds(result);
      assert.match(result.stderr, /Release pruning failed/);
      assert.doesNotMatch(result.stdout, /(?:Would remove|Removing) release:/);
      assert.ok(existsSync(obsolete));
      assert.ok(lstatSync(link).isSymbolicLink());
    }
  });
}

test('missing daemon release and daemon link outside releases do not abort pruning', (t) => {
  const f = fixture(t); f.activate();
  const releases = join(f.profileRoot(), 'releases');
  const outside = join(f.root, 'outside-daemon'), link = join(releases, NEW_REF);
  mkdirSync(outside); symlinkSync(outside, link, 'dir');
  const obsolete = join(releases, 'c'.repeat(40)); mkdirSync(obsolete);
  const unit = join(f.root, 'home/.config/systemd/user/multiremi-daemon.service');
  mkdirSync(dirname(unit), { recursive: true });
  writeFileSync(unit, `[Service]\nExecStart="${daemonExecutable(link, 'daemon-bin/remi')}" daemon start\nExecStart="${daemonExecutable(releases, 'd'.repeat(40), 'daemon-bin/remi')}" daemon start\n`);
  const dry = f.run('stable', 'prune-releases', { args: ['--dry-run'] }); succeeds(dry);
  assert.doesNotMatch(dry.stderr, /Release pruning failed/);
  assert.ok(dry.stdout.includes(`Would remove release: ${obsolete}`));
  assert.ok(!dry.stdout.includes(`Keeping release for daemon reference: ${outside}`));
  const result = f.run('stable', 'prune-releases'); succeeds(result);
  assert.doesNotMatch(result.stderr, /Release pruning failed/);
  assert.ok(!existsSync(obsolete));
  assert.ok(existsSync(outside));
  assert.ok(lstatSync(link).isSymbolicLink());
});

test('daemon empty ExecStart clears active references and keep zero retains only effective command', (t) => {
  const f = fixture(t); f.activate();
  const releases = join(f.profileRoot(), 'releases');
  const config = join(f.root, 'custom-config');
  const unit = join(config, 'systemd/user/multiremi-daemon.service'); mkdirSync(`${unit}.d`, { recursive: true });
  mkdirSync(join(releases, NEW_REF));
  writeFileSync(unit, `[Service]\nExecStart="${daemonExecutable(releases, NEW_REF, 'daemon-bin/remi')}" daemon start\n`);
  const environment = { XDG_CONFIG_HOME: config, REMI_RELEASES_KEEP: '0' };
  const dry = f.run('stable', 'prune-releases', { environment, args: ['--dry-run'] }); succeeds(dry);
  assert.ok(dry.stdout.includes(`Keeping release for daemon reference: ${join(releases, NEW_REF)}`));
  writeFileSync(join(`${unit}.d`, '99-clear.conf'), '[Service]\nExecStart=\nExecStart=/usr/bin/remi daemon start\n');
  succeeds(f.run('stable', 'prune-releases', { environment }));
  assert.ok(!existsSync(join(releases, NEW_REF)));
});

test('automatic pruning protects daemon unit reference with HOME fallback and ignores manual paths', (t) => {
  const f = fixture(t); f.activate();
  const ref = '1'.repeat(40);
  const releases = join(f.profileRoot(), 'releases'); mkdirSync(join(releases, ref));
  const unit = join(f.root, 'home/.config/systemd/user/multiremi-daemon.service');
  mkdirSync(dirname(unit), { recursive: true });
  writeFileSync(unit, `[Service]\nExecStart="${daemonExecutable(releases, ref, 'daemon-bin/remi')}" daemon start\n`);
  const environment = { XDG_CONFIG_HOME: '', REMI_RELEASES_KEEP: '0' };
  const result = f.run('stable', 'deploy', { commit: NEW_REF, environment }); succeeds(result);
  assert.doesNotMatch(result.stderr, /Release pruning failed/);
  assert.ok(existsSync(join(releases, ref)));
  mkdirSync(`${unit}.d`);
  writeFileSync(join(`${unit}.d`, '99-manual.conf'),
    `[Service]\nExecStart=\nExecStart="${daemonExecutable(releases, 'native-agy-test/daemon-bin/remi')}" daemon start\n`);
  const dry = f.run('stable', 'prune-releases', { environment, args: ['--dry-run'] }); succeeds(dry);
  assert.ok(dry.stdout.includes(`Would remove release: ${join(releases, ref)}`));
  assert.doesNotMatch(dry.stdout, /Keeping release for daemon reference/);
});

test('unreadable or unparseable daemon configuration aborts the entire prune plan', (t) => {
  const f = fixture(t); f.activate();
  const obsolete = join(f.profileRoot(), 'releases', NEW_REF); mkdirSync(obsolete);
  const unit = join(f.root, 'home/.config/systemd/user/multiremi-daemon.service');
  mkdirSync(`${unit}.d`, { recursive: true });
  const dropin = join(`${unit}.d`, '99-bad.conf');
  // EISDIR is a deterministic read failure even when tests run as root.
  mkdirSync(dropin);
  const check = () => {
    for (const args of [['--dry-run'], []]) {
      const result = f.run('stable', 'prune-releases', { args }); succeeds(result);
      assert.match(result.stderr, /Release pruning failed/);
      assert.doesNotMatch(result.stdout, /(?:Would remove|Removing) release:/);
      assert.ok(existsSync(obsolete));
    }
  };
  check(); rmSync(dropin, { recursive: true });
  writeFileSync(dropin, '[Service]\nExecStart="unterminated\n'); check();
  writeFileSync(dropin, '[Service]\nExecStart=%unknown/daemon\n'); check();
  writeFileSync(dropin, '[Service\nExecStart=/usr/bin/remi\n'); check();
});

test('prune excludes internal SHA and tar symlinks and mismatched entry types from its plan', (t) => {
  const f = fixture(t); f.activate();
  const releases = join(f.profileRoot(), 'releases');
  const manual = join(releases, 'manual-release'); mkdirSync(manual);
  const archive = join(releases, 'manual.tar'); writeFileSync(archive, 'keep');
  const directoryLink = join(releases, 'f'.repeat(40));
  const archiveLink = join(releases, `${'e'.repeat(40)}.tar`);
  symlinkSync(manual, directoryLink, 'dir');
  symlinkSync(archive, archiveLink, 'file');
  const shaFile = join(releases, 'd'.repeat(40)); writeFileSync(shaFile, 'keep');
  const tarDirectory = join(releases, `${'c'.repeat(40)}.tar`); mkdirSync(tarDirectory);
  // Include eligible garbage so preservation cannot pass by skipping all cleanup.
  const obsolete = join(releases, NEW_REF); mkdirSync(obsolete);
  const dry = f.run('stable', 'prune-releases', { args: ['--dry-run'] }); succeeds(dry);
  assert.ok(dry.stdout.includes(`Would remove release: ${obsolete}`));
  for (const path of [directoryLink, archiveLink, shaFile, tarDirectory]) assert.ok(!dry.stdout.includes(path));
  assert.ok(existsSync(obsolete));
  succeeds(f.run('stable', 'prune-releases'));
  assert.ok(!existsSync(obsolete));
  assert.ok(lstatSync(directoryLink).isSymbolicLink());
  assert.ok(lstatSync(archiveLink).isSymbolicLink());
  assert.equal(readFileSync(shaFile, 'utf8'), 'keep');
  assert.ok(lstatSync(tarDirectory).isDirectory());
  assert.ok(existsSync(manual));
  assert.equal(readFileSync(archive, 'utf8'), 'keep');
});

test('prune refuses escaping release symlinks and preserves outside files', (t) => {
  const f = fixture(t); f.activate();
  const outside = join(f.root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'sentinel'), 'keep');
  const link = join(f.profileRoot(), 'releases', NEW_REF);
  symlinkSync(outside, link, 'dir');
  const dry = f.run('stable', 'prune-releases', { args: ['--dry-run'] }); succeeds(dry);
  assert.ok(!dry.stdout.includes(link));
  const result = f.run('stable', 'prune-releases'); succeeds(result);
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'keep');
});

test('prune shares the host lock and never deletes while another operation owns it', (t) => {
  const f = fixture(t); f.activate();
  const path = join(f.profileRoot(), 'releases', NEW_REF); mkdirSync(path);
  writeFileSync(join(f.profileRoot(), 'host-update.lock'), JSON.stringify({ pid: process.pid }));
  const result = f.run('stable', 'prune-releases');
  assert.equal(result.status, 1); assert.match(result.stderr, /holds the lock/);
  assert.ok(existsSync(path));
});

test('automatic pruning failures only warn after successful deployment', (t) => {
  const f = fixture(t); f.activate();
  const result = f.run('stable', 'deploy', { commit: NEW_REF, environment: { REMI_RELEASES_KEEP: 'invalid' } });
  succeeds(result); assert.match(result.stderr, /Release pruning failed/);
  assert.equal(f.readProfile('active.json').ref, NEW_REF);
});


test('default retention keeps three distinct backup refs and rejects an escaping releases root', (t) => {
  const f = fixture(t); f.activate();
  const root = f.profileRoot();
  const refs = ['1', '2', '3', '4'].map(c => c.repeat(40));
  for (const [i, ref] of refs.entries()) {
    const source = join(root, 'releases', ref); mkdirSync(source);
    const backup = join(root, 'backups', `2026-0${i + 1}`); mkdirSync(backup);
    writeFileSync(join(backup, 'active.json'), JSON.stringify({ ref, source }));
  }
  succeeds(f.run('stable', 'prune-releases'));
  for (const [i, ref] of refs.entries()) assert.equal(existsSync(join(root, 'releases', ref)), i > 0);
  const outside = join(f.root, 'other-releases'); mkdirSync(outside);
  const sentinel = join(outside, NEW_REF); mkdirSync(sentinel);
  rmSync(join(root, 'releases'), { recursive: true });
  symlinkSync(outside, join(root, 'releases'), 'dir');
  const result = f.run('stable', 'prune-releases'); succeeds(result);
  assert.match(result.stderr, /Release path escapes profile root/);
  assert.ok(existsSync(sentinel));
});

const MODERN_SCHEMA = JSON.stringify({ format: 1, expandLevel: 3, contractLevel: 0, minLevel: 3, maxLevel: 3 });
for (const [name, environment, expected] of [
  ['missing metadata', { TEST_SCHEMA_INVENTORY: '{"historical":true,"metadata":false}' }, /remi db prepare/],
  ['empty metadata', { TEST_SCHEMA_ROWS: '[]' }, /Invalid schema metadata/],
  ['contract floor', { TEST_SCHEMA_ROWS: '[{"singleton":1,"expand_level":4,"contract_level":4}]' }, /exceeds target maximum/],
  ['query failure', {}, /failed/],
]) {
  test(`schema preflight rejects ${name} before stopping old containers`, t => {
    const f = fixture(t); f.activate();
    const result = f.run('stable', 'deploy', { commit: NEW_REF, fail: name === 'query failure' ? 'schema_query' : '', environment: { TEST_SCHEMA_TARGET: MODERN_SCHEMA, ...environment } });
    assert.equal(result.status, 1); assert.match(result.stderr, expected);
    assert.equal(f.readProfile('deployment.json').ref, OLD_REF);
    assert.equal(f.readProfile('active.json').ref, OLD_REF);
    assert.ok(!dockerCalls(result).some(call => call.args.includes('stop') || call.args.includes('up') || call.args.includes('pg_restore')));
  });
}
for (const inventory of ['{"historical":false,"metadata":false}', '{"historical":true,"metadata":true}']) {
  test(`schema preflight permits bootstrap or enrolled database: ${inventory}`, t => {
    const f = fixture(t); f.activate();
    succeeds(f.run('stable', 'deploy', { commit: NEW_REF, environment: { TEST_SCHEMA_TARGET: MODERN_SCHEMA, TEST_SCHEMA_INVENTORY: inventory } }));
    assert.equal(f.readProfile('active.json').ref, NEW_REF);
  });
}

test('failed automatic container rollback reports recovery required and never restores data', t => {
  const f = fixture(t); f.activate();
  const result = f.run('stable', 'deploy', { commit: NEW_REF, fail: 'deploy_rollback_failure' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /automatic container rollback failed.*manual recovery required/);
  assert.equal(f.readProfile('active.json').ref, OLD_REF);
  assert.ok(!dockerCalls(result).some(call => call.args.includes('pg_restore') || call.args.includes('createdb')));
});
