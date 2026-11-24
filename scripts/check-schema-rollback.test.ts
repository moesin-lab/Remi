import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { assertCleanCandidate, runCleanups } from './check-schema-rollback.ts';

const here = dirname(fileURLToPath(import.meta.url));
const absent = async (path: string) => assert.rejects(access(path), { code: 'ENOENT' });

/** Isolated orchestration fixture: real child processes and filesystem; tiny
 * candidate/old modules and a fake SQL admin avoid requiring PostgreSQL here.
 * The workflow separately runs the real released Store against PostgreSQL. */
async function fixture(run: (root: string, execute: (mode?: string) => ReturnType<typeof spawnSync>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'rollback-orchestration-'));
  const put = async (path: string, content: string) => {
    const file = join(root, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, content);
  };
  try {
    await mkdir(join(root, 'scripts'));
    await copyFile(join(here, 'check-schema-rollback.ts'), join(root, 'scripts/check-schema-rollback.ts'));
    await put('scripts/schema-rollback-identity.ts', `
      import { readFile } from 'node:fs/promises';
      export async function verifyPreparedRelease(root, manifest) {
        const previous = JSON.parse(await readFile(manifest, 'utf8'));
        if (previous.invalid) throw new Error('invalid prepared release identity');
        return { mode: 'published-archive', publishedRef: previous.ref, actualPreviousRef: previous.ref,
          observedTagRef: 'b'.repeat(40), manifestSha256: 'c'.repeat(64), sourceSha256: 'd'.repeat(64),
          sourceTree: 'e'.repeat(40), provenance: { verified: true } };
      }
    `);
    await put('scripts/schema-rollback-probe.ts', `
      import assert from 'node:assert/strict';
      import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
      import { join } from 'node:path';
      const marker = join(process.env.HOME, 'stage');
      if (process.env.MUL173_EXPECT_TASK) {
        assert.equal(process.env.MUL173_EXPECT_TASK, 'retained-task');
        assert.equal(readFileSync(marker, 'utf8'), 'expanded');
        if (existsSync(join(process.cwd(), 'fail-after'))) {
          console.error('old writer failed after expand'); process.exit(19);
        }
        writeFileSync(marker, 'old-after');
        if (existsSync(join(process.cwd(), 'block-probe-cleanup'))) {
          unlinkSync(import.meta.filename); mkdirSync(import.meta.filename);
        }
      } else {
        assert.equal(existsSync(marker), false); writeFileSync(marker, 'old-before');
      }
      console.error('old writer stderr');
      console.log(JSON.stringify({ pass: true, task: 'retained-task' }));
    `);
    await put('packages/platform-updater/src/schema-fingerprint.mjs', `export async function schemaLevelFingerprint() { return 'f'.repeat(64); }`);
    await put('packages/server/src/store/db/postgres.ts', `export class PostgresSyncDatabase { close() {} }`);
    await put('packages/server/src/store/schema-levels.ts', `
      import { readFileSync } from 'node:fs'; import { join } from 'node:path';
      export function readSchemaLevels() {
        const stage = readFileSync(join(process.env.HOME, 'stage'), 'utf8');
        if (!['expanded', 'old-after'].includes(stage)) throw new Error('wrong probe order');
        return { expandLevel: 3, contractLevel: 0 };
      }
    `);
    await put('packages/server/src/store/migrations.ts', `
      import assert from 'node:assert/strict';
      import { readFileSync, writeFileSync } from 'node:fs'; import { join } from 'node:path';
      export function runMigrations(db, options) { assert.equal(options.historicalMaintenance, true); }
      export function runStartupMigrations() {
        const marker = join(process.env.HOME, 'stage');
        assert.equal(readFileSync(marker, 'utf8'), 'old-before'); writeFileSync(marker, 'expanded');
        console.error('candidate expand stderr');
      }
    `);
    await put('bootstrap.mjs', `
      import assert from 'node:assert/strict';
      import { appendFileSync, writeFileSync, existsSync } from 'node:fs';
      import { spawnSync } from 'node:child_process';
      const evidence = process.cwd() + '/ci-schema/rollback-evidence.json';
      globalThis.Bun = {
        SQL: class {
          async unsafe(sql) {
            assert.equal(existsSync(evidence), false, 'evidence must be absent during database cleanup');
            appendFileSync(process.cwd() + '/ci-schema/admin.log', sql + '\\n');
            if (sql.startsWith('DROP') && process.env.FIXTURE_MODE === 'drop-failure') throw new Error('drop failed');
          }
          async close() { appendFileSync(process.cwd() + '/ci-schema/admin.log', 'closed\\n'); }
        },
        spawnSync(command, options) {
          writeFileSync(process.cwd() + '/ci-schema/temporary-home.txt', options.env.HOME);
          const result = spawnSync(command[0], ['--experimental-strip-types', ...command.slice(1)], options);
          return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status, signalCode: result.signal };
        }
      };
    `);
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
    await put('ci-schema/previous-release.json', JSON.stringify({ ref: 'a'.repeat(40), version: '0.2.95', dataSchema: '1'.repeat(64) }));
    await mkdir(join(root, 'ci-schema/previous/scripts'), { recursive: true });
    await put('ci-schema/rollback-evidence.json', JSON.stringify({ stale: true, rollbackSafeFrom: ['stale'] }));
    const execute = (mode = '') => spawnSync(process.execPath, ['--experimental-strip-types', '--import', join(root, 'bootstrap.mjs'),
      join(root, 'scripts/check-schema-rollback.ts'), 'ci-schema/previous', 'ci-schema/previous-release.json', 'ci-schema/rollback-evidence.json'], {
      cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME,
        FIXTURE_MODE: mode, MULTIREMI_TEST_POSTGRES_URL: 'postgres://test@127.0.0.1/postgres' },
    });
    await run(root, execute);
  } finally { await rm(root, { recursive: true, force: true }); }
}

const readJson = async (root: string, name: string) => JSON.parse(await readFile(join(root, 'ci-schema', name), 'utf8'));

function assertNoDeclaration(diagnostics: unknown) {
  assert.equal(JSON.stringify(diagnostics).includes('rollbackSafeFrom'), false);
}

test('invalid identity in a real CLI subprocess removes stale success before verification', async () => {
  await fixture(async (root, execute) => {
    await writeFile(join(root, 'ci-schema/previous-release.json'), JSON.stringify({ invalid: true }));
    const result = execute();
    assert.notEqual(result.status, 0);
    await absent(join(root, 'ci-schema/rollback-evidence.json'));
    const diagnostic = await readJson(root, 'rollback-diagnostics.json');
    assert.match(diagnostic.error, /invalid prepared release identity/);
    assert.deepEqual(diagnostic.phases, []);
    assertNoDeclaration(diagnostic);
    await absent(join(root, 'ci-schema/previous/scripts/mul173-schema-rollback-probe.ts'));
  });
});

test('candidate rejects tracked and untracked source but accepts generated root ci-schema', async () => {
  await fixture(async root => {
    assertCleanCandidate(root);
    await writeFile(join(root, 'untracked.ts'), 'untracked');
    assert.throws(() => assertCleanCandidate(root), /untracked/);
    await rm(join(root, 'untracked.ts'));
    await writeFile(join(root, 'scripts/schema-rollback-probe.ts'), 'changed');
    assert.throws(() => assertCleanCandidate(root));
  });
});

test('real phase subprocesses run old -> candidate -> same old and retain stdout, stderr and levels', async () => {
  await fixture(async (root, execute) => {
    const result = execute();
    assert.equal(result.status, 0, String(result.stderr));
    const evidence = await readJson(root, 'rollback-evidence.json');
    assert.equal(evidence.targetRef, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim());
    assert.equal(evidence.previousIdentity.mode, 'published-archive');
    assert.equal(evidence.previousIdentity.actualPreviousRef, 'a'.repeat(40));
    assert.equal(evidence.probes.before.task, evidence.probes.after.task);
    assert.deepEqual(evidence.schemaVerification, evidence.schema);
    assert.deepEqual(evidence.phases.map(phase => phase.name), ['previous-before-expand', 'candidate-expand', 'previous-after-expand', 'verify-schema-levels']);
    for (const phase of evidence.phases) {
      assert.equal(phase.status, 'passed'); assert.equal(phase.exitCode, 0);
      assert.match(await readFile(join(root, 'ci-schema', phase.stdout), 'utf8'), /"pass":true/);
      await access(join(root, 'ci-schema', phase.stderr));
    }
    assert.match(await readFile(join(root, 'ci-schema/rollback-logs/candidate-expand.stderr.log'), 'utf8'), /candidate expand stderr/);
    await absent(join(root, 'ci-schema/previous/scripts/mul173-schema-rollback-probe.ts'));
    await absent(await readFile(join(root, 'ci-schema/temporary-home.txt'), 'utf8'));
  });
});

test('old writer failure after expand retains failing logs, clears success and cleans all resources', async () => {
  await fixture(async (root, execute) => {
    await writeFile(join(root, 'ci-schema/previous/fail-after'), '');
    const result = execute();
    assert.notEqual(result.status, 0);
    await absent(join(root, 'ci-schema/rollback-evidence.json'));
    const diagnostic = await readJson(root, 'rollback-diagnostics.json');
    assertNoDeclaration(diagnostic);
    assert.equal(diagnostic.phases.at(-1).name, 'previous-after-expand');
    assert.equal(diagnostic.phases.at(-1).exitCode, 19);
    assert.match(await readFile(join(root, 'ci-schema/rollback-logs/previous-after-expand.stderr.log'), 'utf8'), /old writer failed after expand/);
    assert(diagnostic.cleanup.every(item => item.status === 'passed'));
  });
});

test('database cleanup failure rejects success and still closes admin and removes temporary home', async () => {
  await fixture(async (root, execute) => {
    const result = execute('drop-failure');
    assert.notEqual(result.status, 0);
    await absent(join(root, 'ci-schema/rollback-evidence.json'));
    const diagnostic = await readJson(root, 'rollback-diagnostics.json');
    assertNoDeclaration(diagnostic);
    assert.equal(diagnostic.cleanup.find(item => item.name === 'test-database').status, 'failed');
    assert.equal(diagnostic.cleanup.find(item => item.name === 'admin-connection').status, 'passed');
    assert.match(await readFile(join(root, 'ci-schema/admin.log'), 'utf8'), /DROP DATABASE.*\nclosed\n/);
    await absent(await readFile(join(root, 'ci-schema/temporary-home.txt'), 'utf8'));
  });
});

test('probe cleanup failure does not prevent database, admin or home cleanup', async () => {
  await fixture(async (root, execute) => {
    await writeFile(join(root, 'ci-schema/previous/block-probe-cleanup'), '');
    const result = execute();
    assert.notEqual(result.status, 0);
    await absent(join(root, 'ci-schema/rollback-evidence.json'));
    const diagnostic = await readJson(root, 'rollback-diagnostics.json');
    assert.equal(diagnostic.cleanup[0].name, 'previous-probe');
    assert.equal(diagnostic.cleanup[0].status, 'failed');
    assert(diagnostic.cleanup.slice(1).every(item => item.status === 'passed'));
    await absent(await readFile(join(root, 'ci-schema/temporary-home.txt'), 'utf8'));
  });
});

test('existing probe is rejected without overwrite or deletion', async () => {
  await fixture(async (root, execute) => {
    const probe = join(root, 'ci-schema/previous/scripts/mul173-schema-rollback-probe.ts');
    await writeFile(probe, 'existing probe');
    const result = execute();
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(probe, 'utf8'), 'existing probe');
    await absent(join(root, 'ci-schema/rollback-evidence.json'));
    const diagnostic = await readJson(root, 'rollback-diagnostics.json');
    assert.match(diagnostic.error, /EEXIST/);
    assert(diagnostic.cleanup.every(item => item.status === 'passed'));
  });
});

test('each cleanup is attempted even when multiple earlier cleanups throw', async () => {
  const attempted: string[] = [];
  const results = await runCleanups(['probe', 'database', 'admin', 'temporary'].map(name => ({ name, run() {
    attempted.push(name); if (name !== 'temporary') throw new Error(`${name} failed`);
  } })));
  assert.deepEqual(attempted, ['probe', 'database', 'admin', 'temporary']);
  assert.deepEqual(results.map(item => item.status), ['failed', 'failed', 'failed', 'passed']);
});
