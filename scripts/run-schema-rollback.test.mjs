import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rollbackPolicy } from './platform-rollback-policy.mjs';
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
if (${JSON.stringify(behavior)} === 'fetch-fail' && args.includes('fetch')) process.exit(28);
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
for (const behavior of ['wrong-bun', 'clone-fail', 'fetch-fail', 'candidate-install-fail', 'prepare-fail', 'previous-install-fail', 'check-fail', 'private-dirty', 'context-replaced', 'final-dirty', 'bad-phase', 'bad-inner-cleanup', 'metadata-missing']) {
  test(`${behavior} refuses final evidence and completes independent resource cleanup`, async t => {
    const f = await fixture(t, behavior), sourceRefs = git(f.source, 'show-ref'), sourceIndex = await readFile(join(f.source, '.git', 'index'));
    const result = await f.run(), diagnostic = await checkFailure(f, result);
    assert.equal(git(f.source, 'show-ref'), sourceRefs);
    assert.deepEqual(await readFile(join(f.source, '.git', 'index')), sourceIndex);
    if (behavior === 'fetch-fail') {
      assert.equal((await readdir(f.records)).length, 0, 'Fetch failure must not fall back to install or execution');
      assert.match(diagnostic.error, /fetch/);
    }
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

// Complete evidence fields let publication tests ask the real consumer whether
// any failed launcher left behind a usable success declaration. Bun/PG remain
// controlled tools here; this proves the publication boundary, not PG support.
const digest = value => createHash('sha256').update(value).digest('hex');
const publicationSchema = { expandLevel: 3, contractLevel: 0 };
const publicationDataSchema = digest(JSON.stringify({ format: 1, ...publicationSchema }));
async function consumableFixture(t) {
  const f = await fixture(t), origin = 'https://github.com/moesin-lab/Remi';
  const previousRelease = { version: '1.1.9', dataSchema: 'b'.repeat(64), ref: 'e'.repeat(40), sourceSha256: 'f'.repeat(64),
    releaseUrl: `${origin}/releases/tag/v1.1.9`, manifestUrl: `${origin}/releases/download/v1.1.9/platform-release.json`,
    sourceUrl: `${origin}/releases/download/v1.1.9/platform-systemd-v1.1.9.tar.gz`,
    apiImage: `ghcr.io/moesin-lab/remi-api@sha256:${'a'.repeat(64)}` };
  const previousManifest = JSON.stringify(previousRelease, null, 2) + '\n';
  const extra = { dataSchema: publicationDataSchema, previousRelease, previousManifest,
    previousIdentity: { format: 1, mode: 'published-archive', publishedRef: previousRelease.ref,
      actualPreviousRef: previousRelease.ref, observedTagRef: 'b'.repeat(40), tagDrift: true,
      sourceTree: 'c'.repeat(40), sourceSha256: previousRelease.sourceSha256, manifestSha256: digest(previousManifest),
      manifestAssetId: 11, sourceAssetId: 12, releaseId: 13,
      provenance: { model: 'verified-api-image+github-publish-log+exact-git-tree', sourceArchiveAttestation: false,
        apiImage: previousRelease.apiImage, runId: '101', attempt: 2, jobId: 201,
        invocation: `${origin}/actions/runs/101/attempts/2`, jobUrl: `${origin}/actions/runs/101/job/201`,
        publishLogSha256: 'd'.repeat(64), verificationSha256: 'e'.repeat(64) } },
    schema: publicationSchema, schemaVerification: publicationSchema,
    phases: ['previous-before-expand', 'candidate-expand', 'previous-after-expand', 'verify-schema-levels']
      .map(name => ({ name, status: 'passed', exitCode: 0, signalCode: null,
        stdout: `rollback-logs/${name}.stdout.log`, stderr: `rollback-logs/${name}.stderr.log` })),
    probes: { before: { probe: 'previous-release-core', pass: true, task: 'before-task', cancelled: 'before-cancelled' },
      after: { probe: 'previous-release-core', pass: true, task: 'after-task', cancelled: 'after-cancelled' } },
    checks: ['previous-startup', 'previous-create-start-complete-cancel', 'candidate-expand-startup', 'previous-startup-after-expand', 'previous-create-start-complete-cancel-after-expand'],
    rollbackSafeFrom: [previousRelease.dataSchema] };
  const bunPath = join(f.base, 'bin', 'bun'), bun = await readFile(bunPath, 'utf8');
  await writeFile(bunPath, bun.replace('const staged = { format: 2,', `const staged = { ...${JSON.stringify(extra)}, format: 2,`));
  return f;
}
function consumerAccepts(f, bytes) {
  try { return rollbackPolicy({ version: '1.2.0', ref: f.ref, dataSchema: publicationDataSchema }, undefined, JSON.parse(bytes)).length === 1; }
  catch { return false; }
}
async function publicationFault(f, mode) {
  const driver = join(f.bootstrap, 'publication-fault-driver.mjs'), eventPath = join(f.base, 'publication-events.json');
  await writeFile(driver, `import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const mode = ${JSON.stringify(mode)}, events = [], root = ${JSON.stringify(f.artifacts)};
    const originalOpen = fs.open, originalWriteFile = fs.writeFile;
    let lastDiagnostic, closedDiagnostics = false, finalOpened = false, diagnosticCloseFaulted = false;
    let diagnosticOpens = 0, firstInjectedError;
    const snapshotMode = mode.startsWith('snapshot-');
    const inject = label => { const error = fault(label); firstInjectedError ??= error; return error; };
    const fault = label => Object.assign(new Error('injected ' + label), { code: 'EIO' });
    const finishing = async () => {
      if (!lastDiagnostic?.runRoot) return false;
      try { await fs.lstat(lastDiagnostic.runRoot); return false; }
      catch (error) { if (error.code === 'ENOENT') return true; throw error; }
    };
    const replaceFinal = async path => {
      await fs.rename(path, ${JSON.stringify(join(f.base, 'displaced-owned-final.json'))});
      if (mode.endsWith('symlink')) {
        await originalWriteFile(${JSON.stringify(join(f.base, 'competitor-target'))}, 'competitor target bytes');
        await fs.symlink(${JSON.stringify(join(f.base, 'competitor-target'))}, path);
      } else await originalWriteFile(path, 'competing final writer bytes', { flag: 'wx' });
    };
    fs.writeFile = async (path, data, options) => {
      if (String(path).endsWith('/rollback-evidence.json')) {
        events.push('final-writeFile');
        if (mode === 'final-partial-write') { await originalWriteFile(path, String(data).slice(0, 120), options); throw fault(mode); }
      }
      return originalWriteFile(path, data, options);
    };
    fs.open = async (...args) => {
      const path = String(args[0]);
      if (path.endsWith('/rollback-evidence.json')) {
        events.push('final-open'); finalOpened = true;
        if (mode === 'final-open-race') await originalWriteFile(path, 'competing final writer bytes', { flag: 'wx' });
      }
      const handle = await originalOpen(...args);
      if (path.endsWith('/launcher-diagnostics.json')) {
        const truncate = handle.truncate.bind(handle), write = handle.write.bind(handle), close = handle.close.bind(handle);
        const ordinal = ++diagnosticOpens;
        let snapshot = 0, writes = 0, snapshotBuffer, snapshotCloseFaulted = false;
        handle.truncate = async (...params) => {
          snapshot++; writes = 0; snapshotBuffer = undefined;
          if (await finishing()) { events.push('diagnostic-final-truncate'); if (mode === 'diagnostic-truncate') throw fault(mode); }
          if (finalOpened && mode === 'no-post-publication-io') throw fault('diagnostic truncate after final open');
          return truncate(...params);
        };
        handle.write = async (data, ...params) => {
          try { lastDiagnostic = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : data); } catch {}
          const buffered = Buffer.isBuffer(data), bytes = buffered ? data : Buffer.from(data, 'utf8');
          const offset = buffered ? params[0] : 0, length = buffered ? params[1] : bytes.length;
          const position = buffered ? params[2] : params[0];
          writes++;
          if (snapshotMode && writes > 12) throw new Error('test guard: diagnostic write made no progress');
          if (snapshotMode && buffered) {
            if (snapshotBuffer && snapshotBuffer !== data) throw new Error('snapshot was serialized more than once');
            snapshotBuffer = data;
          }
          const prefix = async count => {
            const result = count === 0 ? { bytesWritten: 0, buffer: data } : await write(bytes, offset, Math.min(count, length), position);
            if (snapshotMode) events.push({ kind: 'diagnostic-write', ordinal, snapshot, buffered, offset, length, position,
              bytesWritten: result.bytesWritten, splitUtf8: (bytes[offset + result.bytesWritten] & 0xc0) === 0x80 });
            return result;
          };
          if (await finishing()) {
            events.push('diagnostic-final-write');
            if (mode === 'diagnostic-partial-write') {
              await prefix(30); events.push('diagnostic-prefix-written'); throw fault(mode);
            }
          }
          if (finalOpened && mode === 'no-post-publication-io') throw fault('diagnostic write after final open');
          if (snapshotMode) {
            if (ordinal === 1 && snapshot === 1) {
              if (mode === 'snapshot-first-zero') return prefix(0);
              if (mode === 'snapshot-short-zero') return prefix(writes === 1 ? 7 : 0);
              if (mode === 'snapshot-first-throw' || mode === 'snapshot-save-close-recovery-short') throw inject('save first fault');
              if (mode === 'snapshot-short-throw' || mode === 'snapshot-save-close-recovery-throw') {
                if (writes === 1) return prefix(7);
                throw inject('save after-prefix fault');
              }
            }
            if (ordinal > 1 && mode.endsWith('recovery-throw')) throw inject('recovery later fault');
            if ((mode === 'snapshot-short-once' || (ordinal > 1 && mode.endsWith('recovery-short'))) && writes === 1) return prefix(7);
            if (mode === 'snapshot-short-many' && writes <= 5) {
              const firstUtf8 = bytes.findIndex(byte => byte >= 0x80);
              if (firstUtf8 < 0) throw new Error('UTF8 fixture contains no multibyte bytes');
              return prefix(writes === 1 ? firstUtf8 + 1 : writes < 4 ? 1 : 3);
            }
            return prefix(length);
          }
          return write(data, ...params);
        };
        handle.close = async () => {
          events.push('diagnostic-close');
          if (snapshotMode) events.push({ kind: 'diagnostic-close', ordinal });
          if (snapshotMode && ordinal === 1 && mode.includes('-close-') && !snapshotCloseFaulted) {
            snapshotCloseFaulted = true;
            if (mode !== 'snapshot-save-close-recovery-throw') { await close(); closedDiagnostics = true; }
            throw inject('close later fault');
          }
          if (finalOpened && mode === 'no-post-publication-io') throw fault('diagnostic close after final open');
          await close(); closedDiagnostics = true;
          if (mode === 'diagnostic-close' && !diagnosticCloseFaulted) { diagnosticCloseFaulted = true; throw fault(mode); }
        };
        if (mode === 'diagnostic-replacement' && closedDiagnostics) events.push('diagnostic-reopened');
      }
      if (path.endsWith('/rollback-evidence.json')) {
        const writeFile = handle.writeFile.bind(handle), close = handle.close.bind(handle);
        handle.writeFile = async (...params) => {
          events.push('final-handle-write');
          if (mode === 'final-replace-after-write') { await writeFile(...params); await replaceFinal(path); return; }
          if (mode.startsWith('final-partial') || mode.startsWith('final-write-replace')) {
            await writeFile(String(params[0]).slice(0, 120));
            if (mode.startsWith('final-write-replace')) await replaceFinal(path);
            if (mode === 'final-write-replace-diagnostic') {
              const diagnostic = root + '/launcher-diagnostics.json';
              await fs.rename(diagnostic, ${JSON.stringify(join(f.base, 'displaced-owned-diagnostic.json'))});
              await originalWriteFile(diagnostic, 'competing diagnostic writer bytes', { flag: 'wx' });
            }
            throw fault(mode);
          }
          return writeFile(...params);
        };
        let closeFaulted = false;
        handle.close = async () => {
          events.push('final-handle-close');
          if (mode === 'final-replace-after-close' && !closeFaulted) { closeFaulted = true; await close(); await replaceFinal(path); return; }
          if (mode.startsWith('final-close') && !closeFaulted) {
            closeFaulted = true;
            if (mode === 'final-close-replace') await replaceFinal(path);
            if (mode !== 'final-close-before') await close();
            throw fault(mode);
          }
          return close();
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    const { runSchemaRollback } = await import(${JSON.stringify(pathToFileURL(f.launcher).href)});
    let preservedFirstError = true;
    try { await runSchemaRollback(${JSON.stringify({ sourceRepo: f.source, candidateRef: f.ref, artifacts: f.artifacts })}); }
    catch (error) { preservedFirstError = !firstInjectedError || error === firstInjectedError; console.error(String(error)); process.exitCode = 1; }
    await originalWriteFile(${JSON.stringify(eventPath)}, JSON.stringify({ events, lastDiagnostic, preservedFirstError }));
  `);
  const result = await new Promise((accept, reject) => {
    const child = spawn(process.execPath, [driver], { cwd: f.bootstrap, env: f.env });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
    child.once('error', reject); child.once('close', status => accept({ status, stdout, stderr }));
  });
  return { ...result, ...JSON.parse(await readFile(eventPath, 'utf8')) };
}

test('successful publication is consumer-valid and follows all required diagnostic writes and close', async t => {
  const f = await consumableFixture(t), result = await publicationFault(f, 'no-post-publication-io');
  assert.equal(result.status, 0, result.stderr);
  const bytes = await readFile(join(f.artifacts, 'rollback-evidence.json'), 'utf8');
  assert.equal(consumerAccepts(f, bytes), true);
  assert(result.events.indexOf('diagnostic-close') < result.events.indexOf('final-open'), JSON.stringify(result.events));
});
for (const mode of ['diagnostic-truncate', 'diagnostic-partial-write', 'diagnostic-close', 'final-partial-write', 'final-close-before', 'final-close-after']) {
  test(`${mode} leaves no final success file or partial publication`, async t => {
    const f = await consumableFixture(t), result = await publicationFault(f, mode);
    assert.notEqual(result.status, 0, result.stdout); assert.match(result.stderr, /injected/);
    if (mode === 'diagnostic-partial-write') {
      assert(result.events.includes('diagnostic-prefix-written'));
      assert.doesNotMatch(result.stderr, /TypeError/);
    }
    assert.equal(await present(join(f.artifacts, 'rollback-evidence.json')), false, JSON.stringify(result.events));
    if (mode.startsWith('diagnostic-')) assert.equal(result.events.includes('final-open'), false, JSON.stringify(result.events));
    if (!mode.startsWith('diagnostic-') || mode === 'diagnostic-close') assert.equal((await diagnostics(f)).status, 'failed');
  });
}
for (const mode of ['final-open-race', 'final-write-replace', 'final-write-replace-symlink', 'final-close-replace', 'final-write-replace-diagnostic', 'final-replace-after-write', 'final-replace-after-close']) {
  test(`${mode} preserves competing writer ownership during failed publication recovery`, async t => {
    const f = await consumableFixture(t), result = await publicationFault(f, mode);
    assert.notEqual(result.status, 0, result.stdout);
    const bytes = await readFile(join(f.artifacts, 'rollback-evidence.json'), 'utf8');
    assert.equal(bytes, mode.endsWith('symlink') ? 'competitor target bytes' : 'competing final writer bytes');
    assert.equal(consumerAccepts(f, bytes), false);
    if (mode.endsWith('symlink')) assert.equal((await lstat(join(f.artifacts, 'rollback-evidence.json'))).isSymbolicLink(), true);
    if (mode.endsWith('diagnostic')) assert.equal(await readFile(join(f.artifacts, 'launcher-diagnostics.json'), 'utf8'), 'competing diagnostic writer bytes');
    else assert.equal((await diagnostics(f)).status, 'failed');
  });
}

// Six diagnostic snapshot groups: full UTF8, one short write, repeated short
// writes, zero progress, throwing writes, and combined save/close/recovery faults.
const snapshotCases = [
  ['UTF8 complete diagnostic snapshot', 'snapshot-utf8-full', true],
  ['one short write then completion on every snapshot', 'snapshot-short-once', true],
  ['repeated short writes across UTF8 byte boundaries', 'snapshot-short-many', true],
  ['first write returns zero', 'snapshot-first-zero', false],
  ['short write followed by zero', 'snapshot-short-zero', false],
  ['first write throws', 'snapshot-first-throw', false],
  ['short write followed by throw', 'snapshot-short-throw', false],
  ['save and close fail but recovery completes short writes', 'snapshot-save-close-recovery-short', false],
  ['save, close and recovery all fail', 'snapshot-save-close-recovery-throw', false],
  ['close and recovery fail after complete save', 'snapshot-close-recovery-throw', false],
];
for (const [name, mode, success] of snapshotCases) {
  test(`diagnostic snapshot: ${name}`, async t => {
    const f = await consumableFixture(t), unicodeTemp = join(f.base, '临时🌱');
    await mkdir(unicodeTemp, { mode: 0o700 }); f.env.TMPDIR = unicodeTemp;
    const result = await publicationFault(f, mode);
    const writes = result.events.filter(event => event?.kind === 'diagnostic-write');
    const firstWrites = writes.filter(event => event.ordinal === 1 && event.snapshot === 1);
    assert.equal(result.preservedFirstError, true, result.stderr);
    assert.doesNotMatch(result.stderr, /TypeError|test guard/);
    if (success) {
      assert.equal(result.status, 0, result.stderr);
      const bytes = await readFile(join(f.artifacts, 'launcher-diagnostics.json'));
      const diagnostic = JSON.parse(bytes.toString('utf8'));
      assert.equal(diagnostic.status, 'passed'); assert.match(diagnostic.runRoot, /临时🌱/);
      assert.deepEqual(bytes, Buffer.from(JSON.stringify(result.lastDiagnostic, null, 2) + '\n', 'utf8'));
      assert.equal(consumerAccepts(f, await readFile(join(f.artifacts, 'rollback-evidence.json'), 'utf8')), true);
      const snapshots = Map.groupBy(writes, event => `${event.ordinal}:${event.snapshot}`);
      assert(snapshots.size >= 6, 'Every reused-handle snapshot must reset its position');
      for (const calls of snapshots.values()) {
        let completed = 0;
        for (const call of calls) {
          assert.equal(call.buffered, true, 'Serialize one UTF8 Buffer per snapshot');
          assert.equal(call.offset, completed); assert.equal(call.position, completed);
          assert.equal(call.length, calls[0].length - completed);
          assert(call.bytesWritten > 0 && call.bytesWritten <= call.length);
          completed += call.bytesWritten;
        }
        assert.equal(completed, calls[0].length);
        assert.equal(calls.length, mode === 'snapshot-short-many' ? 6 : mode === 'snapshot-short-once' ? 2 : 1);
      }
      if (mode === 'snapshot-short-many') assert(writes.some(event => event.splitUtf8), 'Must split a multibyte UTF8 character');
    } else {
      assert.notEqual(result.status, 0, result.stdout);
      assert.equal(await present(join(f.artifacts, 'rollback-evidence.json')), false);
      assert.equal(result.events.includes('final-open'), false);
      assert.deepEqual(result.lastDiagnostic.cleanup.map(item => [item.name, item.status]),
        ['previous-input', 'candidate-checkout', 'staged-result', 'run-root'].map(name => [name, 'passed']));
      assert.equal(await present(result.lastDiagnostic.runRoot), false);
      if (mode.endsWith('-zero')) {
        assert.match(result.stderr, /Diagnostic write made invalid progress/);
        assert.equal(firstWrites.length, mode === 'snapshot-first-zero' ? 1 : 2, 'Zero progress must fail immediately');
      } else assert.match(result.stderr, /injected (save|close)/);
      if (mode.includes('-close-')) {
        assert.equal(result.events.filter(event => event?.kind === 'diagnostic-close' && event.ordinal === 1).length, 2);
        assert.match(result.stderr, mode === 'snapshot-close-recovery-throw' ? /injected close later fault/ : /injected save/);
        assert.doesNotMatch(result.stderr, /recovery later fault/);
      }
      if (mode.endsWith('recovery-short')) {
        assert.equal(writes.filter(event => event.ordinal === 2).length, 2, 'Recovery must finish its own short write');
        const diagnostic = await diagnostics(f);
        assert.equal(diagnostic.status, 'failed'); assert.match(diagnostic.error, /injected save first fault/);
        assert.deepEqual(await readFile(join(f.artifacts, 'launcher-diagnostics.json')),
          Buffer.from(JSON.stringify(result.lastDiagnostic, null, 2) + '\n', 'utf8'));
      }
    }
  });
}

test('selected detached S is explicitly transported after shared HEAD moves away immediately before clone', async t => {
  const f = await fixture(t), branch = git(f.source, 'symbolic-ref', 'HEAD');
  await writeFile(join(f.source, 'detached-only'), 'candidate S, no branch');
  await writeFile(join(f.source, 'source.mjs'), 'export const marker = "selected detached S";\n');
  git(f.source, 'add', '.'); git(f.source, 'commit', '-qm', 'detached S');
  const selected = git(f.source, 'rev-parse', 'HEAD'), selectedTree = git(f.source, 'rev-parse', 'HEAD^{tree}');
  git(f.source, 'checkout', '--detach', selected); git(f.source, 'update-ref', branch, f.ref);
  assert.equal(git(f.source, 'for-each-ref', '--contains', selected), '');
  const refsBefore = git(f.source, 'show-ref'), indexBefore = await readFile(join(f.source, '.git', 'index'));
  const wrapperPath = join(f.base, 'bin', 'git'), wrapper = await readFile(wrapperPath, 'utf8');
  await writeFile(wrapperPath, wrapper.replace('const child = spawnSync(', `
    if (args.includes('clone')) {
      // This call occurs after the launcher read S/T. Simulate only the other
      // writer's checkout; leave S in source objects and touch no refs.
      const moved = spawnSync(${JSON.stringify(gitBinary)}, ${JSON.stringify(['-C', f.source, 'checkout', branch.replace('refs/heads/', '')])}, { stdio: 'pipe' });
      if (moved.status !== 0) process.exit(91);
      const advertised = spawnSync(${JSON.stringify(gitBinary)}, ${JSON.stringify(['-C', f.source, 'ls-remote', f.source])}, { encoding: 'utf8' });
      if (advertised.stdout.includes(${JSON.stringify(selected)})) process.exit(92);
    }
    if (args.includes('fetch')) {
      const resolved = spawnSync(${JSON.stringify(gitBinary)}, ${JSON.stringify(['-C', f.source, 'rev-parse', `${selected}^{commit}`])}, { encoding: 'utf8' });
      if (resolved.stdout.trim() !== ${JSON.stringify(selected)}) process.exit(93);
    }
    const child = spawnSync(`));
  f.args[3] = selected;
  const result = await f.run(); assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(await readFile(join(f.artifacts, 'rollback-evidence.json'), 'utf8'));
  assert.equal(evidence.targetRef, selected); assert.equal(evidence.candidateExecution.finalTree, selectedTree);
  assert.equal(git(f.source, 'rev-parse', 'HEAD'), f.ref); assert.equal(git(f.source, 'show-ref'), refsBefore);
  assert.equal(git(f.source, 'rev-parse', `${selected}^{commit}`), selected);
  // The other writer changed its checkout/index to the branch; compare that
  // state to the branch tree rather than to the original detached index.
  assert.equal(git(f.source, 'status', '--porcelain=v1'), '');
  assert.notDeepEqual(await readFile(join(f.source, '.git', 'index')), indexBefore);
  assert.equal((await records(f)).find(event => event.stage === 'check').source, 'export const marker = "selected detached S";\n');
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
