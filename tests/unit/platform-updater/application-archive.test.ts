import { afterEach, describe, expect, it } from 'bun:test';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { API_BASE_INPUTS, DATA_SCHEMA_INPUTS, extractArchive, restoreMigrationReports } from '../../../packages/platform-updater/src/container-runtime.mjs';
import { API_BASE_INPUTS as expectedBaseInputs } from '../../../packages/platform-updater/src/application-manifest.js';
import expectedInputs from '../../../packages/platform-updater/src/data-schema-inputs.json';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function headerFor(name: string, size = 0) {
  const header = Buffer.alloc(512);
  header.write(name, 0); header.write('0000644\0', 100);
  header.write(size.toString(8).padStart(11, '0') + '\0', 124);
  header.fill(32, 148, 156); header.write('0', 156);
  const sum = header.reduce((total, value) => total + value, 0);
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return header;
}
function tar(entries: Array<{ name: string; content?: string; type?: string; link?: string }>) {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.content ?? '');
    const header = Buffer.alloc(512);
    header.write(entry.name, 0); header.write('0000644\0', 100);
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    header.fill(32, 148, 156); header.write(entry.type ?? '0', 156); header.write(entry.link ?? '', 157);
    const sum = header.reduce((total, value) => total + value, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
async function unpack(entries: Parameters<typeof tar>[0]) {
  const root = await mkdtemp(join(tmpdir(), 'remi-app-archive-')); roots.push(root);
  const archive = join(root, 'application.tar.gz');
  await writeFile(archive, tar(entries));
  const target = join(root, 'release');
  return { root, target, extract: () => extractArchive(archive, target) };
}
describe('application archive extraction', () => {
  it('verifies the same migration sources as release publication and the host', () => {
    expect(DATA_SCHEMA_INPUTS).toEqual(expectedInputs);
    expect(API_BASE_INPUTS).toEqual(expectedBaseInputs);
  });
  it('extracts application files', async () => {
    const f = await unpack([{ name: 'api/package.json', content: '{}' }]);
    await f.extract();
    expect(await readFile(join(f.target, 'api/package.json'), 'utf8')).toBe('{}');
  });
  // The extractor runs inside Linux Docker, never on the Windows host.
  it.skipIf(process.platform === 'win32')('extracts internal workspace links', async () => {
    const f = await unpack([{ name: 'api/package.json', content: '{}' }, { name: 'api/pkg/index.js', content: 'export {}' }, { name: 'api/module', type: '2', link: 'pkg' }]);
    await f.extract();
    expect(await readFile(join(f.target, 'api/module/index.js'), 'utf8')).toBe('export {}');
  });
  for (const entry of [
    { name: '../outside', content: 'bad' }, { name: '/absolute', content: 'bad' },
    { name: 'api/link', type: '2', link: '../../outside' }, { name: 'device', type: '3' },
  ]) it(`rejects unsafe archive entry ${entry.name}`, async () => {
    const f = await unpack([entry]); await expect(f.extract()).rejects.toThrow();
  });
  it.skipIf(process.platform === 'win32')('rejects symlinks whose resolved target escapes through another link', async () => {
    const f = await unpack([{ name: 'dir', type: '5' }, { name: 'shortcut', type: '2', link: '.' }, { name: 'dir/escape', type: '2', link: '../shortcut/../outside' }]);
    await expect(f.extract()).rejects.toThrow();
  });
  it.skipIf(process.platform === 'win32')('never writes through a link created by an earlier archive entry', async () => {
    const f = await unpack([{ name: 'link', type: '2', link: 'target' }, { name: 'link/file', content: 'value' }]);
    await expect(f.extract()).rejects.toThrow();
  });
  it('rejects duplicate file entries', async () => {
    const f = await unpack([{ name: 'file', content: 'first' }, { name: 'file', content: 'replacement' }]);
    await expect(f.extract()).rejects.toThrow('Duplicate');
  });
});

describe('rehearsal migration report restore', () => {
  async function backup(entries: Parameters<typeof tar>[0]) {
    const root = await mkdtemp(join(tmpdir(), 'remi-report-archive-')); roots.push(root);
    const archive = join(root, 'api-home.archive');
    await writeFile(archive, gunzipSync(tar(entries)));
    const target = join(root, 'scratch');
    return { archive, target, restore: () => restoreMigrationReports(archive, target) };
  }
  it('extracts only reports from the uncompressed HOME backup, ignoring cache links and credentials', async () => {
    const f = await backup([
      { name: './', type: '5' },
      { name: './credentials.json', content: 'private' },
      { name: './cache', type: '2', link: '/outside' },
      { name: './reports/migrations/cutover-before.json', content: '{"phase":"before"}' },
      { name: './reports/migrations/cutover-after.json', content: '{"phase":"after"}' },
    ]);
    const directory = await f.restore();
    expect(await readFile(join(directory, 'cutover-before.json'), 'utf8')).toBe('{"phase":"before"}');
    expect((await readdir(directory)).sort()).toEqual(['cutover-after.json', 'cutover-before.json']);
    expect(await readdir(f.target)).toEqual(['reports']);
  });
  it('fails diagnostically when the backup has no migration reports', async () => {
    const f = await backup([{ name: 'credentials.json', content: 'private' }]);
    await expect(f.restore()).rejects.toThrow('current api-home backup is missing or has invalid reports/migrations');
  });
  // Sparse files avoid allocating HOME-sized fixtures. The real stream still
  // consumes every byte, exercising both the single-entry and total quotas.
  it.skipIf(process.platform === 'win32')('streams past unrelated HOME content larger than the application byte quotas', async () => {
    const f = await backup([]);
    const size = 8 * 1024 ** 3 + 512;
    const report = gunzipSync(tar([{ name: 'reports/migrations/before.json', content: 'before' }]));
    const handle = await open(f.archive, 'w');
    try {
      await handle.write(headerFor('cache/large', size), 0, 512, 0);
      await handle.write(report, 0, report.length, 512 + size);
    } finally { await handle.close(); }
    expect(await readFile(join(await f.restore(), 'before.json'), 'utf8')).toBe('before');
    expect(await readdir(f.target)).toEqual(['reports']);
    // A selected report of the same size must still fail before extraction.
    const reportArchive = await open(f.archive, 'r+');
    try { await reportArchive.write(headerFor('reports/migrations/large.json', size), 0, 512, 0); }
    finally { await reportArchive.close(); }
    await expect(f.restore()).rejects.toThrow('invalid reports/migrations');
    await expect(extractArchive(f.archive, join(f.target, 'application'), false)).rejects.toThrow('Invalid tar entry size');
  }, 120_000);
  it('does not count unrelated HOME entries against the report quota', async () => {
    const f = await backup([]);
    const handle = await open(f.archive, 'w');
    try {
      for (let batch = 0; batch < 251; batch++) {
        await handle.writeFile(Buffer.concat(Array.from({ length: 1000 }, (_, i) => headerFor(`cache/empty-${batch * 1000 + i}`))));
      }
      await handle.writeFile(gunzipSync(tar([{ name: 'reports/migrations/before.json', content: 'before' }])));
    } finally { await handle.close(); }
    expect(await readFile(join(await f.restore(), 'before.json'), 'utf8')).toBe('before');
  }, 30_000);
  it('still rejects duplicate reports and unsafe paths in skipped entries', async () => {
    const duplicate = await backup([
      { name: 'reports/migrations/before.json', content: 'first' },
      { name: 'reports/migrations/before.json', content: 'replacement' },
    ]);
    await expect(duplicate.restore()).rejects.toThrow('invalid reports/migrations');
    const unsafe = await backup([{ name: '../cache/escape', content: 'bad' }, { name: 'reports/migrations/before.json', content: 'before' }]);
    await expect(unsafe.restore()).rejects.toThrow('invalid reports/migrations');
  });
  it('fails diagnostically when the HOME archive is absent', async () => {
    const f = await backup([]); await rm(f.archive);
    await expect(f.restore()).rejects.toThrow('current api-home backup');
  });
  for (const type of ['1', '2']) it(`rejects report links of type ${type}`, async () => {
    const f = await backup([{ name: 'reports/migrations/report.json', type, link: '../../credentials.json' }]);
    await expect(f.restore()).rejects.toThrow('invalid reports/migrations');
  });
});
