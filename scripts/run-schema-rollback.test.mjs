import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scripts = dirname(fileURLToPath(import.meta.url));
const gitBinary = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const git = (root, ...args) => execFileSync(gitBinary, ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const present = async path => { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
async function fixture(t, behavior = 'normal') {
  const base = await mkdtemp(join(tmpdir(), 'mul4-launcher-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = join(base, 'source'), bin = join(base, 'bin'), artifacts = join(base, 'artifacts'), records = join(base, 'records');
  await mkdir(join(source, 'scripts'), { recursive: true }); await mkdir(bin); await mkdir(records);
  for (const name of ['run-schema-rollback.mjs', 'schema-rollback-candidate.mjs']) await copyFile(join(scripts, name), join(source, 'scripts', name));
  await writeFile(join(source, 'package.json'), JSON.stringify({ type: 'module', workspaces: ['packages/*'] }));
  await mkdir(join(source, 'packages', 'a'), { recursive: true });
  await writeFile(join(source, 'packages', 'a', 'package.json'), '{"name":"fixture-a"}');
  await writeFile(join(source, 'bun.lock'), 'fixed fixture lock\n');
  await writeFile(join(source, 'source.mjs'), 'export const marker = "S";\n');
  for (const file of ['prepare-schema-rollback.ts', 'check-schema-rollback.ts']) await writeFile(join(source, 'scripts', file), '// controlled Bun tool fixture\n');
  git(source, 'init', '-q'); git(source, 'config', 'user.name', 'Fixture'); git(source, 'config', 'user.email', 'fixture@example.invalid');
  git(source, 'add', '.'); git(source, 'commit', '-qm', 'S');
  const ref = git(source, 'rev-parse', 'HEAD'), tree = git(source, 'rev-parse', 'HEAD^{tree}');
  const bootstrap = join(base, 'bootstrap'); await mkdir(bootstrap);
  const launcher = join(bootstrap, 'launcher.mjs');
  // Exactly the CI model: export one self-contained file from immutable objects.
  await writeFile(launcher, execFileSync(gitBinary, ['-C', source, 'show', `${ref}:scripts/run-schema-rollback.mjs`]));
  await writeFile(join(bin, 'bun'), `#!/usr/bin/env node
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const behavior = ${JSON.stringify(behavior)}, sharedSource = ${JSON.stringify(source)}, recordRoot = ${JSON.stringify(records)};
const args = process.argv.slice(2);
if (args[0] === '--version') { assert.equal(process.env.GH_TOKEN, undefined); console.log(behavior === 'wrong-bun' ? '1.3.13' : '1.3.14'); process.exit(0); }
assert.equal(process.env.NODE_PATH, undefined); assert.equal(process.env.NODE_OPTIONS, undefined);
assert.equal(process.env.GIT_DIR, undefined); assert.equal(process.env.GIT_INDEX_FILE, undefined);
assert.equal(process.env.npm_config_registry, undefined);
assert.equal((await readFile(join(process.env.HOME, '.npmrc'), 'utf8')).trim(), 'registry=https://registry.npmjs.org');
const ctx = JSON.parse(await readFile(process.env.SCHEMA_ROLLBACK_RUN_CONTEXT, 'utf8'));
const record = value => appendFile(join(recordRoot, ctx.runId + '.jsonl'), JSON.stringify(value) + '\\n');
if (args[0] === 'install') {
  assert.equal(process.env.GH_TOKEN, undefined);
  assert.deepEqual(args, ['install', '--registry', 'https://registry.npmjs.org', '--frozen-lockfile', '--ignore-scripts', '--backend=copyfile']);
  assert.equal(await readFile(join(process.cwd(), 'bun.lock'), 'utf8'), 'fixed fixture lock\\n');
  const previous = process.cwd() !== ctx.candidateRoot;
  if (!previous) assert.equal(JSON.parse(await readFile(join(process.cwd(), 'packages/a/package.json'), 'utf8')).name, 'fixture-a');
  await record({ stage: previous ? 'previous-install' : 'candidate-install', cwd: process.cwd(), home: process.env.HOME, runRoot: ctx.runRoot });
  if (behavior === (previous ? 'previous-install-fail' : 'candidate-install-fail')) process.exit(21);
  await mkdir(join(process.cwd(), 'node_modules'));
  await writeFile(join(process.cwd(), 'node_modules', 'dependency.mjs'), 'export {};');
  process.exit(0);
}
assert.equal(process.env.GH_TOKEN, 'fixture-query-token');
if (args[1] === 'scripts/prepare-schema-rollback.ts') {
  await record({ stage: 'prepare', candidateRoot: ctx.candidateRoot, source: await readFile(join(ctx.candidateRoot, 'source.mjs'), 'utf8') });
  if (behavior === 'prepare-fail') process.exit(22);
  if (behavior === 'shared-dirty' || behavior === 'shared-head') {
    await writeFile(join(sharedSource, 'source.mjs'), 'export const marker = "shared changed";\\n');
    await writeFile(join(sharedSource, 'scripts/run-schema-rollback.mjs'), 'invalid shared launcher after bootstrap\\n');
    if (behavior === 'shared-head') {
      execFileSync(${JSON.stringify(gitBinary)}, ['-C', sharedSource, 'add', '.']);
      execFileSync(${JSON.stringify(gitBinary)}, ['-C', sharedSource, 'commit', '-qm', 'B']);
    }
  }
  if (behavior === 'private-dirty') await writeFile(join(ctx.candidateRoot, 'source.mjs'), 'export const marker = "private changed";\\n');
  if (behavior === 'context-replaced') { ctx.runId = '12345678-1234-4234-8234-123456789abc'; await writeFile(process.env.SCHEMA_ROLLBACK_RUN_CONTEXT, JSON.stringify(ctx)); }
  if (behavior === 'previous-cleanup-fail') {
    execFileSync(${JSON.stringify(gitBinary)}, ['-C', ctx.candidateRoot, 'worktree', 'add', '--detach', join(args[2], 'previous'), ctx.expectedRef]);
  } else {
    await mkdir(join(args[2], 'previous'));
    await writeFile(join(args[2], 'previous', 'package.json'), '{"type":"module"}');
    await writeFile(join(args[2], 'previous', 'bun.lock'), 'fixed fixture lock\\n');
  }
  for (const name of ['preparation-diagnostics.json', 'previous-release.json', 'previous-identity.json', 'api-image-verification.json']) {
    if (behavior === 'metadata-missing' && name === 'api-image-verification.json') continue;
    await writeFile(join(args[2], name), JSON.stringify({ fixture: name }));
  }
  process.exit(0);
}
assert.equal(args[1], 'scripts/check-schema-rollback.ts');
const helper = await import(pathToFileURL(join(ctx.candidateRoot, 'scripts/schema-rollback-candidate.mjs')).href);
await helper.verifyCandidate(await helper.loadCandidateContext(process.env.SCHEMA_ROLLBACK_RUN_CONTEXT));
await record({ stage: 'check', candidateRoot: ctx.candidateRoot, source: await readFile(join(ctx.candidateRoot, 'source.mjs'), 'utf8'), runId: ctx.runId });
if (behavior === 'check-fail') process.exit(23);
const phase = { runId: ctx.runId, ref: ctx.expectedRef, tree: ctx.expectedTree };
const staged = { format: 2, targetRef: ctx.expectedRef, candidatePhases: { expand: phase, verify: phase },
  candidateExecution: { format: 1, mode: 'private-fixed-commit', runId: ctx.runId, expectedRef: ctx.expectedRef, actualRef: ctx.expectedRef,
    expectedTree: ctx.expectedTree, finalTree: ctx.expectedTree, lockfileSha256: ctx.lockfileSha256, runtime: ctx.runtime },
  cleanup: ['previous-probe', 'test-database', 'admin-connection', 'temporary-home'].map(name => ({ name, status: 'passed' })) };
if (behavior === 'bad-phase') staged.candidatePhases.expand = { ...phase, runId: '12345678-1234-4234-8234-123456789abc' };
if (behavior === 'bad-inner-cleanup') staged.cleanup[1].status = 'failed';
await writeFile(args[4], JSON.stringify(staged), { flag: 'wx' });
if (behavior === 'staging-after-failure') process.exit(27);
if (behavior === 'metadata-race') await writeFile(join(ctx.artifactRoot, 'previous-release.json'), 'competing metadata', { flag: 'wx' });
if (behavior === 'final-dirty') await writeFile(join(ctx.candidateRoot, 'source.mjs'), 'changed after checker\\n');
if (behavior === 'evidence-race') await writeFile(join(ctx.artifactRoot, 'rollback-evidence.json'), 'competitor content', { flag: 'wx' });
`, { mode: 0o755 });
  await writeFile(join(bin, 'git'), `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (${JSON.stringify(behavior)} === 'clone-fail' && args.includes('clone')) process.exit(25);
if (${JSON.stringify(behavior)} === 'previous-cleanup-fail' && args.includes('worktree') && args.includes('remove')) process.exit(26);
const child = spawnSync(${JSON.stringify(gitBinary)}, args, { stdio: 'inherit' });
process.exit(child.status ?? 1);
`, { mode: 0o755 });
  const env = { ...process.env, GH_TOKEN: 'fixture-query-token', PATH: `${bin}:${process.env.PATH}`, NODE_PATH: join(source, 'node_modules'),
    NODE_OPTIONS: '--no-warnings', GIT_DIR: '/must-not-be-used', GIT_INDEX_FILE: '/must-not-be-used-index', npm_config_registry: 'https://invalid.invalid' };
  const args = ['--source-repo', source, '--candidate-ref', ref, '--artifacts', artifacts];
  const run = (overrides = {}) => new Promise((accept, reject) => {
    const child = spawn(process.execPath, [launcher, ...args], { cwd: bootstrap, env, ...overrides });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
    child.once('error', reject); child.once('close', status => accept({ status, stdout, stderr }));
  });
  return { base, source, artifacts, launcher, bootstrap, records, ref, tree, run, env, args };
}
async function diagnostics(f) { return JSON.parse(await readFile(join(f.artifacts, 'launcher-diagnostics.json'), 'utf8')); }
async function records(f) { return (await Promise.all((await readdir(f.records)).map(name => readFile(join(f.records, name), 'utf8')))).flatMap(text => text.trim().split('\n').map(JSON.parse)); }
async function checkFailure(f, result) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(await present(join(f.artifacts, 'rollback-evidence.json')), false);
  const diagnostic = await diagnostics(f);
  assert.equal(diagnostic.status, 'failed');
  assert.deepEqual(diagnostic.cleanup.map(item => item.name), ['previous-input', 'candidate-checkout', 'staged-result', 'run-root']);
  return diagnostic;
}

test('exported standard-library launcher executes fixed private clone, separate full installs, and publishes only after cleanup', async t => {
  const f = await fixture(t), before = git(f.source, 'status', '--porcelain=v1'), result = await f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(f.source, 'status', '--porcelain=v1'), before);
  assert.equal(git(f.source, 'rev-parse', 'HEAD'), f.ref);
  const evidence = JSON.parse(await readFile(join(f.artifacts, 'rollback-evidence.json'), 'utf8'));
  assert.equal(evidence.targetRef, f.ref); assert.equal(evidence.candidateExecution.finalTree, f.tree);
  assert.deepEqual(evidence.candidateExecution.cleanup.map(item => item.status), ['passed', 'passed', 'passed', 'passed']);
  const diagnostic = await diagnostics(f); assert.equal(diagnostic.status, 'passed');
  assert.equal(await present(diagnostic.runRoot), false);
  assert.equal(await present(join(f.artifacts, 'rollback-staged-result.json')), false);
  const events = await records(f); assert.deepEqual(events.map(event => event.stage), ['candidate-install', 'prepare', 'previous-install', 'check']);
  assert.notEqual(events[0].home, events[2].home);
  for (const event of events) assert.notEqual(event.cwd ?? event.candidateRoot, f.source);
  for (const name of ['previous-release.json', 'previous-identity.json', 'api-image-verification.json']) assert.equal(await present(join(f.artifacts, name)), true);
  assert.equal(await present(join(f.source, 'ci-schema')), false);
});

for (const behavior of ['shared-dirty', 'shared-head']) {
  test(`asynchronous ${behavior} preserves fixed actual candidate bytes and leaves shared changes intact`, async t => {
    const f = await fixture(t, behavior), result = await f.run();
    assert.equal(result.status, 0, result.stderr);
    const events = await records(f), check = events.find(event => event.stage === 'check');
    assert.equal(check.source, 'export const marker = "S";\n');
    assert.match(await readFile(join(f.source, 'source.mjs'), 'utf8'), /shared changed/);
    if (behavior === 'shared-head') assert.notEqual(git(f.source, 'rev-parse', 'HEAD'), f.ref);
    const evidence = JSON.parse(await readFile(join(f.artifacts, 'rollback-evidence.json'), 'utf8'));
    assert.equal(evidence.targetRef, f.ref);
  });
}
for (const behavior of ['wrong-bun', 'clone-fail', 'candidate-install-fail', 'prepare-fail', 'previous-install-fail', 'check-fail', 'private-dirty', 'context-replaced', 'final-dirty', 'bad-phase', 'bad-inner-cleanup', 'metadata-missing']) {
  test(`${behavior} refuses final evidence and completes independent resource cleanup`, async t => {
    const f = await fixture(t, behavior), result = await f.run(), diagnostic = await checkFailure(f, result);
    assert.equal(diagnostic.cleanup.every(item => item.status === 'passed'), true, JSON.stringify(diagnostic));
    assert.equal(await present(diagnostic.runRoot), false);
    assert.equal(git(f.source, 'rev-parse', 'HEAD'), f.ref);
  });
}

test('previous worktree cleanup failure is recorded, other cleanup runs, and failed run root is retained', async t => {
  const f = await fixture(t, 'previous-cleanup-fail'), result = await f.run(), diagnostic = await checkFailure(f, result);
  t.after(() => rm(diagnostic.runRoot, { recursive: true, force: true }));
  assert.deepEqual(diagnostic.cleanup.map(item => item.status), ['failed', 'passed', 'passed', 'failed']);
  assert.equal(await present(diagnostic.runRoot), true);
  assert.equal(git(f.source, 'worktree', 'list', '--porcelain').includes(diagnostic.runRoot), false);
});

for (const [cleanupName, suffix] of [['candidate-checkout', '/candidate'], ['staged-result', '/rollback-staged-result.json'], ['run-root', null]]) {
  test(`${cleanupName} filesystem failure blocks publication while still attempting all four cleanups`, async t => {
    const f = await fixture(t);
    const driver = join(f.bootstrap, 'fault-driver.mjs');
    // Fault injection is entirely in this test subprocess's standard library;
    // the production launcher has no bypass flag or injected cleanup callback.
    await writeFile(driver, `import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      const original = fs.rm;
      fs.rm = async (path, options) => {
        if (${suffix === null ? '/\\/schema-rollback-[a-f0-9-]+$/.test(String(path))' : `String(path).endsWith(${JSON.stringify(suffix)})`}) throw new Error('injected ${cleanupName} filesystem error');
        return original(path, options);
      };
      syncBuiltinESMExports();
      const { runSchemaRollback } = await import(${JSON.stringify(pathToFileURL(f.launcher).href)});
      try { await runSchemaRollback(${JSON.stringify({ sourceRepo: f.source, candidateRef: f.ref, artifacts: f.artifacts })}); }
      catch (error) { console.error(String(error)); process.exitCode = 1; }
    `);
    const fault = await new Promise((accept, reject) => {
      const child = spawn(process.execPath, [driver], { cwd: f.bootstrap, env: f.env });
      let stderr = ''; child.stderr.on('data', bytes => stderr += bytes); child.once('error', reject); child.once('close', status => accept({ status, stderr }));
    });
    const diagnostic = await checkFailure(f, fault);
    if (await present(diagnostic.runRoot)) t.after(() => rm(diagnostic.runRoot, { recursive: true, force: true }));
    assert.equal(diagnostic.cleanup.find(item => item.name === cleanupName).status, 'failed');
    assert.equal(diagnostic.cleanup.length, 4);
  });
}

test('another writer winning final wx publication keeps its bytes and marks this run failed', async t => {
  const f = await fixture(t, 'evidence-race'), result = await f.run();
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(join(f.artifacts, 'rollback-evidence.json'), 'utf8'), 'competitor content');
  assert.equal((await diagnostics(f)).status, 'failed');
});

test('fresh-only preflight preserves existing input/outputs and symlink aliases byte for byte', async t => {
  const f = await fixture(t);
  await mkdir(f.artifacts); await writeFile(join(f.artifacts, 'keep'), 'caller bytes');
  const result = await f.run(); assert.notEqual(result.status, 0); assert.equal(result.stdout, '');
  assert.deepEqual(await readdir(f.artifacts), ['keep']); assert.equal(await readFile(join(f.artifacts, 'keep'), 'utf8'), 'caller bytes');
  const alias = join(f.base, 'source-alias'); await symlink(f.source, alias);
  f.args[5] = join(alias, 'output');
  const collision = await f.run(); assert.notEqual(collision.status, 0); assert.equal(collision.stdout, '');
  assert.equal(await present(join(f.source, 'output')), false);
  assert.equal(git(f.source, 'status', '--porcelain=v1'), '');
});

test('artifact symlink parent outside source rejects before creating any output', async t => {
  const f = await fixture(t), external = join(f.base, 'external'), alias = join(f.base, 'external-alias');
  await mkdir(external); await writeFile(join(external, 'keep'), 'preserve me'); await symlink(external, alias);
  f.args[5] = join(alias, 'new-artifacts');
  const result = await f.run();
  assert.notEqual(result.status, 0); assert.equal(result.stdout, ''); assert.match(result.stderr, /component is a symlink/);
  assert.deepEqual(await readdir(external), ['keep']); assert.equal(await readFile(join(external, 'keep'), 'utf8'), 'preserve me');
  assert.equal(git(f.source, 'status', '--porcelain=v1'), '');
});

test('a detached PR merge commit absent from every branch is cloned by its exact object identity', async t => {
  const f = await fixture(t), branch = git(f.source, 'symbolic-ref', 'HEAD'), original = f.ref;
  await writeFile(join(f.source, 'merge-fixture'), 'synthetic detached merge content');
  git(f.source, 'add', '.'); git(f.source, 'commit', '-qm', 'detached PR merge fixture');
  const ref = git(f.source, 'rev-parse', 'HEAD');
  git(f.source, 'checkout', '--detach', ref); git(f.source, 'update-ref', branch, original);
  assert.equal(git(f.source, 'for-each-ref', '--contains', ref), '');
  const beforeRefs = git(f.source, 'show-ref');
  f.args[3] = ref;
  const result = await f.run(); assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(await readFile(join(f.artifacts, 'rollback-evidence.json'), 'utf8'));
  assert.equal(evidence.targetRef, ref); assert.equal(git(f.source, 'rev-parse', 'HEAD'), ref);
  assert.equal(git(f.source, 'show-ref'), beforeRefs);
});

test('nonzero checker leaving staging reports failed staged cleanup and preserves unowned bytes', async t => {
  const f = await fixture(t, 'staging-after-failure'), diagnostic = await checkFailure(f, await f.run());
  assert.equal(diagnostic.cleanup.find(item => item.name === 'staged-result').status, 'failed');
  assert.equal(await present(join(f.artifacts, 'rollback-staged-result.json')), true);
});

test('metadata copy collision preserves competing content and blocks final publication', async t => {
  const f = await fixture(t, 'metadata-race');
  await checkFailure(f, await f.run());
  assert.equal(await readFile(join(f.artifacts, 'previous-release.json'), 'utf8'), 'competing metadata');
});

test('two concurrent runs at the same S have distinct clones, run IDs, installation homes and artifacts', async t => {
  const f = await fixture(t), secondArtifacts = join(f.base, 'artifacts-two');
  const secondArgs = [...f.args]; secondArgs[5] = secondArtifacts;
  const second = new Promise((accept, reject) => {
    const child = spawn(process.execPath, [f.launcher, ...secondArgs], { cwd: f.bootstrap, env: f.env });
    let stderr = ''; child.stderr.on('data', bytes => stderr += bytes); child.once('error', reject); child.once('close', status => accept({ status, stderr }));
  });
  const results = await Promise.all([f.run(), second]);
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  const evidence = await Promise.all([f.artifacts, secondArtifacts].map(async root => JSON.parse(await readFile(join(root, 'rollback-evidence.json'), 'utf8'))));
  assert.notEqual(evidence[0].candidateExecution.runId, evidence[1].candidateExecution.runId);
  assert.equal(evidence[0].targetRef, evidence[1].targetRef);
  const events = (await records(f)).filter(event => event.stage === 'candidate-install');
  assert.equal(events.length, 2); assert.notEqual(events[0].cwd, events[1].cwd); assert.notEqual(events[0].home, events[1].home);
});
