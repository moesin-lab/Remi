/** Resolve the latest published stable platform release (not an arbitrary Git
 * ref). The checker subsequently binds tag, commit, package version and schema. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
const directory = resolve(process.argv[2] ?? 'ci-schema');
await mkdir(directory, { recursive: true });
const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
let published: any;
for (let page = 1; !published; page++) {
  const response = await fetch(`https://api.github.com/repos/moesin-lab/Remi/releases?per_page=100&page=${page}`, { headers });
  if (!response.ok) throw new Error(`Cannot resolve previous release: HTTP ${response.status}`);
  const releases = await response.json() as any[];
  if (!releases.length) throw new Error('No published stable platform release found; cannot attest rollback');
  published = releases.find(r => !r.draft && !r.prerelease && /^v\d+\.\d+\.\d+$/.test(r.tag_name)
    && r.assets.some((a: any) => a.name === 'platform-release.json'));
}
const asset = published.assets.find((a: any) => a.name === 'platform-release.json');
const response = await fetch(asset.browser_download_url);
if (!response.ok) throw new Error(`Cannot download published manifest: HTTP ${response.status}`);
const previous = await response.json() as any;
if (published.tag_name !== `v${previous.version}` || !/^[a-f0-9]{40}$/.test(previous.ref)) throw new Error('Published release tag/manifest mismatch');
await writeFile(join(directory, 'previous-release.json'), JSON.stringify(previous, null, 2) + '\n');
execFileSync('git', ['fetch', 'origin', `refs/tags/${published.tag_name}:refs/tags/${published.tag_name}`], { stdio: 'inherit' });
execFileSync('git', ['worktree', 'add', '--detach', join(directory, 'previous'), published.tag_name], { stdio: 'inherit' });
console.log(`Previous published release: ${published.tag_name} @ ${previous.ref}`);
