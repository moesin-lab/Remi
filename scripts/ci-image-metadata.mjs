import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isIPv4 } from 'node:net';
import { validateCiImages } from './ci-images.mjs';

const hostname = process.env.BUILD_HOSTNAME || '127.0.0.1';
const octets = hostname.split('.').map(Number);
if (!isIPv4(hostname) || !(hostname === '127.0.0.1' || octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168))) throw new Error('Hostname must be loopback or an RFC 1918 IPv4 address');
const ref = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const repository = process.env.GITHUB_REPOSITORY.toLowerCase();
const owner = repository.split('/')[0];
const version = `${JSON.parse(readFileSync('package.json', 'utf8')).version}-stable.${ref.slice(0, 8)}`;
if (process.argv.includes('--manifest')) {
  const manifest = validateCiImages({ schemaVersion: 1, repository, ref, version, hostname,
    profile: 'stable', platform: 'linux/amd64',
    apiImage: `ghcr.io/${owner}/remi-api@${process.env.API_DIGEST}`,
    webImage: `ghcr.io/${owner}/remi-web@${process.env.WEB_DIGEST}`,
  }, { repository, ref, hostname });
  writeFileSync('stable-images.json', JSON.stringify(manifest, null, 2) + '\n');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Built ${ref} for ${hostname}. Download the stable-images-${ref} artifact for immutable image references. No local environment is upgraded automatically.\n`);
} else {
  const values = { sha: ref, owner, version, hostname, tag: `ci-${ref}-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}` };
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
}
