import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

function fixture(t, complexPaths = true) {
  const root = mkdtempSync(join(tmpdir(), 'remi-installer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Spaces and quotes exercise the shell launcher quoting, too.
  const bin = join(root, complexPaths ? "user's bin" : "bin"), store = join(root, complexPaths ? "user's store" : "store"), mocks = join(root, 'mocks');
  for (const dir of [bin, store, mocks]) mkdirSync(dir);
  writeFileSync(join(mocks, 'curl'), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n if [ "$1" = "-o" ]; then cp "$FIXTURE_ARCHIVE" "$2"; exit 0; fi\n shift\ndone\nexit 93\n', { mode: 0o755 });
  function archive(version, prepareExit = 0) {
    const release = join(root, version); mkdirSync(release);
    writeFileSync(join(release, 'remi'), `#!/bin/sh\nif [ "$1" = "fixed argument" ]; then shift; fi\nif [ "$1" = --version ]; then echo ${version}; exit; fi\nif [ "$1 $2" = 'runtime prepare' ]; then exit ${prepareExit}; fi\nprintf '%s\\n' "$@"\n`, { mode: 0o755 });
    writeFileSync(join(release, 'remi-claude-agent-acp'), '#!/bin/sh\necho wrapper\n', { mode: 0o755 });
    writeFileSync(join(release, 'runtime-bundle.json'), '{}\n');
    const path = join(root, `${version}.tar.gz`);
    execFileSync('tar', ['czf', path, '-C', release, 'remi', 'remi-claude-agent-acp', 'runtime-bundle.json']);
    return { path, id: createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 8) };
  }
  function install(version, artifact, extraEnv = {}) {
    return spawnSync('bash', [resolve('scripts/install-remi.sh')], { encoding: 'utf8', timeout: 15000, env: {
      ...process.env, PATH: `${mocks}:${process.env.PATH}`, MULTIREMI_VERSION: version, MULTIREMI_BIN_DIR: bin,
      MULTIREMI_INSTALL_ROOT: store, FIXTURE_ARCHIVE: artifact.path, ...extraEnv,
    } });
  }
  return { root, bin, store, mocks, archive, install, launcher: join(bin, 'remi') };
}

test('first install preserves a direct executable and publishes adjacent bundle plus stable launcher', t => {
  const f = fixture(t);
  // An executable without a shebang takes the direct-executable preservation path.
  const old = "printf '0.1.0\\n'\n";
  writeFileSync(f.launcher, old, { mode: 0o755 });
  const a = f.archive('1.0.0'); const r = f.install('1.0.0', a);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(f.store, 'versions/previous-0.1.0/remi'), 'utf8'), old);
  assert.match(readFileSync(f.launcher, 'utf8'), /^#!\/bin\/sh/);
  assert.equal(execFileSync(f.launcher, ['--version'], { encoding: 'utf8' }).trim(), '1.0.0');
  for (const name of ['remi', 'remi-claude-agent-acp', 'runtime-bundle.json', 'launcher', 'previous-launcher'])
    assert.ok(existsSync(join(f.store, 'versions', a.id, name)), name);
  assert.equal(execFileSync(join(f.bin, 'remi-claude-agent-acp'), { encoding: 'utf8' }).trim(), 'wrapper');
});

test('second install preserves shell setup and arguments; repeat install keeps old snapshots', t => {
  const f = fixture(t), a = f.archive('1.0.0'), b = f.archive('1.0.1');
  assert.equal(f.install('1.0.0', a).status, 0);
  const original = readFileSync(f.launcher, 'utf8');
  writeFileSync(f.launcher, original.replace('# Remi stable launcher;', 'export FIXTURE_LOCAL_SETTING=kept\n# Remi stable launcher;').replace('"$@"', '"fixed argument" "$@"'));
  const r = f.install('1.0.1', b); assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(f.launcher, 'utf8'), /export FIXTURE_LOCAL_SETTING=kept/);
  assert.ok(readFileSync(f.launcher, 'utf8').includes('"fixed argument" "$@"'));
  assert.equal(execFileSync(f.launcher, ['argument with spaces', '$literal'], { encoding: 'utf8' }), 'argument with spaces\n$literal\n');
  assert.equal(execFileSync(f.launcher, ['--version'], { encoding: 'utf8' }).trim(), '1.0.1');
  assert.ok(existsSync(join(f.store, 'versions', a.id, 'remi')));
  assert.equal(f.install('1.0.1', b).status, 0);
});

test('runtime preparation failure and version mismatch preserve the selected launcher', t => {
  const f = fixture(t), a = f.archive('1.0.0'), bad = f.archive('1.0.1', 1);
  assert.equal(f.install('1.0.0', a).status, 0);
  const before = readFileSync(f.launcher);
  const r = f.install('1.0.1', bad); assert.notEqual(r.status, 0);
  assert.match(r.stderr, /existing remi binary was not replaced/);
  assert.deepEqual(readFileSync(f.launcher), before);
  assert.notEqual(f.install('1.0.2', a).status, 0);
  assert.deepEqual(readFileSync(f.launcher), before);
});

test('failure while publishing wrapper leaves the current CLI launcher unchanged', t => {
  const f = fixture(t), a = f.archive('1.0.0'), b = f.archive('1.0.1');
  assert.equal(f.install('1.0.0', a).status, 0);
  const before = readFileSync(f.launcher);
  const realMv = execFileSync('which', ['mv'], { encoding: 'utf8' }).trim();
  writeFileSync(join(f.mocks, 'mv'), `#!/bin/sh\ncase "$*" in *remi-claude-agent-acp*) exit 79 ;; esac\nexec '${realMv}' "$@"\n`, { mode: 0o755 });
  assert.notEqual(f.install('1.0.1', b).status, 0);
  assert.deepEqual(readFileSync(f.launcher), before);
});


test('reinstall accepts historical simple single and double quoted executable tokens', t => {
  for (const quote of ["'", '"']) {
    const f = fixture(t, false), a = f.archive('1.0.0'), b = f.archive('1.0.1');
    assert.equal(f.install('1.0.0', a).status, 0);
    const target = join(f.store, 'versions', a.id, 'remi');
    writeFileSync(f.launcher, `#!/bin/sh\nexport LOCAL_SETUP=preserved\nexec ${quote}${target}${quote} "fixed argument" "$@"\n`);
    const r = f.install('1.0.1', b); assert.equal(r.status, 0, r.stderr);
    assert.ok(readFileSync(f.launcher, 'utf8').includes('export LOCAL_SETUP=preserved'));
    assert.ok(readFileSync(f.launcher, 'utf8').includes('"fixed argument" "$@"'));
    assert.equal(execFileSync(f.launcher, ['--version'], { encoding: 'utf8' }).trim(), '1.0.1');
  }
});
