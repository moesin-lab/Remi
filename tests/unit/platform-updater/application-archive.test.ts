import { afterEach, describe, expect, it } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { API_BASE_INPUTS, DATA_SCHEMA_INPUTS, extractArchive } from '../../../packages/platform-updater/src/container-runtime.mjs';
import { API_BASE_INPUTS as expectedBaseInputs } from '../../../packages/platform-updater/src/application-manifest.js';
import expectedInputs from '../../../packages/platform-updater/src/data-schema-inputs.json';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
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
