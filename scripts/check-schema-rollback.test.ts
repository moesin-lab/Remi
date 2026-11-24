import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, access, cp, symlink, readdir, lstat, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { assertCleanCandidate, runCleanups } from './check-schema-rollback.ts';
import { rollbackPolicy } from './platform-rollback-policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const absent = async (path: string) => assert.rejects(access(path), { code: 'ENOENT' });
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const dataSchema = sha256(JSON.stringify({ format: 1, expandLevel: 3, contractLevel: 0 }));
const previousRelease = {
  version: '0.2.95', ref: 'a'.repeat(40), dataSchema: '1'.repeat(64), sourceSha256: 'd'.repeat(64),
  releaseUrl: 'https://github.com/moesin-lab/Remi/releases/tag/v0.2.95',
  manifestUrl: 'https://github.com/moesin-lab/Remi/releases/download/v0.2.95/platform-release.json',
  sourceUrl: 'https://github.com/moesin-lab/Remi/releases/download/v0.2.95/platform-systemd-v0.2.95.tar.gz',
  apiImage: 'ghcr.io/moesin-lab/remi-api@sha256:' + '2'.repeat(64),
  notes: '发布前版',
};
// Deliberately preserve formatting, CRLF, trailing whitespace and multibyte UTF8.
const previousManifest = JSON.stringify(previousRelease, null, 2).replaceAll('\n', '\r\n') + ' \r\n';
type Execute = (mode?: string, output?: string) => ReturnType<typeof spawnSync>;

/** Isolated orchestration fixture: real child processes and filesystem; tiny
 * candidate/old modules and a fake SQL admin avoid requiring PostgreSQL here.
 * The workflow separately runs the real released Store against PostgreSQL. */
async function fixture(run: (root: string, execute: Execute) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'rollback-orchestration-'));
  const put = async (path: string, content: string) => {
    const file = join(root, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, content);
  };
  try {
    await mkdir(join(root, 'scripts'));
    await copyFile(join(here, 'check-schema-rollback.ts'), join(root, 'scripts/check-schema-rollback.ts'));
    await copyFile(join(here, 'platform-rollback-policy.mjs'), join(root, 'scripts/platform-rollback-policy.mjs'));
    await put('scripts/schema-rollback-identity.ts', `
      import assert from 'node:assert/strict';
      import { existsSync } from 'node:fs';
      import { readFile } from 'node:fs/promises';
      import { createHash } from 'node:crypto';
      export async function verifyPreparedRelease(root, manifest) {
        assert.equal(existsSync(process.cwd() + '/' + process.env.FIXTURE_OUTPUT), false,
          'stale evidence must be absent before identity verification');
        const bytes = await readFile(manifest);
        const previous = JSON.parse(bytes.toString('utf8'));
        if (previous.invalid) throw new Error('invalid prepared release identity');
        return { format: 1, mode: 'published-archive', publishedRef: previous.ref, actualPreviousRef: previous.ref,
          observedTagRef: 'b'.repeat(40), tagDrift: true,
          manifestSha256: createHash('sha256').update(bytes).digest('hex'), sourceSha256: previous.sourceSha256,
          sourceTree: 'e'.repeat(40), releaseId: 11, manifestAssetId: 12, sourceAssetId: 13,
          provenance: { model: 'verified-api-image+github-publish-log+exact-git-tree', sourceArchiveAttestation: false,
            apiImage: previous.apiImage, runId: '42', attempt: 1, jobId: 43,
            invocation: 'https://github.com/moesin-lab/Remi/actions/runs/42/attempts/1',
            jobUrl: 'https://github.com/moesin-lab/Remi/actions/runs/42/job/43',
            publishLogSha256: '3'.repeat(64), verificationSha256: '4'.repeat(64) } };
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
      const before = { probe: 'previous-release-core', pass: true, task: 'retained-task', cancelled: 'before-cancelled-task' };
      const report = process.env.MUL173_EXPECT_TASK ? { ...before, task: 'new-task', cancelled: 'after-cancelled-task' } : before;
      if (existsSync(join(process.cwd(), 'replay-before')) && process.env.MUL173_EXPECT_TASK) Object.assign(report, before);
      if (existsSync(join(process.cwd(), 'same-task')) ||
        (process.env.MUL173_EXPECT_TASK && existsSync(join(process.cwd(), 'same-task-after')))) report.cancelled = report.task;
      for (const field of ['task', 'cancelled']) {
        for (const original of ['task', 'cancelled']) {
          if (process.env.MUL173_EXPECT_TASK && existsSync(join(process.cwd(), 'reuse-' + field + '-' + original))) report[field] = before[original];
        }
      }
      console.log(JSON.stringify(report));
    `);
    await put('packages/platform-updater/src/schema-fingerprint.mjs', `export async function schemaLevelFingerprint() { return '${dataSchema}'; }`);
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
      const evidence = process.cwd() + '/' + process.env.FIXTURE_OUTPUT;
      globalThis.Bun = {
        SQL: class {
          async unsafe(sql) {
            assert.equal(existsSync(evidence), false, 'evidence must be absent during database cleanup');
            appendFileSync(process.cwd() + '/ci-schema/admin.log', sql + '\\n');
            if (sql.startsWith('DROP') && process.env.FIXTURE_MODE === 'drop-failure') throw new Error('drop failed');
          }
          async close() {
            appendFileSync(process.cwd() + '/ci-schema/admin.log', 'closed\\n');
            if (process.env.FIXTURE_MODE === 'output-collision') writeFileSync(evidence, 'created by another writer');
          }
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
    await put('ci-schema/previous-release.json', previousManifest);
    await mkdir(join(root, 'ci-schema/previous/scripts'), { recursive: true });
    const execute: Execute = (mode = '', output = 'ci-schema/rollback-evidence.json') => spawnSync(process.execPath, ['--experimental-strip-types', '--import', join(root, 'bootstrap.mjs'),
      join(root, 'scripts/check-schema-rollback.ts'), 'ci-schema/previous', 'ci-schema/previous-release.json', output], {
      cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME,
        FIXTURE_MODE: mode, FIXTURE_OUTPUT: output, MULTIREMI_TEST_POSTGRES_URL: 'postgres://test@127.0.0.1/postgres' },
    });
    await run(root, execute);
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function snapshot(root: string) {
  const files: Record<string, unknown> = {};
  const visit = async (directory: string, prefix = '') => {
    for (const name of (await readdir(directory)).sort()) {
      if (name === '.git') continue;
      const path = join(directory, name), key = prefix + name;
      const stat = await lstat(path);
      files[key] = stat.isSymbolicLink() ? { link: await readlink(path) } : stat.isDirectory()
        ? { directory: true } : { mode: stat.mode, bytes: (await readFile(path)).toString('base64') };
      if (stat.isDirectory()) await visit(path, key + '/');
    }
  };
  await visit(root);
  return files;
}

const readJson = async (root: string, name: string) => JSON.parse(await readFile(join(root, 'ci-schema', name), 'utf8'));

function assertNoDeclaration(diagnostics: unknown) {
  assert.equal(JSON.stringify(diagnostics).includes('rollbackSafeFrom'), false);
}

function assertAcceptedEvidence(evidence: any) {
  assert.equal(evidence.previousManifest, previousManifest, 'Preserve the exact published UTF8 manifest text');
  assert.equal(sha256(evidence.previousManifest), evidence.previousIdentity.manifestSha256);
  assert.deepEqual(JSON.parse(evidence.previousManifest), evidence.previousRelease);
  assert.deepEqual(rollbackPolicy({ version: '0.2.96', ref: evidence.targetRef, dataSchema }, undefined, evidence), [previousRelease.dataSchema]);
}

// Root output must not make its own diagnostics fail the candidate clean check.
test('clean candidate publishes root evidence accepted by the real rollback consumer', async () => {
  await fixture(async (root, execute) => {
    const result = execute('', 'rollback-evidence.json');
    assert.equal(result.status, 0, String(result.stderr));
    const evidence = JSON.parse(await readFile(join(root, 'rollback-evidence.json'), 'utf8'));
    assertAcceptedEvidence(evidence);
    const diagnostic = JSON.parse(await readFile(join(root, 'rollback-diagnostics.json'), 'utf8'));
    assert.equal(diagnostic.status, 'passed');
    assertNoDeclaration(diagnostic);
    assert.match(await readFile(join(root, 'rollback-logs/previous-after-expand.stdout.log'), 'utf8'), /"pass":true/);
  });
});

test('root output identity failure retains diagnostics without publishing success', async () => {
  await fixture(async (root, execute) => {
    await writeFile(join(root, 'ci-schema/previous-release.json'), JSON.stringify({ invalid: true }));
    const result = execute('', 'rollback-evidence.json');
    assert.notEqual(result.status, 0);
    await absent(join(root, 'rollback-evidence.json'));
    const diagnostic = JSON.parse(await readFile(join(root, 'rollback-diagnostics.json'), 'utf8'));
    assert.match(diagnostic.error, /invalid prepared release identity/);
    assert.equal(diagnostic.status, 'failed');
    assert.deepEqual(diagnostic.phases, []);
    assertNoDeclaration(diagnostic);
  });
});

test('pre-existing root success is rejected and preserved without any writes', async () => {
  await fixture(async (root, execute) => {
    await writeFile(join(root, 'rollback-evidence.json'), JSON.stringify({ rollbackSafeFrom: ['stale'] }));
    const before = await snapshot(root);
    const result = execute('', 'rollback-evidence.json');
    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /Artifact already exists/);
    assert.deepEqual(await snapshot(root), before);
  });
});

for (const dirty of [
  { name: 'untracked source', path: 'untracked.ts', tracked: false, output: 'ci-schema/rollback-evidence.json' },
  { name: 'tracked source', path: 'scripts/schema-rollback-probe.ts', tracked: true, output: 'ci-schema/rollback-evidence.json' },
  { name: 'untracked root logs', path: 'rollback-logs/untracked.ts', tracked: false, output: 'rollback-evidence.json' },
  { name: 'tracked generated logs', path: 'ci-schema/rollback-logs/tracked.log', tracked: true, output: 'ci-schema/rollback-evidence.json' },
]) {
  test(`dirty candidate rejects ${dirty.name} before output cleanup and preserves the changed file`, async () => {
    await fixture(async (root, execute) => {
      const changed = join(root, dirty.path);
      await mkdir(dirname(changed), { recursive: true });
      if (dirty.tracked && dirty.path.startsWith('ci-schema/')) {
        await writeFile(changed, 'original');
        execFileSync('git', ['add', dirty.path], { cwd: root });
        execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'tracked log fixture'], { cwd: root });
      }
      await writeFile(changed, 'candidate change must survive');
      const before = await snapshot(root);
      const result = execute('', dirty.output);
      assert.notEqual(result.status, 0);
      assert.deepEqual(await snapshot(root), before);
      assert.match(String(result.stderr), dirty.path.includes('rollback-logs') && dirty.tracked
        ? /Artifact overlaps tracked/ : dirty.tracked ? /git diff --quiet HEAD/ : /Artifact already exists|Candidate has untracked files/);
    });
  });
}

for (const scenario of [
  { name: 'tracked output', output: 'bootstrap.mjs' },
  { name: 'dirty tracked output', output: 'scripts/schema-rollback-probe.ts', dirty: true },
  { name: 'clean tracked logs', path: 'ci-schema/rollback-logs/tracked.log', tracked: true },
  { name: 'tracked diagnostics', path: 'ci-schema/rollback-diagnostics.json', tracked: true },
  { name: 'untracked output', path: 'ci-schema/rollback-evidence.json' },
  { name: 'untracked log contents', path: 'ci-schema/rollback-logs/keep.txt' },
  { name: 'untracked diagnostics', path: 'ci-schema/rollback-diagnostics.json' },
  { name: 'output aliases diagnostics', output: 'ci-schema/rollback-diagnostics.json' },
  { name: 'output aliases logs', output: 'ci-schema/rollback-logs' },
  { name: 'output aliases input', output: 'ci-schema/previous-release.json' },
  { name: 'output enters git metadata', output: '.git/new-evidence.json' },
  { name: 'output is ancestor of tracked source', output: 'scripts' },
]) {
  test(`preflight rejects ${scenario.name} without modifying any existing content`, async () => {
    await fixture(async (root, execute) => {
      if (scenario.path) {
        await mkdir(dirname(join(root, scenario.path)), { recursive: true });
        await writeFile(join(root, scenario.path), 'pre-existing content');
        if (scenario.tracked) {
          execFileSync('git', ['add', scenario.path], { cwd: root });
          execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'tracked artifact fixture'], { cwd: root });
        }
      }
      if (scenario.dirty) await writeFile(join(root, scenario.output!), 'dirty source must survive');
      const before = await snapshot(root);
      const result = execute('', scenario.output);
      assert.notEqual(result.status, 0);
      assert.match(String(result.stderr), /Artifact/);
      assert.deepEqual(await snapshot(root), before);
      await absent(join(root, '.git/new-evidence.json'));
    });
  });
}

for (const path of ['ci-schema/rollback-evidence.json', 'ci-schema/rollback-logs', 'ci-schema/linked']) {
  test(`preflight rejects symlink ${path} and preserves its target`, async () => {
    await fixture(async (root, execute) => {
      await mkdir(join(root, 'ci-schema/keep'));
      await writeFile(join(root, 'ci-schema/keep/keep.txt'), 'keep target');
      await symlink(path.endsWith('.json') ? 'keep/keep.txt' : 'keep', join(root, path));
      const before = await snapshot(root);
      const result = execute('', path.endsWith('linked') ? path + '/evidence.json' : undefined);
      assert.notEqual(result.status, 0);
      assert.match(String(result.stderr), /symlink/);
      assert.deepEqual(await snapshot(root), before);
    });
  });
}

for (const mode of ['replay-before', 'same-task', 'same-task-after', 'reuse-task-task', 'reuse-task-cancelled', 'reuse-cancelled-task', 'reuse-cancelled-cancelled']) {
  test(`producer rejects ${mode} reports and cleans resources without success evidence`, async () => {
    await fixture(async (root, execute) => {
      await writeFile(join(root, 'ci-schema/previous', mode), '');
      const result = execute();
      assert.notEqual(result.status, 0);
      await absent(join(root, 'ci-schema/rollback-evidence.json'));
      const diagnostic = await readJson(root, 'rollback-diagnostics.json');
      assert.match(diagnostic.error, /distinct ID/);
      assert.equal(diagnostic.status, 'failed');
      assert(diagnostic.cleanup.every(item => item.status === 'passed'));
      await absent(join(root, 'ci-schema/previous/scripts/mul173-schema-rollback-probe.ts'));
      assertNoDeclaration(diagnostic);
    });
  });
}

test('different clean checkout with the same schema level cannot run this checker or candidate phases', async () => {
  await fixture(async (root, execute) => {
    const other = await mkdtemp(join(tmpdir(), 'rollback-other-candidate-'));
    try {
      await cp(root, other, { recursive: true });
      await writeFile(join(other, 'packages/server/src/store/migrations.ts'), 'throw new Error("A migrations must not execute B");');
      execFileSync('git', ['add', '.'], { cwd: other });
      execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'different migrations same level'], { cwd: other });
      const before = await snapshot(root), otherBefore = await snapshot(other);
      for (const args of [
        [join(other, 'ci-schema/previous'), join(other, 'ci-schema/previous-release.json'), join(other, 'ci-schema/rollback-evidence.json')],
        ['--candidate-expand'], ['--read-schema'],
      ]) {
        const result = spawnSync(process.execPath, ['--experimental-strip-types', '--import', join(root, 'bootstrap.mjs'),
          join(root, 'scripts/check-schema-rollback.ts'), ...args], { cwd: other, encoding: 'utf8',
          env: { PATH: process.env.PATH, HOME: process.env.HOME, MULTIREMI_TEST_POSTGRES_URL: 'postgres://test@127.0.0.1/postgres' } });
        assert.notEqual(result.status, 0);
        assert.match(String(result.stderr), /own candidate repository root/);
        assert.deepEqual(await snapshot(root), before);
        assert.deepEqual(await snapshot(other), otherBefore);
      }
      assert.equal(execute().status, 0, 'matching checkout remains supported');
    } finally { await rm(other, { recursive: true, force: true }); }
  });
});

test('real path aliases of the matching checkout remain supported', async () => {
  await fixture(async root => {
    const temporary = await mkdtemp(join(tmpdir(), 'rollback-root-alias-'));
    try {
      const alias = join(temporary, 'candidate');
      await symlink(root, alias);
      const result = spawnSync(process.execPath, ['--experimental-strip-types', '--import', join(root, 'bootstrap.mjs'),
        join(root, 'scripts/check-schema-rollback.ts'), 'ci-schema/previous', 'ci-schema/previous-release.json', 'ci-schema/rollback-evidence.json'], {
        cwd: alias, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME,
          FIXTURE_OUTPUT: 'ci-schema/rollback-evidence.json', MULTIREMI_TEST_POSTGRES_URL: 'postgres://test@127.0.0.1/postgres' },
      });
      assert.equal(result.status, 0, String(result.stderr));
      assertAcceptedEvidence(await readJson(root, 'rollback-evidence.json'));
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
});

test('output created by another writer during cleanup is preserved and rejects publication', async () => {
  await fixture(async (root, execute) => {
    const result = execute('output-collision');
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(join(root, 'ci-schema/rollback-evidence.json'), 'utf8'), 'created by another writer');
    const diagnostic = await readJson(root, 'rollback-diagnostics.json');
    assert.equal(diagnostic.status, 'failed');
    assert.match(diagnostic.error, /EEXIST/);
    assert(diagnostic.cleanup.every(item => item.status === 'passed'));
    assertNoDeclaration(diagnostic);
    await absent(join(root, 'ci-schema/previous/scripts/mul173-schema-rollback-probe.ts'));
    await absent(await readFile(join(root, 'ci-schema/temporary-home.txt'), 'utf8'));
  });
});

test('invalid identity in a real CLI subprocess never publishes success', async () => {
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
    assert.equal(evidence.probes.before.task, 'retained-task');
    assert.equal(evidence.probes.after.task, 'new-task');
    assertAcceptedEvidence(evidence);
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
