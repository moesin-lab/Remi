import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { schemaFingerprint } from '../packages/platform-updater/src/supervisor.mjs';
import { extractArchive } from '../packages/platform-updater/src/container-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// Only Docker is simulated: packaging, manifest generation, tar and extraction
// run for real. Real multi-architecture OCI validation remains a release CI job.
for (const reviewed of [false, true]) test(`packages computed schema in feed and both archives (review=${reviewed})`, { skip: process.platform !== 'linux' }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'remi-package-test-'));
  try {
    const bin = join(temporary, 'bin');
    await mkdir(bin);
    const docker = `#!${process.execPath}
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
const args = process.argv.slice(2), command = args[0];
if (command === 'create') console.log(args.includes('api@sha256:' + 'a'.repeat(64)) ? 'api' : 'web');
else if (command === 'run') console.log(args.includes('GNU_LIBC_VERSION') ? 'glibc 2.36' : args.includes('/usr/local/bin/bun') ? '1.3.14' : 'v22.23.2');
else if (command === 'cp') {
  const destination = args.at(-1), source = args.at(-2);
  if (source === 'api:/app/.') {
    const inputs = JSON.parse(await (await import('node:fs/promises')).readFile(join(process.env.PACKAGE_SOURCE, 'packages/platform-updater/src/data-schema-inputs.json')));
    for (const path of [...inputs, 'packages/server/src/store/schema-compatibility.json', 'deploy/docker/Dockerfile.api', 'deploy/docker/api-entrypoint.sh']) {
      mkdirSync(dirname(join(destination, path)), { recursive: true });
      copyFileSync(join(process.env.PACKAGE_SOURCE, path), join(destination, path));
    }
    if (process.env.PACKAGE_MISMATCH) writeFileSync(join(destination, 'packages/server/src/store/schema-compatibility.json'), JSON.stringify({format:1,expandLevel:99,contractLevel:0,minLevel:1,maxLevel:99}));
  } else if (source === 'web:/app/.') {
    mkdirSync(join(destination, 'frontend/apps/web'), { recursive: true });
    writeFileSync(join(destination, 'frontend/apps/web/server.js'), '// fixture');
  } else writeFileSync(destination, 'fixture runtime');
}
`;
    await writeFile(join(bin, 'docker'), docker, { mode: 0o755 });
    const manifestPath = join(temporary, 'platform-release.json');
    const manifest = { version: '1.2.0', ref: 'a'.repeat(40), apiImage: 'api@sha256:' + 'a'.repeat(64), webImage: 'web@sha256:' + 'b'.repeat(64), manifestUrl: 'https://example.org/platform-release.json', dataSchema: 'stale input must be replaced' };
    if (reviewed) manifest.rollbackReview = { targetRef: manifest.ref, previousVersion: '1.1.0', previousDataSchema: 'c'.repeat(64), reason: 'Reviewed unchanged storage format', reviewedBy: 'human reviewer', previousRelease: { version: '1.1.0', dataSchema: 'c'.repeat(64) } };
    await writeFile(manifestPath, JSON.stringify(manifest));
    const run = (mismatch, evidencePath = '') => spawnSync(process.execPath, ['scripts/package-platform-application.mjs', manifestPath, temporary], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: bin + delimiter + process.env.PATH, PACKAGE_SOURCE: root, PACKAGE_MISMATCH: mismatch ? '1' : '', PLATFORM_SCHEMA_ROLLBACK_EVIDENCE: evidencePath } });
    const result = run(false);
    assert.equal(result.status, 0, result.stderr);
    const published = JSON.parse(await readFile(manifestPath));
    assert.equal(published.dataSchema, await schemaFingerprint(root));
    assert.deepEqual(published.application.rollbackSafeFrom, reviewed ? ['c'.repeat(64)] : []);
    for (const arch of ['x64', 'arm64']) {
      const extracted = join(temporary, arch);
      await extractArchive(join(temporary, `platform-application-v1.2.0-linux-${arch}.tar.gz`), extracted);
      const archived = JSON.parse(await readFile(join(extracted, 'application.json')));
      assert.equal(archived.dataSchema, published.dataSchema);
      assert.equal(await schemaFingerprint(join(extracted, 'api')), published.dataSchema);
      assert.deepEqual(archived.application.rollbackSafeFrom, published.application.rollbackSafeFrom);
    }
    const incompletePath = join(temporary, 'old-rollback-evidence.json');
    await writeFile(incompletePath, JSON.stringify({ format: 1, targetRef: manifest.ref, dataSchema: published.dataSchema,
      previousRelease: { version: '1.1.0', ref: 'e'.repeat(40), dataSchema: 'c'.repeat(64) },
      schema: { expandLevel: 3, contractLevel: 0 },
      checks: ['previous-startup', 'previous-create-start-complete-cancel', 'candidate-expand-startup', 'previous-startup-after-expand', 'previous-create-start-complete-cancel-after-expand'],
      rollbackSafeFrom: ['c'.repeat(64)] }));
    const beforeInvalidEvidence = await readFile(manifestPath, 'utf8');
    const invalidEvidence = run(false, incompletePath);
    assert.notEqual(invalidEvidence.status, 0);
    assert.match(invalidEvidence.stderr, /Invalid mixed-version rollback evidence/);
    assert.equal(await readFile(manifestPath, 'utf8'), beforeInvalidEvidence);
    const mismatch = run(true);
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /Published API source differs/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
