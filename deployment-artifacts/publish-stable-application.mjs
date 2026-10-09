// This deployment-only branch adds archive storage, without creating a tag or
// GitHub Release or changing the existing formal release manifest.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repository = 'moesin-lab/Remi';
const ref = '277a43bef475b690b13d713cd9175222095f2767';
const sha256 = '5193dd26f135fffc84728253e364503a5fda10ed976ded96ea759fdb9860258e';
const bytes = 461838088;
const tag = 'v0.2.86';
const archiveName = `platform-application-${ref}-linux-x64.tar.gz`;
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 4 * 1024 ** 2 }).trim();
const api = path => JSON.parse(gh('api', path));
const manifest = JSON.parse(await readFile(new URL('./stable-application.json', import.meta.url), 'utf8'));
assert.equal(manifest.ref, ref);
assert.equal(manifest.version, '0.2.88');
assert.equal(manifest.application.assets['linux-x64'].sha256, sha256);
const bundleUrl = manifest.application.assets['linux-x64'].url;
assert.equal(bundleUrl, `https://github.com/${repository}/releases/download/${tag}/${archiveName}`);
const ci = api(`repos/${repository}/actions/runs/37949668870`);
assert.equal(ci.head_sha, ref);
assert.equal(ci.status, 'completed');
assert.equal(ci.conclusion, 'success');
const jobs = api(`repos/${repository}/actions/runs/${ci.id}/jobs?per_page=100`);
assert.equal(jobs.total_count, 14);
assert(jobs.jobs.every(job => job.status === 'completed' && job.conclusion === 'success'));
const release = api(`repos/${repository}/releases/tags/${tag}`);
assert.equal(release.draft, false);
assert.equal(release.prerelease, false);

async function downloadVerified(url, destination, headers) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`Archive download returned ${response.status}`);
  assert.equal(new URL(response.url).protocol, 'https:');
  const file = destination ? await open(destination, 'wx', 0o600) : null;
  const hash = createHash('sha256');
  let length = 0;
  try {
    for await (const chunk of response.body) {
      length += chunk.length;
      assert(length <= bytes, 'Archive exceeds the verified size');
      hash.update(chunk);
      if (file) await file.writeFile(chunk);
    }
    if (file) await file.sync();
  } finally { if (file) await file.close(); }
  assert.equal(length, bytes);
  assert.equal(hash.digest('hex'), sha256);
}

const existing = release.assets.find(asset => asset.name === archiveName);
if (existing) {
  assert.equal(existing.size, bytes);
  if (existing.digest) assert.equal(existing.digest, 'sha256:' + sha256);
} else {
  const temporary = await mkdtemp(join(tmpdir(), 'remi-stable-feed-'));
  try {
    const tokenResponse = await fetch('https://ghcr.io/token?service=ghcr.io&scope=repository:moesin-lab/remi-api:pull');
    assert(tokenResponse.ok, 'Public registry token unavailable');
    const { token } = await tokenResponse.json();
    assert.equal(typeof token, 'string');
    const archive = join(temporary, archiveName);
    await downloadVerified(`https://ghcr.io/v2/moesin-lab/remi-api/blobs/sha256:${sha256}`, archive,
      { Authorization: 'Bearer ' + token });
    gh('release', 'upload', tag, archive, '--repo', repository);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

// Verify the permanent URL anonymously, rather than a short-lived registry
// redirect or a CI artifact that requires authentication.
await downloadVerified(bundleUrl);
const report = { ok: true, checkedAt: new Date().toISOString(), ref, version: manifest.version,
  bundleUrl, sha256, bytes, ci: { url: ci.html_url, checks: jobs.total_count, conclusion: ci.conclusion },
  anonymousDownloadVerified: true, createdRelease: false, replacedFormalAssets: false };
await writeFile('stable-application-publication.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));

