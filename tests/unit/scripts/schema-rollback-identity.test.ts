import { describe, expect, test } from 'bun:test';
import { sha256, validateAsset, validateManifest, validatePublishRun, verifiedImageInvocation } from '../../../scripts/schema-rollback-identity.js';

const ref = 'a'.repeat(40), digest = 'b'.repeat(64);
const base = 'https://github.com/moesin-lab/Remi';
const previous = { version: '1.2.3', ref, dataSchema: 'c'.repeat(64), sourceSha256: digest,
  releaseUrl: `${base}/releases/tag/v1.2.3`, manifestUrl: `${base}/releases/download/v1.2.3/platform-release.json`,
  sourceUrl: `${base}/releases/download/v1.2.3/platform-systemd-v1.2.3.tar.gz`, apiImage: `ghcr.io/moesin-lab/remi-api@sha256:${digest}` };
const invocation = `${base}/actions/runs/123/attempts/1`;
function verification() {
  return [{ verificationResult: { signature: { certificate: {
    sourceRepositoryURI: base, sourceRepositoryDigest: ref, sourceRepositoryRef: 'refs/tags/v1.2.3',
    runnerEnvironment: 'github-hosted', issuer: 'https://token.actions.githubusercontent.com',
    buildSignerURI: `${base}/.github/workflows/platform-release.yml@refs/tags/v1.2.3`,
    buildSignerDigest: ref, runInvocationURI: invocation,
  } }, statement: { predicateType: 'https://slsa.dev/provenance/v1',
    subject: [{ name: 'ghcr.io/moesin-lab/remi-api', digest: { sha256: digest } }],
    predicate: { buildDefinition: { resolvedDependencies: [{ digest: { gitCommit: ref } }] },
      runDetails: { metadata: { invocationId: invocation } } },
  } } }];
}
const run = { repository: { full_name: 'moesin-lab/Remi' }, head_repository: { full_name: 'moesin-lab/Remi' },
  head_sha: ref, head_branch: 'v1.2.3', path: '.github/workflows/release.yml', event: 'push',
  status: 'completed', conclusion: 'success', run_attempt: 1 };
const job = { id: 1, name: 'platform / publish', conclusion: 'success', steps: [
  'Build deployment manifest', 'Upload platform assets to the existing GitHub Release', 'Attest API image',
].map(name => ({ name, conclusion: 'success' })) };

describe('published source trust boundary', () => {
  test('binds URLs to the exact repository, tag and source asset', () => {
    validateManifest(previous, 'v1.2.3');
    for (const changed of [ { ref: 'short' }, { dataSchema: '' }, { sourceSha256: '' },
      { sourceUrl: 'https://example.org/source.tar.gz' }, { sourceUrl: previous.sourceUrl + '?redirect=true' },
      { manifestUrl: previous.manifestUrl.replace('v1.2.3', 'v1.2.2') },
      { apiImage: `ghcr.io/other/remi-api@sha256:${digest}` } ]) {
      expect(() => validateManifest({ ...previous, ...changed }, 'v1.2.3')).toThrow();
    }
    expect(() => validateManifest(previous, 'v1.2.4')).toThrow();
  });
  test('requires GitHub digest and exact bytes as well as manifest sourceSha256', () => {
    const bytes = new TextEncoder().encode('published bytes');
    const asset = { browser_download_url: previous.sourceUrl, size: bytes.length, digest: `sha256:${sha256(bytes)}` };
    validateAsset(asset, previous.sourceUrl, bytes);
    expect(() => validateAsset({ ...asset, digest: null }, previous.sourceUrl, bytes)).toThrow();
    expect(() => validateAsset(asset, previous.sourceUrl, new TextEncoder().encode('tampered'))).toThrow();
    expect(() => validateAsset(asset, previous.sourceUrl + '/other', bytes)).toThrow();
  });
  test('requires verified certificate, subject, source commit, workflow and invocation to agree', () => {
    expect(verifiedImageInvocation(verification(), previous)).toEqual({ invocation, runId: '123', attempt: 1 });
    const changes = [
      (v: any) => { v.signature.certificate.sourceRepositoryDigest = 'd'.repeat(40); },
      (v: any) => { v.signature.certificate.sourceRepositoryURI = 'https://github.com/other/Remi'; },
      (v: any) => { v.signature.certificate.buildSignerURI += '-other'; },
      (v: any) => { v.signature.certificate.runnerEnvironment = 'self-hosted'; },
      (v: any) => { v.signature.certificate.sourceRepositoryRef = 'refs/heads/main'; },
      (v: any) => { v.statement.subject[0].digest.sha256 = 'e'.repeat(64); },
      (v: any) => { v.statement.predicate.runDetails.metadata.invocationId += '0'; },
      (v: any) => { v.statement.predicate.buildDefinition.resolvedDependencies = []; },
    ];
    for (const mutate of changes) {
      const input = verification(); mutate(input[0].verificationResult);
      expect(() => verifiedImageInvocation(input, previous)).toThrow();
    }
    expect(() => verifiedImageInvocation([], previous)).toThrow();
  });
  test('rejects another SHA, fork, rerun, workflow or failed/missing publication', () => {
    expect(validatePublishRun(run, [job], previous, 1).id).toBe(1);
    for (const changed of [ { head_sha: 'e'.repeat(40) }, { event: 'pull_request' },
      { repository: { full_name: 'fork/Remi' } }, { head_repository: { full_name: 'fork/Remi' } },
      { head_branch: 'v1.2.2' }, { run_attempt: 2 }, { path: '.github/workflows/other.yml' },
      { conclusion: 'failure' }, { status: 'in_progress' } ]) {
      expect(() => validatePublishRun({ ...run, ...changed }, [job], previous, 1)).toThrow();
    }
    expect(() => validatePublishRun(run, [], previous, 1)).toThrow();
    expect(() => validatePublishRun(run, [job, job], previous, 1)).toThrow();
    expect(() => validatePublishRun(run, [{ ...job, steps: job.steps.slice(0, 2) }], previous, 1)).toThrow();
  });
});
