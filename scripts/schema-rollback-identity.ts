/** Published source identity. A schema fingerprint is never a source identity. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { schemaLevelFingerprint } from '../packages/platform-updater/src/schema-fingerprint.mjs';

export const repository = 'moesin-lab/Remi';
const origin = `https://github.com/${repository}`;
export const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
export const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
export async function github(path: string, text = false): Promise<any> {
  // Use the already authenticated GitHub CLI; never read or log its credentials.
  // Newer gh versions require explicit permission for ANSI bytes in captured logs.
  // These bytes are hashed in memory and never printed to the terminal.
  const logFlags = text && execFileSync('gh', ['api', '--help'], { encoding: 'utf8' }).includes('--allow-escape-sequences')
    ? ['--allow-escape-sequences'] : [];
  const response = execFileSync('gh', ['api', `repos/${repository}/${path}`, ...logFlags,
    '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return text ? response : JSON.parse(response);
}
export function validateManifest(previous: any, tag: string) {
  assert.match(previous.version, /^\d+\.\d+\.\d+$/);
  assert.equal(tag, `v${previous.version}`);
  assert.match(previous.ref, /^[a-f0-9]{40}$/);
  assert.match(previous.dataSchema, /^[a-f0-9]{64}$/);
  assert.match(previous.sourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(previous.releaseUrl, `${origin}/releases/tag/${tag}`);
  assert.equal(previous.manifestUrl, `${origin}/releases/download/${tag}/platform-release.json`);
  assert.equal(previous.sourceUrl, `${origin}/releases/download/${tag}/platform-systemd-${tag}.tar.gz`);
  assert.match(previous.apiImage, /^ghcr\.io\/moesin-lab\/remi-api@sha256:[a-f0-9]{64}$/);
}
export function validateAsset(asset: any, url: string, bytes: Uint8Array) {
  assert.equal(asset.browser_download_url, url);
  assert.equal(asset.digest, `sha256:${sha256(bytes)}`, 'GitHub asset digest mismatch');
  assert.equal(asset.size, bytes.byteLength, 'GitHub asset size mismatch');
}

/** Inspect only the verifier's cryptographically verified results, never decoded bundles. */
export function verifiedImageInvocation(results: any[], previous: any) {
  const tagRef = `refs/tags/v${previous.version}`;
  const matches = results.map(r => r.verificationResult).filter(v => {
    const c = v?.signature?.certificate, s = v?.statement;
    return c?.sourceRepositoryURI === origin && c.sourceRepositoryDigest === previous.ref
      && c.sourceRepositoryRef === tagRef && c.runnerEnvironment === 'github-hosted'
      && c.issuer === 'https://token.actions.githubusercontent.com'
      && c.buildSignerURI === `${origin}/.github/workflows/platform-release.yml@${tagRef}`
      && c.buildSignerDigest === previous.ref
      && s?.predicateType === 'https://slsa.dev/provenance/v1'
      && s.subject?.some((subject: any) => subject.name === 'ghcr.io/moesin-lab/remi-api'
        && subject.digest?.sha256 === previous.apiImage.split('@sha256:')[1])
      && s.predicate?.buildDefinition?.resolvedDependencies?.some((d: any) => d.digest?.gitCommit === previous.ref)
      && s.predicate?.runDetails?.metadata?.invocationId === c.runInvocationURI;
  });
  assert.ok(matches.length, 'No verified API provenance binds the published commit and trusted workflow');
  const invocations = [...new Set(matches.map(v => v.signature.certificate.runInvocationURI))];
  assert.equal(invocations.length, 1, 'Ambiguous release provenance');
  const invocation = invocations[0] as string;
  const match = invocation.match(/^https:\/\/github\.com\/moesin-lab\/Remi\/actions\/runs\/(\d+)\/attempts\/(\d+)$/);
  assert.ok(match, 'Unexpected provenance invocation');
  return { invocation, runId: match[1], attempt: Number(match[2]) };
}

export function validatePublishRun(run: any, jobs: any[], previous: any, attempt: number) {
  assert.equal(run.repository?.full_name, repository);
  assert.equal(run.head_repository?.full_name, repository);
  assert.equal(run.head_sha, previous.ref);
  assert.equal(run.head_branch, `v${previous.version}`);
  assert.equal(run.path, '.github/workflows/release.yml');
  assert.equal(run.event, 'push');
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.equal(run.run_attempt, attempt);
  const publish = jobs.filter(j => j.name === 'platform / publish' && j.conclusion === 'success');
  assert.equal(publish.length, 1, 'Missing or ambiguous successful publish job');
  for (const name of ['Build deployment manifest', 'Upload platform assets to the existing GitHub Release', 'Attest API image']) {
    assert.ok(publish[0].steps.some((s: any) => s.name === name && s.conclusion === 'success'), `Missing successful publish step: ${name}`);
  }
  return publish[0];
}

export async function verifyProvenance(previous: any, directory: string) {
  const verification = execFileSync('gh', ['attestation', 'verify', `oci://${previous.apiImage}`,
    '--repo', repository, '--signer-workflow', `${repository}/.github/workflows/platform-release.yml`,
    '--source-digest', previous.ref, '--source-ref', `refs/tags/v${previous.version}`,
    '--deny-self-hosted-runners', '--format', 'json'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const identity = verifiedImageInvocation(JSON.parse(verification), previous);
  await writeFile(join(directory, 'api-image-verification.json'), verification);
  const run = await github(`actions/runs/${identity.runId}/attempts/${identity.attempt}`);
  const jobs: any[] = [];
  for (let page = 1; ; page++) {
    const response = await github(`actions/runs/${identity.runId}/attempts/${identity.attempt}/jobs?per_page=100&page=${page}`);
    jobs.push(...response.jobs);
    if (jobs.length >= response.total_count) break;
  }
  const job = validatePublishRun(run, jobs, previous, identity.attempt);
  const logs = await github(`actions/jobs/${job.id}/logs`, true);
  assert.ok(logs.includes(previous.ref), 'Publish log does not bind original checkout');
  assert.ok(logs.includes('git archive --format=tar.gz'), 'Publish log lacks source archive generation');
  assert.ok(logs.includes('gh release upload') && logs.includes('platform-systemd-$TAG.tar.gz'), 'Publish log lacks source upload');
  return { model: 'verified-api-image+github-publish-log+exact-git-tree', sourceArchiveAttestation: false,
    apiImage: previous.apiImage, ...identity, jobId: job.id, jobUrl: job.html_url,
    publishLogSha256: sha256(logs), verificationSha256: sha256(verification) };
}

export function verifyArchive(directory: string, previous: any, tree: string, destination?: string, checkDirectory?: string) {
  assert.match(tree, /^[a-f0-9]{40}$/);
  const args = ['-I', join(import.meta.dir, 'verify-release-source.py'), join(directory, 'source-download', 'source.tar.gz'),
    previous.sourceSha256, previous.ref, tree, `remi-v${previous.version}`];
  if (destination) args.push(destination);
  if (checkDirectory) args.push('--check-directory', checkDirectory);
  return JSON.parse(execFileSync('python3', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 }));
}

export async function verifyPreparedRelease(previousRootArg: string, manifestPath: string) {
  const previousRoot = resolve(previousRootArg), directory = dirname(resolve(manifestPath));
  assert.equal(previousRoot, join(directory, 'previous'), 'Previous source must be the isolated prepared directory');
  const bytes = await readFile(manifestPath);
  const previous = JSON.parse(bytes.toString());
  validateManifest(previous, `v${previous.version}`);
  const identity = JSON.parse(await readFile(join(directory, 'previous-identity.json'), 'utf8'));
  assert.equal(identity.publishedRef, previous.ref);
  assert.equal(identity.actualPreviousRef, previous.ref, 'Executed source must equal actual published source');
  assert.equal(identity.manifestSha256, sha256(bytes));
  assert.equal(identity.sourceSha256, previous.sourceSha256);
  const commit = await github(`git/commits/${previous.ref}`);
  assert.equal(commit.sha, previous.ref);
  assert.equal(identity.sourceTree, commit.tree.sha);
  const observedTagRef = git(process.cwd(), 'rev-parse', `v${previous.version}^{commit}`);
  assert.equal(identity.observedTagRef, observedTagRef, 'Observed tag changed since preparation');
  if (identity.mode === 'tag') {
    assert.equal(observedTagRef, previous.ref, 'Default tag/ref equality is strict');
    assert.equal(git(previousRoot, 'rev-parse', 'HEAD'), previous.ref);
  } else {
    assert.equal(identity.mode, 'published-archive');
    assert.notEqual(observedTagRef, previous.ref, 'Archive recovery must explicitly retain tag drift');
  }
  verifyArchive(directory, previous, identity.sourceTree, undefined, previousRoot);
  const provenance = await verifyProvenance(previous, directory);
  assert.equal(provenance.invocation, identity.provenance.invocation);
  assert.equal(JSON.parse(await readFile(join(previousRoot, 'package.json'), 'utf8')).version, previous.version);
  assert.equal(await schemaLevelFingerprint(previousRoot), previous.dataSchema, 'Published source schema mismatch');
  return { ...identity, provenance };
}
