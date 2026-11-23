/** Real previous release x candidate schema. Fails closed; emits evidence only
 * after old code has booted and executed core writes on both sides of expand.
 * Usage: bun scripts/check-schema-rollback.ts <previous worktree> <published manifest> <output> */
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { copyFile, readFile, writeFile, rm, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { PostgresSyncDatabase } from '../packages/server/src/store/db/postgres.ts';
import { runMigrations, runStartupMigrations } from '../packages/server/src/store/migrations.ts';
import { readSchemaLevels } from '../packages/server/src/store/schema-levels.ts';
import { schemaLevelFingerprint } from '../packages/platform-updater/src/schema-fingerprint.mjs';
import {
  KNOWN_REWRITTEN_RELEASE_REFS,
  verifyPreviousReleaseCheckout,
  verifyPreviousReleaseRef,
  type PreviousReleaseManifest,
  type RewrittenReleaseRef,
} from './schema-rollback-identity.ts';

export {
  KNOWN_REWRITTEN_RELEASE_REFS,
  verifyPreviousReleaseCheckout,
  verifyPreviousReleaseRef,
  type PreviousReleaseManifest,
  type RewrittenReleaseRef,
};

async function main(): Promise<void> {
  const [previousRootArg, manifestPath, outputArg] = process.argv.slice(2);
  if (!previousRootArg || !manifestPath || !outputArg || !process.env.MULTIREMI_TEST_POSTGRES_URL) {
    throw new Error('Usage: MULTIREMI_TEST_POSTGRES_URL=... bun scripts/check-schema-rollback.ts <previous worktree> <published platform-release.json> <evidence.json>');
  }
  const previousRoot = resolve(previousRootArg), output = resolve(outputArg);
  const previous = JSON.parse(await readFile(manifestPath, 'utf8')) as PreviousReleaseManifest;
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  execFileSync('git', ['diff', '--quiet', 'HEAD'], { cwd: process.cwd() });
  await verifyPreviousReleaseCheckout(previousRoot, previous, { git });
  // Never leave stale successful evidence after a failed rerun.
  await rm(output, { force: true });
  const temporary = await mkdtemp(join(tmpdir(), 'remi-schema-rollback-'));
  const probe = join(previousRoot, 'scripts/mul173-schema-rollback-probe.ts');
  const name = `mul173_mixed_${crypto.randomUUID().replaceAll('-', '')}`;
  const url = new URL(process.env.MULTIREMI_TEST_POSTGRES_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Requires an isolated local test PostgreSQL service');
  const previousReportDir = process.env.MULTIREMI_MIGRATION_REPORT_DIR;
  process.env.MULTIREMI_MIGRATION_REPORT_DIR = join(temporary, 'reports');
  const admin = new Bun.SQL(url.toString(), { max: 1 });
  let created = false;
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`); created = true;
    url.pathname = '/' + name;
    await copyFile(join(import.meta.dir, 'schema-rollback-probe.ts'), probe);
    const runOld = (expectedTask?: string) => {
      const result = Bun.spawnSync([process.execPath, probe], { cwd: previousRoot,
        env: { MUL173_EXPECT_TASK: expectedTask, PATH: process.env.PATH, HOME: temporary, NODE_ENV: 'test', MULTIREMI_DATABASE_URL: url.toString(),
          MULTIREMI_MIGRATION_REPORT_DIR: join(temporary, 'reports') }, stdout: 'pipe', stderr: 'pipe' });
      console.log(result.stdout.toString());
      if (result.exitCode !== 0) throw new Error(`Previous release core tests failed (${result.exitCode}): ${result.stderr.toString()}`);
      const resultData = JSON.parse(result.stdout.toString().trim().split('\n').at(-1)!);
      assert.equal(resultData.pass, true);
      return resultData;
    };
    const seeded = runOld(); // Establish the previous schema and data using actual old writers.
    const db = new PostgresSyncDatabase(url.toString());
    let schema;
    try {
      runMigrations(db, { historicalMaintenance: true }); // Initial protocol boundary: offline preparation.
      runStartupMigrations(db); // Candidate's real startup path.
      schema = readSchemaLevels(db);
      assert.equal(schema.contractLevel, 0, 'Automatic rollback attestation cannot cross contract');
    } finally { db.close(); }
    runOld(seeded.task); // Actual old startup plus create/start/complete/cancel after expand.
    const verify = new PostgresSyncDatabase(url.toString());
    try { assert.deepEqual(readSchemaLevels(verify), schema, 'Old startup must retain schema levels'); }
    finally { verify.close(); }
    const evidence = { format: 1, targetRef: git(process.cwd(), 'rev-parse', 'HEAD'),
      dataSchema: await schemaLevelFingerprint(process.cwd()), previousRelease: previous,
      schema, checks: ['previous-startup', 'previous-create-start-complete-cancel', 'candidate-expand-startup', 'previous-startup-after-expand', 'previous-create-start-complete-cancel-after-expand'],
      rollbackSafeFrom: [previous.dataSchema] };
    await mkdir(resolve(output, '..'), { recursive: true });
    await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify({ pass: true, previousVersion: previous.version, previousRef: previous.ref, ...schema, rollbackSafeFrom: evidence.rollbackSafeFrom }));
  } finally {
    await rm(probe, { force: true });
    if (created) await admin.unsafe(`DROP DATABASE ${name}`);
    await admin.close();
    if (previousReportDir === undefined) delete process.env.MULTIREMI_MIGRATION_REPORT_DIR;
    else process.env.MULTIREMI_MIGRATION_REPORT_DIR = previousReportDir;
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await main();
}
