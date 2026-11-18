import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOperator } from './operator.mjs';

test('init and collect reject mismatched UID before files or external commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a5-operator-'));
  try {
    const data = join(root, 'data');
    for (const action of ['init', 'collect']) await assert.rejects(runOperator(action, {
      env: { A5_RUNTIME_UID: '1000', A5_DATA_DIR: data }, uid: 2000,
      exec: () => assert.fail('No external command allowed'),
    }), /Execution UID 2000 must equal A5_RUNTIME_UID=1000/);
    await assert.rejects(stat(data), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('matching UID init produces private directories and matching container configuration without Docker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a5-operator-'));
  try {
    const source = join(root, 'source'), data = join(root, 'data'), sha = 'a'.repeat(40);
    await mkdir(join(source, 'packages/platform-updater/src'), { recursive: true });
    await writeFile(join(source, 'packages/platform-updater/src/slot-supervisor.mjs'), '// fixture');
    const uid = process.getuid();
    await runOperator('init', { uid, env: { A5_RUNTIME_UID: String(uid), A5_SOURCE_DIR: source, A5_DATA_DIR: data, A5_MERGED_SHA: sha },
      exec: (command, args) => { assert.equal(command, 'git'); return args[0] === 'rev-parse' ? sha : ''; } });
    for (const path of [data, join(data, 'evidence'), join(data, 'control')]) {
      const info = await stat(path); assert.equal(info.uid, uid); assert.equal(info.mode & 0o777, 0o700);
    }
    for (const name of ['api.env', 'updater.env', 'compose.env', 'candidate.compose.json', 'environment.json']) {
      assert.equal((await stat(join(data, name))).mode & 0o777, 0o600);
    }
    const overlay = JSON.parse(await readFile(join(data, 'candidate.compose.json'), 'utf8'));
    assert.equal(overlay.services.api.environment.REMI_RUNTIME_UID, String(uid));
    assert.match(overlay.services.api.entrypoint[2], new RegExp(`chown ${uid}:1000`));
    assert.ok(overlay.services.api.entrypoint[2].endsWith('"$$@"'));
    const setup = JSON.parse(await readFile(join(data, 'environment.json'), 'utf8'));
    if (uid !== 1000) {
      for (const name of ['web', 'updater', 'rehearsal']) assert.equal(overlay.services[name].user, `${uid}:1000`);
      assert.equal(overlay.services['candidate-init'].user, '0:0');
      assert.ok(overlay.services['candidate-init'].volumes.every(v => !v.includes('control')));
    }
    assert.equal(setup.runtimeUid, uid); assert.equal(setup.phaseAAccepted, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('driver rejects UID mismatch before control access or evidence creation', async () => {
  const { run } = await import('../phase-a-acceptance.mjs');
  const previous = process.env.A5_RUNTIME_UID;
  process.env.A5_RUNTIME_UID = String(process.getuid() + 1);
  try { await assert.rejects(run({}, '/unused'), /must equal A5_RUNTIME_UID/); }
  finally {
    if (previous === undefined) delete process.env.A5_RUNTIME_UID;
    else process.env.A5_RUNTIME_UID = previous;
  }
});
