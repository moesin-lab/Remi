import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schemaLevelFingerprint } from '../packages/platform-updater/src/schema-fingerprint.mjs';
test('modern schema identity follows levels, not formatting, code or reader interval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mul173-fingerprint-'));
  const path = join(root, 'packages/server/src/store');
  await mkdir(path, { recursive: true });
  const declaration = { format: 1, expandLevel: 1, contractLevel: 0, minLevel: 1, maxLevel: 1 };
  const save = value => writeFile(join(path, 'schema-compatibility.json'), JSON.stringify(value, null, 2));
  try {
    await save(declaration); const first = await schemaLevelFingerprint(root);
    await writeFile(join(path, 'migrations.ts'), '// arbitrary implementation refactor');
    await save({ ...declaration, maxLevel: 2 });
    assert.equal(await schemaLevelFingerprint(root), first);
    await save({ ...declaration, expandLevel: 2 });
    assert.notEqual(await schemaLevelFingerprint(root), first);
    await save({ ...declaration, contractLevel: 2 });
    await assert.rejects(() => schemaLevelFingerprint(root), /Invalid schema/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
