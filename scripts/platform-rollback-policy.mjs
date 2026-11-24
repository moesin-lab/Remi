import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const origin = 'https://github.com/moesin-lab/Remi';

function validateIdentity(previous, identity, previousManifest) {
  assert.match(previous.version, /^\d+\.\d+\.\d+$/);
  assert(commit(previous.ref) && hash(previous.dataSchema) && hash(previous.sourceSha256));
  const release = `${origin}/releases`, tag = `v${previous.version}`;
  assert.equal(previous.releaseUrl, `${release}/tag/${tag}`);
  assert.equal(previous.manifestUrl, `${release}/download/${tag}/platform-release.json`);
  assert.equal(previous.sourceUrl, `${release}/download/${tag}/platform-systemd-${tag}.tar.gz`);
  assert.match(previous.apiImage, /^ghcr\.io\/moesin-lab\/remi-api@sha256:[a-f0-9]{64}$/);
  assert.equal(identity.format, 1);
  assert.equal(identity.publishedRef, previous.ref);
  assert.equal(identity.actualPreviousRef, previous.ref);
  assert(commit(identity.observedTagRef) && commit(identity.sourceTree));
  assert.equal(identity.sourceSha256, previous.sourceSha256);
  assert(hash(identity.manifestSha256) && typeof previousManifest === 'string');
  // Retain the downloaded manifest bytes: reserialization changes its digest.
  assert.equal(identity.manifestSha256, sha256(previousManifest));
  assert.deepEqual(JSON.parse(previousManifest), previous);
  assert([identity.manifestAssetId, identity.sourceAssetId, identity.releaseId].every(positiveInteger));
  if (identity.mode === 'tag') {
    assert.equal(identity.observedTagRef, previous.ref);
    assert.equal(identity.tagDrift, false);
  } else {
    assert.equal(identity.mode, 'published-archive');
    assert.notEqual(identity.observedTagRef, previous.ref);
    assert.equal(identity.tagDrift, true);
  }
  const provenance = identity.provenance;
  assert.equal(provenance.model, 'verified-api-image+github-publish-log+exact-git-tree');
  assert.equal(provenance.sourceArchiveAttestation, false);
  assert.equal(provenance.apiImage, previous.apiImage);
  assert(typeof provenance.runId === 'string' && /^[1-9]\d*$/.test(provenance.runId));
  assert(positiveInteger(provenance.attempt) && positiveInteger(provenance.jobId));
  assert.equal(provenance.invocation, `${origin}/actions/runs/${provenance.runId}/attempts/${provenance.attempt}`);
  assert.equal(provenance.jobUrl, `${origin}/actions/runs/${provenance.runId}/job/${provenance.jobId}`);
  assert(hash(provenance.publishLogSha256) && hash(provenance.verificationSha256));
}

export function validateCoreProbeReports(reports) {
  const ids = [];
  for (const report of reports) {
    assert.equal(report.probe, 'previous-release-core');
    assert.equal(report.pass, true);
    assert(text(report.task) && text(report.cancelled));
    ids.push(report.task, report.cancelled);
  }
  assert.equal(new Set(ids).size, ids.length, 'Each completed/cancelled task must have a distinct ID across core probes');
}

function validateMixedVersionEvidence(manifest, evidence) {
  try {
    assert.equal(evidence.format, 1);
    assert(commit(manifest.ref) && hash(manifest.dataSchema));
    assert.equal(evidence.targetRef, manifest.ref);
    assert.equal(evidence.dataSchema, manifest.dataSchema);
    validateIdentity(evidence.previousRelease, evidence.previousIdentity, evidence.previousManifest);
    const schema = evidence.schema;
    assert.equal(schema.contractLevel, 0);
    assert(positiveInteger(schema.expandLevel));
    assert.deepEqual(evidence.schemaVerification, schema);
    assert.equal(evidence.dataSchema, sha256(JSON.stringify({ format: 1,
      expandLevel: schema.expandLevel, contractLevel: schema.contractLevel })));
    const phases = ['previous-before-expand', 'candidate-expand', 'previous-after-expand', 'verify-schema-levels'];
    assert.deepEqual(evidence.phases.map(phase => phase.name), phases);
    for (const phase of evidence.phases) {
      assert.equal(phase.status, 'passed');
      assert.equal(phase.exitCode, 0);
      assert(phase.signalCode === undefined || phase.signalCode === null);
      assert.equal(phase.error, undefined);
      assert.equal(phase.stdout, `rollback-logs/${phase.name}.stdout.log`);
      assert.equal(phase.stderr, `rollback-logs/${phase.name}.stderr.log`);
    }
    validateCoreProbeReports([evidence.probes.before, evidence.probes.after]);
    assert.deepEqual(evidence.cleanup.map(result => result.name),
      ['previous-probe', 'test-database', 'admin-connection', 'temporary-home']);
    for (const result of evidence.cleanup) {
      assert.equal(result.status, 'passed');
      assert.equal(result.error, undefined);
    }
    assert.deepEqual(evidence.checks, ['previous-startup', 'previous-create-start-complete-cancel',
      'candidate-expand-startup', 'previous-startup-after-expand', 'previous-create-start-complete-cancel-after-expand']);
    assert.deepEqual(evidence.rollbackSafeFrom, [evidence.previousRelease.dataSchema]);
  } catch (cause) {
    throw new Error('Invalid mixed-version rollback evidence: complete matching identity, digests, successful probes, schema verification and cleanup are required', { cause });
  }
}

// Evidence is produced by the real mixed-version check; manual review remains
// a fallback for historical boundary releases.
export function rollbackPolicy(manifest, review, evidence) {
  if (evidence !== undefined) {
    validateMixedVersionEvidence(manifest, evidence);
    const previous = evidence.previousRelease;
    // Reuse the stable-version ordering validation below.
    return rollbackPolicy(manifest, { targetRef: manifest.ref, previousVersion: previous.version,
      previousDataSchema: previous.dataSchema, previousRelease: previous,
      reviewedBy: 'mixed-version PostgreSQL CI', reason: 'Previous release core probes passed on candidate expanded schema' });
  }
  if (review === undefined) return [];
  const previous = review?.previousRelease;
  if (!review || review.targetRef !== manifest.ref || !text(review.reason) || !text(review.reviewedBy)
      || !/^\d+\.\d+\.\d+$/.test(review.previousVersion) || review.previousVersion === manifest.version
      || previous?.version !== review.previousVersion || !hash(review.previousDataSchema)
      || previous?.dataSchema !== review.previousDataSchema) {
    throw new Error('Invalid reviewed rollback declaration: bind targetRef, previous published version/schema, reason and reviewedBy');
  }
  const version = value => value.split('.').map(Number);
  const targetVersion = version(manifest.version), previousVersion = version(review.previousVersion);
  const difference = targetVersion.map((value, index) => value - previousVersion[index]).find(value => value !== 0);
  if (!(difference > 0)) throw new Error('Rollback declaration must refer to an earlier published version');
  return [review.previousDataSchema];
}
