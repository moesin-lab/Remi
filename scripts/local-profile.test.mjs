import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scriptSource = readFileSync(join(repository, 'scripts/local-profile.mjs'), 'utf8');
const OLD_REF = 'a'.repeat(40);
const NEW_REF = 'b'.repeat(40);

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
const imageId = (tag) => 'sha256:' + createHash('sha256').update(tag).digest('hex');
childProcess.spawnSync = (command, args, options = {}) => {
  const metadataPath = join(process.env.TEST_PROFILE_ROOT, 'deployment.json');
  const selection = existsSync(metadataPath) ? JSON.parse(readFileSync(metadataPath, 'utf8')) : null;
  appendFileSync(process.env.TEST_COMMAND_LOG, JSON.stringify({
    command, args,
    // Log only names, never inherited values or the generated credentials.
    environmentKeys: Object.keys(options.env || {}),
    selectedRef: selection?.ref ?? null,
    selectedProfile: selection?.profile ?? null,
    restoreControlPlane: args.includes('pg_restore') && String(options.input ?? '').includes('CONTROL-PLANE'),
  }) + '\n');
  if (command === 'git' && args[0] === 'rev-parse') return succeed(process.env.TEST_COMMIT + '\n');
  if (command === 'git' && args[0] === 'fetch') return succeed();
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
  if (args.includes('image') && args.includes('inspect')) {
    if (process.env.TEST_FAIL === 'missing_old_web' && args.at(-1) === 'remi-web:stable-' + 'a'.repeat(40)) return fail();
    if (process.env.TEST_FAIL === 'mutated_old_web' && args.at(-1) === 'remi-web:stable-' + 'a'.repeat(40)) return succeed(imageId('different-content'));
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
  if (process.env.TEST_FAIL === 'config' && args.includes('config')) return fail();
  if (process.env.TEST_FAIL === 'build' && args.includes('build')) return fail();
  if (process.env.TEST_FAIL === 'crash_build' && args.includes('build')) process.exit(91);
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
  writeFileSync(script, scriptSource);
  writeFileSync(join(source, 'package.json'), '{"version":"0.2.60"}\n');
  writeFileSync(join(source, 'deploy/docker/host-write-fence.ts'), '// Runtime fence is validated independently.\n');
  for (const name of ['compose.local.yml', 'compose.local-dev.yml']) {
    copyFileSync(join(repository, 'deploy/docker', name), join(source, 'deploy/docker', name));
  }
  writeFileSync(mock, mockSource);

  function run(profile, action, { args = [], commit = OLD_REF, fail = '', environment = {}, profileBase = profilesRoot } = {}) {
    writeFileSync(log, '');
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(mock).href, script, profile, action, ...args], {
      env: {
        ...process.env,
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
