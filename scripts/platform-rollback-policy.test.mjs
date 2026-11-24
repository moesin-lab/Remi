import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rollbackPolicy } from './platform-rollback-policy.mjs';
const manifest = { version: '1.2.0', ref: 'a'.repeat(40) };
const review = {
  targetRef: manifest.ref, previousVersion: '1.1.9', previousDataSchema: 'b'.repeat(64),
  reviewedBy: 'release reviewer', reason: 'Previous code reads the unchanged record format',
  previousRelease: { version: '1.1.9', dataSchema: 'b'.repeat(64) },
};
test('no review gives no cross-fingerprint attestation', () => {
  assert.deepEqual(rollbackPolicy(manifest), []);
});
test('review attests only the published previous schema', () => {
  assert.deepEqual(rollbackPolicy(manifest, review), [review.previousDataSchema]);
});
test('rejects stale, malformed, unreviewed and mismatched declarations', () => {
  for (const patch of [
    { targetRef: 'c'.repeat(40) }, { previousDataSchema: 'd'.repeat(64) },
    { previousDataSchema: 'invalid' }, { reviewedBy: '' }, { reason: ' ' },
    { previousVersion: '1.1.8' }, { previousRelease: undefined },
    { previousVersion: '1.2.0', previousRelease: { ...review.previousRelease, version: '1.2.0' } },
    { previousVersion: '2.0.0', previousRelease: { ...review.previousRelease, version: '2.0.0' } },
  ]) assert.throws(() => rollbackPolicy(manifest, { ...review, ...patch }));
  assert.throws(() => rollbackPolicy(manifest, null));
});

const sha256 = value => createHash('sha256').update(value).digest('hex');
const schema = { expandLevel: 3, contractLevel: 0 };
const target = { ...manifest, dataSchema: sha256(JSON.stringify({ format: 1, ...schema })) };
const origin = 'https://github.com/moesin-lab/Remi';
function sealManifest(evidence) {
  evidence.previousManifest = JSON.stringify(evidence.previousRelease, null, 2) + '\n';
  evidence.previousIdentity.manifestSha256 = sha256(evidence.previousManifest);
}
function mixedVersionEvidence(drift = false) {
  const previous = { ...review.previousRelease, ref: 'e'.repeat(40), sourceSha256: 'f'.repeat(64),
    releaseUrl: `${origin}/releases/tag/v1.1.9`,
    manifestUrl: `${origin}/releases/download/v1.1.9/platform-release.json`,
    sourceUrl: `${origin}/releases/download/v1.1.9/platform-systemd-v1.1.9.tar.gz`,
    apiImage: `ghcr.io/moesin-lab/remi-api@sha256:${'a'.repeat(64)}` };
  const runId = '4cac804b-47c8-4b32-8e78-91a425bc1b8b', tree = '9'.repeat(40);
  const executionIdentity = { runId, ref: target.ref, tree };
  const evidence = { format: 2, targetRef: target.ref, dataSchema: target.dataSchema,
    candidateExecution: { format: 1, mode: 'private-fixed-commit', runId,
      expectedRef: target.ref, actualRef: target.ref, expectedTree: tree, finalTree: tree,
      lockfileSha256: '8'.repeat(64), runtime: { node: 'v22.23.2', bun: '1.3.14' },
      cleanup: ['previous-input', 'candidate-checkout', 'staged-result', 'run-root']
        .map(name => ({ name, status: 'passed' })) },
    candidatePhases: { expand: { ...executionIdentity }, verify: { ...executionIdentity } },
    previousRelease: previous,
    previousIdentity: { format: 1, mode: drift ? 'published-archive' : 'tag',
      publishedRef: previous.ref, actualPreviousRef: previous.ref,
      observedTagRef: drift ? 'b'.repeat(40) : previous.ref, tagDrift: drift,
      sourceTree: 'c'.repeat(40), sourceSha256: previous.sourceSha256,
      manifestAssetId: 11, sourceAssetId: 12, releaseId: 13,
      provenance: { model: 'verified-api-image+github-publish-log+exact-git-tree',
        sourceArchiveAttestation: false, apiImage: previous.apiImage,
        runId: '101', attempt: 2, jobId: 201,
        invocation: `${origin}/actions/runs/101/attempts/2`,
        jobUrl: `${origin}/actions/runs/101/job/201`,
        publishLogSha256: 'd'.repeat(64), verificationSha256: 'e'.repeat(64) } },
    schema: { ...schema }, schemaVerification: { ...schema },
    phases: ['previous-before-expand', 'candidate-expand', 'previous-after-expand', 'verify-schema-levels']
      .map(name => ({ name, status: 'passed', exitCode: 0, signalCode: null,
        stdout: `rollback-logs/${name}.stdout.log`, stderr: `rollback-logs/${name}.stderr.log` })),
    probes: { before: { probe: 'previous-release-core', pass: true, task: 'before-task', cancelled: 'before-cancelled' },
      after: { probe: 'previous-release-core', pass: true, task: 'after-task', cancelled: 'after-cancelled' } },
    cleanup: ['previous-probe', 'test-database', 'admin-connection', 'temporary-home']
      .map(name => ({ name, status: 'passed' })),
    checks: ['previous-startup', 'previous-create-start-complete-cancel', 'candidate-expand-startup', 'previous-startup-after-expand', 'previous-create-start-complete-cancel-after-expand'],
    rollbackSafeFrom: [previous.dataSchema] };
  sealManifest(evidence);
  return evidence;
}
const candidateExecutionMutations = [
  ['old format1 with otherwise complete evidence', evidence => { evidence.format = 1; }],
  ...['candidateExecution', 'candidatePhases'].flatMap(key => [
    [`missing ${key}`, evidence => { delete evidence[key]; }],
    [`null ${key}`, evidence => { evidence[key] = null; }],
  ]),
  ...Object.keys(mixedVersionEvidence().candidateExecution).map(key =>
    [`missing execution ${key}`, evidence => { delete evidence.candidateExecution[key]; }]),
  ...Object.entries({ format: 2, mode: 'shared-checkout', expectedRef: '1'.repeat(40),
    actualRef: '2'.repeat(40), expectedTree: '3'.repeat(40), finalTree: '4'.repeat(40),
    lockfileSha256: 'invalid', runtime: null }).map(([key, value]) =>
    [`wrong execution ${key}`, evidence => { evidence.candidateExecution[key] = value; }]),
  ...[undefined, null, 123, '', 'not-a-uuid', '00000000-0000-0000-0000-000000000000',
    '4cac804b-47c8-0b32-8e78-91a425bc1b8b', '4cac804b-47c8-4b32-7e78-91a425bc1b8b',
    ' 4cac804b-47c8-4b32-8e78-91a425bc1b8b'].map(runId =>
    [`invalid UUID ${JSON.stringify(runId)}`, evidence => {
      evidence.candidateExecution.runId = evidence.candidatePhases.expand.runId = evidence.candidatePhases.verify.runId = runId;
    }]),
  ...['expand', 'verify'].flatMap(name => [
    [`missing candidate phase ${name}`, evidence => { delete evidence.candidatePhases[name]; }],
    [`null candidate phase ${name}`, evidence => { evidence.candidatePhases[name] = null; }],
    ...['runId', 'ref', 'tree'].flatMap(key => [
      [`missing ${name} ${key}`, evidence => { delete evidence.candidatePhases[name][key]; }],
      [`wrong ${name} ${key}`, evidence => {
        evidence.candidatePhases[name][key] = key === 'runId'
          ? 'b2d4c074-19f5-4bc0-a3ab-f1ad20ad189f' : '5'.repeat(40);
      }],
    ]),
  ]),
  ['same wrong ref in execution and phases', evidence => {
    evidence.candidateExecution.expectedRef = evidence.candidateExecution.actualRef =
      evidence.candidatePhases.expand.ref = evidence.candidatePhases.verify.ref = '6'.repeat(40);
  }],
  ...['invalid', '7'.repeat(39), 'G'.repeat(40), null].map(tree =>
    [`invalid coherent tree ${JSON.stringify(tree)}`, evidence => {
      evidence.candidateExecution.expectedTree = evidence.candidateExecution.finalTree =
        evidence.candidatePhases.expand.tree = evidence.candidatePhases.verify.tree = tree;
    }]),
  ...['', '8'.repeat(63), '8'.repeat(65), 'G'.repeat(64), null, 123].map(digest =>
    [`invalid lock digest ${JSON.stringify(digest)}`, evidence => { evidence.candidateExecution.lockfileSha256 = digest; }]),
  ...['node', 'bun'].flatMap(key => [
    [`missing runtime ${key}`, evidence => { delete evidence.candidateExecution.runtime[key]; }],
    ...['', ' ', null, 123].map(value =>
      [`invalid runtime ${key} ${JSON.stringify(value)}`, evidence => { evidence.candidateExecution.runtime[key] = value; }]),
  ]),
  ['wrong Bun version', evidence => { evidence.candidateExecution.runtime.bun = '1.3.13'; }],
  ['Bun version with prefix', evidence => { evidence.candidateExecution.runtime.bun = 'v1.3.14'; }],
  ['empty outer cleanup', evidence => { evidence.candidateExecution.cleanup = []; }],
  ['missing outer cleanup entry', evidence => { evidence.candidateExecution.cleanup.pop(); }],
  ['duplicate outer cleanup entry', evidence => { evidence.candidateExecution.cleanup.push(evidence.candidateExecution.cleanup[0]); }],
  ['reordered outer cleanup', evidence => { evidence.candidateExecution.cleanup.reverse(); }],
  ...[0, 1, 2, 3].flatMap(index => [
    [`missing outer cleanup ${index}`, evidence => { evidence.candidateExecution.cleanup.splice(index, 1); }],
    [`wrong outer cleanup name ${index}`, evidence => { evidence.candidateExecution.cleanup[index].name = 'temporary-home'; }],
    ...['failed', 'running', 'skipped', undefined].map(status =>
      [`outer cleanup ${index} status ${status}`, evidence => { evidence.candidateExecution.cleanup[index].status = status; }]),
    ...['cleanup failed', '', null].map(error =>
      [`outer cleanup ${index} error ${JSON.stringify(error)}`, evidence => { evidence.candidateExecution.cleanup[index].error = error; }]),
  ]),
];

function rejectMutations(mutations, drift = false) {
  for (const mutate of mutations) {
    const evidence = mixedVersionEvidence(drift);
    mutate(evidence);
    // Supplying a valid manual review cannot rescue invalid automated evidence.
    assert.throws(() => rollbackPolicy(target, review, evidence), /Invalid mixed-version rollback evidence/);
  }
}

test('accepts complete tag evidence and actual published source with explicitly retained tag drift', () => {
  for (const drift of [false, true]) {
    const evidence = mixedVersionEvidence(drift);
    assert.deepEqual(rollbackPolicy(target, undefined, evidence), [review.previousDataSchema]);
    delete evidence.phases[0].signalCode; // Bun may omit an undefined signal on success.
    assert.deepEqual(rollbackPolicy(target, undefined, evidence), [review.previousDataSchema]);
  }
});
test('requires complete fixed-commit execution, matching candidate phases and successful outer cleanup', async t => {
  for (const [name, mutate] of candidateExecutionMutations) {
    await t.test(name, () => {
      for (const drift of [false, true]) rejectMutations([mutate], drift);
    });
  }
});
test('rejects old incomplete evidence, missing mandatory fields and stale candidate bindings', () => {
  rejectMutations([
    ...['previousRelease', 'previousManifest', 'previousIdentity', 'schema', 'schemaVerification', 'phases', 'probes', 'cleanup', 'checks', 'rollbackSafeFrom']
      .map(key => evidence => { delete evidence[key]; }),
    evidence => { evidence.format = 0; },
    evidence => { evidence.targetRef = 'f'.repeat(40); },
    evidence => { evidence.dataSchema = 'c'.repeat(64); },
    evidence => { evidence.previousIdentity = null; },
    evidence => { delete evidence.previousIdentity; delete evidence.phases; delete evidence.cleanup; },
  ]);
  assert.throws(() => rollbackPolicy(target, review, null), /Invalid mixed-version rollback evidence/);
});
test('binds manifest bytes, original release refs and archive digest, rejecting valid-looking mismatches', () => {
  rejectMutations([
    evidence => { evidence.previousIdentity.actualPreviousRef = 'a'.repeat(40); },
    evidence => { evidence.previousIdentity.publishedRef = 'a'.repeat(40); },
    evidence => { evidence.previousIdentity.sourceSha256 = 'a'.repeat(64); },
    evidence => { evidence.previousIdentity.manifestSha256 = 'a'.repeat(64); },
    evidence => { evidence.previousManifest += '\n'; },
    evidence => { evidence.previousManifest = '{}'; evidence.previousIdentity.manifestSha256 = sha256('{}'); },
    evidence => { evidence.previousManifest = 'invalid JSON'; evidence.previousIdentity.manifestSha256 = sha256(evidence.previousManifest); },
    ...['ref', 'dataSchema', 'sourceSha256'].map(key => evidence => { evidence.previousRelease[key] = 'a'.repeat(key === 'ref' ? 40 : 64); sealManifest(evidence); }),
    ...['releaseUrl', 'manifestUrl', 'sourceUrl', 'apiImage'].map(key => evidence => { evidence.previousRelease[key] = 'https://example.com/untrusted'; sealManifest(evidence); }),
    evidence => { evidence.previousRelease.version = '1.1.9-rc.1'; sealManifest(evidence); },
    ...Object.keys(mixedVersionEvidence().previousIdentity).map(key => evidence => { delete evidence.previousIdentity[key]; }),
    ...['observedTagRef', 'sourceTree', 'sourceSha256', 'manifestSha256'].map(key => evidence => { evidence.previousIdentity[key] = 'invalid'; }),
    ...['manifestAssetId', 'sourceAssetId', 'releaseId'].flatMap(key => [0, -1, '13', 1.5, Number.MAX_SAFE_INTEGER + 1]
      .map(value => evidence => { evidence.previousIdentity[key] = value; })),
    evidence => { evidence.previousIdentity.format = 2; },
  ]);
});
test('rejects contradictory recovery modes while permitting legitimate observed tag drift', () => {
  rejectMutations([
    evidence => { evidence.previousIdentity.observedTagRef = 'a'.repeat(40); },
    evidence => { evidence.previousIdentity.tagDrift = true; },
    evidence => { evidence.previousIdentity.mode = 'published-archive'; },
    evidence => { evidence.previousIdentity.mode = 'unknown'; },
  ]);
  rejectMutations([
    evidence => { evidence.previousIdentity.mode = 'tag'; },
    evidence => { evidence.previousIdentity.observedTagRef = evidence.previousRelease.ref; },
    evidence => { evidence.previousIdentity.tagDrift = false; },
    evidence => { evidence.previousIdentity.actualPreviousRef = evidence.previousIdentity.observedTagRef; },
  ], true);
});
test('requires the accepted source trust model, matching image/run/job and provenance digests', () => {
  rejectMutations([
    ...Object.keys(mixedVersionEvidence().previousIdentity.provenance).map(key => evidence => { delete evidence.previousIdentity.provenance[key]; }),
    ...Object.entries({ model: 'archive-digest-only', sourceArchiveAttestation: true,
      apiImage: `ghcr.io/moesin-lab/remi-api@sha256:${'b'.repeat(64)}`,
      runId: '102', attempt: 3, jobId: 202,
      invocation: `${origin}/actions/runs/101/attempts/1`,
      jobUrl: 'https://github.com/other/repo/actions/runs/101/job/201',
      publishLogSha256: 'invalid', verificationSha256: 'invalid' })
      .map(([key, value]) => evidence => { evidence.previousIdentity.provenance[key] = value; }),
    ...[101, '', '0', '-1', '1e2', '1/attempts/2'].map(runId => evidence => { evidence.previousIdentity.provenance.runId = runId; }),
    ...['attempt', 'jobId'].flatMap(key => [0, '1', 1.5, Number.MAX_SAFE_INTEGER + 1].map(value => evidence => { evidence.previousIdentity.provenance[key] = value; })),
  ]);
});
test('requires successful complete ordered phases and per-phase output references', () => {
  rejectMutations([
    evidence => { evidence.phases.pop(); },
    evidence => { evidence.phases.push(evidence.phases[0]); },
    evidence => { evidence.phases.reverse(); },
    ...[0, 1, 2, 3].flatMap(index => [
      ...['failed', 'running', 'skipped', undefined].map(status => evidence => { evidence.phases[index].status = status; }),
      ...[1, '0', undefined].map(exitCode => evidence => { evidence.phases[index].exitCode = exitCode; }),
      evidence => { evidence.phases[index].signalCode = 'SIGTERM'; },
      evidence => { evidence.phases[index].error = 'probe failed'; },
      evidence => { evidence.phases[index].stdout = '../wrong.stdout.log'; },
      evidence => { delete evidence.phases[index].stderr; },
    ]),
  ]);
});
test('requires both real core reports and levels matching each other and the target schema fingerprint', () => {
  rejectMutations([
    ...['before', 'after'].flatMap(key => [
      evidence => { delete evidence.probes[key]; },
      evidence => { evidence.probes[key].pass = false; },
      evidence => { evidence.probes[key].probe = 'substitute'; },
      evidence => { evidence.probes[key].task = ''; },
      evidence => { delete evidence.probes[key].cancelled; },
    ]),
    evidence => { evidence.schemaVerification.expandLevel = 4; },
    evidence => { evidence.schemaVerification = { ...schema, contractLevel: 1 }; },
    evidence => { evidence.schema.expandLevel = evidence.schemaVerification.expandLevel = 4; },
    evidence => { evidence.schema.contractLevel = evidence.schemaVerification.contractLevel = 1; },
    ...[0, -1, '3', 1.5, Number.MAX_SAFE_INTEGER + 1].map(level => evidence => { evidence.schema.expandLevel = evidence.schemaVerification.expandLevel = level; }),
    evidence => { evidence.checks = []; },
    evidence => { evidence.rollbackSafeFrom = []; },
  ]);
});
const replayedProbeMutations = [
  evidence => { evidence.probes.after = { ...evidence.probes.before }; },
  ...['task', 'cancelled'].flatMap(after => ['task', 'cancelled'].map(before => evidence => {
    evidence.probes.after[after] = evidence.probes.before[before];
  })),
  ...['before', 'after'].map(phase => evidence => {
    evidence.probes[phase].cancelled = evidence.probes[phase].task;
  }),
];
test('rejects replayed reports and every within-phase or cross-phase task ID reuse', () => {
  for (const drift of [false, true]) rejectMutations(replayedProbeMutations, drift);
});
test('packaging rejects invalid fixed-commit evidence and replayed reports before invoking Docker', { skip: process.platform !== 'linux' }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'remi-rollback-policy-package-'));
  try {
    const bin = join(temporary, 'bin'), dockerMarker = join(temporary, 'docker-called');
    const manifestPath = join(temporary, 'platform-release.json'), evidencePath = join(temporary, 'rollback-evidence.json');
    await mkdir(bin);
    await writeFile(join(bin, 'docker'), `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(dockerMarker)}, 'called');\nprocess.exit(99);\n`, { mode: 0o755 });
    const release = { ...target, rollbackReview: review,
      apiImage: `ghcr.io/moesin-lab/remi-api@sha256:${'a'.repeat(64)}`,
      webImage: `ghcr.io/moesin-lab/remi-web@sha256:${'b'.repeat(64)}` };
    const run = async evidence => {
      await rm(dockerMarker, { force: true });
      await writeFile(manifestPath, JSON.stringify(release));
      await writeFile(evidencePath, JSON.stringify(evidence));
      return spawnSync(process.execPath, [fileURLToPath(new URL('./package-platform-application.mjs', import.meta.url)), manifestPath, temporary], {
        cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8',
        env: { ...process.env, PATH: bin + delimiter + process.env.PATH, PLATFORM_SCHEMA_ROLLBACK_EVIDENCE: evidencePath },
      });
    };
    // A valid fixture reaches the deliberate Docker cutoff; no real Docker runs.
    for (const drift of [false, true]) {
      const control = await run(mixedVersionEvidence(drift));
      assert.notEqual(control.status, 0);
      assert.match(control.stderr, /docker pull failed/);
      assert.equal(await readFile(dockerMarker, 'utf8'), 'called');
    }
    const mutations = [...candidateExecutionMutations,
      ...replayedProbeMutations.map((mutate, index) => [`replayed core report ${index}`, mutate])];
    for (const [name, mutate] of mutations) {
      await t.test(name, async () => {
        const evidence = mixedVersionEvidence(true);
        mutate(evidence);
        const result = await run(evidence);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Invalid mixed-version rollback evidence/);
        await assert.rejects(readFile(dockerMarker), { code: 'ENOENT' });
        assert.equal(await readFile(manifestPath, 'utf8'), JSON.stringify(release));
      });
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
test('requires all independent cleanups to pass, refusing incomplete or failed cleanup artifacts', () => {
  rejectMutations([
    evidence => { evidence.cleanup.pop(); },
    evidence => { evidence.cleanup.push(evidence.cleanup[0]); },
    evidence => { evidence.cleanup.reverse(); },
    ...[0, 1, 2, 3].flatMap(index => [
      ...['failed', 'running', 'skipped', undefined].map(status => evidence => { evidence.cleanup[index].status = status; }),
      evidence => { evidence.cleanup[index].error = 'DROP failed'; },
    ]),
    evidence => { evidence.previousIdentity.actualPreviousRef = 'a'.repeat(40); evidence.phases[0].status = evidence.cleanup[0].status = 'failed'; },
  ]);
});
