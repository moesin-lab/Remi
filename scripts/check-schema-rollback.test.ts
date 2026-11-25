import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, access, symlink, readdir, lstat, readlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { runCleanups } from './check-schema-rollback.ts';
import { rollbackPolicy } from './platform-rollback-policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const absent = async (path: string) => assert.rejects(access(path), { code: 'ENOENT' });
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const dataSchema = sha256(JSON.stringify({ format: 1, expandLevel: 3, contractLevel: 0 }));
const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const head = (root: string) => git(root, 'rev-parse', 'HEAD');
const commit = (root: string, message: string) => git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message);
const previousRelease = {
  version: '0.2.95', ref: 'a'.repeat(40), dataSchema: '1'.repeat(64), sourceSha256: 'd'.repeat(64),
  releaseUrl: 'https://github.com/moesin-lab/Remi/releases/tag/v0.2.95',
  manifestUrl: 'https://github.com/moesin-lab/Remi/releases/download/v0.2.95/platform-release.json',
  sourceUrl: 'https://github.com/moesin-lab/Remi/releases/download/v0.2.95/platform-systemd-v0.2.95.tar.gz',
  apiImage: 'ghcr.io/moesin-lab/remi-api@sha256:' + '2'.repeat(64), notes: '发布前版',
};
// Preserve formatting, CRLF, trailing whitespace and multibyte UTF8, not a reserialization.
const previousManifest = JSON.stringify(previousRelease, null, 2).replaceAll('\n', '\r\n') + ' \r\n';
const innerCleanup = ['previous-probe', 'test-database', 'admin-connection', 'temporary-home'];
type Context = {
  format: number; runId: string; runRoot: string; candidateRoot: string; expectedRef: string; expectedTree: string;
  artifactRoot: string; lockfileSha256: string; installationDirectories: string[]; runtime: { node: string; bun: string };
};
type Options = { output?: string; cwd?: string; script?: string; contextPath?: string | null; contextDigest?: string | null;
  previousRoot?: string; manifestPath?: string };
type Fixture = {
  sandbox: string; runRoot: string; root: string; control: string; contextPath: string; context: Context;
  previousInput: string; previousRoot: string; manifestPath: string; artifactRoot: string; output: string;
  execute: (mode?: string, options?: Options) => ReturnType<typeof spawnSync>;
  args: (options?: Options) => string[]; env: (mode?: string, options?: Options) => NodeJS.ProcessEnv;
  verify: () => Promise<unknown>;
};

/** Real private Git clone and candidate-context helper; only old-release identity,
 * SQL admin and Store modules are fixture substitutes. No helper validation is mocked. */
async function fixture(run: (f: Fixture) => Promise<void>) {
  const sandbox = await mkdtemp(join(tmpdir(), 'rollback-private-orchestration-'));
  const seed = join(sandbox, 'source');
  const runId = randomUUID();
  const runRoot = join(sandbox, `schema-rollback-${runId}`), root = join(runRoot, 'candidate'), control = join(runRoot, 'control');
  const previousInput = join(runRoot, 'previous-input'), previousRoot = join(previousInput, 'previous');
  const manifestPath = join(previousInput, 'previous-release.json'), artifactRoot = join(sandbox, 'artifacts');
  const contextPath = join(control, 'run-context.json'), output = join(artifactRoot, 'rollback-staged-result.json');
  const put = async (path: string, content: string) => {
    const file = join(seed, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, content);
  };
  try {
    await mkdir(join(seed, 'scripts'), { recursive: true });
    for (const name of ['check-schema-rollback.ts', 'platform-rollback-policy.mjs', 'schema-rollback-candidate.mjs', 'run-schema-rollback.mjs']) {
      await copyFile(join(here, name), join(seed, 'scripts', name));
    }
    await put('package.json', JSON.stringify({ name: 'private-checker-fixture', version: '0.2.96', private: true, type: 'module', workspaces: [] }));
    await put('bun.lock', '{"lockfileVersion":1,"workspaces":{"":{"name":"private-checker-fixture"}}}\n');
    await put('bunfig.toml', '[install]\nregistry = "https://registry.npmjs.org"\n');
    await put('.gitignore', 'node_modules/\nci-schema/\n.env\n.cache/\n');
    await put('scripts/schema-rollback-identity.ts', `
      import assert from 'node:assert/strict';
      import { existsSync, readFileSync } from 'node:fs';
      import { readFile, writeFile } from 'node:fs/promises';
      import { dirname, join } from 'node:path';
      import { createHash } from 'node:crypto';
      export async function verifyPreparedRelease(root, manifest) {
        const ctx = JSON.parse(readFileSync(process.env.SCHEMA_ROLLBACK_RUN_CONTEXT, 'utf8'));
        assert.equal(root, join(ctx.runRoot, 'previous-input/previous'));
        assert.equal(manifest, join(ctx.runRoot, 'previous-input/previous-release.json'));
        assert.equal(existsSync(join(ctx.artifactRoot, 'rollback-staged-result.json')), false);
        const bytes = await readFile(manifest);
        const previous = JSON.parse(bytes.toString('utf8'));
        if (process.env.FIXTURE_MODE === 'identity-barrier') {
          await writeFile(join(dirname(process.env.SCHEMA_ROLLBACK_RUN_CONTEXT), 'identity-entered'), 'waiting');
          while (!existsSync(join(dirname(process.env.SCHEMA_ROLLBACK_RUN_CONTEXT), 'identity-release'))) {
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
        if (previous.invalid) throw new Error('invalid prepared release identity');
        return { format: 1, mode: 'published-archive', description: previous.notes + '🌱', publishedRef: previous.ref, actualPreviousRef: previous.ref,
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
        if (existsSync(join(process.cwd(), 'fail-after'))) { console.error('old writer failed after expand'); process.exit(19); }
        writeFileSync(marker, 'old-after');
        if (existsSync(join(process.cwd(), 'block-probe-cleanup'))) { unlinkSync(import.meta.filename); mkdirSync(import.meta.filename); }
      } else {
        assert.equal(existsSync(marker), false); writeFileSync(marker, 'old-before');
      }
      console.error('old writer stderr');
      const before = { probe: 'previous-release-core', pass: true, task: 'retained-task', cancelled: 'before-cancelled-task' };
      const report = process.env.MUL173_EXPECT_TASK ? { ...before, task: 'new-task', cancelled: 'after-cancelled-task' } : before;
      if (existsSync(join(process.cwd(), 'replay-before')) && process.env.MUL173_EXPECT_TASK) Object.assign(report, before);
      if (existsSync(join(process.cwd(), 'same-task')) ||
          (process.env.MUL173_EXPECT_TASK && existsSync(join(process.cwd(), 'same-task-after')))) report.cancelled = report.task;
      for (const field of ['task', 'cancelled']) for (const original of ['task', 'cancelled']) {
        if (process.env.MUL173_EXPECT_TASK && existsSync(join(process.cwd(), 'reuse-' + field + '-' + original))) report[field] = before[original];
      }
      console.log(JSON.stringify(report));
    `);
    await put('packages/platform-updater/src/schema-fingerprint.mjs', `export async function schemaLevelFingerprint() { return '${dataSchema}'; }`);
    await put('scripts/fixture-drift.mjs', `
      import { appendFileSync, writeFileSync, readFileSync } from 'node:fs';
      import { dirname, join } from 'node:path';
      import { execFileSync } from 'node:child_process';
      export const context = () => JSON.parse(readFileSync(process.env.SCHEMA_ROLLBACK_RUN_CONTEXT, 'utf8'));
      export const fixtureMode = () => readFileSync(join(dirname(process.env.SCHEMA_ROLLBACK_RUN_CONTEXT), 'fixture-mode'), 'utf8');
      export function mutateCandidate(kind) {
        const ctx = context(), cwd = ctx.candidateRoot;
        const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
        const before = head(), source = 'packages/server/src/store/migrations.ts';
        if (kind === 'untracked' || kind === 'ignored') writeFileSync(join(cwd, kind === 'ignored' ? '.env' : 'unexpected-source.ts'), 'EXTRA_SOURCE=true');
        else appendFileSync(join(cwd, source), '\\nconsole.error("MUTATED_CANDIDATE_SOURCE_EXECUTED");\\n');
        if (kind === 'head') {
          execFileSync('git', ['add', source], { cwd });
          execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'private drift same level'], { cwd });
        }
        if (kind === 'index') execFileSync('git', ['update-index', '--assume-unchanged', source], { cwd });
        writeFileSync(join(ctx.artifactRoot, 'drift-applied.json'), JSON.stringify({ kind, before, after: head() }));
      }
    `);
    await put('packages/server/src/store/db/postgres.ts', `
      import { fixtureMode, mutateCandidate } from '../../../../../scripts/fixture-drift.mjs';
      export class PostgresSyncDatabase {
        constructor() { if (fixtureMode().startsWith('drift-constructor-')) mutateCandidate(fixtureMode().split('-').at(-1)); }
        close() {}
      }
    `);
    await put('packages/server/src/store/schema-levels.ts', `
      import { readFileSync } from 'node:fs'; import { join } from 'node:path';
      export function readSchemaLevels() {
        if (!['expanded', 'old-after'].includes(readFileSync(join(process.env.HOME, 'stage'), 'utf8'))) throw new Error('wrong probe order');
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
      import { join } from 'node:path';
      import { spawnSync } from 'node:child_process';
      import { context, mutateCandidate } from './scripts/fixture-drift.mjs';
      import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      const mode = process.env.FIXTURE_MODE ?? '';
      if (mode.startsWith('diagnostic-')) {
        const originalOpen = fs.open;
        let opens = 0;
        fs.open = async (path, ...args) => {
          const file = await originalOpen(path, ...args);
          if (!String(path).endsWith('/rollback-diagnostics.json')) return file;
          const ordinal = ++opens, truncate = file.truncate.bind(file), write = file.write.bind(file), close = file.close.bind(file);
          let snapshot = 0, writes = 0, active = false;
          const record = event => appendFileSync(join(context().artifactRoot, 'diagnostic-io.jsonl'), JSON.stringify({ ordinal, snapshot, ...event }) + '\\n');
          file.truncate = async (...args) => { snapshot++; writes = 0; active = false; return truncate(...args); };
          file.write = async (...args) => {
            const buffered = Buffer.isBuffer(args[0]);
            const bytes = buffered ? args[0] : Buffer.from(args[0], 'utf8');
            const offset = buffered ? args[1] : 0, length = buffered ? args[2] : bytes.length, position = buffered ? args[3] : args[1];
            if (!writes) {
              const report = JSON.parse(bytes.toString('utf8'));
              active = mode.includes('-initial-') || (mode.includes('phase-error') && report.phases.some(phase => phase.status === 'failed')) ||
                (report.status === 'passed' && report.cleanup?.length === 4) || ordinal > 1;
            }
            writes++;
            if (!active) return write(...args);
            if (writes > 12) throw new Error('diagnostic test guard: no progress');
            const remaining = bytes.subarray(offset, offset + length);
            const strategy = ordinal > 1 ? (mode.split('-recovery-')[1] ?? '') : mode.split('-recovery-')[0];
            let count = length;
            if (strategy.includes('short-once') && writes === 1) count = 1;
            if (strategy.includes('short-many') && writes <= 5) {
              const multibyte = remaining.findIndex(byte => byte >= 0xc0);
              count = multibyte >= 0 ? multibyte + 1 : 1;
            }
            if (strategy.includes('short-zero')) count = writes === 1 ? 1 : 0;
            else if (strategy.includes('zero')) count = 0;
            if (strategy.includes('short-throw') && writes === 1) count = 1;
            else if (strategy.includes('throw')) { record({ kind: 'throw' }); throw new Error(ordinal > 1 ? 'diagnostic recovery fault' : 'diagnostic save fault'); }
            if (strategy.includes('invalid-negative')) count = -1;
            if (strategy.includes('invalid-fraction')) count = 0.5;
            if (strategy.includes('invalid-nan')) count = NaN;
            if (strategy.includes('invalid-overrun')) count = length + 1;
            record({ kind: 'write', buffered, offset, length, position, count, bytes: writes === 1 ? bytes.toString('base64') : undefined,
              splitUtf8: count > 0 && count < length && (remaining[count] & 0xc0) === 0x80 });
            if (Number.isInteger(count) && count >= 0 && count <= length) await write(remaining, 0, count, position);
            return { bytesWritten: count, buffer: args[0] };
          };
          file.close = async () => {
            record({ kind: 'close' });
            await close();
            if (mode.includes('close-failure')) throw new Error('diagnostic close fault');
          };
          return file;
        };
        syncBuiltinESMExports();
      }
      globalThis.Bun = {
        SQL: class {
          async unsafe(sql) {
            const ctx = context();
            assert.equal(existsSync(join(ctx.artifactRoot, 'rollback-staged-result.json')), false);
            appendFileSync(join(ctx.artifactRoot, 'admin.log'), sql + '\\n');
            if (sql.startsWith('DROP') && process.env.FIXTURE_MODE === 'drop-failure') throw new Error('drop failed');
          }
          async close() {
            const ctx = context();
            appendFileSync(join(ctx.artifactRoot, 'admin.log'), 'closed\\n');
            if (process.env.FIXTURE_MODE?.includes('output-collision')) writeFileSync(join(ctx.artifactRoot, 'rollback-staged-result.json'), 'created by another writer');
            if (process.env.FIXTURE_MODE?.startsWith('drift-publication-')) mutateCandidate(process.env.FIXTURE_MODE.split('-').at(-1));
          }
        },
        spawnSync(command, options) {
          const ctx = context(), phase = command.at(-1);
          writeFileSync(join(ctx.artifactRoot, 'temporary-home.txt'), options.env.HOME);
          if (phase === '--candidate-expand' || phase === '--read-schema') {
            appendFileSync(join(ctx.artifactRoot, 'candidate-context-env.jsonl'), JSON.stringify({ phase,
              contextPath: options.env.SCHEMA_ROLLBACK_RUN_CONTEXT, contextDigest: options.env.SCHEMA_ROLLBACK_CONTEXT_SHA256 }) + '\\n');
            const stage = phase === '--candidate-expand' ? 'expand' : 'read';
            if (process.env.FIXTURE_MODE?.startsWith('drift-' + stage + '-')) mutateCandidate(process.env.FIXTURE_MODE.split('-').at(-1));
          }
          const result = spawnSync(command[0], ['--experimental-strip-types', ...command.slice(1)], options);
          if ((phase === '--candidate-expand' || phase === '--read-schema') && process.env.FIXTURE_MODE?.startsWith('tamper-')) {
            const [, target, field] = process.env.FIXTURE_MODE.split('-');
            if ((target === 'expand' ? '--candidate-expand' : '--read-schema') === phase && result.status === 0) {
              const lines = result.stdout.toString().trim().split('\\n'), report = JSON.parse(lines.pop());
              report.candidateExecution[field] = field === 'runId' ? '00000000-0000-4000-8000-000000000000' : 'b'.repeat(40);
              lines.push(JSON.stringify(report)); result.stdout = Buffer.from(lines.join('\\n') + '\\n');
            }
          }
          return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status, signalCode: result.signal };
        }
      };
    `);
    git(seed, 'init', '-q'); git(seed, 'add', '.'); commit(seed, 'private fixture including real candidate verifier');
    await mkdir(runRoot, { mode: 0o700 }); await chmod(runRoot, 0o700);
    execFileSync('git', ['clone', '-q', '--no-local', '--no-checkout', seed, root]);
    git(root, 'checkout', '-q', '--detach', head(seed));
    git(root, 'remote', 'set-url', 'origin', 'https://github.com/moesin-lab/Remi.git');
    await mkdir(control, { mode: 0o700 });
    await mkdir(join(previousRoot, 'scripts'), { recursive: true });
    await writeFile(manifestPath, previousManifest);
    await mkdir(artifactRoot, { mode: 0o700 });
    const context: Context = { format: 1, runId, runRoot, candidateRoot: root,
      expectedRef: head(root), expectedTree: git(root, 'rev-parse', 'HEAD^{tree}'), artifactRoot,
      lockfileSha256: sha256(await readFile(join(root, 'bun.lock'))), installationDirectories: ['node_modules'],
      runtime: { node: process.version, bun: '1.3.14' } };
    const contextBytes = JSON.stringify(context), contextDigest = sha256(contextBytes);
    await writeFile(contextPath, contextBytes); await writeFile(join(control, 'fixture-mode'), '');
    const args = (options: Options = {}) => ['--experimental-strip-types', '--import', join(root, 'bootstrap.mjs'),
      options.script ?? join(root, 'scripts/check-schema-rollback.ts'), options.previousRoot ?? previousRoot,
      options.manifestPath ?? manifestPath, options.output ?? output];
    const env = (mode = '', options: Options = {}): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: process.env.HOME,
      FIXTURE_MODE: mode, MULTIREMI_TEST_POSTGRES_URL: 'postgres://test@127.0.0.1/postgres',
      ...(options.contextPath === null ? {} : { SCHEMA_ROLLBACK_RUN_CONTEXT: options.contextPath ?? contextPath,
        ...(options.contextDigest === null ? {} : { SCHEMA_ROLLBACK_CONTEXT_SHA256: options.contextDigest ?? contextDigest }) }) });
    const helper = await import(pathToFileURL(join(root, 'scripts/schema-rollback-candidate.mjs')).href);
    const verify = async () => {
      const originalDigest = process.env.SCHEMA_ROLLBACK_CONTEXT_SHA256;
      process.env.SCHEMA_ROLLBACK_CONTEXT_SHA256 = contextDigest;
      try { return await helper.verifyCandidate(await helper.loadCandidateContext(contextPath, root)); }
      finally {
        if (originalDigest === undefined) delete process.env.SCHEMA_ROLLBACK_CONTEXT_SHA256;
        else process.env.SCHEMA_ROLLBACK_CONTEXT_SHA256 = originalDigest;
      }
    };
    await verify();
    const execute: Fixture['execute'] = (mode = '', options = {}) => {
      // Controls and logs live outside candidate; no blanket generated-source exemption.
      execFileSync(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], process.argv[2])', join(control, 'fixture-mode'), mode]);
      return spawnSync(process.execPath, args(options), { cwd: options.cwd ?? root, encoding: 'utf8', env: env(mode, options) });
    };
    await run({ sandbox, runRoot, root, control, contextPath, context, previousInput, previousRoot, manifestPath, artifactRoot, output, execute, args, env, verify });
  } finally { await rm(sandbox, { recursive: true, force: true }); }
}

async function snapshot(root: string) {
  const files: Record<string, unknown> = {};
  const visit = async (directory: string, prefix = '') => {
    for (const name of (await readdir(directory)).sort()) {
      if (name === '.git') continue;
      const path = join(directory, name), key = prefix + name, stat = await lstat(path);
      files[key] = stat.isSymbolicLink() ? { link: await readlink(path) } : stat.isDirectory()
        ? { directory: true } : { mode: stat.mode, bytes: (await readFile(path)).toString('base64') };
      if (stat.isDirectory()) await visit(path, key + '/');
    }
  };
  await visit(root); return files;
}
const readJson = async (f: Fixture, name: string) => JSON.parse(await readFile(join(f.artifactRoot, name), 'utf8'));
function assertNoDeclaration(diagnostics: unknown) { assert.equal(JSON.stringify(diagnostics).includes('rollbackSafeFrom'), false); }
function assertStagedEvidence(f: Fixture, evidence: any) {
  assert.equal(evidence.format, 2);
  assert.equal(evidence.previousManifest, previousManifest);
  assert.equal(sha256(evidence.previousManifest), evidence.previousIdentity.manifestSha256);
  assert.deepEqual(JSON.parse(evidence.previousManifest), evidence.previousRelease);
  assert.equal(evidence.targetRef, f.context.expectedRef);
  assert.equal(evidence.dataSchema, dataSchema);
  const report = { runId: f.context.runId, ref: f.context.expectedRef, tree: f.context.expectedTree };
  assert.deepEqual(evidence.candidatePhases, { expand: report, verify: report });
  assert.deepEqual(evidence.candidateExecution, { format: 1, mode: 'private-fixed-commit', runId: f.context.runId,
    expectedRef: f.context.expectedRef, actualRef: f.context.expectedRef, expectedTree: f.context.expectedTree,
    finalTree: f.context.expectedTree, lockfileSha256: f.context.lockfileSha256, runtime: f.context.runtime });
  assert.deepEqual(evidence.cleanup.map(item => [item.name, item.status]), innerCleanup.map(name => [name, 'passed']));
  // The checker does not own outer cleanup: staging must never be consumable as a final attestation.
  assert.throws(() => rollbackPolicy({ version: '0.2.96', ref: evidence.targetRef, dataSchema }, undefined, evidence));
}
async function assertResourcesCleaned(f: Fixture, diagnostics: any) {
  assert.deepEqual(diagnostics.cleanup.map(item => [item.name, item.status]), innerCleanup.map(name => [name, 'passed']));
  await absent(join(f.previousRoot, 'scripts/mul173-schema-rollback-probe.ts'));
  assert.match(await readFile(join(f.artifactRoot, 'admin.log'), 'utf8'), /CREATE DATABASE.*\nDROP DATABASE.*\nclosed\n/);
  await absent(await readFile(join(f.artifactRoot, 'temporary-home.txt'), 'utf8'));
}
async function assertDriftFailure(f: Fixture, result: { status: number | null; stderr: unknown }) {
  assert.notEqual(result.status, 0, String(result.stderr)); await absent(f.output);
  const diagnostic = await readJson(f, 'rollback-diagnostics.json');
  assert.equal(diagnostic.status, 'failed'); assertNoDeclaration(diagnostic);
  assert.match(diagnostic.error, /candidate|HEAD|tree|source|tracked|extra|unexpected/i);
  if (diagnostic.cleanup.length) await assertResourcesCleaned(f, diagnostic);
  else { await absent(join(f.artifactRoot, 'admin.log')); await absent(join(f.artifactRoot, 'temporary-home.txt')); }
  for (const phase of diagnostic.phases) {
    assert.doesNotMatch(await readFile(join(f.artifactRoot, phase.stderr), 'utf8'), /MUTATED_CANDIDATE_SOURCE_EXECUTED/);
  }
  return diagnostic;
}
async function applyPrivateDrift(f: Fixture, kind: string) {
  const source = 'packages/server/src/store/migrations.ts';
  if (kind === 'untracked' || kind === 'ignored') await writeFile(join(f.root, kind === 'ignored' ? '.env' : 'unexpected-source.ts'), 'EXTRA_SOURCE=true');
  else await writeFile(join(f.root, source), await readFile(join(f.root, source), 'utf8') + '\nconsole.error("MUTATED_CANDIDATE_SOURCE_EXECUTED");\n');
  if (kind === 'head') { git(f.root, 'add', source); commit(f.root, 'private same-level new HEAD'); }
  if (kind === 'index') git(f.root, 'update-index', '--assume-unchanged', source);
}
async function executeDuringIdentity(f: Fixture, change: () => Promise<void>) {
  const child = spawn(process.execPath, f.args(), { cwd: f.root, env: f.env('identity-barrier'), stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
  let stderr = '', stdout = '', closed = false;
  child.stderr.on('data', data => { stderr += data.toString(); }); child.stdout.on('data', data => { stdout += data.toString(); });
  const finished = new Promise<number | null>(resolve => child.once('close', code => { closed = true; resolve(code); }));
  try {
    const deadline = Date.now() + 10000;
    while (true) {
      try { await access(join(f.control, 'identity-entered')); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      assert(!closed && Date.now() < deadline, `Checker did not reach identity barrier: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await change(); await writeFile(join(f.control, 'identity-release'), 'continue');
    return { status: await finished, stderr, stdout };
  } finally { if (!closed) child.kill('SIGKILL'); await finished; }
}

for (const kind of ['dirty', 'head', 'untracked', 'ignored', 'index']) {
  test(`private ${kind} drift during asynchronous identity verification rejects staging with diagnostics`, async () => {
    await fixture(async f => {
      const result = await executeDuringIdentity(f, () => applyPrivateDrift(f, kind));
      if (kind === 'head') assert.notEqual(head(f.root), f.context.expectedRef);
      else assert.equal(head(f.root), f.context.expectedRef);
      if (kind === 'head' || kind === 'index') assert.equal(spawnSync('git', ['diff', '--quiet', 'HEAD'], { cwd: f.root }).status, 0);
      await assert.rejects(f.verify(), undefined, 'Real helper must reject the actual private bytes/inventory');
      const diagnostic = await assertDriftFailure(f, result);
      assert.equal(diagnostic.targetRef, f.context.expectedRef);
      assert.deepEqual(diagnostic.cleanup, []); assert.deepEqual(diagnostic.phases, []);
    });
  });
}
for (const stage of ['expand', 'read']) for (const kind of ['dirty', 'head']) {
  test(`private ${stage} child rejects ${kind} drift before loading candidate modules`, async () => {
    await fixture(async f => {
      const result = f.execute(`drift-${stage}-${kind}`);
      assert.equal((await readJson(f, 'drift-applied.json')).before, f.context.expectedRef);
      const diagnostic = await assertDriftFailure(f, result);
      assert.equal(diagnostic.phases.at(-1).name, stage === 'expand' ? 'candidate-expand' : 'verify-schema-levels');
      assert.equal(diagnostic.phases.at(-1).status, 'failed');
    });
  });
}
for (const kind of ['dirty', 'head']) {
  test(`private candidate rejects ${kind} drift after database construction before migration import`, async () => {
    await fixture(async f => {
      const result = f.execute(`drift-constructor-${kind}`); await readJson(f, 'drift-applied.json');
      const diagnostic = await assertDriftFailure(f, result);
      assert.equal(diagnostic.phases.at(-1).name, 'candidate-expand'); assert.equal(diagnostic.phases.at(-1).status, 'failed');
    });
  });
}
for (const kind of ['dirty', 'head', 'untracked', 'ignored']) {
  test(`private ${kind} drift during cleanup rejects staging after all inner resources are cleaned`, async () => {
    await fixture(async f => {
      const result = f.execute(`drift-publication-${kind}`); await readJson(f, 'drift-applied.json');
      const diagnostic = await assertDriftFailure(f, result);
      assert.equal(diagnostic.phases.length, 4); assert(diagnostic.phases.every(phase => phase.status === 'passed'));
      assert.equal(diagnostic.cleanup.length, 4);
    });
  });
}

for (const mode of ['short-once', 'short-many']) {
  test(`checker diagnostic ${mode} completes UTF8 bytes before staging`, async () => {
    await fixture(async f => {
      const result = f.execute(`diagnostic-${mode}`);
      assert.equal(result.status, 0, String(result.stderr));
      assertStagedEvidence(f, await readJson(f, 'rollback-staged-result.json'));
      const bytes = await readFile(join(f.artifactRoot, 'rollback-diagnostics.json'));
      assert(bytes.length > 1, `Checker exited 0 and staged success with diagnostic bytes: ${bytes.toString('utf8')}`);
      const diagnostic = JSON.parse(bytes.toString('utf8'));
      assert.equal(diagnostic.status, 'passed'); assertNoDeclaration(diagnostic);
      assert.match(diagnostic.previousIdentity ? JSON.stringify(diagnostic) : '', /发布前版|published-archive/);
      const events = (await readFile(join(f.artifactRoot, 'diagnostic-io.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const writes = events.filter(event => event.kind === 'write');
      assert.equal(writes.length, mode === 'short-once' ? 2 : 6);
      assert.deepEqual(bytes, Buffer.from(writes[0].bytes, 'base64'));
      let position = 0;
      for (const call of writes) {
        assert.equal(call.buffered, true); assert.equal(call.offset, position); assert.equal(call.position, position);
        assert.equal(call.length, bytes.length - position); position += call.count;
      }
      assert.equal(position, bytes.length);
      if (mode === 'short-many') assert(writes.some(call => call.splitUtf8), 'Must split multibyte UTF8');
      assertStagedEvidence(f, await readJson(f, 'rollback-staged-result.json'));
      await assertResourcesCleaned(f, diagnostic); await absent(join(f.artifactRoot, 'rollback-evidence.json'));
    });
  });
}
for (const stage of ['initial', 'final']) for (const fault of ['first-zero', 'short-zero', 'first-throw', 'short-throw',
  'invalid-negative', 'invalid-fraction', 'invalid-nan', 'invalid-overrun']) {
  test(`checker diagnostic ${stage} ${fault} rejects staging without looping`, async () => {
    await fixture(async f => {
      const result = f.execute(`diagnostic-${stage}-${fault}`);
      assert.notEqual(result.status, 0); await absent(f.output); await absent(join(f.artifactRoot, 'rollback-evidence.json'));
      assert.doesNotMatch(String(result.stdout), /"pass":true/);
      assert.match(String(result.stderr), fault.includes('throw') ? /diagnostic save fault/ : /Diagnostic write made invalid progress/);
      assert.doesNotMatch(String(result.stderr), /test guard/);
      const events = (await readFile(join(f.artifactRoot, 'diagnostic-io.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const first = events.filter(event => event.ordinal === 1 && event.snapshot === events[0].snapshot && ['write', 'throw'].includes(event.kind));
      assert.equal(first.length, fault.startsWith('short') ? 2 : 1);
      assert(events.some(event => event.kind === 'close'));
      if (stage === 'final') {
        await absent(join(f.previousRoot, 'scripts/mul173-schema-rollback-probe.ts'));
        assert.match(await readFile(join(f.artifactRoot, 'admin.log'), 'utf8'), /DROP DATABASE.*\nclosed\n/);
        await absent(await readFile(join(f.artifactRoot, 'temporary-home.txt'), 'utf8'));
      } else await absent(join(f.artifactRoot, 'admin.log'));
    });
  });
}
for (const mode of ['initial-first-throw-close-failure-recovery-short-once', 'short-throw-close-failure-recovery-throw',
  'close-failure', 'close-failure-recovery-zero', 'close-failure-recovery-throw']) {
  test(`checker diagnostic ${mode} preserves the first error through recovery`, async () => {
    await fixture(async f => {
      const result = f.execute(`diagnostic-${mode}`);
      assert.notEqual(result.status, 0); await absent(f.output); await absent(join(f.artifactRoot, 'rollback-evidence.json'));
      assert.match(String(result.stderr), mode.split('-recovery-')[0].includes('throw') ? /diagnostic save fault/ : /diagnostic close fault/);
      assert.doesNotMatch(String(result.stderr), /\nError: diagnostic recovery fault|\nError: diagnostic test guard/);
      assert.doesNotMatch(String(result.stdout), /"pass":true/);
      const events = (await readFile(join(f.artifactRoot, 'diagnostic-io.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(events.filter(event => event.kind === 'close' && event.ordinal === 1).length, 2);
      assert(events.some(event => event.ordinal === 2), 'Must attempt recovery');
      if (mode.endsWith('recovery-short-once')) {
        assert.equal(events.filter(event => event.kind === 'write' && event.ordinal === 2).length, 2);
        const diagnostic = await readJson(f, 'rollback-diagnostics.json');
        assert.equal(diagnostic.status, 'failed'); assert.match(diagnostic.error, /diagnostic save fault/);
      }
    });
  });
}
test('checker preserves the original identity error when diagnostic close and recovery fail', async () => {
  await fixture(async f => {
    await writeFile(f.manifestPath, JSON.stringify({ invalid: true }));
    const result = f.execute('diagnostic-close-failure-recovery-throw');
    assert.notEqual(result.status, 0); await absent(f.output); await absent(join(f.artifactRoot, 'rollback-evidence.json'));
    assert.match(String(result.stderr), /invalid prepared release identity/);
    assert.doesNotMatch(String(result.stderr), /diagnostic close fault|diagnostic recovery fault/);
  });
});

test('checker preserves failed phase through diagnostic save, close and recovery failures', async () => {
  await fixture(async f => {
    await writeFile(join(f.previousRoot, 'fail-after'), '');
    const result = f.execute('diagnostic-phase-error-first-throw-close-failure-recovery-throw');
    assert.notEqual(result.status, 0); await absent(f.output); await absent(join(f.artifactRoot, 'rollback-evidence.json'));
    assert.match(String(result.stderr), /previous-after-expand failed \(19\)/);
    assert.doesNotMatch(String(result.stderr), /\nError: diagnostic (save|close|recovery) fault/);
    await absent(join(f.previousRoot, 'scripts/mul173-schema-rollback-probe.ts'));
    await absent(await readFile(join(f.artifactRoot, 'temporary-home.txt'), 'utf8'));
    assert.match(await readFile(join(f.artifactRoot, 'admin.log'), 'utf8'), /DROP DATABASE.*\nclosed\n/);
  });
});

test('checker preserves staging collision and caller bytes when diagnostic recovery fails', async () => {
  await fixture(async f => {
    const result = f.execute('diagnostic-output-collision-recovery-throw');
    assert.notEqual(result.status, 0); assert.match(String(result.stderr), /EEXIST/);
    assert.doesNotMatch(String(result.stderr), /\nError: diagnostic recovery fault/);
    assert.equal(await readFile(f.output, 'utf8'), 'created by another writer');
    await absent(join(f.artifactRoot, 'rollback-evidence.json'));
  });
});

test('private context and all candidate identity reports bind the same fixed SHA/tree/run', async () => {
  await fixture(async f => {
    const result = f.execute(); assert.equal(result.status, 0, String(result.stderr));
    assertStagedEvidence(f, await readJson(f, 'rollback-staged-result.json'));
    const records = (await readFile(join(f.artifactRoot, 'candidate-context-env.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(records.map(record => record.phase), ['--candidate-expand', '--read-schema']);
    for (const record of records) {
      assert.equal(record.contextPath, f.contextPath);
      assert.equal(record.contextDigest, sha256(await readFile(f.contextPath)));
    }
    for (const phase of ['candidate-expand', 'verify-schema-levels']) {
      const report = JSON.parse((await readFile(join(f.artifactRoot, 'rollback-logs', `${phase}.stdout.log`), 'utf8')).trim().split('\n').at(-1)!);
      assert.deepEqual(report.candidateExecution, { runId: f.context.runId, ref: f.context.expectedRef, tree: f.context.expectedTree });
    }
    await f.verify(); await absent(join(f.artifactRoot, 'rollback-evidence.json'));
  });
});
for (const stage of ['expand', 'read']) for (const field of ['runId', 'ref', 'tree']) {
  test(`parent rejects ${stage} candidate report with a different ${field}`, async () => {
    await fixture(async f => {
      const result = f.execute(`tamper-${stage}-${field}`); assert.notEqual(result.status, 0);
      await absent(f.output); const diagnostic = await readJson(f, 'rollback-diagnostics.json');
      assert.equal(diagnostic.status, 'failed'); assertNoDeclaration(diagnostic); await assertResourcesCleaned(f, diagnostic);
    });
  });
}
for (const phase of ['main', '--candidate-expand', '--read-schema']) {
  test(`${phase} requires the private context and never falls back to the old mode`, async () => {
    await fixture(async f => {
      const before = await snapshot(f.sandbox);
      const args = phase === 'main' ? f.args({ contextPath: null }) : ['--experimental-strip-types', join(f.root, 'scripts/check-schema-rollback.ts'), phase];
      const result = spawnSync(process.execPath, args, { cwd: f.root, encoding: 'utf8', env: f.env('', { contextPath: null }) });
      assert.notEqual(result.status, 0); assert.match(String(result.stderr), /context|SCHEMA_ROLLBACK_RUN_CONTEXT/i);
      assert.deepEqual(await snapshot(f.sandbox), before);
    });
  });
}

for (const phase of ['main', '--candidate-expand', '--read-schema']) for (const digest of [null, '0'.repeat(64)]) {
  test(`${phase} rejects ${digest === null ? 'missing' : 'incorrect'} parent context digest before mutation`, async () => {
    await fixture(async f => {
      const before = await snapshot(f.sandbox), options = { contextDigest: digest };
      const args = phase === 'main' ? f.args() : ['--experimental-strip-types', join(f.root, 'scripts/check-schema-rollback.ts'), phase];
      const result = spawnSync(process.execPath, args, { cwd: f.root, encoding: 'utf8', env: f.env('', options) });
      assert.notEqual(result.status, 0); assert.match(String(result.stderr), /context.*digest|context.*binding/i);
      assert.deepEqual(await snapshot(f.sandbox), before);
    });
  });
}
for (const field of ['runId', 'expectedRef', 'expectedTree']) {
  test(`identity wait rejects replacement context ${field} against the original parent digest`, async () => {
    await fixture(async f => {
      const replacement = { ...f.context, [field]: field === 'runId' ? randomUUID() : 'b'.repeat(40) };
      const result = await executeDuringIdentity(f, () => writeFile(f.contextPath, JSON.stringify(replacement)));
      assert.notEqual(result.status, 0); await absent(f.output);
      const diagnostic = await readJson(f, 'rollback-diagnostics.json');
      assert.match(diagnostic.error, /context bytes differ from parent binding/); assert.equal(diagnostic.status, 'failed');
      assert.equal(diagnostic.targetRef, f.context.expectedRef); assertNoDeclaration(diagnostic);
      assert.deepEqual(diagnostic.cleanup, []); assert.deepEqual(diagnostic.phases, []);
      await absent(join(f.artifactRoot, 'admin.log'));
    });
  });
}
for (const input of ['previousRoot', 'manifestPath']) {
  test(`checker rejects ${input} outside this private run before creating artifacts`, async () => {
    await fixture(async f => {
      const foreign = join(f.sandbox, input === 'previousRoot' ? 'foreign-previous' : 'foreign-manifest.json');
      if (input === 'previousRoot') await mkdir(foreign); else await writeFile(foreign, previousManifest);
      const before = await snapshot(f.sandbox), result = f.execute('', { [input]: foreign });
      assert.notEqual(result.status, 0); assert.match(String(result.stderr), /must belong to this private run/);
      assert.deepEqual(await snapshot(f.sandbox), before);
    });
  });
}

test('external fresh artifact root receives staging, diagnostics and logs without changing candidate source', async () => {
  await fixture(async f => {
    const before = await snapshot(f.root), result = f.execute(); assert.equal(result.status, 0, String(result.stderr));
    assert.deepEqual(await snapshot(f.root), before); assertStagedEvidence(f, await readJson(f, 'rollback-staged-result.json'));
    const diagnostic = await readJson(f, 'rollback-diagnostics.json'); assert.equal(diagnostic.status, 'passed'); assertNoDeclaration(diagnostic);
    assert.match(await readFile(join(f.artifactRoot, 'rollback-logs/previous-after-expand.stdout.log'), 'utf8'), /"pass":true/);
  });
});

test('invalid previous identity preserves diagnostics but never stages success', async () => {
  await fixture(async f => {
    await writeFile(f.manifestPath, JSON.stringify({ invalid: true }));
    const result = f.execute(); assert.notEqual(result.status, 0); await absent(f.output);
    const diagnostic = await readJson(f, 'rollback-diagnostics.json');
    assert.match(diagnostic.error, /invalid prepared release identity/); assert.equal(diagnostic.status, 'failed');
    assert.deepEqual(diagnostic.phases, []); assertNoDeclaration(diagnostic);
    await absent(join(f.previousRoot, 'scripts/mul173-schema-rollback-probe.ts'));
  });
});
for (const scenario of [
  { name: 'candidate root output', where: 'candidate', path: 'rollback-staged-result.json' },
  { name: 'tracked output', where: 'candidate', path: 'bootstrap.mjs' },
  { name: 'dirty tracked output', where: 'candidate', path: 'scripts/schema-rollback-probe.ts', dirty: true },
  { name: 'tracked ancestor', where: 'candidate', path: 'scripts' },
  { name: 'Git metadata output', where: 'candidate', path: '.git/new-result.json' },
  { name: 'previous manifest output', where: 'input', path: 'previous-release.json' },
  { name: 'previous source output', where: 'input', path: 'previous/result.json' },
  { name: 'control output', where: 'control', path: 'run-context.json' },
  { name: 'noncanonical artifact filename', where: 'artifacts', path: 'other-result.json' },
  { name: 'diagnostics alias output', where: 'artifacts', path: 'rollback-diagnostics.json' },
  { name: 'logs alias output', where: 'artifacts', path: 'rollback-logs' },
]) {
  test(`preflight rejects ${scenario.name} and preserves caller content`, async () => {
    await fixture(async f => {
      const base = scenario.where === 'candidate' ? f.root : scenario.where === 'input' ? f.previousInput : scenario.where === 'control' ? f.control : f.artifactRoot;
      const output = join(base, scenario.path);
      if (scenario.dirty) await writeFile(output, 'dirty source must survive');
      const before = await snapshot(f.sandbox), result = f.execute('', { output });
      assert.notEqual(result.status, 0); assert.match(String(result.stderr), /artifact|output|staged|candidate|context/i);
      assert.deepEqual(await snapshot(f.sandbox), before); await absent(join(f.root, '.git/new-result.json'));
    });
  });
}
for (const path of ['rollback-staged-result.json', 'rollback-diagnostics.json', 'rollback-logs/keep.txt']) {
  test(`fresh-only preserves pre-existing artifact ${path} without writing diagnostics over it`, async () => {
    await fixture(async f => {
      const target = join(f.artifactRoot, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, 'caller-owned content');
      const before = await snapshot(f.sandbox), result = f.execute(); assert.notEqual(result.status, 0);
      assert.match(String(result.stderr), /already exists|EEXIST|fresh/i); assert.deepEqual(await snapshot(f.sandbox), before);
    });
  });
}
for (const path of ['rollback-staged-result.json', 'rollback-diagnostics.json', 'rollback-logs']) {
  test(`preflight protects tracked source from artifact symlink ${path}`, async () => {
    await fixture(async f => {
      await symlink(path === 'rollback-logs' ? join(f.root, 'scripts') : join(f.root, 'bootstrap.mjs'), join(f.artifactRoot, path));
      const before = await snapshot(f.sandbox), result = f.execute(); assert.notEqual(result.status, 0);
      assert.match(String(result.stderr), /symlink|already exists|EEXIST|artifact/i); assert.deepEqual(await snapshot(f.sandbox), before);
    });
  });
}

test('artifact root replaced with a source symlink is rejected without touching caller files', async () => {
  await fixture(async f => {
    await rm(f.artifactRoot, { recursive: true }); await symlink(f.root, f.artifactRoot);
    const before = await snapshot(f.sandbox), result = f.execute(); assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /symlink|real directory|canonical/i); assert.deepEqual(await snapshot(f.sandbox), before);
  });
});

test('private dependency links escaping to the shared fixture input fail before resources or outputs', async () => {
  await fixture(async f => {
    await mkdir(join(f.root, 'node_modules'));
    await symlink(join(f.sandbox, 'source', 'scripts'), join(f.root, 'node_modules', 'shared-input'));
    const before = await snapshot(f.sandbox), result = f.execute(); assert.notEqual(result.status, 0);
    assert.match(String(result.stderr), /Dependency link escapes private candidate/);
    assert.deepEqual(await snapshot(f.sandbox), before); await absent(f.output);
  });
});

test('exact private install directory with private files and workspace links passes the real verifier and checker', async () => {
  await fixture(async f => {
    await mkdir(join(f.root, 'node_modules', 'private-dependency'), { recursive: true });
    await writeFile(join(f.root, 'node_modules', 'private-dependency', 'index.js'), 'export const fixture = true;\n');
    await symlink(join(f.root, 'packages'), join(f.root, 'node_modules', 'private-workspace'));
    await f.verify(); const before = await snapshot(f.root), result = f.execute(); assert.equal(result.status, 0, String(result.stderr));
    assert.deepEqual(await snapshot(f.root), before); assertStagedEvidence(f, await readJson(f, 'rollback-staged-result.json'));
  });
});

test('context cannot relabel candidate source as the external artifact root', async () => {
  await fixture(async f => {
    await writeFile(f.contextPath, JSON.stringify({ ...f.context, artifactRoot: f.root }));
    const before = await snapshot(f.sandbox), result = f.execute('', { output: join(f.root, 'rollback-staged-result.json') });
    assert.notEqual(result.status, 0); assert.deepEqual(await snapshot(f.sandbox), before);
  });
});
for (const kind of ['dirty', 'head', 'untracked', 'ignored', 'index']) {
  test(`initial private ${kind} source is rejected by the real verifier without output writes`, async () => {
    await fixture(async f => {
      await applyPrivateDrift(f, kind); const before = await snapshot(f.sandbox), result = f.execute();
      assert.notEqual(result.status, 0); assert.deepEqual(await snapshot(f.sandbox), before);
      await assert.rejects(f.verify()); await absent(f.output); await absent(join(f.artifactRoot, 'rollback-diagnostics.json'));
    });
  });
}
for (const mode of ['replay-before', 'same-task', 'same-task-after', 'reuse-task-task', 'reuse-task-cancelled', 'reuse-cancelled-task', 'reuse-cancelled-cancelled']) {
  test(`producer rejects ${mode} reports and cleans resources without staging`, async () => {
    await fixture(async f => {
      await writeFile(join(f.previousRoot, mode), ''); const result = f.execute(); assert.notEqual(result.status, 0); await absent(f.output);
      const diagnostic = await readJson(f, 'rollback-diagnostics.json'); assert.match(diagnostic.error, /distinct ID/);
      assert.equal(diagnostic.status, 'failed'); assertNoDeclaration(diagnostic); await assertResourcesCleaned(f, diagnostic);
    });
  });
}

test('another same-level checkout cannot execute the private checker or either candidate phase', async () => {
  await fixture(async f => {
    const other = join(f.sandbox, 'other');
    execFileSync('git', ['clone', '-q', '--no-local', f.root, other]);
    await writeFile(join(other, 'packages/server/src/store/migrations.ts'), 'throw new Error("A migrations must not execute B");');
    git(other, 'add', '.'); commit(other, 'different same-level candidate');
    const before = await snapshot(f.sandbox);
    for (const phase of ['main', '--candidate-expand', '--read-schema']) {
      const args = phase === 'main' ? f.args() : ['--experimental-strip-types', join(f.root, 'scripts/check-schema-rollback.ts'), phase];
      const result = spawnSync(process.execPath, args, { cwd: other, encoding: 'utf8', env: f.env() });
      assert.notEqual(result.status, 0); assert.match(String(result.stderr), /candidate|root|context/i);
      assert.deepEqual(await snapshot(f.sandbox), before);
    }
    const result = f.execute(); assert.equal(result.status, 0, String(result.stderr));
  });
});

test('real path alias of the private candidate remains supported with its canonical context', async () => {
  await fixture(async f => {
    const alias = join(f.sandbox, 'candidate-alias'); await symlink(f.root, alias);
    const result = f.execute('', { cwd: alias }); assert.equal(result.status, 0, String(result.stderr));
    assertStagedEvidence(f, await readJson(f, 'rollback-staged-result.json'));
  });
});

test('staging created by another writer during cleanup is preserved and rejects publication', async () => {
  await fixture(async f => {
    const result = f.execute('output-collision'); assert.notEqual(result.status, 0);
    assert.equal(await readFile(f.output, 'utf8'), 'created by another writer');
    const diagnostic = await readJson(f, 'rollback-diagnostics.json'); assert.equal(diagnostic.status, 'failed');
    assert.match(diagnostic.error, /EEXIST/); assertNoDeclaration(diagnostic); await assertResourcesCleaned(f, diagnostic);
  });
});

test('private phase subprocesses run old -> fixed candidate -> same old and retain logs and levels', async () => {
  await fixture(async f => {
    const result = f.execute(); assert.equal(result.status, 0, String(result.stderr));
    const evidence = await readJson(f, 'rollback-staged-result.json'); assertStagedEvidence(f, evidence);
    assert.equal(evidence.previousIdentity.mode, 'published-archive'); assert.equal(evidence.previousIdentity.actualPreviousRef, 'a'.repeat(40));
    assert.equal(evidence.probes.before.task, 'retained-task'); assert.equal(evidence.probes.after.task, 'new-task');
    assert.deepEqual(evidence.schemaVerification, evidence.schema);
    assert.deepEqual(evidence.phases.map(phase => phase.name), ['previous-before-expand', 'candidate-expand', 'previous-after-expand', 'verify-schema-levels']);
    for (const phase of evidence.phases) {
      assert.equal(phase.status, 'passed'); assert.equal(phase.exitCode, 0);
      assert.match(await readFile(join(f.artifactRoot, phase.stdout), 'utf8'), /"pass":true/); await access(join(f.artifactRoot, phase.stderr));
    }
    assert.match(await readFile(join(f.artifactRoot, 'rollback-logs/candidate-expand.stderr.log'), 'utf8'), /candidate expand stderr/);
    await assertResourcesCleaned(f, evidence); await f.verify();
  });
});

test('old writer failure after expand retains failing logs and cleans all resources without staging', async () => {
  await fixture(async f => {
    await writeFile(join(f.previousRoot, 'fail-after'), ''); const result = f.execute(); assert.notEqual(result.status, 0); await absent(f.output);
    const diagnostic = await readJson(f, 'rollback-diagnostics.json'); assertNoDeclaration(diagnostic);
    assert.equal(diagnostic.phases.at(-1).name, 'previous-after-expand'); assert.equal(diagnostic.phases.at(-1).exitCode, 19);
    assert.match(await readFile(join(f.artifactRoot, 'rollback-logs/previous-after-expand.stderr.log'), 'utf8'), /old writer failed after expand/);
    await assertResourcesCleaned(f, diagnostic);
  });
});

test('database cleanup failure rejects staging but still closes admin and removes temporary home', async () => {
  await fixture(async f => {
    const result = f.execute('drop-failure'); assert.notEqual(result.status, 0); await absent(f.output);
    const diagnostic = await readJson(f, 'rollback-diagnostics.json'); assertNoDeclaration(diagnostic);
    assert.equal(diagnostic.cleanup.find(item => item.name === 'test-database').status, 'failed');
    assert.equal(diagnostic.cleanup.find(item => item.name === 'admin-connection').status, 'passed');
    assert.match(await readFile(join(f.artifactRoot, 'admin.log'), 'utf8'), /DROP DATABASE.*\nclosed\n/);
    await absent(await readFile(join(f.artifactRoot, 'temporary-home.txt'), 'utf8'));
  });
});

test('probe cleanup failure still attempts database, admin and temporary home cleanup', async () => {
  await fixture(async f => {
    await writeFile(join(f.previousRoot, 'block-probe-cleanup'), ''); const result = f.execute(); assert.notEqual(result.status, 0); await absent(f.output);
    const diagnostic = await readJson(f, 'rollback-diagnostics.json'); assert.equal(diagnostic.cleanup[0].name, 'previous-probe');
    assert.equal(diagnostic.cleanup[0].status, 'failed'); assert(diagnostic.cleanup.slice(1).every(item => item.status === 'passed'));
    await absent(await readFile(join(f.artifactRoot, 'temporary-home.txt'), 'utf8'));
  });
});

test('existing previous probe is rejected without overwrite or deletion', async () => {
  await fixture(async f => {
    const probe = join(f.previousRoot, 'scripts/mul173-schema-rollback-probe.ts'); await writeFile(probe, 'existing probe');
    const result = f.execute(); assert.notEqual(result.status, 0); assert.equal(await readFile(probe, 'utf8'), 'existing probe'); await absent(f.output);
    const diagnostic = await readJson(f, 'rollback-diagnostics.json'); assert.match(diagnostic.error, /EEXIST/);
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
