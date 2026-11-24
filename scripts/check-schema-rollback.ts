/** Real previous release x candidate schema. Evidence is published only after
 * old startup/writes, candidate expand, old startup/writes and cleanup succeed.
 * Usage: bun scripts/check-schema-rollback.ts <previous source> <manifest> <output> */
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { resolve, join, dirname, relative, sep } from 'node:path';
import { copyFile, readFile, writeFile, rm, mkdir, mkdtemp, lstat, realpath, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateCoreProbeReports } from './platform-rollback-policy.mjs';

const script = fileURLToPath(import.meta.url);
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** Only generated ci-schema inputs and this run's exclusively owned artifacts
 * are exempt. Tracked changes and other untracked source still fail. */
export function assertCleanCandidate(root: string, ownedPaths: string[] = []) {
  execFileSync('git', ['diff', '--quiet', 'HEAD'], { cwd: root });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(path => path && !path.startsWith('ci-schema/') &&
      !ownedPaths.some(owned => contains(owned, resolve(root, path))));
  assert.deepEqual(untracked, [], `Candidate has untracked files: ${untracked.join(', ')}`);
}

function assertCandidateIdentity(root: string, expectedRef: string, ownedPaths: string[]) {
  assert.match(expectedRef, /^[a-f0-9]{40}$/, 'Expected candidate SHA is required');
  assert.equal(git(root, 'rev-parse', 'HEAD'), expectedRef, 'Candidate HEAD changed during rollback verification');
  assertCleanCandidate(root, ownedPaths);
  assert.equal(git(root, 'rev-parse', 'HEAD'), expectedRef, 'Candidate HEAD changed during source verification');
}

async function assertExecutionRoot() {
  const root = await realpath(process.cwd());
  assert.equal(root, await realpath(resolve(dirname(script), '..')),
    'Run the checker from its own candidate repository root');
  assert.equal(root, await realpath(git(root, 'rev-parse', '--show-toplevel')),
    'Candidate must be the repository root');
  return root;
}

const contains = (parent: string, path: string) => path === parent || path.startsWith(parent + sep);
const overlaps = (a: string, b: string) => contains(a, b) || contains(b, a);

/** Preflight is read-only. Existing files, including stale artifacts, belong to
 * the caller; a run only owns outputs that it creates exclusively afterward. */
async function assertArtifactPaths(root: string, paths: string[], inputs: string[]) {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean).map(path => resolve(root, path));
  for (const path of paths) {
    assert(contains(root, path) && path !== root && !contains(join(root, '.git'), path),
      `Artifact must be inside the candidate, outside .git: ${path}`);
    assert(!tracked.some(file => overlaps(path, file)), `Artifact overlaps tracked candidate content: ${path}`);
    assert(!inputs.some(input => overlaps(path, input)), `Artifact overlaps previous source or manifest: ${path}`);
    for (const other of paths) {
      assert(path === other || !overlaps(path, other), `Artifact paths overlap: ${path}`);
    }
    let part = root;
    for (const name of relative(root, path).split(sep)) {
      part = join(part, name);
      const stat = await lstat(part).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (!stat) continue;
      assert(!stat.isSymbolicLink(), `Artifact path traverses a symlink: ${part}`);
      assert(part !== path, `Artifact already exists; use fresh output paths: ${path}`);
      assert(stat.isDirectory(), `Artifact parent is not a directory: ${part}`);
    }
  }
  assert.equal(new Set(paths).size, paths.length, 'Artifact paths must be distinct');
}

type Cleanup = { name: string; run: () => unknown | Promise<unknown> };
export async function runCleanups(cleanups: Cleanup[]) {
  const results: { name: string; status: 'passed' | 'failed'; error?: string }[] = [];
  for (const cleanup of cleanups) {
    try { await cleanup.run(); results.push({ name: cleanup.name, status: 'passed' }); }
    catch (error) { results.push({ name: cleanup.name, status: 'failed', error: String(error) }); }
  }
  return results;
}

type Phase = {
  name: string; status: 'running' | 'passed' | 'failed';
  stdout: string; stderr: string; exitCode?: number | null; signalCode?: string | number | null; error?: string;
};

export async function checkSchemaRollback(args: string[]) {
  const [previousRootArg, manifestPathArg, outputArg] = args;
  if (!outputArg) throw new Error('Usage: MULTIREMI_TEST_POSTGRES_URL=... bun scripts/check-schema-rollback.ts <previous source> <manifest> <evidence.json>');
  // Reject checkout/path mismatches before any output or resource mutation.
  const candidateRoot = await assertExecutionRoot(), output = resolve(outputArg);
  assert(previousRootArg && manifestPathArg && process.env.MULTIREMI_TEST_POSTGRES_URL, 'Previous source, published manifest and isolated PostgreSQL URL are required');
  const previousRoot = await realpath(resolve(previousRootArg)), manifestPath = await realpath(resolve(manifestPathArg));
  assert.notEqual(previousRoot, candidateRoot, 'Previous source must be isolated from the candidate');
  const artifactRoot = dirname(output), diagnosticsPath = join(artifactRoot, 'rollback-diagnostics.json');
  const logs = join(artifactRoot, 'rollback-logs');
  await assertArtifactPaths(candidateRoot, [output, diagnosticsPath, logs], [previousRoot, manifestPath]);
  const candidateRef = git(candidateRoot, 'rev-parse', 'HEAD');
  const ownedPaths: string[] = [];
  const checkCandidate = () => assertCandidateIdentity(candidateRoot, candidateRef, ownedPaths);
  checkCandidate();
  const phases: Phase[] = [];
  const cleanups: Cleanup[] = [];
  const diagnostics: Record<string, unknown> = { format: 1, targetRef: candidateRef, status: 'running', phases };
  let evidence: Record<string, unknown> | undefined;
  let failure: unknown;
  let cleanupResults: Awaited<ReturnType<typeof runCleanups>> = [];
  await mkdir(artifactRoot, { recursive: true });
  // Exclusive creation establishes ownership; never truncate a pre-existing file.
  const diagnosticFile = await open(diagnosticsPath, 'wx');
  ownedPaths.push(diagnosticsPath);
  const saveDiagnostics = async () => {
    await diagnosticFile.truncate(0);
    await diagnosticFile.write(JSON.stringify(diagnostics,
      (key, value) => key === 'rollbackSafeFrom' ? undefined : value, 2) + '\n', 0, 'utf8');
  };
  try {
    await mkdir(logs);
    ownedPaths.push(logs);
    await saveDiagnostics();
    checkCandidate();
    const { verifyPreparedRelease } = await import('./schema-rollback-identity.ts');
    checkCandidate();
    const identity = await verifyPreparedRelease(previousRoot, manifestPath);
    checkCandidate();
    diagnostics.previousIdentity = identity;
    const previousManifest = await readFile(manifestPath, 'utf8');
    const previous = JSON.parse(previousManifest);
    checkCandidate();
    const { schemaLevelFingerprint } = await import('../packages/platform-updater/src/schema-fingerprint.mjs');
    checkCandidate();
    const dataSchema = await schemaLevelFingerprint(candidateRoot);
    checkCandidate();
    const url = new URL(process.env.MULTIREMI_TEST_POSTGRES_URL!);
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Requires an isolated local test PostgreSQL service');
    const temporary = await mkdtemp(join(tmpdir(), 'remi-schema-rollback-'));
    cleanups.push({ name: 'temporary-home', run: () => rm(temporary, { recursive: true, force: true }) });
    const admin = new Bun.SQL(url.toString(), { max: 1 });
    cleanups.unshift({ name: 'admin-connection', run: () => admin.close() });
    const name = `mul173_mixed_${crypto.randomUUID().replaceAll('-', '')}`;
    await admin.unsafe(`CREATE DATABASE ${name}`);
    cleanups.unshift({ name: 'test-database', run: () => admin.unsafe(`DROP DATABASE ${name}`) });
    url.pathname = '/' + name;
    const probe = join(previousRoot, 'scripts/mul173-schema-rollback-probe.ts');
    // Identity verification must precede this single, exclusive probe injection.
    await copyFile(join(dirname(script), 'schema-rollback-probe.ts'), probe, constants.COPYFILE_EXCL);
    cleanups.unshift({ name: 'previous-probe', run: () => rm(probe) });
    const env = { PATH: process.env.PATH, HOME: temporary, NODE_ENV: 'test',
      MULTIREMI_DATABASE_URL: url.toString(), MULTIREMI_MIGRATION_REPORT_DIR: join(logs, 'migration-reports') };
    const runPhase = async (name: string, command: string[], cwd: string, expectedTask?: string) => {
      const phase: Phase = { name, status: 'running', stdout: `rollback-logs/${name}.stdout.log`, stderr: `rollback-logs/${name}.stderr.log` };
      phases.push(phase);
      await saveDiagnostics();
      let stdout = '', stderr = '';
      try {
        checkCandidate();
        const result = Bun.spawnSync(command, { cwd, env: { ...env, MUL173_EXPECT_TASK: expectedTask,
          SCHEMA_ROLLBACK_EXPECTED_REF: candidateRef, SCHEMA_ROLLBACK_OWNED_ARTIFACTS: JSON.stringify(ownedPaths) }, stdout: 'pipe', stderr: 'pipe' });
        stdout = result.stdout.toString(); stderr = result.stderr.toString();
        phase.exitCode = result.exitCode; phase.signalCode = result.signalCode;
        checkCandidate();
        assert.equal(result.exitCode, 0, `${name} failed (${result.exitCode}); see ${phase.stderr}`);
        assert(!result.signalCode, `${name} terminated by signal ${result.signalCode}`);
        const report = JSON.parse(stdout.trim().split('\n').at(-1)!);
        assert.equal(report.pass, true, `${name} did not report success`);
        phase.status = 'passed';
        return report;
      } catch (error) {
        phase.status = 'failed'; phase.error = String(error);
        throw error;
      } finally {
        await writeFile(join(logs, `${name}.stdout.log`), stdout);
        await writeFile(join(logs, `${name}.stderr.log`), stderr || (phase.error ? phase.error + '\n' : ''));
        await saveDiagnostics();
      }
    };
    const seeded = await runPhase('previous-before-expand', [process.execPath, probe], previousRoot);
    validateCoreProbeReports([seeded]);
    const expanded = await runPhase('candidate-expand', [process.execPath, script, '--candidate-expand'], candidateRoot);
    diagnostics.schema = expanded.schema;
    assert.equal(expanded.schema.contractLevel, 0, 'Automatic rollback attestation cannot cross contract');
    const after = await runPhase('previous-after-expand', [process.execPath, probe], previousRoot, seeded.task);
    validateCoreProbeReports([seeded, after]);
    const verified = await runPhase('verify-schema-levels', [process.execPath, script, '--read-schema'], candidateRoot);
    diagnostics.schemaVerification = verified.schema;
    assert.deepEqual(verified.schema, expanded.schema, 'Old startup must retain schema levels');
    evidence = { format: 1, targetRef: diagnostics.targetRef, dataSchema, previousManifest, previousRelease: previous,
      previousIdentity: identity, schema: expanded.schema, schemaVerification: verified.schema,
      probes: { before: seeded, after }, phases,
      checks: ['previous-startup', 'previous-create-start-complete-cancel', 'candidate-expand-startup', 'previous-startup-after-expand', 'previous-create-start-complete-cancel-after-expand'],
      rollbackSafeFrom: [previous.dataSchema] };
  } catch (error) {
    failure = error;
    diagnostics.error = String(error);
  } finally {
    cleanupResults = await runCleanups(cleanups);
    diagnostics.cleanup = cleanupResults;
    if (cleanupResults.some(result => result.status === 'failed')) {
      failure ??= new Error('Rollback cleanup failed; see rollback-diagnostics.json');
    }
    diagnostics.status = failure ? 'failed' : 'passed';
    // No success file has been created yet; failure cannot delete caller data.
    try { await saveDiagnostics(); } finally { if (failure) await diagnosticFile.close(); }
  }
  if (failure) throw failure;
  let outputFile: Awaited<ReturnType<typeof open>> | undefined;
  try {
    assert(evidence, 'Missing complete rollback evidence');
    checkCandidate();
    outputFile = await open(output, 'wx');
    ownedPaths.push(output);
    checkCandidate();
    await outputFile.writeFile(JSON.stringify({ ...evidence, cleanup: cleanupResults }, null, 2) + '\n');
    checkCandidate();
    console.log(JSON.stringify({ pass: true, targetRef: evidence.targetRef, previousIdentity: evidence.previousIdentity, schema: evidence.schema }));
  } catch (error) {
    if (outputFile) await rm(output, { force: true });
    diagnostics.status = 'failed'; diagnostics.error = String(error);
    await saveDiagnostics();
    throw error;
  } finally {
    await outputFile?.close();
    await diagnosticFile.close();
  }
}

async function candidatePhase(expand: boolean) {
  const root = await assertExecutionRoot();
  const expectedRef = process.env.SCHEMA_ROLLBACK_EXPECTED_REF ?? '';
  assert.match(expectedRef, /^[a-f0-9]{40}$/, 'Expected candidate SHA is required');
  const ownedPaths = JSON.parse(process.env.SCHEMA_ROLLBACK_OWNED_ARTIFACTS ?? '[]');
  assert(Array.isArray(ownedPaths) && ownedPaths.length === 2 &&
    ownedPaths.every(path => typeof path === 'string' && resolve(path) === path &&
      contains(root, path) && path !== root && !contains(join(root, '.git'), path)) &&
    ownedPaths[0] === join(dirname(ownedPaths[1]), 'rollback-diagnostics.json') &&
    ownedPaths[1] === join(dirname(ownedPaths[0]), 'rollback-logs'), 'Expected owned rollback artifacts');
  const checkCandidate = () => assertCandidateIdentity(root, expectedRef, ownedPaths);
  checkCandidate();
  const { PostgresSyncDatabase } = await import('../packages/server/src/store/db/postgres.ts');
  checkCandidate();
  const { readSchemaLevels } = await import('../packages/server/src/store/schema-levels.ts');
  checkCandidate();
  const db = new PostgresSyncDatabase(process.env.MULTIREMI_DATABASE_URL!);
  try {
    checkCandidate();
    if (expand) {
      const { runMigrations, runStartupMigrations } = await import('../packages/server/src/store/migrations.ts');
      checkCandidate();
      runMigrations(db, { historicalMaintenance: true }); // Offline initial protocol boundary.
      checkCandidate();
      runStartupMigrations(db); // Candidate's real startup path.
      checkCandidate();
    }
    const schema = readSchemaLevels(db);
    checkCandidate();
    assert.equal(schema.contractLevel, 0, 'Automatic rollback attestation cannot cross contract');
    console.log(JSON.stringify({ pass: true, schema }));
  } finally { db.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  if (process.argv[2] === '--candidate-expand' || process.argv[2] === '--read-schema') {
    await candidatePhase(process.argv[2] === '--candidate-expand');
  } else {
    await checkSchemaRollback(process.argv.slice(2));
  }
}
