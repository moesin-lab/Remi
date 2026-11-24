import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  const evidence = { format: 1, targetRef: target.ref, dataSchema: target.dataSchema,
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
