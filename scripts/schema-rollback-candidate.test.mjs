import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scripts = dirname(fileURLToPath(import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'mul4-candidate-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = join(base, 'source');
  await mkdir(join(source, 'scripts'), { recursive: true });
  for (const name of ['run-schema-rollback.mjs', 'schema-rollback-candidate.mjs']) await copyFile(join(scripts, name), join(source, 'scripts', name));
  await writeFile(join(source, 'package.json'), JSON.stringify({ type: 'module', workspaces: ['packages/*'] }));
  await mkdir(join(source, 'packages', 'a'), { recursive: true });
  await writeFile(join(source, 'packages', 'a', 'package.json'), '{"name":"fixture-a"}');
  await writeFile(join(source, 'bun.lock'), 'fixed lock bytes\n');
  await writeFile(join(source, 'source.mjs'), 'export const fixed = "S";\n');
  await writeFile(join(source, 'executable'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await symlink('source.mjs', join(source, 'source-link.mjs'));
  await writeFile(join(source, '.gitignore'), 'node_modules/\n.env\nignored/\n');
  git(source, 'init', '-q'); git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@example.invalid');
  git(source, 'add', '.'); git(source, 'commit', '-qm', 'S');
  const ref = git(source, 'rev-parse', 'HEAD'), tree = git(source, 'rev-parse', 'HEAD^{tree}');
  const runId = randomUUID(), runRoot = join(base, `schema-rollback-${runId}`);
  await mkdir(runRoot, { mode: 0o700 });
  const candidateRoot = join(runRoot, 'candidate'), artifactRoot = join(base, 'artifacts'), control = join(runRoot, 'control');
  await mkdir(control, { mode: 0o700 }); await mkdir(artifactRoot);
  execFileSync('git', ['clone', '--no-local', '--no-checkout', source, candidateRoot], { stdio: 'pipe' });
  git(candidateRoot, 'checkout', '--detach', ref); git(candidateRoot, 'remote', 'set-url', 'origin', 'https://github.com/moesin-lab/Remi.git');
  const context = { format: 1, runId, runRoot, candidateRoot, expectedRef: ref, expectedTree: tree, artifactRoot,
    lockfileSha256: sha256(await readFile(join(candidateRoot, 'bun.lock'))),
    installationDirectories: ['node_modules', 'packages/a/node_modules'], runtime: { node: process.version, bun: '1.3.14' } };
  const contextPath = join(control, 'run-context.json'), bytes = JSON.stringify(context);
  await writeFile(contextPath, bytes);
  const env = { ...process.env, SCHEMA_ROLLBACK_RUN_CONTEXT: contextPath, SCHEMA_ROLLBACK_CONTEXT_SHA256: sha256(bytes) };
  const helperPath = join(candidateRoot, 'scripts', 'schema-rollback-candidate.mjs');
  const run = (overrides = {}) => spawnSync(process.execPath, ['--input-type=module', '-e', `
    const helper = await import(${JSON.stringify(pathToFileURL(helperPath).href)});
    const context = await helper.loadCandidateContext(process.env.SCHEMA_ROLLBACK_RUN_CONTEXT);
    console.log(JSON.stringify(await helper.verifyCandidate(context)));
  `], { cwd: candidateRoot, env, encoding: 'utf8', ...overrides });
  return { source, base, context, contextPath, candidateRoot, artifactRoot, env, run, ref, tree };
}
function passed(result) { assert.equal(result.status, 0, result.stderr); }
function rejected(result, expression) { assert.notEqual(result.status, 0, result.stdout); assert.match(result.stderr, expression); }

test('actual independent clone verifies complete source and safe workspace dependencies in a real process', async t => {
  const f = await fixture(t);
  passed(f.run());
  assert.deepEqual(JSON.parse(f.run().stdout), { runId: f.context.runId, ref: f.ref, tree: f.tree });
  await mkdir(join(f.candidateRoot, 'node_modules', '.bin'), { recursive: true });
  await writeFile(join(f.candidateRoot, 'node_modules', 'dependency.mjs'), 'export {};');
  await symlink('../packages/a', join(f.candidateRoot, 'node_modules', 'fixture-a'));
  await symlink('../../executable', join(f.candidateRoot, 'node_modules', '.bin', 'fixture'));
  await mkdir(join(f.candidateRoot, 'packages', 'a', 'node_modules'));
  passed(f.run());
  // Git's 100755 owner-executable mode also materializes as 0700 under
  // restrictive umask; group/other permissions do not change its tree mode.
  await chmod(join(f.candidateRoot, 'executable'), 0o700);
  passed(f.run());
  const alias = join(f.base, 'cwd-alias'); await symlink(f.candidateRoot, alias);
  passed(f.run({ cwd: alias }));
  assert.equal((await lstat(join(f.candidateRoot, '.git', 'objects'))).isDirectory(), true);
});

test('shared dirty source and later HEAD cannot affect fixed private bytes or identity', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'source.mjs'), 'export const fixed = "shared dirty";\n');
  passed(f.run());
  git(f.source, 'add', '.'); git(f.source, 'commit', '-qm', 'B');
  assert.notEqual(git(f.source, 'rev-parse', 'HEAD'), f.ref);
  passed(f.run());
  assert.equal(await readFile(join(f.candidateRoot, 'source.mjs'), 'utf8'), 'export const fixed = "S";\n');
});

for (const [name, mutate, message] of [
  ['same-size bytes hidden by assume-unchanged', async f => { git(f.candidateRoot, 'update-index', '--assume-unchanged', 'source.mjs'); await writeFile(join(f.candidateRoot, 'source.mjs'), 'export const fixed = "B";\n'); }, /Source bytes changed/],
  ['executable mode', f => chmod(join(f.candidateRoot, 'executable'), 0o644), /executable mode changed/],
  ['symlink bytes', async f => { await rm(join(f.candidateRoot, 'source-link.mjs')); await symlink('executable', join(f.candidateRoot, 'source-link.mjs')); }, /Source bytes changed/],
  ['tracked file replaced with symlink', async f => { await rm(join(f.candidateRoot, 'source.mjs')); await symlink('executable', join(f.candidateRoot, 'source.mjs')); }, /Source file type/],
  ['missing file', f => rm(join(f.candidateRoot, 'source.mjs')), /ENOENT|Tracked source is missing/],
  ['ignored environment loader', f => writeFile(join(f.candidateRoot, '.env'), 'NODE_OPTIONS=--import=evil'), /Unexpected candidate inventory/],
  ['ignored directory', async f => { await mkdir(join(f.candidateRoot, 'ignored')); await writeFile(join(f.candidateRoot, 'ignored', 'loader.mjs'), 'evil'); }, /Unexpected candidate inventory/],
  ['unlisted node_modules', async f => { await mkdir(join(f.candidateRoot, 'scripts', 'node_modules')); }, /Unexpected candidate inventory/],
  ['dependency link to shared source', async f => { await mkdir(join(f.candidateRoot, 'node_modules')); await symlink(f.source, join(f.candidateRoot, 'node_modules', 'escape')); }, /Dependency link escapes/],
  ['dependency hardlink to shared file', async f => { await mkdir(join(f.candidateRoot, 'node_modules')); await link(join(f.source, 'source.mjs'), join(f.candidateRoot, 'node_modules', 'shared.mjs')); }, /Dependency file is shared/],
  ['install root symlink', f => symlink(f.source, join(f.candidateRoot, 'node_modules')), /Install root must be a real directory/],
  ['Git alternates', f => writeFile(join(f.candidateRoot, '.git', 'objects', 'info', 'alternates'), join(f.source, '.git', 'objects')), /Git object sharing/],
  ['uncommitted lockfile', f => writeFile(join(f.candidateRoot, 'bun.lock'), 'changed lock bytes'), /Source bytes changed/],
]) {
  test(`private candidate rejects ${name}`, async t => { const f = await fixture(t); await mutate(f); rejected(f.run(), message); });
}

test('private clean HEAD at another commit rejects even when schema level is unchanged', async t => {
  const f = await fixture(t);
  git(f.candidateRoot, 'config', 'user.name', 'Fixture'); git(f.candidateRoot, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(f.candidateRoot, 'source.mjs'), 'export const fixed = "B";\n');
  git(f.candidateRoot, 'add', '.'); git(f.candidateRoot, 'commit', '-qm', 'B');
  rejected(f.run(), /Candidate HEAD changed/);
});

for (const key of ['runId', 'expectedRef', 'expectedTree', 'candidateRoot', 'installationDirectories']) {
  test(`context replacement changing ${key} fails against parent digest before any module loading`, async t => {
    const f = await fixture(t), changed = structuredClone(f.context);
    changed[key] = key === 'installationDirectories' ? ['node_modules', 'ignored'] : key === 'candidateRoot' ? f.source : key === 'runId' ? randomUUID() : 'a'.repeat(40);
    await writeFile(f.contextPath, JSON.stringify(changed));
    rejected(f.run(), /Private context bytes differ from parent binding/);
  });
}

test('missing context digest, wrong cwd, and a helper loaded from shared source all reject', async t => {
  const f = await fixture(t);
  rejected(f.run({ env: { ...f.env, SCHEMA_ROLLBACK_CONTEXT_SHA256: '' } }), /Parent context digest is required/);
  rejected(f.run({ cwd: f.source }), /Candidate cwd does not match/);
  const sharedHelper = pathToFileURL(join(f.source, 'scripts', 'schema-rollback-candidate.mjs')).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `const h = await import(${JSON.stringify(sharedHelper)}); await h.loadCandidateContext(process.env.SCHEMA_ROLLBACK_RUN_CONTEXT);`],
    { cwd: f.candidateRoot, env: f.env, encoding: 'utf8' });
  rejected(result, /Candidate entry is outside private root/);
});
