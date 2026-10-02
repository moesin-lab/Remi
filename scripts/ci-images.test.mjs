import assert from 'node:assert/strict';
import test from 'node:test';
import { githubRepository, validateCiImages, loadCiImages } from './ci-images.mjs';

const ref = 'a'.repeat(40);
const expected = { ref, hostname: '127.0.0.1', repository: 'example/remi' };
const manifest = { ...expected, schemaVersion: 1, profile: 'stable', platform: 'linux/amd64', version: '0.2.85-stable.aaaaaaaa',
  apiImage: `ghcr.io/example/remi-api@sha256:${'b'.repeat(64)}`, webImage: `ghcr.io/example/remi-web@sha256:${'c'.repeat(64)}` };

test('origin is normalized for explicit fork API calls', () => {
  for (const remote of ['git@github.com:Example/Remi.git', 'https://github.com/Example/Remi.git', 'https://github.com/Example/Remi']) assert.equal(githubRepository(remote), 'example/remi');
  assert.throws(() => githubRepository('https://other.example/Example/Remi.git'));
});
test('only paired digest images for the requested source and baked hostname are accepted', () => {
  assert.equal(validateCiImages(manifest, expected), manifest);
  for (const patch of [null, { ref: 'b'.repeat(40) }, { hostname: '192.168.1.2' }, { repository: 'other/remi' }, { apiImage: 'ghcr.io/example/remi-api:latest' }, { webImage: manifest.apiImage }, { platform: 'linux/arm64' }]) {
    assert.throws(() => validateCiImages(patch === null ? null : { ...manifest, ...patch }, expected));
  }
});
test('failed builds and artifacts from other workflows cannot deploy and never fall back to compilation', () => {
  for (const run of [{ conclusion: 'failure', path: '.github/workflows/platform-images.yml' }, { conclusion: 'success', path: '.github/workflows/other.yml' }]) {
    const calls = [];
    assert.throws(() => loadCiImages({ deployment: { ref }, root: '.', capture(command, args) {
      calls.push([command, ...args]);
      if (command === 'git') return 'git@github.com:example/remi.git';
      if (args[1].includes('/artifacts?')) return JSON.stringify({ artifacts: [{ name: `stable-images-${ref}`, workflow_run: { id: 42 } }] });
      return JSON.stringify(run);
    }, execute() { assert.fail('No download or build is allowed'); } }), /No successful CI image build/);
    assert.equal(calls.length, 3);
  }
});
