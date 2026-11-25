/** Resolve a published platform release, verify its build chain and complete
 * source tree, and prepare the actual published code even when a tag drifted. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { github, git, sha256, validateManifest, validateAsset, verifyArchive, verifyProvenance } from './schema-rollback-identity.ts';

const directory = resolve(process.argv[2] ?? 'ci-schema');
await mkdir(directory, { recursive: true });
// A failed preparation must invalidate all prior success, including an old run.
await rm(join(directory, 'rollback-evidence.json'), { force: true });
await rm(join(directory, 'previous-identity.json'), { force: true });
const diagnostic: any = { format: 1, targetRef: git(process.cwd(), 'rev-parse', 'HEAD'), pass: false, stage: 'resolve-release' };
try {
  let published: any;
  for (let page = 1; !published; page++) {
    const releases = await github(`releases?per_page=100&page=${page}`);
    if (!releases.length) throw new Error('No published stable platform release found; cannot attest rollback');
    published = releases.find((r: any) => !r.draft && !r.prerelease && /^v\d+\.\d+\.\d+$/.test(r.tag_name)
      && r.assets.some((a: any) => a.name === 'platform-release.json'));
  }
  diagnostic.releaseId = published.id;
  diagnostic.tag = published.tag_name;
  const manifestAssets = published.assets.filter((a: any) => a.name === 'platform-release.json');
  assert.equal(manifestAssets.length, 1);
  const manifestAsset = manifestAssets[0];
  const assetBase = `https://github.com/moesin-lab/Remi/releases/download/${published.tag_name}`;
  diagnostic.stage = 'verify-manifest';
  assert.equal(manifestAsset.browser_download_url, `${assetBase}/platform-release.json`);
  const response = await fetch(manifestAsset.browser_download_url);
  if (!response.ok) throw new Error(`Cannot download published manifest: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  validateAsset(manifestAsset, `${assetBase}/platform-release.json`, bytes);
  const previous = JSON.parse(new TextDecoder().decode(bytes));
  validateManifest(previous, published.tag_name);
  await writeFile(join(directory, 'previous-release.json'), bytes);
  diagnostic.publishedRef = previous.ref;
  diagnostic.manifestSha256 = sha256(bytes);

  diagnostic.stage = 'observe-tag';
  // Do not force-update an existing local tag. A changed observation fails closed.
  execFileSync('git', ['fetch', 'origin', `refs/tags/${published.tag_name}:refs/tags/${published.tag_name}`], { stdio: 'inherit' });
  const observedTagRef = git(process.cwd(), 'rev-parse', `${published.tag_name}^{commit}`);
  diagnostic.observedTagRef = observedTagRef;
  const commit = await github(`git/commits/${previous.ref}`);
  assert.equal(commit.sha, previous.ref);
  assert.match(commit.tree.sha, /^[a-f0-9]{40}$/);

  diagnostic.stage = 'verify-source-download';
  const sourceAssets = published.assets.filter((a: any) => a.name === `platform-systemd-${published.tag_name}.tar.gz`);
  assert.equal(sourceAssets.length, 1);
  const sourceAsset = sourceAssets[0];
  assert.equal(sourceAsset.browser_download_url, previous.sourceUrl);
  assert.equal(sourceAsset.digest, `sha256:${previous.sourceSha256}`);
  const downloadDirectory = join(directory, 'source-download');
  await mkdir(downloadDirectory); // A rerun must choose a fresh directory, never overlay downloads.
  const source = await fetch(previous.sourceUrl);
  if (!source.ok) throw new Error(`Cannot download published source: HTTP ${source.status}`);
  const archive = new Uint8Array(await source.arrayBuffer());
  validateAsset(sourceAsset, previous.sourceUrl, archive);
  await writeFile(join(downloadDirectory, 'source.tar.gz'), archive);
  const sourceIdentity = verifyArchive(directory, previous, commit.tree.sha);
  diagnostic.source = sourceIdentity;

  diagnostic.stage = 'verify-build-provenance';
  const provenance = await verifyProvenance(previous, directory);
  diagnostic.provenance = provenance;
  diagnostic.stage = 'restore-published-source';
  const previousRoot = join(directory, 'previous');
  const mode = observedTagRef === previous.ref ? 'tag' : 'published-archive';
  if (mode === 'tag') {
    execFileSync('git', ['worktree', 'add', '--detach', previousRoot, previous.ref], { stdio: 'inherit' });
    assert.equal(git(previousRoot, 'rev-parse', 'HEAD'), previous.ref);
    verifyArchive(directory, previous, commit.tree.sha, undefined, previousRoot);
  } else {
    // No SHA remapping: execute the fully verified original published tree.
    verifyArchive(directory, previous, commit.tree.sha, previousRoot);
  }
  assert.equal(JSON.parse(await readFile(join(previousRoot, 'package.json'), 'utf8')).version, previous.version);
  const identity = { format: 1, mode, publishedRef: previous.ref, actualPreviousRef: previous.ref,
    observedTagRef, tagDrift: observedTagRef !== previous.ref, sourceTree: sourceIdentity.tree,
    sourceSha256: previous.sourceSha256, manifestSha256: sha256(bytes),
    manifestAssetId: manifestAsset.id, sourceAssetId: sourceAsset.id, releaseId: published.id, provenance };
  await writeFile(join(directory, 'previous-identity.json'), JSON.stringify(identity, null, 2) + '\n');
  diagnostic.pass = true;
  diagnostic.stage = 'prepared';
  console.log(JSON.stringify(identity));
} catch (error) {
  diagnostic.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await writeFile(join(directory, 'preparation-diagnostics.json'), JSON.stringify(diagnostic, null, 2) + '\n');
}
