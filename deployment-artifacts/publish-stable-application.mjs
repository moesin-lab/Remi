// This deployment-only branch adds archive storage, without creating a tag or
// GitHub Release or changing the existing formal release manifest.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, rename, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repository = 'moesin-lab/Remi';
const source = resolve('application-source');
const command = (name, args, cwd = source) => execFileSync(name, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 ** 2 }).trim();
const ref = command('git', ['rev-parse', 'HEAD']);
assert.match(ref, /^[a-f0-9]{40}$/);
for (const id of [process.env.IMAGE_RUN, process.env.CI_RUN]) assert.match(id ?? '', /^\d+$/);
const tag = 'v0.2.86';
const archiveName = `platform-application-${ref}-linux-x64.tar.gz`;
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 4 * 1024 ** 2 }).trim();
const api = path => JSON.parse(gh('api', path));
const bundleUrl = `https://github.com/${repository}/releases/download/${tag}/${archiveName}`;
const ci = api(`repos/${repository}/actions/runs/${process.env.CI_RUN}`);
assert.equal(ci.head_sha, ref);
assert.equal(ci.status, 'completed');
assert.equal(ci.conclusion, 'success');
const jobs = api(`repos/${repository}/actions/runs/${ci.id}/jobs?filter=all&per_page=100`);
assert(jobs.total_count <= 100);
const effectiveJobs = new Map();
for (const job of jobs.jobs.sort((a, b) => a.id - b.id)) effectiveJobs.set(job.name, job);
assert.equal(effectiveJobs.size, 14);
assert([...effectiveJobs.values()].every(job => job.status === 'completed' && job.conclusion === 'success'));
assert.equal(api(`repos/${repository}/actions/runs/${process.env.IMAGE_RUN}`).conclusion, 'success');
const release = api(`repos/${repository}/releases/tags/${tag}`);
assert.equal(release.draft, false);
assert.equal(release.prerelease, false);

let sha256, bytes;
async function downloadVerified(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`Archive download returned ${response.status}`);
  assert.equal(new URL(response.url).protocol, 'https:');
  const hash = createHash('sha256');
  let length = 0;
  for await (const chunk of response.body) {
      length += chunk.length;
      assert(length <= bytes, 'Archive exceeds the verified size');
      hash.update(chunk);
  }
  assert.equal(length, bytes);
  assert.equal(hash.digest('hex'), sha256);
}

assert(!release.assets.some(asset => asset.name === archiveName), 'Archive already published; recover its publication report rather than overwriting');
const temporary = await mkdtemp(join(tmpdir(), 'remi-stable-feed-'));
let manifest;
try {
  gh('run', 'download', process.env.IMAGE_RUN, '--repo', repository, '--name', 'stable-images-' + ref, '--dir', temporary);
  const images = JSON.parse(await readFile(join(temporary, 'stable-images.json'), 'utf8'));
  assert.equal(images.ref, ref); assert.equal(images.repository, repository.toLowerCase());
  for (const image of [images.apiImage, images.webImage]) assert.match(image, /^ghcr\.io\/moesin-lab\/remi-\w+@sha256:[a-f0-9]{64}$/);
  const version = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).version;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const path = join(temporary, 'stable-application.json');
  await writeFile(path, JSON.stringify({ version, ref, publishedAt: new Date().toISOString(),
    releaseUrl: `https://github.com/${repository}/tree/${ref}`,
    manifestUrl: `https://raw.githubusercontent.com/${repository}/codex/stable-application-feed-20261010/deployment-artifacts/stable-application.json`,
    dataSchema: command('node', ['scripts/platform-data-schema.mjs']), apiImage: images.apiImage, webImage: images.webImage, updaterImage: images.updaterImage }));
  const packaging = await readFile(join(source, 'scripts/package-platform-application.mjs'), 'utf8');
  const architectures = "[['x64', 'amd64'], ['arm64', 'arm64']]";
  assert(packaging.includes(architectures));
  await writeFile(join(source, 'scripts/package-deployment-application.mjs'), packaging.replace(architectures, "[['x64', 'amd64']]"));
  command('node', ['scripts/package-deployment-application.mjs', path, temporary]);
  manifest = JSON.parse(await readFile(path, 'utf8'));
  sha256 = manifest.application.assets['linux-x64'].sha256;
  const archive = join(temporary, archiveName);
  await rename(join(temporary, `platform-application-v${version}-linux-x64.tar.gz`), archive);
  bytes = (await stat(archive)).size;
  gh('release', 'upload', tag, archive, '--repo', repository);
  await downloadVerified(bundleUrl);
  manifest.application.assets['linux-x64'].url = bundleUrl;
  await writeFile(new URL('./stable-application.json', import.meta.url), JSON.stringify(manifest, null, 2) + '\n');
} finally { await rm(temporary, { recursive: true, force: true }); }

// Verify the permanent URL anonymously, rather than a short-lived registry
// redirect or a CI artifact that requires authentication.
const report = { ok: true, checkedAt: new Date().toISOString(), ref, version: manifest.version,
  bundleUrl, sha256, bytes, ci: { url: ci.html_url, checks: effectiveJobs.size, conclusion: ci.conclusion },
  anonymousDownloadVerified: true, createdRelease: false, replacedFormalAssets: false };
await writeFile('stable-application-publication.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));

