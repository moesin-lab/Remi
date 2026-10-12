import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJson } from '../../../packages/platform-updater/src/supervisor.mjs';

const readStatus = (path: string) => readJson<{ revision: string }>(path);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'remi-supervisor-json-'));
  roots.push(root);
  const path = join(root, 'status.json');
  await writeJson(path, { revision: 'old' });
  return { root, path };
}

describe('supervisor atomic JSON', () => {
  it('keeps every published document readable during concurrent status reads', async () => {
    const { root, path } = await fixture();
    const reader = (async () => {
      for (let index = 0; index < 40; index++) {
        const value = await readStatus(path);
        expect(value).not.toBeNull();
        expect(typeof value?.revision).toBe('string');
      }
    })();
    const writer = (async () => {
      for (let index = 0; index < 20; index++) await writeJson(path, { revision: String(index) });
    })();
    await Promise.all([reader, writer]);
    expect(await readStatus(path)).toEqual({ revision: '19' });
    expect(await fs.readdir(root)).toEqual(['status.json']);
  });

  it.skipIf(process.platform !== 'win32').each(['EPERM', 'EACCES', 'EBUSY'])(
    'retries a temporary Windows %s without removing the previous document', async code => {
      const { root, path } = await fixture();
      const originalRename = fs.rename;
      let calls = 0;
      const rename = spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
        expect(await readStatus(path)).toEqual({ revision: 'old' });
        expect(await readStatus(String(source))).toEqual({ revision: 'new' });
        if (++calls < 3) throw Object.assign(new Error('temporary sharing violation'), { code });
        await originalRename(source, destination);
      });
      try {
        await writeJson(path, { revision: 'new' });
        expect(calls).toBe(3);
        expect(await readStatus(path)).toEqual({ revision: 'new' });
        expect(await fs.readdir(root)).toEqual(['status.json']);
      } finally { rename.mockRestore(); }
    },
  );

  it.each(['EPERM', 'EACCES', 'EBUSY'])(
    'bounds persistent %s failures and preserves the previous document', async code => {
      const { root, path } = await fixture();
      const failure = Object.assign(new Error('persistent sharing violation'), { code });
      const rename = spyOn(fs, 'rename').mockRejectedValue(failure);
      try {
        await expect(writeJson(path, { revision: 'new' })).rejects.toBe(failure);
        expect(rename.mock.calls.length).toBeLessThanOrEqual(10);
        if (process.platform === 'win32') expect(rename.mock.calls.length).toBeGreaterThan(1);
        else expect(rename).toHaveBeenCalledTimes(1);
        expect(await readStatus(path)).toEqual({ revision: 'old' });
        expect(await fs.readdir(root)).toEqual(['status.json']);
      } finally { rename.mockRestore(); }
    },
  );

  it('reports a non-transient rename error immediately and removes only its temporary file', async () => {
    const { root, path } = await fixture();
    await fs.writeFile(join(root, 'unrelated.tmp'), 'keep');
    const failure = Object.assign(new Error('I/O failure'), { code: 'EIO' });
    const rename = spyOn(fs, 'rename').mockRejectedValue(failure);
    try {
      await expect(writeJson(path, { revision: 'new' })).rejects.toBe(failure);
      expect(rename).toHaveBeenCalledTimes(1);
      expect(await readStatus(path)).toEqual({ revision: 'old' });
      expect((await fs.readdir(root)).sort()).toEqual(['status.json', 'unrelated.tmp']);
    } finally { rename.mockRestore(); }
  });

  it('cleans an unpublished temporary file when serialization fails', async () => {
    const { root, path } = await fixture();
    const circular: { value?: unknown } = {};
    circular.value = circular;
    await expect(writeJson(path, circular)).rejects.toThrow();
    expect(await readStatus(path)).toEqual({ revision: 'old' });
    expect(await fs.readdir(root)).toEqual(['status.json']);
  });
});
