#!/usr/bin/env node
/** Fixed-commit provisioner. Deliberately self-contained: CI exports this file
 * from the requested Git object before running it outside the shared checkout. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const OFFICIAL_ORIGIN = 'https://github.com/moesin-lab/Remi.git';
const METADATA = ['preparation-diagnostics.json', 'previous-release.json', 'previous-identity.json', 'api-image-verification.json'];
const CLEANUPS = ['previous-input', 'candidate-checkout', 'staged-result', 'run-root'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, path) => path === root || path.startsWith(root + sep);
const overlap = (a, b) => inside(a, b) || inside(b, a);

/** No caller Git roots/index/alternates/preloads or user-level tool config. */
export function executionEnvironment(home, temporary, contextPath) {
  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL', 'TZ', 'MULTIREMI_TEST_POSTGRES_URL']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'config'),
    XDG_CACHE_HOME: join(home, 'cache'), BUN_INSTALL_CACHE_DIR: join(home, 'bun-cache'),
    NPM_CONFIG_USERCONFIG: join(home, '.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(home, 'global.npmrc'),
    TMPDIR: temporary, TMP: temporary, TEMP: temporary, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
  if (contextPath) env.SCHEMA_ROLLBACK_RUN_CONTEXT = contextPath;
  return env;
}
function gitEnvironment() {
  const env = executionEnvironment('/nonexistent-schema-rollback-home', tmpdir());
  delete env.GH_TOKEN;
  return env;
}
export function candidateGit(root, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', '-C', root, ...args],
    { env: gitEnvironment(), maxBuffer: 128 * 1024 * 1024 });
}
const gitText = (root, ...args) => candidateGit(root, ...args).toString('utf8').trim();
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function rejectSymlinkComponents(path) {
  let current = path;
  while (true) {
    if (await exists(current)) assert(!(await lstat(current)).isSymbolicLink(), `Artifact path component is a symlink: ${current}`);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
async function realDirectory(path) {
  assert(isAbsolute(path), 'Expected absolute directory');
  assert.equal(await realpath(path), path, `Directory must be canonical: ${path}`);
  assert((await lstat(path)).isDirectory(), `Expected directory: ${path}`);
}
function entries(root, ref) {
  const raw = candidateGit(root, 'ls-tree', '-rz', '--full-tree', ref), text = raw.toString('utf8');
  assert(Buffer.from(text, 'utf8').equals(raw), 'Non-UTF8 source paths are unsupported');
  return text.split('\0').filter(Boolean).map(record => {
    const match = /^(\d{6}) (\w+) ([a-f0-9]{40})\t([\s\S]+)$/.exec(record);
    assert(match, 'Malformed Git tree entry');
    const [, mode, type, oid, path] = match;
    assert(type === 'blob' && ['100644', '100755', '120000'].includes(mode), `Unsupported source type: ${path}`);
    assert(!isAbsolute(path) && path.split('/').every(p => p && p !== '.' && p !== '..' && p !== '.git'), 'Unsafe source path');
    return { mode, oid, path };
  });
}
function workspacePattern(pattern) {
  assert(typeof pattern === 'string' && pattern && !pattern.startsWith('/') &&
    pattern.split('/').every(p => p && p !== '.' && p !== '..') && !/[\\\[\]{}!]/.test(pattern), 'Unsupported workspace pattern');
  return new RegExp('^' + pattern.split('/').map(part => part === '**' ? '.*' : part.split('*').map(s => s.replace(/[.+?^$()|]/g, '\\$&')).join('[^/]*')).join('/') + '$');
}
/** Derived from committed manifests, never from caller-supplied exclusions. */
export function candidateInstallationDirectories(root, ref) {
  assert(SHA.test(ref), 'Expected full candidate SHA');
  const tracked = entries(root, ref);
  const rootManifest = JSON.parse(candidateGit(root, 'show', `${ref}:package.json`).toString('utf8'));
  const workspaces = rootManifest.workspaces?.packages ?? rootManifest.workspaces ?? [];
  assert(Array.isArray(workspaces), 'Invalid workspace declaration');
  const patterns = workspaces.map(workspacePattern);
  const directories = ['node_modules'];
  for (const entry of tracked) {
    if (!entry.path.endsWith('/package.json')) continue;
    const directory = entry.path.slice(0, -'/package.json'.length);
    if (patterns.some(pattern => pattern.test(directory))) directories.push(`${directory}/node_modules`);
  }
  const result = [...new Set(directories)].sort();
  for (const directory of result) assert(!tracked.some(entry => entry.path === directory || entry.path.startsWith(directory + '/')), 'Install directory overlaps tracked source');
  return result;
}

/** Internal shared implementation; public helper additionally binds its module root. */
export async function readCandidateContext(contextPath, root = process.cwd(), moduleRoot) {
  assert(typeof contextPath === 'string' && isAbsolute(contextPath), 'Private run context is required');
  assert.equal(await realpath(contextPath), contextPath, 'Context must be canonical');
  const contextStat = await lstat(contextPath);
  assert(contextStat.isFile() && !contextStat.isSymbolicLink(), 'Expected regular context file');
  const contextBytes = await readFile(contextPath);
  assert.match(process.env.SCHEMA_ROLLBACK_CONTEXT_SHA256 ?? '', /^[a-f0-9]{64}$/, 'Parent context digest is required');
  assert.equal(hash(contextBytes), process.env.SCHEMA_ROLLBACK_CONTEXT_SHA256, 'Private context bytes differ from parent binding');
  const ctx = JSON.parse(contextBytes.toString('utf8'));
  assert.equal(ctx.format, 1, 'Unknown candidate context');
  assert(UUID.test(ctx.runId), 'Invalid runId');
  assert(SHA.test(ctx.expectedRef) && SHA.test(ctx.expectedTree), 'Invalid fixed candidate identity');
  assert(/^[a-f0-9]{64}$/.test(ctx.lockfileSha256), 'Invalid lockfile digest');
  assert.equal(ctx.runtime?.bun, '1.3.14', 'Expected Bun 1.3.14');
  assert.match(ctx.runtime?.node ?? '', /^v22\./, 'Expected Node 22');
  for (const key of ['runRoot', 'candidateRoot', 'artifactRoot']) { assert.equal(typeof ctx[key], 'string'); await realDirectory(ctx[key]); }
  assert.equal(basename(ctx.runRoot), `schema-rollback-${ctx.runId}`, 'Invalid private run layout');
  const runStat = await lstat(ctx.runRoot);
  assert.equal(runStat.mode & 0o777, 0o700, 'Run root must have mode 0700');
  if (process.getuid) assert.equal(runStat.uid, process.getuid(), 'Run root has another owner');
  assert.equal(ctx.candidateRoot, join(ctx.runRoot, 'candidate'), 'Invalid candidate layout');
  assert.equal(contextPath, join(ctx.runRoot, 'control', 'run-context.json'), 'Invalid control layout');
  await realDirectory(join(ctx.runRoot, 'control'));
  assert(!overlap(ctx.runRoot, ctx.artifactRoot), 'Artifacts overlap private execution');
  assert.equal(await realpath(root), ctx.candidateRoot, 'Candidate cwd does not match private context');
  if (moduleRoot) assert.equal(await realpath(moduleRoot), ctx.candidateRoot, 'Candidate entry is outside private root');
  assert.deepEqual(ctx.installationDirectories, candidateInstallationDirectories(ctx.candidateRoot, ctx.expectedRef), 'Install exclusions differ from committed workspaces');
  return ctx;
}

/** Verify actual bytes and inventory. No index, stat-cache, diff or ignore rules
 * participate in the source identity proof. Same-UID malicious writers remain
 * outside the execution model's isolation guarantee. */
export async function verifyCandidate(ctx) {
  assert.equal(await realpath(ctx.candidateRoot), ctx.candidateRoot, 'Candidate root changed');
  const root = ctx.candidateRoot;
  await realDirectory(join(root, '.git'));
  assert.equal(gitText(root, 'rev-parse', '--show-toplevel'), root, 'Unexpected Git root');
  assert.equal(gitText(root, 'rev-parse', '--absolute-git-dir'), join(root, '.git'), 'Git metadata is not independent');
  assert.equal(await realpath(resolve(root, gitText(root, 'rev-parse', '--git-common-dir'))), join(root, '.git'), 'Shared Git common directory');
  assert.equal(gitText(root, 'remote', 'get-url', 'origin'), OFFICIAL_ORIGIN, 'Unexpected candidate origin');
  for (const path of ['objects/info/alternates', 'objects/info/http-alternates', 'commondir']) assert(!await exists(join(root, '.git', path)), 'Git object sharing is forbidden');
  async function independentObjects(directory) {
    for (const name of await readdir(directory)) {
      const path = join(directory, name), stat = await lstat(path);
      assert(!stat.isSymbolicLink(), 'Git object symlink is forbidden');
      if (stat.isDirectory()) await independentObjects(path);
      else assert(stat.isFile() && stat.nlink === 1, 'Git objects must be independently materialized');
    }
  }
  await independentObjects(join(root, '.git', 'objects'));
  assert.equal(gitText(root, 'rev-parse', 'HEAD'), ctx.expectedRef, 'Candidate HEAD changed');
  assert.equal(gitText(root, 'rev-parse', `${ctx.expectedRef}^{tree}`), ctx.expectedTree, 'Candidate tree changed');
  const tracked = entries(root, ctx.expectedRef);
  const expected = new Map(tracked.map(entry => [entry.path, entry]));
  const directorySet = new Set();
  for (const entry of tracked) {
    let parent = dirname(entry.path);
    while (parent !== '.') { directorySet.add(parent); parent = dirname(parent); }
  }
  const installationDirectories = candidateInstallationDirectories(root, ctx.expectedRef);
  assert.deepEqual(ctx.installationDirectories, installationDirectories, 'Unexpected install directories');
  const installRoots = installationDirectories.map(path => join(root, path));
  for (const directory of installationDirectories) {
    let parent = dirname(directory);
    while (parent !== '.') { directorySet.add(parent); parent = dirname(parent); }
  }
  const seen = new Set();
  async function checkDependencies(directory) {
    const stat = await lstat(directory);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Install root must be a real directory');
    async function walk(path) {
      for (const name of await readdir(path)) {
        const child = join(path, name), info = await lstat(child);
        if (info.isSymbolicLink()) {
          const target = await realpath(child);
          assert(inside(root, target) && !inside(join(root, '.git'), target), `Dependency link escapes private candidate: ${child}`);
          assert(installRoots.some(dir => inside(dir, target)) || expected.has(relative(root, target).split(sep).join('/')) || directorySet.has(relative(root, target).split(sep).join('/')),
            `Dependency link has no private source/install target: ${child}`);
        } else if (info.isDirectory()) await walk(child);
        else assert(info.isFile() && info.nlink === 1, `Dependency file is shared or unsupported: ${child}`);
      }
    }
    await walk(directory);
  }
  async function walk(directory, prefix = '') {
    for (const name of await readdir(directory)) {
      if (!prefix && name === '.git') continue;
      const path = join(directory, name), rel = prefix ? `${prefix}/${name}` : name;
      if (installationDirectories.includes(rel)) { await checkDependencies(path); continue; }
      const entry = expected.get(rel), stat = await lstat(path);
      if (!entry) {
        assert(stat.isDirectory() && !stat.isSymbolicLink() && directorySet.has(rel), `Unexpected candidate inventory: ${rel}`);
        await walk(path, rel); continue;
      }
      seen.add(rel);
      let bytes;
      if (entry.mode === '120000') { assert(stat.isSymbolicLink(), `Source symlink type changed: ${rel}`); bytes = await readlink(path, { encoding: 'buffer' }); }
      else {
        assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, `Source file type/sharing changed: ${rel}`);
        // Git records owner-executable, not all permission bits. A checkout
        // under umask 077 legitimately materializes 100755 as mode 0700.
        assert(entry.mode === '100755' ? Boolean(stat.mode & 0o100) : !(stat.mode & 0o111), `Source executable mode changed: ${rel}`);
        bytes = await readFile(path);
      }
      const oid = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      assert.equal(oid, entry.oid, `Source bytes changed: ${rel}`);
      if (entry.mode === '120000') {
        const target = await realpath(path);
        assert(inside(root, target) && !inside(join(root, '.git'), target), `Source symlink escapes candidate: ${rel}`);
      }
    }
  }
  await walk(root);
  assert.equal(seen.size, tracked.length, 'Tracked source is missing');
  assert.equal(hash(await readFile(join(root, 'bun.lock'))), ctx.lockfileSha256, 'Lockfile changed');
  assert.equal(gitText(root, 'rev-parse', 'HEAD'), ctx.expectedRef, 'Candidate HEAD changed during verification');
  return { runId: ctx.runId, ref: ctx.expectedRef, tree: ctx.expectedTree };
}

async function command(command, args, cwd, env, logfile) {
  const log = await open(logfile, 'wx', 0o600);
  try {
    await new Promise((accept, reject) => {
      const child = spawn(command, args, { cwd, env, stdio: ['ignore', log.fd, log.fd] });
      child.once('error', reject);
      child.once('close', (code, signal) => code === 0 ? accept() : reject(new Error(`${basename(command)} ${args[0] ?? ''} failed (${signal ?? code}); see ${basename(logfile)}`)));
    });
  } finally { await log.close(); }
}
function validateStaged(evidence, ctx) {
  assert.equal(evidence.format, 2, 'Expected format2 staged evidence');
  assert.equal(evidence.targetRef, ctx.expectedRef, 'Staged evidence target differs');
  const execution = evidence.candidateExecution;
  assert(execution && execution.format === 1 && execution.mode === 'private-fixed-commit', 'Invalid staged candidate execution');
  for (const [key, value] of Object.entries({ runId: ctx.runId, expectedRef: ctx.expectedRef, actualRef: ctx.expectedRef,
    expectedTree: ctx.expectedTree, finalTree: ctx.expectedTree, lockfileSha256: ctx.lockfileSha256 })) assert.equal(execution[key], value, `Staged ${key} differs`);
  assert.deepEqual(execution.runtime, ctx.runtime, 'Staged runtime differs');
  assert(!Object.hasOwn(execution, 'cleanup'), 'Checker cannot claim outer cleanup');
  const phase = { runId: ctx.runId, ref: ctx.expectedRef, tree: ctx.expectedTree };
  assert.deepEqual(evidence.candidatePhases, { expand: phase, verify: phase }, 'Candidate phase identity differs');
  assert.deepEqual(evidence.cleanup?.map(item => item.name), ['previous-probe', 'test-database', 'admin-connection', 'temporary-home'], 'Incomplete checker cleanup');
  assert(evidence.cleanup.every(item => item.status === 'passed' && !Object.hasOwn(item, 'error')), 'Checker cleanup failed');
}

export async function runSchemaRollback(options) {
  assert.match(options.candidateRef ?? '', SHA, 'candidate-ref must be an explicit full SHA');
  assert.equal(Number(process.versions.node.split('.')[0]), 22, 'Node 22 is required');
  const source = await realpath(resolve(options.sourceRepo));
  assert.equal(gitText(source, 'rev-parse', '--show-toplevel'), source, 'source-repo must be a Git checkout root');
  const ref = options.candidateRef;
  assert.equal(gitText(source, 'rev-parse', `${ref}^{commit}`), ref, 'Candidate commit is unavailable');
  const tree = gitText(source, 'rev-parse', `${ref}^{tree}`);
  assert.match(tree, SHA);
  const requestedArtifacts = resolve(options.artifacts);
  await rejectSymlinkComponents(requestedArtifacts);
  const artifactRoot = join(await realpath(dirname(requestedArtifacts)), basename(requestedArtifacts));
  assert(!overlap(source, artifactRoot), 'Artifacts overlap source input');
  assert(!await exists(artifactRoot), 'Artifacts must be a fresh external directory');
  const runId = randomUUID(), runRoot = join(await realpath(tmpdir()), `schema-rollback-${runId}`);
  assert(!overlap(runRoot, source) && !overlap(runRoot, artifactRoot), 'Private run paths overlap input/artifacts');
  // All preceding operations are read-only; mkdir obtains exclusive ownership.
  await mkdir(artifactRoot, { mode: 0o700 });
  const diagnosticFile = await open(join(artifactRoot, 'launcher-diagnostics.json'), 'wx', 0o600);
  const diagnostic = { format: 1, runId, expectedRef: ref, expectedTree: tree, status: 'running', stage: 'create-run-root', cleanup: [] };
  let ownedRun = false, ctx, staged, failure;
  const candidate = join(runRoot, 'candidate'), previousInput = join(runRoot, 'previous-input');
  const staging = join(artifactRoot, 'rollback-staged-result.json');
  let stagingIdentity, diagnosticIdentity;
  const save = async () => { await diagnosticFile.truncate(0); await diagnosticFile.write(JSON.stringify(diagnostic, null, 2) + '\n', 0, 'utf8'); };
  try {
    diagnosticIdentity = await diagnosticFile.stat({ bigint: true });
    await mkdir(runRoot, { mode: 0o700 }); ownedRun = true;
    diagnostic.runRoot = runRoot;
    const control = join(runRoot, 'control');
    await mkdir(control, { mode: 0o700 });
    await mkdir(previousInput, { mode: 0o700 });
    const home = join(runRoot, 'candidate-home'), previousHome = join(runRoot, 'previous-home'), temp = join(runRoot, 'tmp');
    for (const path of [home, previousHome, temp]) await mkdir(path, { mode: 0o700 });
    for (const path of [home, previousHome]) {
      await writeFile(join(path, '.npmrc'), 'registry=https://registry.npmjs.org\n', { flag: 'wx', mode: 0o600 });
      await writeFile(join(path, 'global.npmrc'), '', { flag: 'wx', mode: 0o600 });
    }
    const contextPath = join(control, 'run-context.json'), env = executionEnvironment(home, temp, contextPath);
    diagnostic.stage = 'clone'; await save();
    await command('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--no-local', '--no-checkout', '--', source, candidate], runRoot, env, join(artifactRoot, 'clone.log'));
    candidateGit(candidate, 'remote', 'set-url', 'origin', OFFICIAL_ORIGIN);
    // A detached S can stop being advertised after preflight. Request its
    // object closure explicitly, without pinning or mutating any source ref.
    await command('git', ['-c', 'core.hooksPath=/dev/null', '-C', candidate, 'fetch', '--no-tags', '--no-write-fetch-head', '--', source, ref], runRoot, env, join(artifactRoot, 'candidate-fetch.log'));
    assert.equal(gitText(candidate, 'rev-parse', `${ref}^{commit}`), ref, 'Transported candidate commit differs');
    assert.equal(gitText(candidate, 'rev-parse', `${ref}^{tree}`), tree, 'Transported candidate tree differs');
    candidateGit(candidate, 'checkout', '--detach', ref);
    const bunVersion = execFileSync('bun', ['--version'], { cwd: runRoot, env, encoding: 'utf8' }).trim();
    assert.equal(bunVersion, '1.3.14', 'Bun 1.3.14 is required');
    ctx = { format: 1, runId, runRoot, candidateRoot: candidate, expectedRef: ref, expectedTree: tree, artifactRoot,
      lockfileSha256: hash(candidateGit(candidate, 'show', `${ref}:bun.lock`)),
      installationDirectories: candidateInstallationDirectories(candidate, ref), runtime: { node: process.version, bun: bunVersion } };
    const contextBytes = JSON.stringify(ctx, null, 2) + '\n';
    await writeFile(contextPath, contextBytes, { flag: 'wx', mode: 0o600 });
    env.SCHEMA_ROLLBACK_CONTEXT_SHA256 = hash(contextBytes);
    const sourceQueryEnv = { ...env };
    if (process.env.GH_TOKEN !== undefined) sourceQueryEnv.GH_TOKEN = process.env.GH_TOKEN;
    // The outer launcher already owns ctx in memory; the digest is required by
    // private checker/helper processes and is never inferred from their input.
    await verifyCandidate(ctx);
    diagnostic.stage = 'candidate-install'; await save();
    const install = ['install', '--registry', 'https://registry.npmjs.org', '--frozen-lockfile', '--ignore-scripts', '--backend=copyfile'];
    await command('bun', install, candidate, env, join(artifactRoot, 'candidate-install.log'));
    await verifyCandidate(ctx);
    diagnostic.stage = 'prepare'; await save();
    await command('bun', ['run', 'scripts/prepare-schema-rollback.ts', previousInput], candidate, sourceQueryEnv, join(artifactRoot, 'prepare.log'));
    await verifyCandidate(ctx);
    diagnostic.stage = 'previous-install'; await save();
    await command('bun', install, join(previousInput, 'previous'), executionEnvironment(previousHome, temp, contextPath), join(artifactRoot, 'previous-install.log'));
    await verifyCandidate(ctx);
    diagnostic.stage = 'check'; await save();
    await command('bun', ['run', 'scripts/check-schema-rollback.ts', join(previousInput, 'previous'), join(previousInput, 'previous-release.json'), staging], candidate, sourceQueryEnv, join(artifactRoot, 'check.log'));
    stagingIdentity = await lstat(staging);
    assert(stagingIdentity.isFile() && !stagingIdentity.isSymbolicLink(), 'Staged evidence must be a regular file');
    staged = JSON.parse(await readFile(staging, 'utf8'));
    validateStaged(staged, ctx);
    await verifyCandidate(ctx);
    diagnostic.stage = 'cleanup';
  } catch (error) {
    failure = error;
    diagnostic.error = String(error);
  } finally {
    // Copy only metadata, never source, archives, dependencies, HOME or staging.
    if (ownedRun) {
      for (const name of METADATA) {
        try {
          const from = join(previousInput, name);
          if (!failure) assert(await exists(from), `Successful execution is missing metadata: ${name}`);
          if (await exists(from)) {
            const info = await lstat(from);
            assert(info.isFile() && !info.isSymbolicLink(), 'Metadata must be a regular file');
            await copyFile(from, join(artifactRoot, name), constants.COPYFILE_EXCL);
          }
        } catch (error) { failure ??= error; diagnostic.metadataError = String(error); }
      }
    }
    const cleanup = async (name, action) => {
      try { await action(); diagnostic.cleanup.push({ name, status: 'passed' }); }
      catch (error) { diagnostic.cleanup.push({ name, status: 'failed', error: String(error) }); failure ??= error; }
    };
    await cleanup('previous-input', async () => {
      if (!ownedRun) return;
      if (await exists(join(candidate, '.git'))) {
        const list = candidateGit(candidate, 'worktree', 'list', '--porcelain', '-z').toString('utf8');
        if (list.split('\0').includes(`worktree ${join(previousInput, 'previous')}`)) candidateGit(candidate, 'worktree', 'remove', '--force', join(previousInput, 'previous'));
      }
      await rm(previousInput, { recursive: true, force: true });
    });
    await cleanup('candidate-checkout', async () => { if (ownedRun) await rm(candidate, { recursive: true, force: true }); });
    await cleanup('staged-result', async () => {
      // Checker creates exclusively; consume only the inode observed after its
      // successful termination. A competing writer's file never belongs to us.
      if (stagingIdentity) {
        const current = await lstat(staging);
        assert.equal(current.ino, stagingIdentity.ino, 'Staged result owner changed');
        assert.equal(current.dev, stagingIdentity.dev, 'Staged result device changed');
        await rm(staging);
      } else assert(!await exists(staging), 'Unowned staged result remains; preserving its contents');
    });
    await cleanup('run-root', async () => {
      if (!ownedRun) return;
      assert(diagnostic.cleanup.slice(0, 2).every(item => item.status === 'passed'), 'Retaining run root after failed resource cleanup');
      await rm(runRoot, { recursive: true });
    });
    assert.deepEqual(diagnostic.cleanup.map(item => item.name), CLEANUPS);
    // All mandatory diagnostic I/O precedes publication. In particular a
    // diagnostic save/close error must never leave usable success evidence.
    diagnostic.status = failure ? 'failed' : 'passed';
    if (failure && !diagnostic.error) diagnostic.error = String(failure);
    try { await save(); } catch (error) { failure ??= error; }
    try { await diagnosticFile.close(); }
    catch (error) {
      failure ??= error;
      try { await diagnosticFile.close(); } catch { /* Preserve the original close failure. */ }
    }
    if (!failure) {
      const output = join(artifactRoot, 'rollback-evidence.json');
      let outputFile, outputIdentity;
      try {
        assert(staged && ctx, 'Missing successful staged result');
        staged.candidateExecution.cleanup = diagnostic.cleanup;
        outputFile = await open(output, 'wx', 0o600);
        outputIdentity = await outputFile.stat({ bigint: true });
        await outputFile.writeFile(JSON.stringify(staged, null, 2) + '\n');
        await outputFile.close();
        const current = await lstat(output, { bigint: true });
        assert(current.isFile() && current.dev === outputIdentity.dev && current.ino === outputIdentity.ino,
          'Final evidence ownership changed during publication');
        // No required diagnostic or other resource I/O follows this success.
      } catch (error) {
        failure = error;
        if (outputFile) {
          // Invalidate only our open inode, even if another writer has moved
          // it elsewhere. Never truncate a replacement reached through output.
          try { await outputFile.truncate(0); } catch { /* The close may have already completed. */ }
          try { await outputFile.close(); } catch { /* Still attempt owned-path recovery. */ }
          try {
            const current = await lstat(output, { bigint: true });
            if (outputIdentity && current.dev === outputIdentity.dev && current.ino === outputIdentity.ino) await rm(output);
          } catch (cleanupError) {
            if (cleanupError.code !== 'ENOENT') diagnostic.publicationCleanupError = String(cleanupError);
          }
        }
      }
    }
    if (failure) {
      // Updating diagnostics is best effort only on failure, including an
      // earlier diagnostic close error. Reopening does not establish ownership.
      diagnostic.status = 'failed'; diagnostic.error ??= String(failure);
      let report;
      try {
        report = await open(join(artifactRoot, 'launcher-diagnostics.json'), constants.O_RDWR | constants.O_NOFOLLOW);
        const current = await report.stat({ bigint: true });
        assert(diagnosticIdentity && current.isFile() && current.dev === diagnosticIdentity.dev && current.ino === diagnosticIdentity.ino,
          'Diagnostic ownership changed after close');
        await report.truncate(0);
        await report.write(JSON.stringify(diagnostic, null, 2) + '\n', 0, 'utf8');
      } catch { /* Keep the original failure and preserve competing writer content. */ }
      finally { if (report) { try { await report.close(); } catch { /* Best effort only. */ } } }
    }
  }
  if (failure) throw failure;
  return join(artifactRoot, 'rollback-evidence.json');
}
function parseArguments(argv) {
  const result = {};
  const names = { '--source-repo': 'sourceRepo', '--candidate-ref': 'candidateRef', '--artifacts': 'artifacts' };
  for (let i = 0; i < argv.length; i += 2) {
    assert(names[argv[i]] && argv[i + 1] && !Object.hasOwn(result, names[argv[i]]), 'Usage: --source-repo ROOT --candidate-ref SHA --artifacts FRESH-DIRECTORY');
    result[names[argv[i]]] = argv[i + 1];
  }
  assert(Object.keys(result).length === 3, 'source-repo, candidate-ref and artifacts are required');
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runSchemaRollback(parseArguments(process.argv.slice(2))); }
  catch (error) { console.error(String(error)); process.exitCode = 1; }
}
