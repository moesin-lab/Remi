/** Real previous release x private candidate schema. The launcher publishes
 * final evidence after this staged result and all outer cleanup succeed.
 * Internal: SCHEMA_ROLLBACK_RUN_CONTEXT=... bun scripts/check-schema-rollback.ts <previous source> <manifest> <staging> */
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { resolve, join, dirname, relative, sep } from 'node:path';
import { copyFile, readFile, writeFile, rm, mkdir, mkdtemp, lstat, realpath, open } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateCoreProbeReports } from './platform-rollback-policy.mjs';

const script = fileURLToPath(import.meta.url);
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

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
  assert.equal(root, await realpath(root), 'Artifact root must be its real path');
  for (const path of paths) {
    assert(contains(root, path) && path !== root,
      `Artifact must be inside the owned artifact root: ${path}`);
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
  if (!outputArg) throw new Error('Internal usage: SCHEMA_ROLLBACK_RUN_CONTEXT=... SCHEMA_ROLLBACK_CONTEXT_SHA256=... MULTIREMI_TEST_POSTGRES_URL=... bun scripts/check-schema-rollback.ts <previous source> <manifest> <rollback-staged-result.json>');
  // Reject checkout/path mismatches before any output or resource mutation.
  const candidateRoot = await assertExecutionRoot(), output = resolve(outputArg);
  const contextPath = process.env.SCHEMA_ROLLBACK_RUN_CONTEXT;
  assert(contextPath, 'SCHEMA_ROLLBACK_RUN_CONTEXT is required; use the private candidate launcher');
  const { loadCandidateContext, verifyCandidate } = await import('./schema-rollback-candidate.mjs');
  const context = await loadCandidateContext(contextPath, candidateRoot);
  const checkCandidate = () => verifyCandidate(context);
  await checkCandidate();
  assert(previousRootArg && manifestPathArg && process.env.MULTIREMI_TEST_POSTGRES_URL, 'Previous source, published manifest and isolated PostgreSQL URL are required');
  const previousRoot = await realpath(resolve(previousRootArg)), manifestPath = await realpath(resolve(manifestPathArg));
  assert.equal(previousRoot, join(context.runRoot, 'previous-input', 'previous'), 'Previous source must belong to this private run');
  assert.equal(manifestPath, join(context.runRoot, 'previous-input', 'previous-release.json'), 'Previous manifest must belong to this private run');
  const artifactRoot = context.artifactRoot, diagnosticsPath = join(artifactRoot, 'rollback-diagnostics.json');
  const logs = join(artifactRoot, 'rollback-logs');
  assert.equal(output, join(artifactRoot, 'rollback-staged-result.json'), 'Only the private launcher staged output is allowed');
  await assertArtifactPaths(artifactRoot, [output, diagnosticsPath, logs], [candidateRoot, previousRoot, manifestPath, contextPath]);
  const candidateRef = context.expectedRef;
  const phases: Phase[] = [];
  const cleanups: Cleanup[] = [];
  const diagnostics: Record<string, unknown> = { format: 1, targetRef: candidateRef, status: 'running', phases };
  let evidence: Record<string, unknown> | undefined;
  let failure: unknown;
  let cleanupResults: Awaited<ReturnType<typeof runCleanups>> = [];
  await mkdir(artifactRoot, { recursive: true });
  // Exclusive creation establishes ownership; never truncate a pre-existing file.
  const diagnosticFile = await open(diagnosticsPath, 'wx');
  let diagnosticIdentity: { dev: bigint; ino: bigint } | undefined;
  const saveDiagnostics = async (file = diagnosticFile) => {
    const bytes = Buffer.from(JSON.stringify(diagnostics,
      (key, value) => key === 'rollbackSafeFrom' ? undefined : value, 2) + '\n', 'utf8');
    await file.truncate(0);
    for (let position = 0; position < bytes.length;) {
      const remaining = bytes.length - position;
      const { bytesWritten } = await file.write(bytes, position, remaining, position);
      assert(Number.isInteger(bytesWritten) && bytesWritten > 0 && bytesWritten <= remaining,
        'Diagnostic write made invalid progress');
      position += bytesWritten;
    }
  };
  const recoverDiagnostics = async () => {
    diagnostics.status = 'failed'; diagnostics.error ??= String(failure);
    let report: Awaited<ReturnType<typeof open>> | undefined;
    try {
      report = await open(diagnosticsPath, constants.O_RDWR | constants.O_NOFOLLOW);
      const current = await report.stat({ bigint: true });
      assert(diagnosticIdentity && current.isFile() && current.dev === diagnosticIdentity.dev && current.ino === diagnosticIdentity.ino,
        'Diagnostic ownership changed after close');
      await saveDiagnostics(report);
    } catch { /* Keep the original failure and preserve competing writer content. */ }
    finally { if (report) { try { await report.close(); } catch { /* Best effort only. */ } } }
  };
  try {
    diagnosticIdentity = await diagnosticFile.stat({ bigint: true });
    await mkdir(logs);
    await saveDiagnostics();
    await checkCandidate();
    const { verifyPreparedRelease } = await import('./schema-rollback-identity.ts');
    await checkCandidate();
    const identity = await verifyPreparedRelease(previousRoot, manifestPath);
    await checkCandidate();
    diagnostics.previousIdentity = identity;
    const previousManifest = await readFile(manifestPath, 'utf8');
    const previous = JSON.parse(previousManifest);
    await checkCandidate();
    const { schemaLevelFingerprint } = await import('../packages/platform-updater/src/schema-fingerprint.mjs');
    await checkCandidate();
    const dataSchema = await schemaLevelFingerprint(candidateRoot);
    await checkCandidate();
    const url = new URL(process.env.MULTIREMI_TEST_POSTGRES_URL!);
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Requires an isolated local test PostgreSQL service');
    const temporary = await mkdtemp(join(context.runRoot, 'probe-home-'));
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
        await checkCandidate();
        const result = Bun.spawnSync(command, { cwd, env: { ...env, MUL173_EXPECT_TASK: expectedTask,
          SCHEMA_ROLLBACK_RUN_CONTEXT: contextPath,
          SCHEMA_ROLLBACK_CONTEXT_SHA256: process.env.SCHEMA_ROLLBACK_CONTEXT_SHA256 }, stdout: 'pipe', stderr: 'pipe' });
        stdout = result.stdout.toString(); stderr = result.stderr.toString();
        phase.exitCode = result.exitCode; phase.signalCode = result.signalCode;
        await checkCandidate();
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
        try {
          await writeFile(join(logs, `${name}.stdout.log`), stdout);
          await writeFile(join(logs, `${name}.stderr.log`), stderr || (phase.error ? phase.error + '\n' : ''));
          await saveDiagnostics();
        } catch (error) { if (phase.status !== 'failed') throw error; }
      }
    };
    const seeded = await runPhase('previous-before-expand', [process.execPath, probe], previousRoot);
    validateCoreProbeReports([seeded]);
    const expanded = await runPhase('candidate-expand', [process.execPath, script, '--candidate-expand'], candidateRoot);
    const expectedExecution = { runId: context.runId, ref: candidateRef, tree: context.expectedTree };
    assert.deepEqual(expanded.candidateExecution, expectedExecution, 'Expand candidate execution context differs');
    diagnostics.schema = expanded.schema;
    assert.equal(expanded.schema.contractLevel, 0, 'Automatic rollback attestation cannot cross contract');
    const after = await runPhase('previous-after-expand', [process.execPath, probe], previousRoot, seeded.task);
    validateCoreProbeReports([seeded, after]);
    const verified = await runPhase('verify-schema-levels', [process.execPath, script, '--read-schema'], candidateRoot);
    assert.deepEqual(verified.candidateExecution, expectedExecution, 'Schema verification candidate execution context differs');
    diagnostics.schemaVerification = verified.schema;
    assert.deepEqual(verified.schema, expanded.schema, 'Old startup must retain schema levels');
    await checkCandidate();
    evidence = { format: 2, targetRef: candidateRef, dataSchema, previousManifest, previousRelease: previous,
      candidateExecution: { format: 1, mode: 'private-fixed-commit', runId: context.runId,
        expectedRef: candidateRef, actualRef: candidateRef, expectedTree: context.expectedTree, finalTree: context.expectedTree,
        lockfileSha256: context.lockfileSha256, runtime: context.runtime },
      candidatePhases: { expand: expanded.candidateExecution, verify: verified.candidateExecution },
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
    // Required diagnostic I/O must finish before creating successful staging.
    try { await saveDiagnostics(); } catch (error) { failure ??= error; }
    try { await diagnosticFile.close(); }
    catch (error) {
      failure ??= error;
      try { await diagnosticFile.close(); } catch { /* Preserve the original close failure. */ }
    }
  }
  if (failure) { await recoverDiagnostics(); throw failure; }
  let outputFile: Awaited<ReturnType<typeof open>> | undefined;
  try {
    assert(evidence, 'Missing complete rollback evidence');
    await checkCandidate();
    outputFile = await open(output, 'wx');
    await checkCandidate();
    await outputFile.writeFile(JSON.stringify({ ...evidence, cleanup: cleanupResults }, null, 2) + '\n');
    await checkCandidate();
    await outputFile.close();
    console.log(JSON.stringify({ pass: true, targetRef: evidence.targetRef, previousIdentity: evidence.previousIdentity, schema: evidence.schema }));
  } catch (error) {
    failure = error;
    if (outputFile) {
      try { await outputFile.close(); } catch { /* Still attempt staged output cleanup. */ }
      try { await rm(output, { force: true }); } catch { /* Preserve the publication failure. */ }
    }
    await recoverDiagnostics();
    throw failure;
  }
}

async function candidatePhase(expand: boolean) {
  const root = await assertExecutionRoot();
  const contextPath = process.env.SCHEMA_ROLLBACK_RUN_CONTEXT;
  assert(contextPath, 'SCHEMA_ROLLBACK_RUN_CONTEXT is required; use the private candidate launcher');
  const { loadCandidateContext, verifyCandidate } = await import('./schema-rollback-candidate.mjs');
  const context = await loadCandidateContext(contextPath, root);
  const checkCandidate = () => verifyCandidate(context);
  await checkCandidate();
  const { PostgresSyncDatabase } = await import('../packages/server/src/store/db/postgres.ts');
  await checkCandidate();
  const { readSchemaLevels } = await import('../packages/server/src/store/schema-levels.ts');
  await checkCandidate();
  const db = new PostgresSyncDatabase(process.env.MULTIREMI_DATABASE_URL!);
  try {
    await checkCandidate();
    if (expand) {
      const { runMigrations, runStartupMigrations } = await import('../packages/server/src/store/migrations.ts');
      await checkCandidate();
      runMigrations(db, { historicalMaintenance: true }); // Offline initial protocol boundary.
      await checkCandidate();
      runStartupMigrations(db); // Candidate's real startup path.
      await checkCandidate();
    }
    const schema = readSchemaLevels(db);
    await checkCandidate();
    assert.equal(schema.contractLevel, 0, 'Automatic rollback attestation cannot cross contract');
    console.log(JSON.stringify({ pass: true, schema, candidateExecution: await checkCandidate() }));
  } finally { db.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  if (process.argv[2] === '--candidate-expand' || process.argv[2] === '--read-schema') {
    await candidatePhase(process.argv[2] === '--candidate-expand');
  } else {
    await checkSchemaRollback(process.argv.slice(2));
  }
}
